import type { Logger } from 'typeorm';
import { dbQueryDuration } from './metrics.registry';

export class DbQueryLogger implements Logger {
  logQuery(query: string, parameters?: unknown[]) {
    console.log(`query: ${query}`, parameters?.length ? parameters : '');
  }

  logQueryError(error: string | Error, query: string, parameters?: unknown[]) {
    console.error(`query failed: ${query}`, parameters, error);
  }

  logQuerySlow(time: number, query: string) {
    dbQueryDuration.observe(time / 1000);
    console.log(`query: ${query} -- ${time}ms`);
  }

  logSchemaBuild(message: string) {
    console.log(message);
  }

  logMigration(message: string) {
    console.log(message);
  }

  log(level: 'log' | 'info' | 'warn', message: unknown) {
    if (level === 'warn') {
      console.warn(message);
    } else {
      console.log(message);
    }
  }
}
