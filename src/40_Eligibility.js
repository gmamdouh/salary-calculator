SalaryCalculator.Eligibility = (function () {
  function decision(eligible, amount, reasonCode, note) {
    return { eligible: eligible, amount: amount, reasonCode: reasonCode, note: note };
  }
  function assertCount(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be a nonnegative integer');
  }
  function assertBoolean(value, label) {
    if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean');
  }
  function dateTime(value) {
    var time = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T00:00:00.000Z') : NaN;
    if (!Number.isFinite(time) || new Date(time).toISOString().slice(0,10) !== value) throw new Error('Invalid ISO calendar date');
    return time;
  }
  function addDays(date, days) { return new Date(dateTime(date) + days * 86400000).toISOString().slice(0,10); }
  function assertLedger(ledger) {
    if (!Array.isArray(ledger) || ledger.some(function (row) { return !row || typeof row.benefitKey !== 'string' || !row.benefitKey.trim(); })) throw new Error('ledger must contain benefitKey rows');
  }
  function hasBenefit(ledger, key) { return ledger.some(function (row) { return row.benefitKey === key; }); }
  // Attendance is already normalized to scheduled workdays; off-days are excluded.
  // Eligible ABS money is calculated by PayrollEngine from configured salary rules.
  function evaluateAbs(employee, attendance, period) {
    SalaryCalculator.Contracts.assertEmployee(employee);
    if (!attendance || typeof attendance !== 'object') throw new Error('attendance is required');
    assertCount(attendance.attendedScheduledDays, 'attendedScheduledDays');
    assertCount(attendance.leaveDays, 'leaveDays');
    assertBoolean(attendance.nsPresent, 'nsPresent');
    var departments = SalaryCalculator.Constants.DEPARTMENTS;
    if (employee.department === departments.TDS || employee.department === departments.MANAGEMENT) return decision(false, 0, 'NO_ABS', 'Department has no ABS.');
    var window = SalaryCalculator.PayrollPeriod.getEmploymentWindow(employee, period);
    if (!window) return decision(false, 0, 'OUTSIDE_PERIOD', 'Employment does not overlap the payroll period.');
    if (attendance.nsPresent) return decision(false, 0, 'NO_SHOW', 'No-Show removes this month\'s ABS.');
    if (attendance.leaveDays > 5) return decision(false, 0, 'LEAVE_LIMIT', 'More than five leave days removes this month\'s ABS.');
    var partialEmployment = employee.firstWorkingDay > period.startDate ||
      (employee.lastWorkingDay && employee.lastWorkingDay < period.monthEndDate);
    if (partialEmployment) return decision(true, null, 'PARTIAL_MONTH_EXEMPT', 'Partial employment is exempt from the attendance threshold; ABS is prorated by the engine.');
    if (!period.isComplete) return decision(true, null, 'ATTENDANCE_PENDING', 'Full-month attendance threshold is pending month completion.');
    var threshold = period.payrollMonth.slice(5) === '02' ? 15 : 17;
    if (attendance.attendedScheduledDays < threshold) return decision(false, 0, 'ATTENDANCE_THRESHOLD', 'Fewer than ' + threshold + ' attended scheduled workdays.');
    return decision(true, null, 'ELIGIBLE', 'ABS attendance requirements met.');
  }
  function calculateNoShowDeduction(nsPresent, basicDailyRate) {
    assertBoolean(nsPresent, 'nsPresent');
    if (typeof basicDailyRate !== 'number' || !Number.isFinite(basicDailyRate) || basicDailyRate < 0) throw new Error('Basic daily rate must be a finite nonnegative number');
    return nsPresent ? basicDailyRate * 3 : 0;
  }
  // Date-specific monetary rates are deliberately left to PayrollEngine.
  function calculateExtraDayUnits(workedOffDays, workedHolidays) {
    var dates = Object.create(null);
    function add(values, units) {
      if (!Array.isArray(values)) throw new Error('Worked dates must be arrays');
      values.forEach(function (date) { dateTime(date); dates[date] = Math.max(dates[date] || 0, units); });
    }
    add(workedOffDays, 1);
    add(workedHolidays, 2);
    var byDate = Object.keys(dates).sort().map(function (date) { return { date: date, units: dates[date] }; });
    var result = decision(byDate.length > 0, null, byDate.length ? 'EXTRA_DAYS' : 'NO_EXTRA_DAYS', 'Off-day work adds one unit; holiday work adds two units and takes precedence on overlaps.');
    result.units = byDate.reduce(function (total, item) { return total + item.units; }, 0);
    result.byDate = byDate;
    return result;
  }
  function evaluateProbationPayment(employee, ledger, hrDecision) {
    SalaryCalculator.Contracts.assertEmployee(employee);
    assertLedger(ledger);
    if (!hrDecision || typeof hrDecision !== 'object') throw new Error('Probation decision is required');
    dateTime(hrDecision.asOfDate);
    if (hrDecision.approved !== undefined) assertBoolean(hrDecision.approved, 'approved');
    var key = 'PROBATION:' + employee.employeeId;
    var candidateDate = addDays(employee.firstWorkingDay, 91);
    var department = employee.department;
    var applicable = department === SalaryCalculator.Constants.DEPARTMENTS.SURVEY || department === SalaryCalculator.Constants.DEPARTMENTS.RESERVATIONS;
    var candidate = applicable && candidateDate <= hrDecision.asOfDate && (!employee.lastWorkingDay || employee.lastWorkingDay >= candidateDate);
    var result;
    if (!applicable) result = decision(false, 0, 'NOT_APPLICABLE', 'Probation completion payment applies only to Survey and Reservations.');
    else if (hasBenefit(ledger, key)) result = decision(false, 0, 'ALREADY_PAID', 'Probation completion payment is already recorded.');
    else if (!candidate) result = decision(false, 0, 'NOT_CANDIDATE', 'Employee must complete day 91 and continue working through day 92.');
    else if (hrDecision.approved === undefined) result = decision(false, 0, 'DECISION_REQUIRED', 'HR confirmation is required for the probation payment.');
    else if (!hrDecision.approved) result = decision(false, 0, 'HR_DECLINED', 'HR declined the probation completion payment.');
    else result = decision(true, 12000, 'ELIGIBLE', 'HR approved the one-time probation completion payment.');
    result.benefitKey = key;
    result.candidate = candidate;
    result.candidateDate = candidateDate;
    result.decisionRequired = result.reasonCode === 'DECISION_REQUIRED';
    return result;
  }
  // finalPayrollPaymentDate, when present, is the former referrer's already-paid cutoff.
  // Without it, paymentDate is the date of the proposed final payroll.
  function evaluateReferral(referrer, referred, paymentDate, ledger) {
    SalaryCalculator.Contracts.assertEmployee(referrer);
    SalaryCalculator.Contracts.assertEmployee(referred);
    dateTime(paymentDate);
    assertLedger(ledger);
    if (referrer.finalPayrollPaymentDate !== undefined && referrer.finalPayrollPaymentDate !== null) dateTime(referrer.finalPayrollPaymentDate);
    var key = 'REFERRAL:' + referrer.employeeId + ':' + referred.employeeId;
    var qualifyingDate = addDays(referred.firstWorkingDay, 59);
    var cutoff = referrer.lastWorkingDay && referrer.finalPayrollPaymentDate ? referrer.finalPayrollPaymentDate : paymentDate;
    var result;
    if (referrer.employeeId === referred.employeeId || referred.referrerEmployeeId !== referrer.employeeId) result = decision(false, 0, 'REFERRAL_LINK_MISMATCH', 'Referred employee must be linked to this distinct referrer by Employee ID.');
    else if (hasBenefit(ledger, key)) result = decision(false, 0, 'ALREADY_PAID', 'This referral bonus is already recorded.');
    else if (referred.lastWorkingDay && referred.lastWorkingDay < qualifyingDate) result = decision(false, 0, 'REFERRED_LEFT_EARLY', 'Referred employee left before completing 60 full days.');
    else if (qualifyingDate > cutoff && referrer.lastWorkingDay) result = decision(false, 0, 'FINAL_PAYMENT_CUTOFF', 'Referral qualification occurs after the former employee\'s final payroll payment date.');
    else if (qualifyingDate > paymentDate) result = decision(false, 0, 'NOT_YET_QUALIFIED', 'Referred employee has not completed 60 full days by payment date.');
    else result = decision(true, 10000, 'ELIGIBLE', 'Referred employee completed 60 full days before the applicable payment cutoff.');
    result.benefitKey = key;
    result.qualifyingDate = qualifyingDate;
    return result;
  }
  return { evaluateAbs: evaluateAbs, calculateNoShowDeduction: calculateNoShowDeduction,
    calculateExtraDayUnits: calculateExtraDayUnits, evaluateProbationPayment: evaluateProbationPayment,
    evaluateReferral: evaluateReferral };
})();
