export const PLAYER_PERSONALIZATION_CONFIG = Object.freeze({
  version: 'player-personalization-v1',
  populationDefaultVersion:
    'population-default-developer-baseline-v1' as string | null,
  personalSampleLimit: 20,
  priorSampleCount: 4,
  personalizedSampleThreshold: 10,
});

export type PlayerProfileSource = 'DEFAULT' | 'BLENDED' | 'PERSONALIZED';
export type PlayerProfileFallback =
  | 'NONE'
  | 'NO_USER'
  | 'NO_PERSONAL_SAMPLES'
  | 'PROFILE_SOURCE_ERROR';

export interface MetricObservation<T> {
  value: T | null;
  sampleCount: number;
  confidence: number;
  available: boolean;
}

export interface WordLengthPerformance {
  short: MetricObservation<number>;
  medium: MetricObservation<number>;
  long: MetricObservation<number>;
}

export interface PlayerRuntimeProfile {
  wpm: number;
  accuracy: number;
  reactionTimeMs: number;
  sampleCount: number;
  confidence: number;
  source: PlayerProfileSource;
  profileVersion: string;
  populationDefaultVersion: string | null;
  fallbackReason: PlayerProfileFallback;
  typoProbability: MetricObservation<number>;
  correctionDelayMs: MetricObservation<number>;
  abandonProbability: MetricObservation<number>;
  wordLengthPerformance: WordLengthPerformance;
}
