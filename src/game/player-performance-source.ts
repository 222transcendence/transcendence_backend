import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ParticipantPerformance } from './entities/participant-performance.entity';
import type { PlayerPerformanceSample } from './player-model';

export const DEFAULT_PERFORMANCE_LIMIT = 20;
export const MAX_PERFORMANCE_LIMIT = 100;
export const OVER_FETCH_MULTIPLIER = 3;
export const MAX_OVER_FETCH = 300;

export interface PlayerPerformanceSource {
  getRecentPerformance(
    modelPlayerId: string,
    limit?: number,
  ): Promise<PlayerPerformanceSample[]>;
}

@Injectable()
export class TypeOrmPlayerPerformanceSource implements PlayerPerformanceSource {
  constructor(
    @InjectRepository(ParticipantPerformance)
    private readonly performanceRepository: Repository<ParticipantPerformance>,
  ) {}

  async getRecentPerformance(
    modelPlayerId: string,
    limit?: number,
  ): Promise<PlayerPerformanceSample[]> {
    const records = await this.getRecentPerformanceRecords(
      modelPlayerId,
      limit,
    );
    return records
      .map(toPerformanceSample)
      .filter((sample): sample is PlayerPerformanceSample => sample !== null);
  }

  async getRecentPerformanceRecords(
    modelPlayerId: string,
    limit?: number,
  ): Promise<ParticipantPerformance[]> {
    const normalizedLimit = normalizeLimit(limit);
    if (normalizedLimit === 0) return [];

    const take = Math.min(
      normalizedLimit * OVER_FETCH_MULTIPLIER,
      MAX_OVER_FETCH,
    );
    const records = await this.performanceRepository
      .createQueryBuilder('performance')
      .where('performance.userId = :modelPlayerId', { modelPlayerId })
      .andWhere('performance.participantType = :participantType', {
        participantType: 'HUMAN',
      })
      .andWhere('performance.resultStatus = :resultStatus', {
        resultStatus: 'FINISHED',
      })
      .andWhere('performance.mode IN (:...modes)', {
        modes: ['PVP', 'AI_PRACTICE'],
      })
      .andWhere('performance.typingWpm IS NOT NULL')
      .andWhere('performance.accuracy IS NOT NULL')
      .andWhere(
        '(performance.avgAcquisitionTimeMs IS NOT NULL OR performance.avgReactionTimeMs IS NOT NULL)',
      )
      .orderBy('performance.createdAt', 'DESC')
      .addOrderBy('performance.id', 'DESC')
      .take(take)
      .getMany();

    return records
      .filter((record) => toPerformanceSample(record) !== null)
      .slice(0, normalizedLimit);
  }
}

export function normalizeLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_PERFORMANCE_LIMIT;
  }
  if (limit <= 0) return 0;
  return Math.min(Math.floor(limit), MAX_PERFORMANCE_LIMIT);
}

function toPerformanceSample(
  record: ParticipantPerformance,
): PlayerPerformanceSample | null {
  if (
    record.typingWpm === null ||
    record.accuracy === null ||
    record.avgReactionTimeMs === null
  ) {
    return null;
  }

  const wpm = Number(record.typingWpm);
  const accuracy = Number(record.accuracy);
  const reactionTimeMs = Number(
    record.avgAcquisitionTimeMs ?? record.avgReactionTimeMs,
  );
  if (
    !Number.isFinite(wpm) ||
    wpm <= 0 ||
    !Number.isFinite(accuracy) ||
    accuracy < 0 ||
    accuracy > 1 ||
    !Number.isFinite(reactionTimeMs) ||
    reactionTimeMs < 0
  ) {
    return null;
  }

  return { wpm, accuracy, reactionTimeMs };
}
