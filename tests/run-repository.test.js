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
  repository.createDraft(runRecord({ runId: 'RUN-002', version: 2 }));
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
  repository.createDraft(runRecord({ runId: 'RUN-002', version: 2 }));
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
  repository.createDraft(runRecord({ runId: 'RUN-002', version: 2 }));
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
  repository.createDraft(runRecord({ runId: 'RUN-000', payrollMonth: '2026-08', version: 1 }));
  repository.approve('RUN-000', 'approver');
  repository.createDraft(runRecord({ runId: 'RUN-001', payrollMonth: '2026-09', version: 2 }));
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
  repository.createDraft(runRecord({ runId: 'RUN-002', version: 2 }));
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
