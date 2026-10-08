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
    validateAccess(c, kind) { return options.validateAccess ? options.validateAccess(c, kind) : { valid: true, errors: [], warnings: [] }; },
    readDepartment(c, p) {
      calls.push(['read', c.department]);
      if (options.readDepartment) return options.readDepartment(c, p, rawEmployee, rawAttendance);
      return { department: c.department, period: p, employeeRows: [rawEmployee], attendanceRows: [rawAttendance] };
    },
    writeApprovalState(c, writes) { calls.push(['write', c.department, writes]); return { valid: true, errors: [] }; }
  };
  if (options.readEmployeeRoster) sourceGateway.readEmployeeRoster = (c, p) => options.readEmployeeRoster(c, p, rawEmployee);
  if (options.readAttendanceRows) sourceGateway.readAttendanceRows = (c, p) => options.readAttendanceRows(c, p, rawAttendance);
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
      getBenefitLedger: options.getBenefitLedger,
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
    const employeeId = config.department === 'SURVEY' ? 'EMP-001' : 'EMP-002';
    const row = { ...employeeRow, values: [employeeId, 'Alex Smith', '2026-08-01', 10], displayValues: [employeeId, 'Alex Smith', '2026-08-01', '10'] };
    const employeeRows = config.department === 'SURVEY' ? [row, row] : [row];
    const attendance = { ...attendanceRow, values: [employeeId, '2026-09-01', 'PRESENT'], displayValues: [employeeId, '2026-09-01', 'PRESENT'] };
    return { department: config.department, period, employeeRows, attendanceRows: [attendance] };
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
  const draft = orchestrator.calculateDraft({ ...request, acknowledgements: { partialDepartmentsFingerprint: validation.partialDepartmentsFingerprint } });
  assert.equal(draft.valid, true, JSON.stringify(plain(draft)));
  assert.equal(draft.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(draft.departmentErrors.some(error => error.department === 'RESERVATIONS'), true);
  assert.equal(draft.acknowledgements.partialDepartmentsFingerprint, validation.partialDepartmentsFingerprint);
  assert.equal(draft.acknowledgements.partialDepartmentsReport.fingerprint, validation.partialDepartmentsFingerprint);
  assert.deepEqual(plain(draft.results.map(result => result.department)), ['SURVEY']);
  assert.equal(calls.some(call => call[0] === 'draft'), true);
});

test('All-mode partial draft requires an explicit acknowledgement of omitted departments', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  const { orchestrator, calls } = fixture({ configs: [base.config, reservations], readDepartment(config, period, employeeRow, attendanceRow) {
    if (config.department === 'RESERVATIONS') throw new Error('Reservations workbook unavailable');
    return { department: config.department, period, employeeRows: [employeeRow], attendanceRows: [attendanceRow] };
  } });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] };
  const unacknowledged = orchestrator.calculateDraft({ ...request, acknowledgements: { partialDepartments: true } });
  assert.equal(unacknowledged.valid, false);
  assert.equal(unacknowledged.errors[0].code, 'ACK_REQUIRED');
  assert.equal(calls.some(call => call[0] === 'draft'), false);

  const report = orchestrator.validateRequest(request);
  const acknowledged = orchestrator.calculateDraft({ ...request, acknowledgements: { partialDepartmentsFingerprint: report.partialDepartmentsFingerprint } });
  assert.equal(acknowledged.valid, true, JSON.stringify(plain(acknowledged)));
  assert.equal(acknowledged.acknowledgements.partialDepartmentsFingerprint, report.partialDepartmentsFingerprint);
});

