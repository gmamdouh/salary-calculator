/** Coordinates payroll source reads, calculation, audit evidence and the run lifecycle. */
SalaryCalculator.PayrollOrchestrator = (function () {
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function issue(code, message, department, details) {
    return Object.assign({ code: code, message: message, department: department || null }, details || {});
  }
  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    var result = {};
    Object.keys(value).sort().forEach(function (key) {
      if (typeof value[key] !== 'undefined') result[key] = stableValue(value[key]);
    });
    return result;
  }
  function rulesVersion(snapshot) {
    var serialized = JSON.stringify(stableValue(snapshot));
    var hash = 2166136261;
    for (var index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 16777619) >>> 0;
    return 'rules-fnv1a32-' + ('00000000' + hash.toString(16)).slice(-8);
  }
  function partialDepartmentsFingerprint(failedDepartments, departmentErrors, failedEmployees, employeeErrors) {
    var departments = (failedDepartments || []).map(String).sort();
    var employees = (failedEmployees || []).map(stableValue).sort(function (left, right) {
      var a = JSON.stringify(left), b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    if (!departments.length && !employees.length) return null;
    var errors = (departmentErrors || []).map(stableValue).sort(function (left, right) {
      var a = JSON.stringify(left), b = JSON.stringify(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var report = { failedDepartments: departments, departmentErrors: errors };
    if (employees.length) {
      report.failedEmployees = employees;
      report.employeeErrors = (employeeErrors || []).map(stableValue).sort(function (left, right) {
        var a = JSON.stringify(left), b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      });
    }
    var serialized = JSON.stringify(report);
    var first = 2166136261, second = 2246822519;
    for (var index = 0; index < serialized.length; index++) {
      var code = serialized.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619) >>> 0;
      second = Math.imul(second ^ (code + index), 3266489917) >>> 0;
    }
    return 'partial-' + first.toString(16) + second.toString(16);
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
    function referralIdentityMapping(config) {
      var identityColumns = {};
      ['employeeId', 'americanName', 'firstWorkingDay', 'lastWorkingDay', 'finalPayrollPaymentDate', 'referrerEmployeeId'].forEach(function (field) {
        if (config.employeeColumns[field]) identityColumns[field] = config.employeeColumns[field];
      });
      return Object.assign({}, config, { employeeColumns: identityColumns });
    }
    function validateRequest(request) {
      request = request || {};
      var errors = [], warnings = [], configs, period, failed = Object.create(null);
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
        var unknown = unique.filter(function (department) { return !configs.some(function (config) { return String(config.department || '').trim().toUpperCase() === department; }); });
        unknown.forEach(function (department) {
          failed[department] = true;
          errors.push(issue('UNCONFIGURED_DEPARTMENT', 'No source mapping is configured.', department));
        });
        if (dependencies.buildPeriod) period = dependencies.buildPeriod(request);
        else period = SalaryCalculator.PayrollPeriod.buildPeriod({ payrollMonth: request.payrollMonth, cutoffMode: request.cutoffMode,
          today: (request.today || now()).slice(0, 10) });
        var employees = [], inputs = [], rosterIdentityInputs = [], referralIdentityIssues = [], sourceSnapshot = {}, sourceConfigs = [],
          attendanceByDepartment = Object.create(null), attendanceByEmployee = Object.create(null), deductionsByEmployee = Object.create(null);
        function collectReferralIdentity(row, config) {
          try { rosterIdentityInputs.push(SalaryCalculator.MappingConfig.normalizeEmployee(row, referralIdentityMapping(config))); }
          catch (identityError) {
            var referrerColumn = config.employeeColumns.referrerEmployeeId;
            var referrerIndex = referrerColumn ? row.headers.indexOf(referrerColumn) : -1;
            referralIdentityIssues.push({ sourceDepartment: config.department,
              referrerEmployeeId: referrerIndex < 0 ? '' : String(row.values[referrerIndex] || '').trim(),
              cause: identityError.message });
          }
        }
        var splitSourceReads = typeof sourceGateway.readEmployeeRoster === 'function' && typeof sourceGateway.readAttendanceRows === 'function';
        unique.forEach(function (department) {
          var config = configs.find(function (candidate) { return String(candidate.department || '').trim().toUpperCase() === department; });
          if (!config) return;
          try {
            try { config = SalaryCalculator.MappingConfig.parse([config])[0]; }
            catch (mappingError) {
              throw Object.assign(new Error(mappingError.message), { issues: [issue('INVALID_SOURCE_MAPPING', 'Source mapping could not be parsed: ' + mappingError.message, department)] });
            }
            sourceConfigs.push(copy(config));
            var access = sourceGateway.validateAccess(config, splitSourceReads ? 'employee' : undefined);
            if (!access || access.valid !== true) {
              (access && access.errors || [issue('SOURCE_ACCESS_ERROR', 'Source access validation failed.')]).forEach(function (item) { errors.push(Object.assign({}, item, { department: department })); });
              failed[department] = true; return;
            }
            var bundle = splitSourceReads ? null : sourceGateway.readDepartment(config, period);
            var employeeRows = splitSourceReads ? sourceGateway.readEmployeeRoster(config, period) : bundle.employeeRows;
            sourceSnapshot[department] = { employeeRows: copy(employeeRows), attendanceRows: bundle ? copy(bundle.attendanceRows) : [],
              source: { spreadsheetId: config.spreadsheetId, leaveSpreadsheetId: config.leaveSpreadsheetId,
                employeeTab: config.employeeTab, attendanceTab: config.attendanceTab } };
            employeeRows.forEach(function (row) { collectReferralIdentity(row, config); });
            var deptEmployees = employeeRows.map(function (row) { return SalaryCalculator.MappingConfig.normalizeEmployee(row, config); });
            var ids = Object.create(null), localDuplicateIssues = [];
            deptEmployees.forEach(function (employee) {
              if (ids[employee.employeeId]) localDuplicateIssues.push(issue('DUPLICATE_EMPLOYEE_ID', 'Employee ID occurs more than once.', department, { employeeId: employee.employeeId }));
              else ids[employee.employeeId] = true;
            });
            // Preserve the normalized roster before attendance validation so a later attendance
            // failure or local duplicate cannot hide IDs that collide with another department's roster.
            deptEmployees.forEach(function (employee) {
              employees.push({ employeeId: employee.employeeId, americanName: employee.americanName, department: department });
              inputs.push(employee);
            });
            if (localDuplicateIssues.length) throw Object.assign(new Error('Employee ID occurs more than once'), { issues: localDuplicateIssues });
            var attendanceRows = bundle ? bundle.attendanceRows : null;
            if (splitSourceReads) {
              access = sourceGateway.validateAccess(config, 'attendance');
              if (!access || access.valid !== true) {
                (access && access.errors || [issue('SOURCE_ACCESS_ERROR', 'Attendance source access validation failed.')]).forEach(function (item) { errors.push(Object.assign({}, item, { department: department })); });
                failed[department] = true; return;
              }
              attendanceRows = sourceGateway.readAttendanceRows(config, period);
              sourceSnapshot[department].attendanceRows = copy(attendanceRows);
            }
            var attendance = SalaryCalculator.MappingConfig.normalizeAttendance(attendanceRows, config, period);
            attendance.forEach(function (record) {
              if (!ids[record.employeeId]) throw Object.assign(new Error('Attendance Employee ID is absent from employee source'), { issues: [issue('UNMATCHED_EMPLOYEE_ID', 'Attendance Employee ID is absent from employee source.', department, { employeeId: record.employeeId })] });
            });
            var missingAttendance = deptEmployees.filter(function (employee) {
              var window = SalaryCalculator.PayrollPeriod.getEmploymentWindow(employee, period);
              return window && !attendance.some(function (record) {
                return record.employeeId === employee.employeeId && record.date >= window.startDate && record.date <= window.endDate;
              });
            }).map(function (employee) {
              return issue('MISSING_ATTENDANCE', 'No attendance or schedule evidence exists for this employed employee in the payroll period.',
                department, { employeeId: employee.employeeId });
            });
            if (missingAttendance.length) throw Object.assign(new Error('Missing attendance evidence'), { issues: missingAttendance });
            attendanceByDepartment[department] = attendance;
            if (config.deductionSpreadsheetId) {
              access = sourceGateway.validateAccess(config, 'deduction');
              if (!access || access.valid !== true) {
                (access && access.errors || [issue('SOURCE_ACCESS_ERROR', 'Deduction source access validation failed.')]).forEach(function (item) { errors.push(Object.assign({}, item, { department: department })); });
                failed[department] = true; return;
              }
              var deductionRows = sourceGateway.readDeductionRows(config);
              sourceSnapshot[department].deductionRows = copy(deductionRows);
              var deductions = SalaryCalculator.MappingConfig.normalizeDeductions(deductionRows, config, period);
              deductions.forEach(function (deduction) {
                if (!ids[deduction.employeeId]) throw Object.assign(new Error('Deduction Employee ID is absent from employee source'), {
                  issues: [issue('UNMATCHED_DEDUCTION_EMPLOYEE_ID', 'Deduction Employee ID is absent from employee source.', department,
                    { employeeId: deduction.employeeId, source: deduction.source })] });
                (deductionsByEmployee[deduction.employeeId] || (deductionsByEmployee[deduction.employeeId] = [])).push(deduction);
              });
            }
          } catch (error) {
            failed[department] = true;
            (error.issues || [issue('SOURCE_ERROR', error.message || 'Unable to read department source.', department)]).forEach(function (item) {
              errors.push(Object.assign({}, item, { department: department }));
            });
          }
        });
        var departmentsByEmployeeId = Object.create(null);
        inputs.forEach(function (employee) {
          var departments = departmentsByEmployeeId[employee.employeeId] || (departmentsByEmployeeId[employee.employeeId] = []);
          if (departments.indexOf(employee.department) === -1) departments.push(employee.department);
        });
        Object.keys(departmentsByEmployeeId).forEach(function (employeeId) {
          var departments = departmentsByEmployeeId[employeeId];
          if (departments.length < 2) return;
          departments.forEach(function (department) {
            failed[department] = true;
            errors.push(issue('CROSS_DEPARTMENT_EMPLOYEE_ID', 'Employee ID occurs in more than one department source.', department,
              { employeeId: employeeId, departments: departments.slice() }));
          });
        });
        inputs = inputs.filter(function (employee) { return !failed[employee.department]; });
        employees = employees.filter(function (employee) { return !failed[employee.department]; });
        sourceConfigs = sourceConfigs.filter(function (config) { return !failed[config.department]; });
        var acceptedEmployeeIds = Object.create(null);
        inputs.forEach(function (employee) { acceptedEmployeeIds[employee.employeeId] = true; });
        Object.keys(deductionsByEmployee).forEach(function (employeeId) {
          if (!acceptedEmployeeIds[employeeId]) delete deductionsByEmployee[employeeId];
        });
        inputs.forEach(function (employee) {
          attendanceByEmployee[employee.employeeId] = (attendanceByDepartment[employee.department] || []).filter(function (record) {
            return record.employeeId === employee.employeeId;
          });
        });

        // Referral relationships are roster facts, not client decisions. A scoped payroll still
        // needs the other departments' employee rosters, but never their attendance or performance.
        var referralInputs = rosterIdentityInputs.slice(), referralSourceSnapshot = {}, referralUnavailable = false;
        if (inputs.length) configs.forEach(function (rawConfig) {
          var sourceDepartment = String(rawConfig.department || '').trim().toUpperCase();
          if (unique.indexOf(sourceDepartment) !== -1) return;
          try {
            var referralConfig = SalaryCalculator.MappingConfig.parse([rawConfig])[0];
            var identityMapping = referralIdentityMapping(referralConfig);
            var access = sourceGateway.validateAccess(identityMapping, 'employee');
            if (!access || access.valid !== true) throw Object.assign(new Error('Employee roster access failed'), { issues: access && access.errors || [] });
            var rosterRows = typeof sourceGateway.readEmployeeRoster === 'function' ?
              sourceGateway.readEmployeeRoster(identityMapping, period) : sourceGateway.readDepartment(identityMapping, period).employeeRows;
            rosterRows.forEach(function (row) { collectReferralIdentity(row, referralConfig); });
            referralInputs = rosterIdentityInputs.slice();
            referralSourceSnapshot[sourceDepartment] = { employeeRows: copy(rosterRows),
              source: { spreadsheetId: referralConfig.spreadsheetId, employeeTab: referralConfig.employeeTab } };
          } catch (error) {
            referralUnavailable = true;
            inputs.forEach(function (employee) {
              errors.push(issue('REFERRAL_SOURCE_UNAVAILABLE', 'The referral directory cannot be verified from another department roster.',
                employee.department, { employeeId: employee.employeeId, sourceDepartment: sourceDepartment,
                  sourceIssues: error.issues || [], cause: error.message }));
            });
          }
        });
        var selectedById = Object.create(null), directoryById = Object.create(null), employeeErrors = [];
        inputs.forEach(function (employee) { selectedById[employee.employeeId] = employee; });
        referralIdentityIssues.forEach(function (problem) {
          var referrer = selectedById[problem.referrerEmployeeId];
          if (!referrer) return;
          var identityIssue = issue('REFERRAL_SOURCE_UNAVAILABLE', 'A referred employee identity cannot be verified.',
            referrer.department, { employeeId: referrer.employeeId,
              sourceDepartment: problem.sourceDepartment, cause: problem.cause });
          errors.push(identityIssue); employeeErrors.push(identityIssue);
        });
        referralInputs.forEach(function (employee) {
          (directoryById[employee.employeeId] || (directoryById[employee.employeeId] = [])).push(employee);
        });
        Object.keys(directoryById).forEach(function (employeeId) {
          var entries = directoryById[employeeId];
          if (entries.length < 2) return;
          entries.forEach(function (entry) {
            var referrer = selectedById[entry.referrerEmployeeId];
            if (!referrer) return;
            var collisionIssue = issue('REFERRAL_EMPLOYEE_ID_COLLISION', 'A referred Employee ID is duplicated in the referral directory.',
              referrer.department, { employeeId: referrer.employeeId, referredEmployeeId: employeeId });
            errors.push(collisionIssue); employeeErrors.push(collisionIssue);
          });
        });
        var failedEmployees = [], failedEmployeeIds = Object.create(null);
        employeeErrors.forEach(function (item) {
          if (failedEmployeeIds[item.employeeId]) return;
          failedEmployeeIds[item.employeeId] = true;
          failedEmployees.push({ department: item.department, employeeId: item.employeeId });
        });
        inputs = inputs.filter(function (employee) { return !failedEmployeeIds[employee.employeeId]; });
        employees = employees.filter(function (employee) { return !failedEmployeeIds[employee.employeeId]; });

        var decisionRequirements = [], benefitLedger = dependencies.getBenefitLedger ? dependencies.getBenefitLedger() : [];
        inputs.forEach(function (employee) {
          var employeeDecisions = request.decisions && request.decisions.employeeDecisions &&
            request.decisions.employeeDecisions[employee.employeeId] || {};
          var probationDecision = employeeDecisions.probation || {};
          var probation = SalaryCalculator.Eligibility.evaluateProbationPayment(employee,
            benefitLedger.filter(function (row) { return row.benefitKey; }),
            { asOfDate: period.endDate, approved: typeof probationDecision.approved === 'boolean' ? probationDecision.approved : undefined });
          if (probation.decisionRequired && SalaryCalculator.PayrollPeriod.getEmploymentWindow(employee, period)) decisionRequirements.push({ employeeId: employee.employeeId,
            americanName: employee.americanName, department: employee.department, decision: 'PROBATION',
            candidateDate: probation.candidateDate, message: probation.note });
        });
        var allMode = request.departmentScope.indexOf('ALL') !== -1;
        var failedDepartments = unique.filter(function (department) { return failed[department]; });
        var departmentErrors = errors.filter(function (item) { return employeeErrors.indexOf(item) === -1; });
        return { valid: !referralUnavailable && (departmentErrors.length === 0 || (allMode && inputs.length > 0)) &&
            (inputs.length > 0 || !failedEmployees.length), errors: errors, warnings: warnings, payrollMonth: request.payrollMonth,
          cutoffMode: request.cutoffMode, departmentScope: unique, period: period, employees: employees, inputs: inputs,
          attendanceByEmployee: attendanceByEmployee, deductionsByEmployee: deductionsByEmployee, sourceSnapshot: sourceSnapshot, sourceConfigs: sourceConfigs,
          referralInputs: referralInputs, referralSourceSnapshot: referralSourceSnapshot,
          failedDepartments: failedDepartments, departmentErrors: departmentErrors, failedEmployees: failedEmployees, employeeErrors: employeeErrors,
          partialDepartmentsFingerprint: partialDepartmentsFingerprint(failedDepartments, departmentErrors, failedEmployees, employeeErrors),
          runId: runId(), decisions: copy(request.decisions || {}),
          decisionRequirements: decisionRequirements, unresolvedDecisionCount: decisionRequirements.length };
      } catch (error) {
        errors.push(issue('VALIDATION_ERROR', error.message || 'Payroll validation failed.'));
        return { valid: false, errors: errors, warnings: warnings, employees: [], sourceSnapshot: {} };
      }
    }
    function calculateDraft(request) {
      var report = validateRequest(request);
      if (!report.valid || !report.inputs.length) return { valid: false, state: 'BLOCKED', runId: report.runId || null,
        errors: report.errors, warnings: report.warnings || [], failedEmployees: report.failedEmployees || [],
        employeeErrors: report.employeeErrors || [] };
      if ((report.failedDepartments.length || report.failedEmployees.length) && !(request.acknowledgements &&
          request.acknowledgements.partialDepartmentsFingerprint === report.partialDepartmentsFingerprint)) {
        return { valid: false, state: 'BLOCKED', runId: report.runId,
          errors: [issue('ACK_REQUIRED', 'The omission report changed or has not been acknowledged.')], warnings: [],
          failedDepartments: report.failedDepartments, departmentErrors: report.departmentErrors,
          failedEmployees: report.failedEmployees, employeeErrors: report.employeeErrors,
          partialDepartmentsFingerprint: report.partialDepartmentsFingerprint, employees: report.employees };
      }
      var decisions = copy(request.decisions || report.decisions || {});
      decisions.employeeDecisions = decisions.employeeDecisions || {};
      Object.keys(report.deductionsByEmployee || {}).forEach(function (employeeId) {
        var employeeDecisions = decisions.employeeDecisions[employeeId] || (decisions.employeeDecisions[employeeId] = {});
        employeeDecisions.deductions = (employeeDecisions.deductions || []).concat(report.deductionsByEmployee[employeeId].map(function (record) {
          return { amount: record.amount, reason: record.reason, source: record.source };
        }));
      });
      if (report.decisionRequirements && report.decisionRequirements.length) {
        return { valid: false, state: 'BLOCKED', runId: request.runId || report.runId,
          errors: report.decisionRequirements.map(function (requirement) {
            return issue('DECISION_REQUIRED', requirement.message, requirement.department, { employeeId: requirement.employeeId, decision: requirement.decision });
          }), warnings: [] };
      }
      if (unresolvedOcr(decisions)) return { valid: false, state: 'BLOCKED', runId: report.runId,
        errors: [issue('OCR_UNRESOLVED', 'Resolve all ambiguous, unmatched, and unconfirmed OCR entries before drafting.')], warnings: [] };
      var rules;
      try { rules = dependencies.getRules ? dependencies.getRules() : {}; }
      catch (error) { return { valid: false, state: 'BLOCKED', runId: report.runId,
        errors: error.issues || [issue('INVALID_RULES', error.message || 'Payroll rules are invalid.')], warnings: [] }; }
      var rulesSnapshot = copy(stableValue(rules));
      var ledger = dependencies.getBenefitLedger ? dependencies.getBenefitLedger() : [];
      var referralsByReferrer = Object.create(null), referralKeys = Object.create(null);
      var rosterById = Object.create(null);
      report.referralInputs.forEach(function (employee) { rosterById[employee.employeeId] = employee; });
      report.referralInputs.forEach(function (referred) {
        var referrerId = referred.referrerEmployeeId, referrer = rosterById[referrerId];
        if (!referrer || referrer.employeeId === referred.employeeId) return;
        var key = 'REFERRAL:' + referrerId + ':' + referred.employeeId;
        if (referralKeys[key]) return;
        referralKeys[key] = true;
        (referralsByReferrer[referrerId] || (referralsByReferrer[referrerId] = [])).push(referred);
      });
      var holidayWork = decisions.holidayWork || {}, holidaySelections = Object.create(null);
      var holidayDecisions = Array.isArray(holidayWork.dates) ? holidayWork.dates.slice() : [];
      var calendar = dependencies.getHolidayCalendar ? dependencies.getHolidayCalendar() : [];
      if (!holidayDecisions.length && holidayWork.applies === true) {
        var legacyHoliday = (calendar || []).find(function (holiday) {
          return String(holiday.holidayId || holiday.id || '') === String(holidayWork.holidayId || '');
        });
        if (!legacyHoliday) return { valid: false, state: 'BLOCKED', runId: report.runId,
          errors: [issue('HOLIDAY_REQUIRED', 'Choose a configured holiday before confirming holiday work.')], warnings: [] };
        if (!Array.isArray(legacyHoliday.actualHolidayDates) || legacyHoliday.actualHolidayDates.length !== 1)
          return { valid: false, state: 'BLOCKED', runId: report.runId,
            errors: [issue('HOLIDAY_DATE_AMBIGUOUS', 'Select employees separately for each actual holiday date.')], warnings: [] };
        holidayDecisions.push({ holidayId: holidayWork.holidayId, date: legacyHoliday.actualHolidayDates[0],
          applies: true, employeeIds: holidayWork.employeeIds || [] });
        decisions.holidayWork.actualHolidayDates = legacyHoliday.actualHolidayDates.slice();
      }
      var validatedIds = Object.create(null), seenHolidayDates = Object.create(null);
      report.employees.forEach(function (employee) { validatedIds[employee.employeeId] = true; });
      for (var holidayIndex = 0; holidayIndex < holidayDecisions.length; holidayIndex++) {
        var holidayDecision = holidayDecisions[holidayIndex], holiday = (calendar || []).find(function (item) {
          return String(item.holidayId || item.id || '') === String(holidayDecision.holidayId || '');
        });
        if (!holiday) return { valid: false, state: 'BLOCKED', runId: report.runId,
          errors: [issue('HOLIDAY_REQUIRED', 'Choose a configured holiday before confirming holiday work.')], warnings: [] };
        var selectedDate = holidayDecision.date;
        if (!Array.isArray(holiday.actualHolidayDates) || holiday.actualHolidayDates.indexOf(selectedDate) === -1 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate || '') || selectedDate < report.period.startDate || selectedDate > report.period.endDate ||
            seenHolidayDates[selectedDate]) return { valid: false, state: 'BLOCKED', runId: report.runId,
          errors: [issue('HOLIDAY_DATE_INVALID', 'Choose one configured actual holiday date per decision inside this payroll period.')], warnings: [] };
        seenHolidayDates[selectedDate] = true;
        if (holidayDecision.applies !== true) continue;
        var employeeIds = holidayDecision.employeeIds || [];
        if (!Array.isArray(employeeIds) || employeeIds.some(function (employeeId) { return !validatedIds[String(employeeId)]; }))
          return { valid: false, state: 'BLOCKED', runId: report.runId,
            errors: [issue('HOLIDAY_EMPLOYEE_INVALID', 'Holiday work includes an employee outside the validated run.')], warnings: [] };
        employeeIds.forEach(function (employeeId) {
          (holidaySelections[String(employeeId)] || (holidaySelections[String(employeeId)] = [])).push(selectedDate);
        });
      }
      var results = [], calculationErrors = [];
      report.inputs.forEach(function (employee) {
        try {
          var employmentWindow = SalaryCalculator.PayrollPeriod.getEmploymentWindow(employee, report.period);
          var entries = (report.attendanceByEmployee[employee.employeeId] || []).filter(function (entry) {
            return employmentWindow && entry.date >= employmentWindow.startDate && entry.date <= employmentWindow.endDate;
          });
          var attendance = { attendedScheduledDays: 0, leaveDays: 0, nsPresent: false, noShowDates: [], workedOffDays: [], workedHolidays: [] };
          entries.forEach(function (entry) {
            if (entry.status === 'PRESENT') attendance.attendedScheduledDays++;
            if (entry.status === 'LEAVE') attendance.leaveDays++;
            if (entry.status === 'NS') { attendance.nsPresent = true; attendance.noShowDates.push(entry.date); }
            if (entry.status === 'OFF') attendance.workedOffDays.push(entry.date);
          });
          attendance.noShowDates.sort();
          attendance.noShowDate = attendance.noShowDates[0] || null;
          attendance.workedHolidays = (holidaySelections[employee.employeeId] || []).slice();
          var employeeDecisions = decisions.employeeDecisions && decisions.employeeDecisions[employee.employeeId] || decisions[employee.employeeId] || {};
          if (!decisions.employeeDecisions[employee.employeeId]) decisions.employeeDecisions[employee.employeeId] = employeeDecisions;
          employeeDecisions.referrals = (referralsByReferrer[employee.employeeId] || []).slice();
          employeeDecisions.paymentDate = employee.lastWorkingDay && employee.finalPayrollPaymentDate ?
            employee.finalPayrollPaymentDate : report.period.endDate;
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
      var persistedAcknowledgements = copy(request.acknowledgements || {});
      var partialDepartmentsReport = report.failedDepartments.length || report.failedEmployees.length ? {
        failedDepartments: copy(report.failedDepartments), departmentErrors: copy(report.departmentErrors),
        failedEmployees: copy(report.failedEmployees), employeeErrors: copy(report.employeeErrors),
        fingerprint: report.partialDepartmentsFingerprint } : null;
      if (partialDepartmentsReport) {
        persistedAcknowledgements.partialDepartmentsFingerprint = report.partialDepartmentsFingerprint;
        persistedAcknowledgements.partialDepartmentsReport = partialDepartmentsReport;
      }
      var run = { runId: id, version: 1, state: 'DRAFT', payrollMonth: report.payrollMonth, cutoff: report.period.endDate,
        cutoffMode: report.cutoffMode, departmentScope: report.departmentScope, rulesVersion: rulesVersion(rulesSnapshot), rulesSnapshot: rulesSnapshot,
        createdBy: actor(), createdAt: timestamp, sourceSnapshot: report.sourceSnapshot, sourceConfigs: report.sourceConfigs,
        inputs: report.inputs, referralSourceSnapshot: report.referralSourceSnapshot, decisions: decisions, ocrAuditEvidence: auditEvidence, results: results,
        failedDepartments: report.failedDepartments || [], departmentErrors: report.departmentErrors || [],
        failedEmployees: report.failedEmployees || [], employeeErrors: report.employeeErrors || [],
        partialDepartmentsFingerprint: report.partialDepartmentsFingerprint || null,
        warnings: report.warnings, acknowledgements: persistedAcknowledgements };
      try {
        return Object.assign({ valid: true, errors: [], blockingErrors: [], failedDepartments: run.failedDepartments,
          departmentErrors: run.departmentErrors, failedEmployees: run.failedEmployees,
          employeeErrors: run.employeeErrors }, repository.createDraft(run));
      } catch (error) {
        return { valid: false, state: 'BLOCKED', runId: id,
          errors: error.issues || [issue('DRAFT_SAVE_FAILED', error.message || 'The draft could not be saved.')], warnings: [] };
      }
    }
    function approveRun(id, approver) {
      try {
        var run = repository.getRun(id);
        var omittedDepartmentsFingerprint = partialDepartmentsFingerprint(run.failedDepartments, run.departmentErrors,
          run.failedEmployees, run.employeeErrors);
        var savedAcknowledgement = run.acknowledgements || {}, savedReport = savedAcknowledgement.partialDepartmentsReport;
        if (((run.failedDepartments || []).length || (run.failedEmployees || []).length) && (!savedReport ||
            savedAcknowledgement.partialDepartmentsFingerprint !== omittedDepartmentsFingerprint ||
            run.partialDepartmentsFingerprint !== omittedDepartmentsFingerprint ||
            savedReport.fingerprint !== omittedDepartmentsFingerprint ||
            partialDepartmentsFingerprint(savedReport.failedDepartments, savedReport.departmentErrors,
              savedReport.failedEmployees, savedReport.employeeErrors) !== omittedDepartmentsFingerprint)) {
          return { valid: false, state: run.state, runId: id,
            errors: [issue('ACK_REQUIRED', 'This partial run has no matching saved acknowledgment of its omission report.') ] };
        }
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
