# Salary Calculator — Google Sheets and Apps Script Design Specification

**Date:** 2026-10-04  
**Status:** Design approved in conversation; written specification awaiting review

## 1. Purpose

Build a master Google Sheets payroll tool, powered by Google Apps Script, that calculates monthly payroll for Survey, Reservations, Sales, TDS, and Management.

An HR user starts a run from a button or custom menu, selects a department or All, selects the payroll month and cutoff, resolves required eligibility decisions, reviews an editable draft, and approves the payroll. The system keeps permanent calculation history and writes controlled status records back to the relevant department source workbook.

All user-facing payroll screens and outputs display the employee's American name only. Unique Employee ID is the permanent matching key. Real names may be read internally for reconciliation but are not displayed.

## 2. System Architecture

The solution consists of one master Salary Calculator workbook with a container-bound Apps Script project.

The master workbook reads from two external workbooks per department:

1. Department employee and performance workbook.
2. Department Leave Tracker workbook.

Each department may use a different workbook layout. A configurable mapping layer translates department-specific tabs and columns into a single canonical payroll record.

The master workbook owns:

- Run interface and guided sidebar.
- Source and column mappings.
- Salary and commission rules.
- Holiday calendar.
- Latest results.
- Payroll history.
- Payment ledger.
- Override audit.
- OCR evidence and matching decisions.

Draft calculation never marks a payment as paid. Only final approval locks a run and performs controlled write-back.

## 3. Departments and Roles

The selectable run scopes are:

- Survey
- Reservations
- Sales
- TDS
- Management
- All

TDS is the only valid role name; CDS and TCS are excluded.

## 4. Workbook Tabs

The master workbook contains the following managed tabs:

- **Dashboard:** Run Payroll button, recent runs, warnings, and links to drafts.
- **Sources & Mappings:** Department workbook IDs, Leave Tracker workbook IDs, tab names, column mappings, and access checks.
- **Salary Rules:** Configurable salary amounts, ABS amounts, commission matrices, thresholds, and quarterly Sales cycle.
- **Holiday Calendar:** Occasion date, actual holiday date or range, number of days, triple-pay flag, and confirmed/estimated status.
- **Latest Results:** The most recent payroll output, separated into active employees and final settlements.
- **Payroll History:** Immutable snapshots for every draft and approved version.
- **Payment Ledger:** Probation and referral eligibility, decisions, payment dates, and duplicate-prevention keys.
- **Override Audit:** Original values, edited values, reason, editor, and timestamp.
- **Run Decisions:** Holiday eligibility, OCR evidence, probation decisions, acknowledged warnings, and approval metadata.

Protected technical tabs may be hidden from ordinary users but remain auditable.

## 5. Run Payroll Workflow

### 5.1 Setup

The Run Payroll button opens a guided sidebar.

The user selects:

- Payroll month, defaulting to the previous calendar month.
- Cutoff:
  - Through today's date.
  - Through the last day of the selected month.
- Department or All.

For a completed past month, both cutoff choices resolve to the month end. A future payroll month is rejected. For the current month, Through Today ends on the current date.

### 5.2 Validation

Before calculation, the system validates:

- Access to each configured source workbook.
- Required tab and column mappings.
- Unique Employee IDs.
- Employee-to-Leave-Tracker matching.
- Valid first and last working dates.
- Numeric salary, transfer, sales, conversion, annual-balance, and deduction inputs.
- Referral links.
- Required schedule and attendance data.
- Required commission inputs.

Blocking errors stop the affected department. Non-blocking warnings must be shown and acknowledged.

### 5.3 Decisions

Before creating the draft, the wizard resolves:

- Employees who passed probation.
- Eligibility for the one-time EGP 12,000 probation-completion payment.
- Government holiday applicability.
- Holiday employee selection.
- OCR or pasted-name matches.
- Any other unresolved eligibility inputs.

### 5.4 Draft

The draft displays every payroll component separately. HR may edit calculated amounts directly.

Every edited amount requires:

- Original calculated value.
- Edited value.
- Reason.
- Editor identity.
- Timestamp.

A draft may be recalculated or superseded. It does not write paid flags.

### 5.5 Approval

Approval is unavailable while blocking errors, unmatched OCR names, unresolved decisions, or missing override reasons remain.

Approval:

