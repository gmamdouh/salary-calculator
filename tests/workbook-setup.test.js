const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { runRecord } = require('./helpers/fixtures');

const expectedHeaders = {
  'Dashboard': ['Section', 'Value', 'Updated At'],
  'Sources & Mappings': ['Department', 'Employee Workbook ID', 'Leave Tracker Workbook ID', 'Employee Tab', 'Attendance Tab', 'Employee Header Row', 'Attendance Header Row', 'Employee Column Mappings', 'Attendance Column Mappings', 'Approval Column Mappings', 'Access Check', 'Last Checked'],
  'Salary Rules': ['Rule Type', 'Department', 'Rule Key', 'Value', 'Notes'],
  'Holiday Calendar': ['Holiday Name', 'Occasion Date', 'Actual Holiday Date', 'Number of Days', 'Triple Pay', 'Status'],
  'Latest Results': ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Probation EGP', 'Referral EGP', 'Additions EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'],
  'Payroll History': ['Run ID', 'Version', 'State', 'Employee ID', 'American Name', 'Department', 'Payroll Month', 'Cutoff', 'Final Settlement', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Additions EGP', 'Deductions EGP', 'Total EGP', 'Run Snapshot Ref'],
  'Payment Ledger': ['Benefit Key', 'Type', 'Employee ID', 'Related Employee ID', 'Amount EGP', 'Payroll Month', 'Run ID', 'Paid', 'Payment Date', 'Decision', 'Eligibility', 'Notes'],
  'Override Audit': ['Run ID', 'Component', 'Employee ID', 'American Name', 'Calculated EGP', 'Previous EGP', 'Edited EGP', 'Reason', 'Editor', 'Timestamp', 'Audit Key'],
  'Run Decisions': ['Run ID', 'Decision Type', 'Employee ID', 'American Name', 'Decision', 'Reason', 'Evidence URL', 'Acknowledged By', 'Timestamp', 'Details JSON', 'Audit Key'],
  'Payroll Runs': ['Run ID', 'Version', 'State', 'Payroll Month', 'Cutoff', 'RunRecord JSON']
};

function fakeSpreadsheet() {
  const sheets = new Map();
  function range(sheet, row, column, rows = 1, columns = 1) {
    return {
      setValues(values) {
        values.forEach((line, r) => line.forEach((value, c) => sheet.cells.set(`${row + r}:${column + c}`, value)));
        return this;
      },
      getValues() { return Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => sheet.cells.get(`${row + r}:${column + c}`) ?? '')); },
      clearContent() { sheet.clearCalls++; for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) sheet.cells.delete(`${row + r}:${column + c}`); return this; },
      protect() { return addProtection(sheet, { row, column, rows, columns }); },
      setNumberFormat(value) { sheet.formats.push({ row, column, rows, columns, value }); return this; }
    };
  }
  function addProtection(sheet, dimensions) {
    const protection = { description: '', warningOnly: true, domainEdit: true, editors: ['outsider@example.test'], unprotectedRanges: ['B2:C99'], targetAudiences: ['all-staff'],
      getDescription() { return this.description; }, setDescription(value) { this.description = value; return this; },
      setWarningOnly(value) { this.warningOnly = value; return this; }, isWarningOnly() { return this.warningOnly; },
      getEditors() { return this.editors.map(email => ({ getEmail: () => email })); },
      addEditor(email) { const value = typeof email === 'string' ? email : email.getEmail(); if (!this.editors.includes(value)) this.editors.push(value); return this; },
      addEditors(emails) { emails.forEach(email => this.addEditor(email)); return this; },
      removeEditors(emails) { const removed = emails.map(email => typeof email === 'string' ? email : email.getEmail()); this.editors = this.editors.filter(email => !removed.includes(email)); return this; },
      canDomainEdit() { return this.domainEdit; }, setDomainEdit(value) { this.domainEdit = value; return this; },
      getUnprotectedRanges() { return this.unprotectedRanges; }, setUnprotectedRanges(value) { this.unprotectedRanges = value; return this; },
      getTargetAudiences() { return this.targetAudiences.map(id => ({ getAudienceId: () => id })); },
      removeTargetAudience(id) { this.targetAudiences = this.targetAudiences.filter(value => value !== id); return this; },
      remove() { sheet.protections = sheet.protections.filter(item => item.protection !== this); }
    };
    sheet.protections.push({ ...dimensions, protection }); return protection;
  }
  return {
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) {
      const sheet = { name, cells: new Map(), protections: [], formats: [], hidden: false, clearCalls: 0, insertedColumns: [],
        getName() { return name; }, getRange: (...args) => range(sheet, ...args),
        getLastRow() { return Math.max(0, ...[...sheet.cells.keys()].map(key => Number(key.split(':')[0]))); },
        getLastColumn() { return Math.max(0, ...[...sheet.cells.keys()].map(key => Number(key.split(':')[1]))); },
        getMaxRows() { return 1000; },
        insertColumnBefore(column) {
          sheet.insertedColumns.push(column);
          [...sheet.cells.entries()].filter(([key]) => Number(key.split(':')[1]) >= column).sort((a, b) => Number(b[0].split(':')[1]) - Number(a[0].split(':')[1])).forEach(([key, value]) => {
            const [rowNumber, columnNumber] = key.split(':').map(Number);
            sheet.cells.delete(key); sheet.cells.set(`${rowNumber}:${columnNumber + 1}`, value);
          });
          return sheet;
        },
        getDataRange() { return range(sheet, 1, 1, this.getLastRow(), this.getLastColumn()); },
        hideSheet() { sheet.hidden = true; return sheet; }, showSheet() { sheet.hidden = false; return sheet; },
        getSheetId() { return 100 + [...sheets.keys()].indexOf(name); },
        protect() { return addProtection(sheet, { wholeSheet: true }); },
        getProtections(type) { return sheet.protections.filter(item => !type || (type === 'SHEET' ? item.wholeSheet : !item.wholeSheet)).map(item => item.protection); }
      };
      sheets.set(name, sheet); return sheet;
    },
    getSheets() { return [...sheets.values()]; }
  };
}

