import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WordAttemptRecord } from './entities/word-attempt-record.entity';
import { TypeOrmPlayerPerformanceSource } from './player-performance-source';
import {
  PLAYER_PERSONALIZATION_CONFIG,
  type WordLengthPerformance,
} from './player-personalization.config';
import type { PlayerPerformanceSample } from './player-model';

export interface PlayerBehaviorData {
  performanceSamples: PlayerPerformanceSample[];
  typoProbability: number | null;
  correctionDelayMs: number | null;
  abandonProbability: number | null;
  wordLengthPerformance: WordLengthPerformance;
  observationCounts: {
    typo: number;
    correction: number;
    abandon: number;
    wordLength: number;
  };
}

export interface PlayerBehaviorSource {
  getRecentBehavior(
    userId: string,
    limit?: number,
  ): Promise<PlayerBehaviorData>;
}

@Injectable()
export class TypeOrmPlayerBehaviorSource implements PlayerBehaviorSource {
  constructor(
    private readonly performanceSource: TypeOrmPlayerPerformanceSource,
    @InjectRepository(WordAttemptRecord)
    private readonly attemptRepository: Repository<WordAttemptRecord>,
  ) {}

  async getRecentPerformance(
    userId: string,
    limit?: number,
  ): Promise<PlayerPerformanceSample[]> {
    return this.performanceSource.getRecentPerformance(userId, limit);
  }

  async getRecentBehavior(
    userId: string,
    limit: number = PLAYER_PERSONALIZATION_CONFIG.personalSampleLimit,
  ): Promise<PlayerBehaviorData> {
    const records = await this.performanceSource.getRecentPerformanceRecords(
      userId,
      limit,
    );
    const uniquePerformances = new Map<string, (typeof records)[number]>();
    for (const record of records) {
      const key = `${record.matchId}:${record.userId ?? ''}`;
      if (!uniquePerformances.has(key)) uniquePerformances.set(key, record);
    }
    const validPerformances = [...uniquePerformances.values()].map(
      (record) => ({
        matchId: record.matchId,
        sample: {
          wpm: Number(record.typingWpm),
          accuracy: Number(record.accuracy),
          reactionTimeMs: Number(record.avgReactionTimeMs),
        },
      }),
    );

    const matchIds = new Set(validPerformances.map(({ matchId }) => matchId));
    const attempts =
      matchIds.size === 0
        ? []
        : await this.attemptRepository
            .createQueryBuilder('attempt')
            .where('attempt.userId = :userId', { userId })
            .andWhere('attempt.matchId IN (:...matchIds)', {
              matchIds: [...matchIds],
            })
            .orderBy('attempt.resolvedAt', 'DESC')
            .addOrderBy('attempt.id', 'DESC')
            .getMany();

    const uniqueAttempts = new Map<string, WordAttemptRecord>();
    for (const attempt of attempts) {
      const key = `${attempt.matchId}:${attempt.participantId}:${attempt.wordId}:${attempt.attemptNo}`;
      if (!uniqueAttempts.has(key)) uniqueAttempts.set(key, attempt);
    }
    return {
      performanceSamples: validPerformances.map(({ sample }) => sample),
      ...buildBehaviorMetrics([...uniqueAttempts.values()]),
    };
  }
}

function buildBehaviorMetrics(attempts: WordAttemptRecord[]) {
  const started = attempts.filter((attempt) => attempt.firstTypingAt !== null);
  const totalKeystrokes = attempts.reduce(
    (sum, attempt) => sum + Math.max(0, attempt.totalKeystrokes),
    0,
  );
  const typoCount = attempts.reduce(
    (sum, attempt) => sum + Math.max(0, attempt.typoCount),
    0,
  );
  // A measured zero is different from an unobserved metric. Keep zero when
  // attempts contain keystroke observations so the profile can distinguish
  // an accurate player from a dataset with no typing data.
  const typoProbability =
    totalKeystrokes > 0 ? typoCount / totalKeystrokes : null;
  const abandoned = started.filter((attempt) => attempt.result === 'GIVE_UP');
  const abandonProbability =
    started.length > 0 ? abandoned.length / started.length : null;
  const wordLengthPerformance: WordLengthPerformance = {
    short: wordLengthObservation(attempts, 'short'),
    medium: wordLengthObservation(attempts, 'medium'),
    long: wordLengthObservation(attempts, 'long'),
  };
  const wordLengthSampleCount = attempts.filter(
    (attempt) =>
      typeof attempt.targetKeystrokes === 'number' &&
      attempt.targetKeystrokes > 0,
  ).length;

  return {
    typoProbability,
    correctionDelayMs: null,
    abandonProbability,
    wordLengthPerformance,
    observationCounts: {
      typo: totalKeystrokes,
      correction: 0,
      abandon: abandoned.length,
      wordLength: wordLengthSampleCount,
    },
  };
}

function unavailableObservation() {
  return {
    value: null,
    sampleCount: 0,
    confidence: 0,
    available: false,
  };
}

type WordLengthBucket = 'short' | 'medium' | 'long';

function wordLengthBucket(targetKeystrokes: number): WordLengthBucket {
  if (targetKeystrokes <= 5) return 'short';
  if (targetKeystrokes <= 8) return 'medium';
  return 'long';
}

function wordLengthObservation(
  attempts: WordAttemptRecord[],
  bucket: WordLengthBucket,
) {
  const observed = attempts.filter(
    (attempt) =>
      typeof attempt.targetKeystrokes === 'number' &&
      attempt.targetKeystrokes > 0 &&
      wordLengthBucket(attempt.targetKeystrokes) === bucket,
  );
  if (observed.length === 0) return unavailableObservation();
  const successful = observed.filter(
    (attempt) =>
      attempt.result === 'CORRECT' ||
      attempt.result === 'CORRECT_AFTER_CORRECTION',
  ).length;
  return {
    value: successful / observed.length,
    sampleCount: observed.length,
    confidence: Math.min(
      1,
      observed.length / PLAYER_PERSONALIZATION_CONFIG.priorSampleCount,
    ),
    available: true,
  };
}
