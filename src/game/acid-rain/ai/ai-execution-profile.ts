import { DEFAULT_PLAYER_SKILL, toAiExecutionProfile } from '../../player-model';
import type { AiDifficulty } from '../acid-rain.interface';
import type {
  AiExecutionProfile,
  PlayerSkillProfile,
} from '../../player-model';
import type { AiTypingProfile } from './state-evaluator';

export interface AiExecutionConfig {
  minimumAsyncDelayMs: number;
  correctionDelayMs: number;
  abandonProbability: number;
  jitterMs: number;
  typoFloor: number;
  typoCeiling: number;
}

export interface AiProfileProvider {
  getSkillProfile(context: {
    roomId: string;
    aiParticipantId: string;
  }): PlayerSkillProfile;
  loadSkillProfile?(context: {
    roomId: string;
    aiParticipantId: string;
    modelPlayerId: string;
    difficulty: AiDifficulty;
  }): Promise<PlayerSkillProfile>;
}

export interface AiExecutionProfileFactory {
  create(
    skill: PlayerSkillProfile,
    difficulty: AiDifficulty,
  ): AiExecutionProfile;
}

export const DIFFICULTY_EXECUTION_CONFIG: Readonly<
  Record<AiDifficulty, AiExecutionConfig>
> = Object.freeze({
  BEGINNER: {
    minimumAsyncDelayMs: 1,
    correctionDelayMs: 220,
    abandonProbability: 0.12,
    jitterMs: 120,
    typoFloor: 0.02,
    typoCeiling: 0.25,
  },
  NORMAL: {
    minimumAsyncDelayMs: 1,
    correctionDelayMs: 150,
    abandonProbability: 0.06,
    jitterMs: 80,
    typoFloor: 0.01,
    typoCeiling: 0.18,
  },
  HARD: {
    minimumAsyncDelayMs: 1,
    correctionDelayMs: 90,
    abandonProbability: 0.02,
    jitterMs: 40,
    typoFloor: 0.005,
    typoCeiling: 0.12,
  },
});

export class DefaultAiProfileProvider implements AiProfileProvider {
  getSkillProfile(): PlayerSkillProfile {
    return { ...DEFAULT_PLAYER_SKILL };
  }
}

export class DefaultAiExecutionProfileFactory implements AiExecutionProfileFactory {
  create(
    skill: PlayerSkillProfile,
    difficulty: AiDifficulty,
  ): AiExecutionProfile {
    return toAiExecutionProfile(skill, difficulty);
  }
}

export interface AiEvaluatorProfile extends AiTypingProfile {
  execution: AiExecutionProfile;
  config: AiExecutionConfig;
}

export function createEvaluatorProfile(
  execution: AiExecutionProfile,
  difficulty: AiDifficulty,
): AiEvaluatorProfile {
  const config = DIFFICULTY_EXECUTION_CONFIG[difficulty];
  const perKeystrokeMs = 60000 / (execution.typingWpm * 5);
  if (!Number.isFinite(perKeystrokeMs) || perKeystrokeMs <= 0) {
    throw new RangeError('typing profile produced an invalid keystroke delay');
  }
  return {
    reactionMs: execution.reactionDelayMs,
    perKeystrokeMs,
    uncertaintyMs: config.jitterMs,
    urgencyWindowMs: 3000,
    damageWeight: 1,
    urgencyWeight: 1,
    opportunityCostWeight: 0.25,
    switchMargin: 0.1,
    execution,
    config,
  };
}

export function typoProbability(
  accuracy: number,
  config: AiExecutionConfig,
): number {
  if (!Number.isFinite(accuracy))
    throw new RangeError('accuracy must be finite');
  const normalized = Math.min(1, Math.max(0, accuracy));
  return Math.min(
    config.typoCeiling,
    Math.max(config.typoFloor, 1 - normalized),
  );
}