test('partial-department acknowledgment is bound to the exact revalidated report', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  let reservationFailure = 'Reservations workbook unavailable';
  const { orchestrator, repository, calls } = fixture({ configs: [base.config, reservations], readDepartment(config, period, employeeRow, attendanceRow) {
    if (config.department === 'RESERVATIONS') throw new Error(reservationFailure);
    return { department: config.department, period, employeeRows: [employeeRow], attendanceRows: [attendanceRow] };
  } });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] };
  const firstReport = orchestrator.validateRequest(request);
  const repeatedReport = orchestrator.validateRequest(request);
  assert.equal(typeof firstReport.partialDepartmentsFingerprint, 'string');
  assert.equal(firstReport.partialDepartmentsFingerprint, repeatedReport.partialDepartmentsFingerprint);

  reservationFailure = 'Reservations workbook permissions changed';
  const staleAck = orchestrator.calculateDraft({ ...request, acknowledgements: {
    partialDepartmentsFingerprint: firstReport.partialDepartmentsFingerprint
  } });
  assert.equal(staleAck.valid, false);
  assert.equal(staleAck.errors[0].code, 'ACK_REQUIRED');
  assert.notEqual(staleAck.partialDepartmentsFingerprint, firstReport.partialDepartmentsFingerprint);
  assert.equal(staleAck.departmentErrors.some(error => error.message === reservationFailure), true);

  const currentAck = orchestrator.calculateDraft({ ...request, acknowledgements: {
    partialDepartmentsFingerprint: staleAck.partialDepartmentsFingerprint
  } });
  assert.equal(currentAck.valid, true, JSON.stringify(plain(currentAck)));
  assert.equal(currentAck.acknowledgements.partialDepartmentsFingerprint, staleAck.partialDepartmentsFingerprint);
  assert.equal(currentAck.acknowledgements.partialDepartmentsReport.fingerprint, staleAck.partialDepartmentsFingerprint);
  const savedRun = calls.find(call => call[0] === 'draft')[1];
  assert.equal(savedRun.partialDepartmentsFingerprint, staleAck.partialDepartmentsFingerprint);
  repository.getRun = () => ({ ...savedRun, departmentErrors: savedRun.departmentErrors.concat({
    department: 'RESERVATIONS', code: 'NEW_ERROR', message: 'Altered after draft'
  }) });
  const alteredApproval = orchestrator.approveRun(savedRun.runId, 'approver@example.test');
  assert.equal(alteredApproval.valid, false);
  assert.equal(alteredApproval.errors[0].code, 'ACK_REQUIRED');
  assert.equal(calls.some(call => call[0] === 'approve'), false);
});

test('approval blocks a partial run without its persisted omission acknowledgment', () => {
  const { orchestrator, repository, calls } = fixture();
  repository.getRun = () => ({ runId: 'RUN-PARTIAL', state: 'DRAFT', failedDepartments: ['RESERVATIONS'], acknowledgements: {} });
  const result = orchestrator.approveRun('RUN-PARTIAL', 'approver@example.test');
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'ACK_REQUIRED');
  assert.equal(calls.some(call => call[0] === 'approve'), false);
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
  const draft = orchestrator.calculateDraft({ ...request, acknowledgements: { partialDepartmentsFingerprint: validation.partialDepartmentsFingerprint } });
  assert.equal(draft.valid, true, JSON.stringify(plain(draft)));
  assert.deepEqual(plain(draft.results.map(result => result.employeeId)), ['EMP-003']);
});

test('roster collisions quarantine departments even when one later fails attendance normalization', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  const management = { ...base.config, department: 'MANAGEMENT' };
  const { orchestrator } = fixture({ configs: [base.config, reservations, management], readDepartment(config, period, employeeRow, attendanceRow) {
    const employeeId = config.department === 'MANAGEMENT' ? 'EMP-003' : 'EMP-001';
    const name = config.department === 'SURVEY' ? 'Survey Alex' : config.department === 'RESERVATIONS' ? 'Reservation Alex' : 'Morgan Manager';
    const employee = { ...employeeRow, values: [employeeId, name, '2026-08-01', 10], displayValues: [employeeId, name, '2026-08-01', '10'] };
    const attendance = config.department === 'SURVEY'
      ? { ...attendanceRow, values: ['MISSING-EMPLOYEE', '2026-09-01', 'PRESENT'], displayValues: ['MISSING-EMPLOYEE', '2026-09-01', 'PRESENT'] }
      : { ...attendanceRow, values: [employeeId, '2026-09-01', 'PRESENT'], displayValues: [employeeId, '2026-09-01', 'PRESENT'] };
    return { department: config.department, period, employeeRows: [employee], attendanceRows: [attendance] };
  } });
  const report = orchestrator.validateRequest({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });

  assert.equal(report.valid, true);
  assert.equal(report.failedDepartments.includes('SURVEY'), true);
  assert.equal(report.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(report.errors.some(error => error.code === 'UNMATCHED_EMPLOYEE_ID' && error.department === 'SURVEY'), true);
  assert.deepEqual(plain(report.errors.filter(error => error.code === 'CROSS_DEPARTMENT_EMPLOYEE_ID').map(error => error.department).sort()), ['RESERVATIONS', 'SURVEY']);
  assert.deepEqual(plain(report.employees.map(employee => employee.department)), ['MANAGEMENT']);
});

