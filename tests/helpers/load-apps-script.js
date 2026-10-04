const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function loadAppsScript(globals = {}) {
  const context = vm.createContext({ ...globals });
  const sourceDir = path.resolve(__dirname, '../../src');
  for (const file of fs.readdirSync(sourceDir).filter(name => name.endsWith('.js')).sort()) {
    vm.runInContext(fs.readFileSync(path.join(sourceDir, file), 'utf8'), context, { filename: file });
  }
  return context.SalaryCalculator || {};
}
module.exports = { loadAppsScript };
