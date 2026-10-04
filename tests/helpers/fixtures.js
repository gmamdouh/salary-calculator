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
function payrollRules(overrides = {}) {
  return { salaries: {
    SURVEY: { before: { basic: 12000, abs: 2000 }, after: { basic: 15000, abs: 3000 } },
    RESERVATIONS: { before: { basic: 12000, abs: 2000 }, after: { basic: 15000, abs: 3000 } },
    SALES: { before: { basic: 16000, abs: 4000 }, after: { basic: 16000, abs: 4000 } },
    TDS: { before: { basic: 18000, abs: 0 }, after: { basic: 21000, abs: 0 } },
    MANAGEMENT: { before: { basic: 21000, abs: 0 }, after: { basic: 27000, abs: 0 } }
  }, salesQuarterlyPaymentMonths: [3, 6, 9, 12], ...overrides };
}
module.exports = { employee, rules, decisionSet, periodOptions, attendance, probationDecision, benefitLedger, payrollRules };
