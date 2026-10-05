const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadAppsScript } = require('./helpers/load-apps-script');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const { PayrollOrchestrator } = loadAppsScript();
  const config = { department: 'SURVEY', spreadsheetId: 'source-survey', leaveSpreadsheetId: 'leave-survey',
    employeeTab: 'Team', attendanceTab: 'Days', employeeHeaderRow: 1, attendanceHeaderRow: 1,
    employeeColumns: { employeeId: 'ID', americanName: 'Name', firstWorkingDay: 'Joined', transfers: 'Transfers' },
    attendanceColumns: { employeeId: 'ID', date: 'Day', status: 'Status' },
    approvalColumns: { runId: 'Run ID', status: 'Payroll Status' } };
  const period = { payrollMonth: '2026-09', startDate: '2026-09-01', endDate: '2026-09-30', monthEndDate: '2026-09-30', daysInMonth: 30, isComplete: true };
  const joined = options.firstWorkingDay || '2026-08-01';
  const rawEmployee = { headers: ['ID', 'Name', 'Joined', 'Transfers'], values: ['EMP-001', 'Alex Smith', joined, 10], displayValues: ['EMP-001', 'Alex Smith', joined, '10'], rowNumber: 2 };
  const rawAttendance = { headers: ['ID', 'Day', 'Status'], values: ['EMP-001', '2026-09-01', 'PRESENT'], displayValues: ['EMP-001', '2026-09-01', 'PRESENT'], rowNumber: 2 };
  const calls = [];
  const configs = options.configs || [config];
  const sourceGateway = {
    validateAccess(c) { return options.validateAccess ? options.validateAccess(c) : { valid: true, errors: [], warnings: [] }; },
    readDepartment(c, p) {
      calls.push(['read', c.department]);
      if (options.readDepartment) return options.readDepartment(c, p, rawEmployee, rawAttendance);
      return { department: c.department, period: p, employeeRows: [rawEmployee], attendanceRows: [rawAttendance] };
    },
    writeApprovalState(c, writes) { calls.push(['write', c.department, writes]); return { valid: true, errors: [] }; }
  };
  const repository = options.repository || {
    createDraft(run) { calls.push(['draft', run]); return { ...run, state: 'DRAFT', revision: 1 }; },
    getRun(id) { return this.run; },
    applyOverride(...args) { calls.push(['override', ...args]); return { valid: true }; },
    approve(id, actor) { calls.push(['approve', id, actor]); return { valid: true, state: 'APPROVED', runId: id }; }
  };
  return { PayrollOrchestrator, config, period, sourceGateway, repository, calls,
    orchestrator: PayrollOrchestrator && PayrollOrchestrator.create({
      sourceGateway, repository, getConfigs: () => configs, getRules: options.getRules || (() => ({ salaries: {
        SURVEY: { before: { basic: 12000, abs: 2000 }, after: { basic: 15000, abs: 3000 } },
        RESERVATIONS: { before: { basic: 12000, abs: 2000 }, after: { basic: 15000, abs: 3000 } },
        SALES: { before: { basic: 16000, abs: 4000 }, after: { basic: 16000, abs: 4000 } },
        TDS: { before: { basic: 18000, abs: 0 }, after: { basic: 21000, abs: 0 } },
        MANAGEMENT: { before: { basic: 21000, abs: 0 }, after: { basic: 27000, abs: 0 } }
      } })),
      rulesVersion: 'rules-v1', clock: () => '2026-10-04T10:00:00.000Z', actor: () => 'hr@example.test',
      buildPeriod: () => period, readDecisions: () => ({}), auditStore: options.auditStore,
      getHolidayCalendar: () => options.holidays || []
    }) };
}

