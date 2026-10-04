# Salary Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a tested Google Sheets and Apps Script payroll tool for Survey, Reservations, Sales, TDS, and Management with configurable external sources, guided draft/approval workflow, permanent history, OCR-assisted holiday selection, and safe write-back.

**Architecture:** A container-bound Apps Script project owns a thin spreadsheet/UI shell around a pure JavaScript payroll domain engine. Department adapters normalize different source workbook and Leave Tracker layouts into canonical records; an orchestrator calculates immutable run snapshots, while a repository layer controls drafts, overrides, approval, ledgers, and idempotent write-back.

**Tech Stack:** Google Apps Script V8, Google Sheets, HTML Service, Google Drive, Cloud Vision REST API, JavaScript, Node.js built-in test runner, clasp.

**Spec:** `outputs/salary-calculator-design-spec.md`

## Global Constraints

- All user-facing employee names display the American name only; Employee ID is the permanent key.
- Full eligible months pay fixed monthly amounts regardless of calendar length; partial months use monthly amount ÷ 30 with inclusive dates and a monthly cap.
- Days 1–90 use before-probation rates; day 91 onward uses after-probation rates.
- Survey and Reservations alone may receive the HR-approved one-time EGP 12,000 probation payment.
- Reservations commission is progressive; Sales commission is non-progressive and uses the final 1–19, 20–29, 30–39, 40–49, or 50+ bracket.
- TDS and Management have no ABS.
- Drafts are editable only with a required override reason; approved runs are immutable.
- Draft calculation never writes paid flags; only approval performs controlled write-back.
- Every approved operation is idempotent and keyed by run ID plus benefit identity.
- Holiday screenshots and OCR evidence are retained in a restricted Drive audit folder.
- Live `clasp push` is forbidden until the exact local folder and Apps Script project ID are displayed and explicitly confirmed in the same turn.

## Review Focus

- **Ambiguous employee matching:** duplicate or missing Employee IDs must block the affected department; Task 5 pins this with mapping validation tests.
- **Month-edge proration:** inclusive dates, leap February, 31-day caps, current-month cutoff, and mid-month day-91 transitions must remain exact; Tasks 2 and 4 pin these cases.
- **Duplicate money:** approval retries, concurrent approval, and repeated referral/probation candidates must never produce duplicate ledger entries; Tasks 6 and 9 pin these failures.
- **Partial-month attendance:** joiners and leavers are exempt from the 17/15-day threshold but not from NS; Tasks 3 and 4 pin the distinction.
- **Uncertain OCR:** unmatched or ambiguous American names must block holiday application until human confirmation; Task 8 pins exact, ambiguous, and unmatched cases.

---

## File Structure

- `package.json` — local scripts for the Node test suite.
- `.gitignore` — ignores generated coverage, local secrets, clasp credentials, and visual-companion files.
- `.claspignore` — restricts future push scope to Apps Script source files.
- `src/appsscript.json` — Apps Script V8 manifest and required scopes.
- `src/00_Namespace.js` — global `SalaryCalculator` namespace and immutable constants.
- `src/10_Contracts.js` — JSDoc canonical record and result contracts plus runtime assertions.
- `src/20_PayrollPeriod.js` — month/cutoff, employment windows, fixed-30 proration, and probation segmentation.
- `src/30_Commission.js` — Survey, Reservations, Sales, and TDS commission functions.
- `src/40_Eligibility.js` — ABS, NS, probation-payment, referral, holiday, off-day, and final-settlement eligibility.
- `src/50_PayrollEngine.js` — pure per-employee calculation and final component total.
- `src/60_MappingConfig.js` — mapping schema, validation, and normalized configuration.
- `src/70_SpreadsheetGateway.js` — batch reads/writes against external workbooks and Leave Trackers.
- `src/80_RunRepository.js` — drafts, immutable history, payment ledger, overrides, and idempotent approval persistence.
- `src/90_OcrService.js` — Drive evidence storage, Cloud Vision call, name extraction, and confirmation candidates.
- `src/100_PayrollOrchestrator.js` — validates, normalizes, calculates, saves drafts, and finalizes runs.
- `src/110_WorkbookSetup.js` — creates/protects master tabs, headers, validation lists, and default rule rows.
- `src/120_MenuAndApi.js` — `onOpen`, sidebar launch, and server functions called by the UI.
- `src/PayrollSidebar.html` — five-step setup/validation/decisions/draft/approval UI.
- `src/SidebarStyles.html` — sidebar styles.
- `src/SidebarScripts.html` — client-side state, rendering, editable draft controls, and server calls.
- `tests/helpers/load-apps-script.js` — loads Apps Script global files into a Node VM.
- `tests/helpers/fixtures.js` — canonical employees, rules, attendance, and run fixtures.
- `tests/contracts.test.js`
- `tests/payroll-period.test.js`
- `tests/commission.test.js`
- `tests/eligibility.test.js`
- `tests/payroll-engine.test.js`
- `tests/mapping-config.test.js`
- `tests/run-repository.test.js`
- `tests/ocr-service.test.js`
- `tests/orchestrator.test.js`
- `tests/workbook-setup.test.js`
- `README.md` — local testing, spreadsheet setup, mappings, Cloud Vision, and deployment preflight.

