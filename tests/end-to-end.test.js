const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { payrollRules, periodOptions, employee, attendance } = require('./helpers/fixtures');

const app = loadAppsScript();
const plain = value => JSON.parse(JSON.stringify(value));
const period = app.PayrollPeriod.buildPeriod(periodOptions());
const rules = payrollRules();

function calculate(overrides = {}) {
  return app.PayrollEngine.calculateEmployee({ employee: employee({ firstWorkingDay: '2026-08-01', ...overrides.employee }),
    performance: overrides.performance || { transfers: 0, sales: 0, conversionRate: 0, agents: [] },
    attendance: attendance(overrides.attendance), decisions: overrides.decisions || {}, ledger: overrides.ledger || [],
    period: overrides.period || period, rules });
}

function memoryGateway() {
  const tables = new Map();
  const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  return {
    read(name, key) { return table(name).has(key) ? plain(table(name).get(key)) : null; },
    upsert(name, key, value) { table(name).set(key, plain(value)); },
    appendUnique(name, key, value) { if (!table(name).has(key)) table(name).set(key, plain(value)); },
    list(name) { return [...table(name).values()].map(plain); }
  };
}

function employeeRow(id, name, department, additions = {}) {
  return { headers: ['ID', 'Name', 'Department', 'Joined', 'Left', 'Annual Days', 'Transfers', 'Sales', 'Conversion', 'Agents', 'Referrer'],
    values: [id, name, department, additions.firstWorkingDay || '2026-08-01', additions.lastWorkingDay || '', additions.annualLeaveBalance || 0,
      additions.transfers || 0, additions.sales || 0, additions.conversionRate || 0, additions.agents || '', additions.referrerEmployeeId || ''],
    displayValues: [id, name, department, additions.firstWorkingDay || '2026-08-01', additions.lastWorkingDay || '', String(additions.annualLeaveBalance || 0),
      String(additions.transfers || 0), String(additions.sales || 0), String(additions.conversionRate || 0), String(additions.agents || ''), additions.referrerEmployeeId || ''], rowNumber: 2 };
}

function config(department) {
  return { department, spreadsheetId: `source-${department}`, leaveSpreadsheetId: `leave-${department}`,
    employeeTab: 'Team', attendanceTab: 'Attendance', employeeHeaderRow: 1, attendanceHeaderRow: 1,
    employeeColumns: { employeeId: 'ID', americanName: 'Name', department: 'Department', firstWorkingDay: 'Joined', lastWorkingDay: 'Left',
      annualLeaveBalance: 'Annual Days', transfers: 'Transfers', sales: 'Sales', conversionRate: 'Conversion', agents: 'Agents', referrerEmployeeId: 'Referrer' },
    attendanceColumns: { employeeId: 'ID', date: 'Day', status: 'Status' },
    approvalColumns: { runId: 'Run ID', status: 'Payroll Status', paid: 'Paid' } };
}