- Locks the payroll version.
- Preserves an immutable input and result snapshot.
- Updates Latest Results.
- Adds the final version to Payroll History.
- Writes controlled run and payment status fields back to department sources.
- Records approver and timestamp.

Approved runs cannot be edited. Corrections require a new version linked to the superseded run.

## 6. Canonical Employee and Payroll Data

Each normalized employee record includes, where applicable:

- Employee ID.
- American name.
- Internal real name.
- Department and role.
- First working day.
- Last working day.
- Probation day/status.
- Referrer Employee ID.
- Referred employees.
- Monthly transfer count.
- Monthly sales count.
- Active-call count or conversion rate.
- Batch and assigned TDS.
- Annual-leave balance.
- Manual deductions and reasons.
- Attendance and leave codes.
- Scheduled days off.
- Worked off-days.
- Worked government holidays.
- Previously paid one-time benefits.
- Payroll run and payment history.

Employee ID, not name or row position, is used for joins and write-back.

## 7. Payroll Period and Proration

### 7.1 Fixed Monthly Basis

Monthly salary and monthly ABS are fixed amounts regardless of whether the calendar month contains 28, 29, 30, or 31 days.

An employee eligible for the entire payroll month receives the full configured monthly amount.

Partial employment periods use:

`Monthly amount ÷ 30 × eligible calendar days`

The result is capped at the full monthly amount for that month.

### 7.2 Eligible Dates

Employment dates are inclusive:

- The first working day is paid.
- The last working day is paid.
- September 5 through September 30 equals 26 eligible calendar days.

The calculation covers only the selected payroll month. It never begins at the employee's historical hiring date unless that historical month is explicitly selected.

Basic and prorated ABS count all eligible calendar days within the employment window, including weekends and holidays. Attendance qualification uses scheduled workdays separately.

### 7.3 Probation Split

- Employment days 1–90 use before-probation rates.
- Day 91 onward uses after-probation rates.
- A payroll month containing day 91 is split by date.
- An employee at day 91 or later is visibly marked green as Passed Probation.

## 8. Department Salary Rules

### 8.1 Survey

Before probation:

- Basic: EGP 12,000 per month.
- ABS: EGP 2,000 per month.

After probation:

- Basic: EGP 15,000 per month.
- ABS: EGP 3,000 per month.

### 8.2 Reservations

Reservations uses the same Basic, ABS, proration, probation, referral, holiday, off-day, and deduction rules as Survey.

### 8.3 Sales

- Basic: EGP 16,000 per month before and after probation.
- No probation salary increase.
- ABS accrues at EGP 4,000 per qualifying full month and is normally paid as EGP 12,000 on the configurable company-wide quarterly cycle.
- Partial-month Sales ABS is prorated on the fixed 30-day basis.
- Commission and ABS remain separate components.

### 8.4 TDS

Before probation:

- Fixed Basic: EGP 18,000 per month.

After probation:

- Fixed Basic: EGP 21,000 per month.

TDS has no ABS.

TDS performance commission is EGP 100 for each agent in the TDS's assigned batch who achieves more than 75 transfers in the selected month.

### 8.5 Management

Before probation:

- Fixed Basic: EGP 21,000 per month.

After probation:

- Fixed Basic: EGP 27,000 per month.

Management has no ABS.

## 9. Commission Rules

### 9.1 Survey Transfer Commission

- 1–200 transfers: all transfers × EGP 10.
- 201–300 transfers: first 200 × EGP 10; transfers above 200 × EGP 15.
- 301–350 transfers: all transfers × EGP 15.
- 351–400 transfers: all transfers × EGP 20.
- 401–500 transfers: all transfers × EGP 25.
- 501+ transfers: all transfers × EGP 30.

### 9.2 Reservations Transfer Commission

Reservations is fully progressive:

- Transfers 1–200 × EGP 10.
- Transfers 201–300 × EGP 15.
- Transfers 301–400 × EGP 20.
- Transfers 401–500 × EGP 25.
- Transfers 501+ × EGP 30.

### 9.3 Sales Commission

Sales commission is non-progressive. The employee's conversion-rate band and final sales-count bracket select one per-sale rate. That one rate applies to every sale.

| Conversion Rate | 1–19 | 20–29 | 30–39 | 40–49 | 50+ |
|---|---:|---:|---:|---:|---:|
| 0%–3.00% | 300 | 300 | 300 | 300 | 300 |
| 3.01%–3.99% | 400 | 400 | 400 | 400 | 400 |
| 4.00%–4.99% | 450 | 550 | 650 | 750 | 850 |
| 5.00%–5.99% | 550 | 650 | 750 | 850 | 1,000 |
| 6.00%+ | 650 | 750 | 950 | 1,100 | 1,300 |

