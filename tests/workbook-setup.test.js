const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { runRecord } = require('./helpers/fixtures');

const expectedHeaders = {
  'Dashboard': ['Section', 'Value', 'Updated At'],
  'Sources & Mappings': ['Department', 'Employee Workbook ID', 'Leave Tracker Workbook ID', 'Employee Tab', 'Attendance Tab', 'Employee Header Row', 'Attendance Header Row', 'Employee Column Mappings', 'Attendance Column Mappings', 'Approval Column Mappings', 'Access Check', 'Last Checked'],
  'Salary Rules': ['Rule Type', 'Department', 'Rule Key', 'Value', 'Notes'],
  'Holiday Calendar': ['Holiday Name', 'Occasion Date', 'Actual Holiday Date', 'Number of Days', 'Triple Pay', 'Status'],
  'Latest Results': ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'],
  'Payroll History': ['Run ID', 'Version', 'State', 'Employee ID', 'American Name', 'Department', 'Payroll Month', 'Cutoff', 'Final Settlement', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Run Snapshot Ref'],
  'Payment Ledger': ['Benefit Key', 'Type', 'Employee ID', 'Related Employee ID', 'Amount EGP', 'Payroll Month', 'Run ID', 'Paid', 'Payment Date', 'Decision', 'Eligibility', 'Notes'],
  'Override Audit': ['Run ID', 'Component', 'Employee ID', 'American Name', 'Calculated EGP', 'Previous EGP', 'Edited EGP', 'Reason', 'Editor', 'Timestamp'],
  'Run Decisions': ['Run ID', 'Decision Type', 'Employee ID', 'American Name', 'Decision', 'Reason', 'Evidence URL', 'Acknowledged By', 'Timestamp', 'Details JSON'],
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
      clearContent() { for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) sheet.cells.delete(`${row + r}:${column + c}`); return this; },
      protect() {
        const protection = { description: '', getDescription() { return this.description; }, setDescription(value) { this.description = value; return this; }, setWarningOnly(value) { this.warningOnly = value; return this; } };
        sheet.protections.push({ row, column, rows, columns, protection }); return protection;
      },
      setNumberFormat(value) { sheet.formats.push({ row, column, rows, columns, value }); return this; }
    };
  }
  return {
    getSheetByName(name) { return sheets.get(name) || null; },
    insertSheet(name) {
      const sheet = { name, cells: new Map(), protections: [], formats: [], hidden: false,
        getName() { return name; }, getRange: (...args) => range(sheet, ...args),
        getLastRow() { return Math.max(0, ...[...sheet.cells.keys()].map(key => Number(key.split(':')[0]))); },
        getLastColumn() { return Math.max(0, ...[...sheet.cells.keys()].map(key => Number(key.split(':')[1]))); },
        getMaxRows() { return 1000; },
        getDataRange() { return range(sheet, 1, 1, this.getLastRow(), this.getLastColumn()); },
        hideSheet() { sheet.hidden = true; return sheet; }, showSheet() { sheet.hidden = false; return sheet; },
        protect() { const protection = { getDescription() { return this.description; }, setDescription(value) { this.description = value; return this; }, setWarningOnly(value) { this.warningOnly = value; return this; } }; sheet.protections.push({ wholeSheet: true, protection }); return protection; },
        getProtections() { return sheet.protections.map(item => item.protection); }
      };
      sheets.set(name, sheet); return sheet;
    },
    getSheets() { return [...sheets.values()]; }
  };
}

const managed = ['Dashboard', 'Sources & Mappings', 'Salary Rules', 'Holiday Calendar', 'Latest Results', 'Payroll History', 'Payment Ledger', 'Override Audit', 'Run Decisions'];

test('initialization creates the approved managed tabs with stable headers and protected technical identifiers', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
  const report = WorkbookSetup.initialize(spreadsheet);
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
  WorkbookSetup.initialize(spreadsheet);
  const before = spreadsheet.getSheets().map(sheet => [sheet.name, sheet.getLastRow(), sheet.getLastColumn()]);
  const protections = spreadsheet.getSheets().map(sheet => sheet.protections.length);
  WorkbookSetup.initialize(spreadsheet);
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
  const activeHeaders = ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'];
  const finalHeaders = ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'];
  assert.deepEqual(sheet.getRange(2, 1, 1, activeHeaders.length).getValues()[0], activeHeaders);
  assert.deepEqual(sheet.getRange(6, 1, 1, finalHeaders.length).getValues()[0], finalHeaders);
  const activeRow = sheet.getRange(3, 1, 1, activeHeaders.length).getValues()[0];
  const finalRow = sheet.getRange(7, 1, 1, finalHeaders.length).getValues()[0];
  assert.equal(activeRow.includes(7777), false);
  assert.equal(activeRow[11], 14000);
  assert.equal(finalRow[8], 600);
  assert.equal(finalRow[12], 21600);
});

test('history preserves Employee IDs in protected audit data and appends one row per result', () => {
  const { WorkbookSetup } = loadAppsScript();
  const spreadsheet = fakeSpreadsheet();
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
