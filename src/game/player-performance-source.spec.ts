import { ParticipantPerformance } from './entities/participant-performance.entity';
import {
  DEFAULT_PERFORMANCE_LIMIT,
  MAX_OVER_FETCH,
  MAX_PERFORMANCE_LIMIT,
  TypeOrmPlayerPerformanceSource,
} from './player-performance-source';

function record(
  overrides: Partial<ParticipantPerformance> = {},
): ParticipantPerformance {
  return {
    id: 'performance-1',
    matchId: 'match-1',
    participantId: 'human-1',
    userId: 'user-1',
    participantType: 'HUMAN',
    mode: 'PVP',
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

function setup(records: ParticipantPerformance[] = []) {
  const builder = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    leftJoin: jest.fn(),
    innerJoin: jest.fn(),
    leftJoinAndSelect: jest.fn(),
    innerJoinAndSelect: jest.fn(),
    getMany: jest.fn().mockResolvedValue(records),
  } as Record<string, jest.Mock>;
  Object.values(builder).forEach((method) => method.mockReturnValue(builder));
  builder.getMany.mockResolvedValue(records);

  const repository = {
    createQueryBuilder: jest.fn(() => builder),
  };
  return {
    source: new TypeOrmPlayerPerformanceSource(repository as never),
    builder,
    repository,
  };
}

describe('TypeOrmPlayerPerformanceSource', () => {
  it('maps valid PVP and AI practice HUMAN rows and applies query filters', async () => {
    const context = setup([
      record({ mode: 'PVP', id: 'pvp' }),
      record({ mode: 'AI_PRACTICE', id: 'practice' }),
    ]);

    await expect(
      context.source.getRecentPerformance('user-1', 2),
    ).resolves.toEqual([
      { wpm: 45, accuracy: 0.9, reactionTimeMs: 650 },
      { wpm: 45, accuracy: 0.9, reactionTimeMs: 650 },
    ]);
    expect(context.repository.createQueryBuilder).toHaveBeenCalledWith(
      'performance',
    );
    expect(context.builder.where).toHaveBeenCalledWith(
      'performance.userId = :modelPlayerId',
      { modelPlayerId: 'user-1' },
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.participantType = :participantType',
      { participantType: 'HUMAN' },
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.resultStatus = :resultStatus',
      { resultStatus: 'FINISHED' },
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.mode IN (:...modes)',
      { modes: ['PVP', 'AI_PRACTICE'] },
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.typingWpm IS NOT NULL',
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.accuracy IS NOT NULL',
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.avgReactionTimeMs IS NOT NULL',
    );
    expect(context.builder.orderBy).toHaveBeenCalledWith(
      'performance.createdAt',
      'DESC',
    );
    expect(context.builder.addOrderBy).toHaveBeenCalledWith(
      'performance.id',
      'DESC',
    );
    expect(context.builder.take).toHaveBeenCalledWith(6);
    expect(context.builder.leftJoin).not.toHaveBeenCalled();
    expect(context.builder.innerJoin).not.toHaveBeenCalled();
    expect(context.builder.leftJoinAndSelect).not.toHaveBeenCalled();
    expect(context.builder.innerJoinAndSelect).not.toHaveBeenCalled();
  });

  it('uses query filters to exclude AI, mismatched users, ABORTED, and VOID rows', async () => {
    const context = setup([
      record({
        participantType: 'HUMAN',
        userId: 'user-1',
        resultStatus: 'FINISHED',
      }),
    ]);

    await context.source.getRecentPerformance('user-1');

    expect(context.builder.where).toHaveBeenCalledWith(
      'performance.userId = :modelPlayerId',
      { modelPlayerId: 'user-1' },
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.participantType = :participantType',
      { participantType: 'HUMAN' },
    );
    expect(context.builder.andWhere).toHaveBeenCalledWith(
      'performance.resultStatus = :resultStatus',
      { resultStatus: 'FINISHED' },
    );
    expect(context.builder.andWhere).not.toHaveBeenCalledWith(
      expect.stringContaining('ABORTED'),
    );
    expect(context.builder.andWhere).not.toHaveBeenCalledWith(
      expect.stringContaining('VOID'),
    );
  });

  it('excludes invalid rows while retaining finite extreme WPM and reaction values', async () => {
    const context = setup([
      record({ typingWpm: 0 }),
      record({ accuracy: -0.1 }),
      record({ accuracy: 1.1 }),
      record({ avgReactionTimeMs: -1 }),
      record({ typingWpm: 999_999, avgReactionTimeMs: 999_999 }),
      record({
        typingWpm: '55.5' as unknown as number,
        accuracy: '0.8' as unknown as number,
      }),
    ]);

    await expect(
      context.source.getRecentPerformance('user-1', 20),
    ).resolves.toEqual([
      { wpm: 999_999, accuracy: 0.9, reactionTimeMs: 999_999 },
      { wpm: 55.5, accuracy: 0.8, reactionTimeMs: 650 },
    ]);
  });

  it('excludes null required values and non-finite runtime values', async () => {
    const context = setup([
      record({ typingWpm: null }),
      record({ accuracy: null }),
      record({ avgReactionTimeMs: null }),
      record({ typingWpm: Number.NaN }),
      record({ accuracy: Number.POSITIVE_INFINITY }),
      record({ avgReactionTimeMs: Number.NEGATIVE_INFINITY }),
    ]);

    await expect(
      context.source.getRecentPerformance('user-1'),
    ).resolves.toEqual([]);
  });

  it.each([
    ['NaN WPM', { typingWpm: Number.NaN }],
    ['Infinity WPM', { typingWpm: Number.POSITIVE_INFINITY }],
    ['zero WPM', { typingWpm: 0 }],
    ['negative WPM', { typingWpm: -1 }],
    ['negative accuracy', { accuracy: -0.01 }],
    ['accuracy above one', { accuracy: 1.01 }],
    ['negative reaction', { avgReactionTimeMs: -1 }],
    ['Infinity reaction', { avgReactionTimeMs: Number.POSITIVE_INFINITY }],
  ])('excludes %s during runtime mapping', async (_name, overrides) => {
    const context = setup([record(overrides)]);

    await expect(
      context.source.getRecentPerformance('user-1'),
    ).resolves.toEqual([]);
  });

  it('does not filter by duration or stored per-match sampleCount', async () => {
    const context = setup([record({ typingDurationMs: 1, sampleCount: 0 })]);

    await expect(
      context.source.getRecentPerformance('user-1'),
    ).resolves.toEqual([{ wpm: 45, accuracy: 0.9, reactionTimeMs: 650 }]);
  });

  it('normalizes limits and bounds the query', async () => {
    const defaultContext = setup([]);
    await defaultContext.source.getRecentPerformance('user-1');
    expect(defaultContext.builder.take).toHaveBeenCalledWith(
      DEFAULT_PERFORMANCE_LIMIT * 3,
    );

    const nanContext = setup([]);
    await nanContext.source.getRecentPerformance('user-1', Number.NaN);
    expect(nanContext.builder.take).toHaveBeenCalledWith(60);

    const infinityContext = setup([]);
    await infinityContext.source.getRecentPerformance('user-1', Infinity);
    expect(infinityContext.builder.take).toHaveBeenCalledWith(60);

    const maxContext = setup([]);
    await maxContext.source.getRecentPerformance('user-1', 999);
    expect(maxContext.builder.take).toHaveBeenCalledWith(MAX_OVER_FETCH);
    expect(MAX_PERFORMANCE_LIMIT).toBe(100);

    const fractionalContext = setup([record(), record(), record()]);
    await fractionalContext.source.getRecentPerformance('user-1', 2.9);
    expect(fractionalContext.builder.take).toHaveBeenCalledWith(6);
    expect(
      await fractionalContext.source.getRecentPerformance('user-1', 0),
    ).toEqual([]);
    expect(
      fractionalContext.repository.createQueryBuilder,
    ).toHaveBeenCalledTimes(1);

    const negativeContext = setup([]);
    await expect(
      negativeContext.source.getRecentPerformance('user-1', -1),
    ).resolves.toEqual([]);
    expect(
      negativeContext.repository.createQueryBuilder,
    ).not.toHaveBeenCalled();

    const cappedContext = setup(Array.from({ length: 101 }, () => record()));
    const capped = await cappedContext.source.getRecentPerformance(
      'user-1',
      100,
    );
    expect(capped).toHaveLength(100);
    expect(cappedContext.builder.take).toHaveBeenCalledWith(300);

    const invalidAfterOverFetchContext = setup(
      Array.from({ length: 300 }, (_, index) =>
        record({ typingWpm: index % 2 === 0 ? 0 : 50 }),
      ),
    );
    const bounded =
      await invalidAfterOverFetchContext.source.getRecentPerformance(
        'user-1',
        20,
      );
    expect(bounded.length).toBeLessThanOrEqual(20);
    expect(invalidAfterOverFetchContext.builder.take).toHaveBeenCalledWith(60);
  });

  it('propagates repository errors', async () => {
    const context = setup();
    context.builder.getMany.mockRejectedValue(new Error('db unavailable'));

    await expect(context.source.getRecentPerformance('user-1')).rejects.toThrow(
      'db unavailable',
    );
  });
});
