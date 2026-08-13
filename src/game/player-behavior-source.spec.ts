import { ParticipantPerformance } from './entities/participant-performance.entity';
import { WordAttemptRecord } from './entities/word-attempt-record.entity';
import { TypeOrmPlayerBehaviorSource } from './player-behavior-source';
import { TypeOrmPlayerPerformanceSource } from './player-performance-source';

function performance(
  overrides: Partial<ParticipantPerformance> = {},
): ParticipantPerformance {
  return {
    id: 'performance-1',
    matchId: 'match-1',
    participantId: 'human-1',
    userId: 'user-a',
    participantType: 'HUMAN',
    mode: 'AI_PRACTICE',
    resultStatus: 'FINISHED',
    correctWords: 10,
    wrongAttempts: 1,
    missedWords: 0,
    typoCount: 0,
    correctionCount: 0,
    abandonedWords: 0,
    totalKeystrokes: 20,
    typingWpm: 45,
    accuracy: 0.9,
    avgReactionTimeMs: 650,
    medianReactionTimeMs: null,
    avgCompletionTimeMs: null,
    sampleCount: 11,
    typingDurationMs: 60_000,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function attempt(
  overrides: Partial<WordAttemptRecord> = {},
): WordAttemptRecord {
  return {
    id: 'attempt-1',
    matchId: 'match-1',
    participantId: 'human-1',
    userId: 'user-a',
    wordId: 'runtime-word-1',
    attemptNo: 1,
    result: 'GIVE_UP',
    wordSpawnedAt: new Date('2026-01-01T00:00:00Z'),
    firstTypingAt: new Date('2026-01-01T00:00:01Z'),
    lastTypingAt: new Date('2026-01-01T00:00:02Z'),
    submitReceivedAt: null,
    resolvedAt: new Date('2026-01-01T00:00:03Z'),
    submittedText: null,
    typoCount: 0,
    correctionCount: 0,
    totalKeystrokes: 4,
    ...overrides,
  };
}

function queryBuilder(records: unknown[]) {
  const builder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    getMany: jest.fn().mockResolvedValue(records),
  } as Record<string, jest.Mock>;
  Object.values(builder).forEach((method) => method.mockReturnValue(builder));
  builder.getMany.mockResolvedValue(records);
  return builder;
}

describe('TypeOrmPlayerBehaviorSource', () => {
  it('queries only the requested user and derives supported behavior metrics', async () => {
    const performanceBuilder = queryBuilder([performance()]);
    const attemptBuilder = queryBuilder([
      attempt({ totalKeystrokes: 0 }),
      attempt({
        id: 'attempt-short',
        wordId: 'runtime-word-short',
        result: 'CORRECT',
        totalKeystrokes: 4,
      }),
      attempt({
        id: 'attempt-duplicate',
        result: 'CORRECT',
        totalKeystrokes: 11,
      }),
      attempt({
        id: 'attempt-medium',
        wordId: 'runtime-word-3',
        result: 'CORRECT',
        totalKeystrokes: 8,
      }),
      attempt({
        id: 'attempt-long',
        wordId: 'runtime-word-long',
        result: 'CORRECT',
        totalKeystrokes: 12,
      }),
      attempt({
        id: 'attempt-missed',
        wordId: 'runtime-word-2',
        result: 'MISSED',
        totalKeystrokes: 0,
      }),
    ]);
    const performanceRepository = {
      createQueryBuilder: jest.fn(() => performanceBuilder),
    };
    const attemptRepository = {
      createQueryBuilder: jest.fn(() => attemptBuilder),
    };
    const performanceSource = new TypeOrmPlayerPerformanceSource(
      performanceRepository as never,
    );
    const source = new TypeOrmPlayerBehaviorSource(
      performanceSource,
      attemptRepository as never,
    );

    const result = await source.getRecentBehavior('user-a');

    expect(performanceBuilder.where).toHaveBeenCalledWith(
      'performance.userId = :modelPlayerId',
      { modelPlayerId: 'user-a' },
    );
    expect(attemptBuilder.where).toHaveBeenCalledWith(
      'attempt.userId = :userId',
      { userId: 'user-a' },
    );
    expect(result.performanceSamples).toEqual([
      { wpm: 45, accuracy: 0.9, reactionTimeMs: 650 },
    ]);
    expect(result.abandonProbability).toBe(1 / 5);
    expect(result.correctionDelayMs).toBeNull();
    expect(result.wordLengthPerformance.short.value).toBeNull();
    expect(result.wordLengthPerformance.medium.value).toBeNull();
    expect(result.wordLengthPerformance.long.value).toBeNull();
  });

  it('does not invent typo probability when the stored typo event count is zero', async () => {
    const performanceSource = new TypeOrmPlayerPerformanceSource({
      createQueryBuilder: () => queryBuilder([performance()]),
    } as never);
    const source = new TypeOrmPlayerBehaviorSource(performanceSource, {
      createQueryBuilder: () => queryBuilder([attempt({ result: 'CORRECT' })]),
    } as never);

    await expect(source.getRecentBehavior('user-a')).resolves.toMatchObject({
      typoProbability: null,
      observationCounts: { typo: 0, correction: 0 },
    });
  });
});