const managed = ['Dashboard', 'Sources & Mappings', 'Salary Rules', 'Holiday Calendar', 'Latest Results', 'Payroll History', 'Payment Ledger', 'Override Audit', 'Run Decisions'];
const policy = { editorEmails: ['approver@example.test', 'executor@example.test'], effectiveUserEmail: 'executor@example.test', actingUserEmail: 'approver@example.test' };

test('initialization creates the approved managed tabs with stable headers and protected technical identifiers', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  const report = WorkbookSetup.initialize(spreadsheet, policy);
  assert.equal(report.valid, true);
  assert.deepEqual(Array.from(report.sheetNames), [...managed, 'Payroll Runs']);
  assert.deepEqual(spreadsheet.getSheets().map(sheet => sheet.name), [...managed, 'Payroll Runs']);
  assert.deepEqual(spreadsheet.getSheetByName('Holiday Calendar').getRange(1, 1, 1, 6).getValues()[0], ['Holiday Name', 'Occasion Date', 'Actual Holiday Date', 'Number of Days', 'Triple Pay', 'Status']);
  assert.deepEqual(spreadsheet.getSheetByName('Payroll History').getRange(1, 1, 1, 5).getValues()[0], ['Run ID', 'Version', 'State', 'Employee ID', 'American Name']);
  assert.ok(spreadsheet.getSheetByName('Payroll History').protections.length > 0);
  assert.equal(spreadsheet.getSheetByName('Payroll Runs').hidden, true);
  assert.ok(spreadsheet.getSheetByName('Payroll Runs').protections.length > 0);
  for (const [name, headers] of Object.entries(expectedHeaders)) {
    const row = name === 'Latest Results' ? 2 : 1;
    assert.deepEqual(spreadsheet.getSheetByName(name).getRange(row, 1, 1, headers.length).getValues()[0], headers);
  }
  const rules = spreadsheet.getSheetByName('Salary Rules').getRange(2, 1, 60, 5).getValues();
  assert.ok(rules.some(row => row[0] === 'SALARY' && row[1] === 'SURVEY' && row[2] === 'after.basic' && row[3] === 15000));
  assert.ok(rules.some(row => row[0] === 'COMMISSION' && row[1] === 'SALES' && row[2] === '6.00%+|50+' && row[3] === 1300));
  assert.ok(rules.some(row => row[0] === 'CYCLE' && row[1] === 'SALES' && row[2] === 'quarterly payment months' && row[3] === ''));
  assert.equal(rules.some(row => String(row[3]).includes('3,6,9,12')), false);
});

