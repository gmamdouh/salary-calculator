const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const plain = value => JSON.parse(JSON.stringify(value));
const { mappingConfig, sourceRow, periodOptions, payrollRules, attendance } = require('./helpers/fixtures');
test('different employee source layouts normalize to the same canonical identity', () => {
  const { MappingConfig, Contracts } = loadAppsScript();
  const configs = MappingConfig.parse([
    { department: 'SURVEY', spreadsheetId: 'https://docs.google.com/spreadsheets/d/fixture-source/edit', leaveSpreadsheetId: 'fixture-leave', employeeTab: 'Team', attendanceTab: 'Days', employeeColumns: JSON.stringify({ employeeId: 'ID', americanName: 'Alias', realName: 'Legal', firstWorkingDay: 'Joined', transfers: 'Count' }), attendanceColumns: { employeeId: 'ID', date: 'Day', status: 'Code' } },
    { department: 'SURVEY', spreadsheetId: 'fixture-other', leaveSpreadsheetId: 'fixture-leave', employeeTab: 'Staff', attendanceTab: 'Log', employeeColumns: { employeeId: 'Key', americanName: 'Name', realName: 'Private', firstWorkingDay: 'Start', transfers: 'Total' }, attendanceColumns: { employeeId: 'Key', date: 'Date', status: 'Status' } }
  ]);
  assert.equal(configs[0].spreadsheetId, 'fixture-source');
  const a = MappingConfig.normalizeEmployee({ ID: 'EMP-001', Alias: 'Alex Smith', Legal: 'Internal Name', Joined: '2026-01-01', Count: '10' }, configs[0]);
  const b = MappingConfig.normalizeEmployee({ Total: 10, Start: '2026-01-01', Private: 'Internal Name', Name: 'Alex Smith', Key: 'EMP-001' }, configs[1]);
  assert.deepEqual(plain(a), plain(b));
  Contracts.assertEmployee(a);
  assert.equal(a.realName, 'Internal Name');
  assert.equal(a.americanName, 'Alex Smith');
});

test('configuration validates required mappings and header coordinates without Apps Script globals', () => {
  const { MappingConfig } = loadAppsScript();
  assert.equal(MappingConfig.validate([mappingConfig()]).valid, true);
  const invalid = mappingConfig({ employeeColumns: { employeeId: 'ID' } });
  const report = MappingConfig.validate([invalid]);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some(issue => issue.field === 'americanName'));
  const matrix = [['department', 'spreadsheetId', 'leaveSpreadsheetId', 'employeeTab', 'attendanceTab', 'employeeColumns', 'attendanceColumns'],
    ['survey', 'fixture-source', 'fixture-leave', 'Team', 'Days', '{"employeeId":"ID","americanName":"Alias","firstWorkingDay":"Joined"}', '{"employeeId":"ID","date":"Day","status":"Code"}']];
  assert.equal(MappingConfig.parse(matrix)[0].department, 'SURVEY');
  const broken = sourceRow({ headers: ['ID', 'Alias', 'Legal', 'Wrong', 'Left', 'Count'] });
  assert.throws(() => MappingConfig.normalizeEmployee(broken, mappingConfig()), error => {
    assert.equal(error.issues[0].code, 'MISSING_HEADER');
    assert.equal(error.issues[0].tab, 'Team');
    assert.equal(error.issues[0].row, 2);
    assert.equal(error.issues[0].field, 'firstWorkingDay');
    return true;
  });
});

test('invalid employee dates and numbers block with exact source cell coordinates', () => {
  const { MappingConfig, PayrollEngine, PayrollPeriod } = loadAppsScript();
  for (const [index, value, field, code] of [[3, '2026-02-30', 'firstWorkingDay', 'INVALID_DATE'], [5, 'ten', 'transfers', 'INVALID_NUMBER'], [0, '', 'employeeId', 'MISSING_EMPLOYEE_ID']]) {
    const row = sourceRow(); row.values[index] = value;
    assert.throws(() => MappingConfig.normalizeEmployee(row, mappingConfig()), error => {
      const found = error.issues.find(issue => issue.field === field);
      assert.deepEqual(plain(found), { code, message: found.message, field, spreadsheetId: 'fixture-source', tab: 'Team', row: 3, column: index + 1 });
      return true;
    });
  }
  const row = sourceRow(); row.values[3] = '01/02/2026';
  assert.equal(MappingConfig.normalizeEmployee(row, mappingConfig({ dateFormat: 'DD/MM/YYYY' })).firstWorkingDay, '2026-02-01');
  const record = MappingConfig.normalizeEmployee(sourceRow(), mappingConfig());
  const result = PayrollEngine.calculateEmployee({ employee: record, rules: payrollRules(), attendance: attendance(), period: PayrollPeriod.buildPeriod(periodOptions()) });
  assert.equal(result.americanName, 'Alex Smith');
  assert.equal(JSON.stringify(result).includes('Internal Name'), false);
});

