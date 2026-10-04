var SalaryCalculator = typeof SalaryCalculator === 'undefined' ? {} : SalaryCalculator;
SalaryCalculator.Constants = Object.freeze({
  DEPARTMENTS: Object.freeze({ SURVEY: 'SURVEY', RESERVATIONS: 'RESERVATIONS', SALES: 'SALES', TDS: 'TDS', MANAGEMENT: 'MANAGEMENT' }),
  CUTOFF_MODES: Object.freeze({ TODAY: 'TODAY', MONTH_END: 'MONTH_END' }),
  RUN_STATES: Object.freeze({ DRAFT: 'DRAFT', APPROVED: 'APPROVED', SUPERSEDED: 'SUPERSEDED' })
});