test('initialization is idempotent and seeds the exact 2027 holiday calendar', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  WorkbookSetup.initialize(spreadsheet, policy);
  const before = spreadsheet.getSheets().map(sheet => [sheet.name, sheet.getLastRow(), sheet.getLastColumn()]);
  const protections = spreadsheet.getSheets().map(sheet => sheet.protections.length);
  WorkbookSetup.initialize(spreadsheet, policy);
  assert.deepEqual(spreadsheet.getSheets().map(sheet => [sheet.name, sheet.getLastRow(), sheet.getLastColumn()]), before);
  assert.deepEqual(spreadsheet.getSheets().map(sheet => sheet.protections.length), protections);
  assert.equal(spreadsheet.getSheetByName('Holiday Calendar').getLastRow(), 14);
  const holidays = spreadsheet.getSheetByName('Holiday Calendar').getRange(2, 1, 13, 6).getValues();
  const display = holidays.map(row => row.map((cell, index) => index === 1 || (index === 2 && Object.prototype.toString.call(cell) === '[object Date]')
    ? `${String(new Date(cell).getUTCDate()).padStart(2, '0')}-${String(new Date(cell).getUTCMonth() + 1).padStart(2, '0')}-${new Date(cell).getUTCFullYear()}` : cell));
  assert.deepEqual(display, [
    ['Coptic Christmas', '07-01-2027', '07-01-2027', 1, 'Yes', 'Confirmed occasion date'],
    ['January 25 Revolution & Police Day', '25-01-2027', '28-01-2027', 1, 'Yes', 'Estimated until official postponement decision'],
    ['Eid Al-Fitr', '10-03-2027', '10-03-2027 to 12-03-2027', 3, 'Yes', 'Estimated'],
    ['Sinai Liberation Day', '25-04-2027', '25-04-2027', 1, 'Yes', 'Confirmed occasion date'],
    ['Labor Day', '01-05-2027', '01-05-2027', 1, 'Yes', 'Confirmed occasion date'],
    ['Sham El-Nessim', '03-05-2027', '03-05-2027', 1, 'Yes', 'Highly likely'],
    ['Arafat Day', '16-05-2027', '16-05-2027', 1, 'Yes', 'Estimated'],
    ['Eid Al-Adha', '17-05-2027', '17-05-2027 to 19-05-2027', 3, 'Yes', 'Estimated'],
    ['Islamic New Year', '07-06-2027', '07-06-2027', 1, 'Yes', 'Estimated'],
    ['June 30 Revolution', '30-06-2027', '01-07-2027', 1, 'Yes', 'Estimated until official postponement decision'],
    ['July 23 Revolution', '23-07-2027', '23-07-2027', 1, 'Yes', 'Confirmed occasion date'],
    ['Prophet Muhammad’s Birthday', '15-08-2027', '15-08-2027', 1, 'Yes', 'Estimated'],
    ['Armed Forces Day / October 6 Victory', '06-10-2027', '07-10-2027', 1, 'Yes', 'Estimated until official postponement decision']
  ]);
});

test('initialization fills missing rules while preserving edited and legacy commission rows', () => {
  const { WorkbookSetup, Commission } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  const sheet = spreadsheet.insertSheet('Salary Rules');
  sheet.getRange(1, 1, 1, 5).setValues([expectedHeaders['Salary Rules']]);
  sheet.getRange(2, 1, 3, 5).setValues([
    ['SALARY', 'SURVEY', 'after.basic', 17000, 'edited'],
    ['COMMISSION', 'SURVEY', '1-200', 12, 'edited'],
    ['COMMISSION', 'SALES', '4.00%-4.99%|1-19', 475, 'legacy bracket, edited']
  ]);
  WorkbookSetup.initialize(spreadsheet, policy);
  const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues();
  assert.equal(rows.find(row => row[0] === 'SALARY' && row[1] === 'SURVEY' && row[2] === 'after.basic')[3], 17000);
  assert.equal(rows.find(row => row[0] === 'COMMISSION' && row[1] === 'SURVEY' && row[2] === '1-200')[3], 12);
  assert.equal(rows.filter(row => row[0] === 'COMMISSION' && row[1] === 'SALES' && /4\.00%-4\.99%\|(0-19|1-19)/.test(row[2])).length, 1);
  assert.equal(Commission.parseRows(rows).sales.length, 5);
});

test('history stores the original rules snapshot when later runs use edited rates', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  const sheets = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const first = runRecord({ rulesSnapshot: { commissions: { survey: [{ min: 1, max: 200, rate: 10 }] } } });
  WorkbookSetup.appendHistory(sheets, first, 'RUN-001:DRAFT:1');
  const second = runRecord({ runId: 'RUN-002', rulesSnapshot: { commissions: { survey: [{ min: 1, max: 200, rate: 20 }] } } });
  WorkbookSetup.appendHistory(sheets, second, 'RUN-002:DRAFT:1');
  const stored = sheets['Payroll Runs'].getRange(2, 1, 2, 6).getValues().map(row => JSON.parse(row[5]));
  assert.equal(stored[0].rulesSnapshot.commissions.survey[0].rate, 10);
  assert.equal(stored[1].rulesSnapshot.commissions.survey[0].rate, 20);
});

test('initialization repairs appended source and audit key headers on an existing workbook', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  WorkbookSetup.initialize(spreadsheet, policy);
  spreadsheet.getSheetByName('Sources & Mappings').getRange(1, 13, 1, 4).clearContent();
  spreadsheet.getSheetByName('Override Audit').getRange(1, 11).clearContent();
  spreadsheet.getSheetByName('Run Decisions').getRange(1, 11).clearContent();
  assert.equal(WorkbookSetup.initialize(spreadsheet, policy).valid, true);
  assert.deepEqual(spreadsheet.getSheetByName('Sources & Mappings').getRange(1, 13, 1, 4).getValues()[0],
    ['Deduction Workbook ID', 'Deduction Tab', 'Deduction Header Row', 'Deduction Column Mappings']);
  assert.equal(spreadsheet.getSheetByName('Override Audit').getRange(1, 11).getValues()[0][0], 'Audit Key');
  assert.equal(spreadsheet.getSheetByName('Run Decisions').getRange(1, 11).getValues()[0][0], 'Audit Key');
});