test('roster collisions are detected before attendance access preflight can fail', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  const management = { ...base.config, department: 'MANAGEMENT' };
  const attendanceReads = [];
  const { orchestrator } = fixture({ configs: [base.config, reservations, management],
    validateAccess(config, kind) {
      if (kind === 'attendance' && config.department === 'SURVEY') return { valid: false,
        errors: [{ code: 'ATTENDANCE_ACCESS_ERROR', message: 'Survey attendance tab cannot be read' }] };
      return { valid: true, errors: [] };
    },
    readEmployeeRoster(config, period, employeeRow) {
      const id = config.department === 'MANAGEMENT' ? 'EMP-003' : 'EMP-001';
      const name = config.department === 'SURVEY' ? 'Survey Alex' : config.department === 'RESERVATIONS' ? 'Reservation Alex' : 'Morgan Manager';
      return [{ ...employeeRow, values: [id, name, '2026-08-01', 10], displayValues: [id, name, '2026-08-01', '10'] }];
    },
    readAttendanceRows(config, period, attendanceRow) {
      attendanceReads.push(config.department);
      const id = config.department === 'MANAGEMENT' ? 'EMP-003' : 'EMP-001';
      return [{ ...attendanceRow, values: [id, '2026-09-01', 'PRESENT'], displayValues: [id, '2026-09-01', 'PRESENT'] }];
    }
  });
  const report = orchestrator.validateRequest({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });

  assert.equal(report.valid, true);
  assert.equal(report.failedDepartments.includes('SURVEY'), true);
  assert.equal(report.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(report.errors.some(error => error.code === 'ATTENDANCE_ACCESS_ERROR' && error.department === 'SURVEY'), true);
  assert.deepEqual(plain(report.errors.filter(error => error.code === 'CROSS_DEPARTMENT_EMPLOYEE_ID').map(error => error.department).sort()), ['RESERVATIONS', 'SURVEY']);
  assert.deepEqual(plain(report.employees.map(employee => employee.department)), ['MANAGEMENT']);
  assert.equal(attendanceReads.includes('SURVEY'), false);
});

test('local duplicate roster IDs also quarantine every department sharing that ID', () => {
  const base = fixture();
  const reservations = { ...base.config, department: 'RESERVATIONS' };
  const management = { ...base.config, department: 'MANAGEMENT' };
  const { orchestrator } = fixture({ configs: [base.config, reservations, management], readDepartment(config, period, employeeRow, attendanceRow) {
    const employeeId = config.department === 'MANAGEMENT' ? 'EMP-003' : 'EMP-X';
    const name = config.department === 'SURVEY' ? 'Survey Alex' : config.department === 'RESERVATIONS' ? 'Reservation Alex' : 'Morgan Manager';
    const row = { ...employeeRow, values: [employeeId, name, '2026-08-01', 10], displayValues: [employeeId, name, '2026-08-01', '10'] };
    const employeeRows = config.department === 'SURVEY' ? [row, { ...row, values: ['EMP-X', 'Second Survey Alex', '2026-08-02', 10], displayValues: ['EMP-X', 'Second Survey Alex', '2026-08-02', '10'] }] : [row];
    const attendance = { ...attendanceRow, values: [employeeId, '2026-09-01', 'PRESENT'], displayValues: [employeeId, '2026-09-01', 'PRESENT'] };
    return { department: config.department, period, employeeRows, attendanceRows: [attendance] };
  } });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] };
  const report = orchestrator.validateRequest(request);

  assert.equal(report.valid, true);
  assert.equal(report.failedDepartments.includes('SURVEY'), true);
  assert.equal(report.failedDepartments.includes('RESERVATIONS'), true);
  assert.equal(report.errors.some(error => error.code === 'DUPLICATE_EMPLOYEE_ID' && error.department === 'SURVEY'), true);
  assert.deepEqual(plain(report.errors.filter(error => error.code === 'CROSS_DEPARTMENT_EMPLOYEE_ID').map(error => error.department).sort()), ['RESERVATIONS', 'SURVEY']);
  assert.deepEqual(plain(report.employees.map(employee => employee.department)), ['MANAGEMENT']);
  const draft = orchestrator.calculateDraft({ ...request, acknowledgements: { partialDepartmentsFingerprint: report.partialDepartmentsFingerprint } });
  assert.equal(draft.valid, true, JSON.stringify(plain(draft)));
  assert.deepEqual(plain(draft.results.map(result => result.department)), ['MANAGEMENT']);
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

