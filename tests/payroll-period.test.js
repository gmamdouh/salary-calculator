const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { employee, periodOptions } = require('./helpers/fixtures');
const api = loadAppsScript().PayrollPeriod;
const plain = value => JSON.parse(JSON.stringify(value));
test('builds past and current month boundaries including February', () => {
  for (const [month, today, end, days] of [
    ['2026-09', '2026-10-04', '2026-09-30', 30],
    ['2026-10', '2026-10-04', '2026-10-31', 31],
    ['2027-02', '2027-03-01', '2027-02-28', 28],
    ['2028-02', '2028-03-01', '2028-02-29', 29]]) {
    const period = api.buildPeriod(periodOptions({ payrollMonth: month, today }));
    assert.equal(period.startDate, month + '-01');
    assert.equal(period.endDate, end);
    assert.equal(period.daysInMonth, days);
    assert.equal(period.monthEndDate, end);
    assert.equal(period.isComplete, true);
  }
});
test('TODAY caps only the current month', () => {
  assert.equal(api.buildPeriod(periodOptions({ payrollMonth: '2026-10', cutoffMode: 'TODAY' })).endDate, '2026-10-04');
  assert.equal(api.buildPeriod(periodOptions({ cutoffMode: 'TODAY' })).endDate, '2026-09-30');
});
test('rejects future months and invalid inputs', () => {
  assert.throws(() => api.buildPeriod(periodOptions({ payrollMonth: '2026-11' })), /future/i);
  for (const overrides of [{ payrollMonth: '2026-13' }, { today: '2026-02-30' }, { cutoffMode: 'OTHER' }]) {
    assert.throws(() => api.buildPeriod(periodOptions(overrides)));
  }
});
test('September 5 through 30 includes 26 eligible days', () => {
  const window = api.getEmploymentWindow(employee({ firstWorkingDay: '2026-09-05' }), api.buildPeriod(periodOptions()));
  assert.deepEqual(plain(window), { startDate: '2026-09-05', endDate: '2026-09-30', eligibleDays: 26, isFullEligibleMonth: false });
});
test('employment boundaries are inclusive and nonoverlap is null', () => {
  const period = api.buildPeriod(periodOptions());
  for (const day of ['2026-09-01', '2026-09-30']) {
    assert.equal(api.getEmploymentWindow(employee({ firstWorkingDay: day, lastWorkingDay: day }), period).eligibleDays, 1);
  }
  assert.equal(api.getEmploymentWindow(employee({ firstWorkingDay: '2026-10-01' }), period), null);
  assert.equal(api.getEmploymentWindow(employee({ lastWorkingDay: '2026-08-31' }), period), null);
});
test('full calendar months pay fixed monthly amount; partial months use 30 and cap', () => {
  const period = api.buildPeriod(periodOptions({ payrollMonth: '2026-10' }));
  const window = api.getEmploymentWindow(employee(), period);
  assert.equal(window.eligibleDays, 31);
  assert.equal(window.isFullEligibleMonth, true);
  assert.equal(api.prorate(3000, 31, true), 3000);
  assert.equal(api.prorate(3000, 28, true), 3000);
  assert.equal(api.prorate(3000, 26, false), 2600);
  assert.equal(api.prorate(3000, 31, false), 3000);
  assert.equal(api.prorate(3000, 0, false), 0);
});
test('TODAY employment window is partial despite employment throughout month', () => {
  const period = api.buildPeriod(periodOptions({ payrollMonth: '2026-10', cutoffMode: 'TODAY' }));
  assert.equal(api.getEmploymentWindow(employee(), period).isFullEligibleMonth, false);
  assert.equal(period.isComplete, false);
});
test('probation day 90 and day 91 split exactly', () => {
  const period = api.buildPeriod(periodOptions({ payrollMonth: '2026-04', today: '2026-05-01' }));
  const window = api.getEmploymentWindow(employee({ firstWorkingDay: '2026-01-02' }), period);
  assert.deepEqual(plain(api.splitProbation(window, '2026-01-02')), [
    { startDate: '2026-04-01', endDate: '2026-04-01', eligibleDays: 1, phase: 'BEFORE_PROBATION' },
    { startDate: '2026-04-02', endDate: '2026-04-30', eligibleDays: 29, phase: 'AFTER_PROBATION' }
  ]);
});
test('probation segments cover wholly probation and wholly postprobation windows', () => {
  const period = api.buildPeriod(periodOptions());
  assert.equal(api.splitProbation(api.getEmploymentWindow(employee({ firstWorkingDay: '2026-09-05' }), period), '2026-09-05')[0].phase, 'BEFORE_PROBATION');
  assert.equal(api.splitProbation(api.getEmploymentWindow(employee(), period), '2026-01-01')[0].phase, 'AFTER_PROBATION');
  assert.deepEqual(plain(api.splitProbation(null, '2026-01-01')), []);
});
test('invalid prorating amounts and day counts reject', () => {
  for (const args of [[-1, 1, false], [NaN, 1, false], [100, -1, false], [100, 1.5, false]]) assert.throws(() => api.prorate(...args), /nonnegative/);
});

test('finite large partial amounts remain capped without intermediate overflow', () => {
  assert.equal(api.prorate(Number.MAX_VALUE, 30, false), Number.MAX_VALUE);
});
