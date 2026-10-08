const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { runRecord, mappingConfig, employee } = require('./helpers/fixtures');
const plain = value => JSON.parse(JSON.stringify(value));
// Repository adapter: read(table,key), upsert(table,key,record),
// appendUnique(table,key,record), list(table); all records are JSON snapshots.
function harness() {
  const tables = new Map(), events = [];
  let held = false;
  const state = { failSource: false, failLatestOnce: false, onLock: null };
  const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const gateway = {
    read: (name, key) => table(name).has(key) ? plain(table(name).get(key)) : null,
    upsert(name, key, value) {
      events.push(['upsert', name, key]);
      if (name === 'Latest Results' && state.failLatestOnce) { state.failLatestOnce = false; throw new Error('Injected latest-result failure'); }
      table(name).set(key, plain(value));
    },
    appendUnique(name, key, value) { if (!table(name).has(key)) { events.push(['append', name, key]); table(name).set(key, plain(value)); } },
    list: name => [...table(name).values()].map(plain)
  };
  const lockService = { getDocumentLock() { return {
    waitLock() { if (held) throw new Error('Lock already held'); held = true; if (state.onLock) { const fn = state.onLock; state.onLock = null; fn(); } },
    releaseLock() { held = false; }
  }; } };
  const sourceGateway = { writeApprovalState(config, writes) {
    assert.equal(held, true);
    events.push(['source', config.department, plain(writes)]);
    return state.failSource ? { valid: false, partial: true, written: 1, errors: [{ code: 'WRITE_ERROR' }] } : { valid: true, written: writes.length, errors: [] };
  } };
  const { RunRepository } = loadAppsScript();
  const repository = RunRepository.create({ gateway, lockService, sourceGateway, now: () => '2026-10-04T10:00:00.000Z' });
  return { repository, gateway, sourceGateway, lockService, tables, events, state, isLocked: () => held };
}
function runWithoutOneTimeBenefits(overrides = {}) {
  const run = runRecord(overrides);
  run.results.forEach(result => {
    result.benefitCandidates = [];
    result.components.probation.amount = 0;
    result.components.probation.calculatedAmount = 0;
  });
  return run;
}
test('draft preserves rules, inputs and results independently of caller mutations', () => {
  const { repository, events } = harness();
  const input = runRecord(), draft = repository.createDraft(input);
  input.sourceSnapshot.employeeRows[0].values[0] = 'CHANGED';
  draft.results[0].components.basic.amount = 0;
  const stored = repository.getRun(input.runId);
  assert.equal(stored.state, 'DRAFT');
  assert.equal(stored.rulesVersion, 'rules-v1');
  assert.equal(stored.sourceSnapshot.employeeRows[0].values[0], 'EMP-001');
  assert.equal(stored.results[0].components.basic.amount, 15000);
  assert.equal(events.some(event => event[0] === 'source'), false);
});

test('identical draft retry resumes a transient audit projection failure without duplicate history', () => {
  const { repository, gateway } = harness();
  const input = runRecord(), projected = new Map();
  let failOnce = true;
  gateway.projectRunAudit = run => {
    if (failOnce) { failOnce = false; throw new Error('Audit tab unavailable'); }
    projected.set(run.runId, plain(run));
  };
  assert.throws(() => repository.createDraft(input), error => error.issues?.[0]?.code === 'DRAFT_PERSISTENCE_INCOMPLETE' && error.issues[0].resumable === true);
  assert.equal(gateway.read('Payroll Runs', input.runId).state, 'DRAFT');
  assert.equal(gateway.read('Payroll Runs', input.runId).draftCheckpoint.state, 'PENDING');
  assert.equal(gateway.list('Payroll History').length, 0);
  assert.throws(() => repository.applyOverride(input.runId, 'EMP-001', 'basic', 16000, 'Correction', 'editor'),
    error => error.issues?.[0]?.code === 'DRAFT_PERSISTENCE_INCOMPLETE');
  assert.throws(() => repository.approve(input.runId, 'approver'),
    error => error.issues?.[0]?.code === 'DRAFT_PERSISTENCE_INCOMPLETE');
  assert.throws(() => repository.createDraft(runRecord({ payrollMonth: '2026-08' })), error => error.issues?.[0]?.code === 'RUN_ID_CONFLICT');
  const resumed = repository.createDraft(input);
  assert.equal(resumed.runId, input.runId);
  assert.equal(resumed.state, 'DRAFT');
  assert.equal(resumed.draftCheckpoint.state, 'COMPLETE');
  assert.equal(gateway.list('Payroll History').length, 1);
  assert.equal(projected.size, 1);
  repository.createDraft(input);
  assert.equal(gateway.list('Payroll History').length, 1);
  assert.equal(projected.size, 1);
});

