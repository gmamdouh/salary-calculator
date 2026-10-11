const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function createTracker() {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(firstScript, 'sidebar should expose its browser-local OCR attempt tracker');
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  return context.PayrollSidebarOcrAttemptTracker.create();
}

function createPartialRunNotice() {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  return context.PayrollSidebarPartialRunNotice.create();
}

function createHolidayDecisions() {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  return context.PayrollSidebarHolidayDecisions.create();
}

test('each configured holiday date has independent American-name and department decisions', () => {
  const decisions = createHolidayDecisions();
  decisions.setCalendar([{ holidayId: 'H-MAY', actualHolidayDates: ['2027-05-17', '2027-05-18'] }], '2027-05', '2027-05-31');
  const employees = [{ employeeId: 'SUR-1', department: 'SURVEY' }, { employeeId: 'RES-1', department: 'RESERVATIONS' },
    { employeeId: 'SALE-1', department: 'SALES' }];
  decisions.selectDate('H-MAY|2027-05-17');
  decisions.setApplies(true);
  decisions.selectEmployee('SUR-1', true);
  decisions.bulk('RESERVATIONS', employees);
  decisions.selectDate('H-MAY|2027-05-18');
  decisions.setApplies(false);
  decisions.selectEmployee('SALE-1', true);
  const payload = JSON.parse(JSON.stringify(decisions.payload()));
  assert.deepEqual(payload, [
    { holidayId: 'H-MAY', date: '2027-05-17', applies: true, employeeIds: ['SUR-1', 'RES-1'] },
    { holidayId: 'H-MAY', date: '2027-05-18', applies: false, employeeIds: [] }
  ]);
});

test('changed validation removes newly omitted employees from every holiday date', () => {
  const decisions = createHolidayDecisions();
  decisions.setCalendar([{ holidayId: 'H', actualHolidayDates: ['2027-05-17', '2027-05-18'] }], '2027-05', '2027-05-31');
  decisions.selectDate('H|2027-05-17'); decisions.setApplies(true); decisions.selectEmployee('EMP-OMITTED', true);
  decisions.selectDate('H|2027-05-18'); decisions.setApplies(true); decisions.selectEmployee('EMP-OMITTED', true);
  decisions.retainEmployees(['EMP-HEALTHY']);
  assert.deepEqual(JSON.parse(JSON.stringify(decisions.payload())).map(item => item.employeeIds), [[], []]);
});

test('previous payroll month is correct on a 31st followed by a shorter month', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  assert.equal(context.PayrollSidebarDefaultMonth(new Date('2026-10-31T12:00:00Z')), '2026-09');
  assert.equal(context.PayrollSidebarDefaultMonth(new Date('2027-03-31T12:00:00Z')), '2027-02');
});

test('draft approval stays locked after an edit or failed save until an authoritative draft is loaded', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  const gate = context.PayrollSidebarDraftGate.create();
  gate.load({ valid: true, runId: 'RUN-1', state: 'DRAFT' });
  assert.equal(gate.canApprove(), true);
  gate.markDirty();
  assert.equal(gate.canApprove(), false);
  gate.beginSave();
  assert.equal(gate.canApprove(), false);
  gate.saveFailed();
  assert.equal(gate.canApprove(), false);
  assert.equal(gate.canEdit(), false);
  gate.load({ valid: true, runId: 'RUN-1', state: 'DRAFT' });
  assert.equal(gate.canApprove(), true);
});

test('a frozen approval can retry the same run after failure and sidebar reload', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  const gate = context.PayrollSidebarDraftGate.create();
  gate.load({ valid: true, runId: 'RUN-RETRY', state: 'DRAFT' });
  gate.beginApproval();
  gate.approvalFailed(true);
  assert.equal(gate.canApprove(), false);
  assert.equal(gate.canRetry(), true);
  assert.equal(gate.runId(), 'RUN-RETRY');
  const reopened = context.PayrollSidebarDraftGate.create();
  reopened.load({ valid: true, runId: 'RUN-RETRY', state: 'DRAFT', retryableApproval: true });
  assert.equal(reopened.canRetry(), true);
  assert.equal(reopened.runId(), 'RUN-RETRY');
  reopened.load(null);
  assert.equal(reopened.isFrozen(), false);
  assert.equal(reopened.runId(), null);
});

