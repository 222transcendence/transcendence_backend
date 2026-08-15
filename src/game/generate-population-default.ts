import 'dotenv/config';
import { AppDataSource } from '../data-source';
import {
  estimatePopulationDefault,
  serializePopulationDefaultReport,
} from './population-default.estimator';
import {
  parsePopulationDefaultAllowlist,
  TypeOrmPopulationDefaultDataSource,
  PopulationDefaultConfigurationError,
} from './population-default.data-source';

async function main(): Promise<void> {
  const allowlist = parsePopulationDefaultAllowlist();
  await AppDataSource.initialize();
  try {
    const source = new TypeOrmPopulationDefaultDataSource(AppDataSource);
    const rows = await source.getPerformanceRows(allowlist);
    const estimate = estimatePopulationDefault(rows);
    const report = serializePopulationDefaultReport(estimate, {
      generatedAt: new Date().toISOString(),
      allowlistCount: allowlist.length,
      queriedMatches: new Set(rows.map((row) => row.matchId)).size,
    });
    process.stdout.write(`${report}\n`);
    if (!estimate.eligibleForRuntime) process.exitCode = 2;
  } finally {
    await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  const prefix =
    error instanceof PopulationDefaultConfigurationError
      ? 'configuration error'
      : 'system error';
  console.error(`[population-default] ${prefix}: ${String(error)}`);
  process.exitCode = 1;
});