test('a one-department validation returns normalized employees and preserves its source snapshot', () => {
  const { orchestrator, calls } = fixture();
  const report = orchestrator.validateRequest({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(report.valid, true);
  assert.deepEqual(plain(report.employees.map(employee => employee.americanName)), ['Alex Smith']);
  assert.equal(report.sourceSnapshot.SURVEY.employeeRows[0].values[0], 'EMP-001');
  assert.deepEqual(calls[0], ['read', 'SURVEY']);
});

test('All departments keeps valid departments available when duplicate IDs block one department', () => {
  const base = fixture();
  const secondConfig = { ...base.config, department: 'RESERVATIONS' };
  const { orchestrator } = fixture({ configs: [base.config, secondConfig], readDepartment(config, period, employeeRow, attendanceRow) {
    const employeeRows = config.department === 'SURVEY' ? [employeeRow, employeeRow] : [employeeRow];
    return { department: config.department, period, employeeRows, attendanceRows: [attendanceRow] };
  } });
  const report = orchestrator.validateRequest({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });
  assert.equal(report.valid, true);
  assert.equal(report.errors.some(error => error.code === 'DUPLICATE_EMPLOYEE_ID' && error.department === 'SURVEY'), true);
  assert.deepEqual(plain(report.employees.map(employee => employee.department)), ['RESERVATIONS']);
  assert.equal(report.sourceSnapshot.SURVEY.employeeRows.length, 2);
});

test('All mode drafts healthy departments and returns failed department errors', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  const { orchestrator, calls } = fixture({ configs: [base.config, reservations], readDepartment(config, period, employeeRow, attendanceRow) {
    if (config.department === 'RESERVATIONS') throw new Error('Reservations workbook unavailable');
    return { department: config.department, period, employeeRows: [employeeRow], attendanceRows: [attendanceRow] };
  } });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] };
  const validation = orchestrator.validateRequest(request);
  assert.equal(validation.valid, true);
  assert.equal(validation.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(validation.errors.some(error => error.department === 'RESERVATIONS'), true);
  const draft = orchestrator.calculateDraft(request);
  assert.equal(draft.valid, true, JSON.stringify(plain(draft)));
  assert.equal(draft.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(draft.departmentErrors.some(error => error.department === 'RESERVATIONS'), true);
  assert.deepEqual(plain(draft.results.map(result => result.department)), ['SURVEY']);
  assert.equal(calls.some(call => call[0] === 'draft'), true);
});

test('a single invalid department still blocks draft creation', () => {
  const { orchestrator, calls } = fixture({ readDepartment() { throw new Error('Survey workbook unavailable'); } });
  const result = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(result.valid, false);
  assert.equal(result.state, 'BLOCKED');
  assert.equal(result.errors[0].department, 'SURVEY');
  assert.equal(calls.some(call => call[0] === 'draft'), false);
});

test('cross-department Employee ID collisions exclude every affected department without replacing attendance', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  const management = { ...base.config, department: 'MANAGEMENT' };
  const { orchestrator } = fixture({ configs: [base.config, reservations, management], readDepartment(config, period, employeeRow, attendanceRow) {
    const employeeId = config.department === 'MANAGEMENT' ? 'EMP-003' : 'EMP-001';
    const name = config.department === 'SURVEY' ? 'Survey Alex' : config.department === 'RESERVATIONS' ? 'Reservation Alex' : 'Morgan Manager';
    const status = config.department === 'RESERVATIONS' ? 'NS' : 'PRESENT';
    const employee = { ...employeeRow, values: [employeeId, name, '2026-08-01', 10], displayValues: [employeeId, name, '2026-08-01', '10'] };
    const attendance = { ...attendanceRow, values: [employeeId, '2026-09-01', status], displayValues: [employeeId, '2026-09-01', status] };
    return { department: config.department, period, employeeRows: [employee], attendanceRows: [attendance] };
  } });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] };
  const validation = orchestrator.validateRequest(request);
  assert.equal(validation.valid, true);
  assert.equal(validation.failedDepartments.includes('SURVEY'), true);
  assert.equal(validation.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(validation.errors.filter(error => error.code === 'CROSS_DEPARTMENT_EMPLOYEE_ID').length, 2);
  assert.deepEqual(plain(validation.employees.map(employee => employee.department)), ['MANAGEMENT']);
  assert.equal(validation.attendanceByEmployee['EMP-001'], undefined);
  assert.equal(validation.attendanceByEmployee['EMP-003'][0].status, 'PRESENT');
  const draft = orchestrator.calculateDraft(request);
  assert.equal(draft.valid, true, JSON.stringify(plain(draft)));
  assert.deepEqual(plain(draft.results.map(result => result.employeeId)), ['EMP-003']);
});