test('HOLIDAY attendance without an affirmative dated HR decision pays no holiday units', () => {
  const { orchestrator } = fixture({ holidays: [{ holidayId: 'H-1', actualHolidayDates: ['2026-09-14'] }],
    readDepartment(config, period, employee, attendance) {
      return { department: config.department, period, employeeRows: [employee], attendanceRows: [
        { ...attendance, values: ['EMP-001', '2026-09-14', 'HOLIDAY'] }
      ] };
    } });
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] };
  const undecided = orchestrator.calculateDraft(request);
  assert.equal(undecided.valid, true);
  assert.equal(undecided.results[0].components.extraDays.units, 0);
  const declined = orchestrator.calculateDraft({ ...request,
    decisions: { holidayWork: { holidayId: 'H-1', applies: false, employeeIds: ['EMP-001'] } } });
  assert.equal(declined.valid, true);
  assert.equal(declined.results[0].components.extraDays.units, 0);
});

test('separate holiday decisions select different employees by exact calendar date', () => {
  const employeeB = { headers: ['ID', 'Name', 'Joined', 'Transfers'],
    values: ['EMP-002', 'Blair', '2026-08-01', 0], rowNumber: 3 };
  const { orchestrator } = fixture({ holidays: [
    { holidayId: 'H-1', actualHolidayDates: ['2026-09-14'] },
    { holidayId: 'H-2', actualHolidayDates: ['2026-09-21'] }
  ], readDepartment(config, period, employee, attendance) {
    return { department: config.department, period, employeeRows: [employee, employeeB], attendanceRows: [
      attendance, { ...attendance, values: ['EMP-002', '2026-09-01', 'PRESENT'] }
    ] };
  } });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'],
    decisions: { holidayWork: { dates: [
      { holidayId: 'H-1', date: '2026-09-14', applies: true, employeeIds: ['EMP-001'] },
      { holidayId: 'H-2', date: '2026-09-21', applies: true, employeeIds: ['EMP-002'] }
    ] } } });
  assert.equal(run.valid, true, JSON.stringify(plain(run)));
  assert.deepEqual(plain(run.results.map(result => result.components.extraDays.byDate)), [
    [{ date: '2026-09-14', units: 2 }], [{ date: '2026-09-21', units: 2 }]
  ]);
});

test('approved holiday overlapping an OFF record pays two total units, not three', () => {
  const { orchestrator } = fixture({ holidays: [{ holidayId: 'H-1', actualHolidayDates: ['2026-09-14'] }],
    readDepartment(config, period, employee, attendance) {
      return { department: config.department, period, employeeRows: [employee], attendanceRows: [
        { ...attendance, values: ['EMP-001', '2026-09-14', 'OFF'] }
      ] };
    } });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'],
    decisions: { holidayWork: { holidayId: 'H-1', applies: true, employeeIds: ['EMP-001'] } } });
  assert.equal(run.valid, true);
  assert.deepEqual(plain(run.results[0].components.extraDays.byDate), [{ date: '2026-09-14', units: 2 }]);
});

test('legacy holiday selection cannot silently approve a multi-date calendar entry', () => {
  const { orchestrator } = fixture({ holidays: [{ holidayId: 'H-1', actualHolidayDates: ['2026-09-14', '2026-09-15'] }] });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'],
    decisions: { holidayWork: { holidayId: 'H-1', applies: true, employeeIds: ['EMP-001'] } } });
  assert.equal(run.valid, false);
  assert.equal(run.errors[0].code, 'HOLIDAY_DATE_AMBIGUOUS');
});

