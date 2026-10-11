/**
 * @typedef {Object} EmployeeRecord
 * @property {string} employeeId Required stable employee key.
 * @property {string} americanName
 * @property {'SURVEY'|'RESERVATIONS'|'SALES'|'TDS'|'MANAGEMENT'} department
 * @property {string} firstWorkingDay ISO YYYY-MM-DD.
 * @property {?string} [lastWorkingDay] ISO YYYY-MM-DD, inclusive.
 * @property {string} [realName]
 * @property {string} [role]
 * @property {{transfers:(number|undefined),sales:(number|undefined),activeCalls:(number|undefined),conversionRate:(number|undefined)}} [performance] Each metric is optional.
 */
/** @typedef {Object<string, *>} RulesRecord Open rules record. */
/** @typedef {Object<string, *>} DecisionSet Open decision record. */
SalaryCalculator.Contracts = (function () {
  function assertObject(value, label) {
    var prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
    if (!value || Array.isArray(value) || typeof value !== 'object' ||
        (prototype !== null && (Object.getPrototypeOf(prototype) !== null || prototype.constructor.name !== 'Object'))) {
      throw new Error(label + ' must be a plain object');
    }
  }
  function assertText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required');
  }
  function assertDate(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(label + ' must be an ISO date');
    var date = new Date(value + 'T00:00:00.000Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(label + ' must be a valid calendar date');
  }
  function assertEnum(value, enumeration, label) {
    if (Object.keys(enumeration).map(function (key) { return enumeration[key]; }).indexOf(value) === -1) throw new Error(label + ' is invalid');
  }
  function assertEmployee(record) {
    assertObject(record, 'employee');
    assertText(record.employeeId, 'employeeId');
    assertText(record.americanName, 'americanName');
    assertEnum(record.department, SalaryCalculator.Constants.DEPARTMENTS, 'department');
    assertDate(record.firstWorkingDay, 'firstWorkingDay');
    if (record.lastWorkingDay !== null && record.lastWorkingDay !== undefined) {
      assertDate(record.lastWorkingDay, 'lastWorkingDay');
      if (record.lastWorkingDay < record.firstWorkingDay) throw new Error('lastWorkingDay precedes firstWorkingDay');
    }
    if (record.performance !== undefined) {
      assertObject(record.performance, 'performance');
      ['transfers', 'sales', 'activeCalls', 'conversionRate'].forEach(function (field) {
        var value = record.performance[field];
        if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('performance.' + field + ' must be a finite nonnegative number');
      });
    }
    return record;
  }
  // Open records: only recognized top-level values are constrained; later tasks may add fields.
  function assertKnownValues(record, label) {
    Object.keys(record).forEach(function (key) {
      var value = record[key];
      var field = label + '.' + key;
      if (key === 'cutoffMode') assertEnum(value, SalaryCalculator.Constants.CUTOFF_MODES, field);
      if (key === 'state' || key === 'runState') assertEnum(value, SalaryCalculator.Constants.RUN_STATES, field);
    });
  }
  function assertOpenRecord(record, label) {
    assertObject(record, label);
    assertKnownValues(record, label);
    return record;
  }
  return {
    assertRun: function (run) {
      assertObject(run, 'run');
      assertKnownValues(run, 'run');
      ['runId', 'rulesVersion', 'createdBy', 'payrollMonth', 'cutoff'].forEach(function (key) { assertText(run[key], key); });
      if (!Number.isSafeInteger(run.version) || run.version < 1) throw new Error('version must be a positive integer');
      assertObject(run.sourceSnapshot, 'sourceSnapshot');
      assertObject(run.rulesSnapshot, 'rulesSnapshot');
      assertObject(run.rulesSnapshot.salaries, 'rulesSnapshot.salaries');
      assertObject(run.rulesSnapshot.commissions, 'rulesSnapshot.commissions');
      if (!Array.isArray(run.results) || !run.results.length) throw new Error('results are required');
      return run;
    },
    assertEmployee: assertEmployee,
    assertRules: function (rules) { return assertOpenRecord(rules, 'rules'); },
    assertDecisionSet: function (decisions) { return assertOpenRecord(decisions, 'decisions'); }
  };
})();