test('initialization migrates legacy component columns without losing history or latest rows', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  const history = spreadsheet.insertSheet('Payroll History');
  const oldHeaders = expectedHeaders['Payroll History'].filter(value => value !== 'Additions EGP');
  history.getRange(1, 1, 1, oldHeaders.length).setValues([oldHeaders]);
  const oldRow = ['RUN-OLD', 1, 'APPROVED', 'EMP-OLD', 'Old Name', 'SURVEY', '2026-08', '2026-08-31', false,
    100, 20, 0, 0, 0, 0, 0, -5, 135, 'RUN-OLD:APPROVED'];
  history.getRange(2, 1, 1, oldRow.length).setValues([oldRow]);
  const latest = spreadsheet.insertSheet('Latest Results');
  const oldLatestHeaders = expectedHeaders['Latest Results'].filter(value => value !== 'Additions EGP');
  latest.getRange(1, 1).setValues([['Active Employees']]);
  latest.getRange(2, 1, 1, oldLatestHeaders.length).setValues([oldLatestHeaders]);
  latest.getRange(3, 1, 1, 14).setValues([['Old Name', 'SURVEY', '2026-08', '2026-08-31', 100, 20, 0, 0, 0, 0, -5, 135, '', '']]);
  latest.getRange(5, 1).setValues([['Final Settlements']]);
  const oldFinalHeaders = ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'];
  latest.getRange(6, 1, 1, oldFinalHeaders.length).setValues([oldFinalHeaders]);
  latest.getRange(7, 1, 1, 15).setValues([['Final Name', 'TDS', '2026-08', '2026-08-31', 200, 0, 0, 0, 10, 0, 0, -5, 225, '', '']]);
  WorkbookSetup.initialize(spreadsheet, policy);
  assert.deepEqual(history.insertedColumns, [17]);
  assert.equal(history.clearCalls, 0);
  assert.deepEqual(history.getRange(2, 1, 1, 20).getValues()[0], [...oldRow.slice(0, 16), 20, ...oldRow.slice(16)]);
  assert.equal(latest.getRange(3, 11).getValues()[0][0], 20);
  assert.equal(latest.getRange(3, 12).getValues()[0][0], -5);
  assert.equal(latest.getRange(7, 12).getValues()[0][0], 20);
  assert.equal(latest.getRange(7, 13).getValues()[0][0], -5);
  assert.equal(latest.getRange(7, 14).getValues()[0][0], 225);
  const migratedSheets = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const retry = runRecord({ runId: 'RUN-OLD', results: [{ employeeId: 'EMP-OLD', components: {} }] });
  assert.equal(WorkbookSetup.appendHistory(migratedSheets, retry, 'RUN-OLD:APPROVED'), 0);
  assert.equal(WorkbookSetup.appendHistory(migratedSheets, retry, 'RUN-OLD:NEW'), 1);
});

test('initialization resumes a history column insertion interrupted before its header write', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), history = spreadsheet.insertSheet('Payroll History');
  const oldHeaders = expectedHeaders['Payroll History'].filter(value => value !== 'Additions EGP');
  history.getRange(1, 1, 1, oldHeaders.length).setValues([oldHeaders]);
  history.getRange(2, 1, 1, 19).setValues([['RUN-OLD', 1, 'APPROVED', 'EMP-OLD', 'Old Name', 'SURVEY', '2026-08', '2026-08-31', false,
    100, 20, 0, 0, 0, 0, 0, -5, 135, 'RUN-OLD:APPROVED']]);
  history.insertColumnBefore(17);
  WorkbookSetup.initialize(spreadsheet, policy);
  assert.deepEqual(history.insertedColumns, [17]);
  assert.equal(history.getRange(1, 17).getValues()[0][0], 'Additions EGP');
  assert.equal(history.getRange(2, 17).getValues()[0][0], 20);
  assert.equal(history.getRange(2, 20).getValues()[0][0], 'RUN-OLD:APPROVED');
});

test('initialization requires an editor policy and restricts complete sensitive sheets', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  assert.throws(() => WorkbookSetup.initialize(spreadsheet), /protected editor/i);
  WorkbookSetup.initialize(spreadsheet, policy);
  const sensitive = ['Dashboard', 'Sources & Mappings', 'Salary Rules', 'Holiday Calendar', 'Payroll History', 'Payment Ledger', 'Override Audit', 'Run Decisions', 'Payroll Runs'];
  for (const name of sensitive) {
    const protections = spreadsheet.getSheetByName(name).protections.filter(item => item.wholeSheet);
    assert.equal(protections.length, 1, name);
    assert.equal(protections[0].protection.warningOnly, false, name);
    assert.equal(protections[0].protection.domainEdit, false, name);
    assert.deepEqual(Array.from(protections[0].protection.unprotectedRanges), [], name);
    assert.deepEqual(protections[0].protection.targetAudiences, [], name);
    assert.deepEqual(protections[0].protection.editors.slice().sort(), ['approver@example.test', 'executor@example.test'], name);
  }
  assert.equal(spreadsheet.getSheetByName('Latest Results').protections.some(item => item.wholeSheet), false);
  const count = spreadsheet.getSheets().map(sheet => sheet.protections.length);
  WorkbookSetup.initialize(spreadsheet, policy);
  assert.deepEqual(spreadsheet.getSheets().map(sheet => sheet.protections.length), count);
});