test('transition-month NS uses earliest date for one penalty and retains all NS dates', () => {
  const { orchestrator } = fixture({ firstWorkingDay: '2026-07-01', readDepartment(config, period, employee, attendance) {
    return { department: config.department, period, employeeRows: [employee], attendanceRows: [
      { ...attendance, values: ['EMP-001', '2026-09-29', 'NS'] },
      { ...attendance, values: ['EMP-001', '2026-09-20', 'NS'] }
    ] };
  } });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'],
    decisions: { employeeDecisions: { 'EMP-001': { probation: { approved: false } } } } });
  assert.equal(run.valid, true, JSON.stringify(plain(run)));
  assert.equal(run.results[0].components.deductions.automaticAmount, 1200);
  assert.deepEqual(plain(run.results[0].attendance.noShowDates), ['2026-09-20', '2026-09-29']);
});

test('an employed employee with no attendance rows is blocked with an Employee ID diagnostic', () => {
  const { orchestrator } = fixture({ readDepartment(config, period, employee) {
    return { department: config.department, period, employeeRows: [employee], attendanceRows: [] };
  } });
  const result = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'MISSING_ATTENDANCE');
  assert.equal(result.errors[0].department, 'SURVEY');
  assert.equal(result.errors[0].employeeId, 'EMP-001');
});

test('attendance before an employee joined is not coverage for the employment window', () => {
  const { orchestrator } = fixture({ firstWorkingDay: '2026-09-20', readDepartment(config, period, employee, attendance) {
    return { department: config.department, period, employeeRows: [employee], attendanceRows: [attendance] };
  } });
  const result = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(result.valid, false);
  assert.equal(result.errors[0].code, 'MISSING_ATTENDANCE');
  assert.equal(result.errors[0].employeeId, 'EMP-001');
});

function referralFixture(options = {}) {
  const base = fixture();
  const employeeColumns = { employeeId: 'ID', americanName: 'Name', firstWorkingDay: 'Joined',
    lastWorkingDay: 'Left', finalPayrollPaymentDate: 'Final Paid', referrerEmployeeId: 'Referrer', transfers: 'Transfers' };
  const survey = { ...base.config, employeeColumns };
  const reservations = { ...survey, department: 'RESERVATIONS' };
  const headers = ['ID', 'Name', 'Joined', 'Left', 'Final Paid', 'Referrer', 'Transfers'];
  function employee(values) { return { headers, values, displayValues: values.map(String), rowNumber: 2 }; }
  const referrer = employee(['EMP-001', 'Alex', options.referrerJoined || '2026-08-01',
    options.referrerLeft || '', options.finalPaid || '', '', 0]);
  const referred = employee(['EMP-002', 'Blair', options.referredJoined || '2026-08-02', '', '', 'EMP-001', options.referredTransfers || 0]);
  return fixture({ configs: [survey, reservations], getBenefitLedger: () => options.ledger || [],
    readDepartment(config, period, unusedEmployee, attendance) {
      const isReferrer = config.department === 'SURVEY';
      return { department: config.department, period, employeeRows: [isReferrer ? referrer : referred],
        attendanceRows: isReferrer && options.referrerLeft ? [] : [
          { ...attendance, values: [isReferrer ? 'EMP-001' : 'EMP-002', '2026-09-01',
            !isReferrer && options.badReferralAttendance ? 'BAD_STATUS' : 'PRESENT'] }
        ] };
    } });
}

test('referral is source-derived across departments at inclusive day 60 and ignores manual payloads', () => {
  const { orchestrator } = referralFixture();
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END',
    departmentScope: ['SURVEY', 'RESERVATIONS'], decisions: { employeeDecisions: { 'EMP-001': {
      referrals: [{ employeeId: 'FAKE', americanName: 'Injected', department: 'SURVEY',
        firstWorkingDay: '2026-01-01', referrerEmployeeId: 'EMP-001' }]
    } } } });
  assert.equal(run.valid, true, JSON.stringify(plain(run)));
  const result = run.results.find(item => item.employeeId === 'EMP-001');
  assert.equal(result.components.referral.amount, 10000);
  assert.deepEqual(plain(result.benefitCandidates.filter(item => item.benefitKey.startsWith('REFERRAL:')).map(item => item.benefitKey)),
    ['REFERRAL:EMP-001:EMP-002']);
  assert.deepEqual(plain(run.decisions.employeeDecisions['EMP-001'].referrals.map(item => item.employeeId)), ['EMP-002']);
});

