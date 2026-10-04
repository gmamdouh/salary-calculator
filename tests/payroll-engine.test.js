const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const { employee, attendance, periodOptions, payrollRules } = require('./helpers/fixtures');
const app = loadAppsScript();
function run(overrides = {}) {
  return app.PayrollEngine.calculateEmployee({ employee: employee({ firstWorkingDay: '2026-08-01' }), attendance: attendance(),
    performance: { transfers: 0 }, decisions: {}, rules: payrollRules(),
    period: app.PayrollPeriod.buildPeriod(periodOptions()), ledger: [], ...overrides });
}
test('Survey before probation receives basic plus ABS', () => {
  const result = run();
  assert.equal(result.components.basic.amount, 12000);
  assert.equal(result.components.abs.amount, 2000);
  assert.equal(result.total, 14000);
});
test('probation split blends a full month without a 31-day overpayment', () => {
  const result = run({ employee: employee({ firstWorkingDay: '2026-06-17' }) });
  assert.equal(result.components.basic.amount, 13600);
  assert.equal(result.components.abs.amount, 2533.33);
  const full = run({ employee: employee(), period: app.PayrollPeriod.buildPeriod(periodOptions({ payrollMonth: '2026-08' })) });
  assert.equal(full.components.basic.amount, 15000);
  assert.equal(full.components.abs.amount, 3000);
});
test('Reservations delegates progressive transfers and TDS counts only its supplied batch', () => {
  assert.equal(run({ employee: employee({ department: 'RESERVATIONS', firstWorkingDay: '2026-08-01' }), performance: { transfers: 351 } }).components.commission.amount, 4520);
  const result = run({ employee: employee({ department: 'TDS' }), performance: { agents: [{ performance: { transfers: 75 } }, { performance: { transfers: 76 } }] } });
  assert.equal(result.components.commission.amount, 100);
  assert.equal(result.components.abs.amount, 0);
});
test('Management has no ABS, regardless of configured ABS', () => {
  assert.equal(run({ employee: employee({ department: 'MANAGEMENT' }) }).total, 27000);
});
test('active sample is 15000 and final settlement with four annual days is 16600', () => {
  const sample = { employee: employee({ firstWorkingDay: '2026-09-04' }), attendance: attendance({ attendedScheduledDays: 3, workedHolidays: ['2026-09-10','2026-09-11','2026-09-12'] }) };
  assert.equal(run(sample).total, 15000);
  const final = run({ ...sample, employee: employee({ firstWorkingDay: '2026-09-04', lastWorkingDay: '2026-09-30', annualLeaveBalance: 4 }) });
  assert.equal(final.total, 16600);
  assert.equal(final.components.annualBalance.amount, 1600);
  assert.equal(final.finalSettlement, true);
});
test('annual leave and date-specific extra units use the Basic rate applicable on each date', () => {
  const result = run({ employee: employee({ firstWorkingDay: '2026-06-17', lastWorkingDay: '2026-09-20', annualLeaveBalance: 4 }),
    attendance: attendance({ workedOffDays: ['2026-09-10','2026-09-20'], workedHolidays: ['2026-09-20'] }) });
  assert.equal(result.components.annualBalance.amount, 2000);
  assert.equal(result.components.extraDays.amount, 1400);
  assert.equal(result.components.extraDays.units, 3);
});
test('partial joiners and leavers retain ABS with low attendance; NS removes it only', () => {
  for (const dates of [{ firstWorkingDay: '2026-09-16' }, { firstWorkingDay: '2026-08-01', lastWorkingDay: '2026-09-15' }]) {
    const params = { employee: employee(dates), attendance: attendance({ attendedScheduledDays: 1 }) };
    assert.equal(run(params).components.abs.amount, 1000);
    const ns = run({ ...params, attendance: attendance({ attendedScheduledDays: 1, nsPresent: true }) });
    assert.equal(ns.components.abs.amount, 0);
    assert.equal(ns.components.deductions.amount, -1200);
  }
});
test('Sales payout retains prior accruals when current month fails; partial forfeiture removes only partial accrual', () => {
  const params = { employee: employee({ department: 'SALES' }), performance: { sales: 37, conversionRate: 4.2 },
    ledger: [{ type: 'SALES_ABS', employeeId: 'EMP-001', payrollMonth: '2026-07', amount: 4000 }, { type: 'SALES_ABS', employeeId: 'EMP-001', payrollMonth: '2026-08', amount: 4000 }] };
  assert.equal(run(params).components.abs.amount, 12000);
  assert.equal(run(params).components.commission.amount, 24050);
  const failed = run({ ...params, attendance: attendance({ nsPresent: true }) });
  assert.equal(failed.components.abs.amount, 8000);
  assert.equal(failed.salesAccrual.amount, 0);
  const partial = { ...params, employee: employee({ department: 'SALES', firstWorkingDay: '2026-09-16' }) };
  assert.equal(run(partial).components.abs.amount, 10000);
  assert.equal(run({ ...partial, attendance: attendance({ nsPresent: true }) }).components.abs.amount, 8000);
});
test('Sales defers monthly accrual until configured quarter month and excludes paid ledger rows', () => {
  const result = run({ employee: employee({ department: 'SALES' }), performance: { sales: 0, conversionRate: 0 },
    period: app.PayrollPeriod.buildPeriod(periodOptions({ payrollMonth: '2026-08' })) });
  assert.equal(result.components.abs.amount, 0);
  assert.equal(result.salesAccrual.amount, 4000);
  assert.equal(result.salesAccrual.paid, false);
  const paid = run({ employee: employee({ department: 'SALES' }), performance: { sales: 0, conversionRate: 0 }, ledger: [{ type: 'SALES_ABS', employeeId: 'EMP-001', payrollMonth: '2026-08', amount: 4000, paid: true }] });
  assert.equal(paid.components.abs.amount, 4000);
});
test('NS in a transition month needs its worked date and uses that date Basic rate', () => {
  const params = { employee: employee({ firstWorkingDay: '2026-06-17' }), attendance: attendance({ nsPresent: true }) };
  assert.throws(() => run(params), /No-Show date is required/);
  const result = run({ ...params, attendance: attendance({ nsPresent: true, noShowDate: '2026-09-10' }) });
  assert.equal(result.components.deductions.amount, -1200);
});
test('Sales final settlement releases unpaid accruals and rows outside employment pay zero', () => {
  const params = { employee: employee({ department: 'SALES', lastWorkingDay: '2026-08-15' }), performance: { sales: 0, conversionRate: 0 },
    ledger: [{ type: 'SALES_ABS', employeeId: 'EMP-001', payrollMonth: '2026-07', amount: 4000 }], period: app.PayrollPeriod.buildPeriod(periodOptions({ payrollMonth: '2026-08' })) };
  assert.equal(run(params).components.abs.amount, 6000);
  assert.equal(run({ ...params, period: app.PayrollPeriod.buildPeriod(periodOptions()) }).total, 0);
});
test('probation and referral are approved once, including duplicate same-run referrals', () => {
  const referred = employee({ employeeId: 'EMP-002', firstWorkingDay: '2026-07-01', referrerEmployeeId: 'EMP-001' });
  const ledger = [];
  const result = run({ employee: employee(), ledger, decisions: { probation: { approved: true }, referrals: [referred,referred] } });
  assert.equal(result.components.probation.amount, 12000);
  assert.equal(result.components.referral.amount, 10000);
  assert.equal(ledger.length, 0);
  const paid = run({ employee: employee(), ledger: [{ benefitKey: 'PROBATION:EMP-001' },{ benefitKey: 'REFERRAL:EMP-001:EMP-002' }], decisions: { probation: { approved: true }, referrals: [referred] } });
  assert.equal(paid.components.probation.amount, 0);
  assert.equal(paid.components.referral.amount, 0);
});
test('approved additions, manual deductions, and documented overrides retain calculation audit', () => {
  const result = run({ decisions: { additions: [{ amount: 50, approved: true, reason: 'Approved adjustment' }], deductions: [{ amount: 20, reason: 'Advance' }],
    overrides: [{ component: 'basic', value: 12345, reason: 'HR correction', editor: 'hr@example.com', timestamp: '2026-10-04T12:00:00Z' }] } });
  assert.equal(result.components.basic.calculatedAmount, 12000);
  assert.equal(result.components.basic.amount, 12345);
  assert.equal(result.total, 14375);
});
test('components are rounded before summation and invalid inputs fail clearly', () => {
  const result = run({ employee: employee({ firstWorkingDay: '2026-09-30' }), decisions: { additions: [{ amount: 0.005, approved: true, reason: 'Rounding' }] } });
  assert.equal(result.components.abs.amount, 66.67);
  assert.equal(result.components.additions.amount, 0.01);
  assert.equal(result.total, 466.68);
  assert.equal(app.PayrollEngine.sumComponents(result.components), result.total);
  assert.throws(() => run({ decisions: { deductions: [{ amount: NaN, reason: 'Bad' }] } }), /finite/);
  assert.throws(() => run({ decisions: { overrides: [{ component: 'basic', value: 1 }] } }), /reason/);
  assert.throws(() => run({ employee: employee({ lastWorkingDay: '2026-09-30', annualLeaveBalance: NaN }) }), /annualLeaveBalance/);
  assert.throws(() => run({ attendance: attendance({ noShowDate: '2026-09-31' }) }), /Invalid No-Show date/);
  assert.throws(() => run({ decisions: { overrides: [{ component: 'toString', value: 1 }] } }), /Unknown override/);
});
test('calculation preserves input snapshots and warns when probation confirmation is missing', () => {
  const params = { employee: employee(), attendance: attendance(), decisions: {}, rules: payrollRules(), ledger: [] };
  const before = JSON.stringify(params);
  const result = run(params);
  assert.equal(JSON.stringify(params), before);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.components.probation.amount, 0);
  assert.equal(result.benefitCandidates[0].benefitKey, 'PROBATION:EMP-001');
});