test('an unlisted acting user cannot initialize or acquire protected editor access', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), audit = spreadsheet.insertSheet('Override Audit');
  audit.protect().setDescription('SalaryCalculator: protected Override Audit');
  const originalEditors = audit.protections[0].protection.editors.slice();
  for (const denied of [
    { editorEmails: ['approver@example.test'], actingUserEmail: 'outsider@example.test', effectiveUserEmail: 'approver@example.test' }
  ]) {
    assert.throws(() => WorkbookSetup.initialize(spreadsheet, denied), error => {
      assert.equal(error.issues[0].code, 'PROTECTED_EDITOR_NOT_AUTHORIZED'); return true;
    });
    assert.deepEqual(audit.protections[0].protection.editors, originalEditors);
    assert.equal(spreadsheet.getSheetByName('Payroll Runs'), null);
  }
  WorkbookSetup.initialize(spreadsheet, { editorEmails: ['approver@example.test'], actingUserEmail: 'approver@example.test', effectiveUserEmail: 'approver@example.test' });
  assert.deepEqual(audit.protections[0].protection.editors, ['approver@example.test']);
});

test('a listed acting user can initialize without adding an unlisted effective user', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  WorkbookSetup.initialize(spreadsheet, {
    editorEmails: ['approver@example.test'],
    actingUserEmail: 'approver@example.test',
    effectiveUserEmail: 'owner@example.test'
  });
  const protectedSheet = spreadsheet.getSheetByName('Payroll History');
  assert.deepEqual(protectedSheet.protections[0].protection.editors, ['approver@example.test']);
});

test('production protection adapter repairs editors and domain access on an existing protected sheet', () => {
  const { SpreadsheetGateway } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), sheet = spreadsheet.insertSheet('Payroll History');
  const gateway = SpreadsheetGateway.createMaster();
  const protection = gateway.protectSheet(sheet, 'SalaryCalculator: protected Payroll History', ['approver@example.test', 'executor@example.test']);
  protection.addEditor('outsider@example.test'); protection.setDomainEdit(true); protection.setWarningOnly(true);
  protection.setUnprotectedRanges(['B2:C99']);
  protection.targetAudiences = ['all-staff'];
  const repaired = gateway.protectSheet(sheet, 'SalaryCalculator: protected Payroll History', ['approver@example.test', 'executor@example.test']);
  assert.equal(repaired, protection);
  assert.deepEqual(protection.editors.slice().sort(), ['approver@example.test', 'executor@example.test']);
  assert.equal(protection.domainEdit, false);
  assert.equal(protection.warningOnly, false);
  assert.deepEqual(Array.from(protection.unprotectedRanges), []);
  assert.deepEqual(protection.targetAudiences, []);
  assert.equal(sheet.protections.length, 1);
});

test('initialization replaces old partial and legacy sheet protections', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), sheet = spreadsheet.insertSheet('Override Audit');
  sheet.protect().setDescription('SalaryCalculator: protected override audit');
  sheet.getRange(2, 3, 50, 1).protect().setDescription('SalaryCalculator: Override Audit Employee ID');
  WorkbookSetup.initialize(spreadsheet, policy);
  assert.equal(sheet.protections.length, 1);
  assert.equal(sheet.protections[0].wholeSheet, true);
  assert.equal(sheet.protections[0].protection.getDescription(), 'SalaryCalculator: protected Override Audit');
  assert.deepEqual(sheet.protections[0].protection.editors.slice().sort(), ['approver@example.test', 'executor@example.test']);
});

test('approval stops before payroll writes when workbook protection cannot be enforced', () => {
  const { MenuAndApi } = loadAppsScript();
  let approved = false;
  const api = MenuAndApi.create({ actor: () => 'approver@example.test', approverEmails: ['approver@example.test'],
    ensureProtection: () => { throw new Error('Protected editor configuration is missing'); },
    orchestrator: { approveRun: () => { approved = true; return { valid: true }; } } });
  const result = api.approveRun('RUN-001');
  assert.equal(result.valid, false);
  assert.equal(approved, false);
  assert.match(result.errors[0].message, /protected editor/i);
});

test('production configuration check and initialization fail closed when acting identity is unavailable', () => {
  const spreadsheet = fakeSpreadsheet();
  const { WorkbookSetup, MenuAndApi } = loadAppsScript({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' } },
    LockService: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'PAYROLL_APPROVER_EMAILS' ? 'approver@example.test' : '' }) },
    Session: { getEffectiveUser: () => { throw new Error('Effective identity must not be read'); }, getActiveUser: () => { throw new Error('Active identity unavailable'); } }
  });
  WorkbookSetup.ensureManagedSheets(spreadsheet);
  const api = MenuAndApi.current();
  const check = api.configurationCheck();
  assert.equal(check.valid, false);
  assert.equal(check.protection.valid, false);
  assert.equal(check.protection.errors[0].code, 'PROTECTED_EDITOR_CONFIGURATION_MISSING');
  assert.equal(api.initializeWorkbook().errors[0].code, 'PROTECTED_EDITOR_CONFIGURATION_MISSING');
  assert.equal(api.approveRun('RUN-001').valid, false);
});

