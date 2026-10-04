/** Coordinates payroll source reads, calculation, audit evidence and the run lifecycle. */
SalaryCalculator.PayrollOrchestrator = (function () {
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function issue(code, message, department, details) {
    return Object.assign({ code: code, message: message, department: department || null }, details || {});
  }
  function create(dependencies) {
    dependencies = dependencies || {};
    var sourceGateway = dependencies.sourceGateway || SalaryCalculator.SpreadsheetGateway;
    var repository = dependencies.repository;
    function now() { return dependencies.clock ? dependencies.clock() : new Date().toISOString(); }
    function actor() { return dependencies.actor ? dependencies.actor() : 'unknown'; }
    function runId() {
      if (dependencies.createRunId) return dependencies.createRunId();
      var unique = typeof Utilities !== 'undefined' && Utilities.getUuid ? Utilities.getUuid() : String(now()).replace(/[^0-9]/g, '') + '-' + Math.random().toString(36).slice(2);
      return 'RUN-' + unique;
    }
    function unresolvedOcr(decisions) {
      var ocr = decisions && decisions.ocr || {};
      var attempts = ocr.attempts || [];
      return Number(ocr.unresolvedCount || 0) > 0 || attempts.some(function (attempt) {
        return (attempt.manualIssues || []).some(function (item) { return item.resolved !== true; }) ||
          (attempt.matches || []).some(function (item) { return item.confirmed !== true; });
      });
    }
    function validateRequest(request) {
      request = request || {};
      var errors = [], warnings = [], configs, period;
      if (!/^\d{4}-\d{2}$/.test(request.payrollMonth || '')) errors.push(issue('INVALID_PAYROLL_MONTH', 'Payroll month must use YYYY-MM.'));
      if (!Object.prototype.hasOwnProperty.call(SalaryCalculator.Constants.CUTOFF_MODES, request.cutoffMode)) errors.push(issue('INVALID_CUTOFF', 'Cutoff mode is invalid.'));
      if (!Array.isArray(request.departmentScope) || !request.departmentScope.length) errors.push(issue('INVALID_DEPARTMENT_SCOPE', 'Choose a department or All.'));
      if (errors.length) return { valid: false, errors: errors, warnings: warnings, employees: [], sourceSnapshot: {} };
      try {
        configs = dependencies.getConfigs ? dependencies.getConfigs() : [];
        if (!Array.isArray(configs) || !configs.length) {
          errors.push(issue('NO_SOURCE_MAPPINGS', 'Configure at least one department source before validating payroll.'));
          return { valid: false, errors: errors, warnings: warnings, employees: [], sourceSnapshot: {} };
        }
        var scope = request.departmentScope.indexOf('ALL') !== -1 ?
          Object.keys(SalaryCalculator.Constants.DEPARTMENTS).map(function (key) { return SalaryCalculator.Constants.DEPARTMENTS[key]; }) : request.departmentScope;
        var unique = [];
        scope.forEach(function (department) { if (unique.indexOf(department) === -1) unique.push(department); });
        var unknown = unique.filter(function (department) { return !configs.some(function (config) { return config.department === department; }); });
        unknown.forEach(function (department) { errors.push(issue('UNCONFIGURED_DEPARTMENT', 'No source mapping is configured.', department)); });
        if (dependencies.buildPeriod) period = dependencies.buildPeriod(request);
        else period = SalaryCalculator.PayrollPeriod.buildPeriod({ payrollMonth: request.payrollMonth, cutoffMode: request.cutoffMode,
          today: (request.today || now()).slice(0, 10) });
        var employees = [], inputs = [], sourceSnapshot = {}, sourceConfigs = [], attendanceByEmployee = Object.create(null), failed = Object.create(null);
        unique.forEach(function (department) {
          var config = configs.find(function (candidate) { return candidate.department === department; });
          if (!config) return;
          sourceConfigs.push(copy(config));
          try {
            var access = sourceGateway.validateAccess(config);
            if (!access || access.valid !== true) {
              (access && access.errors || [issue('SOURCE_ACCESS_ERROR', 'Source access validation failed.')]).forEach(function (item) { errors.push(Object.assign({}, item, { department: department })); });
              failed[department] = true; return;
            }
            var bundle = sourceGateway.readDepartment(config, period);
            sourceSnapshot[department] = { employeeRows: copy(bundle.employeeRows), attendanceRows: copy(bundle.attendanceRows),
              source: { spreadsheetId: config.spreadsheetId, leaveSpreadsheetId: config.leaveSpreadsheetId,
                employeeTab: config.employeeTab, attendanceTab: config.attendanceTab } };
            var deptEmployees = bundle.employeeRows.map(function (row) { return SalaryCalculator.MappingConfig.normalizeEmployee(row, config); });
            var ids = Object.create(null);
            deptEmployees.forEach(function (employee) {
              if (ids[employee.employeeId]) throw Object.assign(new Error('Employee ID occurs more than once'), { issues: [issue('DUPLICATE_EMPLOYEE_ID', 'Employee ID occurs more than once.', department, { employeeId: employee.employeeId })] });
              ids[employee.employeeId] = true;
            });
            var attendance = SalaryCalculator.MappingConfig.normalizeAttendance(bundle.attendanceRows, config, period);
            attendance.forEach(function (record) {
              if (!ids[record.employeeId]) throw Object.assign(new Error('Attendance Employee ID is absent from employee source'), { issues: [issue('UNMATCHED_EMPLOYEE_ID', 'Attendance Employee ID is absent from employee source.', department, { employeeId: record.employeeId })] });
            });
            deptEmployees.forEach(function (employee) {
              employees.push({ employeeId: employee.employeeId, americanName: employee.americanName, department: department });
              inputs.push(employee);
              attendanceByEmployee[employee.employeeId] = attendance.filter(function (record) { return record.employeeId === employee.employeeId; });
            });
          } catch (error) {
            failed[department] = true;
            (error.issues || [issue('SOURCE_ERROR', error.message || 'Unable to read department source.', department)]).forEach(function (item) {
              errors.push(Object.assign({}, item, { department: department }));
            });
          }
        });
        var decisionRequirements = [], benefitLedger = dependencies.getBenefitLedger ? dependencies.getBenefitLedger() : [];
        inputs.forEach(function (employee) {
          var employeeDecisions = request.decisions && request.decisions.employeeDecisions &&
            request.decisions.employeeDecisions[employee.employeeId] || {};
          var probationDecision = employeeDecisions.probation || {};
          var probation = SalaryCalculator.Eligibility.evaluateProbationPayment(employee,
            benefitLedger.filter(function (row) { return row.benefitKey; }),
            { asOfDate: period.endDate, approved: typeof probationDecision.approved === 'boolean' ? probationDecision.approved : undefined });
          if (probation.decisionRequired) decisionRequirements.push({ employeeId: employee.employeeId,
            americanName: employee.americanName, department: employee.department, decision: 'PROBATION',
            candidateDate: probation.candidateDate, message: probation.note });
        });
        return { valid: errors.length === 0, errors: errors, warnings: warnings, payrollMonth: request.payrollMonth,
          cutoffMode: request.cutoffMode, departmentScope: unique, period: period, employees: employees, inputs: inputs,
          attendanceByEmployee: attendanceByEmployee, sourceSnapshot: sourceSnapshot, sourceConfigs: sourceConfigs,
          failedDepartments: Object.keys(failed), runId: runId(), decisions: copy(request.decisions || {}),
          decisionRequirements: decisionRequirements, unresolvedDecisionCount: decisionRequirements.length };
      } catch (error) {
        errors.push(issue('VALIDATION_ERROR', error.message || 'Payroll validation failed.'));
        return { valid: false, errors: errors, warnings: warnings, employees: [], sourceSnapshot: {} };
      }
    }
    function calculateDraft(request) {
      var report = validateRequest(request);
      if (!report.valid) return { valid: false, state: 'BLOCKED', runId: report.runId || null, errors: report.errors, warnings: report.warnings || [] };
      var decisions = copy(request.decisions || report.decisions || {});
      if (report.decisionRequirements && report.decisionRequirements.length) {
        return { valid: false, state: 'BLOCKED', runId: request.runId || report.runId,
          errors: report.decisionRequirements.map(function (requirement) {
            return issue('DECISION_REQUIRED', requirement.message, requirement.department, { employeeId: requirement.employeeId, decision: requirement.decision });
          }), warnings: [] };
      }
      if (unresolvedOcr(decisions)) return { valid: false, state: 'BLOCKED', runId: report.runId,
        errors: [issue('OCR_UNRESOLVED', 'Resolve all ambiguous, unmatched, and unconfirmed OCR entries before drafting.')], warnings: [] };
      var rules = dependencies.getRules ? dependencies.getRules() : {};
      var ledger = dependencies.getBenefitLedger ? dependencies.getBenefitLedger() : [];
      var holidayWork = decisions.holidayWork || {}, selectedHolidayIds = (holidayWork.employeeIds || []).map(String);
      var selectedHoliday = null, holidayDates = [];
      if (holidayWork.applies === true) {
        var calendar = dependencies.getHolidayCalendar ? dependencies.getHolidayCalendar() : [];
        selectedHoliday = (calendar || []).find(function (holiday) {
          return String(holiday.holidayId || holiday.id || '') === String(holidayWork.holidayId || '');
        });
        if (!selectedHoliday) return { valid: false, state: 'BLOCKED', runId: report.runId,
          errors: [issue('HOLIDAY_REQUIRED', 'Choose a configured holiday before confirming holiday work.')], warnings: [] };
        holidayDates = selectedHoliday.actualHolidayDates || [];
        if (!Array.isArray(holidayDates) || !holidayDates.length || holidayDates.some(function (date) {
          return !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < report.period.startDate || date > report.period.endDate;
        })) return { valid: false, state: 'BLOCKED', runId: report.runId,
          errors: [issue('HOLIDAY_DATE_INVALID', 'The selected holiday has no valid actual dates inside this payroll period.')], warnings: [] };
        var validatedIds = Object.create(null);
        report.employees.forEach(function (employee) { validatedIds[employee.employeeId] = true; });
        if (selectedHolidayIds.some(function (employeeId) { return !validatedIds[employeeId]; })) {
          return { valid: false, state: 'BLOCKED', runId: report.runId,
            errors: [issue('HOLIDAY_EMPLOYEE_INVALID', 'Holiday work includes an employee outside the validated run.')], warnings: [] };
        }
        decisions.holidayWork.actualHolidayDates = holidayDates.slice();
      }
      var results = [], calculationErrors = [];
      report.inputs.forEach(function (employee) {
        try {
          var entries = report.attendanceByEmployee[employee.employeeId] || [];
          var attendance = { attendedScheduledDays: 0, leaveDays: 0, nsPresent: false, workedOffDays: [], workedHolidays: [] };
          entries.forEach(function (entry) {
            if (entry.status === 'PRESENT') attendance.attendedScheduledDays++;
            if (entry.status === 'LEAVE') attendance.leaveDays++;
            if (entry.status === 'NS') attendance.nsPresent = true;
            if (entry.status === 'OFF') attendance.workedOffDays.push(entry.date);
            if (entry.status === 'HOLIDAY') attendance.workedHolidays.push(entry.date);
          });
          if (holidayWork.applies === true && selectedHolidayIds.indexOf(employee.employeeId) !== -1) {
            holidayDates.forEach(function (date) { if (attendance.workedHolidays.indexOf(date) === -1) attendance.workedHolidays.push(date); });
          }
          var employeeDecisions = decisions.employeeDecisions && decisions.employeeDecisions[employee.employeeId] || decisions[employee.employeeId] || {};
          results.push(SalaryCalculator.PayrollEngine.calculateEmployee({ employee: employee, rules: rules, attendance: attendance,
            period: report.period, ledger: ledger, decisions: employeeDecisions }));
        } catch (error) {
          calculationErrors.push(issue('CALCULATION_ERROR', error.message || 'Employee calculation failed.', employee.department, { employeeId: employee.employeeId }));
        }
      });
      if (calculationErrors.length) return { valid: false, state: 'BLOCKED', runId: report.runId, errors: calculationErrors, warnings: [] };
      var id = request.runId || report.runId, timestamp = now(), auditEvidence = [];
      if (dependencies.auditStore && decisions.ocr && decisions.ocr.attempts && decisions.ocr.attempts.length) {
        try {
          auditEvidence = dependencies.auditStore.persistDecisions({ runId: id, actor: actor(), timestamp: timestamp,
            evidenceIds: (decisions.holidayWork && decisions.holidayWork.evidenceIds || []).slice(),
            attempts: decisions.ocr.attempts, confirmedEmployeeIds: (decisions.ocr.confirmedEmployeeIds || []).slice() }) || [];
        } catch (error) {
          return { valid: false, state: 'BLOCKED', runId: id,
            errors: [issue('OCR_AUDIT_PERSISTENCE_FAILED', 'OCR decision evidence could not be retained; payroll draft was not created.')], warnings: [] };
        }
      }
      var run = { runId: id, version: 1, state: 'DRAFT', payrollMonth: report.payrollMonth, cutoff: report.period.endDate,
        cutoffMode: report.cutoffMode, departmentScope: report.departmentScope, rulesVersion: dependencies.rulesVersion || 'unknown',
        createdBy: actor(), createdAt: timestamp, sourceSnapshot: report.sourceSnapshot, sourceConfigs: report.sourceConfigs,
        inputs: report.inputs, decisions: decisions, ocrAuditEvidence: auditEvidence, results: results,
        warnings: report.warnings, acknowledgements: request.acknowledgements || [] };
      try {
        return Object.assign({ valid: true, errors: [], blockingErrors: [] }, repository.createDraft(run));
      } catch (error) {
        return { valid: false, state: 'BLOCKED', runId: id,
          errors: error.issues || [issue('DRAFT_SAVE_FAILED', error.message || 'The draft could not be saved.')], warnings: [] };
      }
    }
    function approveRun(id, approver) {
      try {
        var run = repository.getRun(id);
        if (unresolvedOcr(run.decisions || {})) return { valid: false, state: run.state, runId: id,
          errors: [issue('OCR_UNRESOLVED', 'Resolve all ambiguous, unmatched, and unconfirmed OCR entries before approval.')] };
        return repository.approve(id, approver || actor());
      } catch (error) {
        return { valid: false, runId: id, errors: error.issues || [issue('APPROVAL_FAILED', error.message || 'Approval failed.')] };
      }
    }
    function saveOverride(request) {
      request = request || {};
      try { return repository.applyOverride(request.runId, request.employeeId, request.component, request.value, request.reason, actor()); }
      catch (error) { return { valid: false, errors: error.issues || [issue('OVERRIDE_FAILED', error.message || 'Override could not be saved.')] }; }
    }
    return { validateRequest: validateRequest, calculateDraft: calculateDraft, approveRun: approveRun, saveOverride: saveOverride };
  }
  return { create: create };
})();