### Task 1: Project Skeleton and Canonical Contracts

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `.claspignore`
- Create: `src/appsscript.json`
- Create: `src/00_Namespace.js`
- Create: `src/10_Contracts.js`
- Create: `tests/helpers/load-apps-script.js`
- Create: `tests/helpers/fixtures.js`
- Create: `tests/contracts.test.js`

**Interfaces:**
- Consumes: Approved design spec.
- Produces: `SalaryCalculator.Constants`, `SalaryCalculator.Contracts.assertEmployee(record)`, `assertRules(rules)`, `assertDecisionSet(decisions)`, and canonical fixture builders used by every later task.

- [ ] **Step 1: Initialize version control and test scripts**

Initialize Git in the workspace. Add `npm test` as `node --test tests/*.test.js`; require no runtime npm dependencies.

- [ ] **Step 2: Write failing contract tests**

Cover a valid canonical employee and rejection of missing Employee ID, American name, department, first working day, invalid last working day, and nonnumeric performance fields.

- [ ] **Step 3: Run the contract test and verify failure**

Run: `node --test tests/contracts.test.js`  
Expected: FAIL because `SalaryCalculator.Contracts` is undefined.

- [ ] **Step 4: Implement the namespace, constants, contracts, manifest, and VM loader**

Define exact department constants `SURVEY`, `RESERVATIONS`, `SALES`, `TDS`, `MANAGEMENT`; cutoff modes `TODAY` and `MONTH_END`; run states `DRAFT`, `APPROVED`, and `SUPERSEDED`. Use JSDoc records and runtime assertions with Employee ID as the required key.

- [ ] **Step 5: Run the test suite**

Run: `npm test`  
Expected: all Task 1 tests PASS.

- [ ] **Step 6: Commit**

`git add package.json .gitignore .claspignore src tests && git commit -m "chore: scaffold salary calculator contracts"`

### Task 2: Payroll Period, Inclusive Dates, and Probation Segments

**Files:**
- Create: `src/20_PayrollPeriod.js`
- Create: `tests/payroll-period.test.js`
- Modify: `tests/helpers/fixtures.js`

**Interfaces:**
- Consumes: Canonical employee contracts and cutoff constants.
- Produces:
  - `PayrollPeriod.buildPeriod({ payrollMonth, cutoffMode, today }): PayrollPeriodRecord`
  - `PayrollPeriod.getEmploymentWindow(employee, period): EmploymentWindow | null`
  - `PayrollPeriod.splitProbation(window, firstWorkingDay): ProbationSegment[]`
  - `PayrollPeriod.prorate(monthlyAmount, eligibleDays, isFullEligibleMonth): number`

- [ ] **Step 1: Write failing period tests**

Assert: previous/current month boundaries; February 2027; leap February; September 5–30 equals 26 days; first/last days are inclusive; a full 31-day month pays the fixed monthly value; partial results never exceed monthly value; future months reject; TODAY caps a current month; day 90/day 91 split exactly.

- [ ] **Step 2: Run the period tests and verify failure**

Run: `node --test tests/payroll-period.test.js`  
Expected: FAIL because `PayrollPeriod` is undefined.

- [ ] **Step 3: Implement the four period interfaces**

