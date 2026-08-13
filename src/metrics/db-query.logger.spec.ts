import {
  DbQueryLogger,
  PopulationDefaultReportLogger,
} from './db-query.logger';

describe('DbQueryLogger', () => {
  const originalReportFlag = process.env.POPULATION_DEFAULT_REPORT;
  const originalLog = console.log;
  const originalError = console.error;

  afterEach(() => {
    if (originalReportFlag === undefined) {
      delete process.env.POPULATION_DEFAULT_REPORT;
    } else {
      process.env.POPULATION_DEFAULT_REPORT = originalReportFlag;
    }
    console.log = originalLog;
    console.error = originalError;
  });

  it('keeps normal query logging and error diagnostics when report flag is set', () => {
    process.env.POPULATION_DEFAULT_REPORT = '1';
    const log = jest.fn();
    const error = jest.fn();
    console.log = log;
    console.error = error;

    const logger = new DbQueryLogger();
    logger.logQuery('SELECT 1', ['safe-test-parameter']);
    logger.logQueryError('db failure', 'SELECT 1', ['safe-test-parameter']);

    expect(log).toHaveBeenCalledWith('query: SELECT 1', [
      'safe-test-parameter',
    ]);
    expect(error).toHaveBeenCalledWith(
      'query failed: SELECT 1',
      ['safe-test-parameter'],
      'db failure',
    );
  });

  it('redacts report query parameters but preserves the query error itself', () => {
    const error = jest.fn();
    console.error = error;

    new PopulationDefaultReportLogger().logQueryError(
      'db failure',
      'SELECT * FROM participant_performances WHERE userId IN ($1)',
      ['private-user-id'],
    );

    expect(error).toHaveBeenCalledWith(
      '[population-default] query failed: SELECT * FROM participant_performances WHERE userId IN ($1)',
      'db failure',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('private-user-id');
  });
});
