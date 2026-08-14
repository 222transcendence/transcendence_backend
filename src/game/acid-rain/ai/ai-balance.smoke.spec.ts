import { DEFAULT_PLAYER_SKILL } from '../../player-model';
import {
  createEvaluatorProfile,
  DefaultAiExecutionProfileFactory,
} from './ai-execution-profile';
import { AiExecutor } from './ai-executor';
import type { Clock, RandomSource } from './ai-execution.types';

type Difficulty = 'BEGINNER' | 'NORMAL' | 'HARD';

const DIFFICULTIES: readonly Difficulty[] = ['BEGINNER', 'NORMAL', 'HARD'];
const SEEDS = [
  ...Array.from({ length: 24 }, (_, index) => index + 1),
  ...Array.from({ length: 24 }, (_, index) => index + 2023),
];
const WORD = {
  wordId: 'trace-word',
  text: 'abcdefgh',
  keystrokes: 8,
  landAtMs: 2000,
  damage: 9,
};

interface RunResult {
  latencyMs: number;
  success: boolean;
  typoRate: number;
  abandoned: boolean;
  aiWon: boolean;
  humanWon: boolean;
}

interface Aggregate {
  averageLatencyMs: number;
  successRate: number;
  typoRate: number;
  abandonRate: number;
  aiWinRate: number;
  humanWinRate: number;
}

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return {
    next: () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    },
  };
}

function runOnce(difficulty: Difficulty, seed: number): RunResult {
  let now = 0;
  const clock: Clock = { now: () => now };
  const random = seededRandom(seed);
  const executor = new AiExecutor(clock, random);
  const factory = new DefaultAiExecutionProfileFactory();
  const execution = factory.create(DEFAULT_PLAYER_SKILL, difficulty);
  const evaluator = createEvaluatorProfile(execution, difficulty);
  const abandoned = executor.shouldAbandon(evaluator);
  const task = executor.createTask(
    'balance-room',
    WORD,
    evaluator,
    1,
    `seed-${seed}`,
  );
  now = executor.completionMs(task);
  const typoCount = task.timeline.filter(
    (segment) => segment.kind === 'CORRECTION',
  ).length;
  const success = !abandoned && now <= WORD.landAtMs;
  const humanCompletionMs = 1800;

  return {
    latencyMs: now,
    success,
    typoRate: typoCount / WORD.keystrokes,
    abandoned,
    aiWon: success && now < humanCompletionMs,
    humanWon: !success || now >= humanCompletionMs,
  };
}

function aggregate(difficulty: Difficulty): Aggregate {
  const results = SEEDS.map((seed) => runOnce(difficulty, seed));
  const average = (select: (result: RunResult) => number) =>
    results.reduce((sum, result) => sum + select(result), 0) / results.length;

  return {
    averageLatencyMs: average((result) => result.latencyMs),
    successRate: average((result) => Number(result.success)),
    typoRate: average((result) => result.typoRate),
    abandonRate: average((result) => Number(result.abandoned)),
    aiWinRate: average((result) => Number(result.aiWon)),
    humanWinRate: average((result) => Number(result.humanWon)),
  };
}

describe('AI deterministic balance smoke', () => {
  it('keeps difficulty parameter monotonicity separate from match outcomes', () => {
    const profiles = DIFFICULTIES.map((difficulty) =>
      createEvaluatorProfile(
        new DefaultAiExecutionProfileFactory().create(
          DEFAULT_PLAYER_SKILL,
          difficulty,
        ),
        difficulty,
      ),
    );

    expect(profiles[0].execution.typingWpm).toBeLessThanOrEqual(
      profiles[1].execution.typingWpm,
    );
    expect(profiles[1].execution.typingWpm).toBeLessThanOrEqual(
      profiles[2].execution.typingWpm,
    );
    expect(profiles[0].reactionMs).toBeGreaterThanOrEqual(
      profiles[1].reactionMs,
    );
    expect(profiles[1].reactionMs).toBeGreaterThanOrEqual(
      profiles[2].reactionMs,
    );
    expect(profiles[0].config.abandonProbability).toBeGreaterThan(
      profiles[2].config.abandonProbability,
    );
    expect(profiles[0].config.typoCeiling).toBeGreaterThan(
      profiles[2].config.typoCeiling,
    );
  });

  it('replays the same difficulty, seed, and word trace exactly', () => {
    for (const difficulty of DIFFICULTIES) {
      expect(runOnce(difficulty, 17)).toEqual(runOnce(difficulty, 17));
    }
  });

  it('compares aggregate behavior across a fixed seed set', () => {
    const results = Object.fromEntries(
      DIFFICULTIES.map((difficulty) => [difficulty, aggregate(difficulty)]),
    ) as Record<Difficulty, Aggregate>;

    expect(results.HARD.averageLatencyMs).toBeLessThan(
      results.BEGINNER.averageLatencyMs,
    );
    expect(results.HARD.successRate).toBeGreaterThan(
      results.BEGINNER.successRate,
    );
    expect(results.HARD.typoRate).toBeLessThan(results.BEGINNER.typoRate);
    expect(results.HARD.abandonRate).toBeLessThan(results.BEGINNER.abandonRate);
    expect(results.HARD.aiWinRate).toBeGreaterThan(0);
    expect(results.BEGINNER.humanWinRate).toBeGreaterThan(0);
  });

  it('observes non-perfect and occasionally-winning behavior in the approved trace set', () => {
    const results = DIFFICULTIES.flatMap((difficulty) =>
      SEEDS.map((seed) => runOnce(difficulty, seed)),
    );

    expect(results.some((result) => result.typoRate > 0)).toBe(true);
    expect(results.some((result) => result.abandoned)).toBe(true);
    expect(results.some((result) => result.aiWon)).toBe(true);
    expect(results.some((result) => result.humanWon)).toBe(true);
  });
});
