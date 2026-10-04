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