test('configuration check reports malformed commission rows as structured rule issues', () => {
  const spreadsheet = fakeSpreadsheet();
  const { WorkbookSetup, MenuAndApi } = loadAppsScript({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' } },
    LockService: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'approver@example.test' }) },
    Session: { getActiveUser: () => ({ getEmail: () => 'approver@example.test' }) }
  });
  WorkbookSetup.initialize(spreadsheet, policy);
  const rules = spreadsheet.getSheetByName('Salary Rules');
  const rows = rules.getRange(2, 1, rules.getLastRow() - 1, 5).getValues();
  const index = rows.findIndex(row => row[0] === 'COMMISSION' && row[1] === 'SALES' && row[2] === '4.00%-4.99%|30-39');
  rules.getRange(index + 2, 4).setValues([['invalid']]);
  const check = MenuAndApi.current().configurationCheck();
  assert.equal(check.rules.valid, false);
  assert.equal(check.rules.errors[0].code, 'INVALID_COMMISSION_RULE');
});

test('production API denies an unlisted caller before protected draft, override, or initialization writes', () => {
  const spreadsheet = fakeSpreadsheet();
  const { WorkbookSetup, MenuAndApi } = loadAppsScript({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' } },
    LockService: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'PAYROLL_APPROVER_EMAILS' ? 'outsider@example.test' :
      key === 'PAYROLL_PROTECTED_EDITOR_EMAILS' ? 'approver@example.test' : '' }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'outsider@example.test' }), getActiveUser: () => ({ getEmail: () => 'outsider@example.test' }) }
  });
  WorkbookSetup.ensureManagedSheets(spreadsheet);
  const api = MenuAndApi.current();
  for (const action of [() => api.calculateDraft({}), () => api.saveOverride({}), () => api.initializeWorkbook(), () => api.approveRun('RUN-001')]) {
    const result = action();
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'PROTECTED_EDITOR_NOT_AUTHORIZED');
  }
  assert.equal(spreadsheet.getSheetByName('Payroll Runs').getLastRow(), 1);
  assert.equal(spreadsheet.getSheetByName('Payroll Runs').protections.length, 0);
});

test('production workbook initialization rebuilds Dashboard from saved run records', () => {
  const spreadsheet = fakeSpreadsheet();
  const { WorkbookSetup, MenuAndApi } = loadAppsScript({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' } },
    LockService: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'PAYROLL_APPROVER_EMAILS' ? 'approver@example.test' :
      key === 'PAYROLL_PROTECTED_EDITOR_EMAILS' ? 'approver@example.test' : '' }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.test' }), getActiveUser: () => ({ getEmail: () => 'approver@example.test' }) }
  });
  WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ state: 'DRAFT', createdAt: '2026-10-04T09:00:00Z', warnings: ['Review attendance'] });
  spreadsheet.getSheetByName('Payroll Runs').getRange(2, 1, 1, 6).setValues([[run.runId, run.version, run.state, run.payrollMonth, run.cutoff, JSON.stringify(run)]]);
  assert.equal(MenuAndApi.current().initializeWorkbook().valid, true);
  assert.deepEqual(spreadsheet.getSheetByName('Payroll History').protections[0].protection.editors, ['approver@example.test']);
  const dashboard = spreadsheet.getSheetByName('Dashboard');
  assert.match(dashboard.getRange(1, 1, dashboard.getLastRow(), 3).getValues().flat().map(String).join('|'), /RUN-001|DRAFT|Review attendance/);
});

test('production initialization refreshes approved Latest Results using per-result cutoff', () => {
  const spreadsheet = fakeSpreadsheet();
  const { WorkbookSetup, MenuAndApi } = loadAppsScript({
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' } },
    LockService: {},
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'PAYROLL_APPROVER_EMAILS' ? 'approver@example.test' :
      key === 'PAYROLL_PROTECTED_EDITOR_EMAILS' ? 'approver@example.test,executor@example.test' : '' }) },
    Session: { getEffectiveUser: () => ({ getEmail: () => 'executor@example.test' }), getActiveUser: () => ({ getEmail: () => 'approver@example.test' }) }
  });
  WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ state: 'APPROVED', approvedAt: '2026-10-04T10:00:00Z' });
  run.results[0].cutoff = '2026-09-25';
  run.results[0].components.additions = { amount: 25 };
  run.results[0].total += 25;
  spreadsheet.getSheetByName('Payroll Runs').getRange(2, 1, 1, 6).setValues([[run.runId, run.version, run.state, run.payrollMonth, run.cutoff, JSON.stringify(run)]]);
  MenuAndApi.current().initializeWorkbook();
  const latest = spreadsheet.getSheetByName('Latest Results');
  assert.equal(latest.getRange(3, 4).getValues()[0][0].toISOString().slice(0, 10), '2026-09-25');
  assert.equal(latest.getRange(3, 11).getValues()[0][0], 25);
});

