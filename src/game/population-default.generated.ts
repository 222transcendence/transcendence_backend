import type { PlayerSkillProfile } from './player-model';

/**
 * Offline-generated developer baseline for #167.
 * Source: one explicitly allowlisted developer with 10 finished matches.
 */
export const GENERATED_POPULATION_DEFAULT_VERSION =
  'population-default-developer-baseline-v1';

export const GENERATED_POPULATION_DEFAULT: Readonly<PlayerSkillProfile> =
  Object.freeze({
    wpm: 146.5776347325265,
    accuracy: 1,
    reactionTimeMs: 1254.2386363636365,
    sampleCount: 0,
    confidence: 0,
  });
