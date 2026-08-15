import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ParticipantPerformance } from './entities/participant-performance.entity';
import type { PopulationDefaultInput } from './population-default.estimator';
import { POPULATION_DEFAULT_CONFIG } from './population-default.config';

export const POPULATION_DEFAULT_ALLOWLIST_ENV =
  POPULATION_DEFAULT_CONFIG.allowlistEnvironmentVariable;

export class PopulationDefaultConfigurationError extends Error {}

export interface PopulationDefaultEnvironment {
  [POPULATION_DEFAULT_ALLOWLIST_ENV]?: string;
}

export interface PopulationDefaultPerformanceRow {
  matchId: string;
  playerId: string;
  participantType: PopulationDefaultInput['participantType'];
  mode: PopulationDefaultInput['mode'];
  resultStatus: PopulationDefaultInput['resultStatus'];
  wpm: number;
  accuracy: number;
  reactionTimeMs: number;
  createdAt: string;
  consented: boolean;
}

export function parsePopulationDefaultAllowlist(
  environment: PopulationDefaultEnvironment = process.env,
): string[] {
  const raw = environment[POPULATION_DEFAULT_ALLOWLIST_ENV];
  if (!raw || raw.trim().length === 0) {
    throw new PopulationDefaultConfigurationError(
      `${POPULATION_DEFAULT_ALLOWLIST_ENV} must contain at least one user id`,
    );
  }

  const userIds = [...new Set(raw.split(',').map((value) => value.trim()))]
    .filter((value) => value.length > 0)
    .sort((left, right) => left.localeCompare(right));
  if (userIds.length === 0) {
    throw new PopulationDefaultConfigurationError(
      `${POPULATION_DEFAULT_ALLOWLIST_ENV} must contain at least one user id`,
    );
  }
  if (userIds.some((userId) => !isUuid(userId))) {
    throw new PopulationDefaultConfigurationError(
      `${POPULATION_DEFAULT_ALLOWLIST_ENV} contains an invalid user id`,
    );
  }
  return userIds;
}

@Injectable()
export class TypeOrmPopulationDefaultDataSource {
  constructor(private readonly dataSource: DataSource) {}

  async getPerformanceRows(
    userIds: readonly string[],
  ): Promise<PopulationDefaultPerformanceRow[]> {
    if (userIds.length === 0) {
      throw new PopulationDefaultConfigurationError(
        'Population default query requires a non-empty user allowlist',
      );
    }

    const rows = await this.dataSource
      .getRepository(ParticipantPerformance)
      .createQueryBuilder('performance')
      .select([
        'performance.matchId',
        'performance.participantId',
        'performance.userId',
        'performance.participantType',
        'performance.mode',
        'performance.resultStatus',
        'performance.typingWpm',
        'performance.accuracy',
        'performance.avgReactionTimeMs',
        'performance.avgAcquisitionTimeMs',
        'performance.createdAt',
      ])
      .where('performance.userId IN (:...userIds)', { userIds })
      .andWhere('performance.participantType = :participantType', {
        participantType: 'HUMAN',
      })
      .andWhere('performance.resultStatus = :resultStatus', {
        resultStatus: 'FINISHED',
      })
      .andWhere('performance.mode IN (:...modes)', {
        modes: ['PVP', 'AI_PRACTICE'],
      })
      .orderBy('performance.createdAt', 'DESC')
      .addOrderBy('performance.id', 'DESC')
      .getMany();

    return rows.map((row) => ({
      matchId: row.matchId,
      playerId: row.userId as string,
      participantType: row.participantType,
      mode: row.mode,
      resultStatus: row.resultStatus,
      wpm: toMetric(row.typingWpm),
      accuracy: toMetric(row.accuracy),
      reactionTimeMs: toMetric(
        row.avgAcquisitionTimeMs ?? row.avgReactionTimeMs,
      ),
      createdAt: row.createdAt.toISOString(),
      // The allowlist is the explicit consent boundary for this offline job.
      consented: true,
    }));
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function toMetric(value: number | null): number {
  return value === null ? Number.NaN : Number(value);
}
