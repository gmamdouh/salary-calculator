/**
 * Date-only records use ISO YYYY-MM-DD strings.
 * Period: payrollMonth, cutoffMode, startDate, endDate, monthEndDate,
 * daysInMonth, isComplete. Window: startDate, endDate, eligibleDays,
 * isFullEligibleMonth. Segment: startDate, endDate, eligibleDays, phase.
 */
SalaryCalculator.PayrollPeriod = (function () {
  var DAY = 86400000;
  function dateTime(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(label + ' must be an ISO date');
    var time = Date.parse(value + 'T00:00:00.000Z');
    if (!Number.isFinite(time) || iso(time) !== value) throw new Error(label + ' must be a valid calendar date');
    return time;
  }
  function iso(time) { return new Date(time).toISOString().slice(0, 10); }
  function days(start, end) { return (dateTime(end, 'endDate') - dateTime(start, 'startDate')) / DAY + 1; }
  function buildPeriod(options) {
    var month = options.payrollMonth;
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('payrollMonth must be YYYY-MM');
    dateTime(options.today, 'today');
    if (month > options.today.slice(0, 7)) throw new Error('Future payroll months are not allowed');
    var modes = SalaryCalculator.Constants.CUTOFF_MODES;
    if (options.cutoffMode !== modes.TODAY && options.cutoffMode !== modes.MONTH_END) throw new Error('cutoffMode is invalid');
    var startDate = month + '-01';
    var next = new Date(dateTime(startDate, 'payrollMonth'));
    next.setUTCMonth(next.getUTCMonth() + 1);
    var monthEndDate = iso(next.getTime() - DAY);
    var endDate = options.cutoffMode === modes.TODAY && month === options.today.slice(0, 7) ? options.today : monthEndDate;
    return { payrollMonth: month, cutoffMode: options.cutoffMode, startDate: startDate,
      endDate: endDate, monthEndDate: monthEndDate, daysInMonth: days(startDate, monthEndDate),
      isComplete: endDate === monthEndDate };
  }
  function getEmploymentWindow(employee, period) {
    SalaryCalculator.Contracts.assertEmployee(employee);
    var start = employee.firstWorkingDay > period.startDate ? employee.firstWorkingDay : period.startDate;
    var end = employee.lastWorkingDay && employee.lastWorkingDay < period.endDate ? employee.lastWorkingDay : period.endDate;
    if (start > end) return null;
    return { startDate: start, endDate: end, eligibleDays: days(start, end),
      isFullEligibleMonth: start === period.startDate && end === period.monthEndDate };
  }
  function splitProbation(window, firstWorkingDay) {
    if (!window) return [];
    var day91 = dateTime(firstWorkingDay, 'firstWorkingDay') + 90 * DAY;
    var start = dateTime(window.startDate, 'startDate');
    var end = dateTime(window.endDate, 'endDate');
    var segments = [];
    function add(from, to, phase) {
      if (from <= to) segments.push({ startDate: iso(from), endDate: iso(to),
        eligibleDays: (to - from) / DAY + 1, phase: phase });
    }
    add(start, Math.min(end, day91 - DAY), 'BEFORE_PROBATION');
    add(Math.max(start, day91), end, 'AFTER_PROBATION');
    return segments;
  }
  function prorate(monthlyAmount, eligibleDays, isFullEligibleMonth) {
    if (typeof monthlyAmount !== 'number' || !Number.isFinite(monthlyAmount) || monthlyAmount < 0 ||
        !Number.isInteger(eligibleDays) || eligibleDays < 0) throw new Error('Amount and days must be finite nonnegative values; days must be an integer');
    return isFullEligibleMonth ? monthlyAmount : monthlyAmount * (Math.min(eligibleDays, 30) / 30);
  }
  return { buildPeriod: buildPeriod, getEmploymentWindow: getEmploymentWindow,
    splitProbation: splitProbation, prorate: prorate };
})();
