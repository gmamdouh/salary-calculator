SalaryCalculator.OcrService = (function () {
  function scriptProperty(name) {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) throw new Error('OCR settings are unavailable');
    return PropertiesService.getScriptProperties().getProperty(name);
  }

  function requiredText(value, label) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' is required');
    return value.trim();
  }

  function storeEvidence(blob, runId, actor) {
    requiredText(runId, 'runId');
    requiredText(actor, 'actor');
    var folderId = scriptProperty('OCR_AUDIT_FOLDER_ID');
    if (!folderId) throw new Error('OCR evidence folder is not configured');
    if (typeof DriveApp === 'undefined') throw new Error('Drive evidence storage is unavailable');
    var folder = DriveApp.getFolderById(folderId);
    var file = folder.createFile(blob);
    return { evidenceId: file.getId(), runId: runId, actor: actor,
      fileName: file.getName(), contentType: blob && blob.getContentType ? blob.getContentType() : '',
      url: file.getUrl(), storedAt: new Date().toISOString() };
  }

  function extractText(blob) {
    var apiKey = scriptProperty('CLOUD_VISION_API_KEY');
    if (!apiKey) throw new Error('Cloud Vision is not configured');
    if (typeof UrlFetchApp === 'undefined' || typeof Utilities === 'undefined') throw new Error('Cloud Vision is unavailable');
    var encoded = Utilities.base64Encode(blob.getBytes());
    var response = UrlFetchApp.fetch('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(apiKey), {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ requests: [{ image: { content: encoded }, features: [{ type: 'TEXT_DETECTION' }] }] })
    });
    var status = response.getResponseCode();
    if (status < 200 || status >= 300) throw new Error('Cloud Vision text detection failed');
    var result = JSON.parse(response.getContentText());
    if (result.error || !result.responses || !result.responses.length) throw new Error('Cloud Vision returned an invalid response');
    var vision = result.responses[0];
    if (vision.error) throw new Error('Cloud Vision text detection failed');
    var annotation = (vision.textAnnotations || [])[0];
    return { text: annotation && annotation.description || '', detected: !!(annotation && annotation.description),
      feature: 'TEXT_DETECTION' };
  }

  function normalizeName(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  function matchAmericanNames(text, employees) {
    var names = String(text || '').split(/[\r\n,;]+/).map(function (line) { return line.trim(); }).filter(Boolean);
    var matches = [];
    var unmatched = [];
    var ambiguous = [];
    var warnings = [];
    var seenMatches = {};
    var seenInput = {};
    var validEmployees = (employees || []).filter(function (employee) {
      return employee && employee.employeeId && employee.americanName;
    });

    names.forEach(function (name) {
      var normalized = normalizeName(name);
      if (!normalized || seenInput[normalized]) return;
      seenInput[normalized] = true;
      var exact = validEmployees.filter(function (employee) { return normalizeName(employee.americanName) === normalized; });
      if (exact.length === 1 && !seenMatches[exact[0].employeeId]) {
        seenMatches[exact[0].employeeId] = true;
        matches.push({ americanName: exact[0].americanName, employeeId: exact[0].employeeId,
          status: 'PENDING_CONFIRMATION', confirmed: false });
        return;
      }
      if (exact.length > 1) {
        ambiguous.push({ status: 'AMBIGUOUS', candidates: exact.map(function (employee) {
          return { americanName: employee.americanName, employeeId: employee.employeeId };
        }) });
        warnings.push({ code: 'DUPLICATE_AMERICAN_NAME', americanName: exact[0].americanName,
          employeeIds: exact.map(function (employee) { return employee.employeeId; }) });
        return;
      }
      var partial = validEmployees.filter(function (employee) {
        var candidate = normalizeName(employee.americanName);
        return candidate.indexOf(normalized) !== -1 || normalized.indexOf(candidate) !== -1;
      });
      if (partial.length) {
        ambiguous.push({ status: 'AMBIGUOUS', candidates: partial.map(function (employee) {
          return { americanName: employee.americanName, employeeId: employee.employeeId };
        }) });
      } else {
        unmatched.push({ status: 'UNMATCHED' });
      }
    });

    return { matches: matches, ambiguous: ambiguous, unmatched: unmatched, warnings: warnings };
  }

  function confirmMatches(report, selectedEmployeeIds) {
    var selected = {};
    (selectedEmployeeIds || []).forEach(function (employeeId) { selected[String(employeeId)] = true; });
    var pending = report && Array.isArray(report.matches) ? report.matches : [];
    var matches = pending.map(function (match) {
      var confirmed = match.status === 'PENDING_CONFIRMATION' && selected[match.employeeId] === true;
      return { americanName: match.americanName, employeeId: match.employeeId,
        status: confirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION', confirmed: confirmed };
    });
    var selectedIds = matches.filter(function (match) { return match.confirmed; }).map(function (match) { return match.employeeId; });
    var unresolved = (report && report.ambiguous || []).length + (report && report.unmatched || []).length +
      matches.filter(function (match) { return !match.confirmed; }).length;
    return { matches: matches, selectedEmployeeIds: selectedIds, ready: unresolved === 0,
      ambiguous: report && report.ambiguous || [], unmatched: report && report.unmatched || [],
      warnings: report && report.warnings || [] };
  }

  function buildDecisionPayload(input) {
    input = input || {};
    var payload = { holidayWork: { holidayId: String(input.holidayId || ''), applies: input.applies === true,
      employeeIds: (input.employeeIds || []).map(String), evidenceIds: (input.evidenceIds || []).map(String) },
      ocr: { unresolvedCount: Number(input.unresolvedCount || 0), confirmedEmployeeIds: (input.confirmedEmployeeIds || []).map(String) } };
    return SalaryCalculator.Contracts.assertDecisionSet(payload);
  }

  return { storeEvidence: storeEvidence, extractText: extractText,
    matchAmericanNames: matchAmericanNames, confirmMatches: confirmMatches,
    buildDecisionPayload: buildDecisionPayload };
})();