test('draft values can be edited only before approval starts and a frozen retry uses saved values', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  const gate = context.PayrollSidebarDraftGate.create();
  gate.load({ valid: true, runId: 'RUN-1', state: 'DRAFT' });
  assert.equal(gate.canEdit(), true);
  gate.beginApproval();
  assert.equal(gate.canEdit(), false);
  gate.approvalFailed(true);
  assert.equal(gate.canEdit(), false);
  assert.equal(gate.canRetry(), true);
  gate.markDirty();
  assert.equal(gate.canRetry(), true);
});

test('save failure restores pending edits only when the authoritative run is still editable', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  const restore = context.PayrollSidebarCanRestoreEdits;
  assert.equal(restore({ valid: true, state: 'DRAFT', retryableApproval: false }), true);
  assert.equal(restore({ valid: true, state: 'DRAFT', retryableApproval: true }), false);
  assert.equal(restore({ valid: true, state: 'APPROVED', retryableApproval: true }), false);
});

test('approval retry excludes acknowledgment and authorization failures even if the run has a checkpoint', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const firstScript = html.match(/<script>([\s\S]*?)<\/script>/);
  const context = vm.createContext({});
  vm.runInContext(firstScript[1], context);
  const classify = context.PayrollSidebarApprovalRetryable;
  assert.equal(classify({ valid: false, resumable: true, errors: [{ code: 'WRITE_ERROR' }] }, null), true);
  assert.equal(classify({ valid: false, errors: [{ code: 'APPROVER_NOT_AUTHORIZED' }] }, { valid: true, retryableApproval: true }), false);
  assert.equal(classify({ valid: false, errors: [{ code: 'ACK_REQUIRED' }] }, { valid: true, retryableApproval: true }), false);
});

test('partial All-run failures are named with reasons and require explicit acknowledgment', () => {
  const notice = createPartialRunNotice();
  notice.setReport({ failedDepartments: ['RESERVATIONS'], partialDepartmentsFingerprint: 'partial-v1', departmentErrors: [
    { department: 'RESERVATIONS', message: 'Reservations workbook unavailable' }
  ] });

  assert.equal(notice.message(), 'Partial payroll: RESERVATIONS omitted — Reservations workbook unavailable.');
  assert.equal(notice.isRequired(), true);
  assert.equal(notice.canContinue(), false);
  notice.setAcknowledged(true);
  assert.equal(notice.canContinue(), true);
  assert.equal(notice.acknowledgements().partialDepartmentsFingerprint, 'partial-v1');
  notice.setReport({ failedDepartments: ['RESERVATIONS', 'SURVEY'], partialDepartmentsFingerprint: 'partial-v2', departmentErrors: [] });
  assert.equal(notice.canContinue(), false);
  assert.equal(notice.acknowledgements().partialDepartmentsFingerprint, null);
});

test('employee omissions are named and require the exact server fingerprint even without department failures', () => {
  const notice = createPartialRunNotice();
  notice.setReport({ failedEmployees: [{ department: 'SURVEY', employeeId: 'EMP-7' }],
    employeeErrors: [{ employeeId: 'EMP-7', message: 'Referral identity unavailable' }], partialDepartmentsFingerprint: 'server-v1' });
  assert.match(notice.message(), /SURVEY employee EMP-7 omitted — Referral identity unavailable/);
  assert.equal(notice.isRequired(), true);
  assert.equal(notice.canContinue(), false);
  notice.setAcknowledged(true);
  assert.equal(notice.acknowledgements().partialDepartmentsFingerprint, 'server-v1');
  notice.setReport({ failedEmployees: [{ department: 'SURVEY', employeeId: 'EMP-7' }],
    employeeErrors: [], partialDepartmentsFingerprint: 'server-v2' });
  assert.equal(notice.canContinue(), false);
});

test('partial-run details are rendered before the sidebar allows draft or approval', () => {
  const sidebar = fs.readFileSync(require.resolve('../src/PayrollSidebar.html'), 'utf8');
  const scripts = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  assert.match(sidebar, /id="partialDepartmentDetails"/);
  assert.match(sidebar, /id="partialDepartmentAck"/);
  assert.match(sidebar, /id="continuePartialRun"/);
  assert.match(scripts, /partialRunNotice\.message\(\)/);
  assert.match(scripts, /partialRunNotice\.canContinue\(\)/);
  assert.match(scripts, /acknowledgements: partialRunNotice\.acknowledgements\(\)/);
  assert.match(scripts, /Partial payroll — omitted departments/);
});