Zero sales produces EGP 0 commission. Conversion rate is normalized to two decimal places before band selection.

Examples:

- 4.2% and 37 sales: 37 × EGP 650 = EGP 24,050.
- 6.1% and 53 sales: 53 × EGP 1,300 = EGP 68,900.

## 10. ABS Attendance Eligibility

These rules apply to Survey, Reservations, and Sales only.

### 10.1 Full-Month Attendance Threshold

A full-month employee loses the entire month's ABS when either condition is true:

- More than 5 leave days in the month.
- Fewer than 17 attended scheduled workdays, or fewer than 15 in February.

Scheduled days off are excluded using the employee's actual schedule from the department Leave Tracker.

An automatic reason is recorded.

This penalty affects ABS only. It does not reduce Basic, commission, referral bonus, or other independent components.

### 10.2 Partial-Month Exemption

Employees who join or leave partway through the selected month are exempt from the 17/15-day threshold. They receive normal prorated ABS for their eligible employment period unless another rule, such as No-Show, removes it.

### 10.3 No-Show

Leave Tracker code **NS** means No-Show.

NS causes:

- A deduction equal to 3 applicable Basic daily rates.
- Removal of the entire applicable monthly ABS.

For Sales, NS removes only that month's EGP 4,000 ABS accrual, or the prorated monthly accrual where applicable. It does not remove previously earned quarterly accruals.

NS does not affect commission, referral, or unrelated additions.

## 11. Probation-Completion Payment

This rule applies only to Survey and Reservations.

An employee becomes a candidate for the one-time EGP 12,000 payment after completing day 91 and continuing to work beyond it. A later resignation does not erase candidacy.

The wizard marks the employee green as Passed Probation and asks HR whether the candidate is eligible for the EGP 12,000 payment.

The payment:

- Is never automatic without HR confirmation.
- May be included in active payroll or a later final payroll.
- Is stored in the Payment Ledger.
- Cannot be paid twice.

## 12. Referral Bonus

The referral bonus applies to all departments and roles.

Agent A receives EGP 10,000 when referred Agent B completes 60 full days.

The bonus is paid once and tracked by referrer Employee ID plus referred Employee ID.

A former employee may receive the referral bonus in final payroll if the referred employee reaches 60 days on or before the former employee's final payroll payment date. If the 60-day date occurs after final payroll has been paid, no later referral payment is due.

## 13. Extra Days and Government Holidays

### 13.1 Off-Day Work

Working a scheduled off-day adds one Basic daily rate because the day becomes double-paid. The normal day's salary is already included in Basic.

Attendance status `OFF` is schedule evidence only and does not create extra pay. The distinct affirmative status `WORKED_OFF` records that the employee actually worked the scheduled off-day and is the only attendance status that adds this +1 unit.

### 13.2 Government Holiday Work

Working an eligible government holiday adds two Basic daily rates because the day becomes triple-paid.

If a government holiday overlaps a scheduled off-day, the holiday rule takes precedence. The employee receives +2 extra-day units total; the rules do not stack to +3.

The Basic daily rate applicable on the worked date is used.

### 13.3 Holiday Calendar and Decisions

The Holiday Calendar stores both confirmed and estimated dates. Payroll may use currently listed estimated or placed actual dates, but no holiday payment is added silently.

When a selected month contains a holiday, the wizard asks HR whether it applies and which employees worked it.

Selection options:

- Searchable employee checklist.
- Pasted list of American names.
- Uploaded screenshot processed with Google Cloud Vision OCR.
- Select All Survey.
- Select All Reservations.

There is no Select All Sales option because Sales schedules differ. Sales employees must be selected individually.

OCR matches extracted text against employee records and shows only American names. Uncertain or unmatched results require manual resolution. The original screenshot, extracted text, confirmed matches, uploader, and timestamp are retained in a restricted Drive audit folder and linked to the payroll run.

## 14. Final Settlements

Employees with a last working date use a final-settlement layout.

Unused annual-leave balance is paid as:

`Unused annual-leave days × Basic daily rate applicable at departure`

Annual balance excludes ABS and commission.

