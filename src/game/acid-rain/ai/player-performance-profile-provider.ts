import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildPlayerSkillProfile,
  DEFAULT_PLAYER_SKILL,
  type PlayerSkillProfile,
} from '../../player-model';
import {
  PLAYER_PERSONALIZATION_CONFIG,
  type MetricObservation,
  type PlayerProfileFallback,
  type PlayerRuntimeProfile,
} from '../../player-personalization.config';
import type { AiDifficulty } from '../acid-rain.interface';
import type { AiProfileProvider } from './ai-execution-profile';
import type {
  PlayerBehaviorData,
  PlayerBehaviorSource,
} from '../../player-behavior-source';
import { TypeOrmPlayerBehaviorSource } from '../../player-behavior-source';

@Injectable()
export class PlayerPerformanceProfileProvider implements AiProfileProvider {
  private readonly logger = new Logger(PlayerPerformanceProfileProvider.name);

  // 생성자 파라미터 타입이 교차 타입(TypeOrmPlayerBehaviorSource & Partial<...>)이면
  // TypeScript의 emitDecoratorMetadata가 design:paramtypes에 구체 클래스 대신 Object를
  // 내보내서 Nest가 자동으로 주입 토큰을 추론하지 못한다 — @Inject로 명시해야 한다.
  constructor(
    @Inject(TypeOrmPlayerBehaviorSource)
    private readonly source: TypeOrmPlayerBehaviorSource &
      Partial<PlayerBehaviorSource>,
  ) {}

  getSkillProfile(): PlayerSkillProfile {
    return { ...DEFAULT_PLAYER_SKILL };
  }

  async loadSkillProfile(context: {
    roomId: string;
    aiParticipantId: string;
    modelPlayerId: string;
    difficulty: AiDifficulty;
  }): Promise<PlayerSkillProfile> {
    const samples = await this.source.getRecentPerformance(
      context.modelPlayerId,
    );
    try {
      return buildPlayerSkillProfile(samples);
    } catch (err) {
      throw new Error(`AI profile model calculation failed: ${String(err)}`);
    }
  }

  async loadProfile(context: {
    roomId: string;
    aiParticipantId: string;
    modelPlayerId: string;
    difficulty: AiDifficulty;
  }): Promise<PlayerRuntimeProfile> {
    if (!context.modelPlayerId) return defaultRuntimeProfile('NO_USER');
    try {
      if (typeof this.source.getRecentBehavior !== 'function') {
        const skill = await this.loadSkillProfile(context);
        return runtimeProfileFromSkill(skill);
      }
      const data = await this.source.getRecentBehavior(
        context.modelPlayerId,
        PLAYER_PERSONALIZATION_CONFIG.personalSampleLimit,
      );
      return runtimeProfileFromBehavior(data);
    } catch (err) {
      // A database/calculation failure is a safe DEFAULT fallback, not insufficient data.
      this.logger.error(
        `AI profile source failed for room=${context.roomId}: ${String(err)}`,
      );
      return {
        ...defaultRuntimeProfile('PROFILE_SOURCE_ERROR'),
      };
    }
  }
}

function defaultObservation<T>(): MetricObservation<T> {
  return { value: null, sampleCount: 0, confidence: 0, available: false };
}

function defaultRuntimeProfile(
  fallbackReason: PlayerProfileFallback = 'NO_PERSONAL_SAMPLES',
): PlayerRuntimeProfile {
  return {
    ...DEFAULT_PLAYER_SKILL,
    source: 'DEFAULT',
    profileVersion: PLAYER_PERSONALIZATION_CONFIG.version,
    populationDefaultVersion:
      PLAYER_PERSONALIZATION_CONFIG.populationDefaultVersion,
    fallbackReason,
    typoProbability: defaultObservation<number>(),
    correctionDelayMs: defaultObservation<number>(),
    abandonProbability: defaultObservation<number>(),
    wordLengthPerformance: {
      short: defaultObservation<number>(),
      medium: defaultObservation<number>(),
      long: defaultObservation<number>(),
    },
  };
}

function runtimeProfileFromSkill(
  skill: PlayerSkillProfile,
): PlayerRuntimeProfile {
  return {
    ...skill,
    source: skill.sampleCount > 0 ? 'BLENDED' : 'DEFAULT',
    profileVersion: PLAYER_PERSONALIZATION_CONFIG.version,
    populationDefaultVersion:
      PLAYER_PERSONALIZATION_CONFIG.populationDefaultVersion,
    fallbackReason: skill.sampleCount > 0 ? 'NONE' : 'NO_PERSONAL_SAMPLES',
    typoProbability: defaultObservation<number>(),
    correctionDelayMs: defaultObservation<number>(),
    abandonProbability: defaultObservation<number>(),
    wordLengthPerformance: {
      short: defaultObservation<number>(),
      medium: defaultObservation<number>(),
      long: defaultObservation<number>(),
    },
  };
}

function runtimeProfileFromBehavior(
  data: PlayerBehaviorData,
): PlayerRuntimeProfile {
  const skill = buildPlayerSkillProfile(data.performanceSamples);
  const source =
    skill.sampleCount === 0
      ? 'DEFAULT'
      : skill.sampleCount >=
          PLAYER_PERSONALIZATION_CONFIG.personalizedSampleThreshold
        ? 'PERSONALIZED'
        : 'BLENDED';
  return {
    ...skill,
    source,
    profileVersion: PLAYER_PERSONALIZATION_CONFIG.version,
    populationDefaultVersion:
      PLAYER_PERSONALIZATION_CONFIG.populationDefaultVersion,
    fallbackReason: skill.sampleCount === 0 ? 'NO_PERSONAL_SAMPLES' : 'NONE',
    typoProbability: metricObservation(
      data.typoProbability,
      data.observationCounts.typo,
    ),
    correctionDelayMs: metricObservation(
      data.correctionDelayMs,
      data.observationCounts.correction,
    ),
    abandonProbability: metricObservation(
      data.abandonProbability,
      data.observationCounts.abandon,
    ),
    wordLengthPerformance: data.wordLengthPerformance,
  };
}

function metricObservation<T>(
  value: T | null,
  sampleCount: number,
): MetricObservation<T> {
  const count = Math.max(0, Math.floor(sampleCount));
  return {
    value,
    sampleCount: count,
    confidence:
      count === 0
        ? 0
        : count / (count + PLAYER_PERSONALIZATION_CONFIG.priorSampleCount),
    available: value !== null && count > 0,
  };
}