Use date-only UTC arithmetic internally to avoid timezone/DST shifts. Treat day 1 as the first working date and day 91 as first working date plus 90 calendar days.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/payroll-period.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 5: Commit**

`git add src/20_PayrollPeriod.js tests && git commit -m "feat: add fixed-30 payroll period logic"`

### Task 3: Department Commission and Attendance Eligibility

**Files:**
- Create: `src/30_Commission.js`
- Create: `src/40_Eligibility.js`
- Create: `tests/commission.test.js`
- Create: `tests/eligibility.test.js`
- Modify: `tests/helpers/fixtures.js`

**Interfaces:**
- Consumes: Department constants, normalized performance and attendance records, payroll period.
- Produces:
  - `Commission.calculateSurvey(transfers): number`
  - `Commission.calculateReservations(transfers): number`
  - `Commission.calculateSales(sales, conversionRate): { ratePerSale, amount, band }`
  - `Commission.calculateTds(agents): { qualifyingCount, amount }`
  - `Eligibility.evaluateAbs(employee, attendance, period): AbsDecision`
  - `Eligibility.calculateNoShowDeduction(nsPresent, basicDailyRate): number`
  - `Eligibility.calculateExtraDayUnits(workedOffDays, workedHolidays): ExtraDayDecision`
  - `Eligibility.evaluateProbationPayment(employee, ledger, decision): BenefitDecision`
  - `Eligibility.evaluateReferral(referrer, referred, paymentDate, ledger): BenefitDecision`

- [ ] **Step 1: Write failing commission tests**

Pin every bracket boundary: Survey 0, 1, 200, 201, 300, 301, 350, 351, 400, 401, 500, 501; Reservations progressive boundaries; Sales every conversion boundary and sales bracket including 0, 19, 20, 29, 30, 39, 40, 49, 50; 4.2%/37 = 24,050; 6.1%/53 = 68,900; TDS exactly 75 is not qualifying and 76 is.

- [ ] **Step 2: Run commission tests and verify failure**

Run: `node --test tests/commission.test.js`  
Expected: FAIL because `Commission` is undefined.

- [ ] **Step 3: Implement commission functions**

Round Sales conversion rate to two decimals before lookup. Reject negative or nonnumeric counts.

- [ ] **Step 4: Write failing eligibility tests**

Assert: full-month 16/14 attended days fail normal/February thresholds; 17/15 pass; more than five leave days fails; partial joiner/leaver bypasses the attendance threshold; NS still removes ABS and deducts three Basic days; one off-day plus one holiday produces three units across different dates; overlapping off-day/holiday produces two units; former referrer cutoff; duplicate benefit ledger blocks payment.

- [ ] **Step 5: Implement eligibility functions**

Return structured decisions with `eligible`, `amount`, `reasonCode`, and human-readable `note`; do not mutate ledgers.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/commission.test.js tests/eligibility.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

`git add src/30_Commission.js src/40_Eligibility.js tests && git commit -m "feat: add commission and eligibility rules"`

### Task 4: Pure Payroll Engine and Final Settlements

**Files:**
- Create: `src/50_PayrollEngine.js`
- Create: `tests/payroll-engine.test.js`
- Modify: `tests/helpers/fixtures.js`

**Interfaces:**
- Consumes: `PayrollPeriod`, `Commission`, `Eligibility`, canonical employee/attendance/performance/decision/rules records.
- Produces:
  - `PayrollEngine.calculateEmployee({ employee, attendance, performance, decisions, rules, period, ledger }): PayrollResult`
  - `PayrollEngine.sumComponents(components): number`

- [ ] **Step 1: Write failing end-to-end employee calculation tests**

Cover Survey before probation; month split at day 91; Reservations progressive commission; Sales quarterly accrual and a failed month removing only that month's EGP 4,000/prorated accrual; TDS commission; Management without ABS; active sample total EGP 15,000; final-settlement sample total EGP 16,600; annual balance at departure Basic rate; deductions; referral; probation payment; and component rounding to two decimals.

- [ ] **Step 2: Add review-focus edge tests**

Assert partial joiners/leavers retain prorated ABS despite low attendance, NS still removes it, a 31-day full month does not overpay, and a same-run duplicate benefit cannot be included twice.

