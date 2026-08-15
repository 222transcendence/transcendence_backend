import {
  estimatePopulationDefault,
  serializePopulationDefaultReport,
  type PopulationDefaultInput,
} from './population-default.estimator';

const sample = (
  playerId: string,
  matchId: string,
  createdAt: string,
): PopulationDefaultInput => ({
  playerId,
  matchId,
  createdAt,
  participantType: 'HUMAN',
  mode: 'AI_PRACTICE',
  resultStatus: 'FINISHED',
  consented: true,
  wpm: 40,
  accuracy: 0.9,
  reactionTimeMs: 600,
});

describe('estimatePopulationDefault', () => {
  it('requires balanced, consented players and caps each player deterministically', () => {
    const input = [
      ...['p1', 'p2', 'p3'].flatMap((playerId) =>
        Array.from({ length: 4 }, (_, index) =>
          sample(playerId, `${playerId}-${index}`, `2026-01-0${index + 1}`),
        ),
      ),
      { ...sample('p4', 'p4-1', '2026-01-01'), consented: false },
    ];

    const estimate = estimatePopulationDefault(input);

    expect(estimate.eligibleForRuntime).toBe(true);
    expect(estimate.distinctPlayers).toBe(3);
    expect(estimate.validMatches).toBe(12);
    expect(estimate.perPlayerMatchCounts).toEqual({ p1: 4, p2: 4, p3: 4 });
    expect(estimate.exclusionReasons).toContain('NO_EXPLICIT_CONSENT');
  });

  it('publishes a developer baseline from one balanced player', () => {
    const estimate = estimatePopulationDefault([
      sample('only-player', 'm1', '2026-01-01'),
      sample('only-player', 'm2', '2026-01-02'),
      sample('only-player', 'm3', '2026-01-03'),
    ]);

    expect(estimate.eligibleForRuntime).toBe(true);
    expect(estimate.profile).not.toBeNull();
    expect(estimate.distinctPlayers).toBe(1);
  });

  it('rejects duplicate match-participant rows and invalid lifecycle records', () => {
    const first = sample('p1', 'm1', '2026-01-01');
    const estimate = estimatePopulationDefault([
      first,
      first,
      { ...sample('p2', 'm2', '2026-01-02'), accuracy: Number.NaN },
      { ...sample('p3', 'm3', '2026-01-03'), resultStatus: 'ABORTED' },
    ]);

    expect(estimate.validMatches).toBe(1);
    expect(estimate.exclusionReasons).toEqual([
      'DUPLICATE_MATCH_PARTICIPANT',
      'INSUFFICIENT_MATCHES_PER_PLAYER',
      'INVALID_METRIC',
      'NOT_FINISHED',
    ]);
    expect(serializePopulationDefaultReport(estimate)).toContain(
      'policyVersion',
    );
  });

  it('uses the latest ten rows per player and reports range violations', () => {
    const estimate = estimatePopulationDefault(
      Array.from({ length: 11 }, (_, index) =>
        sample(
          'p1',
          `m-${index}`,
          `2026-01-${String(index + 1).padStart(2, '0')}`,
        ),
      ).concat({ ...sample('p2', 'bad', '2026-02-01'), wpm: 0 }),
    );

    expect(estimate.validMatches).toBe(10);
    expect(estimate.usedMatches).toBe(10);
    expect(estimate.exclusionCounts.PLAYER_MATCH_CAP).toBe(1);
    expect(estimate.exclusionCounts.OUT_OF_RANGE).toBe(1);
    expect(estimate.gateFailureReasons).toEqual([]);
  });

  it('keeps slow but positive WPM samples while rejecting only invalid dataset bounds', () => {
    const accepted = estimatePopulationDefault([
      { ...sample('p1', 'slow', '2026-01-01'), wpm: 16.25 },
      { ...sample('p1', 'lower-bound', '2026-01-02'), wpm: 0.1 },
      { ...sample('p1', 'upper-bound', '2026-01-03'), wpm: 300 },
    ]);
    const rejected = estimatePopulationDefault([
      { ...sample('p1', 'zero', '2026-01-01'), wpm: 0 },
      { ...sample('p1', 'too-fast', '2026-01-02'), wpm: 300.01 },
    ]);

    expect(accepted.validMatches).toBe(3);
    expect(accepted.exclusionCounts.OUT_OF_RANGE).toBeUndefined();
    expect(rejected.validMatches).toBe(0);
    expect(rejected.exclusionCounts.OUT_OF_RANGE).toBe(2);
  });

  it('serializes an anonymized report with the candidate only after the gate passes', () => {
    const input = ['p1', 'p2', 'p3'].flatMap((playerId) =>
      Array.from({ length: 3 }, (_, index) =>
        sample(playerId, `${playerId}-${index}`, `2026-01-0${index + 1}`),
      ),
    );
    const report = serializePopulationDefaultReport(
      estimatePopulationDefault(input),
      { generatedAt: 'fixed-time', allowlistCount: 3, queriedMatches: 9 },
    );
    const parsed = JSON.parse(report) as Record<string, unknown>;

    expect(parsed.gatePassed).toBe(true);
    expect(parsed.populationCandidate).toEqual({
      wpm: 40,
      accuracy: 0.9,
      reactionTimeMs: 600,
    });
    expect(parsed.playerContributions).toEqual([
      { contributionUnit: 'player-001', matchCount: 3 },
      { contributionUnit: 'player-002', matchCount: 3 },
      { contributionUnit: 'player-003', matchCount: 3 },
    ]);
    expect(report).not.toContain('p1');
    expect(report).not.toContain('submittedText');
    expect(report).not.toContain('partialText');
  });

  it('produces the same anonymized result regardless of input order', () => {
    const input = ['p1', 'p2', 'p3'].flatMap((playerId) =>
      Array.from({ length: 3 }, (_, index) =>
        sample(playerId, `${playerId}-${index}`, `2026-01-0${index + 1}`),
      ),
    );
    const first = serializePopulationDefaultReport(
      estimatePopulationDefault(input),
      { generatedAt: 'fixed-time', allowlistCount: 3, queriedMatches: 9 },
    );
    const second = serializePopulationDefaultReport(
      estimatePopulationDefault([...input].reverse()),
      { generatedAt: 'fixed-time', allowlistCount: 3, queriedMatches: 9 },
    );

    expect(second).toBe(first);
  });
});