Final-settlement output includes:

- Agent.
- Basic.
- ABS.
- Annual balance.
- Transfers or Commission.
- Extra days.
- Deductions.
- Other approved additions.
- Probation completion payment, if approved.
- Referral bonus, if eligible.
- Total.

Active-employee output includes the same components except Annual balance.

The sample active-agent correction is:

- 27 Basic days × EGP 400 = EGP 10,800.
- 27 ABS days × EGP 66.6667 = EGP 1,800.
- 6 extra-day units × EGP 400 = EGP 2,400.
- Total = EGP 15,000.

## 15. Calculation Order

For each employee, the engine performs calculations in this order:

1. Resolve the selected payroll period and employment window.
2. Split the period at the probation boundary when necessary.
3. Calculate Basic and ABS.
4. Apply attendance-based ABS eligibility and NS deductions.
5. Calculate department commission.
6. Evaluate probation and referral payments.
7. Add off-day and holiday payments.
8. Add annual-balance payment for final settlements.
9. Add approved additions.
10. Subtract manual and automatic deductions.
11. Apply documented draft overrides.
12. Validate and calculate the final total.

## 16. History, Audit, and Write-Back

Every run stores:

- Run ID and version.
- Draft or Approved status.
- Payroll month and cutoff.
- Department scope.
- Rules version.
- Source workbook IDs, tabs, and source snapshot.
- Per-employee canonical inputs.
- Per-component calculated and final amounts.
- Eligibility decisions.
- Warnings and acknowledgements.
- OCR evidence.
- Overrides.
- Creator, approver, and timestamps.

Write-back uses Employee ID and records only controlled payroll/payment state, including run ID, payroll month, approval status, payment date, and one-time-payment markers. It never depends on mutable row positions.

Final approval is idempotent. Retrying the same approval cannot duplicate a payment or history record.

## 17. Security and Permissions

- Users must have appropriate access to the master workbook and configured external sources.
- Approval permission is controlled by a configured approver list.
- Spreadsheet and Drive scopes are limited to those needed for configured data and retained evidence.
- Cloud Vision settings and credentials are stored in protected Apps Script properties, not visible cells.
- OCR evidence is stored in a restricted Drive folder.
- Technical sheets and configuration ranges are protected.
- The system uses an Apps Script lock during approval to prevent concurrent finalization.

## 18. Performance and Reliability

- Source data is read in batches rather than cell by cell.
- Results are written in batches.
- Department adapters isolate layout differences.
- The pure payroll engine is separate from spreadsheet input/output.
- A failure in one department during an All run is reported precisely and cannot silently corrupt another department's approved result.
- No incomplete run is marked approved.
- Source snapshots make historical results reproducible even after source sheets change.

## 19. Test Strategy

Automated tests cover:

- Full months with 28, 29, 30, and 31 calendar days.
- Partial-month inclusive date counting.
- First and last working dates.
- Current-day and month-end cutoffs.
- Day-90/day-91 probation splits.
- EGP 12,000 candidacy, approval, and duplicate prevention.
- Full-month versus partial-month attendance rules.
- February 15-day threshold.
- More-than-5-leave rule.
- NS deduction and ABS removal.
- Every Survey commission boundary.
- Every Reservations progressive band.
- Every Sales conversion and sales-count boundary.
- Zero Sales commission.
- Sales quarterly accrual and one-month forfeiture.
- TDS batch commission.
- Referral eligibility and former-employee cutoff.
- Off-day and holiday multipliers.
- Holiday/off-day overlap.
- Annual-balance final settlement.
- Manual override audit.
- Approval locking and idempotent retry.
- Source mapping and missing-data failures.
- OCR exact, uncertain, and unmatched names.

Before deployment, representative dry-run results will be compared with manually verified payroll examples.

## 20. Integration Inputs Required Before Deployment

Implementation can proceed locally with fixtures, but live integration requires the user to provide:

- Department workbook links/IDs.
- Department Leave Tracker links/IDs.
- Relevant tab names.
- Column headers or mapping samples.
- Sales quarterly bonus cycle months/payment payrolls.
- Google Drive folder for retained OCR evidence.
- Google Cloud project with Vision OCR enabled.
- Approver email list.
- Representative source rows and manually verified expected payroll examples.

No script is pushed to Google Apps Script until the local folder and exact Apps Script project ID are displayed and explicitly confirmed in the same turn.