test('a valid draft is calculated and persisted with its source snapshot and server actor', () => {
  const { orchestrator, calls } = fixture();
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(run.valid, true, JSON.stringify(plain(run)));
  assert.equal(run.state, 'DRAFT');
  assert.equal(run.createdBy, 'hr@example.test');
  assert.equal(run.results[0].employeeId, 'EMP-001');
  assert.equal(calls.some(call => call[0] === 'draft' && call[1].sourceSnapshot.SURVEY.employeeRows[0].values[0] === 'EMP-001'), true);
});

test('confirmed holiday work applies its calendar dates only to selected Employee IDs', () => {
  const { orchestrator } = fixture({ holidays: [{ holidayId: 'H-1', name: 'Test holiday', actualHolidayDates: ['2026-09-14'] }] });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'],
    decisions: { holidayWork: { holidayId: 'H-1', applies: true, employeeIds: ['EMP-001'], evidenceIds: [] } } });
  assert.equal(run.valid, true);
  assert.equal(run.results[0].components.extraDays.byDate[0].date, '2026-09-14');
  assert.equal(run.results[0].components.extraDays.byDate[0].units, 2);
});

test('eligible probation payments require an HR decision that is saved with the draft', () => {
  const { orchestrator } = fixture({ firstWorkingDay: '2026-01-01' });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] };
  const validation = orchestrator.validateRequest(request);
  assert.equal(validation.unresolvedDecisionCount, 1);
  assert.equal(validation.decisionRequirements[0].americanName, 'Alex Smith');
  const blocked = orchestrator.calculateDraft(request);
  assert.equal(blocked.valid, false);
  assert.equal(blocked.errors[0].code, 'DECISION_REQUIRED');
  const decisions = { employeeDecisions: { 'EMP-001': { probation: { approved: false } } } };
  const run = orchestrator.calculateDraft({ ...request, decisions });
  assert.equal(run.valid, true);
  assert.equal(run.decisions.employeeDecisions['EMP-001'].probation.approved, false);
});

test('unresolved OCR entries block draft creation and approval', () => {
  const { orchestrator, calls, repository } = fixture();
  const decisions = { ocr: { unresolvedCount: 1, attempts: [{ manualIssues: [{ kind: 'AMBIGUOUS', resolved: false }] }] } };
  const draft = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'], decisions });
  assert.equal(draft.valid, false);
  assert.equal(draft.errors[0].code, 'OCR_UNRESOLVED');
  assert.equal(calls.some(call => call[0] === 'draft'), false);
  repository.getRun = () => ({ runId: 'RUN-X', state: 'DRAFT', decisions });
  const approval = orchestrator.approveRun('RUN-X', 'approver');
  assert.equal(approval.valid, false);
  assert.equal(approval.errors[0].code, 'OCR_UNRESOLVED');
  assert.equal(calls.some(call => call[0] === 'approve'), false);
});

test('screenshot evidence is stored before OCR and the bridge retains OCR text in restricted audit storage', () => {
  const { MenuAndApi } = loadAppsScript();
  const events = [], stored = [];
  const api = MenuAndApi.create({
    orchestrator: { validateRequest: () => ({ valid: true, employees: [{ employeeId: 'EMP-001', americanName: 'Alex Smith', department: 'SURVEY' }] }) },
    getEmployees: () => [{ employeeId: 'EMP-001', americanName: 'Alex Smith', department: 'SURVEY' }],
    getEmployeesForRun: () => [{ employeeId: 'EMP-001', americanName: 'Alex Smith', department: 'SURVEY' }],
    actor: () => 'hr@example.test', clock: () => '2026-10-04T10:00:00.000Z',
    decodeImage: value => value, makeImageBlob: (bytes, type, name) => ({ bytes, type, name }),
    makeAuditBlob: value => ({ json: value }),
    ocrService: {
      storeEvidence(blob, runId, actor) { events.push(['store', blob, runId, actor]); const item = { evidenceId: 'E-' + (events.length), runId, actor, storedAt: '2026-10-04T10:00:00.000Z' }; stored.push(blob); return item; },
      extractText() { events.push(['extract']); return { text: 'Alex Smith', detected: true }; },
      matchAmericanNames(text, employees) { events.push(['match', text]); return { matches: [{ americanName: 'Alex Smith', employeeId: employees[0].employeeId, status: 'PENDING_CONFIRMATION', confirmed: false }], ambiguous: [], unmatched: [], warnings: [] }; }
    }
  });
  const result = api.processHolidayScreenshot({ runId: 'RUN-9', imageData: 'data:image/png;base64,AAA=', fileName: 'holiday.png', contentType: 'image/png' });
  assert.equal(events[0][0], 'store');
  assert.equal(events[1][0], 'extract');
  assert.equal(stored.length, 2);
  assert.equal(stored.some(item => item && item.json && JSON.parse(item.json).extractedText === 'Alex Smith'), true);
  assert.equal(JSON.stringify(result).includes('Alex Smith'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'extractedText'), false);
});

