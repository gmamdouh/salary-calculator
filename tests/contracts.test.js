const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const fixtures = require('./helpers/fixtures');
const calculator = loadAppsScript();
test('accepts canonical employee and optional fields', () => {
  assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee()));
  assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee({ performance: undefined, lastWorkingDay: undefined, extra: true })));
});
for (const field of ['employeeId', 'americanName', 'department', 'firstWorkingDay']) {
  test(`rejects missing ${field}`, () => {
    assert.throws(() => calculator.Contracts.assertEmployee(fixtures.employee({ [field]: '' })), new RegExp(field));
  });
}
for (const value of ['bad-date', '2026-02-30', '2025-12-31']) {
  test(`rejects invalid lastWorkingDay ${value}`, () => {
    assert.throws(() => calculator.Contracts.assertEmployee(fixtures.employee({ lastWorkingDay: value })), /lastWorkingDay/);
  });
}
for (const field of ['transfers', 'sales', 'activeCalls', 'conversionRate']) {
  for (const value of ['10', NaN, Infinity, -1, null]) {
    test(`rejects invalid performance ${field} ${String(value)}`, () => {
      const record = fixtures.employee();
      record.performance[field] = value;
      assert.throws(() => calculator.Contracts.assertEmployee(record), /performance/);
    });
  }
}
test('accepts empty and partial performance records', () => {
  assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee({ performance: {} })));
  for (const field of ['transfers', 'sales', 'activeCalls', 'conversionRate']) {
    assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee({ performance: { [field]: 0 } })));
    assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee({ performance: { [field]: undefined } })));
  }
});
test('validates departments and calendar dates', () => {
  for (const department of ['SURVEY', 'RESERVATIONS', 'SALES', 'TDS', 'MANAGEMENT']) {
    assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee({ department })));
  }
  assert.throws(() => calculator.Contracts.assertEmployee(fixtures.employee({ department: 'OTHER' })), /department/);
  assert.throws(() => calculator.Contracts.assertEmployee(fixtures.employee({ firstWorkingDay: '2026-02-30' })), /firstWorkingDay/);
  assert.doesNotThrow(() => calculator.Contracts.assertEmployee(fixtures.employee({ lastWorkingDay: '2026-01-01' })));
});
for (const method of ['assertRules', 'assertDecisionSet']) {
  test(`${method} accepts open records and validates known enum values`, () => {
    assert.doesNotThrow(() => calculator.Contracts[method]({ extra: true }));
    assert.doesNotThrow(() => calculator.Contracts[method]({ cutoffMode: 'TODAY', state: 'DRAFT', runState: 'APPROVED' }));
    for (const value of [null, [], 'value', new Date()]) assert.throws(() => calculator.Contracts[method](value), /object/);
    assert.throws(() => calculator.Contracts[method]({ cutoffMode: 'OTHER' }), /cutoffMode/);
    assert.throws(() => calculator.Contracts[method]({ state: 'OTHER' }), /state/);
    assert.throws(() => calculator.Contracts[method]({ runState: 'OTHER' }), /runState/);
    assert.doesNotThrow(() => calculator.Contracts[method]({ nested: { cutoffMode: 'OTHER', state: 'ACTIVE', runState: 'PENDING' } }));
  });
}
test('new run records require their complete rules snapshot', () => {
  assert.throws(() => calculator.Contracts.assertRun(fixtures.runRecord({ rulesSnapshot: undefined })), /rulesSnapshot/);
  assert.doesNotThrow(() => calculator.Contracts.assertRun(fixtures.runRecord()));
});
