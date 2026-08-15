import { DEFAULT_PLAYER_SKILL, toAiExecutionProfile } from '../../player-model';
import {
  DefaultAiExecutionProfileFactory,
  DIFFICULTY_EXECUTION_CONFIG,
  createEvaluatorProfile,
  typoProbability,
} from './ai-execution-profile';
import { AiExecutor } from './ai-executor';

describe('AI execution profile adapter', () => {
  it('uses the existing player model for every difficulty', () => {
    const factory = new DefaultAiExecutionProfileFactory();
    for (const difficulty of ['BEGINNER', 'NORMAL', 'HARD'] as const) {
      expect(factory.create(DEFAULT_PLAYER_SKILL, difficulty)).toEqual(
        toAiExecutionProfile(DEFAULT_PLAYER_SKILL, difficulty),
      );
    }
  });

  it('keeps typo probability inside each difficulty configuration', () => {
    for (const difficulty of ['BEGINNER', 'NORMAL', 'HARD'] as const) {
      const config = DIFFICULTY_EXECUTION_CONFIG[difficulty];
      expect(typoProbability(0, config)).toBe(config.typoCeiling);
      expect(typoProbability(1, config)).toBe(config.typoFloor);
    }
  });

  it('produces finite evaluator timing values', () => {
    const profile = createEvaluatorProfile(
      toAiExecutionProfile(DEFAULT_PLAYER_SKILL, 'NORMAL'),
      'NORMAL',
    );
    expect(profile.perKeystrokeMs).toBeGreaterThan(0);
    expect(profile.reactionMs).toBeGreaterThan(0);
  });

  it('propagates WPM, accuracy, and reaction changes into executor timing', () => {
    const low = createEvaluatorProfile(
      { typingWpm: 60, accuracy: 0.8, reactionDelayMs: 500 },
      'NORMAL',
    );
    const high = createEvaluatorProfile(
      { typingWpm: 120, accuracy: 0.95, reactionDelayMs: 300 },
      'NORMAL',
    );
    const executor = new AiExecutor({ now: () => 0 }, { next: () => 0.5 });
    const word = {
      wordId: 'profile-word',
      text: 'abc',
      keystrokes: 3,
      landAtMs: 10_000,
      damage: 1,
    };

    const lowTask = executor.createTask('low-room', word, low, 1, 'low');
    const highTask = executor.createTask('high-room', word, high, 1, 'high');

    expect(high.perKeystrokeMs).toBeLessThan(low.perKeystrokeMs);
    expect(typoProbability(low.execution.accuracy, low.config)).toBeGreaterThan(
      typoProbability(high.execution.accuracy, high.config),
    );
    expect(highTask.reactionEndsAtMs).toBeLessThan(lowTask.reactionEndsAtMs);
  });

  it('passes observed behavior metrics into the evaluator after difficulty', () => {
    const factory = new DefaultAiExecutionProfileFactory();
    const execution = factory.create(DEFAULT_PLAYER_SKILL, 'NORMAL', {
      ...DEFAULT_PLAYER_SKILL,
      source: 'PERSONALIZED',
      profileVersion: 'player-personalization-v1',
      populationDefaultVersion: null,
      fallbackReason: 'NONE',
      typoProbability: {
        value: 0.1,
        sampleCount: 10,
        confidence: 0.7,
        available: true,
      },
      correctionDelayMs: {
        value: 180,
        sampleCount: 10,
        confidence: 0.7,
        available: true,
      },
      abandonProbability: {
        value: 0.2,
        sampleCount: 10,
        confidence: 0.7,
        available: true,
      },
      wordLengthPerformance: {
        short: {
          value: 0.9,
          sampleCount: 10,
          confidence: 0.7,
          available: true,
        },
        medium: {
          value: null,
          sampleCount: 0,
          confidence: 0,
          available: false,
        },
        long: { value: null, sampleCount: 0, confidence: 0, available: false },
      },
    });
    const evaluator = createEvaluatorProfile(execution, 'NORMAL');

    expect(evaluator.execution.typoProbability).toBe(0.1);
    expect(evaluator.config.correctionDelayMs).toBe(180);
    expect(evaluator.config.abandonProbability).toBe(0.2);
  });
});