test('confirmed and manually resolved OCR attempts are durably linked to the payroll draft', () => {
  const saved = [];
  const { orchestrator } = fixture({ auditStore: { persistDecisions(record) {
    saved.push(plain(record));
    return [{ evidenceId: 'AUDIT-FINAL', runId: record.runId, actor: record.actor, storedAt: record.timestamp }];
  } } });
  const decisions = { holidayWork: { evidenceIds: ['IMAGE-1'] }, ocr: {
    unresolvedCount: 0, confirmedEmployeeIds: ['EMP-001'],
    attempts: [{ evidenceId: 'IMAGE-1', matches: [{ americanName: 'Alex Smith', employeeId: 'EMP-001', confirmed: true }],
      manualIssues: [{ kind: 'UNMATCHED', resolved: true, employeeIds: ['EMP-001'] }] }]
  } };
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'], decisions });
  assert.equal(run.valid, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].evidenceIds[0], 'IMAGE-1');
  assert.equal(saved[0].attempts[0].manualIssues[0].employeeIds[0], 'EMP-001');
  assert.equal(run.ocrAuditEvidence[0].evidenceId, 'AUDIT-FINAL');
});

test('approval is denied when the allowlist is absent and permits configured addresses case-insensitively', () => {
  const { MenuAndApi } = loadAppsScript();
  const calls = [];
  const orchestrator = { approveRun(id, email) { calls.push([id, email]); return { valid: true, state: 'APPROVED' }; } };
  const missing = MenuAndApi.create({ orchestrator, actor: () => 'hr@example.test' }).approveRun('RUN-1');
  assert.equal(missing.valid, false);
  assert.equal(missing.errors[0].code, 'APPROVER_CONFIGURATION_MISSING');
  const denied = MenuAndApi.create({ orchestrator, actor: () => 'hr@example.test', approverEmails: ['other@example.test'] }).approveRun('RUN-1');
  assert.equal(denied.errors[0].code, 'APPROVER_NOT_AUTHORIZED');
  const approved = MenuAndApi.create({ orchestrator, actor: () => 'HR@Example.Test', approverEmails: ['hr@example.test'] }).approveRun('RUN-1');
  assert.equal(approved.valid, true);
  assert.equal(calls.length, 1);
});

test('sidebar API omits internal employee names and raw source snapshots', () => {
  const { MenuAndApi } = loadAppsScript();
  const api = MenuAndApi.create({ actor: () => 'hr@example.test', orchestrator: {
    validateRequest: () => ({ valid: true, runId: 'RUN-1', period: { endDate: '2026-09-30' },
      employees: [{ employeeId: 'EMP-1', americanName: 'Alex Smith', department: 'SURVEY' }],
      inputs: [{ employeeId: 'EMP-1', americanName: 'Alex Smith', realName: 'Private Legal Name' }],
      sourceSnapshot: { SURVEY: { employeeRows: [{ values: ['Private Legal Name'] }] } }, errors: [] }),
    calculateDraft: () => ({ valid: true, runId: 'RUN-1', state: 'DRAFT', inputs: [{ realName: 'Private Legal Name' }],
      sourceSnapshot: { SURVEY: { employeeRows: [{ values: ['Private Legal Name'] }] } },
      results: [{ employeeId: 'EMP-1', americanName: 'Alex Smith', components: {} }] })
  } });
  const validation = api.validateRun({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  const draft = api.calculateDraft({});
  assert.equal(JSON.stringify(validation).includes('Private Legal Name'), false);
  assert.equal(JSON.stringify(draft).includes('Private Legal Name'), false);
  assert.equal(validation.employees[0].americanName, 'Alex Smith');
});

test('sidebar API exposes partial department failures separately from blocking errors', () => {
  const { MenuAndApi } = loadAppsScript();
  const departmentErrors = [{ code: 'SOURCE_ERROR', department: 'RESERVATIONS', message: 'Unavailable' }];
  const orchestrator = {
    validateRequest: () => ({ valid: true, runId: 'RUN-ALL', payrollMonth: '2026-09', period: { endDate: '2026-09-30' },
      employees: [{ employeeId: 'EMP-SUR', americanName: 'Alex Smith', department: 'SURVEY' }],
      failedDepartments: ['RESERVATIONS'], errors: departmentErrors, warnings: [] }),
    calculateDraft: () => ({ valid: true, runId: 'RUN-ALL', state: 'DRAFT', payrollMonth: '2026-09',
      results: [{ employeeId: 'EMP-SUR', department: 'SURVEY' }], failedDepartments: ['RESERVATIONS'],
      departmentErrors, errors: [], blockingErrors: [], warnings: [] })
  };
  const api = MenuAndApi.create({ orchestrator });
  const validation = api.validateRun({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });
  const draft = api.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });
  assert.equal(validation.valid, true);
  assert.deepEqual(plain(validation.errors), []);
  assert.deepEqual(plain(validation.failedDepartments), ['RESERVATIONS']);
  assert.deepEqual(plain(validation.departmentErrors), departmentErrors);
  assert.equal(draft.valid, true);
  assert.deepEqual(plain(draft.failedDepartments), ['RESERVATIONS']);
  assert.deepEqual(plain(draft.departmentErrors), departmentErrors);
  assert.deepEqual(plain(draft.errors), []);
});