test('draft retry repairs transient history failure but rejects a conflicting payload', () => {
  const { repository, gateway } = harness();
  const input = runRecord(), append = gateway.appendUnique;
  let failOnce = true;
  gateway.appendUnique = function (...args) {
    if (failOnce && args[0] === 'Payroll History') { failOnce = false; throw new Error('History tab unavailable'); }
    return append.apply(this, args);
  };
  assert.throws(() => repository.createDraft(input), error => error.issues?.[0]?.code === 'DRAFT_PERSISTENCE_INCOMPLETE');
  assert.equal(gateway.list('Payroll History').length, 0);
  repository.createDraft(input);
  assert.equal(gateway.list('Payroll History').length, 1);
  const conflict = runRecord({ results: [{ ...input.results[0], total: 99999 }] });
  assert.throws(() => repository.createDraft(conflict), error => error.issues?.[0]?.code === 'RUN_ID_CONFLICT');
  assert.equal(gateway.list('Payroll History').length, 1);
});

test('OCR draft retry accepts regenerated evidence metadata but rejects changed decisions', () => {
  const { repository, gateway } = harness();
  const original = runRecord({ decisions: { ocr: { confirmedEmployeeIds: ['EMP-001'] } },
    ocrAuditEvidence: [{ evidenceId: 'FIRST', url: 'https://example.test/first', timestamp: '2026-10-04T10:00:00Z' }] });
  const append = gateway.appendUnique;
  let failOnce = true;
  gateway.appendUnique = function (...args) {
    if (failOnce && args[0] === 'Payroll History') { failOnce = false; throw new Error('History unavailable'); }
    return append.apply(this, args);
  };
  assert.throws(() => repository.createDraft(original), error => error.issues?.[0]?.code === 'DRAFT_PERSISTENCE_INCOMPLETE');
  const retry = runRecord({ decisions: { ocr: { confirmedEmployeeIds: ['EMP-001'] } },
    ocrAuditEvidence: [{ evidenceId: 'SECOND', url: 'https://example.test/second', timestamp: '2026-10-04T10:01:00Z' }] });
  assert.equal(repository.createDraft(retry).ocrAuditEvidence[0].evidenceId, 'FIRST');
  assert.equal(gateway.list('Payroll History').length, 1);
  const changed = runRecord({ decisions: { ocr: { confirmedEmployeeIds: ['EMP-002'] } },
    ocrAuditEvidence: retry.ocrAuditEvidence });
  assert.throws(() => repository.createDraft(changed), error => error.issues?.[0]?.code === 'RUN_ID_CONFLICT');
});
test('overrides require a reason and persist calculated, previous and edited amounts with audit identity', () => {
  const { repository } = harness();
  repository.createDraft(runRecord());
  assert.throws(() => repository.applyOverride('RUN-001', 'EMP-001', 'basic', 16000, '  ', 'editor'), /reason/i);
  const first = repository.applyOverride('RUN-001', 'EMP-001', 'basic', 16000, 'HR correction', 'editor');
  const second = repository.applyOverride('RUN-001', 'EMP-001', 'basic', 17000, 'Revised correction', 'editor');
  assert.equal(first.originalValue, 15000);
  assert.equal(first.value, 16000);
  assert.equal(second.originalValue, 15000);
  assert.equal(second.previousValue, 16000);
  const run = repository.getRun('RUN-001');
  assert.equal(run.results[0].total, 29000);
  assert.equal(run.results[0].components.basic.calculatedAmount, 15000);
  assert.equal(run.overrides.length, 2);
  assert.equal(run.overrides[0].editor, 'editor');
  assert.equal(run.overrides[0].timestamp, '2026-10-04T10:00:00.000Z');
  assert.throws(() => repository.applyOverride('RUN-001', 'EMP-001', 'total', 1, 'reason', 'editor'), /component/i);
  assert.throws(() => repository.applyOverride('RUN-001', 'EMP-001', 'basic', -1, 'reason', 'editor'), /amount/i);
});
test('approval is immutable and retry returns the same approval without duplicate history or benefits', () => {
  const { repository, gateway, events, isLocked } = harness();
  repository.createDraft(runRecord());
  const first = repository.approve('RUN-001', 'approver');
  const retry = repository.approve('RUN-001', 'another-approver');
  assert.deepEqual(plain(retry), plain(first));
  assert.equal(first.valid, true);
  assert.equal(first.state, 'APPROVED');
  assert.equal(repository.getRun('RUN-001').approvedBy, 'approver');
  assert.throws(() => repository.applyOverride('RUN-001', 'EMP-001', 'basic', 1, 'reason', 'editor'), /frozen/i);
  assert.equal(gateway.list('Payroll History').filter(run => run.state === 'APPROVED').length, 1);
  assert.equal(gateway.list('Payment Ledger').length, 1);
  assert.equal(repository.hasBenefit('PROBATION:EMP-001'), true);
  assert.equal(repository.hasBenefit('PROBATION:EMP-002'), false);
  assert.equal(repository.makeBenefitKey('PROBATION', 'EMP-001'), 'PROBATION:EMP-001');
  assert.equal(repository.makeBenefitKey('REFERRAL', 'EMP-001', 'EMP-002'), 'REFERRAL:EMP-001:EMP-002');
  assert.notEqual(repository.makeBenefitKey('REFERRAL', 'EMP-002', 'EMP-001'), repository.makeBenefitKey('REFERRAL', 'EMP-001', 'EMP-002'));
  assert.equal(events.filter(event => event[0] === 'source').length, 1);
  const sourceIndex = events.findIndex(event => event[0] === 'source');
  assert.ok(events.findIndex(event => event[0] === 'append' && event[1] === 'Payment Ledger') < sourceIndex);
  assert.equal(isLocked(), false);
});
test('completed approval finalizes probation and referral ledger rows idempotently after a partial payment write', () => {
  const { repository, gateway } = harness();
  const result = runRecord().results[0];
  result.benefitCandidates.push({ eligible: true, amount: 5000, benefitKey: 'REFERRAL:EMP-001:EMP-002' });
  result.components.referral = { calculatedAmount: 5000, amount: 5000 };
  result.total += 5000;
  repository.createDraft(runRecord({ results: [result] }));
  const upsert = gateway.upsert;
  let failAfterDurablePayment = true;
  gateway.upsert = function (table, key, value) {
    const saved = upsert.apply(this, arguments);
    if (failAfterDurablePayment && table === 'Payment Ledger' && value.paid === true) {
      failAfterDurablePayment = false;
      throw new Error('Failure after first paid row was durable');
    }
    return saved;
  };
  assert.throws(() => repository.approve('RUN-001', 'approver'), /first paid row/);
  gateway.upsert = upsert;
  assert.equal(gateway.read('Payment Ledger', 'PROBATION:EMP-001').paid, true);
  assert.equal(gateway.read('Payment Ledger', 'REFERRAL:EMP-001:EMP-002').paid, false);

  assert.equal(repository.approve('RUN-001', 'retry-approver').valid, true);
  const probation = gateway.read('Payment Ledger', 'PROBATION:EMP-001');
  const referral = gateway.read('Payment Ledger', 'REFERRAL:EMP-001:EMP-002');
  for (const row of [probation, referral]) {
    assert.equal(row.paid, true);
    assert.equal(row.paymentDate, '2026-10-04T10:00:00.000Z');
    assert.equal(row.decision, 'PAID');
    assert.equal(row.eligibility, 'APPROVED');
    assert.equal(row.notes, 'Paid by approver');
  }
  assert.equal(gateway.list('Payment Ledger').length, 2);
  assert.equal(repository.getRun('RUN-001').approvalCheckpoint.benefitsFinalized, true);
});
test('one-time benefit ownership is claimed by the first approved draft and conflicts have no side effects', () => {
  const { repository, gateway, events } = harness();
  repository.createDraft(runRecord());
  repository.createDraft(runRecord({ runId: 'RUN-002', version: 2 }));
  repository.applyOverride('RUN-001', 'EMP-001', 'probation', 9000, 'Final approved amount', 'editor');
  repository.approve('RUN-001', 'approver-one');
  const before = events.length;
  assert.throws(() => repository.approve('RUN-002', 'approver-two'), error =>
    error.issues?.[0]?.code === 'BENEFIT_ALREADY_CLAIMED' && error.issues[0].benefitKey === 'PROBATION:EMP-001');
  assert.equal(repository.getRun('RUN-002').state, 'DRAFT');
  assert.equal(gateway.read('Payment Ledger', 'PROBATION:EMP-001').runId, 'RUN-001');
  assert.equal(events.length, before);
  const firstRetry = repository.approve('RUN-001', 'retry-approver');
  const secondRetry = repository.approve('RUN-001', 'approver-one');
  assert.deepEqual(plain(secondRetry), plain(firstRetry));
  assert.equal(gateway.list('Payment Ledger').length, 1);
  const benefitRow = gateway.read('Payment Ledger', 'PROBATION:EMP-001');
  assert.equal(benefitRow.amount, 9000);
  assert.equal(benefitRow.runId, 'RUN-001');
  assert.equal(benefitRow.paid, true);
  assert.equal(benefitRow.paymentDate, '2026-10-04T10:00:00.000Z');
  assert.equal(benefitRow.decision, 'PAID');
  assert.equal(benefitRow.eligibility, 'APPROVED');
  assert.equal(benefitRow.notes, 'Paid by approver-one');
});
test('approval retry rechecks benefit ownership after a checkpointed ledger write failure', () => {
  const { repository, gateway } = harness();
  const firstRun = runRecord();
  repository.createDraft(firstRun);
  let failBeforeWrite = true;
  const appendUnique = gateway.appendUnique;
  gateway.appendUnique = function (table, key, value) {
    if (failBeforeWrite && table === 'Payment Ledger') {
      failBeforeWrite = false;
      throw new Error('Ledger unavailable before first durable append');
    }
    return appendUnique.apply(this, arguments);
  };
  assert.throws(() => repository.approve(firstRun.runId, 'approver-a'), /Ledger unavailable/);
  gateway.appendUnique = appendUnique;
  assert.equal(repository.getRun(firstRun.runId).approvalCheckpoint.benefitsWritten, undefined);

  repository.createDraft(runRecord({ runId: 'RUN-B', version: 2 }));
  repository.approve('RUN-B', 'approver-b');
  assert.throws(() => repository.approve(firstRun.runId, 'approver-a'), error =>
    error.issues?.[0]?.code === 'BENEFIT_ALREADY_CLAIMED' && error.issues[0].existingRunId === 'RUN-B');
  assert.equal(repository.getRun(firstRun.runId).state, 'DRAFT');
  assert.equal(gateway.read('Payment Ledger', 'PROBATION:EMP-001').runId, 'RUN-B');
});
test('sales accrual months settle once with the approved cumulative amount and approval metadata', () => {
  const { repository, gateway } = harness();
  const salesRun = (runId, payrollMonth, amount, paid, priorMonthsPaid = [], absAmount = amount) => {
    const record = runRecord({ runId, payrollMonth, results: [{ employeeId: 'EMP-SALES', department: 'SALES', payrollMonth,
      components: { basic: { calculatedAmount: 16000, amount: 16000 }, abs: { calculatedAmount: absAmount, amount: paid ? absAmount : 0 },
        probation: { calculatedAmount: 0, amount: 0 }, referral: { calculatedAmount: 0, amount: 0 } },
      total: 16000 + (paid ? absAmount : 0), benefitCandidates: [],
      salesAccrual: { payrollMonth, amount, paid, priorMonthsPaid } }] });
    return record;
  };
  repository.createDraft(salesRun('RUN-JUL', '2026-07', 3000, false));
  repository.approve('RUN-JUL', 'approver');
  repository.createDraft(salesRun('RUN-AUG', '2026-08', 4000, false));
  repository.approve('RUN-AUG', 'approver');
  repository.createDraft(salesRun('RUN-SEP', '2026-09', 5000, true, ['2026-07', '2026-08'], 12000));
  repository.approve('RUN-SEP', 'quarter-approver');
  repository.approve('RUN-SEP', 'retry-approver');
  const rows = gateway.list('Payment Ledger');
  assert.equal(rows.filter(row => row.type === 'SALES_ABS').length, 3);
  assert.equal(rows.find(row => row.benefitKey === 'SALES_ABS:EMP-SALES:2026-07').paid, true);
  assert.equal(rows.find(row => row.benefitKey === 'SALES_ABS:EMP-SALES:2026-08').paid, true);
  assert.equal(rows.find(row => row.benefitKey === 'SALES_ABS:EMP-SALES:2026-09').paid, true);
  const settlement = rows.find(row => row.type === 'SALES_ABS_SETTLEMENT');
  assert.equal(settlement.amount, 12000);
  assert.equal(settlement.runId, 'RUN-SEP');
  assert.equal(settlement.notes, 'Approved by quarter-approver; settlementRunId=RUN-SEP; reservedMonths=2026-07,2026-08,2026-09');
  assert.equal(settlement.paymentDate, '2026-10-04T10:00:00.000Z');
  assert.equal(settlement.eligibility, 'APPROVED');
  assert.equal(settlement.decision, 'SETTLED');
  assert.equal(rows.filter(row => row.type === 'SALES_ABS_SETTLEMENT').length, 1);
});
test('interrupted Sales settlement reserves every input month and blocks a competitor selecting only unpaid months', () => {
  const { repository, gateway, events } = harness();
  const salesRun = (runId, payrollMonth, amount, paid, priorMonthsPaid = [], absAmount = amount) => runRecord({ runId, payrollMonth,
    results: [{ employeeId: 'EMP-SALES', department: 'SALES', payrollMonth,
      components: { basic: { calculatedAmount: 16000, amount: 16000 }, abs: { calculatedAmount: absAmount, amount: paid ? absAmount : 0 },
        probation: { calculatedAmount: 0, amount: 0 }, referral: { calculatedAmount: 0, amount: 0 } },
      total: 16000 + (paid ? absAmount : 0), benefitCandidates: [],
      salesAccrual: { payrollMonth, amount, paid, priorMonthsPaid } }] });
  repository.createDraft(salesRun('RUN-JUL', '2026-07', 3000, false));
  repository.approve('RUN-JUL', 'approver');
  repository.createDraft(salesRun('RUN-AUG', '2026-08', 4000, false));
  repository.approve('RUN-AUG', 'approver');
  repository.createDraft(salesRun('RUN-SEP', '2026-09', 5000, true, ['2026-07', '2026-08'], 12000));
  const upsert = gateway.upsert;
  let failAfterJulySettlement = true;
  gateway.upsert = function (table, key, value) {
    const result = upsert.apply(this, arguments);
    if (failAfterJulySettlement && table === 'Payment Ledger' && key === 'SALES_ABS:EMP-SALES:2026-07' && value.paid === true) {
      failAfterJulySettlement = false;
      throw new Error('Failure after July settlement was durable');
    }
    return result;
  };
  assert.throws(() => repository.approve('RUN-SEP', 'settlement-approver'), /Failure after July/);
  gateway.upsert = upsert;
  assert.equal(gateway.read('Payment Ledger', 'SALES_ABS:EMP-SALES:2026-07').paid, true);

  repository.createDraft(salesRun('RUN-OCT', '2026-10', 0, true, ['2026-08'], 4000));
  const beforeCompetitor = events.length;
  assert.throws(() => repository.approve('RUN-OCT', 'other-approver'), error =>
    error.issues?.[0]?.code === 'SALES_ACCRUAL_ALREADY_CLAIMED' && error.issues[0].existingRunId === 'RUN-SEP');
  assert.equal(events.length, beforeCompetitor);
  assert.equal(repository.getRun('RUN-OCT').state, 'DRAFT');
  assert.equal(gateway.read('Payment Ledger', 'SALES_ABS:EMP-SALES:2026-08').paid, false);

  assert.equal(repository.approve('RUN-SEP', 'retry-approver').valid, true);
  const rows = gateway.list('Payment Ledger');
  assert.equal(rows.find(row => row.benefitKey === 'SALES_ABS:EMP-SALES:2026-07').paid, true);
  assert.equal(rows.find(row => row.benefitKey === 'SALES_ABS:EMP-SALES:2026-08').paid, true);
  assert.equal(rows.find(row => row.benefitKey === 'SALES_ABS:EMP-SALES:2026-09').paid, true);
  assert.equal(rows.filter(row => row.type === 'SALES_ABS_SETTLEMENT').length, 1);
  const eventsAfterRecovery = events.length;
  assert.equal(repository.approve('RUN-SEP', 'repeat-retry').valid, true);
  assert.equal(events.length, eventsAfterRecovery);
});
test('approval rejects referral aggregate overrides that cannot be allocated without partial writes', () => {
  const { repository, gateway, events } = harness();
  const input = runRecord({ results: [{ ...runRecord().results[0], components: {
    basic: { calculatedAmount: 15000, amount: 15000 }, probation: { calculatedAmount: 0, amount: 0 },
    referral: { calculatedAmount: 300, amount: 150 }, deductions: { calculatedAmount: 0, amount: 0 }
  }, benefitCandidates: [
    { eligible: true, amount: 100, benefitKey: 'REFERRAL:EMP-001:EMP-002' },
    { eligible: true, amount: 200, benefitKey: 'REFERRAL:EMP-001:EMP-003' }
  ], total: 15150 }] });
  repository.createDraft(input);
  const before = events.length;
  assert.throws(() => repository.approve(input.runId, 'approver'), error =>
    error.issues?.[0]?.code === 'AMBIGUOUS_LEDGER_AMOUNT');
  assert.equal(repository.getRun(input.runId).state, 'DRAFT');
  assert.equal(gateway.list('Payment Ledger').length, 0);
  assert.equal(events.length, before);
});
test('approval only sets paid markers for positive final-run payments and leaves other markers untouched', () => {
  const { repository, events } = harness();
  const input = runRecord({ sourceConfigs: [mappingConfig({ approvalColumns: {
    runId: 'Run', paid: 'Paid', probationPaid: 'Probation Paid', referralPaid: 'Referral Paid', status: 'Status'
  } })] });
  repository.createDraft(input);
  repository.approve('RUN-001', 'approver');
  const write = events.find(event => event[0] === 'source')[2][0].values;
  assert.equal(write.probationPaid, true);
  assert.equal(Object.prototype.hasOwnProperty.call(write, 'paid'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(write, 'referralPaid'), false);
});
test('approval skips an all-empty unpaid-marker write payload as a successful no-op', () => {
  const { repository, events } = harness();
  repository.createDraft(runRecord({ sourceConfigs: [mappingConfig({ approvalColumns: { paid: 'Paid' } })] }));
  const result = repository.approve('RUN-001', 'approver');
  assert.equal(result.valid, true);
  assert.equal(result.writeBackStatus, 'COMPLETE');
  assert.equal(events.some(event => event[0] === 'source'), false);
});
test('failed source write-back keeps a frozen checkpoint and retry completes without duplicate ledger writes', () => {
  const { repository, gateway, state } = harness();
  repository.createDraft(runRecord());
  state.failSource = true;
  const failed = repository.approve('RUN-001', 'approver');
  assert.equal(failed.valid, false);
  assert.equal(failed.resumable, true);
  assert.equal(repository.getRun('RUN-001').state, 'DRAFT');
  assert.equal(repository.getRun('RUN-001').approvalCheckpoint.state, 'APPROVING');
  assert.equal(repository.getRun('RUN-001').writeBackStatus, 'FAILED');
  assert.equal(gateway.list('Payment Ledger').length, 1);
  assert.equal(gateway.list('Latest Results').length, 0);
  assert.throws(() => repository.applyOverride('RUN-001', 'EMP-001', 'basic', 16000, 'reason', 'editor'), /frozen/i);
  state.failSource = false;
  const completed = repository.approve('RUN-001', 'another-approver');
  assert.equal(completed.valid, true);
  assert.equal(repository.getRun('RUN-001').state, 'APPROVED');
  assert.equal(gateway.list('Payment Ledger').length, 1);
  assert.equal(gateway.list('Payroll History').filter(run => run.state === 'APPROVED').length, 1);
  assert.equal(gateway.read('Latest Results', 'EMP-001').runId, 'RUN-001');
});

test('durable run writes replay audit projections through draft, override, failed approval and recovery', () => {
  const { repository, gateway, state } = harness();
  const projected = [];
  gateway.projectRunAudit = run => projected.push(plain(run));
  repository.createDraft(runRecord({ decisions: { employeeDecisions: { 'EMP-001': { probation: { approved: true } } } } }));
  repository.applyOverride('RUN-001', 'EMP-001', 'basic', 16000, 'Correction', 'editor');
  state.failSource = true;
  repository.approve('RUN-001', 'approver');
  assert.ok(projected.some(run => run.state === 'DRAFT' && run.overrides.length === 0));
  assert.ok(projected.some(run => run.overrides.length === 1));
  assert.ok(projected.some(run => run.writeBackStatus === 'FAILED'));
  state.failSource = false;
  repository.approve('RUN-001', 'approver');
  assert.equal(projected.at(-1).state, 'APPROVED');
  const count = projected.length;
  repository.approve('RUN-001', 'different-approver');
  assert.equal(projected.length, count);
});
test('interrupted latest publication resumes its checkpointed projection without repeating approval writes', () => {
  const { repository, gateway, events, state } = harness();
  repository.createDraft(runRecord());
  state.failLatestOnce = true;
  assert.throws(() => repository.approve('RUN-001', 'approver'), /Injected latest-result failure/);
  assert.equal(repository.getRun('RUN-001').approvalCheckpoint.latestStatus, 'PENDING');
  const sourceWrites = events.filter(event => event[0] === 'source').length;
  const historyRows = gateway.list('Payroll History').length;
  const benefitRows = gateway.list('Payment Ledger').length;
  const approval = repository.approve('RUN-001', 'another-approver');
  assert.equal(approval.valid, true);
  assert.equal(repository.getRun('RUN-001').approvalCheckpoint.latestStatus, 'COMPLETE');
  assert.equal(gateway.read('Latest Results', 'EMP-001').runId, 'RUN-001');
  assert.equal(events.filter(event => event[0] === 'source').length, sourceWrites);
  assert.equal(gateway.list('Payroll History').length, historyRows);
  assert.equal(gateway.list('Payment Ledger').length, benefitRows);
});

test('approved crash before latest checkpoint publishes results on retry without repeating payment writes', () => {
  const { repository, gateway, events } = harness();
  repository.createDraft(runRecord());
  let failOnce = true;
  gateway.projectRunAudit = run => {
    if (failOnce && run.state === 'APPROVED' && !run.approvalCheckpoint.latestStatus) {
      failOnce = false;
      throw new Error('Audit projection failed after durable approval');
    }
  };
  assert.throws(() => repository.approve('RUN-001', 'approver'), /Audit projection failed/);
  assert.equal(repository.getRun('RUN-001').state, 'APPROVED');
  assert.equal(repository.getRun('RUN-001').approvalCheckpoint.latestStatus, undefined);
  assert.equal(gateway.list('Latest Results').length, 0);
  const sourceWrites = events.filter(event => event[0] === 'source').length;
  const historyRows = gateway.list('Payroll History').length;
  const paymentRows = gateway.list('Payment Ledger').length;
  const result = repository.approve('RUN-001', 'another-approver');
  assert.equal(result.valid, true);
  assert.equal(repository.getRun('RUN-001').approvalCheckpoint.latestStatus, 'COMPLETE');
  assert.equal(gateway.read('Latest Results', 'EMP-001').runId, 'RUN-001');
  assert.equal(events.filter(event => event[0] === 'source').length, sourceWrites);
  assert.equal(gateway.list('Payroll History').length, historyRows);
  assert.equal(gateway.list('Payment Ledger').length, paymentRows);
});
test('two approval calls through the document lock produce one durable approval write set', () => {
  const { repository, events } = harness();
  repository.createDraft(runRecord());
  const first = repository.approve('RUN-001', 'approver');
  const second = repository.approve('RUN-001', 'approver');
  assert.deepEqual(plain(second), plain(first));
  assert.equal(events.filter(event => event[0] === 'source').length, 1);
  assert.equal(events.filter(event => event[0] === 'append' && event[1] === 'Payment Ledger').length, 1);
  assert.equal(events.filter(event => event[0] === 'append' && event[1] === 'Payroll History' && event[2] === 'RUN-001:APPROVED').length, 1);
});
test('completed approval retry does not replace a newer latest result or write again', () => {
  const { repository, gateway, events } = harness();
  repository.createDraft(runRecord());
  const first = repository.approve('RUN-001', 'approver');
  repository.createDraft(runWithoutOneTimeBenefits({ runId: 'RUN-002', version: 2 }));
  repository.approve('RUN-002', 'approver');
  const latestBeforeRetry = gateway.read('Latest Results', 'EMP-001');
  const eventsBeforeRetry = events.length;
  const retry = repository.approve('RUN-001', 'another-approver');
  assert.deepEqual(plain(retry), plain(first));
  assert.deepEqual(gateway.read('Latest Results', 'EMP-001'), latestBeforeRetry);
  assert.equal(events.length, eventsBeforeRetry);
});
test('incomplete approved write-back resumes only the source step without ledger or latest writes', () => {
  const { repository, gateway, events } = harness();
  repository.createDraft(runRecord());
  repository.approve('RUN-001', 'approver');
  const run = repository.getRun('RUN-001');
  run.writeBackStatus = 'FAILED';
  gateway.upsert('Payroll Runs', run.runId, run);
  repository.createDraft(runWithoutOneTimeBenefits({ runId: 'RUN-002', version: 2 }));
  repository.approve('RUN-002', 'approver');
  const latestBeforeRetry = gateway.read('Latest Results', 'EMP-001');
  const eventsBeforeRetry = events.slice();
  const resumed = repository.approve('RUN-001', 'another-approver');
  assert.equal(resumed.valid, true);
  assert.deepEqual(gateway.read('Latest Results', 'EMP-001'), latestBeforeRetry);
  assert.equal(events.slice(eventsBeforeRetry.length).filter(event => event[0] === 'source').length, 1);
  assert.equal(events.slice(eventsBeforeRetry.length).some(event => event[0] === 'append' || (event[0] === 'upsert' && (event[1] === 'Latest Results' || event[1] === 'Payment Ledger'))), false);
});
test('failed draft checkpoint retry does not replace a newer latest result or reappend payment rows', () => {
  const { repository, gateway, events, state } = harness();
  repository.createDraft(runRecord());
  state.failSource = true;
  repository.approve('RUN-001', 'approver');
  state.failSource = false;
  repository.createDraft(runWithoutOneTimeBenefits({ runId: 'RUN-002', version: 2 }));
  repository.approve('RUN-002', 'approver');
  const latestBeforeRetry = gateway.read('Latest Results', 'EMP-001');
  const eventCountBeforeRetry = events.length;
  repository.approve('RUN-001', 'another-approver');
  assert.deepEqual(gateway.read('Latest Results', 'EMP-001'), latestBeforeRetry);
  assert.equal(events.slice(eventCountBeforeRetry).some(event => event[0] === 'upsert' && event[1] === 'Latest Results'), false);
  assert.equal(events.slice(eventCountBeforeRetry).some(event => event[0] === 'append' && event[1] === 'Payment Ledger'), false);
  assert.equal(gateway.list('Payment Ledger').length, 1);
});
test('failed draft checkpoint retry replaces an older payroll month in Latest Results', () => {
  const { repository, gateway, state } = harness();
  repository.createDraft(runWithoutOneTimeBenefits({ runId: 'RUN-000', payrollMonth: '2026-08', version: 1 }));
  repository.approve('RUN-000', 'approver');
  repository.createDraft(runWithoutOneTimeBenefits({ runId: 'RUN-001', payrollMonth: '2026-09', version: 2 }));
  state.failSource = true;
  repository.approve('RUN-001', 'approver');
  state.failSource = false;
  repository.approve('RUN-001', 'another-approver');
  assert.equal(gateway.read('Latest Results', 'EMP-001').runId, 'RUN-001');
  assert.equal(gateway.read('Latest Results', 'EMP-001').payrollMonth, '2026-09');
});
test('probation override to zero leaves its one-time benefit eligible for a later run', () => {
  const { repository, events } = harness();
  repository.createDraft(runRecord({ sourceConfigs: [mappingConfig({ approvalColumns: {
    runId: 'Run', probationPaid: 'Probation Paid'
  } })] }));
  repository.applyOverride('RUN-001', 'EMP-001', 'probation', 0, 'Do not pay this cycle', 'editor');
  repository.approve('RUN-001', 'approver');
  assert.equal(repository.hasBenefit('PROBATION:EMP-001'), false);
  const sourceValues = events.find(event => event[0] === 'source')[2][0].values;
  assert.equal(Object.prototype.hasOwnProperty.call(sourceValues, 'probationPaid'), false);
  const { Eligibility } = loadAppsScript();
  assert.equal(Eligibility.evaluateProbationPayment(employee(), [], { asOfDate: '2026-10-01', approved: true }).eligible, true);
});
test('superseded run versions remain readable after replacement approval', () => {
  const { repository, gateway } = harness();
  repository.createDraft(runRecord());
  repository.approve('RUN-001', 'approver');
  repository.createDraft(runWithoutOneTimeBenefits({ runId: 'RUN-002', version: 2 }));
  repository.approve('RUN-002', 'approver');
  repository.supersede('RUN-001', 'RUN-002');
  assert.equal(repository.getRun('RUN-001').state, 'SUPERSEDED');
  assert.equal(repository.getRun('RUN-002').state, 'APPROVED');
  assert.equal(gateway.list('Payroll History').some(run => run.runId === 'RUN-001' && run.state === 'SUPERSEDED'), true);
});
test('internal approval checkpoint is rejected as a public run lifecycle state', () => {
  const { repository } = harness();
  assert.throws(() => repository.createDraft(runRecord({ state: 'APPROVING' })), /state is invalid/i);
});
