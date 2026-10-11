/** Master workbook schema, defaults and user-facing payroll projections. */
SalaryCalculator.WorkbookSetup = (function () {
  var SHEETS = {
    'Dashboard': { headers: ['Section', 'Value', 'Updated At'] },
    'Sources & Mappings': { headers: ['Department', 'Employee Workbook ID', 'Leave Tracker Workbook ID', 'Employee Tab', 'Attendance Tab', 'Employee Header Row', 'Attendance Header Row', 'Employee Column Mappings', 'Attendance Column Mappings', 'Approval Column Mappings', 'Access Check', 'Last Checked', 'Deduction Workbook ID', 'Deduction Tab', 'Deduction Header Row', 'Deduction Column Mappings'] },
    'Salary Rules': { headers: ['Rule Type', 'Department', 'Rule Key', 'Value', 'Notes'] },
    'Holiday Calendar': { headers: ['Holiday Name', 'Occasion Date', 'Actual Holiday Date', 'Number of Days', 'Triple Pay', 'Status'] },
    'Latest Results': { title: 'Active Employees', headerRow: 2, headers: ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Probation EGP', 'Referral EGP', 'Additions EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'] },
    'Payroll History': { headers: ['Run ID', 'Version', 'State', 'Employee ID', 'American Name', 'Department', 'Payroll Month', 'Cutoff', 'Final Settlement', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Additions EGP', 'Deductions EGP', 'Total EGP', 'Run Snapshot Ref'] },
    'Payment Ledger': { headers: ['Benefit Key', 'Type', 'Employee ID', 'Related Employee ID', 'Amount EGP', 'Payroll Month', 'Run ID', 'Paid', 'Payment Date', 'Decision', 'Eligibility', 'Notes'] },
    'Override Audit': { headers: ['Run ID', 'Component', 'Employee ID', 'American Name', 'Calculated EGP', 'Previous EGP', 'Edited EGP', 'Reason', 'Editor', 'Timestamp', 'Audit Key'] },
    'Run Decisions': { headers: ['Run ID', 'Decision Type', 'Employee ID', 'American Name', 'Decision', 'Reason', 'Evidence URL', 'Acknowledged By', 'Timestamp', 'Details JSON', 'Audit Key'] },
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
  var ACTIVE_COMPONENTS = ['basic', 'abs', 'commission', 'extraDays', 'probation', 'referral', 'additions', 'deductions'];
  var FINAL_COMPONENTS = ['basic', 'abs', 'commission', 'extraDays', 'annualBalance', 'probation', 'referral', 'additions', 'deductions'];
  var HISTORY_COMPONENTS = ['basic', 'abs', 'commission', 'extraDays', 'annualBalance', 'probation', 'referral', 'additions', 'deductions'];
  var FINAL_HEADERS = ['American Name', 'Department', 'Payroll Month', 'Cutoff', 'Basic EGP', 'ABS EGP', 'Commission EGP', 'Extra Days EGP', 'Annual Balance EGP', 'Probation EGP', 'Referral EGP', 'Additions EGP', 'Deductions EGP', 'Total EGP', 'Notes', 'Warnings'];

  function masterGateway() { return SalaryCalculator.SpreadsheetGateway.createMaster(); }
  function migrateAdditions(sheet, name, headerRow, headers) {
    if (name !== 'Latest Results' && name !== 'Payroll History') return false;
    var previous = headers.slice();
    var additionColumn = previous.indexOf('Additions EGP');
    previous.splice(additionColumn, 1);
    if (name === 'Payroll History') {
      var interrupted = sheet.getRange(headerRow, 1, 1, headers.length).getValues()[0];
      if (interrupted.every(function (value, index) { return index === additionColumn ? value === '' : value === headers[index]; })) {
        var remaining = sheet.getLastRow() - 1;
        if (remaining > 0) {
          var resumed = sheet.getRange(2, 1, remaining, headers.length).getValues().map(function (row) {
            if (typeof row[18] !== 'number') return [''];
            var delta = Math.round((row[18] - row.slice(9, 18).reduce(function (sum, value, index) {
              return sum + (index + 9 !== additionColumn && typeof value === 'number' ? value : 0);
            }, 0)) * 100) / 100;
            return [Number.isFinite(delta) && delta >= 0 ? delta : ''];
          });
          masterGateway().writeRows(sheet, 2, additionColumn + 1, resumed);
        }
        masterGateway().writeRows(sheet, 1, additionColumn + 1, [['Additions EGP']]);
        return true;
      }
    }
    var existing = sheet.getRange(headerRow, 1, 1, previous.length).getValues()[0];
    if (!previous.every(function (header, index) { return existing[index] === header; })) return false;
    var lastRow = sheet.getLastRow(), lastColumn = sheet.getLastColumn();
    if (name === 'Payroll History') {
      if (typeof sheet.insertColumnBefore !== 'function') throw new Error('Payroll History cannot be migrated safely');
      var oldRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, previous.length).getValues() : [];
      var additions = oldRows.map(function (row) {
        if (typeof row[17] !== 'number') return [''];
        var delta = Math.round((row[17] - row.slice(9, 17).reduce(function (sum, value) {
          return sum + (typeof value === 'number' ? value : 0);
        }, 0)) * 100) / 100;
        return [Number.isFinite(delta) && delta >= 0 ? delta : ''];
      });
      sheet.insertColumnBefore(additionColumn + 1);
      if (additions.length) masterGateway().writeRows(sheet, 2, additionColumn + 1, additions);
      masterGateway().writeRows(sheet, 1, additionColumn + 1, [['Additions EGP']]);
      if (additions.length) masterGateway().format(sheet, 2, 10, additions.length, 10, '"EGP "#,##0.00');
      return true;
    }
    var rows = sheet.getRange(1, 1, lastRow, lastColumn).getValues(), finalSection = false;
    rows.forEach(function (row, index) {
      if (name === 'Latest Results' && row[0] === 'Final Settlements') finalSection = true;
      var insertAt = name === 'Payroll History' ? additionColumn : finalSection ? additionColumn + 1 : additionColumn;
      var totalAt = name === 'Payroll History' ? 17 : finalSection ? 12 : 11;
      var firstComponent = name === 'Payroll History' ? 9 : 4;
      var addition = '';
      if ((name === 'Payroll History' ? index > 0 : index > 1 && row[0] !== 'Final Settlements' && row[0] !== 'American Name') &&
          typeof row[totalAt] === 'number') {
        var delta = Math.round((row[totalAt] - row.slice(firstComponent, totalAt).reduce(function (sum, value) {
          return sum + (typeof value === 'number' ? value : 0);
        }, 0)) * 100) / 100;
        if (Number.isFinite(delta) && delta >= 0) addition = delta;
      }
      row.splice(insertAt, 0, addition);
      if (index + 1 === headerRow) row.splice(additionColumn, 1, 'Additions EGP');
      if (name === 'Latest Results' && row[0] === 'American Name' && finalSection) row.splice(additionColumn + 1, 1, 'Additions EGP');
    });
    masterGateway().clearRows(sheet, 1, lastRow, Math.max(lastColumn, headers.length + 1));
    masterGateway().writeRows(sheet, 1, 1, rows);
    if (lastRow > headerRow) {
      masterGateway().format(sheet, headerRow + 1, name === 'Payroll History' ? 10 : 5,
        lastRow - headerRow, name === 'Payroll History' ? 10 : 10, '"EGP "#,##0.00');
    }
    return true;
  }
  function ensureManagedSheets(spreadsheet) {
    if (!spreadsheet || typeof spreadsheet.getSheetByName !== 'function' || typeof spreadsheet.insertSheet !== 'function') throw new Error('A spreadsheet is required');
    var map = {};
    SHEET_ORDER.forEach(function (name) {
      var schema = SHEETS[name], sheet = spreadsheet.getSheetByName(name);
      if (!sheet) sheet = spreadsheet.insertSheet(name);
      map[name] = sheet;
      if (schema.title && sheet.getLastRow() === 0) masterGateway().writeRows(sheet, 1, 1, [[schema.title]]);
      var row = schema.headerRow || 1;
      migrateAdditions(sheet, name, row, schema.headers);
      var existing = sheet.getRange(row, 1, 1, schema.headers.length).getValues()[0];
      if (!existing.some(function (value) { return value !== '' && value !== null && value !== undefined; })) masterGateway().writeRows(sheet, row, 1, [schema.headers]);
      else if (schema.headers.some(function (header, index) { return existing[index] !== header; })) {
        var oldWidth = name === 'Sources & Mappings' ? 12 : name === 'Override Audit' || name === 'Run Decisions' ? 10 : 0;
        var matchingPrefix = oldWidth && schema.headers.slice(0, oldWidth).every(function (header, index) { return existing[index] === header; });
        var blankSuffix = matchingPrefix && existing.slice(oldWidth).every(function (value) { return value === '' || value === null || value === undefined; });
        var suffixHasData = blankSuffix && sheet.getLastRow() > row && sheet.getRange(row + 1, oldWidth + 1,
          sheet.getLastRow() - row, schema.headers.length - oldWidth).getValues().some(function (values) {
          return values.some(function (value) { return value !== '' && value !== null && value !== undefined; });
        });
        if (!blankSuffix || suffixHasData) throw new Error('Managed header mismatch in ' + name);
        masterGateway().writeRows(sheet, row, oldWidth + 1, [schema.headers.slice(oldWidth)]);
      }
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
    rows.push(['CYCLE', 'SALES', 'quarterly payment months', '', 'Unset. Configure company-wide payout months before enabling quarterly ABS payment.']);
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
  function protectedEditors(policy) {
    var configured = policy && policy.editorEmails;
    var effective = policy && String(policy.effectiveUserEmail || '').trim().toLowerCase();
    if (!Array.isArray(configured) || !configured.length || !effective) throw new Error('Protected editor configuration is missing');
    var emails = configured.map(function (email) { return String(email).trim().toLowerCase(); });
    if (emails.indexOf(effective) === -1) emails.push(effective);
    if (emails.some(function (email) { return !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); })) throw new Error('Protected editor configuration has an invalid email');
    return emails.filter(function (email, index) { return emails.indexOf(email) === index; });
  }
  function enforceProtections(sheetMap, policy) {
    var gateway = masterGateway(), editors = protectedEditors(policy);
    SHEET_ORDER.filter(function (name) { return name !== 'Latest Results'; }).forEach(function (name) {
      var sheet = sheetMap[name];
      if (!sheet) throw new Error(name + ' sheet is required for protection');
      var enforced = gateway.protectSheet(sheet, 'SalaryCalculator: protected ' + name, editors);
      var sheetType = typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.ProtectionType.SHEET : 'SHEET';
      (sheet.getProtections ? sheet.getProtections(sheetType) : []).forEach(function (protection) {
        if (protection !== enforced && protection.getDescription && /^SalaryCalculator:/.test(protection.getDescription())) protection.remove();
      });
      var type = typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.ProtectionType.RANGE : 'RANGE';
      (sheet.getProtections ? sheet.getProtections(type) : []).forEach(function (protection) {
        if (protection.getDescription && /^SalaryCalculator:/.test(protection.getDescription())) protection.remove();
      });
    });
  }
  function initialize(spreadsheet, policy) {
    protectedEditors(policy);
    var sheetMap = ensureManagedSheets(spreadsheet);
    seedDefaultRules(sheetMap);
    seedHolidayCalendar(sheetMap);
    enforceProtections(sheetMap, policy);
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
    function values(result, isFinal) {
      var row = [americanName(run, result), result.department || '', run.payrollMonth || result.payrollMonth || '', dateValue(result.cutoff || run.cutoff)];
      (isFinal ? FINAL_COMPONENTS : ACTIVE_COMPONENTS).forEach(function (component) { row.push(amount(result, component)); });
      row.push(typeof result.total === 'number' ? result.total : SalaryCalculator.PayrollEngine.sumComponents(result.components || {}));
      row.push((result.notes || []).join('; '));
      row.push((result.warnings || []).join('; '));
      return row;
    }
    var activeRows = active.map(function (result) { return values(result, false); }), finalTitleRow = 3 + activeRows.length + 1;
    if (activeRows.length) gateway.writeRows(sheet, 3, 1, activeRows);
    gateway.writeRows(sheet, finalTitleRow, 1, [['Final Settlements']]);
    gateway.writeRows(sheet, finalTitleRow + 1, 1, [FINAL_HEADERS]);
    var finalRows = final.map(function (result) { return values(result, true); });
    if (finalRows.length) gateway.writeRows(sheet, finalTitleRow + 2, 1, finalRows);
    var totalRows = activeRows.length + finalRows.length;
    if (totalRows) {
      gateway.format(sheet, 3, 5, activeRows.length || 1, 9, '"EGP "#,##0.00');
      gateway.format(sheet, finalTitleRow + 2, 5, finalRows.length || 1, 10, '"EGP "#,##0.00');
      gateway.format(sheet, 3, 4, activeRows.length || 1, 1, 'dd-MM-yyyy');
      gateway.format(sheet, finalTitleRow + 2, 4, finalRows.length || 1, 1, 'dd-MM-yyyy');
    }
  }
  function appendHistory(sheetMap, run, historyKey) {
    if (!run || !Array.isArray(run.results)) throw new Error('Run results are required');
    if (historyKey !== undefined && (typeof historyKey !== 'string' || !historyKey.trim())) throw new Error('History key is required');
    var sheet = sheetMap['Payroll History'];
    if (!sheet) throw new Error('Payroll History sheet is required');
    var gateway = masterGateway(), existing = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, SHEETS['Payroll History'].headers.length).getValues() : [];
    var state = run.state || 'DRAFT', key = historyKey || run.runId + ':' + run.version + ':' + state,
      snapshot = JSON.stringify(run), rows = [];
    run.results.forEach(function (result) {
      var duplicate = existing.some(function (row) { return row[19] === key && row[3] === result.employeeId; });
      if (duplicate) return;
      var row = [run.runId, run.version, state, result.employeeId || '', americanName(run, result), result.department || '', run.payrollMonth || result.payrollMonth || '', dateValue(result.cutoff || run.cutoff), result.finalSettlement === true];
      HISTORY_COMPONENTS.forEach(function (component) { row.push(amount(result, component)); });
      row.push(typeof result.total === 'number' ? result.total : SalaryCalculator.PayrollEngine.sumComponents(result.components || {}));
      row.push(key);
      rows.push(row);
    });
    if (rows.length) {
      var startRow = Math.max(2, sheet.getLastRow() + 1);
      gateway.writeRows(sheet, startRow, 1, rows);
      gateway.format(sheet, startRow, 10, rows.length, 10, '"EGP "#,##0.00');
      gateway.format(sheet, startRow, 8, rows.length, 1, 'dd-MM-yyyy');
    }
    var runsSheet = sheetMap['Payroll Runs'];
    if (runsSheet) {
      var savedRuns = runsSheet.getLastRow() > 1 ? runsSheet.getRange(2, 1, runsSheet.getLastRow() - 1, 1).getValues() : [];
      var saved = savedRuns.some(function (row) { return row[0] === key; });
      if (!saved) gateway.writeRows(runsSheet, runsSheet.getLastRow() + 1, 1, [[key, run.version, state, run.payrollMonth || '', dateValue(run.cutoff), snapshot]]);
    }
    return rows.length;
  }
  function projectAuditTabs(sheetMap, run) {
    var gateway = masterGateway(), results = run.results || [], evidence = (run.ocrAuditEvidence || []).map(function (item) { return item.url; }).filter(Boolean).join(', ');
    function name(employeeId) {
      var result = results.find(function (item) { return item.employeeId === employeeId; });
      return result ? americanName(run, result) : '';
    }
    function write(name, rows) {
      var target = sheetMap[name];
      if (!target) throw new Error(name + ' sheet is required');
      var last = target.getLastRow(), keys = last > 1 ? target.getRange(2, 11, last - 1, 1).getValues() : [], index = Object.create(null);
      keys.forEach(function (row, position) { if (row[0]) index[String(row[0])] = position + 2; });
      rows.forEach(function (row) {
        var safeRow = row.map(function (value) {
          return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
        });
        var key = safeRow[10], position = index[key] || target.getLastRow() + 1;
        gateway.writeRows(target, position, 1, [safeRow]);
        index[key] = position;
      });
    }
    var overrides = (run.overrides || []).map(function (item, index) {
      return [run.runId, item.component, item.employeeId, name(item.employeeId), item.originalValue, item.previousValue,
        item.value, item.reason, item.editor, item.timestamp, run.runId + ':OVERRIDE:' + index];
    });
    write('Override Audit', overrides);
    var decisions = [];
    function add(type, employeeId, decision, reason, acknowledgedBy, timestamp, details, key) {
      decisions.push([run.runId, type, employeeId || '', employeeId ? name(employeeId) : '', decision, reason || '', evidence,
        acknowledgedBy || '', timestamp || run.createdAt || '', JSON.stringify(details), run.runId + ':DECISION:' + key]);
    }
    var payload = run.decisions || {}, perEmployee = payload.employeeDecisions || {};
    Object.keys(perEmployee).sort().forEach(function (employeeId) {
      Object.keys(perEmployee[employeeId] || {}).sort().forEach(function (type) {
        var value = perEmployee[employeeId][type], record = value && typeof value === 'object' ? value : {};
        add(type, employeeId, typeof record.approved === 'boolean' ? (record.approved ? 'APPROVED' : 'DECLINED') : 'RECORDED',
          record.reason || (Array.isArray(value) ? value.map(function (item) { return item && item.reason; }).filter(Boolean).join('; ') : ''),
          run.createdBy, run.createdAt, value, 'EMPLOYEE:' + employeeId + ':' + type);
      });
    });
    Object.keys(payload).filter(function (key) { return key !== 'employeeDecisions'; }).sort().forEach(function (type) {
      add(type, '', 'RECORDED', '', run.createdBy, run.createdAt, payload[type], 'RUN:' + type);
    });
    if (run.acknowledgements && Object.keys(run.acknowledgements).length)
      add('ACKNOWLEDGEMENTS', '', 'ACKNOWLEDGED', '', run.createdBy, run.createdAt, run.acknowledgements, 'ACKNOWLEDGEMENTS');
    if (run.approvalCheckpoint) {
      var approval = run.approvalCheckpoint, status = run.state === 'APPROVED' ? 'APPROVED' : run.writeBackStatus || 'PENDING';
      add('APPROVAL', '', status, (approval.lastWriteBackError || []).map(function (item) { return item.message; }).join('; '),
        approval.approvedBy, approval.approvedAt, { state: run.state, writeBackStatus: run.writeBackStatus, checkpoint: approval }, 'APPROVAL');
    }
    write('Run Decisions', decisions);
    return { overrides: overrides.length, decisions: decisions.length };
  }
  function projectDashboard(sheetMap, runs) {
    var sheet = sheetMap['Dashboard'];
    if (!sheet) throw new Error('Dashboard sheet is required');
    var latest = sheetMap['Latest Results'], id = latest && latest.getSheetId ? latest.getSheetId() : '';
    var recent = (runs || []).slice().sort(function (a, b) {
      return String(b.approvedAt || b.createdAt || '').localeCompare(String(a.approvedAt || a.createdAt || ''));
    }).slice(0, 10);
    var rows = [SHEETS.Dashboard.headers, ['Latest Results', id === '' ? 'Open Latest Results tab' : '#gid=' + id, '']];
    function display(values) {
      return (values || []).map(function (value) { return typeof value === 'string' ? value : value && (value.employeeId || value.department || value.message) || ''; }).filter(Boolean).join('; ');
    }
    recent.forEach(function (run) {
      var label = 'Run ' + run.runId, updated = run.approvedAt || run.createdAt || '';
      rows.push([label, run.state || 'UNKNOWN', updated]);
      rows.push([label + ' · Month / cutoff', [run.payrollMonth || '', run.cutoff || ''].filter(Boolean).join(' / '), updated]);
      rows.push([label + ' · Total EGP', (run.results || []).reduce(function (sum, result) { return sum + (Number(result.total) || 0); }, 0), updated]);
      rows.push([label + ' · Warnings', display(run.warnings), updated]);
      rows.push([label + ' · Omitted departments', display(run.failedDepartments), updated]);
      rows.push([label + ' · Omitted employees', display(run.failedEmployees), updated]);
      if (run.state !== 'APPROVED' || run.writeBackStatus && run.writeBackStatus !== 'COMPLETE') rows.push([label + ' · Resume Run ID', run.runId, updated]);
    });
    rows = rows.map(function (row) { return row.map(function (value) {
      return typeof value === 'string' && /^[=+\-@]/.test(value) ? "'" + value : value;
    }); });
    var gateway = masterGateway(), last = sheet.getLastRow();
    if (last) gateway.clearRows(sheet, 1, last, Math.max(3, sheet.getLastColumn()));
    gateway.writeRows(sheet, 1, 1, rows);
    return recent.length;
  }
  return { initialize: initialize, ensureManagedSheets: ensureManagedSheets, seedDefaultRules: seedDefaultRules,
    seedHolidayCalendar: seedHolidayCalendar, renderLatestResults: renderLatestResults, appendHistory: appendHistory, projectAuditTabs: projectAuditTabs,
    enforceProtections: enforceProtections, protectedEditors: protectedEditors, projectDashboard: projectDashboard,
    schema: function () { return JSON.parse(JSON.stringify(SHEETS)); } };
})();
