function employee(overrides = {}) {
  return { employeeId: 'EMP-001', americanName: 'Alex Smith', department: 'SURVEY',
    firstWorkingDay: '2026-01-01', lastWorkingDay: null,
    performance: { transfers: 10, sales: 2, activeCalls: 20, conversionRate: 0.1 }, ...overrides };
}
function rules(overrides = {}) { return { ...overrides }; }
function decisionSet(overrides = {}) { return { ...overrides }; }
function periodOptions(overrides = {}) { return { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', today: '2026-10-04', ...overrides }; }
module.exports = { employee, rules, decisionSet, periodOptions };
