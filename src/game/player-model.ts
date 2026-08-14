import type { AiDifficulty } from './acid-rain/acid-rain.interface';
import { GENERATED_POPULATION_DEFAULT } from './population-default.generated';

export interface PlayerPerformanceSample {
  wpm: number;
  accuracy: number;
  reactionTimeMs: number;
}

export interface PlayerSkillProfile {
  wpm: number;
  accuracy: number;
  reactionTimeMs: number;
  sampleCount: number;
  confidence: number;
}

export interface AiExecutionProfile {
  typingWpm: number;
  accuracy: number;
  reactionDelayMs: number;
  typoProbability?: number;
  correctionDelayMs?: number;
  abandonProbability?: number;
}

const RAW_WPM_RANGE = { min: 20, max: 140 } as const;
const RAW_ACCURACY_RANGE = { min: 0, max: 1 } as const;
const RAW_REACTION_RANGE = { min: 250, max: 2000 } as const;
const SKILL_ACCURACY_RANGE = { min: 0.7, max: 0.98 } as const;
const PRIOR_SAMPLE_COUNT = 4;
const MAX_DECIMAL_PLACES = 4;

export const LEGACY_DEFAULT_PLAYER_SKILL: Readonly<PlayerSkillProfile> =
  Object.freeze({
    wpm: 45,
    accuracy: 0.92,
    reactionTimeMs: 650,
    sampleCount: 0,
    confidence: 0,
  });

export const DEFAULT_PLAYER_SKILL: Readonly<PlayerSkillProfile> = Object.freeze(
  GENERATED_POPULATION_DEFAULT,
);

interface SanitizedSample {
  wpm: number;
  accuracy: number;
  reactionTimeMs: number;
}

interface MetricRange {
  min: number;
  max: number;
}

const DIFFICULTY_MODIFIERS: Record<
  AiDifficulty,
  { speed: number; accuracy: number; reaction: number }
> = {
  BEGINNER: { speed: 0.85, accuracy: -0.08, reaction: 1.15 },
  NORMAL: { speed: 1, accuracy: 0, reaction: 1 },
  HARD: { speed: 1.15, accuracy: 0.08, reaction: 0.85 },
};

function clamp(value: number, range: MetricRange): number {
  return Math.min(range.max, Math.max(range.min, value));
}

function round(value: number): number {
  const factor = 10 ** MAX_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}

function roundInteger(value: number): number {
  return Math.round(value);
}

function sanitizeSample(
  sample: PlayerPerformanceSample,
): SanitizedSample | null {
  if (
    !Number.isFinite(sample.wpm) ||
    !Number.isFinite(sample.accuracy) ||
    !Number.isFinite(sample.reactionTimeMs)
  ) {
    return null;
  }

  return {
    wpm: clamp(sample.wpm, RAW_WPM_RANGE),
    accuracy: clamp(sample.accuracy, RAW_ACCURACY_RANGE),
    reactionTimeMs: clamp(sample.reactionTimeMs, RAW_REACTION_RANGE),
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function blend(
  defaultValue: number,
  observedValue: number,
  confidence: number,
): number {
  return defaultValue * (1 - confidence) + observedValue * confidence;
}

function normalizeSkill(skill: PlayerSkillProfile): PlayerSkillProfile {
  const wpm = Number.isFinite(skill.wpm)
    ? clamp(skill.wpm, RAW_WPM_RANGE)
    : DEFAULT_PLAYER_SKILL.wpm;
  const accuracy = Number.isFinite(skill.accuracy)
    ? clamp(skill.accuracy, SKILL_ACCURACY_RANGE)
    : DEFAULT_PLAYER_SKILL.accuracy;
  const reactionTimeMs = Number.isFinite(skill.reactionTimeMs)
    ? clamp(skill.reactionTimeMs, RAW_REACTION_RANGE)
    : DEFAULT_PLAYER_SKILL.reactionTimeMs;
  const sampleCount = Number.isFinite(skill.sampleCount)
    ? Math.max(0, Math.floor(skill.sampleCount))
    : DEFAULT_PLAYER_SKILL.sampleCount;
  const confidence = Number.isFinite(skill.confidence)
    ? clamp(skill.confidence, { min: 0, max: 1 })
    : DEFAULT_PLAYER_SKILL.confidence;

  return {
    wpm: roundInteger(wpm),
    accuracy: round(accuracy),
    reactionTimeMs: roundInteger(reactionTimeMs),
    sampleCount,
    confidence: round(confidence),
  };
}

export function buildPlayerSkillProfile(
  samples: readonly PlayerPerformanceSample[],
): PlayerSkillProfile {
  const validSamples = samples
    .map(sanitizeSample)
    .filter((sample): sample is SanitizedSample => sample !== null);

  if (validSamples.length === 0) {
    return { ...DEFAULT_PLAYER_SKILL };
  }

  const confidence =
    validSamples.length / (validSamples.length + PRIOR_SAMPLE_COUNT);
  const observedMean = {
    wpm: mean(validSamples.map((sample) => sample.wpm)),
    accuracy: mean(validSamples.map((sample) => sample.accuracy)),
    reactionTimeMs: mean(validSamples.map((sample) => sample.reactionTimeMs)),
  };

  return {
    wpm: roundInteger(
      clamp(
        blend(DEFAULT_PLAYER_SKILL.wpm, observedMean.wpm, confidence),
        RAW_WPM_RANGE,
      ),
    ),
    accuracy: round(
      clamp(
        blend(DEFAULT_PLAYER_SKILL.accuracy, observedMean.accuracy, confidence),
        SKILL_ACCURACY_RANGE,
      ),
    ),
    reactionTimeMs: roundInteger(
      clamp(
        blend(
          DEFAULT_PLAYER_SKILL.reactionTimeMs,
          observedMean.reactionTimeMs,
          confidence,
        ),
        RAW_REACTION_RANGE,
      ),
    ),
    sampleCount: validSamples.length,
    confidence: round(confidence),
  };
}

export function toAiExecutionProfile(
  skill: PlayerSkillProfile,
  difficulty: AiDifficulty,
): AiExecutionProfile {
  const normalizedSkill = normalizeSkill(skill);
  const modifier = DIFFICULTY_MODIFIERS[difficulty];

  return {
    typingWpm: roundInteger(
      clamp(normalizedSkill.wpm * modifier.speed, RAW_WPM_RANGE),
    ),
    accuracy: round(
      clamp(normalizedSkill.accuracy + modifier.accuracy, SKILL_ACCURACY_RANGE),
    ),
    reactionDelayMs: roundInteger(
      clamp(
        normalizedSkill.reactionTimeMs * modifier.reaction,
        RAW_REACTION_RANGE,
      ),
    ),
  };
}