test('Apps Script globals are available and the custom menu targets the required actions', () => {
  const menuItems = [], added = [];
  const context = vm.createContext({ SpreadsheetApp: { getUi() { return { createMenu(name) {
    assert.equal(name, 'Salary Calculator');
    return { addItem(label, target) { menuItems.push([label, target]); return this; }, addToUi() { added.push(true); } };
  } }; } } });
  const sourceDir = path.resolve(__dirname, '../src');
  fs.readdirSync(sourceDir).filter(file => file.endsWith('.js')).sort().forEach(file => {
    vm.runInContext(fs.readFileSync(path.join(sourceDir, file), 'utf8'), context, { filename: file });
  });
  ['onOpen', 'showPayrollSidebar', 'getRunSetup', 'validateRun', 'calculateDraft', 'saveOverride',
    'approveRun', 'processHolidayScreenshot', 'matchHolidayNames'].forEach(name => assert.equal(typeof context[name], 'function', name));
  context.onOpen();
  assert.deepEqual(plain(menuItems), [
    ['Run Payroll', 'showPayrollSidebar'], ['Open Latest Results', 'openLatestResults'],
    ['Configuration Check', 'configurationCheck'], ['Initialize/Repair Workbook', 'initializeRepairWorkbook']
  ]);
  assert.equal(added.length, 1);
});

test('multi-day Holiday Calendar ranges expand to every actual date', () => {
  const { MenuAndApi } = loadAppsScript();
  assert.deepEqual(plain(MenuAndApi.normalizeHolidayDates('17-05-2027 to 19-05-2027')),
    ['2027-05-17', '2027-05-18', '2027-05-19']);
});