test('attendance layouts use Employee ID and date, filter the cutoff, and block duplicate daily identity', () => {
  const { MappingConfig, PayrollPeriod } = loadAppsScript();
  const period = PayrollPeriod.buildPeriod(periodOptions());
  const rows = [{ ID: 'EMP-001', Day: '2026-09-01', Code: 'PRESENT' }, { ID: 'EMP-001', Day: '2026-09-02', Code: 'NS' }, { ID: 'EMP-001', Day: '2026-10-01', Code: 'LEAVE' }];
  const normalized = MappingConfig.normalizeAttendance(rows, mappingConfig(), period);
  assert.deepEqual(plain(normalized), [{ employeeId: 'EMP-001', date: '2026-09-01', status: 'PRESENT' }, { employeeId: 'EMP-001', date: '2026-09-02', status: 'NS' }]);
  const alternate = mappingConfig({ attendanceColumns: { employeeId: 'Key', date: 'When', status: 'Mark' }, statusCodes: { P: 'PRESENT', N: 'NS' } });
  assert.deepEqual(plain(MappingConfig.normalizeAttendance([{ Key: 'EMP-001', When: '2026-09-01', Mark: 'P' }, { Key: 'EMP-001', When: '2026-09-02', Mark: 'N' }], alternate, period)), plain(normalized));
  assert.throws(() => MappingConfig.normalizeAttendance([rows[0], rows[0]], mappingConfig(), period), error => error.issues[0].code === 'DUPLICATE_ATTENDANCE');
  for (const [field, value, code] of [['ID', '', 'MISSING_EMPLOYEE_ID'], ['Day', '2026-09-31', 'INVALID_DATE'], ['Code', 'UNKNOWN', 'INVALID_STATUS']]) {
    const invalid = { ...rows[0], [field]: value };
    assert.throws(() => MappingConfig.normalizeAttendance([invalid], mappingConfig(), period), error => error.issues[0].code === code && error.issues[0].spreadsheetId === 'fixture-leave');
  }
});

function fakeSpreadsheets() {
  const tables = { Team: [['title'], sourceRow().headers, sourceRow().values], Days: [['ID', 'Day', 'Code'], ['EMP-001', '2026-09-01', 'PRESENT']] };
  const reads = [], writes = [], opened = [], displays = {};
  const sheets = Object.fromEntries(Object.keys(tables).map(name => [name, {
    getDataRange() { return { getValues() { reads.push(name + ':typed'); return tables[name].map(row => row.slice()); }, getDisplayValues() { reads.push(name + ':display'); return (displays[name] || tables[name]).map(row => row.map(value => String(value ?? ''))); } }; },
    getRange(row, column, height, width) { return { setValues(values) {
      assert.equal(values.length, height); assert.ok(values.every(item => item.length === width));
      writes.push({ name, row, column, values });
      values.forEach((items, offset) => items.forEach((value, index) => { tables[name][row + offset - 1][column + index - 1] = value; }));
    } }; }
  }]));
  const app = { openById(id) {
    opened.push(id);
    if (!['fixture-source', 'fixture-leave'].includes(id)) throw new Error('Access denied');
    return { getSheetByName(name) { return sheets[name] || null; }, getSpreadsheetTimeZone() { return 'Africa/Cairo'; } };
  } };
  return { app, tables, reads, writes, opened, displays, sheets };
}

