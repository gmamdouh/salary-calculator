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
function mappingConfig(overrides = {}) {
  return { department: 'SURVEY', spreadsheetId: 'fixture-source', leaveSpreadsheetId: 'fixture-leave',
    employeeTab: 'Team', attendanceTab: 'Days', employeeHeaderRow: 2, attendanceHeaderRow: 1,
    employeeColumns: { employeeId: 'ID', americanName: 'Alias', realName: 'Legal', firstWorkingDay: 'Joined', lastWorkingDay: 'Left', transfers: 'Count' },
    attendanceColumns: { employeeId: 'ID', date: 'Day', status: 'Code' },
    approvalColumns: { runId: 'Run', paid: 'Paid' }, ...overrides };
}
function sourceRow(overrides = {}) {
  return { headers: ['ID', 'Alias', 'Legal', 'Joined', 'Left', 'Count', 'Run', 'Paid'],
    values: ['EMP-001', 'Alex Smith', 'Internal Name', '2026-01-01', '', 10, '', ''],
    displayValues: ['EMP-001', 'Alex Smith', 'Internal Name', '2026-01-01', '', '10', '', ''], rowNumber: 3, ...overrides };
}
function runRecord(overrides = {}) {
  return { runId: 'RUN-001', version: 1, payrollMonth: '2026-09', cutoff: '2026-09-30',
    departmentScope: ['SURVEY'], rulesVersion: 'rules-v1', createdBy: 'hr@example.test',
    sourceSnapshot: { employeeRows: [sourceRow()] }, inputs: [employee()], decisions: {},
    sourceConfigs: [mappingConfig()], warnings: [], acknowledgements: [],
    results: [{ employeeId: 'EMP-001', department: 'SURVEY', payrollMonth: '2026-09',
      components: { basic: { calculatedAmount: 15000, amount: 15000 }, probation: { calculatedAmount: 12000, amount: 12000 }, referral: { calculatedAmount: 0, amount: 0 }, deductions: { calculatedAmount: 0, amount: 0 } },
      total: 27000, warnings: [], benefitCandidates: [{ eligible: true, amount: 12000, benefitKey: 'PROBATION:EMP-001' }] }], ...overrides };
}
module.exports = { employee, rules, decisionSet, periodOptions, attendance, probationDecision, benefitLedger, payrollRules, mappingConfig, sourceRow, runRecord };
