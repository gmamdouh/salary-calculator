# Task 7 Report — Master Workbook Setup and Result Rendering

## RED/GREEN evidence

- RED command: `node --test tests/workbook-setup.test.js`
- RED output: 4 tests, 0 passed, 4 failed. Each failed with `TypeError` because `WorkbookSetup` was undefined, confirming the requested missing public interface.
- GREEN focused command: `node --test tests/workbook-setup.test.js`
- GREEN output: 4 tests, 4 passed, 0 failed.
- Full command: `npm test`
- Full output: 104 tests, 104 passed, 0 failed.
- Patch check: `git diff --check` exited 0; Git emitted only its LF-to-CRLF normalization warning for `src/70_SpreadsheetGateway.js`.

## Files changed

- `src/110_WorkbookSetup.js`: managed tab schemas, idempotent initialization, default salary/commission rules, exact 2027 holiday rows, protections, output sections, history rows, and protected technical run snapshots.
- `src/70_SpreadsheetGateway.js`: master sheet batch write/clear, format, and idempotent protection helpers.
- `tests/workbook-setup.test.js`: fake-spreadsheet tests for managed tabs and every stable header, rules and holiday seeds, protections and idempotence, active/final-settlement output separation, American-name-only visible output, and history snapshot retention.

## Self-review

- Repeated initialization retains the same tabs, data dimensions, and protections.
- Visible latest results and payroll history render American names only; Employee IDs remain in protected audit/history columns. Full run JSON is stored in the hidden, protected `Payroll Runs` tab.
- History appends are idempotent per run/version/state/employee, and the protected technical snapshot is independently deduplicated per run/version/state.
- Salary defaults include all 25 Sales commission cells and the quarterly Sales cycle. Holiday rows match all 13 approved 2027 entries and display dates as `DD-MM-YYYY`.

## Concerns

- No live spreadsheet IDs were available, so validation used only the fake spreadsheet as requested. Apps Script protection and date rendering still need confirmation in a real master workbook.
- `git diff --check` reports that Git may normalize the modified gateway file from LF to CRLF; it did not report whitespace errors.

## Fix round 1 evidence

- Required fixes: active Latest Results headers and rows omit Annual Balance and the Final Settlement column; final settlement output has its own headers including Annual Balance; Sales quarterly payment months are left unset with an explanatory note; tests assert literal managed-tab headers and literal active/final section headers.
- Focused command: `node --test tests/workbook-setup.test.js`
- Focused output: 4 tests, 4 passed, 0 failed.
- Full command: `npm test`
- Full output: 104 tests, 104 passed, 0 failed.
- Patch check: `git diff --check` exited 0; Git emitted only LF-to-CRLF normalization warnings for `src/110_WorkbookSetup.js` and `tests/workbook-setup.test.js`.
- Commit: pending at report update time.
