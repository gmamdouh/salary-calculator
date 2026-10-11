/** Validated, data-driven commission schedules from Salary Rules rows. */
SalaryCalculator.Commission = (function () {
  var SALES_RATES = [[300,300,300,300,300],[400,400,400,400,400],[450,550,650,750,850],
    [550,650,750,850,1000],[650,750,950,1100,1300]];
  var CONVERSION_BANDS = ['0.00%-3.00%','3.01%-3.99%','4.00%-4.99%','5.00%-5.99%','6.00%+'];
  var SALE_BRACKETS = ['0-19','20-29','30-39','40-49','50+'];
  function defaultRows() {
    var rows = [
      ['COMMISSION','SURVEY','1-200',10,'EGP per transfer; all transfers at rate'],
      ['COMMISSION','SURVEY','201-300',15,'Progressive increment after first 200 transfers'],
      ['COMMISSION','SURVEY','301-350',15,'EGP per transfer; all transfers at rate'],
      ['COMMISSION','SURVEY','351-400',20,'EGP per transfer; all transfers at rate'],
      ['COMMISSION','SURVEY','401-500',25,'EGP per transfer; all transfers at rate'],
      ['COMMISSION','SURVEY','501+',30,'EGP per transfer; all transfers at rate'],
      ['COMMISSION','RESERVATIONS','1-200',10,'EGP per transfer, progressive'],
      ['COMMISSION','RESERVATIONS','201-300',15,'EGP per transfer, progressive'],
      ['COMMISSION','RESERVATIONS','301-400',20,'EGP per transfer, progressive'],
      ['COMMISSION','RESERVATIONS','401-500',25,'EGP per transfer, progressive'],
      ['COMMISSION','RESERVATIONS','501+',30,'EGP per transfer, progressive']
    ];
    CONVERSION_BANDS.forEach(function (band, i) { SALE_BRACKETS.forEach(function (bracket, j) {
      rows.push(['COMMISSION','SALES',band + '|' + bracket,SALES_RATES[i][j],'EGP per sale']);
    }); });
    rows.push(['COMMISSION','TDS','transfers > 75',100,'EGP per qualifying agent']);
    return rows;
  }
  function problem(message, row) {
    var error = new Error(message);
    error.code = 'INVALID_COMMISSION_RULE';
    error.issues = [{ code: error.code, message: message, row: row || null }];
    throw error;
  }
  function rate(value, row, legacySurveySecond) {
    if (legacySurveySecond && typeof value === 'string' && value.trim() === '2000 + (transfers - 200) * 15') value = 15;
    if (!((typeof value === 'number' && Number.isFinite(value)) ||
        (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()))) || Number(value) < 0)
      problem('Commission rate must be a finite nonnegative number', row);
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) problem('Commission rate must be a finite nonnegative number', row);
    return parsed;
  }
  function range(key, row, percent) {
    var pattern = percent ? /^(\d+\.\d{2})%-(\d+\.\d{2})%$|^(\d+\.\d{2})%\+$/ : /^(\d+)-(\d+)$|^(\d+)\+$/;
    var match = pattern.exec(key);
    if (!match) problem('Invalid commission band: ' + key, row);
    var scale = percent ? 100 : 1;
    var min = Math.round(Number(match[1] || match[3]) * scale);
    var max = match[2] === undefined ? null : Math.round(Number(match[2]) * scale);
    if (!Number.isSafeInteger(min) || (max !== null && !Number.isSafeInteger(max))) problem('Commission band is outside the supported range: ' + key, row);
    if (max !== null && max < min) problem('Reversed commission band: ' + key, row);
    return { min: min, max: max };
  }
  function contiguous(bands, start, label) {
    bands.sort(function (a, b) { return a.min - b.min; });
    if (!bands.length) problem('Missing ' + label + ' commission rules');
    var next = start;
    bands.forEach(function (band) {
      if (band.min !== next) problem((band.min < next ? 'Overlapping or duplicate ' : 'Gapped ') + label + ' commission bands');
      next = band.max === null ? null : band.max + 1;
      if (next === null && band !== bands[bands.length - 1]) problem('Commission band follows open-ended ' + label + ' band');
    });
    if (next !== null) problem('Missing open-ended ' + label + ' commission band');
  }
  function parseRows(rows) {
    if (!Array.isArray(rows)) problem('Commission rows must be an array');
    var result = { survey: [], reservations: [], sales: [], tds: null };
    var salesByBand = Object.create(null), seen = Object.create(null);
    rows.forEach(function (row, index) {
      if (String(row[0] || '').trim().toUpperCase() !== 'COMMISSION') return;
      var number = index + 2, department = String(row[1] || '').trim().toUpperCase(), key = String(row[2] || '').trim();
      if (department === 'SURVEY' || department === 'RESERVATIONS') {
        var item = range(key, number, false);
        item.rate = rate(row[3], number, department === 'SURVEY' && key === '201-300');
        item.mode = department === 'RESERVATIONS' ? 'PROGRESSIVE' : 'FLAT';
        result[department.toLowerCase()].push(item);
      } else if (department === 'SALES') {
        var parts = key.split('|');
        if (parts.length !== 2) problem('Sales rule needs conversion and sale bands', number);
        var conversion = range(parts[0], number, true), sale = range(parts[1], number, false);
        // Old seeded sheets used 1-19. Zero sales has the same rate as 1-19.
        if (sale.min === 1 && sale.max === 19) sale.min = 0;
        var bandKey = conversion.min + ':' + conversion.max;
        if (!salesByBand[bandKey]) salesByBand[bandKey] = { min: conversion.min, max: conversion.max,
          label: parts[0].replace(/%/g, ''), brackets: [] };
        var duplicate = bandKey + '|' + sale.min + ':' + sale.max;
        if (seen[duplicate]) problem('Duplicate Sales commission rule: ' + key, number);
        seen[duplicate] = true;
        sale.rate = rate(row[3], number);
        salesByBand[bandKey].brackets.push(sale);
      } else if (department === 'TDS') {
        if (result.tds) problem('Duplicate TDS commission rule', number);
        var match = /^transfers\s*>\s*(\d+)$/.exec(key);
        if (!match) problem('TDS rule must use transfers > N', number);
        var threshold = Number(match[1]);
        if (!Number.isSafeInteger(threshold) || threshold < 0) problem('TDS threshold is outside the supported range', number);
        result.tds = { threshold: threshold, rate: rate(row[3], number) };
      } else problem('Unknown commission department: ' + department, number);
    });
    contiguous(result.survey, 1, 'Survey');
    contiguous(result.reservations, 1, 'Reservations');
    if (result.survey.length < 2 || result.survey[1].max === null) problem('Survey needs a bounded progressive second band');
    result.survey[1].mode = 'PROGRESSIVE_AFTER_FIRST';
    result.sales = Object.keys(salesByBand).map(function (key) { return salesByBand[key]; });
    contiguous(result.sales, 0, 'Sales conversion');
    result.sales.forEach(function (band) { contiguous(band.brackets, 0, 'Sales count'); });
    if (!result.tds) problem('Missing TDS commission rule');
    return result;
  }
  function count(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be a nonnegative integer');
    return value;
  }
  function schedule(rules) {
    if (!rules || !rules.survey || !rules.reservations || !rules.sales || !rules.tds) throw new Error('Validated commission rules are required');
    return rules;
  }
  function finiteAmount(amount) {
    if (!Number.isFinite(amount)) throw new Error('Commission amount must be finite');
    return amount;
  }
  function bandFor(bands, value) { return bands.find(function (band) { return value >= band.min && (band.max === null || value <= band.max); }); }
  function calculateSurvey(transfers, rules) {
    count(transfers, 'transfers');
    var bands = schedule(rules).survey;
    if (!transfers) return 0;
    var band = bandFor(bands, transfers);
    if (!band) throw new Error('Survey commission band missing');
    if (band.mode === 'PROGRESSIVE_AFTER_FIRST') {
      var first = bands[0];
      return finiteAmount(first.max * first.rate + (transfers - first.max) * band.rate);
    }
    return finiteAmount(transfers * band.rate);
  }
  function calculateReservations(transfers, rules) {
    count(transfers, 'transfers');
    return finiteAmount(schedule(rules).reservations.reduce(function (sum, band) {
      return sum + Math.max(0, Math.min(transfers, band.max === null ? transfers : band.max) - band.min + 1) * band.rate;
    }, 0));
  }
  function calculateSales(sales, conversionRate, rules) {
    count(sales, 'sales');
    if (typeof conversionRate !== 'number' || !Number.isFinite(conversionRate) || conversionRate < 0) throw new Error('conversionRate must be a finite nonnegative number');
    var conversion = Math.round((conversionRate + Number.EPSILON) * 100);
    var band = bandFor(schedule(rules).sales, conversion);
    var bracket = band && bandFor(band.brackets, sales);
    if (!bracket) throw new Error('Sales commission band missing');
    return { ratePerSale: bracket.rate, amount: finiteAmount(sales * bracket.rate), band: band.label };
  }
  function calculateTds(agents, rules) {
    if (!Array.isArray(agents)) throw new Error('agents must be an array');
    var tds = schedule(rules).tds;
    var qualifyingCount = agents.reduce(function (total, agent) {
      var transfers = agent && agent.performance && agent.performance.transfers;
      count(transfers, 'agent transfers');
      return total + (transfers > tds.threshold ? 1 : 0);
    }, 0);
    return { qualifyingCount: qualifyingCount, amount: finiteAmount(qualifyingCount * tds.rate) };
  }
  return { defaultRows: defaultRows, parseRows: parseRows, calculateSurvey: calculateSurvey,
    calculateReservations: calculateReservations, calculateSales: calculateSales, calculateTds: calculateTds };
})();
