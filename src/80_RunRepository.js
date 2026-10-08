/** Audited run lifecycle. create({gateway, lockService, sourceGateway, now}) injects I/O.
 * Repository adapter: read(table,key)->record|null; upsert(table,key,record);
 * appendUnique(table,key,record); list(table)->records. Writes must be durable
 * before returning, JSON snapshots detached, and unique appends retry-safe.
 */
SalaryCalculator.RunRepository = (function () {
  var TABLES = { runs: 'Payroll Runs', history: 'Payroll History', benefits: 'Payment Ledger', latest: 'Latest Results' };
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function text(value, label) { if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required'); }
  function create(dependencies) {
    dependencies = dependencies || {};
    var adapter = dependencies.gateway, gateway = Object.create(adapter);
    gateway.upsert = function (table, key, value) {
      adapter.upsert(table, key, value);
      if (table === TABLES.runs && typeof adapter.projectRunAudit === 'function') adapter.projectRunAudit(copy(value));
    };
    function now() { return dependencies.now ? dependencies.now() : new Date().toISOString(); }
    function locked(action) {
      var lock = (dependencies.lockService || LockService).getDocumentLock();
      if (!lock) throw new Error('Document lock is unavailable');
      lock.waitLock(30000);
      try { return action(); } finally { lock.releaseLock(); }
    }
    function getRun(runId) {
      var run = gateway.read(TABLES.runs, runId);
      if (!run) throw new Error('Unknown run: ' + runId);
      return copy(run);
    }
    function hasFinalBenefit(result, type) {
      var componentName = type === 'PROBATION' ? 'probation' : 'referral';
      var component = result.components && result.components[componentName];
      if (!component || !(component.amount > 0)) return false;
      return (result.benefitCandidates || []).some(function (candidate) {
        if (!candidate || candidate.eligible !== true || typeof candidate.benefitKey !== 'string') return false;
        var parts = candidate.benefitKey.split(':');
        if (type === 'PROBATION') return candidate.benefitKey === 'PROBATION:' + result.employeeId;
        return parts.length === 3 && parts[0] === 'REFERRAL' && parts[1] === result.employeeId;
      });
    }
    function benefitKey(type, employeeId, relatedEmployeeId) {
      type = String(type || '').toUpperCase();
      text(employeeId, 'Employee ID');
      if (type === 'PROBATION') {
        if (relatedEmployeeId !== undefined) throw new Error('Probation benefit does not have a related employee');
        return 'PROBATION:' + employeeId;
      }
      if (type === 'REFERRAL') {
        text(relatedEmployeeId, 'Related employee ID');
        if (employeeId === relatedEmployeeId) throw new Error('Referral employees must be distinct');
        return 'REFERRAL:' + employeeId + ':' + relatedEmployeeId;
      }
      throw new Error('Unknown benefit type');
    }
    function sourceWrites(run, checkpoint) {
      if (checkpoint.sourceWrites) return copy(checkpoint.sourceWrites);
      var supported = ['runId', 'payrollMonth', 'approvedBy', 'approvedAt', 'paid', 'probationPaid', 'referralPaid', 'status'];
      var writes = [];
      (run.sourceConfigs || []).forEach(function (config) {
        var fields = Object.keys(config.approvalColumns || {}).filter(function (field) { return supported.indexOf(field) !== -1; });
        if (!fields.length) return;
        run.results.filter(function (result) { return result.department === config.department; }).forEach(function (result) {
          var values = {};
          fields.forEach(function (field) {
            if (field === 'runId') values[field] = run.runId;
            else if (field === 'payrollMonth') values[field] = run.payrollMonth;
            else if (field === 'approvedBy') values[field] = checkpoint.approvedBy;
            else if (field === 'approvedAt') values[field] = checkpoint.approvedAt;
            else if (field === 'status') values[field] = 'APPROVED';
            else if (field === 'paid' && result.salesAccrual && result.salesAccrual.paid === true && result.components.abs && result.components.abs.amount > 0) values[field] = true;
            else if (field === 'probationPaid' && hasFinalBenefit(result, 'PROBATION')) values[field] = true;
            else if (field === 'referralPaid' && hasFinalBenefit(result, 'REFERRAL')) values[field] = true;
          });
          writes.push({ employeeId: result.employeeId, values: values });
        });
      });
      checkpoint.sourceWrites = copy(writes);
      return writes;
    }
    function benefitRows(run) {
      var rows = [];
      run.results.forEach(function (result) {
        (result.benefitCandidates || []).forEach(function (candidate) {
          if (!candidate || candidate.eligible !== true || typeof candidate.benefitKey !== 'string' || !candidate.benefitKey.trim()) return;
          var key = candidate.benefitKey, parts = key.split(':'), expected = parts[0] === 'PROBATION' ? benefitKey('PROBATION', result.employeeId) :
            (parts[0] === 'REFERRAL' && parts.length === 3 ? benefitKey('REFERRAL', parts[1], parts[2]) : null);
          if (!expected || key !== expected) throw new Error('Invalid eligible benefit key: ' + key);
          if (typeof candidate.amount !== 'number' || !Number.isFinite(candidate.amount) || candidate.amount < 0) throw new Error('Invalid benefit amount');
          var finalAmount = parts[0] === 'PROBATION' ? result.components.probation.amount : result.components.referral.amount;
          if (!(finalAmount > 0)) return;
          rows.push({ benefitKey: key, type: parts[0], employeeId: result.employeeId,
            relatedEmployeeId: parts[0] === 'REFERRAL' ? parts[2] : null, amount: parts[0] === 'PROBATION' ? finalAmount : candidate.amount,
            payrollMonth: run.payrollMonth, runId: run.runId, paid: false });
        });
        var referralRows = rows.filter(function (row) { return row.employeeId === result.employeeId && row.type === 'REFERRAL'; });
        var referralAmount = result.components && result.components.referral && result.components.referral.amount || 0;
        if (referralAmount > 0 && (!referralRows.length || (referralRows.length > 1 &&
            SalaryCalculator.PayrollEngine.sumComponents({ value: referralRows.reduce(function (sum, row) { return sum + row.amount; }, 0) }) !== referralAmount))) {
          var ambiguous = new Error('Referral aggregate cannot be allocated to the eligible referred employees');
          ambiguous.issues = [{ code: 'AMBIGUOUS_LEDGER_AMOUNT', employeeId: result.employeeId, runId: run.runId }];
          throw ambiguous;
        }
        if (referralRows.length === 1) referralRows[0].amount = referralAmount;
      });
      return rows;
    }
    function settlementOwner(row) {
      if (!row) return null;
      if (typeof row.settlementRunId === 'string' && row.settlementRunId) return row.settlementRunId;
      var match = String(row.notes || '').match(/(?:^|;\s*)settlementRunId=([^;]+)/);
      return match ? match[1] : null;
    }
    function settlementMonths(row) {
      var match = String(row && row.notes || '').match(/(?:^|;\s*)reservedMonths=([^;]+)/);
      return match ? match[1].split(',').filter(Boolean) : [];
    }
    function settledByRun(row, runId) {
      return !!row && row.paid === true && settlementOwner(row) === runId;
    }
    function salesOwnershipConflict(row, key, run) {
      var conflict = new Error('Sales accrual is already owned by another settlement run');
      conflict.issues = [{ code: 'SALES_ACCRUAL_ALREADY_CLAIMED', benefitKey: key,
        runId: run.runId, existingRunId: settlementOwner(row) || row.runId }];
      return conflict;
    }
    function assertBenefitOwnership(run) {
      var ledger = gateway.list(TABLES.benefits) || [];
      benefitRows(run).forEach(function (row) {
        var existing = ledger.find(function (item) { return item.benefitKey === row.benefitKey; });
        if (existing && existing.runId !== run.runId) {
          var conflict = new Error('One-time benefit is already claimed by another approved run');
          conflict.issues = [{ code: 'BENEFIT_ALREADY_CLAIMED', benefitKey: row.benefitKey,
            runId: run.runId, existingRunId: existing.runId }];
          throw conflict;
        }
      });
      run.results.forEach(function (result) {
        var accrual = result.salesAccrual;
        if (!accrual) return;
        if (accrual.payrollMonth !== run.payrollMonth || typeof accrual.amount !== 'number' || !Number.isFinite(accrual.amount) ||
            accrual.amount < 0 || typeof accrual.paid !== 'boolean' || !Array.isArray(accrual.priorMonthsPaid)) throw new Error('Invalid Sales accrual record');
        var key = 'SALES_ABS:' + result.employeeId + ':' + accrual.payrollMonth;
        var monthly = ledger.find(function (item) { return item.benefitKey === key; });
        if (monthly && monthly.runId !== run.runId) {
          var occupied = new Error('Sales accrual month already belongs to another approved run');
          occupied.issues = [{ code: 'SALES_ACCRUAL_ALREADY_CLAIMED', benefitKey: key, runId: run.runId, existingRunId: monthly.runId }];
          throw occupied;
        }
        if (monthly && monthly.paid === true && !settledByRun(monthly, run.runId)) throw salesOwnershipConflict(monthly, key, run);
        if (!accrual.paid) return;
        var requestedMonths = accrual.priorMonthsPaid.concat([accrual.payrollMonth]);
        ledger.filter(function (row) { return row.type === 'SALES_ABS_SETTLEMENT' && row.employeeId === result.employeeId; }).forEach(function (claim) {
          var ownsRequestedMonth = settlementMonths(claim).some(function (month) { return requestedMonths.indexOf(month) !== -1; });
          if (ownsRequestedMonth && claim.runId !== run.runId) throw salesOwnershipConflict(claim, claim.benefitKey, run);
        });
        var prior = accrual.priorMonthsPaid.map(function (month) { return ledger.find(function (row) {
          return row.benefitKey === 'SALES_ABS:' + result.employeeId + ':' + month;
        }); });
        prior.forEach(function (row, index) {
          if (!row || row.type !== 'SALES_ABS') throw new Error('Sales settlement is missing a prior accrual');
          if (row.paid === true && !settledByRun(row, run.runId)) {
            throw salesOwnershipConflict(row, 'SALES_ABS:' + result.employeeId + ':' + accrual.priorMonthsPaid[index], run);
          }
        });
        var expected = accrual.amount + prior.reduce(function (sum, row) { return sum + row.amount; }, 0);
        if (!result.components || !result.components.abs || result.components.abs.amount !== expected) {
          var ambiguous = new Error('Sales settlement total cannot be allocated to its monthly accruals');
          ambiguous.issues = [{ code: 'AMBIGUOUS_LEDGER_AMOUNT', employeeId: result.employeeId, runId: run.runId }];
          throw ambiguous;
        }
        var settlementKey = 'SALES_ABS_SETTLEMENT:' + result.employeeId + ':' + accrual.payrollMonth;
        var settlement = ledger.find(function (row) { return row.benefitKey === settlementKey; });
        if (settlement && settlement.runId !== run.runId) throw salesOwnershipConflict(settlement, settlementKey, run);
      });
    }
    function appendBenefits(run) {
      benefitRows(run).forEach(function (row) {
        row.paymentDate = run.approvalCheckpoint.approvedAt;
        row.decision = 'APPROVED'; row.eligibility = 'APPROVED'; row.notes = 'Approved by ' + run.approvalCheckpoint.approvedBy;
        gateway.appendUnique(TABLES.benefits, row.benefitKey, row);
      });
      run.results.forEach(function (result) {
        var accrual = result.salesAccrual;
        if (!accrual) return;
        if (accrual.payrollMonth !== run.payrollMonth || typeof accrual.amount !== 'number' ||
            !Number.isFinite(accrual.amount) || accrual.amount < 0 || typeof accrual.paid !== 'boolean' ||
            !Array.isArray(accrual.priorMonthsPaid)) throw new Error('Invalid Sales accrual record');
        var key = 'SALES_ABS:' + result.employeeId + ':' + accrual.payrollMonth;
        var monthly = { benefitKey: key, type: 'SALES_ABS', employeeId: result.employeeId, relatedEmployeeId: null,
          amount: accrual.amount, payrollMonth: accrual.payrollMonth, runId: run.runId, paid: false,
          paymentDate: run.approvalCheckpoint.approvedAt, decision: 'ACCRUED', eligibility: 'APPROVED',
          notes: 'Approved by ' + run.approvalCheckpoint.approvedBy };
        var existing = gateway.read(TABLES.benefits, key);
        if (existing && existing.runId !== run.runId) {
          var conflict = new Error('Sales accrual month already belongs to another approved run');
          conflict.issues = [{ code: 'SALES_ACCRUAL_ALREADY_CLAIMED', benefitKey: key, runId: run.runId, existingRunId: existing.runId }];
          throw conflict;
        }
        gateway.appendUnique(TABLES.benefits, key, monthly);
        if (!accrual.paid) return;
        var priorKeys = accrual.priorMonthsPaid.map(function (month) { return 'SALES_ABS:' + result.employeeId + ':' + month; });
        var ledger = gateway.list(TABLES.benefits) || [], settlementRows = priorKeys.map(function (priorKey) {
          var row = ledger.find(function (item) { return item.benefitKey === priorKey; });
          if (!row || row.type !== 'SALES_ABS' || row.employeeId !== result.employeeId) throw new Error('Sales settlement is missing a prior accrual');
          if (row.paid === true && !settledByRun(row, run.runId)) throw salesOwnershipConflict(row, priorKey, run);
          return row;
        });
        var settlementAmount = accrual.amount + settlementRows.reduce(function (sum, row) { return sum + row.amount; }, 0);
        var total = result.components && result.components.abs && result.components.abs.amount;
        if (total !== settlementAmount) {
          var ambiguous = new Error('Sales settlement total cannot be allocated to its monthly accruals');
          ambiguous.issues = [{ code: 'AMBIGUOUS_LEDGER_AMOUNT', employeeId: result.employeeId, runId: run.runId }];
          throw ambiguous;
        }
        var settlementKey = 'SALES_ABS_SETTLEMENT:' + result.employeeId + ':' + accrual.payrollMonth;
        var reservedMonths = Array.from(new Set(accrual.priorMonthsPaid.concat([accrual.payrollMonth]))).sort();
        var reservation = { benefitKey: settlementKey, type: 'SALES_ABS_SETTLEMENT', employeeId: result.employeeId,
          relatedEmployeeId: null, amount: settlementAmount, payrollMonth: accrual.payrollMonth, runId: run.runId,
          paid: false, paymentDate: run.approvalCheckpoint.approvedAt, decision: 'RESERVED', eligibility: 'APPROVED',
          notes: 'Approved by ' + run.approvalCheckpoint.approvedBy + '; settlementRunId=' + run.runId +
            '; reservedMonths=' + reservedMonths.join(',') };
        var priorReservation = gateway.read(TABLES.benefits, settlementKey);
        if (priorReservation && priorReservation.runId !== run.runId) throw salesOwnershipConflict(priorReservation, settlementKey, run);
        if (!priorReservation) gateway.appendUnique(TABLES.benefits, settlementKey, reservation);
        [monthly].concat(settlementRows).forEach(function (row) {
          row.paid = true; row.paymentDate = run.approvalCheckpoint.approvedAt; row.decision = 'SETTLED';
          row.eligibility = 'APPROVED'; row.notes = 'Approved by ' + run.approvalCheckpoint.approvedBy + '; settlementRunId=' + run.runId;
          gateway.upsert(TABLES.benefits, row.benefitKey, row);
        });
        gateway.upsert(TABLES.benefits, settlementKey, { benefitKey: settlementKey, type: 'SALES_ABS_SETTLEMENT',
          employeeId: result.employeeId, relatedEmployeeId: null, amount: settlementAmount,
          payrollMonth: accrual.payrollMonth, runId: run.runId, paid: true, paymentDate: run.approvalCheckpoint.approvedAt,
          decision: 'SETTLED', eligibility: 'APPROVED', notes: reservation.notes });
      });
    }
    function finalizeBenefits(run) {
      var checkpoint = run.approvalCheckpoint;
      if (!checkpoint || checkpoint.benefitsFinalized === true) return;
      benefitRows(run).forEach(function (row) {
        var existing = gateway.read(TABLES.benefits, row.benefitKey);
        if (existing && existing.runId !== run.runId) {
          var conflict = new Error('One-time benefit is already claimed by another approved run');
          conflict.issues = [{ code: 'BENEFIT_ALREADY_CLAIMED', benefitKey: row.benefitKey,
            runId: run.runId, existingRunId: existing.runId }];
          throw conflict;
        }
        gateway.upsert(TABLES.benefits, row.benefitKey, Object.assign({}, existing || row, {
          paid: true, paymentDate: checkpoint.approvedAt, decision: 'PAID', eligibility: 'APPROVED',
          notes: 'Paid by ' + checkpoint.approvedBy
        }));
      });
      checkpoint.benefitsFinalized = true;
      gateway.upsert(TABLES.runs, run.runId, run);
    }
    function approvalResult(run) {
      return copy(run.approvalCheckpoint.result || { valid: true, state: 'APPROVED', runId: run.runId,
        approvedBy: run.approvedBy, approvedAt: run.approvedAt, writeBackStatus: run.writeBackStatus });
    }
    function writeSourceState(run) {
      var checkpoint = run.approvalCheckpoint, adapter = dependencies.sourceGateway || SalaryCalculator.SpreadsheetGateway;
      if (!checkpoint || !Array.isArray(checkpoint.sourceWrites)) throw new Error('Approval checkpoint has no saved source write set');
      (run.sourceConfigs || []).forEach(function (config) {
        var writes = checkpoint.sourceWrites.filter(function (write) {
          return write.values && Object.keys(write.values).length > 0 &&
            run.results.some(function (result) { return result.employeeId === write.employeeId && result.department === config.department; });
        });
        if (!writes.length) return;
        var outcome = adapter.writeApprovalState(config, writes);
        if (!outcome || outcome.valid !== true) {
          var error = new Error('Source approval write-back failed');
          error.issues = outcome && outcome.errors || [];
          throw error;
        }
      });
    }
    function failedWriteBack(run, error) {
      run.writeBackStatus = 'FAILED';
      run.approvalCheckpoint.lastWriteBackError = copy(error.issues || [{ code: 'WRITE_ERROR', message: error.message }]);
      gateway.upsert(TABLES.runs, run.runId, run);
      return { valid: false, resumable: true, state: run.state, runId: run.runId,
        writeBackStatus: 'FAILED', errors: copy(run.approvalCheckpoint.lastWriteBackError) };
    }
    function mayPublishLatest(run, employeeId) {
      var latest = gateway.read(TABLES.latest, employeeId);
      if (!latest || latest.runId === run.runId) return true;
      if (latest.payrollMonth && run.payrollMonth && latest.payrollMonth !== run.payrollMonth) return latest.payrollMonth < run.payrollMonth;
      var latestRun = latest.runId ? gateway.read(TABLES.runs, latest.runId) : null;
      var latestVersion = Number.isSafeInteger(latest.version) ? latest.version : latestRun && latestRun.version;
      if (Number.isSafeInteger(latestVersion) && Number.isSafeInteger(run.version) && latestVersion !== run.version) return latestVersion < run.version;
      var latestAt = latest.approvedAt || (latestRun && latestRun.approvedAt);
      if (typeof latestAt === 'string' && typeof run.approvedAt === 'string' && latestAt !== run.approvedAt) return latestAt < run.approvedAt;
      return false;
    }
    function publishLatest(run) {
      var status = run.approvalCheckpoint.latestWriteStatus || (run.approvalCheckpoint.latestWriteStatus = {});
      run.approvalCheckpoint.latestStatus = 'PENDING';
      gateway.upsert(TABLES.runs, run.runId, run);
      run.results.forEach(function (result) {
        if (mayPublishLatest(run, result.employeeId)) {
          gateway.upsert(TABLES.latest, result.employeeId, { runId: run.runId, version: run.version,
            payrollMonth: run.payrollMonth, state: 'APPROVED', result: result, approvedAt: run.approvedAt });
          status[result.employeeId] = 'PUBLISHED';
        } else status[result.employeeId] = 'SKIPPED_NEWER';
        // Comparing the persisted latest row makes an interrupted write safe to repeat.
        gateway.upsert(TABLES.runs, run.runId, run);
      });
      if (typeof gateway.renderLatestResults === 'function') gateway.renderLatestResults();
      run.approvalCheckpoint.latestStatus = 'COMPLETE';
      gateway.upsert(TABLES.runs, run.runId, run);
    }
    function approve(runId, approver) {
      text(approver, 'Approver');
      return locked(function () {
        var run = getRun(runId);
        assertDraftComplete(run);
        if (run.state === 'DRAFT') assertBenefitOwnership(run);
        if (run.state === 'SUPERSEDED') return approvalResult(run);
        if (run.state === 'APPROVED' && run.writeBackStatus === 'COMPLETE') {
          finalizeBenefits(run);
          if (run.approvalCheckpoint && run.approvalCheckpoint.latestStatus !== 'COMPLETE') publishLatest(run);
          return approvalResult(run);
        }
        if (run.state === 'APPROVED') {
          try {
            writeSourceState(run);
          } catch (error) {
            return failedWriteBack(run, error);
          }
          run.writeBackStatus = 'COMPLETE';
          run.approvalCheckpoint.result = { valid: true, state: 'APPROVED', runId: runId,
            approvedBy: run.approvedBy, approvedAt: run.approvedAt, writeBackStatus: 'COMPLETE' };
          gateway.upsert(TABLES.runs, runId, run);
          finalizeBenefits(run);
          return approvalResult(run);
        }
        if (run.state !== 'DRAFT') throw new Error('Only a draft can be approved');
        var resuming = !!run.approvalCheckpoint;
        if (!run.approvalCheckpoint) {
          run.approvalCheckpoint = { state: 'APPROVING', approvedBy: approver, approvedAt: now() };
          run.writeBackStatus = 'PENDING';
          sourceWrites(run, run.approvalCheckpoint);
          gateway.upsert(TABLES.runs, runId, run);
        }
        // Mark each durable prerequisite after its idempotent write so a retry
        // can repair a crash between the checkpoint and the external write-back.
        if (run.approvalCheckpoint.historyWritten !== true) {
          gateway.appendUnique(TABLES.history, runId + ':APPROVAL_CHECKPOINT', run);
          run.approvalCheckpoint.historyWritten = true;
          gateway.upsert(TABLES.runs, runId, run);
        }
        if (run.approvalCheckpoint.benefitsWritten !== true) {
          appendBenefits(run);
          run.approvalCheckpoint.benefitsWritten = true;
          gateway.upsert(TABLES.runs, runId, run);
        }
        // Persist the exact source write set before attempting external writes.
        gateway.upsert(TABLES.runs, runId, run);
        try {
          writeSourceState(run);
        } catch (error) {
          return failedWriteBack(run, error);
        }
        var checkpoint = run.approvalCheckpoint;
        run.writeBackStatus = 'COMPLETE';
        run.state = 'APPROVED';
        run.approvedBy = checkpoint.approvedBy;
        run.approvedAt = checkpoint.approvedAt;
        checkpoint.result = { valid: true, state: 'APPROVED', runId: runId,
          approvedBy: run.approvedBy, approvedAt: run.approvedAt, writeBackStatus: 'COMPLETE' };
        gateway.appendUnique(TABLES.history, runId + ':APPROVED', run);
        gateway.upsert(TABLES.runs, runId, run);
        finalizeBenefits(run);
        publishLatest(run);
        return approvalResult(run);
      });
    }
    function supersede(approvedRunId, replacementRunId) {
      return locked(function () {
        var oldRun = getRun(approvedRunId), replacement = getRun(replacementRunId);
        if (approvedRunId === replacementRunId) throw new Error('Replacement run must be different');
        if (oldRun.state !== 'APPROVED') throw new Error('Only an approved run can be superseded');
        if (replacement.state !== 'APPROVED') throw new Error('Replacement run must be approved');
        if (oldRun.payrollMonth !== replacement.payrollMonth) throw new Error('Replacement must cover the same payroll month');
        oldRun.state = 'SUPERSEDED'; oldRun.supersededBy = replacementRunId; oldRun.supersededAt = now();
        gateway.upsert(TABLES.runs, approvedRunId, oldRun);
        gateway.appendUnique(TABLES.history, approvedRunId + ':SUPERSEDED:' + replacementRunId, oldRun);
      });
    }
    function hasBenefit(key) {
      text(key, 'Benefit key');
      return gateway.list(TABLES.benefits).some(function (row) { return row.benefitKey === key; });
    }
    function listLatestResults() {
      var employeeIds = Object.create(null), runs = gateway.list(TABLES.runs) || [];
      runs.forEach(function (run) {
        (run && run.results || []).forEach(function (result) {
          if (result && result.employeeId) employeeIds[result.employeeId] = true;
        });
      });
      return Object.keys(employeeIds).sort().map(function (employeeId) {
        var latest = gateway.read(TABLES.latest, employeeId);
        if (!latest) return null;
        var run = latest.runId ? gateway.read(TABLES.runs, latest.runId) : null;
        return Object.assign({}, latest, { cutoff: run && run.cutoff || latest.cutoff || '',
          result: copy(latest.result) });
      }).filter(Boolean);
    }
    function comparableDraft(run) {
      var value = copy(run);
      ['state', 'createdAt', 'revision', 'overrides', 'draftCheckpoint'].forEach(function (field) { delete value[field]; });
      function stable(item) {
        if (Array.isArray(item)) return item.map(stable);
        if (!item || typeof item !== 'object') return item;
        var sorted = {};
        Object.keys(item).sort().forEach(function (key) { sorted[key] = stable(item[key]); });
        return sorted;
      }
      return JSON.stringify(stable(value));
    }
    function draftPersistenceError(runId, error) {
      var failure = new Error('Draft persistence is incomplete; retry the same run ID');
      failure.issues = [{ code: 'DRAFT_PERSISTENCE_INCOMPLETE', message: failure.message, runId: runId,
        resumable: true, cause: error.message || String(error) }];
      return failure;
    }
    function assertDraftComplete(run) {
      if (run.draftCheckpoint && run.draftCheckpoint.state !== 'COMPLETE') {
        throw draftPersistenceError(run.runId, new Error('Draft projection has not completed'));
      }
    }
    function createDraft(input) {
      var incoming = copy(SalaryCalculator.Contracts.assertRun(input));
      return locked(function () {
        var run = gateway.read(TABLES.runs, incoming.runId);
        if (run) {
          if (run.state !== 'DRAFT' || run.revision !== 1 || (run.overrides || []).length || run.approvalCheckpoint ||
              comparableDraft(run) !== comparableDraft(incoming)) {
            var conflict = new Error('Run ID already exists with a different or edited draft');
            conflict.issues = [{ code: 'RUN_ID_CONFLICT', message: conflict.message, runId: incoming.runId }];
            throw conflict;
          }
        } else {
          run = incoming;
          run.state = 'DRAFT'; run.revision = 1; run.createdAt = now(); run.overrides = [];
          run.draftCheckpoint = { state: 'PENDING' };
        }
        try {
          // Replaying both projections is safe after any interrupted write.
          gateway.upsert(TABLES.runs, run.runId, run);
          gateway.appendUnique(TABLES.history, run.runId + ':DRAFT:1', run);
          run.draftCheckpoint = { state: 'COMPLETE' };
          gateway.upsert(TABLES.runs, run.runId, run);
          return copy(run);
        } catch (error) {
          if (gateway.read(TABLES.runs, run.runId)) throw draftPersistenceError(run.runId, error);
          throw error;
        }
      });
    }
    function applyOverride(runId, employeeId, component, value, reason, editor) {
      text(reason, 'Override reason'); text(editor, 'Override editor');
      return locked(function () {
        var run = getRun(runId);
        assertDraftComplete(run);
        if (run.state !== 'DRAFT' || run.approvalCheckpoint) throw new Error('Run is frozen and cannot be edited');
        var result = run.results.find(function (row) { return row.employeeId === employeeId; });
        if (!result) throw new Error('Unknown employee');
        if (!Object.prototype.hasOwnProperty.call(result.components, component)) throw new Error('Unknown component');
        if (typeof value !== 'number' || !Number.isFinite(value) || (component === 'deductions' ? value > 0 : value < 0)) throw new Error('Invalid override amount');
        var item = result.components[component];
        var override = { runId: runId, employeeId: employeeId, component: component,
          originalValue: item.calculatedAmount, previousValue: item.amount,
          value: SalaryCalculator.PayrollEngine.sumComponents({ value: value }), reason: reason, editor: editor, timestamp: now() };
        item.amount = override.value; item.override = copy(override);
        result.total = SalaryCalculator.PayrollEngine.sumComponents(result.components);
        run.overrides.push(override); run.revision++;
        gateway.upsert(TABLES.runs, runId, run);
        gateway.appendUnique(TABLES.history, runId + ':DRAFT:' + run.revision, run);
        return copy(override);
      });
    }
    return { createDraft: createDraft, getRun: getRun, applyOverride: applyOverride,
      approve: approve, supersede: supersede, hasBenefit: hasBenefit,
      makeBenefitKey: benefitKey, listLatestResults: listLatestResults };
  }
  return { create: create };
})();