function integration(withDeductions = false, deductionRows) {
  const configs = ['SURVEY', 'RESERVATIONS', 'SALES', 'TDS', 'MANAGEMENT'].map(config);
  if (withDeductions) Object.assign(configs[0], { deductionSpreadsheetId: 'survey-deductions', deductionTab: 'Charges',
    deductionColumns: { employeeId: 'ID', amount: 'Amount', date: 'Date', reason: 'Reason' } });
  const rows = {
    SURVEY: [employeeRow('EMP-SUR', 'Alex Survey', 'SURVEY', { firstWorkingDay: '2026-06-30', transfers: 10 })],
    RESERVATIONS: [employeeRow('EMP-RES', 'Jamie Reservations', 'RESERVATIONS', { firstWorkingDay: '2026-01-01', lastWorkingDay: '2026-09-30', annualLeaveBalance: 4, transfers: 0 })],
    SALES: [employeeRow('EMP-SAL', 'Casey Sales', 'SALES', { firstWorkingDay: '2026-01-01', sales: 37, conversionRate: 4.2 })],
    TDS: [employeeRow('EMP-TDS', 'Morgan TDS', 'TDS', { firstWorkingDay: '2026-01-01' })],
    MANAGEMENT: [employeeRow('EMP-MGT', 'Taylor Management', 'MANAGEMENT', { firstWorkingDay: '2026-08-01', referrerEmployeeId: 'EMP-SUR' })]
  };
  const attendanceRows = Object.fromEntries(Object.keys(rows).map(dept => [dept, rows[dept].map(row => ({
    headers: ['ID', 'Day', 'Status'], values: [row.values[0], '2026-09-10', dept === 'TDS' ? 'NS' : dept === 'SURVEY' ? 'HOLIDAY' : 'PRESENT'],
    displayValues: [row.values[0], '2026-09-10', dept === 'TDS' ? 'NS' : dept === 'SURVEY' ? 'HOLIDAY' : 'PRESENT'], rowNumber: 2
  }))]));
  const events = [];
  let failWriteBack = true;
  const sourceGateway = {
    validateAccess() { return { valid: true, errors: [], warnings: [] }; },
    readDepartment(c, p) { return { department: c.department, period: p, employeeRows: rows[c.department], attendanceRows: attendanceRows[c.department] }; },
    readDeductionRows() { return deductionRows || [
      { headers: ['ID', 'Amount', 'Date', 'Reason'], values: ['EMP-SUR', 250, '2026-09-14', 'Survey charge'], rowNumber: 3 },
      { headers: ['ID', 'Amount', 'Date', 'Reason'], values: ['EMP-SUR', 999, '2026-10-01', 'Future charge'], rowNumber: 4 }
    ]; },
    writeApprovalState(c, writes) { events.push({ department: c.department, writes: plain(writes) });
      return failWriteBack ? { valid: false, errors: [{ code: 'SIMULATED_WRITE_FAILURE', message: 'Source is temporarily unavailable.' }] } : { valid: true, errors: [] }; }
  };
  const gateway = memoryGateway();
  const lockService = { getDocumentLock() { return { waitLock() {}, releaseLock() {} }; } };
  const repository = app.RunRepository.create({ gateway, lockService, now: () => '2026-10-04T10:00:00.000Z', sourceGateway });
  gateway.upsert('Payment Ledger', 'SALES_ABS:EMP-SAL:2026-07', { benefitKey: 'SALES_ABS:EMP-SAL:2026-07',
    type: 'SALES_ABS', employeeId: 'EMP-SAL', amount: 4000, payrollMonth: '2026-07', runId: 'RUN-JUL', paid: false });
  gateway.upsert('Payment Ledger', 'SALES_ABS:EMP-SAL:2026-08', { benefitKey: 'SALES_ABS:EMP-SAL:2026-08',
    type: 'SALES_ABS', employeeId: 'EMP-SAL', amount: 4000, payrollMonth: '2026-08', runId: 'RUN-AUG', paid: false });
  const orchestrator = app.PayrollOrchestrator.create({ sourceGateway, repository, getConfigs: () => configs,
    getRules: () => rules, getBenefitLedger: () => [
      { type: 'SALES_ABS', employeeId: 'EMP-SAL', payrollMonth: '2026-07', amount: 4000, paid: false },
      { type: 'SALES_ABS', employeeId: 'EMP-SAL', payrollMonth: '2026-08', amount: 4000, paid: false }
    ], rulesVersion: 'e2e-rules-v1', clock: () => '2026-10-04T10:00:00.000Z', actor: () => 'hr@example.test',
    createRunId: () => 'RUN-E2E-2026-09', buildPeriod: () => period, getHolidayCalendar: () => [
       { holidayId: 'H-SEP', holidayName: 'September holiday', actualHolidayDates: ['2026-09-10'] }
    ] });
  return { configs, rows, attendanceRows, events, gateway, repository, orchestrator,
    allowWriteBack() { failWriteBack = false; } };
}

