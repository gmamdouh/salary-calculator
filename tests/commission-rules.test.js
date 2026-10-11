const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');

test('edited Sales commission row changes the calculated rate', () => {
  const { Commission } = loadAppsScript();
  const rows = Commission.defaultRows();
  rows.find(row => row[1] === 'SALES' && row[2] === '4.00%-4.99%|30-39')[3] = 700;
  const rules = Commission.parseRows(rows);
  assert.equal(Commission.calculateSales(37, 4.2, rules).amount, 25900);
});

test('missing, duplicate, overlapping, and malformed commission rows fail closed', () => {
  const { Commission } = loadAppsScript();
  const defaults = Commission.defaultRows();
  const missing = defaults.filter(row => !(row[1] === 'SALES' && row[2] === '4.00%-4.99%|30-39'));
  assert.throws(() => Commission.parseRows(missing), error => error.issues?.[0].code === 'INVALID_COMMISSION_RULE');
  assert.throws(() => Commission.parseRows([...defaults, defaults.find(row => row[1] === 'TDS')]), /Duplicate TDS/);
  assert.throws(() => Commission.parseRows([...defaults, ['COMMISSION','SURVEY','199-250',12,'']]), /Overlapping|duplicate/);
  const malformed = defaults.map(row => [...row]);
  malformed.find(row => row[1] === 'RESERVATIONS' && row[2] === '201-300')[3] = 'bad formula';
  assert.throws(() => Commission.parseRows(malformed), /finite nonnegative/);
});

test('legacy seeded bands normalize without changing boundary payouts', () => {
  const { Commission } = loadAppsScript();
  const rows = Commission.defaultRows();
  rows.find(row => row[1] === 'SURVEY' && row[2] === '201-300')[3] = '2000 + (transfers - 200) * 15';
  rows.filter(row => row[1] === 'SALES').forEach(row => { row[2] = row[2].replace('|0-19', '|1-19'); });
  const rules = Commission.parseRows(rows);
  assert.equal(Commission.calculateSurvey(201, rules), 2015);
  assert.equal(Commission.calculateSurvey(301, rules), 4515);
  assert.equal(Commission.calculateSales(0, 4.2, rules).ratePerSale, 450);
  assert.equal(Commission.calculateSales(37, 4.2, rules).amount, 24050);
});