test('sidebar wires dated holiday payload, authoritative saves, retry and resume controls', () => {
  const sidebar = fs.readFileSync(require.resolve('../src/PayrollSidebar.html'), 'utf8');
  const scripts = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  ['holidayDate', 'resumeRunId', 'resumeRun', 'retryApproval', 'draftOmissionDetails'].forEach(id =>
    assert.match(sidebar, new RegExp(`id="${id}"`)));
  assert.match(scripts, /dates: holidayDecisions\.payload\(\)/);
  assert.match(scripts, /result\.valid === false\) throw/);
  assert.match(scripts, /invokeServer\('getRunState', \{ runId: state\.draft\.runId \}\)/);
  assert.match(scripts, /draftGate\.markDirty\(\)/);
  assert.match(scripts, /submitApproval\(true\)/);
  assert.doesNotMatch(scripts, /selectDepartment\('SALES'\)/);
});

test('frozen sidebar controls cannot expose unsaved edits while Retry approves saved values', () => {
  const sidebar = fs.readFileSync(require.resolve('../src/PayrollSidebar.html'), 'utf8');
  const scripts = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  assert.match(sidebar, /Retry approval of frozen values/);
  assert.match(scripts, /byId\('saveDraftEdits'\)\.disabled = !draftGate\.canEdit\(\)/);
  assert.match(scripts, /input\.disabled = !draftGate\.canEdit\(\)/);
  assert.match(scripts, /if \(!PayrollSidebarCanRestoreEdits\(saved\)\)/);
  assert.ok(scripts.indexOf('if (!PayrollSidebarCanRestoreEdits(saved))') < scripts.indexOf('desiredChanges.forEach(function (change)'));
  assert.match(scripts, /function submitApproval[\s\S]*?if \(saved && saved\.valid && retryable\) renderDraft\(saved\)/);
  assert.doesNotMatch(scripts, /input\.disabled = false/);
});

test('new name reports retain earlier unresolved attempts independently', () => {
  const tracker = createTracker();
  const first = tracker.add({ matches: [{ employeeId: 'EMP-1', americanName: 'Alex Smith' }], ambiguous: [], unmatched: [] });
  const second = tracker.add({ matches: [{ employeeId: 'EMP-2', americanName: 'Jamie Doe' }], ambiguous: [], unmatched: [] });

  assert.notEqual(first, second);
  assert.equal(tracker.unresolvedCount(), 2);
  assert.deepEqual(Array.from(tracker.confirmMatches(second)), ['EMP-2']);
  assert.equal(tracker.unresolvedCount(), 1);
  assert.deepEqual(Array.from(tracker.confirmMatches(second)), []);
  assert.equal(tracker.unresolvedCount(), 1);
});

test('manual resolution only clears issues for its own attempt', () => {
  const tracker = createTracker();
  const first = tracker.add({ matches: [], ambiguous: [{ candidates: [{ employeeId: 'EMP-1' }] }], unmatched: [{ status: 'UNMATCHED' }] });
  const second = tracker.add({ matches: [{ employeeId: 'EMP-2', americanName: 'Jamie Doe' }], ambiguous: [], unmatched: [] });

  assert.equal(tracker.unresolvedCount(), 3);
  assert.deepEqual(Array.from(tracker.resolveManual(first, 0, ['EMP-1'])), ['EMP-1']);
  assert.equal(tracker.unresolvedCount(), 2);
  assert.deepEqual(Array.from(tracker.resolveManual(first, 0, ['EMP-1'])), []);
  assert.equal(tracker.unresolvedCount(), 2);
  assert.deepEqual(Array.from(tracker.resolveManual(first, 1, ['EMP-1'])), ['EMP-1']);
  assert.equal(tracker.unresolvedCount(), 1);
  assert.deepEqual(Array.from(tracker.confirmMatches(second)), ['EMP-2']);
  assert.equal(tracker.unresolvedCount(), 0);
});

test('sidebar script blocks remain valid JavaScript', () => {
  const html = fs.readFileSync(require.resolve('../src/SidebarScripts.html'), 'utf8');
  const scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g));
  assert.equal(scripts.length, 2);
  scripts.forEach(script => new vm.Script(script[1]));
});
