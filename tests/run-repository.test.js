const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { runRecord } = require('./helpers/fixtures');
const plain = value => JSON.parse(JSON.stringify(value));
// Repository adapter: read(table,key), upsert(table,key,record),
// appendUnique(table,key,record), list(table); all records are JSON snapshots.
function harness() {
  const tables = new Map(), events = [];
  let held = false;
  const state = { failSource: false, onLock: null };
  const table = name => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name); };
  const gateway = {
    read: (name, key) => table(name).has(key) ? plain(table(name).get(key)) : null,
    upsert(name, key, value) { events.push(['upsert', name, key]); table(name).set(key, plain(value)); },
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
