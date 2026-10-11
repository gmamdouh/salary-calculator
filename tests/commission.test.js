const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const rawCommission = loadAppsScript().Commission;
const rules = rawCommission.parseRows(rawCommission.defaultRows());
const Commission = {
  calculateSurvey: transfers => rawCommission.calculateSurvey(transfers, rules),
  calculateReservations: transfers => rawCommission.calculateReservations(transfers, rules),
  calculateSales: (sales, conversionRate) => rawCommission.calculateSales(sales, conversionRate, rules),
  calculateTds: agents => rawCommission.calculateTds(agents, rules)
};
test('Survey pins every transfer band boundary', () => {
  for (const [count, amount] of [[0,0],[1,10],[200,2000],[201,2015],[300,3500],[301,4515],[350,5250],[351,7020],[400,8000],[401,10025],[500,12500],[501,15030]]) {
    assert.equal(Commission.calculateSurvey(count), amount);
  }
});
test('Reservations pins progressive boundaries', () => {
  for (const [count, amount] of [[0,0],[1,10],[200,2000],[201,2015],[300,3500],[301,3520],[400,5500],[401,5525],[500,8000],[501,8030]]) assert.equal(Commission.calculateReservations(count), amount);
});
test('Sales pins every conversion boundary against every sales boundary', () => {
  const bands = [[0,'0.00-3.00',[300,300,300,300,300]],[3,'0.00-3.00',[300,300,300,300,300]],
    [3.01,'3.01-3.99',[400,400,400,400,400]],[3.99,'3.01-3.99',[400,400,400,400,400]],
    [4,'4.00-4.99',[450,550,650,750,850]],[4.99,'4.00-4.99',[450,550,650,750,850]],
    [5,'5.00-5.99',[550,650,750,850,1000]],[5.99,'5.00-5.99',[550,650,750,850,1000]],
    [6,'6.00+',[650,750,950,1100,1300]],[6.1,'6.00+',[650,750,950,1100,1300]]];
  for (const [conversion, band, rates] of bands) {
    for (const sales of [0,1,19,20,29,30,39,40,49,50]) {
      const bracket = sales < 20 ? 0 : sales < 30 ? 1 : sales < 40 ? 2 : sales < 50 ? 3 : 4;
      const result = Commission.calculateSales(sales, conversion);
      assert.equal(result.ratePerSale, rates[bracket]);
      assert.equal(result.amount, sales * rates[bracket]);
      assert.equal(result.band, band);
    }
  }
  assert.equal(Commission.calculateSales(37,4.2).amount,24050);
  assert.equal(Commission.calculateSales(53,6.1).amount,68900);
  assert.equal(Commission.calculateSales(20,3.004).ratePerSale,300);
  assert.equal(Commission.calculateSales(20,3.005).ratePerSale,400);
  assert.equal(Commission.calculateSales(20,3.999).ratePerSale,550);
});
test('TDS counts only assigned agents strictly above 75 transfers', () => {
  const result = Commission.calculateTds([{ performance: { transfers: 0 } },{ performance: { transfers: 75 } },{ performance: { transfers: 76 } }]);
  assert.equal(result.qualifyingCount,1);
  assert.equal(result.amount,100);
  assert.equal(Commission.calculateTds([]).amount,0);
});
test('commission rejects malformed counts and conversion rates', () => {
  for (const value of [-1,'10',null,NaN,Infinity,1.5]) {
    assert.throws(() => Commission.calculateSurvey(value), /transfers must/);
    assert.throws(() => Commission.calculateReservations(value), /transfers must/);
    assert.throws(() => Commission.calculateSales(value,4), /sales must/);
    assert.throws(() => Commission.calculateTds([{ performance: { transfers: value } }]), /transfers must/);
  }
  for (const value of [-1,'4',null,NaN,Infinity]) assert.throws(() => Commission.calculateSales(1,value), /conversionRate must/);
  assert.throws(() => Commission.calculateTds([{}]), /transfers must/);
});
