/** Pure source mappings. Columns refer to exact source headers, never row identity.
 * parse accepts object rows or a header-first Sources & Mappings values matrix.
 * Normalizers throw errors with .issues: {code,field,spreadsheetId,tab,row,column}.
 * Gateway row envelopes are {values, displayValues, headers, rowNumber}.
 */
SalaryCalculator.MappingConfig = (function () {
  function text(value) { return value === null || value === undefined ? '' : String(value).trim(); }
  function spreadsheetId(value) {
    var source = text(value), match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)(?:[/?#].*)?$/.exec(source);
    if (match) return match[1];
    if (!/^[A-Za-z0-9_-]+$/.test(source)) throw new Error('Invalid spreadsheet ID or URL');
    return source;
  }
  function columns(value) {
    var parsed = typeof value === 'string' ? JSON.parse(value) : value;
    SalaryCalculator.Contracts.assertRules(parsed);
    return Object.assign({}, parsed);
  }
  var employeeRequired = ['employeeId', 'americanName', 'firstWorkingDay'];
  var attendanceRequired = ['employeeId', 'date', 'status'];
  function issue(mapping, kind, row, field, code, message, column) {
    return { code: code, message: message, field: field, spreadsheetId: kind === 'attendance' ? mapping.leaveSpreadsheetId : mapping.spreadsheetId,
      tab: mapping[kind + 'Tab'], row: row, column: column === undefined ? null : column };
  }
  function fail(issues) {
    var error = new Error(issues.map(function (item) { return item.code + ': ' + item.message + ' (' + item.tab + ' row ' + item.row + ', column ' + item.column + ')'; }).join('; '));
    error.issues = issues; throw error;
  }
  function validate(configs) {
    var errors = [], seen = Object.create(null);
    configs.forEach(function (config, index) {
      var row = index + 2;
      function add(field, message) { errors.push(issue(config, 'employee', row, field, 'INVALID_CONFIG', message)); }
      try { SalaryCalculator.Contracts.assertEmployee({ employeeId: 'validation', americanName: 'validation', department: config.department, firstWorkingDay: '2000-01-01' }); }
      catch (error) { add('department', 'Invalid department'); }
      if (seen[config.department]) add('department', 'Duplicate department configuration');
      seen[config.department] = true;
      ['spreadsheetId', 'leaveSpreadsheetId'].forEach(function (field) { try { spreadsheetId(config[field]); } catch (error) { add(field, error.message); } });
      if (config.dateFormat !== undefined && ['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY'].indexOf(config.dateFormat) === -1) add('dateFormat', 'Unsupported explicit date format');
      ['employee', 'attendance'].forEach(function (kind) {
        if (!text(config[kind + 'Tab'])) add(kind + 'Tab', 'Tab is required');
        var headerRow = config[kind + 'HeaderRow'];
        if (headerRow !== undefined && (!Number.isInteger(headerRow) || headerRow < 1)) add(kind + 'HeaderRow', 'Header row must be a positive integer');
        var mapped = config[kind + 'Columns'];
        if (!mapped || typeof mapped !== 'object' || Array.isArray(mapped)) { add(kind + 'Columns', 'Columns must be an object'); return; }
        (kind === 'employee' ? employeeRequired : attendanceRequired).forEach(function (field) { if (!text(mapped[field])) add(field, 'Required column mapping'); });
        var mappedHeaders = Object.create(null);
        Object.keys(mapped).forEach(function (field) {
          if (typeof mapped[field] !== 'string' || !mapped[field].trim()) add(field, 'Column header must be nonempty text');
          if (mappedHeaders[mapped[field]]) add(field, 'Source fields cannot share a header');
          mappedHeaders[mapped[field]] = true;
        });
      });
      if (config.approvalColumns !== undefined) {
        var approval = config.approvalColumns, seenApproval = Object.create(null);
        if (!approval || typeof approval !== 'object' || Array.isArray(approval)) add('approvalColumns', 'Approval columns must be an object');
        else Object.keys(approval).forEach(function (field) {
          var header = approval[field];
          if (typeof header !== 'string' || !header.trim() || seenApproval[header]) add(field, 'Approval columns require distinct nonempty headers');
          if (Object.keys(config.employeeColumns || {}).some(function (key) { return config.employeeColumns[key] === header; })) add(field, 'Approval column overlaps employee source column');
          seenApproval[header] = true;
        });
      }
      if (config.statusCodes !== undefined) {
        if (!config.statusCodes || typeof config.statusCodes !== 'object' || Array.isArray(config.statusCodes)) add('statusCodes', 'Status codes must be an object');
        else Object.keys(config.statusCodes).forEach(function (key) { if (['PRESENT', 'LEAVE', 'NS', 'OFF', 'HOLIDAY', 'ABSENT'].indexOf(config.statusCodes[key]) === -1) add('statusCodes', 'Invalid canonical attendance status'); });
      }
    });
    return { valid: !errors.length, errors: errors, warnings: [] };
  }
  function cells(row, mapping, kind) {
    var mapped = mapping[kind + 'Columns'], headers = row.headers || Object.keys(row), values = {}, positions = {}, errors = [];
    Object.keys(mapped).forEach(function (field) {
      var index = headers.indexOf(mapped[field]); positions[field] = index + 1;
      if (index === -1 || headers.filter(function (header) { return header === mapped[field]; }).length > 1) errors.push(issue(mapping, kind, mapping[kind + 'HeaderRow'] || 1, field, index === -1 ? 'MISSING_HEADER' : 'DUPLICATE_HEADER', 'Mapped header must occur exactly once: ' + mapped[field]));
      else values[field] = row.headers ? row.values[index] : row[mapped[field]];
    });
    if (errors.length) fail(errors);
    return { values: values, positions: positions, rowNumber: row.rowNumber || (mapping[kind + 'HeaderRow'] || 1) + 1 };
  }
  function parse(rows) {
    var input = rows;
    if (Array.isArray(rows[0])) {
      var headers = rows[0].map(text);
      input = rows.slice(1).filter(function (row) { return row.some(function (cell) { return text(cell); }); }).map(function (row) {
        var record = {}; headers.forEach(function (header, index) { record[header] = row[index]; }); return record;
      });
    }
    return input.map(function (row) {
      var config = Object.assign({}, row);
      config.department = text(row.department).toUpperCase();
      config.spreadsheetId = spreadsheetId(row.spreadsheetId);
      config.leaveSpreadsheetId = spreadsheetId(row.leaveSpreadsheetId);
      config.employeeColumns = columns(row.employeeColumns);
      config.attendanceColumns = columns(row.attendanceColumns);
      ['approvalColumns', 'statusCodes'].forEach(function (field) { if (text(row[field])) config[field] = columns(row[field]); else delete config[field]; });
      ['employeeHeaderRow', 'attendanceHeaderRow'].forEach(function (field) { config[field] = text(row[field]) ? Number(row[field]) : 1; });
      if (!text(row.dateFormat)) delete config.dateFormat;
      return config;
    });
  }
  function normalizeEmployee(row, mapping) {
    var record = { department: mapping.department, lastWorkingDay: null }, performance = {};
    var source = cells(row, mapping, 'employee');
    var errors = [];
    Object.keys(mapping.employeeColumns).forEach(function (field) {
      var value = source.values[field];
      function add(code, message) { errors.push(issue(mapping, 'employee', source.rowNumber, field, code, message, source.positions[field])); }
      if (['firstWorkingDay', 'lastWorkingDay', 'finalPayrollPaymentDate'].indexOf(field) !== -1) {
        if (text(value) || field === 'firstWorkingDay') {
          try { record[field] = date(value, mapping.dateFormat); } catch (error) { add('INVALID_DATE', error.message); }
        }
      } else if (['transfers', 'sales', 'activeCalls', 'conversionRate', 'annualLeaveBalance', 'manualDeduction'].indexOf(field) !== -1) {
        if (text(value)) {
          var number = typeof value === 'number' ? value : (/^\d+(?:\.\d+)?$/.test(text(value)) ? Number(text(value)) : NaN);
          if (!Number.isFinite(number) || number < 0) add('INVALID_NUMBER', 'Expected a finite nonnegative number');
          else if (['transfers', 'sales', 'activeCalls', 'conversionRate'].indexOf(field) !== -1) performance[field] = number;
          else record[field] = number;
        }
      } else if (text(value)) record[field] = text(value);
      else if (employeeRequired.indexOf(field) !== -1) add(field === 'employeeId' ? 'MISSING_EMPLOYEE_ID' : 'MISSING_VALUE', 'Required value is missing');
    });
    if (record.lastWorkingDay && record.lastWorkingDay < record.firstWorkingDay) errors.push(issue(mapping, 'employee', source.rowNumber, 'lastWorkingDay', 'INVALID_DATE', 'Last working day precedes first working day', source.positions.lastWorkingDay));
    if (errors.length) fail(errors);
    if (Object.keys(performance).length) record.performance = performance;
    return SalaryCalculator.Contracts.assertEmployee(record);
  }
  function date(value, format) {
    var result = text(value);
    if (format === 'DD/MM/YYYY' || format === 'MM/DD/YYYY') {
      var match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(result);
      if (match) result = match[3] + '-' + match[format === 'DD/MM/YYYY' ? 2 : 1] + '-' + match[format === 'DD/MM/YYYY' ? 1 : 2];
    }
    var parsed = new Date(result + 'T00:00:00.000Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new Error('Expected a valid date in ' + (format || 'YYYY-MM-DD'));
    return result;
  }
  function normalizeAttendance(rows, mapping, period) {
    date(period.startDate); date(period.endDate);
    if (period.endDate < period.startDate) throw new Error('Invalid period boundaries');
    var seen = Object.create(null), records = [], errors = [];
    rows.forEach(function (row, index) {
      var source = cells(row, mapping, 'attendance'), record = {};
      var rowNumber = row.rowNumber || (mapping.attendanceHeaderRow || 1) + index + 1;
      function add(field, code, message) { errors.push(issue(mapping, 'attendance', rowNumber, field, code, message, source.positions[field])); }
      record.employeeId = text(source.values.employeeId);
      if (!record.employeeId) add('employeeId', 'MISSING_EMPLOYEE_ID', 'Employee ID is required');
      try { record.date = date(source.values.date, mapping.dateFormat); } catch (error) { add('date', 'INVALID_DATE', error.message); }
      var status = text(source.values.status), codes = mapping.statusCodes || {};
      record.status = Object.prototype.hasOwnProperty.call(codes, status) ? codes[status] : status.toUpperCase();
      if (['PRESENT', 'LEAVE', 'NS', 'OFF', 'HOLIDAY', 'ABSENT'].indexOf(record.status) === -1) add('status', 'INVALID_STATUS', 'Unknown attendance status');
      var key = record.employeeId + '\u0000' + record.date;
      if (record.employeeId && record.date && seen[key]) add('employeeId', 'DUPLICATE_ATTENDANCE', 'Duplicate Employee ID and date');
      seen[key] = true;
      if (record.date >= period.startDate && record.date <= period.endDate) records.push(record);
    });
    if (errors.length) fail(errors);
    return records;
  }
  return { parse: parse, validate: validate, normalizeEmployee: normalizeEmployee, normalizeAttendance: normalizeAttendance };
})();