test('failed write-back resumes one approval checkpoint without duplicating history or benefits', () => {
  const { RunRepository } = loadAppsScript();
  const tables = new Map(), events = [];
  let failWrite = true, locked = false;
  const getTable = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const gateway = {
    read(name, key) { return getTable(name).has(key) ? plain(getTable(name).get(key)) : null; },
    upsert(name, key, value) { getTable(name).set(key, plain(value)); events.push(['upsert', name, key]); },
    appendUnique(name, key, value) { if (!getTable(name).has(key)) getTable(name).set(key, plain(value)); events.push(['append', name, key]); },
    list(name) { return [...getTable(name).values()].map(plain); }
  };
  const lockService = { getDocumentLock() { return { waitLock() { assert.equal(locked, false); locked = true; }, releaseLock() { locked = false; } }; } };
  const base = fixture();
  const { PayrollOrchestrator, config, sourceGateway, period } = base;
  sourceGateway.writeApprovalState = (sourceConfig, writes) => {
    events.push(['source', sourceConfig.department, plain(writes)]);
    return failWrite ? { valid: false, errors: [{ code: 'WRITE_ERROR' }] } : { valid: true, errors: [] };
  };
  const repository = RunRepository.create({ gateway, lockService, now: () => '2026-10-04T10:00:00.000Z', sourceGateway });
  const orchestrator = PayrollOrchestrator.create({ sourceGateway, repository, getConfigs: () => [config],
    getRules: () => ({ salaries: { SURVEY: { before: { basic: 12000, abs: 2000 }, after: { basic: 15000, abs: 3000 } } } }),
    rulesVersion: 'rules-v1', clock: () => '2026-10-04T10:00:00.000Z', actor: () => 'hr@example.test', buildPeriod: () => period });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(run.valid, true);
  const first = orchestrator.approveRun(run.runId, 'first@example.test');
  assert.equal(first.valid, false);
  assert.equal(first.resumable, true);
  assert.equal(repository.getRun(run.runId).state, 'DRAFT');
  failWrite = false;
  const retry = orchestrator.approveRun(run.runId, 'second@example.test');
  assert.equal(retry.valid, true);
  assert.equal(repository.getRun(run.runId).state, 'APPROVED');
  assert.equal(gateway.list('Payment Ledger').length, 0);
  assert.equal(gateway.list('Payroll History').filter(record => record.state === 'APPROVED').length, 1);
  const sourceCalls = events.filter(event => event[0] === 'source').length;
  const secondApproval = orchestrator.approveRun(run.runId, 'third@example.test');
  assert.deepEqual(plain(secondApproval), plain(retry));
  assert.equal(events.filter(event => event[0] === 'source').length, sourceCalls);
});

test('effective latest results include employees outside a scoped approval', () => {
  const { RunRepository } = loadAppsScript();
  const tables = new Map();
  const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const gateway = {
    read(name, key) { return table(name).has(key) ? plain(table(name).get(key)) : null; },
    upsert(name, key, value) { table(name).set(key, plain(value)); },
    appendUnique(name, key, value) { if (!table(name).has(key)) table(name).set(key, plain(value)); },
    list(name) { return Array.from(table(name).values()).map(plain); }
  };
  const lockService = { getDocumentLock() { return { waitLock() {}, releaseLock() {} }; } };
  let repository, failRender = true, rendered = [];
  const reservationResult = { employeeId: 'EMP-RES', americanName: 'Jamie Doe', department: 'RESERVATIONS',
    payrollMonth: '2026-09', total: 100, components: {} };
  gateway.upsert('Payroll Runs', 'RUN-RES', { runId: 'RUN-RES', version: 1, state: 'APPROVED', payrollMonth: '2026-09',
    cutoff: '2026-09-30', approvedAt: '2026-10-01T00:00:00.000Z', results: [reservationResult] });
  gateway.upsert('Latest Results', 'EMP-RES', { runId: 'RUN-RES', version: 1, payrollMonth: '2026-09',
    cutoff: '2026-09-30', result: reservationResult });
  gateway.renderLatestResults = () => {
    if (failRender) { failRender = false; throw new Error('Simulated interruption during latest-results render'); }
    rendered = repository.listLatestResults().map(record => record.result.employeeId).sort();
  };
  repository = RunRepository.create({ gateway, lockService, now: () => '2026-10-02T00:00:00.000Z' });
  const surveyResult = { employeeId: 'EMP-SUR', americanName: 'Alex Smith', department: 'SURVEY',
    payrollMonth: '2026-09', total: 200, components: {} };
  repository.createDraft({ runId: 'RUN-SUR', version: 1, rulesVersion: 'v1', createdBy: 'hr@example.test',
    payrollMonth: '2026-09', cutoff: '2026-09-30', sourceSnapshot: {}, results: [surveyResult], inputs: [], decisions: {}, sourceConfigs: [] });
  assert.throws(() => repository.approve('RUN-SUR', 'approver@example.test'), /Simulated interruption/);
  assert.equal(repository.getRun('RUN-SUR').approvalCheckpoint.latestStatus, 'PENDING');
  repository.approve('RUN-SUR', 'approver@example.test');

  const latest = repository.listLatestResults();
  assert.deepEqual(plain(latest.map(record => record.result.employeeId).sort()), ['EMP-RES', 'EMP-SUR']);
  assert.equal(latest.find(record => record.result.employeeId === 'EMP-RES').runId, 'RUN-RES');
  assert.equal(latest.find(record => record.result.employeeId === 'EMP-SUR').runId, 'RUN-SUR');
  assert.deepEqual(plain(rendered), ['EMP-RES', 'EMP-SUR']);
});
