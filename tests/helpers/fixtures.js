function employee(overrides = {}) {
  return { employeeId: 'EMP-001', americanName: 'Alex Smith', department: 'SURVEY',
    firstWorkingDay: '2026-01-01', lastWorkingDay: null,
    performance: { transfers: 10, sales: 2, activeCalls: 20, conversionRate: 0.1 }, ...overrides };
}
function rules(overrides = {}) { return { ...overrides }; }
function decisionSet(overrides = {}) { return { ...overrides }; }
function periodOptions(overrides = {}) { return { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', today: '2026-10-04', ...overrides }; }
function attendance(overrides = {}) { return { attendedScheduledDays: 17, leaveDays: 0, nsPresent: false, ...overrides }; }
function probationDecision(overrides = {}) { return { approved: true, asOfDate: '2026-09-30', ...overrides }; }
function benefitLedger(...benefitKeys) { return benefitKeys.map(benefitKey => ({ benefitKey })); }
module.exports = { employee, rules, decisionSet, periodOptions, attendance, probationDecision, benefitLedger };
