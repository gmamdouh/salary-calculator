/** Pure calculation. Monetary rules live in rules.salaries[department].before/after.
 * Sales accrual ledger rows: {type:'SALES_ABS', employeeId, payrollMonth, amount,
 * paid:false}. Decisions: probation, referrals (employee records), paymentDate,
 * additions ({amount, approved:true, reason}) and deductions ({amount, reason}).
 * overrides: [{component, value, reason, editor, timestamp}]. No ledger is mutated.
 */
SalaryCalculator.PayrollEngine = (function () {
  function money(value, label, signed) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (!signed && value < 0)) throw new Error(label + ' must be a finite ' + (signed ? '' : 'nonnegative ') + 'number');
    return value;
  }
  function round(value) { return Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100; }
  function sumComponents(components) {
    return round(Object.keys(components).reduce(function (sum, name) {
      return sum + money(typeof components[name] === 'number' ? components[name] : components[name].amount, name, true);
    }, 0));
  }
  function calculateEmployee(input) {
    var employee = SalaryCalculator.Contracts.assertEmployee(input.employee);
    var rules = SalaryCalculator.Contracts.assertRules(input.rules);
    var decisions = SalaryCalculator.Contracts.assertDecisionSet(input.decisions || {});
    var period = input.period, ledger = input.ledger || [], attendance = input.attendance;
    var performance = input.performance || employee.performance || {};
    var Period = SalaryCalculator.PayrollPeriod, Eligibility = SalaryCalculator.Eligibility, Commission = SalaryCalculator.Commission;
    var window = Period.getEmploymentWindow(employee, period);
    var segments = Period.splitProbation(window, employee.firstWorkingDay);
    var components = {}, notes = [], warnings = [], candidates = [], eligibility = {};
    var salary = rules.salaries && rules.salaries[employee.department];
    if (!salary) throw new Error('Missing salary rules for ' + employee.department);
    ['before', 'after'].forEach(function (phase) {
      if (!salary[phase]) throw new Error('Missing ' + phase + ' salary rules');
      money(salary[phase].basic, 'basic'); money(salary[phase].abs, 'abs');
    });
    if (!Array.isArray(ledger)) throw new Error('ledger must be an array');
    function add(name, amount, metadata) {
      components[name] = Object.assign({ calculatedAmount: round(money(amount, name, true)), amount: round(amount) }, metadata || {});
    }
    function phaseRate(date) {
      var day91 = new Date(Date.parse(employee.firstWorkingDay + 'T00:00:00Z') + 90 * 86400000).toISOString().slice(0,10);
      return salary[date < day91 ? 'before' : 'after'].basic / 30;
    }
    function segmentedAmount(field) {
      if (!window) return 0;
      // A complete month pays one weighted monthly salary; partial employment uses /30.
      var divisor = window.isFullEligibleMonth ? period.daysInMonth : 30;
      var cap = window.isFullEligibleMonth ? 1 : Math.min(window.eligibleDays,30) / window.eligibleDays;
      return segments.reduce(function (total, segment) {
        return total + salary[segment.phase === 'BEFORE_PROBATION' ? 'before' : 'after'][field] * segment.eligibleDays / divisor * cap;
      }, 0);
    }
    add('basic', segmentedAmount('basic'), { days: window ? window.eligibleDays : 0, segments: segments });
    eligibility.abs = Eligibility.evaluateAbs(employee, attendance, period);
    notes.push(eligibility.abs.note);
    var absAccrual = eligibility.abs.eligible ? segmentedAmount('abs') : 0;
    var absPaid = absAccrual;
    var salesAccrual = null;
    if (employee.department === 'SALES') {
      var cycle = rules.salesQuarterlyPaymentMonths;
      if (!Array.isArray(cycle) || !cycle.length || cycle.some(function (month) { return !Number.isInteger(month) || month < 1 || month > 12; })) throw new Error('Sales quarterly payment months are required');
      var month = Number(period.payrollMonth.slice(5));
      var payout = !!window && (cycle.indexOf(month) !== -1 || !!(employee.lastWorkingDay && employee.lastWorkingDay <= period.endDate));
      var seenMonths = Object.create(null);
      var prior = ledger.filter(function (row) { return row.type === 'SALES_ABS' && row.employeeId === employee.employeeId && row.paid !== true && row.payrollMonth < period.payrollMonth; });
      var previousAmount = prior.reduce(function (total, row) {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.payrollMonth)) throw new Error('Invalid Sales accrual month');
        if (seenMonths[row.payrollMonth]) throw new Error('Duplicate Sales accrual month');
        seenMonths[row.payrollMonth] = true;
        return total + money(row.amount,'Sales accrual');
      }, 0);
      absPaid = payout ? previousAmount + absAccrual : 0;
      salesAccrual = { payrollMonth: period.payrollMonth, amount: round(absAccrual), paid: payout, priorMonthsPaid: payout ? Object.keys(seenMonths) : [] };
    }
    add('abs', absPaid, { days: window ? window.eligibleDays : 0, accrualAmount: round(absAccrual) });
    var commission = 0, detail = {};
    if (window) {
      if (employee.department === 'SURVEY') commission = Commission.calculateSurvey(performance.transfers);
      if (employee.department === 'RESERVATIONS') commission = Commission.calculateReservations(performance.transfers);
      if (employee.department === 'SALES') { detail = Commission.calculateSales(performance.sales, performance.conversionRate); commission = detail.amount; }
      if (employee.department === 'TDS') { detail = Commission.calculateTds(performance.agents); commission = detail.amount; }
    }
    add('commission', commission, detail);
    var benefitLedger = ledger.filter(function (row) { return row.benefitKey; }).slice();
    function benefit(result) {
      notes.push(result.note);
      if (result.candidate || result.eligible) candidates.push(result);
      if (result.decisionRequired) warnings.push(result.note);
      if (!result.eligible || !window) return 0;
      benefitLedger.push({ benefitKey: result.benefitKey });
      return result.amount;
    }
    eligibility.probation = Eligibility.evaluateProbationPayment(employee, benefitLedger,
      Object.assign({ asOfDate: period.endDate }, decisions.probation || {}));
    add('probation', benefit(eligibility.probation));
    var referrals = 0;
    (decisions.referrals || []).forEach(function (referred) {
      referrals += benefit(Eligibility.evaluateReferral(employee, referred, decisions.paymentDate || period.endDate, benefitLedger));
    });
    add('referral', referrals);
    var extra = Eligibility.calculateExtraDayUnits(attendance.workedOffDays || [], attendance.workedHolidays || []);
    extra.byDate.forEach(function (item) {
      if (!window || item.date < window.startDate || item.date > window.endDate) throw new Error('Extra-day date is outside employment window');
    });
    add('extraDays', extra.byDate.reduce(function (total,item) { return total + item.units * phaseRate(item.date); }, 0), { units: extra.units, byDate: extra.byDate });
    var finalSettlement = !!(window && employee.lastWorkingDay && employee.lastWorkingDay <= period.endDate);
    var annualDays = finalSettlement ? money(employee.annualLeaveBalance === undefined ? 0 : employee.annualLeaveBalance,'annualLeaveBalance') : 0;
    add('annualBalance', finalSettlement ? annualDays * phaseRate(employee.lastWorkingDay) : 0, { days: annualDays });
    function adjustments(items, approvedOnly) {
      return (items || []).reduce(function (sum, item) {
        money(item.amount,'adjustment');
        if (typeof item.reason !== 'string' || !item.reason.trim()) throw new Error('Adjustment reason is required');
        return sum + (!approvedOnly || item.approved === true ? item.amount : 0);
      }, 0);
    }
    add('additions', window ? adjustments(decisions.additions,true) : 0);
    if (attendance.nsPresent && segments.length > 1 && !attendance.noShowDate) throw new Error('No-Show date is required in a probation transition month');
    if (attendance.noShowDate && (typeof attendance.noShowDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(attendance.noShowDate) ||
        !Number.isFinite(Date.parse(attendance.noShowDate + 'T00:00:00Z')) || new Date(attendance.noShowDate + 'T00:00:00Z').toISOString().slice(0,10) !== attendance.noShowDate)) throw new Error('Invalid No-Show date');
    var nsRate = window ? phaseRate(attendance.noShowDate || window.endDate) : 0;
    if (attendance.noShowDate && (!window || attendance.noShowDate < window.startDate || attendance.noShowDate > window.endDate)) throw new Error('No-Show date outside employment window');
    var automatic = Eligibility.calculateNoShowDeduction(attendance.nsPresent,nsRate);
    add('deductions', -(window ? adjustments(decisions.deductions,false) + automatic : 0), { automaticAmount: round(automatic) });
    var overrides = decisions.overrides || [];
    if (!Array.isArray(overrides)) throw new Error('overrides must be an array');
    var overridden = Object.create(null);
    overrides.forEach(function (override) {
      var name = override.component;
      if (!Object.prototype.hasOwnProperty.call(components,name)) throw new Error('Unknown override component: ' + name);
      if (overridden[name]) throw new Error('Duplicate override component: ' + name);
      overridden[name] = true;
      ['reason','editor','timestamp'].forEach(function (key) { if (typeof override[key] !== 'string' || !override[key].trim()) throw new Error('Override ' + key + ' is required'); });
      money(override.value,'override',name === 'deductions');
      if (name === 'deductions' && override.value > 0) throw new Error('Deduction override must be nonpositive');
      components[name].amount = round(override.value);
      components[name].override = Object.assign({},override);
    });
    return { employeeId: employee.employeeId, americanName: employee.americanName, department: employee.department,
      payrollMonth: period.payrollMonth, finalSettlement: finalSettlement, window: window, segments: segments,
      components: components, total: sumComponents(components), notes: notes, benefitCandidates: candidates,
      warnings: warnings, eligibility: eligibility, salesAccrual: salesAccrual };
  }
  return { calculateEmployee: calculateEmployee, sumComponents: sumComponents };
})();