- [ ] **Step 3: Run engine tests and verify failure**

Run: `node --test tests/payroll-engine.test.js`  
Expected: FAIL because `PayrollEngine` is undefined.

- [ ] **Step 4: Implement calculation order**

Implement the twelve-step order from the spec. Return component amounts, units/days, automatic notes, benefit candidates, warnings, and total without any spreadsheet side effects.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/payroll-engine.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

`git add src/50_PayrollEngine.js tests && git commit -m "feat: calculate auditable employee payroll"`

### Task 5: Configurable Source Mappings and Spreadsheet Gateway

**Files:**
- Create: `src/60_MappingConfig.js`
- Create: `src/70_SpreadsheetGateway.js`
- Create: `tests/mapping-config.test.js`
- Modify: `tests/helpers/fixtures.js`

**Interfaces:**
- Consumes: Canonical contracts and master Sources & Mappings rows.
- Produces:
  - `MappingConfig.parse(rows): DepartmentConfig[]`
  - `MappingConfig.validate(configs): ValidationReport`
  - `MappingConfig.normalizeEmployee(row, mapping): EmployeeRecord`
  - `MappingConfig.normalizeAttendance(rows, mapping, period): AttendanceRecord[]`
  - `SpreadsheetGateway.readDepartment(config, period): RawDepartmentBundle`
  - `SpreadsheetGateway.validateAccess(config): AccessReport`
  - `SpreadsheetGateway.writeApprovalState(config, writes): WriteReport`

- [ ] **Step 1: Write failing mapping tests**

Use two deliberately different department layouts. Assert both normalize to the same contract; duplicate/missing Employee IDs block; missing required headers block; invalid dates/numbers report exact source coordinates; real names remain internal while output identity uses American name.

- [ ] **Step 2: Run mapping tests and verify failure**

Run: `node --test tests/mapping-config.test.js`  
Expected: FAIL because `MappingConfig` is undefined.

- [ ] **Step 3: Implement mapping parsing, validation, and normalization**

Keep mapping logic pure. Accept spreadsheet ID or URL and normalize to ID. Do not use row position as identity.

- [ ] **Step 4: Implement batch spreadsheet gateway**

Use `SpreadsheetApp.openById`, `getDisplayValues`/typed values as appropriate, and batched `setValues`; isolate Apps Script globals behind the gateway so tests can inject fakes.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/mapping-config.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

`git add src/60_MappingConfig.js src/70_SpreadsheetGateway.js tests && git commit -m "feat: normalize configurable payroll sources"`

### Task 6: Drafts, Overrides, History, and Idempotent Ledgers

**Files:**
- Create: `src/80_RunRepository.js`
- Create: `tests/run-repository.test.js`
- Modify: `src/10_Contracts.js`
- Modify: `tests/helpers/fixtures.js`

**Interfaces:**
- Consumes: Payroll results, source snapshots, decisions, and repository sheet gateway.
- Produces:
  - `RunRepository.createDraft(run): RunRecord`
  - `RunRepository.applyOverride(runId, employeeId, component, value, reason, editor): OverrideRecord`
  - `RunRepository.approve(runId, approver): ApprovalResult`
  - `RunRepository.supersede(approvedRunId, replacementRunId): void`
  - `RunRepository.hasBenefit(benefitKey): boolean`
  - `RunRepository.makeBenefitKey(type, employeeId, relatedEmployeeId?): string`

- [ ] **Step 1: Write failing repository tests**

Assert: draft creation preserves source snapshot/rules version; missing override reason rejects; original and edited values persist; approved run rejects edits; approval retry returns the same result without duplicate history/ledger rows; probation and referral keys are unique; superseded versions remain readable.

- [ ] **Step 2: Add concurrency/idempotency contract test**

Use a fake lock and two approval calls for the same run; assert only one approval write set and one benefit-ledger set is produced.

- [ ] **Step 3: Run repository tests and verify failure**

Run: `node --test tests/run-repository.test.js`  
Expected: FAIL because `RunRepository` is undefined.

- [ ] **Step 4: Implement repository and transactional approval**

Wrap final approval in `LockService.getDocumentLock()`; re-read run state after acquiring the lock; write history and ledger before controlled source status updates; return a resumable error if source write-back fails.

