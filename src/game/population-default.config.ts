import { DEFAULT_PLAYER_SKILL } from './player-model';

/** Versioned, offline-generated population-default policy for #167. */
export const POPULATION_DEFAULT_CONFIG = {
  version: 'population-default-developer-baseline-v1',
  allowlistEnvironmentVariable: 'AI_POPULATION_DEFAULT_USER_ALLOWLIST',
  // This project intentionally uses the developer's profile as the common
  // evaluation baseline. It is not a statistically representative population
  // model; use a larger gate when publishing a general-purpose default.
  minimumDistinctPlayers: 1,
  minimumMatchesPerPlayer: 3,
  maximumMatchesPerPlayer: 10,
  requireExplicitConsent: true,
  /** Runtime normalization bounds; not a dataset exclusion policy. */
  runtimeMetricRanges: {
    wpm: { min: 20, max: 140 },
    accuracy: { min: 0, max: 1 },
    reactionTimeMs: { min: 250, max: 2000 },
  },
  /** Broad data-quality sanity bounds; intentionally wider than runtime clamps. */
  datasetMetricRanges: {
    wpm: { min: 0.1, max: 300 },
    accuracy: { min: 0, max: 1 },
    reactionTimeMs: { min: 1, max: 10000 },
  },
} as const;

export type PopulationDefaultConfig = typeof POPULATION_DEFAULT_CONFIG;

/** Keep the existing runtime default until a version passes the publication gate. */
export const POPULATION_DEFAULT_FALLBACK = DEFAULT_PLAYER_SKILL;
