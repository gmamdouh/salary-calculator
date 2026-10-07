/** Apps Script I/O seam. create({spreadsheetApp, formatDate}) allows injected fakes.
 * Raw bundles contain row envelopes for MappingConfig; no source row is an identity.
 * Access validation checks readable tabs/headers, not permission to edit protected cells.
 */
SalaryCalculator.SpreadsheetGateway = (function () {
  function create(dependencies) {
    dependencies = dependencies || {};
    function app() { return dependencies.spreadsheetApp || SpreadsheetApp; }
    function fail(errors) { var error = new Error(errors.map(function (item) { return item.code + ': ' + item.message; }).join('; ')); error.issues = errors; throw error; }
    function issue(config, kind, code, message, row, column, field) {
      return { code: code, message: message, spreadsheetId: kind === 'employee' ? config.spreadsheetId : kind === 'deduction' ? config.deductionSpreadsheetId : config.leaveSpreadsheetId,
        tab: config[kind + 'Tab'], row: row || config[kind + 'HeaderRow'] || 1, column: column || null, field: field || null };
    }
    function configured(config) {
      var parsed = SalaryCalculator.MappingConfig.parse([config])[0];
      var report = SalaryCalculator.MappingConfig.validate([parsed]);
      if (!report.valid) fail(report.errors);
      return parsed;
    }
    function readTable(config, kind, books) {
      var id = kind === 'employee' ? config.spreadsheetId : kind === 'deduction' ? config.deductionSpreadsheetId : config.leaveSpreadsheetId;
      var book = books[id] || (books[id] = app().openById(id));
      var sheet = book.getSheetByName(config[kind + 'Tab']);
      if (!sheet) fail([issue(config, kind, 'MISSING_TAB', 'Configured source tab is missing')]);
      var range = sheet.getDataRange(), typed = range.getValues(), displayed = range.getDisplayValues();
      var headerRow = config[kind + 'HeaderRow'] || 1;
      var headers = (displayed[headerRow - 1] || []).map(function (value) { return String(value).trim(); });
      var mapped = config[kind + 'Columns'], errors = [];
      Object.keys(mapped).forEach(function (field) {
        var matches = headers.filter(function (header) { return header === mapped[field]; }).length;
        if (matches !== 1) errors.push(issue(config, kind, matches ? 'DUPLICATE_HEADER' : 'MISSING_HEADER', 'Mapped header must occur exactly once: ' + mapped[field], headerRow, null, field));
      });
      if (kind === 'employee') Object.keys(config.approvalColumns || {}).forEach(function (field) {
        var header = config.approvalColumns[field], matches = headers.filter(function (item) { return item === header; }).length;
        if (matches !== 1) errors.push(issue(config, kind, matches ? 'DUPLICATE_HEADER' : 'MISSING_HEADER', 'Mapped approval header must occur exactly once: ' + header, headerRow, null, field));
      });
      if (errors.length) fail(errors);
      var rows = [];
      for (var index = headerRow; index < typed.length; index++) {
        var display = displayed[index] || [];
        if (!display.some(function (cell) { return String(cell).trim(); })) continue;
        var values = typed[index].slice();
        Object.keys(mapped).forEach(function (field) {
          var column = headers.indexOf(mapped[field]), value = values[column];
          if (field === 'employeeId' || field === 'referrerEmployeeId') values[column] = display[column];
          // A sheet date is interpreted in its workbook timezone, not the server timezone.
          if (Object.prototype.toString.call(value) === '[object Date]') {
            var formatter = dependencies.formatDate || function (date, timezone) { return Utilities.formatDate(date, timezone, 'yyyy-MM-dd'); };
            values[column] = formatter(value, book.getSpreadsheetTimeZone());
          }
        });
        rows.push({ values: values, displayValues: display.slice(), headers: headers.slice(), rowNumber: index + 1 });
      }
      return { sheet: sheet, headers: headers, rows: rows };
    }
    function employeeIndex(config, table) {
      var index = Object.create(null), errors = [];
      table.rows.forEach(function (row) {
        var employee = SalaryCalculator.MappingConfig.normalizeEmployee(row, config);
        if (index[employee.employeeId]) errors.push(issue(config, 'employee', 'DUPLICATE_EMPLOYEE_ID', 'Employee ID occurs more than once', row.rowNumber, table.headers.indexOf(config.employeeColumns.employeeId) + 1, 'employeeId'));
        else index[employee.employeeId] = row.rowNumber;
      });
      if (errors.length) fail(errors);
      return index;
    }
    function readEmployeeRoster(config) {
      config = configured(config);
      return readTable(config, 'employee', Object.create(null)).rows;
    }
    function readAttendanceRows(config) {
      config = configured(config);
      return readTable(config, 'attendance', Object.create(null)).rows;
    }
    function readDeductionRows(config) {
      config = configured(config);
      return config.deductionSpreadsheetId ? readTable(config, 'deduction', Object.create(null)).rows : [];
    }
    function readDepartment(config, period) {
      config = configured(config);
      var employeeTable = readTable(config, 'employee', Object.create(null)), attendanceTable = readTable(config, 'attendance', Object.create(null));
      var index = employeeIndex(config, employeeTable);
      var normalized = SalaryCalculator.MappingConfig.normalizeAttendance(attendanceTable.rows, config, period), errors = [];
      normalized.forEach(function (record) {
        if (!index[record.employeeId]) {
          var row = attendanceTable.rows.find(function (item) { return String(item.values[attendanceTable.headers.indexOf(config.attendanceColumns.employeeId)]).trim() === record.employeeId; });
          errors.push(issue(config, 'attendance', 'UNMATCHED_EMPLOYEE_ID', 'Attendance Employee ID is absent from employee source', row.rowNumber, attendanceTable.headers.indexOf(config.attendanceColumns.employeeId) + 1, 'employeeId'));
        }
      });
      if (errors.length) fail(errors);
      return { department: config.department, period: period, employeeRows: employeeTable.rows, attendanceRows: attendanceTable.rows };
    }
    function validateAccess(config, kind) {
      try {
        config = configured(config);
        var books = Object.create(null);
        if (!kind || kind === 'employee') readTable(config, 'employee', books);
        if (!kind || kind === 'attendance') readTable(config, 'attendance', books);
        if ((!kind || kind === 'deduction') && config.deductionSpreadsheetId) readTable(config, 'deduction', books);
        return { valid: true, errors: [], warnings: [], writeAccessVerified: false };
      } catch (error) {
        return { valid: false, errors: error.issues || [{ code: 'ACCESS_ERROR', message: 'Unable to read configured source workbook' }], warnings: [], writeAccessVerified: false };
      }
    }
    function writeApprovalState(config, writes) {
      var written = 0;
      try {
        config = configured(config);
        var table = readTable(config, 'employee', Object.create(null)), index = employeeIndex(config, table);
        if (!Array.isArray(writes)) throw new Error('Writes must be an array');
        var cells = [], errors = [], seen = Object.create(null), allowed = ['runId', 'payrollMonth', 'approvedBy', 'approvedAt', 'paid', 'probationPaid', 'referralPaid', 'status'];
        writes.forEach(function (write) {
          var id = write.employeeId, row = index[id];
          function add(field, code, message) { errors.push(issue(config, 'employee', code, message, row, null, field)); }
          if (typeof id !== 'string' || !id.trim() || !row) add('employeeId', 'UNMATCHED_EMPLOYEE_ID', 'Approval Employee ID is absent from employee source');
          if (seen[id]) add('employeeId', 'DUPLICATE_WRITE', 'Employee ID occurs more than once in approval writes');
          seen[id] = true;
          if (!write.values || typeof write.values !== 'object' || Array.isArray(write.values) || !Object.keys(write.values).length) { add('values', 'INVALID_WRITE', 'Approval values are required'); return; }
          Object.keys(write.values).forEach(function (field) {
            var header = config.approvalColumns && config.approvalColumns[field], column = table.headers.indexOf(header) + 1, value = write.values[field];
            if (allowed.indexOf(field) === -1 || !header || column === 0 || table.headers.filter(function (item) { return item === header; }).length !== 1) add(field, 'INVALID_WRITE_MAPPING', 'Field requires a unique configured approval header');
            else if (Object.keys(config.employeeColumns).some(function (key) { return config.employeeColumns[key] === header; })) add(field, 'INVALID_WRITE_MAPPING', 'Approval columns cannot overwrite employee source columns');
            else if (typeof value !== (['paid', 'probationPaid', 'referralPaid'].indexOf(field) !== -1 ? 'boolean' : 'string')) add(field, 'INVALID_WRITE_VALUE', 'Payment flags must be boolean and approval metadata must be text');
            else {
              // Prevent status text from being interpreted as a sheet formula.
              if (typeof value === 'string' && /^[=+\-@]/.test(value)) value = "'" + value;
              cells.push({ row: row, column: column, value: value });
            }
          });
        });
        if (errors.length) fail(errors);
        cells.sort(function (a, b) { return a.row - b.row || a.column - b.column; });
        // Form contiguous column strips, then merge identical strips in adjacent rows.
        // Never fill gaps: unmapped cells and formulas must survive untouched.
        var strips = [];
        cells.forEach(function (cell) {
          var last = strips[strips.length - 1];
          if (last && last.row === cell.row && last.column + last.values[0].length === cell.column) last.values[0].push(cell.value);
          else strips.push({ row: cell.row, column: cell.column, values: [[cell.value]] });
        });
        var batches = [], previous = Object.create(null);
        strips.forEach(function (strip) {
          var key = strip.column + ':' + strip.values[0].length, batch = previous[key];
          if (batch && batch.row + batch.values.length === strip.row) batch.values.push(strip.values[0]);
          else { batches.push(strip); previous[key] = strip; }
        });
        batches.forEach(function (batch) {
          table.sheet.getRange(batch.row, batch.column, batch.values.length, batch.values[0].length).setValues(batch.values);
          written += batch.values.length * batch.values[0].length;
        });
        return { valid: true, written: written, partial: false, errors: [] };
      } catch (error) {
        return { valid: false, written: written, partial: written > 0, errors: error.issues || [{ code: 'WRITE_ERROR', message: 'Unable to write configured approval state' }] };
      }
    }
    return { readDepartment: readDepartment, readEmployeeRoster: readEmployeeRoster,
      readAttendanceRows: readAttendanceRows, readDeductionRows: readDeductionRows, validateAccess: validateAccess, writeApprovalState: writeApprovalState };
  }
  return { create: create,
    createMaster: function () {
      function writeRows(sheet, row, column, values) {
        if (!Array.isArray(values) || !values.length) return 0;
        sheet.getRange(row, column, values.length, values[0].length).setValues(values);
        return values.length;
      }
      function clearRows(sheet, startRow, endRow, columns) {
        var lastRow = Math.max(startRow, endRow || sheet.getLastRow());
        if (lastRow >= startRow && columns > 0) sheet.getRange(startRow, 1, lastRow - startRow + 1, columns).clearContent();
      }
      function protectRange(sheet, row, column, rows, columns, description) {
        var range = sheet.getRange(row, column, rows, columns), type = typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.ProtectionType.RANGE : undefined;
        var existing = sheet.getProtections ? sheet.getProtections(type) : [];
        for (var index = 0; index < existing.length; index++) {
          if (existing[index].getDescription && existing[index].getDescription() === description) return existing[index];
        }
        var protection = range.protect();
        protection.setDescription(description);
        protection.setWarningOnly(false);
        return protection;
      }
      function protectSheet(sheet, description) {
        var type = typeof SpreadsheetApp !== 'undefined' ? SpreadsheetApp.ProtectionType.SHEET : undefined;
        var existing = sheet.getProtections ? sheet.getProtections(type) : [];
        for (var index = 0; index < existing.length; index++) {
          if (existing[index].getDescription && existing[index].getDescription() === description) return existing[index];
        }
        var protection = sheet.protect();
        protection.setDescription(description);
        protection.setWarningOnly(false);
        return protection;
      }
      function format(sheet, row, column, rows, columns, pattern) {
        if (rows > 0 && columns > 0) sheet.getRange(row, column, rows, columns).setNumberFormat(pattern);
      }
      return { writeRows: writeRows, clearRows: clearRows, protectRange: protectRange,
        protectSheet: protectSheet, format: format };
    },
    readDepartment: function (config, period) { return create().readDepartment(config, period); },
    readEmployeeRoster: function (config) { return create().readEmployeeRoster(config); },
    readAttendanceRows: function (config) { return create().readAttendanceRows(config); },
    readDeductionRows: function (config) { return create().readDeductionRows(config); },
    validateAccess: function (config, kind) { return create().validateAccess(config, kind); },
    writeApprovalState: function (config, writes) { return create().writeApprovalState(config, writes); } };
})();
