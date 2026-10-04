/** Master workbook schema, defaults and user-facing payroll projections. */
SalaryCalculator.WorkbookSetup = (function () {
  var SHEETS = {
    'Dashboard': { headers: ['Section', 'Value', 'Updated At'] },
    'Sources & Mappings': { headers: ['Department', 'Employee Workbook ID', 'Leave Tracker Workbook ID', 'Employee Tab', 'Attendance Tab', 'Employee Header Row', 'Attendance Header Row', 'Employee Column Mappings', 'Attendance Column Mappings', 'Approval Column Mappings', 'Access Check', 'Last Checked'] },
    'Salary Rules': { headers: ['Rule Type', 'Department', 'Rule Key', 'Value', 'Notes'] },
    'Holiday Calendar': { headers: ['Holiday Name', 'Occasion Date', 'Actual Holiday Date', 'Number of Days', 'Triple Pay', 'Status'] },
    'Latest Results': { title: 'Active Employees', headerRow: 2, headers: ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Final Settlement', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'] },
    'Payroll History': { headers: ['Run ID', 'Version', 'State', 'Employee ID', 'American Name', 'Department', 'Payroll Month', 'Cutoff', 'Final Settlement', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Deductions EGP', 'Total EGP', 'Run Snapshot Ref'] },
    'Payment Ledger': { headers: ['Benefit Key', 'Type', 'Employee ID', 'Related Employee ID', 'Amount EGP', 'Payroll Month', 'Run ID', 'Paid', 'Payment Date', 'Decision', 'Eligibility', 'Notes'] },
    'Override Audit': { headers: ['Run ID', 'Component', 'Employee ID', 'American Name', 'Calculated EGP', 'Previous EGP', 'Edited EGP', 'Reason', 'Editor', 'Timestamp'] },
    'Run Decisions': { headers: ['Run ID', 'Decision Type', 'Employee ID', 'American Name', 'Decision', 'Reason', 'Evidence URL', 'Acknowledged By', 'Timestamp', 'Details JSON'] },
    'Payroll Runs': { headers: ['Run ID', 'Version', 'State', 'Payroll Month', 'Cutoff', 'RunRecord JSON'], hidden: true, protected: true }
  };
  var SHEET_ORDER = ['Dashboard', 'Sources & Mappings', 'Salary Rules', 'Holiday Calendar', 'Latest Results', 'Payroll History', 'Payment Ledger', 'Override Audit', 'Run Decisions', 'Payroll Runs'];
  var HOLIDAYS_2027 = [
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
  ];
  var COMPONENTS = ['basic', 'abs', 'commission', 'extraDays', 'annualBalance', 'probation', 'referral', 'deductions'];

  function masterGateway() { return SalaryCalculator.SpreadsheetGateway.createMaster(); }
  function ensureManagedSheets(spreadsheet) {
    if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function' || typeof spreadsheet.insertSheet !== 'function') throw new Error('A spreadsheet is required');
    var map = {};
    SHEET_ORDER.forEach(function (name) {
      var schema = SHEETS[name], sheet = spreadsheet.getSheetByName(name);
      if (!sheet) sheet = spreadsheet.insertSheet(name);
      map[name] = sheet;
      if (schema.title && sheet.getLastRow() === 0) masterGateway().writeRows(sheet, 1, 1, [[schema.title]]);
      var row = schema.headerRow || 1, existing = sheet.getRange(row, 1, 1, schema.headers.length).getValues()[0];
      if (!existing.some(function (value) { return value !== '' && value !== null && value !== undefined; })) masterGateway().writeRows(sheet, row, 1, [schema.headers]);
      else if (schema.headers.some(function (header, index) { return existing[index] !== header; })) throw new Error('Managed header mismatch in ' + name);
      if (schema.hidden && typeof sheet.hideSheet === 'function') sheet.hideSheet();
    });
    return map;
  }
  function seedDefaultRules(sheetMap) {
    var sheet = sheetMap['Salary Rules'];
    if (sheet.getLastRow() > 1) return;
    var rows = [];
    var salaries = {
      SURVEY: { before: [12000, 2000], after: [15000, 3000] },
      RESERVATIONS: { before: [12000, 2000], after: [15000, 3000] },
      SALES: { before: [16000, 4000], after: [16000, 4000] },
      TDS: { before: [18000, 0], after: [21000, 0] },
      MANAGEMENT: { before: [21000, 0], after: [27000, 0] }
    };
    Object.keys(salaries).forEach(function (department) {
      ['before', 'after'].forEach(function (phase) {
        rows.push(['SALARY', department, phase + '.basic', salaries[department][phase][0], 'Monthly EGP']);
        rows.push(['SALARY', department, phase + '.abs', salaries[department][phase][1], 'Monthly EGP']);
      });
    });
    [
      ['COMMISSION', 'SURVEY', '1-200', '10', 'EGP per transfer; all transfers at rate'], ['COMMISSION', 'SURVEY', '201-300', '2000 + (transfers - 200) * 15', 'First 200 transfers at EGP 10, remaining transfers at EGP 15'],
      ['COMMISSION', 'SURVEY', '301-350', '15', 'EGP per transfer; all transfers at rate'], ['COMMISSION', 'SURVEY', '351-400', '20', 'EGP per transfer; all transfers at rate'],
      ['COMMISSION', 'SURVEY', '401-500', '25', 'EGP per transfer; all transfers at rate'], ['COMMISSION', 'SURVEY', '501+', '30', 'EGP per transfer; all transfers at rate'],
      ['COMMISSION', 'RESERVATIONS', '1-200', '10', 'EGP per transfer, progressive'], ['COMMISSION', 'RESERVATIONS', '201-300', '15', 'EGP per transfer, progressive'],
      ['COMMISSION', 'RESERVATIONS', '301-400', '20', 'EGP per transfer, progressive'], ['COMMISSION', 'RESERVATIONS', '401-500', '25', 'EGP per transfer, progressive'],
      ['COMMISSION', 'RESERVATIONS', '501+', '30', 'EGP per transfer, progressive']
    ].forEach(function (row) { rows.push(row); });
    var conversionBands = ['0.00%-3.00%', '3.01%-3.99%', '4.00%-4.99%', '5.00%-5.99%', '6.00%+'];
    var saleBrackets = ['1-19', '20-29', '30-39', '40-49', '50+'];
    var salesRates = [[300, 300, 300, 300, 300], [400, 400, 400, 400, 400], [450, 550, 650, 750, 850], [550, 650, 750, 850, 1000], [650, 750, 950, 1100, 1300]];
    conversionBands.forEach(function (band, bandIndex) {
      saleBrackets.forEach(function (bracket, bracketIndex) {
        rows.push(['COMMISSION', 'SALES', band + '|' + bracket, salesRates[bandIndex][bracketIndex], 'EGP per sale']);
      });
    });
    rows.push(['COMMISSION', 'TDS', 'transfers > 75', 100, 'EGP per qualifying agent']);
    rows.push(['CYCLE', 'SALES', 'quarterly payment months', '3,6,9,12', 'Company-wide quarterly ABS payout months']);
    masterGateway().writeRows(sheet, 2, 1, rows);
    masterGateway().format(sheet, 2, 4, 20, 1, '"EGP "#,##0.00');
    masterGateway().format(sheet, 22, 4, 37, 1, '"EGP "#,##0.00');
  }
  function seedHolidayCalendar(sheetMap) {
    var sheet = sheetMap['Holiday Calendar'];
    if (sheet.getLastRow() > 1) return;
    function dateCell(value) {
      var match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
      return match ? new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]))) : value;
    }
    var rows = HOLIDAYS_2027.map(function (row) { return [row[0], dateCell(row[1]), dateCell(row[2]), row[3], row[4], row[5]]; });
    masterGateway().writeRows(sheet, 2, 1, rows);
    masterGateway().format(sheet, 2, 2, HOLIDAYS_2027.length, 2, 'dd-MM-yyyy');
  }
  function protectTechnicalRanges(sheetMap) {
    var gateway = masterGateway(), rowCount = typeof sheetMap['Payroll History'].getMaxRows === 'function' ? sheetMap['Payroll History'].getMaxRows() - 1 : Math.max(1, sheetMap['Payroll History'].getLastRow());
    gateway.protectRange(sheetMap['Payroll History'], 2, 4, rowCount, 1, 'SalaryCalculator: Payroll History Employee ID');
    gateway.protectRange(sheetMap['Payment Ledger'], 2, 3, Math.max(1, (typeof sheetMap['Payment Ledger'].getMaxRows === 'function' ? sheetMap['Payment Ledger'].getMaxRows() : 1000) - 1), 1, 'SalaryCalculator: Payment Ledger Employee ID');
    gateway.protectRange(sheetMap['Override Audit'], 2, 3, Math.max(1, (typeof sheetMap['Override Audit'].getMaxRows === 'function' ? sheetMap['Override Audit'].getMaxRows() : 1000) - 1), 1, 'SalaryCalculator: Override Audit Employee ID');
    gateway.protectRange(sheetMap['Run Decisions'], 2, 3, Math.max(1, (typeof sheetMap['Run Decisions'].getMaxRows === 'function' ? sheetMap['Run Decisions'].getMaxRows() : 1000) - 1), 1, 'SalaryCalculator: Run Decisions Employee ID');
    gateway.protectSheet(sheetMap['Payroll Runs'], 'SalaryCalculator: protected technical run records');
  }
  function initialize(spreadsheet) {
    var sheetMap = ensureManagedSheets(spreadsheet);
    seedDefaultRules(sheetMap);
    seedHolidayCalendar(sheetMap);
    protectTechnicalRanges(sheetMap);
    return { valid: true, sheetNames: SHEET_ORDER.slice(), seeded: { rules: sheetMap['Salary Rules'].getLastRow() > 1, holidays: sheetMap['Holiday Calendar'].getLastRow() > 1 } };
  }
  function amount(result, component) {
    var entry = result.components && result.components[component];
    return entry && typeof entry.amount === 'number' ? entry.amount : 0;
  }
  function dateValue(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : (value || '');
  }
  function americanName(run, result) {
    if (typeof result.americanName === 'string' && result.americanName.trim()) return result.americanName;
    var employee = (run.inputs || []).find(function (item) { return item.employeeId === result.employeeId; });
    return employee && typeof employee.americanName === 'string' ? employee.americanName : '';
  }
  function renderLatestResults(sheetMap, run) {
    if (!run || !Array.isArray(run.results)) throw new Error('Run results are required');
    var sheet = sheetMap['Latest Results'];
    if (!sheet) throw new Error('Latest Results sheet is required');
    var gateway = masterGateway(), width = SHEETS['Latest Results'].headers.length, lastRow = sheet.getLastRow();
    if (lastRow) gateway.clearRows(sheet, 1, lastRow, Math.max(width, sheet.getLastColumn()));
    gateway.writeRows(sheet, 1, 1, [[SHEETS['Latest Results'].title]]);
    gateway.writeRows(sheet, 2, 1, [SHEETS['Latest Results'].headers]);
    var active = run.results.filter(function (item) { return item.finalSettlement !== true; });
    var final = run.results.filter(function (item) { return item.finalSettlement === true; });
    function values(result) {
      var row = [americanName(run, result), result.department || '', run.payrollMonth || result.payrollMonth || '', dateValue(run.cutoff), result.finalSettlement === true];
      COMPONENTS.forEach(function (component) { row.push(amount(result, component)); });
      row.push(typeof result.total === 'number' ? result.total : SalaryCalculator.PayrollEngine.sumComponents(result.components || {}));
      row.push((result.notes || []).join('; '));
      row.push((result.warnings || []).join('; '));
      return row;
    }
    var activeRows = active.map(values), finalTitleRow = 3 + activeRows.length + 1;
    if (activeRows.length) gateway.writeRows(sheet, 3, 1, activeRows);
    gateway.writeRows(sheet, finalTitleRow, 1, [['Final Settlements']]);
    gateway.writeRows(sheet, finalTitleRow + 1, 1, [SHEETS['Latest Results'].headers]);
    var finalRows = final.map(values);
    if (finalRows.length) gateway.writeRows(sheet, finalTitleRow + 2, 1, finalRows);
    var totalRows = activeRows.length + finalRows.length;
    if (totalRows) {
      gateway.format(sheet, 3, 6, activeRows.length || 1, 9, '"EGP "#,##0.00');
      gateway.format(sheet, finalTitleRow + 2, 6, finalRows.length || 1, 9, '"EGP "#,##0.00');
      gateway.format(sheet, 3, 4, activeRows.length || 1, 1, 'dd-MM-yyyy');
      gateway.format(sheet, finalTitleRow + 2, 4, finalRows.length || 1, 1, 'dd-MM-yyyy');
    }
  }
  function appendHistory(sheetMap, run) {
    if (!run || !Array.isArray(run.results)) throw new Error('Run results are required');
    var sheet = sheetMap['Payroll History'];
    if (!sheet) throw new Error('Payroll History sheet is required');
    var gateway = masterGateway(), existing = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS['Payroll History'].headers.length).getValues() : [];
    var state = run.state || 'DRAFT', snapshot = JSON.stringify(run), rows = [];
    run.results.forEach(function (result) {
      var duplicate = existing.some(function (row) { return row[0] === run.runId && row[1] === run.version && row[2] === state && row[3] === result.employeeId; });
      if (duplicate) return;
      var row = [run.runId, run.version, state, result.employeeId || '', americanName(run, result), result.department || '', run.payrollMonth || result.payrollMonth || '', dateValue(run.cutoff), result.finalSettlement === true];
      COMPONENTS.forEach(function (component) { row.push(amount(result, component)); });
      row.push(typeof result.total === 'number' ? result.total : SalaryCalculator.PayrollEngine.sumComponents(result.components || {}));
      row.push(run.runId + ':' + run.version + ':' + state);
      rows.push(row);
    });
    if (rows.length) {
      var startRow = Math.max(2, sheet.getLastRow() + 1);
      gateway.writeRows(sheet, startRow, 1, rows);
      gateway.format(sheet, startRow, 10, rows.length, 9, '"EGP "#,##0.00');
      gateway.format(sheet, startRow, 8, rows.length, 1, 'dd-MM-yyyy');
      gateway.protectRange(sheet, 2, 4, typeof sheet.getMaxRows === 'function' ? sheet.getMaxRows() - 1 : Math.max(1, sheet.getLastRow() - 1), 1, 'SalaryCalculator: Payroll History Employee ID');
    }
    var runsSheet = sheetMap['Payroll Runs'];
    if (runsSheet) {
      var savedRuns = runsSheet.getLastRow() > 1 ? runsSheet.getRange(2, 1, runsSheet.getLastRow() - 1, 3).getValues() : [];
      var saved = savedRuns.some(function (row) { return row[0] === run.runId && row[1] === run.version && row[2] === state; });
      if (!saved) gateway.writeRows(runsSheet, runsSheet.getLastRow() + 1, 1, [[run.runId, run.version, state, run.payrollMonth || '', dateValue(run.cutoff), snapshot]]);
    }
    return rows.length;
  }
  return { initialize: initialize, ensureManagedSheets: ensureManagedSheets, seedDefaultRules: seedDefaultRules,
    seedHolidayCalendar: seedHolidayCalendar, renderLatestResults: renderLatestResults, appendHistory: appendHistory,
    schema: function () { return JSON.parse(JSON.stringify(SHEETS)); } };
})();