test('dashboard projects recent run status, omissions, totals and resume identifiers idempotently', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), sheets = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ state: 'DRAFT', createdAt: '2026-10-04T09:00:00Z', warnings: ['Review attendance'],
    failedDepartments: ['TDS'], failedEmployees: [{ employeeId: 'EMP-002' }] });
  WorkbookSetup.projectDashboard(sheets, [run]);
  const dashboard = spreadsheet.getSheetByName('Dashboard');
  const rows = dashboard.getRange(1, 1, dashboard.getLastRow(), 3).getValues();
  const visible = rows.flat().map(String).join('|');
  assert.match(visible, /RUN-001|DRAFT|Review attendance|TDS|EMP-002|27000|#gid=/);
  const before = dashboard.getLastRow();
  WorkbookSetup.projectDashboard(sheets, [run]);
  assert.equal(dashboard.getLastRow(), before);
  run.state = 'APPROVED'; run.approvedAt = '2026-10-04T10:00:00Z';
  WorkbookSetup.projectDashboard(sheets, [run]);
  assert.match(dashboard.getRange(1, 1, dashboard.getLastRow(), 3).getValues().flat().map(String).join('|'), /APPROVED/);
});

test('latest results separates active employees and final settlements and never displays Employee ID', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  const sheetMap = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ results: [
    { employeeId: 'EMP-001', americanName: 'Alex Smith', department: 'SURVEY', finalSettlement: false, components: { basic: { amount: 12000 }, abs: { amount: 2000 }, annualBalance: { amount: 7777 } }, total: 14000 },
    { employeeId: 'EMP-002', americanName: 'Jamie Doe', department: 'TDS', finalSettlement: true, components: { basic: { amount: 21000 }, annualBalance: { amount: 600 } }, total: 21600 }
  ] });
  WorkbookSetup.renderLatestResults(sheetMap, run);
  const visible = [...spreadsheet.getSheetByName('Latest Results').cells.values()].map(String).join('|');
  assert.match(visible, /Active Employees/); assert.match(visible, /Final Settlements/);
  assert.match(visible, /Alex Smith/); assert.match(visible, /Jamie Doe/);
  assert.doesNotMatch(visible, /EMP-001|EMP-002|realName|Internal Name/);
  assert.ok(spreadsheet.getSheetByName('Latest Results').formats.some(format => format.value.includes('EGP')));
  const sheet = spreadsheet.getSheetByName('Latest Results');
  const activeHeaders = expectedHeaders['Latest Results'];
  const finalHeaders = ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Additions EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'];
  assert.deepEqual(sheet.getRange(2, 1, 1, activeHeaders.length).getValues()[0], activeHeaders);
  assert.deepEqual(sheet.getRange(6, 1, 1, finalHeaders.length).getValues()[0], finalHeaders);
  const activeRow = sheet.getRange(3, 1, 1, activeHeaders.length).getValues()[0];
  const finalRow = sheet.getRange(7, 1, 1, finalHeaders.length).getValues()[0];
  assert.equal(activeRow.includes(7777), false);
  assert.equal(activeRow[12], 14000);
  assert.equal(finalRow[8], 600);
  assert.equal(finalRow[13], 21600);
});

test('approved additions and result cutoffs appear in each visible projection', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), sheets = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ cutoff: '2026-09-30', results: [
    { employeeId: 'EMP-001', department: 'SURVEY', cutoff: '2026-09-25', components: { basic: { amount: 100 }, additions: { amount: 25 }, deductions: { amount: -5 } }, total: 120 },
    { employeeId: 'EMP-002', department: 'TDS', finalSettlement: true, components: { basic: { amount: 200 }, additions: { amount: 40 }, deductions: { amount: -10 } }, total: 230 }
  ] });
  WorkbookSetup.renderLatestResults(sheets, run);
  WorkbookSetup.appendHistory(sheets, run);
  const latest = spreadsheet.getSheetByName('Latest Results');
  assert.equal(latest.getRange(3, 11).getValues()[0][0], 25);
  assert.equal(latest.getRange(7, 12).getValues()[0][0], 40);
  assert.equal(latest.getRange(3, 4).getValues()[0][0].toISOString().slice(0, 10), '2026-09-25');
  assert.equal(latest.getRange(7, 4).getValues()[0][0].toISOString().slice(0, 10), '2026-09-30');
  const history = spreadsheet.getSheetByName('Payroll History');
  assert.deepEqual(history.getRange(2, 17, 2, 1).getValues().map(row => row[0]), [25, 40]);
});

test('history preserves Employee IDs in protected audit data and appends one row per result', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  WorkbookSetup.initialize(spreadsheet, policy);
  const sheetMap = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord();
  assert.equal(WorkbookSetup.appendHistory(sheetMap, run), 1);
  const history = spreadsheet.getSheetByName('Payroll History');
  assert.equal(history.getRange(2, 4).getValues()[0][0], 'EMP-001');
  assert.ok(history.protections.length > 0);
  assert.equal(history.getRange(2, 5).getValues()[0][0], 'Alex Smith');
  assert.doesNotMatch([...history.cells.values()].map(String).join('|'), /Internal Name|Legal/);
  assert.equal(WorkbookSetup.appendHistory(sheetMap, run), 0);
  assert.equal(history.getLastRow(), 2);
  assert.match(spreadsheet.getSheetByName('Payroll Runs').getRange(2, 6).getValues()[0][0], /Internal Name/);
});

