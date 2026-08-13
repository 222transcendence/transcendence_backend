import {
  buildPlayerSkillProfile,
  DEFAULT_PLAYER_SKILL,
  toAiExecutionProfile,
  PlayerPerformanceSample,
  PlayerSkillProfile,
} from './player-model';

const SAMPLE: PlayerPerformanceSample = {
  wpm: 80,
  accuracy: 0.96,
  reactionTimeMs: 400,
};

const DIFFICULTIES = ['BEGINNER', 'NORMAL', 'HARD'] as const;

describe('player model', () => {
  it('returns the exact default profile when every sample is excluded', () => {
    expect(
      buildPlayerSkillProfile([
        { ...SAMPLE, wpm: Number.NaN },
        { ...SAMPLE, accuracy: Number.POSITIVE_INFINITY },
        { ...SAMPLE, reactionTimeMs: Number.NEGATIVE_INFINITY },
      ]),
    ).toEqual(DEFAULT_PLAYER_SKILL);
  });

  it('excludes a sample when any field is non-finite', () => {
    const result = buildPlayerSkillProfile([
      SAMPLE,
      { ...SAMPLE, wpm: Number.NaN },
      { ...SAMPLE, accuracy: Number.POSITIVE_INFINITY },
    ]);

    expect(result.sampleCount).toBe(1);
    expect(result.confidence).toBe(0.2);
  });

  it('clamps finite outliers and counts them as valid samples', () => {
    const result = buildPlayerSkillProfile([
      { wpm: -100, accuracy: -1, reactionTimeMs: -10 },
      {
        wpm: Number.MAX_VALUE,
        accuracy: Number.MAX_VALUE,
        reactionTimeMs: Number.MAX_VALUE,
      },
    ]);

    expect(result.sampleCount).toBe(2);
    expect(result.wpm).toBeGreaterThanOrEqual(20);
    expect(result.wpm).toBeLessThanOrEqual(140);
    expect(result.accuracy).toBeGreaterThanOrEqual(0.7);
    expect(result.accuracy).toBeLessThanOrEqual(0.98);
    expect(result.reactionTimeMs).toBeGreaterThanOrEqual(250);
    expect(result.reactionTimeMs).toBeLessThanOrEqual(2000);
  });

  it('blends one sample with the default using prior confidence', () => {
    const result = buildPlayerSkillProfile([SAMPLE]);

    expect(result.sampleCount).toBe(1);
    expect(result.confidence).toBe(0.2);
    expect(result.wpm).toBe(133);
    expect(result.accuracy).toBe(0.98);
    expect(result.reactionTimeMs).toBe(1083);
  });

  it('uses the arithmetic mean for multiple samples', () => {
    const result = buildPlayerSkillProfile([
      { wpm: 60, accuracy: 0.8, reactionTimeMs: 500 },
      { wpm: 100, accuracy: 1, reactionTimeMs: 900 },
    ]);

    expect(result.sampleCount).toBe(2);
    expect(result.wpm).toBe(124);
    expect(result.accuracy).toBe(0.9667);
    expect(result.reactionTimeMs).toBe(1069);
  });

  it('increases confidence and converges toward observations with more samples', () => {
    const one = buildPlayerSkillProfile([SAMPLE]);
    const four = buildPlayerSkillProfile(
      Array.from({ length: 4 }, () => SAMPLE),
    );
    const eight = buildPlayerSkillProfile(
      Array.from({ length: 8 }, () => SAMPLE),
    );

    expect(one.confidence).toBeLessThan(four.confidence);
    expect(four.confidence).toBeLessThan(eight.confidence);
    expect(Math.abs(eight.wpm - SAMPLE.wpm)).toBeLessThan(
      Math.abs(one.wpm - SAMPLE.wpm),
    );
  });

  it('is independent of input order and does not mutate samples', () => {
    const samples = [SAMPLE, { wpm: 30, accuracy: 0.85, reactionTimeMs: 1000 }];
    const snapshot = structuredClone(samples);

    expect(buildPlayerSkillProfile(samples)).toEqual(
      buildPlayerSkillProfile([...samples].reverse()),
    );
    expect(samples).toEqual(snapshot);
  });

  it('keeps all difficulty outputs within documented ranges', () => {
    const skills: PlayerSkillProfile[] = [
      {
        wpm: 20,
        accuracy: 0.7,
        reactionTimeMs: 250,
        sampleCount: 0,
        confidence: 0,
      },
      {
        wpm: 80,
        accuracy: 0.85,
        reactionTimeMs: 1000,
        sampleCount: 3,
        confidence: 0.4,
      },
      {
        wpm: 140,
        accuracy: 0.98,
        reactionTimeMs: 2000,
        sampleCount: 10,
        confidence: 1,
      },
      {
        wpm: Number.NaN,
        accuracy: Number.POSITIVE_INFINITY,
        reactionTimeMs: -1,
        sampleCount: -4,
        confidence: 2,
      },
    ];

    for (const skill of skills) {
      for (const difficulty of DIFFICULTIES) {
        const output = toAiExecutionProfile(skill, difficulty);
        expect(output.typingWpm).toBeGreaterThanOrEqual(20);
        expect(output.typingWpm).toBeLessThanOrEqual(140);
        expect(output.accuracy).toBeGreaterThanOrEqual(0.7);
        expect(output.accuracy).toBeLessThanOrEqual(0.98);
        expect(output.reactionDelayMs).toBeGreaterThanOrEqual(250);
        expect(output.reactionDelayMs).toBeLessThanOrEqual(2000);
      }
    }
  });

  it('preserves non-strict difficulty monotonicity over the full normalized range', () => {
    const values = [20, 45, 80, 140];
    const accuracies = [0.7, 0.8, 0.92, 0.98];
    const reactions = [250, 650, 1200, 2000];

    for (const wpm of values) {
      for (const accuracy of accuracies) {
        for (const reactionTimeMs of reactions) {
          const skill = {
            wpm,
            accuracy,
            reactionTimeMs,
            sampleCount: 1,
            confidence: 0.2,
          };
          const beginner = toAiExecutionProfile(skill, 'BEGINNER');
          const normal = toAiExecutionProfile(skill, 'NORMAL');
          const hard = toAiExecutionProfile(skill, 'HARD');

          expect(beginner.typingWpm).toBeLessThanOrEqual(normal.typingWpm);
          expect(normal.typingWpm).toBeLessThanOrEqual(hard.typingWpm);
          expect(beginner.accuracy).toBeLessThanOrEqual(normal.accuracy);
          expect(normal.accuracy).toBeLessThanOrEqual(hard.accuracy);
          expect(beginner.reactionDelayMs).toBeGreaterThanOrEqual(
            normal.reactionDelayMs,
          );
          expect(normal.reactionDelayMs).toBeGreaterThanOrEqual(
            hard.reactionDelayMs,
          );
        }
      }
    }
  });

  it('has strict ordering for a representative middle profile', () => {
    const skill = { wpm: 80, accuracy: 0.85, reactionTimeMs: 1000 };
    const beginner = toAiExecutionProfile(
      { ...skill, sampleCount: 4, confidence: 0.5 },
      'BEGINNER',
    );
    const normal = toAiExecutionProfile(
      { ...skill, sampleCount: 4, confidence: 0.5 },
      'NORMAL',
    );
    const hard = toAiExecutionProfile(
      { ...skill, sampleCount: 4, confidence: 0.5 },
      'HARD',
    );

    expect(beginner.typingWpm).toBeLessThan(normal.typingWpm);
    expect(normal.typingWpm).toBeLessThan(hard.typingWpm);
    expect(beginner.accuracy).toBeLessThan(normal.accuracy);
    expect(normal.accuracy).toBeLessThan(hard.accuracy);
    expect(beginner.reactionDelayMs).toBeGreaterThan(normal.reactionDelayMs);
    expect(normal.reactionDelayMs).toBeGreaterThan(hard.reactionDelayMs);
  });

  it('sanitizes malformed skill input for NORMAL difficulty', () => {
    expect(
      toAiExecutionProfile(
        {
          wpm: Number.NaN,
          accuracy: Number.POSITIVE_INFINITY,
          reactionTimeMs: -500,
          sampleCount: -2,
          confidence: Number.NaN,
        },
        'NORMAL',
      ),
    ).toEqual({ typingWpm: 140, accuracy: 0.98, reactionDelayMs: 250 });
  });

  it('keeps hard output imperfect and bounded', () => {
    const hard = toAiExecutionProfile(
      {
        wpm: 140,
        accuracy: 0.98,
        reactionTimeMs: 250,
        sampleCount: 1,
        confidence: 1,
      },
      'HARD',
    );

    expect(hard.accuracy).toBe(0.98);
    expect(hard.typingWpm).toBeLessThanOrEqual(140);
    expect(hard.reactionDelayMs).toBeGreaterThanOrEqual(250);
  });

  it('does not allow runtime mutation of the default profile', () => {
    expect(Object.isFrozen(DEFAULT_PLAYER_SKILL)).toBe(true);
    expect(() => {
      (DEFAULT_PLAYER_SKILL as PlayerSkillProfile).wpm = 999;
    }).toThrow(TypeError);
    expect(DEFAULT_PLAYER_SKILL.wpm).toBe(146.5776347325265);
  });

  it('is deterministic for identical input', () => {
    const samples = [SAMPLE, { wpm: 55, accuracy: 0.9, reactionTimeMs: 700 }];
    const first = toAiExecutionProfile(
      buildPlayerSkillProfile(samples),
      'HARD',
    );
    const second = toAiExecutionProfile(
      buildPlayerSkillProfile(samples),
      'HARD',
    );

    expect(second).toEqual(first);
  });
});