test('scoped referrer discovers other department roster without validating its payroll attendance or performance', () => {
  const { orchestrator } = referralFixture({ referredTransfers: 'bad-performance', badReferralAttendance: true });
  const run = orchestrator.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(run.valid, true, JSON.stringify(plain(run)));
  assert.deepEqual(plain(run.results.map(item => item.employeeId)), ['EMP-001']);
  assert.equal(run.results[0].components.referral.amount, 10000);
  assert.equal(run.referralSourceSnapshot.RESERVATIONS.employeeRows[0].values[0], 'EMP-002');
});

test('unreadable cross-department referral roster blocks a selected referrer with structured error', () => {
  const { orchestrator } = referralFixture({ referredJoined: 'invalid-date' });
  const report = orchestrator.validateRequest({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY'] });
  assert.equal(report.valid, false);
  assert.equal(report.errors[0].code, 'REFERRAL_SOURCE_UNAVAILABLE');
  assert.equal(report.errors[0].department, 'SURVEY');
  assert.equal(report.errors[0].employeeId, 'EMP-001');
  assert.equal(report.errors[0].sourceDepartment, 'RESERVATIONS');
});

test('former referrer receives one source-derived bonus only in later final-payroll period', () => {
  const options = { referrerJoined: '2026-01-01', referrerLeft: '2026-08-15', finalPaid: '2026-09-15',
    referredJoined: '2026-07-17' };
  const request = { payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['SURVEY', 'RESERVATIONS'] };
  const run = referralFixture(options).orchestrator.calculateDraft(request);
  assert.equal(run.valid, true, JSON.stringify(plain(run)));
  const former = run.results.find(item => item.employeeId === 'EMP-001');
  assert.equal(former.window, null);
  assert.equal(former.components.referral.amount, 10000);
  assert.equal(former.total, 10000);
  const paid = referralFixture({ ...options, ledger: [{ benefitKey: 'REFERRAL:EMP-001:EMP-002' }] }).orchestrator.calculateDraft(request);
  assert.equal(paid.results.find(item => item.employeeId === 'EMP-001').components.referral.amount, 0);
  const late = referralFixture({ ...options, referredJoined: '2026-07-19' }).orchestrator.calculateDraft(request);
  assert.equal(late.results.find(item => item.employeeId === 'EMP-001').components.referral.amount, 0);
  const otherMonth = referralFixture({ ...options, finalPaid: '2026-10-15' }).orchestrator.calculateDraft(request);
  assert.equal(otherMonth.results.find(item => item.employeeId === 'EMP-001').components.referral.amount, 0);
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
      failedDepartments: ['RESERVATIONS'], departmentErrors, partialDepartmentsFingerprint: 'partial-api', errors: departmentErrors, warnings: [] }),
    calculateDraft: () => ({ valid: true, runId: 'RUN-ALL', state: 'DRAFT', payrollMonth: '2026-09',
      results: [{ employeeId: 'EMP-SUR', department: 'SURVEY' }], failedDepartments: ['RESERVATIONS'],
      departmentErrors, partialDepartmentsFingerprint: 'partial-api', acknowledgements: { partialDepartmentsFingerprint: 'partial-api' },
      errors: [], blockingErrors: [], warnings: [] })
  };
  const api = MenuAndApi.create({ orchestrator });
  const validation = api.validateRun({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });
  const draft = api.calculateDraft({ payrollMonth: '2026-09', cutoffMode: 'MONTH_END', departmentScope: ['ALL'] });
  assert.equal(validation.valid, true);
  assert.deepEqual(plain(validation.errors), []);
  assert.deepEqual(plain(validation.failedDepartments), ['RESERVATIONS']);
  assert.deepEqual(plain(validation.departmentErrors), departmentErrors);
  assert.equal(validation.partialDepartmentsFingerprint, 'partial-api');
  assert.equal(draft.valid, true);
  assert.deepEqual(plain(draft.failedDepartments), ['RESERVATIONS']);
  assert.deepEqual(plain(draft.departmentErrors), departmentErrors);
  assert.deepEqual(plain(draft.errors), []);
  assert.equal(draft.partialDepartmentsFingerprint, 'partial-api');
  assert.equal(draft.acknowledgements.partialDepartmentsFingerprint, 'partial-api');
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