test('department and payroll scenario fixtures preserve complete component breakdowns', () => {
  const expected = {
    SURVEY: ['basic', 'abs', 'commission', 'probation', 'referral', 'extraDays', 'annualBalance', 'additions', 'deductions'],
    RESERVATIONS: ['basic', 'abs', 'commission', 'probation', 'referral', 'extraDays', 'annualBalance', 'additions', 'deductions'],
    SALES: ['basic', 'abs', 'commission', 'probation', 'referral', 'extraDays', 'annualBalance', 'additions', 'deductions'],
    TDS: ['basic', 'abs', 'commission', 'probation', 'referral', 'extraDays', 'annualBalance', 'additions', 'deductions'],
    MANAGEMENT: ['basic', 'abs', 'commission', 'probation', 'referral', 'extraDays', 'annualBalance', 'additions', 'deductions']
  };
  const scenarios = [
    { department: 'SURVEY', employee: { employeeId: 'EMP-SUR', department: 'SURVEY', firstWorkingDay: '2026-06-30' },
      attendance: { attendedScheduledDays: 20, workedHolidays: ['2026-09-10'] }, decisions: { probation: { approved: true }, referrals: [{ employeeId: 'EMP-REF', americanName: 'Robin Referral', department: 'SURVEY', firstWorkingDay: '2026-08-01', referrerEmployeeId: 'EMP-SUR' }] } },
    { department: 'RESERVATIONS', employee: { employeeId: 'EMP-RES', department: 'RESERVATIONS', firstWorkingDay: '2026-01-01', lastWorkingDay: '2026-09-30', annualLeaveBalance: 4 } },
    { department: 'SALES', employee: { employeeId: 'EMP-SAL', department: 'SALES', firstWorkingDay: '2026-01-01' },
      performance: { sales: 37, conversionRate: 4.2 }, ledger: [{ type: 'SALES_ABS', employeeId: 'EMP-SAL', payrollMonth: '2026-07', amount: 4000 }, { type: 'SALES_ABS', employeeId: 'EMP-SAL', payrollMonth: '2026-08', amount: 4000 }] },
    { department: 'TDS', employee: { employeeId: 'EMP-TDS', department: 'TDS', firstWorkingDay: '2026-01-01' }, attendance: { attendedScheduledDays: 20, nsPresent: true } },
    { department: 'MANAGEMENT', employee: { employeeId: 'EMP-MGT', department: 'MANAGEMENT', firstWorkingDay: '2026-01-01' } }
  ];
  for (const scenario of scenarios) {
    const result = calculate(scenario);
    assert.deepEqual(Object.keys(result.components), expected[scenario.department]);
    for (const component of Object.values(result.components)) {
      assert.equal(typeof component.amount, 'number');
      assert.equal(typeof component.calculatedAmount, 'number');
    }
    assert.equal(result.total, app.PayrollEngine.sumComponents(result.components));
  }
  assert.equal(calculate(scenarios[0]).components.probation.amount, 12000);
  assert.equal(calculate(scenarios[0]).components.referral.amount, 10000);
  assert.equal(calculate(scenarios[0]).components.extraDays.amount, 800);
  assert.equal(calculate(scenarios[1]).components.annualBalance.amount, 2000);
  assert.equal(calculate(scenarios[2]).components.commission.amount, 24050);
  assert.equal(calculate(scenarios[2]).components.abs.amount, 12000);
  assert.equal(calculate(scenarios[3]).components.abs.amount, 0);
  assert.equal(calculate(scenarios[3]).components.deductions.amount, -2100);
  assert.equal(calculate(scenarios[4]).components.abs.amount, 0);
  const overridden = calculate({ employee: { department: 'SURVEY', firstWorkingDay: '2026-08-01' }, decisions: {
    overrides: [{ component: 'basic', value: 12345, reason: 'E2E approved correction', editor: 'hr@example.test', timestamp: '2026-10-04T10:00:00.000Z' }]
  } });
  assert.equal(overridden.components.basic.calculatedAmount, 12000);
  assert.equal(overridden.components.basic.amount, 12345);
});

test('Survey deductions import by Employee ID within cutoff and retain source evidence in the run', () => {
  const fx = integration(true);
  const draft = fx.orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'],
    decisions: { employeeDecisions: { 'EMP-SUR': { probation: { approved: true } } } } });
  assert.equal(draft.valid, true, JSON.stringify(plain(draft.errors)));
  assert.equal(draft.results[0].components.deductions.amount, -250);
  const run = fx.repository.getRun(draft.runId);
  assert.deepEqual(plain(run.decisions.employeeDecisions['EMP-SUR'].deductions), [{ amount: 250, reason: 'Survey charge',
    source: { spreadsheetId: 'survey-deductions', tab: 'Charges', row: 3, date: '2026-09-14' } }]);
  assert.equal(run.sourceSnapshot.SURVEY.deductionRows.length, 2);
});

