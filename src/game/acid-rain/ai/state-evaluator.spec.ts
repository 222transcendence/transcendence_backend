import {
  ActiveWordCandidate,
  AiTypingProfile,
  evaluateUtility,
  UtilityEvaluationInput,
} from './state-evaluator';

const profile: AiTypingProfile = {
  reactionMs: 200,
  perKeystrokeMs: 100,
  uncertaintyMs: 100,
  urgencyWindowMs: 3000,
  damageWeight: 1,
  urgencyWeight: 1,
  opportunityCostWeight: 1,
  switchMargin: 0.5,
};

function word(
  wordId: string,
  keystrokes: number,
  landAtMs: number,
  damage = 5,
): ActiveWordCandidate {
  return { wordId, keystrokes, landAtMs, damage };
}

function input(
  activeWords: readonly ActiveWordCandidate[],
  overrides: Partial<UtilityEvaluationInput> = {},
): UtilityEvaluationInput {
  return {
    nowMs: 0,
    activeWords,
    reservations: new Map(),
    profile,
    ...overrides,
  };
}

describe('evaluateUtility', () => {
  it('returns NO_TARGET when there is no current target or feasible candidate', () => {
    expect(evaluateUtility(input([word('late', 5, 300)])).action).toBe(
      'NO_TARGET',
    );
  });

  it('selects a candidate when no current target exists', () => {
    const result = evaluateUtility(input([word('a', 2, 2000)]));

    expect(result.action).toBe('SELECT');
    expect(result.targetWordId).toBe('a');
  });

  it('keeps a valid current target', () => {
    const result = evaluateUtility(
      input([word('a', 2, 2000)], {
        currentTarget: { wordId: 'a', execution: { state: 'NOT_STARTED' } },
      }),
    );

    expect(result).toMatchObject({ action: 'KEEP', targetWordId: 'a' });
  });

  it('switches to a better target before input starts', () => {
    const result = evaluateUtility(
      input([word('a', 2, 2000, 5), word('b', 2, 2500, 20)], {
        currentTarget: { wordId: 'a', execution: { state: 'NOT_STARTED' } },
      }),
    );

    expect(result).toMatchObject({ action: 'SWITCH', targetWordId: 'b' });
  });

  it('does not charge reaction time again for an in-progress target', () => {
    const result = evaluateUtility(
      input([word('a', 3, 500)], {
        currentTarget: {
          wordId: 'a',
          execution: { state: 'IN_PROGRESS', remainingKeystrokes: 2 },
        },
      }),
    );
    const candidate = result.rankedCandidates[0];

    expect(candidate).toMatchObject({ wordId: 'a', completionMs: 200 });
  });

  it('validates remaining keystrokes only when the current word is active', () => {
    const result = evaluateUtility(
      input([word('replacement', 2, 2000)], {
        currentTarget: {
          wordId: 'gone',
          execution: { state: 'IN_PROGRESS', remainingKeystrokes: 999 },
        },
      }),
    );

    expect(result).toMatchObject({
      action: 'SWITCH',
      targetWordId: 'replacement',
    });
  });

  it('abandons a missing current target when no replacement exists', () => {
    const result = evaluateUtility(
      input([], {
        currentTarget: {
          wordId: 'landed',
          execution: { state: 'IN_PROGRESS', remainingKeystrokes: 999 },
        },
      }),
    );

    expect(result).toMatchObject({ action: 'ABANDON' });
    expect(result.targetWordId).toBeUndefined();
  });

  it('rejects excessive remaining keystrokes for an active current word', () => {
    expect(() =>
      evaluateUtility(
        input([word('a', 3, 2000)], {
          currentTarget: {
            wordId: 'a',
            execution: { state: 'IN_PROGRESS', remainingKeystrokes: 4 },
          },
        }),
      ),
    ).toThrow(RangeError);
  });

  it('includes every newly unreachable alternative in opportunity cost', () => {
    const result = evaluateUtility(
      input([
        word('a', 8, 5000, 10),
        word('b', 6, 1800, 8),
        word('c', 4, 1800, 6),
      ]),
    );
    const a = result.rankedCandidates.find(
      (candidate) => candidate.wordId === 'a',
    );

    expect(a?.opportunityCost).toBeGreaterThan(0);
    expect(a?.opportunityCost).toBeGreaterThan(
      result.rankedCandidates.find((candidate) => candidate.wordId === 'b')
        ?.opportunityCost ?? 0,
    );
  });

  it('includes reaction time when starting an alternative after A', () => {
    const result = evaluateUtility(
      input([word('a', 8, 5000, 10), word('b', 6, 1800, 8)]),
    );
    const a = result.rankedCandidates.find(
      (candidate) => candidate.wordId === 'a',
    );

    expect(a?.opportunityCost).toBeGreaterThan(0);
  });

  it('does not charge opportunity cost for an alternative that remains reachable', () => {
    const result = evaluateUtility(
      input([word('a', 8, 5000, 10), word('b', 6, 2200, 8)]),
    );
    const a = result.rankedCandidates.find(
      (candidate) => candidate.wordId === 'a',
    );

    expect(a?.opportunityCost).toBe(0);
  });

  it('uses server damage without recalculating it from keystrokes', () => {
    const result = evaluateUtility(input([word('a', 10, 3000, 1)]));

    expect(result.rankedCandidates[0].utility).toBeLessThan(2);
  });

  it('lets urgency influence a controlled equal-success decision', () => {
    const result = evaluateUtility(
      input([word('late', 1, 3000, 1), word('urgent', 1, 1000, 1)], {
        profile: {
          ...profile,
          uncertaintyMs: 0,
          damageWeight: 0,
          urgencyWeight: 1,
        },
      }),
    );

    expect(result.targetWordId).toBe('urgent');
  });

  it('does not always prefer urgency when damage is weighted higher', () => {
    const result = evaluateUtility(
      input([word('urgent', 1, 1000, 1), word('valuable', 1, 3000, 20)], {
        profile: {
          ...profile,
          uncertaintyMs: 0,
          damageWeight: 10,
          urgencyWeight: 1,
        },
      }),
    );

    expect(result.targetWordId).toBe('valuable');
  });

  it('excludes other reservations but keeps self reservations eligible', () => {
    const result = evaluateUtility(
      input([word('self', 1, 3000), word('other', 1, 3000)], {
        reservations: new Map([
          ['self', { owner: 'SELF' }],
          ['other', { owner: 'OTHER' }],
        ]),
      }),
    );

    expect(
      result.rankedCandidates.map((candidate) => candidate.wordId),
    ).toEqual(['self']);
  });

  it.each([
    ['reactionMs', { reactionMs: -1 }],
    ['perKeystrokeMs', { perKeystrokeMs: 0 }],
    ['uncertaintyMs', { uncertaintyMs: Number.NaN }],
    ['damageWeight', { damageWeight: -1 }],
    ['switchMargin', { switchMargin: Number.POSITIVE_INFINITY }],
  ])('rejects invalid profile value: %s', (_name, change) => {
    expect(() =>
      evaluateUtility(
        input([word('a', 1, 3000)], {
          profile: { ...profile, ...change },
        }),
      ),
    ).toThrow(RangeError);
  });

  it('uses deterministic wordId ordering for ties', () => {
    const result = evaluateUtility(
      input([word('z', 1, 3000), word('a', 1, 3000)], {
        profile: { ...profile, damageWeight: 1, urgencyWeight: 0 },
      }),
    );

    expect(result.targetWordId).toBe('a');
  });
});
