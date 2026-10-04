/** Thin Apps Script entry points and the application wiring boundary. */
SalaryCalculator.MenuAndApi = (function () {
  var configuredApi = null;
  function issue(code, message) { return { code: code, message: message }; }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function normalizeHolidayDates(value, formatDate) {
    function normalize(date) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        var isoTime = Date.parse(date + 'T00:00:00.000Z');
        return Number.isFinite(isoTime) && new Date(isoTime).toISOString().slice(0, 10) === date ? date : '';
      }
      var match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date);
      if (!match) return '';
      var result = match[3] + '-' + match[2] + '-' + match[1], time = Date.parse(result + 'T00:00:00.000Z');
      return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === result ? result : '';
    }
    if (Object.prototype.toString.call(value) === '[object Date]') {
      var dateValue = formatDate ? formatDate(value) : value.toISOString().slice(0, 10);
      return normalize(String(dateValue)) ? [normalize(String(dateValue))] : [];
    }
    var source = String(value || ''), tokens = source.match(/\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4}/g) || [];
    var dates = tokens.map(normalize);
    if (dates.some(function (date) { return !date; })) return [];
    if (/\bto\b/i.test(source) && dates.length === 2) {
      var from = Date.parse(dates[0] + 'T00:00:00.000Z'), through = Date.parse(dates[1] + 'T00:00:00.000Z');
      if (through < from || (through - from) / 86400000 > 31) return [];
      dates = [];
      for (var timestamp = from; timestamp <= through; timestamp += 86400000) dates.push(new Date(timestamp).toISOString().slice(0, 10));
    }
    return dates.filter(function (date, index) { return dates.indexOf(date) === index; });
  }
  function create(dependencies) {
    dependencies = dependencies || {};
    var orchestrator = dependencies.orchestrator;
    var ocr = dependencies.ocrService || SalaryCalculator.OcrService;
    function clock() { return dependencies.clock ? dependencies.clock() : new Date().toISOString(); }
    function actor() { return dependencies.actor ? dependencies.actor() : 'unknown'; }
    function approverStatus(email) {
      if (dependencies.isApprover) return dependencies.isApprover(email) ? { valid: true } : { valid: false, code: 'APPROVER_NOT_AUTHORIZED' };
      var configured = dependencies.approverEmails || [];
      if (!configured.length) return { valid: false, code: 'APPROVER_CONFIGURATION_MISSING' };
      var normalized = String(email || '').trim().toLowerCase();
      return configured.some(function (item) { return String(item).trim().toLowerCase() === normalized; }) ?
        { valid: true } : { valid: false, code: 'APPROVER_NOT_AUTHORIZED' };
    }
    function persistAudit(value, runId) {
      if (typeof dependencies.makeAuditBlob !== 'function') throw new Error('Restricted OCR audit storage is unavailable');
      var blob = dependencies.makeAuditBlob(JSON.stringify(value), 'application/json', 'payroll-ocr-audit-' + runId + '.json');
      return ocr.storeEvidence(blob, runId, actor());
    }
    function employeesForRun(runId) {
      if (runId && dependencies.getEmployeesForRun) return dependencies.getEmployeesForRun(runId) || [];
      return dependencies.getEmployees ? dependencies.getEmployees() : [];
    }
    function guarded(action) {
      try { return action(); }
      catch (error) { return { valid: false, errors: error.issues || [issue(error.code || 'PAYROLL_ACTION_FAILED', error.message || 'Payroll action failed.')] }; }
    }
    function matchHolidayNames(request) {
      return guarded(function () {
        var text = typeof request === 'string' ? request : String(request && request.text || '');
        var runId = request && request.runId || (dependencies.getActiveRunId && dependencies.getActiveRunId()) || 'PENDING';
        var employees = employeesForRun(request && request.runId);
        if (request && request.runId && !employees.length) throw Object.assign(new Error('Validated employee list is unavailable for this run'), { code: 'VALIDATION_REQUIRED' });
        var report = ocr.matchAmericanNames(text, employees);
        var stored = persistAudit({ kind: 'PASTED_NAME_MATCH', runId: runId, sourceText: text,
          matchReport: report, uploader: actor(), timestamp: clock() }, runId);
        return Object.assign({}, report, { valid: true, evidenceId: stored.evidenceId,
          auditEvidenceId: stored.evidenceId, unresolvedCount: (report.ambiguous || []).length + (report.unmatched || []).length + (report.matches || []).length });
      });
    }
    function processHolidayScreenshot(request) {
      return guarded(function () {
        request = request || {};
        if (typeof request.runId !== 'string' || !request.runId.trim()) throw new Error('A validated payroll run ID is required');
        var employees = employeesForRun(request.runId);
        if (!employees.length) throw Object.assign(new Error('Validated employee list is unavailable for this run'), { code: 'VALIDATION_REQUIRED' });
        var match = /^data:([^;,]+)?;base64,([A-Za-z0-9+/=]+)$/.exec(request.imageData || '');
        var bytes = dependencies.decodeImage ? dependencies.decodeImage(request.imageData) :
          (match ? Utilities.base64Decode(match[2]) : null);
        if (!bytes) throw new Error('Screenshot data is invalid');
        var type = request.contentType || (match && match[1]) || 'application/octet-stream';
        var name = request.fileName || 'holiday-evidence';
        var blob = dependencies.makeImageBlob ? dependencies.makeImageBlob(bytes, type, name) : Utilities.newBlob(bytes, type, name);
        // The original binary is durably stored before the OCR service is called.
        var evidence = ocr.storeEvidence(blob, request.runId, actor());
        var extraction;
        try { extraction = ocr.extractText(blob); }
        catch (error) {
          var failedAudit = persistAudit({ kind: 'SCREENSHOT_OCR_FAILURE', runId: request.runId,
            evidenceId: evidence.evidenceId, uploader: actor(), timestamp: clock(),
            error: error.message || 'OCR failed.' }, request.runId);
          return { valid: false, evidence: evidence, auditEvidence: failedAudit,
            errors: [issue('OCR_FAILED', error.message || 'Screenshot was retained, but text extraction failed.')] };
        }
        var report = ocr.matchAmericanNames(extraction.text || '', employees);
        var audit = persistAudit({ kind: 'SCREENSHOT_OCR', runId: request.runId,
          evidenceId: evidence.evidenceId, extractedText: extraction.text || '', matchReport: report,
          uploader: actor(), timestamp: clock() }, request.runId);
      return { valid: true, evidence: evidence, auditEvidence: audit, matchReport: report,
          unresolvedCount: (report.ambiguous || []).length + (report.unmatched || []).length + (report.matches || []).length };
      });
    }
    function calculateDraft(request) {
      return guarded(function () {
        request = request || {};
        var result = orchestrator.calculateDraft(request);
        if (!result || result.valid === false) return result || { valid: false, errors: [issue('DRAFT_FAILED', 'The draft could not be calculated.')] };
        return { valid: true, runId: result.runId, state: result.state, payrollMonth: result.payrollMonth,
          cutoff: result.cutoff, results: result.results, errors: result.errors || [], blockingErrors: result.blockingErrors || [],
          warnings: result.warnings || [] };
      });
    }
    return {
      getRunSetup: function () {
        return guarded(function () {
          if (dependencies.getRunSetup) return dependencies.getRunSetup();
          return { valid: true, employees: dependencies.getEmployees ? dependencies.getEmployees() : [],
            holidays: dependencies.getHolidayCalendar ? dependencies.getHolidayCalendar() : [],
            payrollMonth: dependencies.previousPayrollMonth ? dependencies.previousPayrollMonth() : '' };
        });
      },
      validateRun: function (request) {
        return guarded(function () {
          var result = orchestrator.validateRequest(request);
          if (result.valid && result.runId && dependencies.saveValidationEmployees) {
            dependencies.saveValidationEmployees(result.runId, result.employees || []);
          }
          return { valid: result.valid, runId: result.runId, payrollMonth: result.payrollMonth,
            cutoff: result.period && result.period.endDate, employees: result.employees || [],
            errors: result.errors || [], warnings: result.warnings || [],
            unresolvedDecisionCount: result.unresolvedDecisionCount || 0,
            decisionRequirements: result.decisionRequirements || [] };
        });
      },
      calculateDraft: calculateDraft,
      saveOverride: function (request) { return orchestrator.saveOverride(request); },
      approveRun: function (runId) {
        var email = actor(), authorization = approverStatus(email);
        if (!authorization.valid) return { valid: false, runId: runId, errors: [issue(authorization.code,
          authorization.code === 'APPROVER_CONFIGURATION_MISSING' ? 'Configure PAYROLL_APPROVER_EMAILS in Script Properties before approval.' :
            'The current user is not in the configured payroll approver list.')] };
        return orchestrator.approveRun(runId, email);
      },
      matchHolidayNames: matchHolidayNames,
      processHolidayScreenshot: processHolidayScreenshot
    };
  }
  function appsScriptApi() {
    if (configuredApi) return configuredApi;
    if (typeof SpreadsheetApp === 'undefined') throw new Error('Payroll spreadsheet is unavailable');
    var book = SpreadsheetApp.getActiveSpreadsheet();
    if (!book) throw new Error('Open the Salary Calculator workbook first');
    var master = SalaryCalculator.SpreadsheetGateway.createMaster(), sheets = {};
    function sheet(name) {
      if (!sheets[name]) {
        sheets[name] = book.getSheetByName(name);
        if (!sheets[name]) throw new Error('Initialize/Repair Workbook before running payroll (missing ' + name + ' sheet)');
      }
      return sheets[name];
    }
    Object.keys(SalaryCalculator.WorkbookSetup.schema()).forEach(function (name) {
      sheets[name] = book.getSheetByName(name);
    });
    function readRows(name) {
      var target = sheet(name), last = target.getLastRow();
      return last ? target.getRange(1, 1, last, Math.max(1, target.getLastColumn())).getValues() : [];
    }
    function getConfigs() {
      var rows = readRows('Sources & Mappings');
      return SalaryCalculator.MappingConfig.parse(rows.slice(1).filter(function (row) { return String(row[0] || '').trim(); }).map(function (row) {
        return { department: row[0], spreadsheetId: row[1], leaveSpreadsheetId: row[2], employeeTab: row[3], attendanceTab: row[4],
          employeeHeaderRow: row[5], attendanceHeaderRow: row[6], employeeColumns: row[7], attendanceColumns: row[8], approvalColumns: row[9] };
      }));
    }
    function getRules() {
      var rules = { salaries: {} };
      readRows('Salary Rules').slice(1).forEach(function (row) {
        var type = String(row[0] || '').trim(), department = String(row[1] || '').trim(), key = String(row[2] || '').trim(), value = row[3];
        if (type === 'SALARY' && department && key) {
          var pieces = key.split('.');
          if (pieces.length !== 2) return;
          rules.salaries[department] = rules.salaries[department] || {};
          rules.salaries[department][pieces[0]] = rules.salaries[department][pieces[0]] || {};
          rules.salaries[department][pieces[0]][pieces[1]] = Number(value);
        }
        if (type === 'CYCLE' && department === 'SALES' && key === 'quarterly payment months' && String(value || '').trim()) {
          rules.salesQuarterlyPaymentMonths = String(value).split(',').map(function (month) { return Number(month.trim()); });
        }
      });
      return rules;
    }
    function holidayDates(value) {
      return normalizeHolidayDates(value, function (date) {
        return Utilities.formatDate(date, book.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
      });
    }
    function getHolidayCalendar() {
      return readRows('Holiday Calendar').slice(1).filter(function (row) { return String(row[0] || '').trim(); }).map(function (row, index) {
        var occasion = Object.prototype.toString.call(row[1]) === '[object Date]' ?
          Utilities.formatDate(row[1], book.getSpreadsheetTimeZone(), 'yyyy-MM-dd') : String(row[1] || '');
        return { holidayId: String(row[0]) + '|' + occasion, name: String(row[0]),
          actualHolidayDates: holidayDates(row[2]), status: String(row[5] || '') };
      });
    }
    function runRows() { return readRows('Payroll Runs').slice(1); }
    function savedRun(id) {
      var rows = runRows();
      var row = rows.reverse().find(function (item) { return item[0] === id; });
      return row && row[5] ? JSON.parse(row[5]) : null;
    }
    function paymentRows() {
      return readRows('Payment Ledger').slice(1).filter(function (row) { return String(row[0] || '').trim(); }).map(function (row) {
        return { benefitKey: row[0], type: row[1], employeeId: row[2], relatedEmployeeId: row[3], amount: Number(row[4]) || 0,
          payrollMonth: row[5], runId: row[6], paid: row[7] === true, paymentDate: row[8], decision: row[9], eligibility: row[10], notes: row[11] };
      });
    }
    function findByFirstColumn(name, key) {
      var values = readRows(name);
      for (var index = values.length - 1; index >= 1; index--) if (values[index][0] === key) return index + 1;
      return 0;
    }
    var storage = {
      read: function (table, key) {
        if (table === 'Payroll Runs') return savedRun(key);
        if (table === 'Payment Ledger') return paymentRows().find(function (item) { return item.benefitKey === key; }) || null;
        if (table === 'Latest Results') {
          var latest = null;
          runRows().forEach(function (row) {
            var run = row[5] && JSON.parse(row[5]);
            var result = run && run.state === 'APPROVED' && (run.results || []).find(function (item) { return item.employeeId === key; });
            var newer = result && (!latest || run.payrollMonth > latest.payrollMonth ||
              (run.payrollMonth === latest.payrollMonth && run.version > latest.version) ||
              (run.payrollMonth === latest.payrollMonth && run.version === latest.version && String(run.approvedAt || '') > String(latest.approvedAt || '')));
            if (newer) latest = { runId: run.runId, version: run.version, payrollMonth: run.payrollMonth,
              state: run.state, result: result, approvedAt: run.approvedAt };
          });
          return latest;
        }
        return null;
      },
      upsert: function (table, key, value) {
        if (table === 'Payroll Runs') {
          var target = sheet('Payroll Runs'), row = findByFirstColumn('Payroll Runs', key) || target.getLastRow() + 1;
          master.writeRows(target, row, 1, [[value.runId, value.version, value.state, value.payrollMonth, value.cutoff, JSON.stringify(value)]]);
        } else if (table === 'Payment Ledger') {
          var ledger = sheet('Payment Ledger'), rowIndex = findByFirstColumn('Payment Ledger', key) || ledger.getLastRow() + 1;
          master.writeRows(ledger, rowIndex, 1, [[value.benefitKey, value.type, value.employeeId, value.relatedEmployeeId || '',
            value.amount, value.payrollMonth, value.runId, value.paid === true, value.paymentDate || '', value.decision || '', value.eligibility || '', value.notes || '']]);
        } else if (table === 'Latest Results') {
          sheet('Latest Results');
          var run = savedRun(value.runId);
          if (run) SalaryCalculator.WorkbookSetup.renderLatestResults(sheets, run);
        }
      },
      appendUnique: function (table, key, value) {
        if (table === 'Payroll History') {
          sheet('Payroll History');
          sheet('Payroll Runs');
          SalaryCalculator.WorkbookSetup.appendHistory(sheets, value);
          return;
        }
        if (table === 'Payment Ledger' && !paymentRows().some(function (item) { return item.benefitKey === key; })) this.upsert(table, key, value);
      },
      list: function (table) {
        if (table === 'Payment Ledger') return paymentRows();
        if (table === 'Payroll Runs') return runRows().filter(function (row) { return row[5]; }).map(function (row) { return JSON.parse(row[5]); });
        return [];
      }
    };
    var sourceGateway = SalaryCalculator.SpreadsheetGateway.create();
    var auditStore = { persistDecisions: function (record) {
      var blob = Utilities.newBlob(JSON.stringify(record), 'application/json', 'payroll-ocr-decisions-' + record.runId + '.json');
      return [SalaryCalculator.OcrService.storeEvidence(blob, record.runId, record.actor)];
    } };
    var repository = SalaryCalculator.RunRepository.create({ gateway: storage, sourceGateway: sourceGateway,
      lockService: LockService, now: function () { return new Date().toISOString(); } });
    function getEmployees() {
      var period = SalaryCalculator.PayrollPeriod.buildPeriod({ payrollMonth: Utilities.formatDate(new Date(), book.getSpreadsheetTimeZone(), 'yyyy-MM'),
        cutoffMode: 'MONTH_END', today: Utilities.formatDate(new Date(), book.getSpreadsheetTimeZone(), 'yyyy-MM-dd') });
      return getConfigs().reduce(function (all, config) {
        var bundle = sourceGateway.readDepartment(config, period);
        return all.concat(bundle.employeeRows.map(function (row) { var employee = SalaryCalculator.MappingConfig.normalizeEmployee(row, config);
          return { employeeId: employee.employeeId, americanName: employee.americanName, department: employee.department }; }));
      }, []);
    }
    var orchestrator = SalaryCalculator.PayrollOrchestrator.create({ sourceGateway: sourceGateway, repository: repository,
      getConfigs: getConfigs, getRules: getRules, rulesVersion: 'configured', clock: function () { return new Date().toISOString(); },
      actor: function () { return Session.getActiveUser().getEmail() || 'unknown'; }, auditStore: auditStore,
      getHolidayCalendar: getHolidayCalendar,
      getBenefitLedger: function () { return storage.list('Payment Ledger'); } });
    var approverSetting = PropertiesService.getScriptProperties().getProperty('PAYROLL_APPROVER_EMAILS') || '';
    var approverEmails = approverSetting.split(/[,\n\r]+/).map(function (email) { return email.trim().toLowerCase(); }).filter(Boolean);
    var api = create({ orchestrator: orchestrator, ocrService: SalaryCalculator.OcrService, getEmployees: getEmployees,
      getHolidayCalendar: getHolidayCalendar,
      getEmployeesForRun: function (runId) {
        var cached = CacheService.getUserCache().get('PAYROLL_VALIDATION_' + runId);
        return cached ? JSON.parse(cached) : [];
      },
      saveValidationEmployees: function (runId, employees) {
        CacheService.getUserCache().put('PAYROLL_VALIDATION_' + runId, JSON.stringify(employees), 21600);
      },
      actor: function () { return Session.getActiveUser().getEmail() || 'unknown'; },
      approverEmails: approverEmails,
      makeAuditBlob: function (value, type, name) { return Utilities.newBlob(value, type, name); },
      makeImageBlob: function (bytes, type, name) { return Utilities.newBlob(bytes, type, name); } });
    api.configurationCheck = function () {
      var configs = getConfigs(), mapping = SalaryCalculator.MappingConfig.validate(configs), access = configs.map(function (config) {
        var result = sourceGateway.validateAccess(config); return { department: config.department, valid: result.valid, errors: result.errors };
      });
      return { valid: mapping.valid && access.every(function (item) { return item.valid; }), mapping: mapping, sources: access };
    };
    api.initializeWorkbook = function () { return SalaryCalculator.WorkbookSetup.initialize(book); };
    api.showLatestResults = function () { book.setActiveSheet(sheet('Latest Results')); };
    api.showPayrollSidebar = function () {
      var template = HtmlService.createTemplateFromFile('PayrollSidebar');
      SpreadsheetApp.getUi().showSidebar(template.evaluate().setTitle('Run payroll'));
    };
    api.openConfigurationCheck = function () {
      var result = api.configurationCheck();
      SpreadsheetApp.getUi().alert(result.valid ? 'Configuration is ready.' : 'Configuration has errors. Review Sources & Mappings.');
      return result;
    };
    return api;
  }
  function currentApi() { return configuredApi || appsScriptApi(); }
  function configure(dependencies) { configuredApi = create(dependencies); return configuredApi; }
  function reset() { configuredApi = null; }
  function addMenu() {
    SpreadsheetApp.getUi().createMenu('Salary Calculator')
      .addItem('Run Payroll', 'showPayrollSidebar')
      .addItem('Open Latest Results', 'openLatestResults')
      .addItem('Configuration Check', 'configurationCheck')
      .addItem('Initialize/Repair Workbook', 'initializeRepairWorkbook')
      .addToUi();
  }
  return { create: create, configure: configure, reset: reset, current: currentApi, addMenu: addMenu,
    normalizeHolidayDates: normalizeHolidayDates };
})();

function onOpen() { SalaryCalculator.MenuAndApi.addMenu(); }
function showPayrollSidebar() { return SalaryCalculator.MenuAndApi.current().showPayrollSidebar(); }
function getRunSetup() { return SalaryCalculator.MenuAndApi.current().getRunSetup(); }
function validateRun(request) { return SalaryCalculator.MenuAndApi.current().validateRun(request); }
function calculateDraft(request) { return SalaryCalculator.MenuAndApi.current().calculateDraft(request); }
function saveOverride(request) { return SalaryCalculator.MenuAndApi.current().saveOverride(request); }
function approveRun(runId) { return SalaryCalculator.MenuAndApi.current().approveRun(runId); }
function processHolidayScreenshot(request) { return SalaryCalculator.MenuAndApi.current().processHolidayScreenshot(request); }
function matchHolidayNames(text) { return SalaryCalculator.MenuAndApi.current().matchHolidayNames(text); }
function openLatestResults() { return SalaryCalculator.MenuAndApi.current().showLatestResults(); }
function configurationCheck() { return SalaryCalculator.MenuAndApi.current().openConfigurationCheck(); }
function initializeRepairWorkbook() { return SalaryCalculator.MenuAndApi.current().initializeWorkbook(); }
