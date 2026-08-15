import {
  parsePopulationDefaultAllowlist,
  PopulationDefaultConfigurationError,
  TypeOrmPopulationDefaultDataSource,
} from './population-default.data-source';

describe('population default data source', () => {
  it('requires an explicit allowlist and never falls back to all users', () => {
    expect(() => parsePopulationDefaultAllowlist({})).toThrow(
      PopulationDefaultConfigurationError,
    );
    expect(() =>
      parsePopulationDefaultAllowlist({
        AI_POPULATION_DEFAULT_USER_ALLOWLIST: ' , ',
      }),
    ).toThrow(PopulationDefaultConfigurationError);
  });

  it('deduplicates and sorts allowlisted user ids without exposing them in reports', () => {
    const ids = [
      '550e8400-e29b-41d4-a716-446655440001',
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400-e29b-41d4-a716-446655440001',
    ];
    expect(
      parsePopulationDefaultAllowlist({
        AI_POPULATION_DEFAULT_USER_ALLOWLIST: ids.join(', '),
      }),
    ).toEqual([ids[1], ids[0]]);
  });

  it('uses a parameterized read-only TypeORM query and maps aggregate rows', async () => {
    const getMany = jest.fn().mockResolvedValue([
      {
        matchId: 'match-1',
        userId: '550e8400-e29b-41d4-a716-446655440000',
        participantType: 'HUMAN',
        mode: 'AI_PRACTICE',
        resultStatus: 'FINISHED',
        typingWpm: 40,
        accuracy: 0.9,
        avgReactionTimeMs: 600,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const query = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany,
    };
    const dataSource = {
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(query),
      }),
    } as never;
    const source = new TypeOrmPopulationDefaultDataSource(dataSource);
    const rows = await source.getPerformanceRows([
      '550e8400-e29b-41d4-a716-446655440000',
    ]);

    expect(query.where).toHaveBeenCalledWith(
      'performance.userId IN (:...userIds)',
      { userIds: ['550e8400-e29b-41d4-a716-446655440000'] },
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'performance.participantType = :participantType',
      { participantType: 'HUMAN' },
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'performance.resultStatus = :resultStatus',
      { resultStatus: 'FINISHED' },
    );
    expect(query.andWhere).toHaveBeenCalledWith(
      'performance.mode IN (:...modes)',
      { modes: ['PVP', 'AI_PRACTICE'] },
    );
    expect(rows).toEqual([
      {
        matchId: 'match-1',
        playerId: '550e8400-e29b-41d4-a716-446655440000',
        participantType: 'HUMAN',
        mode: 'AI_PRACTICE',
        resultStatus: 'FINISHED',
        wpm: 40,
        accuracy: 0.9,
        reactionTimeMs: 600,
        createdAt: '2026-01-01T00:00:00.000Z',
        consented: true,
      },
    ]);
  });

  it('does not query when the allowlist passed to the source is empty', async () => {
    const getRepository = jest.fn();
    const source = new TypeOrmPopulationDefaultDataSource({
      getRepository,
    } as never);

    await expect(source.getPerformanceRows([])).rejects.toThrow(
      PopulationDefaultConfigurationError,
    );
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('preserves a missing metric as invalid instead of converting null to zero', async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([
        {
          matchId: 'match-1',
          userId: '550e8400-e29b-41d4-a716-446655440000',
          participantType: 'HUMAN',
          mode: 'PVP',
          resultStatus: 'FINISHED',
          typingWpm: null,
          accuracy: 0.9,
          avgReactionTimeMs: 600,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]),
    };
    const source = new TypeOrmPopulationDefaultDataSource({
      getRepository: jest.fn().mockReturnValue({
        createQueryBuilder: jest.fn().mockReturnValue(query),
      }),
    } as never);

    const [row] = await source.getPerformanceRows([
      '550e8400-e29b-41d4-a716-446655440000',
    ]);

    expect(row.wpm).toBeNaN();
  });
});
