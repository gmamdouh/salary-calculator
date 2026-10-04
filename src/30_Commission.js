SalaryCalculator.Commission = (function () {
  function count(value, label) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(label + ' must be a nonnegative integer');
    return value;
  }
  function calculateSurvey(transfers) {
    count(transfers, 'transfers');
    if (transfers <= 200) return transfers * 10;
    if (transfers <= 300) return 2000 + (transfers - 200) * 15;
    return transfers * (transfers <= 350 ? 15 : transfers <= 400 ? 20 : transfers <= 500 ? 25 : 30);
  }
  function calculateReservations(transfers) {
    count(transfers, 'transfers');
    return Math.min(transfers, 200) * 10 + Math.min(Math.max(transfers - 200, 0), 100) * 15 +
      Math.min(Math.max(transfers - 300, 0), 100) * 20 + Math.min(Math.max(transfers - 400, 0), 100) * 25 +
      Math.max(transfers - 500, 0) * 30;
  }
  // Conversion rate is expressed in percentage points: 4.2 means 4.2%.
  function calculateSales(sales, conversionRate) {
    count(sales, 'sales');
    if (typeof conversionRate !== 'number' || !Number.isFinite(conversionRate) || conversionRate < 0) throw new Error('conversionRate must be a finite nonnegative number');
    var conversion = Math.round((conversionRate + Number.EPSILON) * 100) / 100;
    var row = conversion <= 3 ? 0 : conversion < 4 ? 1 : conversion < 5 ? 2 : conversion < 6 ? 3 : 4;
    var column = sales < 20 ? 0 : sales < 30 ? 1 : sales < 40 ? 2 : sales < 50 ? 3 : 4;
    var rates = [[300,300,300,300,300],[400,400,400,400,400],[450,550,650,750,850],
      [550,650,750,850,1000],[650,750,950,1100,1300]];
    var rate = rates[row][column];
    return { ratePerSale: rate, amount: sales * rate, band: ['0.00-3.00','3.01-3.99','4.00-4.99','5.00-5.99','6.00+'][row] };
  }
  // Caller supplies only the agents in the TDS's assigned batch.
  function calculateTds(agents) {
    if (!Array.isArray(agents)) throw new Error('agents must be an array');
    var qualifyingCount = agents.reduce(function (total, agent) {
      var transfers = agent && agent.performance && agent.performance.transfers;
      count(transfers, 'agent transfers');
      return total + (transfers > 75 ? 1 : 0);
    }, 0);
    return { qualifyingCount: qualifyingCount, amount: qualifyingCount * 100 };
  }
  return { calculateSurvey: calculateSurvey, calculateReservations: calculateReservations,
    calculateSales: calculateSales, calculateTds: calculateTds };
})();
