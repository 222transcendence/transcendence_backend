import { DEFAULT_PLAYER_SKILL, toAiExecutionProfile } from '../../player-model';
import {
  DefaultAiExecutionProfileFactory,
  DIFFICULTY_EXECUTION_CONFIG,
  createEvaluatorProfile,
  typoProbability,
} from './ai-execution-profile';

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
});