test('gateway batch reads preserve displayed Employee IDs and block duplicates, missing IDs, headers and orphan attendance', () => {
  const { SpreadsheetGateway, PayrollPeriod } = loadAppsScript();
  const fake = fakeSpreadsheets();
  const gateway = SpreadsheetGateway.create({ spreadsheetApp: fake.app });
  const period = PayrollPeriod.buildPeriod(periodOptions());
  const bundle = gateway.readDepartment(mappingConfig(), period);
  assert.equal(bundle.employeeRows[0].rowNumber, 3);
  assert.equal(bundle.attendanceRows[0].rowNumber, 2);
  assert.equal(fake.writes.length, 0);
  assert.deepEqual(fake.reads.sort(), ['Days:display', 'Days:typed', 'Team:display', 'Team:typed']);
  fake.tables.Team.push(sourceRow().values.slice());
  assert.throws(() => gateway.readDepartment(mappingConfig(), period), error => error.issues[0].code === 'DUPLICATE_EMPLOYEE_ID' && error.issues[0].row === 4);
  fake.tables.Team.pop(); fake.tables.Team[2][0] = '';
  assert.throws(() => gateway.readDepartment(mappingConfig(), period), error => error.issues[0].code === 'MISSING_EMPLOYEE_ID');
  fake.tables.Team[2][0] = 'EMP-001'; fake.tables.Days[1][0] = 'EMP-999';
  assert.throws(() => gateway.readDepartment(mappingConfig(), period), error => error.issues[0].code === 'UNMATCHED_EMPLOYEE_ID');
  fake.tables.Days[1][0] = 'EMP-001'; fake.tables.Team[1][0] = 'Wrong';
  assert.equal(gateway.validateAccess(mappingConfig()).valid, false);
  assert.equal(gateway.validateAccess(mappingConfig({ spreadsheetId: 'unavailable' })).valid, false);
  assert.equal(gateway.validateAccess(mappingConfig({ employeeTab: 'Missing' })).valid, false);
});

test('approval writes resolve fresh Employee IDs and batch only configured status cells after complete preflight', () => {
  const { SpreadsheetGateway } = loadAppsScript();
  const fake = fakeSpreadsheets(), gateway = SpreadsheetGateway.create({ spreadsheetApp: fake.app });
  const second = sourceRow().values.slice(); second[0] = 'EMP-002'; second[1] = 'Jordan';
  fake.tables.Team.splice(2, 0, second);
  const report = gateway.writeApprovalState(mappingConfig(), [{ employeeId: 'EMP-001', values: { runId: 'RUN-1', paid: true } }, { employeeId: 'EMP-002', values: { runId: 'RUN-1', paid: true } }]);
  assert.equal(report.valid, true);
  assert.equal(report.written, 4);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(plain(fake.writes[0]), { name: 'Team', row: 3, column: 7, values: [['RUN-1', true], ['RUN-1', true]] });
  assert.equal(fake.tables.Team[2][0], 'EMP-002');
  fake.writes.length = 0;
  for (const writes of [
    [{ employeeId: 'EMP-001', values: { paid: true } }, { employeeId: 'MISSING', values: { paid: true } }],
    [{ employeeId: 'EMP-001', values: { americanName: 'Changed' } }],
    [{ employeeId: 'EMP-001', values: { paid: true } }, { employeeId: 'EMP-001', values: { paid: true } }]
  ]) {
    assert.equal(gateway.writeApprovalState(mappingConfig(), writes).valid, false);
    assert.equal(fake.writes.length, 0);
  }
});

test('optional mappings parse from master rows and unsafe ambiguous mappings block', () => {
  const { MappingConfig } = loadAppsScript();
  const config = MappingConfig.parse([mappingConfig({ employeeHeaderRow: '', approvalColumns: '{"runId":"Run","paid":"Paid"}', statusCodes: '{"P":"PRESENT"}' })])[0];
  assert.equal(MappingConfig.validate([config]).valid, true);
  assert.equal(config.approvalColumns.paid, 'Paid');
  assert.equal(config.statusCodes.P, 'PRESENT');
  for (const overrides of [
    { dateFormat: 'GUESS' },
    { approvalColumns: { runId: 'Run', paid: 'Run' } },
    { approvalColumns: { paid: 'ID' } },
    { employeeColumns: { employeeId: 'ID', americanName: 'ID', firstWorkingDay: 'Joined' } },
    { statusCodes: { P: 'UNKNOWN' } }
  ]) assert.equal(MappingConfig.validate([mappingConfig(overrides)]).valid, false);
  const row = sourceRow(); row.headers.push('ID'); row.values.push('OTHER');
  assert.throws(() => MappingConfig.normalizeEmployee(row, mappingConfig()), error => error.issues[0].code === 'DUPLICATE_HEADER');
});

test('gateway uses workbook timezone for typed dates and preserves formatted IDs through default globals', () => {
  const fake = fakeSpreadsheets();
  fake.displays.Team = fake.tables.Team.map(row => row.slice());
  fake.tables.Team[2][0] = 1; fake.displays.Team[2][0] = '0001';
  fake.tables.Days[1][0] = '0001';
  fake.tables.Team[2][3] = new Date('2025-12-31T22:00:00Z');
  const timezones = [];
  const { SpreadsheetGateway, MappingConfig, PayrollPeriod } = loadAppsScript({ SpreadsheetApp: fake.app, Utilities: { formatDate(value, timezone, format) {
    timezones.push([timezone, format]); return '2026-01-01';
  } } });
  const bundle = SpreadsheetGateway.readDepartment(mappingConfig(), PayrollPeriod.buildPeriod(periodOptions()));
  const employee = MappingConfig.normalizeEmployee(bundle.employeeRows[0], mappingConfig());
  assert.equal(employee.employeeId, '0001');
  assert.equal(employee.firstWorkingDay, '2026-01-01');
  assert.deepEqual(timezones, [['Africa/Cairo', 'yyyy-MM-dd']]);
});