- [ ] **Step 5: Run focused and full tests**

Run: `node --test tests/run-repository.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 6: Commit**

`git add src/10_Contracts.js src/80_RunRepository.js tests && git commit -m "feat: add audited payroll run lifecycle"`

### Task 7: Master Workbook Setup and Result Rendering

**Files:**
- Create: `src/110_WorkbookSetup.js`
- Create: `tests/workbook-setup.test.js`
- Modify: `src/70_SpreadsheetGateway.js`

**Interfaces:**
- Consumes: Design tab schema, salary rules, holiday list, PayrollResult and RunRecord.
- Produces:
  - `WorkbookSetup.initialize(spreadsheet): SetupReport`
  - `WorkbookSetup.ensureManagedSheets(spreadsheet): SheetMap`
  - `WorkbookSetup.seedDefaultRules(sheetMap): void`
  - `WorkbookSetup.seedHolidayCalendar(sheetMap): void`
  - `WorkbookSetup.renderLatestResults(sheetMap, run): void`
  - `WorkbookSetup.appendHistory(sheetMap, run): void`

- [ ] **Step 1: Write failing workbook-schema tests**

With a fake spreadsheet, assert exact managed tab names, stable headers, protected technical ranges, idempotent repeated initialization, 2027 holiday rows, and separate active/final-settlement output sections.

- [ ] **Step 2: Run setup tests and verify failure**

Run: `node --test tests/workbook-setup.test.js`  
Expected: FAIL because `WorkbookSetup` is undefined.

- [ ] **Step 3: Implement initialization and rendering**

Seed the exact 2027 holiday data from the spec. Format EGP columns and dates; display American names only; retain Employee ID in protected audit/history data.

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/workbook-setup.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 5: Commit**

`git add src/110_WorkbookSetup.js src/70_SpreadsheetGateway.js tests && git commit -m "feat: initialize payroll workbook outputs"`

### Task 8: Cloud Vision OCR and Holiday Decision UI

**Files:**
- Create: `src/90_OcrService.js`
- Create: `tests/ocr-service.test.js`
- Create: `src/PayrollSidebar.html`
- Create: `src/SidebarStyles.html`
- Create: `src/SidebarScripts.html`

**Interfaces:**
- Consumes: Uploaded screenshot blob, configured audit folder, Cloud Vision response, current employee list.
- Produces:
  - `OcrService.storeEvidence(blob, runId, actor): EvidenceRecord`
  - `OcrService.extractText(blob): OcrTextResult`
  - `OcrService.matchAmericanNames(text, employees): NameMatchReport`
  - Sidebar decision payload matching `Contracts.assertDecisionSet`.

- [ ] **Step 1: Write failing OCR matching tests**

Assert exact American-name match, case/spacing normalization, real-name non-display, ambiguous partial match, unmatched name, duplicate American-name warning, and confirmation required before inclusion.

- [ ] **Step 2: Run OCR tests and verify failure**

Run: `node --test tests/ocr-service.test.js`  
Expected: FAIL because `OcrService` is undefined.

- [ ] **Step 3: Implement evidence storage, Vision request, and pure matching**

Store the original screenshot first; call Cloud Vision `TEXT_DETECTION` through `UrlFetchApp`; keep credentials/settings in Script Properties; never auto-accept ambiguous matches.

- [ ] **Step 4: Build the five-step sidebar**

Implement Setup, Validate, Decisions, Draft, and Approve views. Include searchable employee selection, pasted names, screenshot upload, Select All Survey, Select All Reservations, and no Select All Sales.

- [ ] **Step 5: Add draft editing safeguards**

A changed amount cannot proceed without a nonblank reason; show original and edited values; show blocking OCR and validation errors.

- [ ] **Step 6: Run full tests and static contract checks**

Run: `npm test`  
Expected: all tests PASS and HTML includes the five named steps and required server API calls.

- [ ] **Step 7: Commit**

`git add src/90_OcrService.js src/*.html tests && git commit -m "feat: add payroll wizard and holiday OCR"`

### Task 9: Orchestration, Menu API, and Safe Approval Write-Back

**Files:**
- Create: `src/100_PayrollOrchestrator.js`
- Create: `src/120_MenuAndApi.js`
- Create: `tests/orchestrator.test.js`
- Modify: `src/80_RunRepository.js`
- Modify: `src/PayrollSidebar.html`
- Modify: `src/SidebarScripts.html`

**Interfaces:**
- Consumes: All earlier module interfaces.
- Produces:
  - `PayrollOrchestrator.validateRequest(request): ValidationReport`
  - `PayrollOrchestrator.calculateDraft(request): RunRecord`
  - `PayrollOrchestrator.approveRun(runId, approver): ApprovalResult`
  - Apps Script globals `onOpen()`, `showPayrollSidebar()`, `getRunSetup()`, `validateRun(request)`, `calculateDraft(request)`, `saveOverride(request)`, and `approveRun(runId)`.

- [ ] **Step 1: Write failing orchestration tests**

With fake gateways, cover one department, All departments, one-department failure isolation, source snapshot preservation, unresolved decision blocking, successful draft, approval, source write-back, and approval retry.

- [ ] **Step 2: Add review-focus integration tests**

Assert duplicate Employee IDs block only the affected department; an ambiguous OCR match blocks approval; simultaneous approval attempts create one final run; source write-back failure leaves a recoverable approved-history state without duplicate payments on retry.

- [ ] **Step 3: Run orchestration tests and verify failure**

Run: `node --test tests/orchestrator.test.js`  
Expected: FAIL because `PayrollOrchestrator` is undefined.

- [ ] **Step 4: Implement orchestrator and global API**

Keep global functions thin. Use dependency injection for gateways, OCR, clock, and actor identity. Return structured errors to the sidebar.

- [ ] **Step 5: Implement custom menu and Dashboard button binding target**

Add menu items for Run Payroll, Open Latest Results, Configuration Check, and Initialize/Repair Workbook. Expose `showPayrollSidebar` as the drawing/button target.

- [ ] **Step 6: Run focused and full tests**

Run: `node --test tests/orchestrator.test.js && npm test`  
Expected: all tests PASS.

- [ ] **Step 7: Commit**

`git add src tests && git commit -m "feat: orchestrate payroll drafts and approval"`

### Task 10: Documentation, End-to-End Fixtures, and Deployment Preflight

**Files:**
- Create: `README.md`
- Create: `tests/end-to-end.test.js`
- Modify: `.claspignore`
- Modify: `src/appsscript.json`
- Modify: all files only as required by verification failures.

**Interfaces:**
- Consumes: Complete application and approved spec.
- Produces: Reproducible local verification, live-integration checklist, and a preflight-ready Apps Script folder.

- [ ] **Step 1: Write end-to-end fixture tests**

Create one representative employee for each department plus active/final-settlement, probation, NS, referral, Sales quarterly ABS, holiday, override, and approval scenarios. Assert complete component breakdowns and history/ledger results.

- [ ] **Step 2: Run the end-to-end test and fix only demonstrated failures**

Run: `node --test tests/end-to-end.test.js`  
Expected: all scenario assertions PASS.

- [ ] **Step 3: Write README setup instructions**

Document Node tests, master workbook initialization, source mappings, Employee ID requirements, Leave Tracker mappings, quarterly Sales cycle, Cloud Vision/Drive setup, approver list, draft/approval flow, and recovery from source write-back failure.

- [ ] **Step 4: Run full local verification**

Run: `npm test`  
Expected: all tests PASS with zero failures.

- [ ] **Step 5: Validate deployment files**

Parse `src/appsscript.json` as JSON, scan source for unresolved markers/conflict markers, and run `clasp status` only after a valid `.clasp.json` exists.

- [ ] **Step 6: Compare representative results manually**

Verify at minimum: Sales 4.2%/37 = EGP 24,050; Sales 6.1%/53 = EGP 68,900; active sample = EGP 15,000; final-settlement sample = EGP 16,600.

- [ ] **Step 7: Commit**

`git add . && git commit -m "docs: complete salary calculator verification and setup"`

- [ ] **Step 8: Stop before live push**

Run the Apps Script deployment preflight. Display the resolved local folder, detected script ID/rootDir, login state, push scope, Git state, and test results. Ask exactly: `Push folder <path> to Apps Script project <scriptId> now?` Proceed only after explicit confirmation.

