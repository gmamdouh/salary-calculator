const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');
const fixtures = require('./helpers/fixtures');
const { Eligibility, PayrollPeriod } = loadAppsScript();
const period = (overrides = {}) => PayrollPeriod.buildPeriod(fixtures.periodOptions(overrides));
test('ABS pins normal and February attended-day thresholds', () => {
  for (const department of ['SURVEY','RESERVATIONS','SALES']) {
    for (const [month,fail,pass] of [['2026-09',16,17],['2026-02',14,15],['2024-02',14,15]]) {
      assert.equal(Eligibility.evaluateAbs(fixtures.employee({department,firstWorkingDay:'2020-01-01'}),fixtures.attendance({attendedScheduledDays:fail}),period({payrollMonth:month})).eligible,false);
      assert.equal(Eligibility.evaluateAbs(fixtures.employee({department,firstWorkingDay:'2020-01-01'}),fixtures.attendance({attendedScheduledDays:pass}),period({payrollMonth:month})).eligible,true);
    }
  }
});
test('ABS leave limit, partial employment and current cutoff are independent', () => {
  const evaluate = (employee, attendance, p = period()) => Eligibility.evaluateAbs(employee, attendance, p);
  assert.equal(evaluate(fixtures.employee(),fixtures.attendance({leaveDays:5})).eligible,true);
  assert.equal(evaluate(fixtures.employee(),fixtures.attendance({leaveDays:6})).reasonCode,'LEAVE_LIMIT');
  for (const overrides of [{firstWorkingDay:'2026-09-05'},{lastWorkingDay:'2026-09-20'}]) {
    const result = evaluate(fixtures.employee(overrides),fixtures.attendance({attendedScheduledDays:0}));
    assert.equal(result.eligible,true);
    assert.equal(result.amount,null);
    assert.equal(evaluate(fixtures.employee(overrides),fixtures.attendance({attendedScheduledDays:0,leaveDays:6})).eligible,false);
  }
  assert.equal(evaluate(fixtures.employee(),fixtures.attendance({attendedScheduledDays:1}),period({payrollMonth:'2026-10',cutoffMode:'TODAY'})).reasonCode,'ATTENDANCE_PENDING');
  assert.equal(evaluate(fixtures.employee({firstWorkingDay:'2026-11-01'}),fixtures.attendance()).reasonCode,'OUTSIDE_PERIOD');
  for (const department of ['TDS','MANAGEMENT']) assert.equal(evaluate(fixtures.employee({department}),fixtures.attendance()).reasonCode,'NO_ABS');
});
test('No-Show forfeits full and partial ABS and deducts exactly three Basic days', () => {
  for (const overrides of [{},{firstWorkingDay:'2026-09-05'},{lastWorkingDay:'2026-09-20'},{department:'SALES'}]) {
    const result = Eligibility.evaluateAbs(fixtures.employee(overrides),fixtures.attendance({nsPresent:true}),period());
    assert.equal(result.eligible,false);
    assert.equal(result.amount,0);
    assert.equal(result.reasonCode,'NO_SHOW');
    assert.ok(result.note.length > 0);
  }
  assert.equal(Eligibility.calculateNoShowDeduction(true,400),1200);
  assert.equal(Eligibility.calculateNoShowDeduction(false,400),0);
  for (const rate of [-1,'400',null,NaN,Infinity]) assert.throws(() => Eligibility.calculateNoShowDeduction(true,rate), /rate/);
  assert.throws(() => Eligibility.calculateNoShowDeduction(1,400), /boolean/);
});
test('extra-day units count unique dates and holiday precedence', () => {
  const distinct = Eligibility.calculateExtraDayUnits(['2026-09-01'],['2026-09-02']);
  assert.equal(distinct.units,3);
  assert.equal(distinct.amount,null);
  const overlap = Eligibility.calculateExtraDayUnits(['2026-09-01','2026-09-01'],['2026-09-01','2026-09-01']);
  assert.equal(overlap.units,2);
  assert.equal(overlap.byDate[0].date,'2026-09-01');
  assert.equal(overlap.byDate[0].units,2);
  assert.equal(Eligibility.calculateExtraDayUnits([],[]).units,0);
  assert.throws(() => Eligibility.calculateExtraDayUnits(['2026-02-30'],[]), /date/);
});
test('probation payment requires day 92, HR approval and no prior benefit', () => {
  const employee = fixtures.employee({firstWorkingDay:'2026-01-01'});
  const evaluate = (overrides, decision, ledger = []) => Eligibility.evaluateProbationPayment({...employee,...overrides},ledger,fixtures.probationDecision(decision));
  assert.equal(evaluate({}, {asOfDate:'2026-04-01'}).eligible,false);
  assert.equal(evaluate({}, {asOfDate:'2026-04-02'}).amount,12000);
  assert.equal(evaluate({lastWorkingDay:'2026-04-01'},{}).eligible,false);
  assert.equal(evaluate({lastWorkingDay:'2026-04-02'},{}).eligible,true);
  assert.equal(evaluate({}, {approved:undefined}).reasonCode,'DECISION_REQUIRED');
  assert.equal(evaluate({}, {approved:false}).reasonCode,'HR_DECLINED');
  const ledger = fixtures.benefitLedger('PROBATION:EMP-001');
  const before = JSON.stringify(ledger);
  assert.equal(evaluate({}, {}, ledger).reasonCode,'ALREADY_PAID');
  assert.equal(JSON.stringify(ledger),before);
  for (const department of ['SALES','TDS','MANAGEMENT']) assert.equal(evaluate({department},{}).reasonCode,'NOT_APPLICABLE');
});
test('referral begins on inclusive day 60 and respects final payment cutoff and duplicate keys', () => {
  const referrer = fixtures.employee({employeeId:'A',department:'MANAGEMENT'});
  const referred = fixtures.employee({employeeId:'B',firstWorkingDay:'2026-01-01',referrerEmployeeId:'A'});
  const evaluate = (a, b, date, ledger = []) => Eligibility.evaluateReferral(a,b,date,ledger);
  assert.equal(evaluate(referrer,referred,'2026-02-28').eligible,false);
  assert.equal(evaluate(referrer,referred,'2026-03-01').amount,10000);
  assert.equal(evaluate(referrer,{...referred,lastWorkingDay:'2026-02-28'},'2026-03-01').eligible,false);
  const former = {...referrer,lastWorkingDay:'2026-02-01',finalPayrollPaymentDate:'2026-02-28'};
  assert.equal(evaluate(former,referred,'2026-03-01').reasonCode,'FINAL_PAYMENT_CUTOFF');
  assert.equal(evaluate({...former,finalPayrollPaymentDate:'2026-03-01'},referred,'2026-03-01').eligible,true);
  assert.equal(evaluate({...referrer,lastWorkingDay:'2026-02-01'},referred,'2026-03-01').eligible,true);
  const ledger = fixtures.benefitLedger('REFERRAL:A:B');
  const before = JSON.stringify(ledger);
  assert.equal(evaluate(referrer,referred,'2026-03-01',ledger).reasonCode,'ALREADY_PAID');
  assert.equal(JSON.stringify(ledger),before);
  assert.equal(evaluate(referrer,{...referred,referrerEmployeeId:'C'},'2026-03-01').reasonCode,'REFERRAL_LINK_MISMATCH');
  assert.equal(evaluate(referrer,{...referred,employeeId:'A'},'2026-03-01').eligible,false);
});
test('eligibility validates malformed attendance, benefit dates and ledgers', () => {
  for (const value of [-1,'17',null,NaN,Infinity,1.5]) {
    assert.throws(() => Eligibility.evaluateAbs(fixtures.employee(),fixtures.attendance({attendedScheduledDays:value}),period()), /attendedScheduledDays/);
    assert.throws(() => Eligibility.evaluateAbs(fixtures.employee(),fixtures.attendance({leaveDays:value}),period()), /leaveDays/);
  }
  assert.throws(() => Eligibility.evaluateAbs(fixtures.employee(),fixtures.attendance({nsPresent:'NS'}),period()), /boolean/);
  assert.throws(() => Eligibility.evaluateProbationPayment(fixtures.employee(),[],fixtures.probationDecision({asOfDate:'2026-02-30'})), /date/);
  assert.throws(() => Eligibility.evaluateProbationPayment(fixtures.employee(),{},fixtures.probationDecision()), /ledger/);
});