test('history retains each immutable draft revision and its resolvable snapshot key', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), sheets = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ state: 'DRAFT', revision: 1 });
  assert.equal(WorkbookSetup.appendHistory(sheets, run, 'RUN-001:DRAFT:1'), 1);
  run.revision = 2;
  run.results[0].components.basic.amount = 16000;
  run.results[0].total += 1000;
  assert.equal(WorkbookSetup.appendHistory(sheets, run, 'RUN-001:DRAFT:2'), 1);
  assert.equal(WorkbookSetup.appendHistory(sheets, run, 'RUN-001:DRAFT:2'), 0);
  assert.equal(WorkbookSetup.appendHistory(sheets, run, 'RUN-001:APPROVAL_CHECKPOINT'), 1);
  run.state = 'APPROVED';
  assert.equal(WorkbookSetup.appendHistory(sheets, run, 'RUN-001:APPROVED'), 1);
  const history = spreadsheet.getSheetByName('Payroll History');
  assert.equal(history.getLastRow(), 5);
  assert.deepEqual(history.getRange(2, 20, 4, 1).getValues().map(row => row[0]),
    ['RUN-001:DRAFT:1', 'RUN-001:DRAFT:2', 'RUN-001:APPROVAL_CHECKPOINT', 'RUN-001:APPROVED']);
  const snapshots = spreadsheet.getSheetByName('Payroll Runs');
  assert.deepEqual(snapshots.getRange(2, 1, 4, 1).getValues().map(row => row[0]),
    ['RUN-001:DRAFT:1', 'RUN-001:DRAFT:2', 'RUN-001:APPROVAL_CHECKPOINT', 'RUN-001:APPROVED']);
  assert.equal(JSON.parse(snapshots.getRange(2, 6).getValues()[0][0]).revision, 1);
  assert.equal(JSON.parse(snapshots.getRange(3, 6).getValues()[0][0]).revision, 2);
});

test('audit tabs project overrides and decisions from durable run state without duplicate retry rows', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet(), sheets = WorkbookSetup.ensureManagedSheets(spreadsheet);
  const run = runRecord({ createdBy: 'hr@example.test', createdAt: '2026-10-04T09:00:00Z',
    decisions: { employeeDecisions: { 'EMP-001': { deductions: [{ amount: 125, reason: 'Equipment', source: { spreadsheetId: 'deductions', tab: 'Charges', row: 7 } }] } },
      holidayWork: { applies: true, employeeIds: ['EMP-001'] } },
    acknowledgements: { partialDepartmentsFingerprint: 'partial-123' },
    ocrAuditEvidence: [{ url: 'https://drive.google.com/file/d/evidence', evidenceId: 'evidence' }],
    overrides: [{ runId: 'RUN-001', employeeId: 'EMP-001', component: 'basic', originalValue: 15000,
      previousValue: 15000, value: 16000, reason: 'HR correction', editor: 'hr@example.test', timestamp: '2026-10-04T09:30:00Z' }] });
  WorkbookSetup.projectAuditTabs(sheets, run);
  const override = spreadsheet.getSheetByName('Override Audit');
  const decisions = spreadsheet.getSheetByName('Run Decisions');
  assert.deepEqual(override.getRange(2, 1, 1, 10).getValues()[0],
    ['RUN-001', 'basic', 'EMP-001', 'Alex Smith', 15000, 15000, 16000, 'HR correction', 'hr@example.test', '2026-10-04T09:30:00Z']);
  assert.match(decisions.getRange(2, 10).getValues()[0][0], /deductions|holidayWork|partialDepartmentsFingerprint/);
  const rowsBeforeRetry = [override.getLastRow(), decisions.getLastRow()];
  WorkbookSetup.projectAuditTabs(sheets, run);
  assert.deepEqual([override.getLastRow(), decisions.getLastRow()], rowsBeforeRetry);
  run.overrides[0].reason = '=SUM(1,1)';
  WorkbookSetup.projectAuditTabs(sheets, run);
  assert.equal(override.getRange(2, 8).getValues()[0][0], "'=SUM(1,1)");
  assert.equal(override.getLastRow(), rowsBeforeRetry[0]);
  run.state = 'APPROVED'; run.approvedBy = 'approver@example.test'; run.approvedAt = '2026-10-04T10:00:00Z';
  run.approvalCheckpoint = { approvedBy: run.approvedBy, approvedAt: run.approvedAt, state: 'APPROVING' };
  WorkbookSetup.projectAuditTabs(sheets, run);
  assert.match([...decisions.cells.values()].map(String).join('|'), /APPROVED|approver@example.test/);
  const approvedRows = decisions.getLastRow();
  WorkbookSetup.projectAuditTabs(sheets, run);
  assert.equal(decisions.getLastRow(), approvedRows);
});