test('approval sparse writes preserve gaps and report partial external failures honestly', () => {
  const fake = fakeSpreadsheets();
  fake.tables.Team[1].splice(7, 0, 'Formula'); fake.tables.Team[2].splice(7, 0, '=SUM(A1:A2)');
  const { SpreadsheetGateway } = loadAppsScript(), gateway = SpreadsheetGateway.create({ spreadsheetApp: fake.app });
  const result = gateway.writeApprovalState(mappingConfig(), [{ employeeId: 'EMP-001', values: { runId: '=danger()', paid: true } }]);
  assert.equal(result.valid, true);
  assert.equal(fake.tables.Team[2][7], '=SUM(A1:A2)');
  assert.equal(fake.tables.Team[2][6], "'=danger()");
  assert.equal(fake.writes.length, 2);
  const original = fake.sheets.Team.getRange; let calls = 0;
  fake.sheets.Team.getRange = (...args) => { if (++calls === 2) throw new Error('Protected range'); return original(...args); };
  const partial = gateway.writeApprovalState(mappingConfig(), [{ employeeId: 'EMP-001', values: { runId: 'RUN-2', paid: true } }]);
  assert.equal(partial.valid, false); assert.equal(partial.partial, true); assert.equal(partial.written, 1);
});

test('approval paid flags require booleans and run status fields require text', () => {
  const fake = fakeSpreadsheets(), gateway = loadAppsScript().SpreadsheetGateway.create({ spreadsheetApp: fake.app });
  for (const values of [{ paid: 'true' }, { runId: true }]) {
    assert.equal(gateway.writeApprovalState(mappingConfig(), [{ employeeId: 'EMP-001', values }]).valid, false);
    assert.equal(fake.writes.length, 0);
  }
});

test('configured approval headers are included in read-only access validation', () => {
  const fake = fakeSpreadsheets(), gateway = loadAppsScript().SpreadsheetGateway.create({ spreadsheetApp: fake.app });
  fake.tables.Team[1][7] = 'Wrong';
  const report = gateway.validateAccess(mappingConfig());
  assert.equal(report.valid, false);
  assert.equal(report.errors[0].code, 'MISSING_HEADER');
  assert.equal(report.errors[0].field, 'paid');
  assert.equal(fake.writes.length, 0);
});

test('final payroll payment dates normalize configured source formats to ISO and allow blanks', () => {
  const { MappingConfig } = loadAppsScript();
  const config = mappingConfig({ dateFormat: 'DD/MM/YYYY', employeeColumns: { ...mappingConfig().employeeColumns, finalPayrollPaymentDate: 'Final Paid' } });
  const row = sourceRow(); row.headers.push('Final Paid'); row.values.push('01/02/2026');
  assert.equal(MappingConfig.normalizeEmployee(row, config).finalPayrollPaymentDate, '2026-02-01');
  row.values[8] = '2026-02-01';
  assert.equal(MappingConfig.normalizeEmployee(row, config).finalPayrollPaymentDate, '2026-02-01');
  row.values[8] = '';
  assert.equal(MappingConfig.normalizeEmployee(row, config).finalPayrollPaymentDate, undefined);
});

test('impossible final payroll payment dates block with exact source coordinates', () => {
  const { MappingConfig } = loadAppsScript();
  const config = mappingConfig({ dateFormat: 'DD/MM/YYYY', employeeColumns: { ...mappingConfig().employeeColumns, finalPayrollPaymentDate: 'Final Paid' } });
  for (const invalid of ['2026-02-30', '30/02/2026']) {
    const row = sourceRow({ rowNumber: 12 }); row.headers.push('Final Paid'); row.values.push(invalid);
    assert.throws(() => MappingConfig.normalizeEmployee(row, config), error => {
      const found = error.issues.find(issue => issue.field === 'finalPayrollPaymentDate');
      assert.deepEqual(plain(found), { code: 'INVALID_DATE', message: 'Expected a valid date in DD/MM/YYYY', field: 'finalPayrollPaymentDate', spreadsheetId: 'fixture-source', tab: 'Team', row: 12, column: 9 });
      return true;
    });
  }
});