test('unmatched Survey deduction Employee ID blocks the department with source coordinates', () => {
  const fx = integration(true, [{ headers: ['ID', 'Amount', 'Date', 'Reason'],
    values: ['UNKNOWN', 250, '2026-09-14', 'Survey charge'], rowNumber: 7 }]);
  const report = fx.orchestrator.validateRequest({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(report.valid, false);
  assert.equal(report.errors[0].code, 'UNMATCHED_DEDUCTION_EMPLOYEE_ID');
  assert.deepEqual(plain(report.errors[0].source), { spreadsheetId: 'survey-deductions', tab: 'Charges', row: 7, date: '2026-09-14' });
});

test('malformed Survey deduction mapping blocks Survey while All retains healthy departments', () => {
  const fx = integration(true);
  fx.configs[0].department = 'survey';
  fx.configs[0].deductionColumns = '{broken json';
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END' };
  const all = fx.orchestrator.validateRequest({ ...request, departmentScope: ['ALL'] });
  assert.equal(all.valid, true);
  assert.deepEqual(plain(all.failedDepartments), ['SURVEY']);
  assert.equal(all.errors[0].department, 'SURVEY');
  assert.equal(all.errors[0].code, 'INVALID_SOURCE_MAPPING');
  assert.equal(all.employees.length, 4);
  const survey = fx.orchestrator.validateRequest({ ...request, departmentScope: ['SURVEY'] });
  assert.equal(survey.valid, false);
  assert.equal(survey.errors[0].department, 'SURVEY');
});

test('all-department draft, audited override, approval recovery, history, and ledger are durable', () => {
  const fx = integration();
  const draft = fx.orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'], decisions: {
     holidayWork: { holidayId: 'H-SEP', applies: true, employeeIds: ['EMP-SUR'] },
     employeeDecisions: { 'EMP-SUR': { probation: { approved: true } },
       'EMP-RES': { probation: { approved: false } } }
  } });
  assert.equal(draft.valid, true, JSON.stringify(plain(draft.errors)));
  assert.deepEqual(plain(draft.results.map(result => result.department).sort()), ['MANAGEMENT', 'RESERVATIONS', 'SALES', 'SURVEY', 'TDS']);
  const byId = Object.fromEntries(draft.results.map(result => [result.employeeId, result]));
  assert.equal(byId['EMP-SAL'].components.commission.amount, 24050);
  assert.equal(byId['EMP-SAL'].components.abs.amount, 8000);
  assert.equal(byId['EMP-RES'].finalSettlement, true);
  assert.equal(byId['EMP-RES'].components.annualBalance.amount, 2000);
  assert.equal(byId['EMP-TDS'].components.deductions.amount, -2100);
  assert.equal(byId['EMP-MGT'].components.abs.amount, 0);
  assert.equal(byId['EMP-SUR'].components.probation.amount, 12000);
  assert.equal(byId['EMP-SUR'].components.referral.amount, 10000);
  assert.equal(byId['EMP-SUR'].components.extraDays.amount, 800);
  assert.equal(fx.gateway.list('Payroll History').filter(row => row.state === 'DRAFT').length, 1);
  const override = fx.repository.applyOverride(draft.runId, 'EMP-SUR', 'basic', 12345, 'E2E adjustment', 'hr@example.test');
  assert.equal(override.value, 12345);
  const firstApproval = fx.orchestrator.approveRun(draft.runId, 'approver@example.test');
  assert.equal(firstApproval.valid, false);
  assert.equal(firstApproval.resumable, true);
  assert.equal(fx.repository.getRun(draft.runId).state, 'DRAFT');
  assert.equal(fx.gateway.list('Payment Ledger').filter(row => row.runId === draft.runId && !row.type.startsWith('SALES_AB')).length, 2);
  fx.allowWriteBack();
  const retry = fx.orchestrator.approveRun(draft.runId, 'approver@example.test');
  assert.equal(retry.valid, true);
  assert.equal(retry.state, 'APPROVED');
  assert.equal(fx.repository.getRun(draft.runId).state, 'APPROVED');
  assert.equal(fx.gateway.list('Payroll History').filter(row => row.state === 'APPROVED').length, 1);
  assert.equal(fx.gateway.list('Payment Ledger').filter(row => row.runId === draft.runId && !row.type.startsWith('SALES_AB')).length, 2);
  assert.equal(fx.gateway.list('Payment Ledger').filter(row => row.type === 'SALES_ABS_SETTLEMENT' && row.runId === draft.runId).length, 1);
  assert.equal(fx.repository.listLatestResults().length, 5);
  assert.equal(fx.events.length, 6);
  assert.equal(fx.events[0].writes.length, 1);
  assert.deepEqual(fx.events.slice(1).map(event => event.department).sort(), ['MANAGEMENT', 'RESERVATIONS', 'SALES', 'SURVEY', 'TDS']);
  assert.ok(fx.events.slice(1).every(event => event.writes.length === 1));
  const duplicateRetry = fx.orchestrator.approveRun(draft.runId, 'another@example.test');
  assert.deepEqual(plain(duplicateRetry), plain(retry));
  assert.equal(fx.events.length, 6);
});
