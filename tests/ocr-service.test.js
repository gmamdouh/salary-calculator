const test = require('node:test');
const assert = require('node:assert/strict');
const { loadAppsScript } = require('./helpers/load-apps-script');

const employees = [
  { employeeId: 'EMP-001', americanName: 'Alex Smith', realName: 'Alexandria Smithson', department: 'SURVEY' },
  { employeeId: 'EMP-002', americanName: 'Jamie Doe', realName: 'Jordan Doe', department: 'RESERVATIONS' }
];
const duplicateEmployees = employees.concat([
  { employeeId: 'EMP-003', americanName: 'Alex Smith', realName: 'Other Legal Name', department: 'SALES' }
]);

test('an exact American name is matched and requires explicit confirmation', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('Alex Smith', employees);
  assert.deepEqual(JSON.parse(JSON.stringify(report.matches)), [
    { americanName: 'Alex Smith', employeeId: 'EMP-001', status: 'PENDING_CONFIRMATION', confirmed: false }
  ]);
  assert.equal(report.unmatched.length, 0);
});

test('case and spacing differences still match the American name', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('  aLeX   sMiTh  ', employees);
  assert.equal(report.matches[0].employeeId, 'EMP-001');
  assert.equal(report.matches[0].americanName, 'Alex Smith');
});

test('a real name is never displayed as a match or exposed in the report', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('Alexandria Smithson', employees);
  assert.equal(report.matches.length, 0);
  assert.equal(report.unmatched.length, 1);
  assert.equal(JSON.stringify(report).includes('Alexandria Smithson'), false);
});

test('a partial name is ambiguous and cannot be included automatically', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('Alex', duplicateEmployees);
  assert.equal(report.matches.length, 0);
  assert.equal(report.ambiguous[0].status, 'AMBIGUOUS');
  assert.deepEqual(report.ambiguous[0].candidates.map(item => item.employeeId), ['EMP-001', 'EMP-003']);
});

test('unmatched text blocks confirmation without exposing its raw contents', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('Unlisted Person', employees);
  assert.equal(report.unmatched.length, 1);
  assert.equal(JSON.stringify(report).includes('Unlisted Person'), false);
  assert.equal(OcrService.confirmMatches(report, []).ready, false);
});

test('duplicate American names produce a warning and ambiguous result', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('Alex Smith', duplicateEmployees);
  assert.equal(report.ambiguous.length, 1);
  assert.equal(report.warnings[0].code, 'DUPLICATE_AMERICAN_NAME');
  assert.equal(report.matches.length, 0);
});

test('only an explicit confirmation includes a pending exact match', () => {
  const { OcrService } = loadAppsScript();
  const report = OcrService.matchAmericanNames('Alex Smith', employees);
  assert.deepEqual(JSON.parse(JSON.stringify(OcrService.confirmMatches(report, []).selectedEmployeeIds)), []);
  const confirmed = OcrService.confirmMatches(report, ['EMP-001']);
  assert.deepEqual(JSON.parse(JSON.stringify(confirmed.selectedEmployeeIds)), ['EMP-001']);
  assert.equal(confirmed.ready, true);
});

test('evidence is saved to the configured Drive folder with run and actor audit fields', () => {
  const calls = [];
  const { OcrService } = loadAppsScript({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'OCR_AUDIT_FOLDER_ID' ? 'restricted-folder' : null }) },
    DriveApp: { getFolderById: id => { calls.push(['folder', id]); return { createFile: blob => {
      calls.push(['file', blob]); return { getId: () => 'FILE-1', getName: () => 'holiday.png', getUrl: () => 'drive://FILE-1' };
    } }; } }
  });
  const blob = { getContentType: () => 'image/png' };
  const evidence = OcrService.storeEvidence(blob, 'RUN-1', 'hr@example.test');
  assert.deepEqual(calls, [['folder', 'restricted-folder'], ['file', blob]]);
  assert.equal(evidence.evidenceId, 'FILE-1');
  assert.equal(evidence.runId, 'RUN-1');
  assert.equal(evidence.actor, 'hr@example.test');
  assert.equal(evidence.contentType, 'image/png');
});

test('Vision request uses TEXT_DETECTION and returns recognized text', () => {
  let request;
  const { OcrService } = loadAppsScript({
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key === 'CLOUD_VISION_API_KEY' ? 'test-key' : null }) },
    Utilities: { base64Encode: bytes => Buffer.from(bytes).toString('base64') },
    UrlFetchApp: { fetch: (url, options) => {
      request = { url, payload: JSON.parse(options.payload) };
      return { getResponseCode: () => 200, getContentText: () => JSON.stringify({ responses: [{ textAnnotations: [{ description: 'Alex Smith' }] }] }) };
    } }
  });
  const result = OcrService.extractText({ getBytes: () => [65, 66] });
  assert.equal(request.payload.requests[0].features[0].type, 'TEXT_DETECTION');
  assert.equal(request.payload.requests[0].image.content, 'QUI=');
  assert.equal(result.text, 'Alex Smith');
  assert.equal(result.detected, true);
});

test('holiday selection payload satisfies the open decision contract', () => {
  const { OcrService, Contracts } = loadAppsScript();
  const payload = OcrService.buildDecisionPayload({ holidayId: 'HOL-1', applies: true,
    employeeIds: ['EMP-001'], evidenceIds: ['FILE-1'], confirmedEmployeeIds: ['EMP-001'] });
  assert.equal(Contracts.assertDecisionSet(payload), payload);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.holidayWork.employeeIds)), ['EMP-001']);
});
