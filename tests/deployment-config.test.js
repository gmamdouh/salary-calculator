const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('clasp ignore allowlist uses paths relative to src rootDir', () => {
  const root = path.join(__dirname, '..');
  const rules = fs.readFileSync(path.join(root, '.claspignore'), 'utf8').trim().split(/\r?\n/);
  assert.deepEqual(rules, ['**/**', '!*.js', '!*.html', '!appsscript.json']);
  const source = fs.readdirSync(path.join(root, 'src'));
  assert.ok(source.includes('00_Namespace.js'));
  assert.ok(source.includes('PayrollSidebar.html'));
  assert.ok(source.includes('appsscript.json'));
});
