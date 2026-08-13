import type { PlayerPerformanceSample } from './player-model';
import {
  POPULATION_DEFAULT_CONFIG,
  POPULATION_DEFAULT_FALLBACK,
  type PopulationDefaultConfig,
} from './population-default.config';

export interface PopulationDefaultInput extends PlayerPerformanceSample {
  matchId: string;
  playerId: string;
  participantType: 'HUMAN' | 'AI';
  mode: 'PVP' | 'AI_PRACTICE';
  resultStatus: 'FINISHED' | 'ABORTED' | 'VOID';
  consented: boolean;
  createdAt: string;
}

export type PopulationDefaultExclusion =
  | 'NOT_HUMAN'
  | 'UNSUPPORTED_MODE'
  | 'NOT_FINISHED'
  | 'NO_EXPLICIT_CONSENT'
  | 'INVALID_METRIC'
  | 'OUT_OF_RANGE'
  | 'DUPLICATE_MATCH_PARTICIPANT'
  | 'PLAYER_MATCH_CAP'
  | 'INSUFFICIENT_MATCHES_PER_PLAYER';

export type PopulationDefaultGateFailure =
  | 'INSUFFICIENT_PLAYERS'
  | 'INSUFFICIENT_MATCHES_PER_PLAYER'
  | 'NO_ALLOWLIST';

export interface PopulationDefaultEstimate {
  configVersion: string;
  eligibleForRuntime: boolean;
  exclusionReasons: PopulationDefaultExclusion[];
  exclusionCounts: Partial<Record<PopulationDefaultExclusion, number>>;
  gateFailureReasons: PopulationDefaultGateFailure[];
  queriedPlayers: number;
  validPlayers: number;
  distinctPlayers: number;
  validMatches: number;
  usedMatches: number;
  playersBelowMinimum: number;
  perPlayerMatchCounts: Record<string, number>;
  profile: PlayerPerformanceSample | null;
}

export interface PopulationDefaultReportContext {
  generatedAt: string;
  allowlistCount: number;
  queriedMatches: number;
}

const isFiniteSample = (sample: PopulationDefaultInput): boolean =>
  Number.isFinite(sample.wpm) &&
  Number.isFinite(sample.accuracy) &&
  Number.isFinite(sample.reactionTimeMs);

const isInRange = (
  sample: PopulationDefaultInput,
  config: PopulationDefaultConfig,
): boolean =>
  sample.wpm >= config.datasetMetricRanges.wpm.min &&
  sample.wpm <= config.datasetMetricRanges.wpm.max &&
  sample.accuracy >= config.datasetMetricRanges.accuracy.min &&
  sample.accuracy <= config.datasetMetricRanges.accuracy.max &&
  sample.reactionTimeMs >= config.datasetMetricRanges.reactionTimeMs.min &&
  sample.reactionTimeMs <= config.datasetMetricRanges.reactionTimeMs.max;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const medianSample = (
  samples: PopulationDefaultInput[],
): PlayerPerformanceSample => ({
  wpm: median(samples.map((sample) => sample.wpm)),
  accuracy: median(samples.map((sample) => sample.accuracy)),
  reactionTimeMs: median(samples.map((sample) => sample.reactionTimeMs)),
});

export function estimatePopulationDefault(
  input: PopulationDefaultInput[],
  config: PopulationDefaultConfig = POPULATION_DEFAULT_CONFIG,
): PopulationDefaultEstimate {
  const exclusionCounts: Partial<Record<PopulationDefaultExclusion, number>> =
    {};
  const exclude = (reason: PopulationDefaultExclusion): void => {
    exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1;
  };
  const seen = new Set<string>();
  const valid = [...input]
    .sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.matchId.localeCompare(left.matchId) ||
        right.playerId.localeCompare(left.playerId) ||
        right.wpm - left.wpm ||
        right.accuracy - left.accuracy ||
        right.reactionTimeMs - left.reactionTimeMs,
    )
    .filter((sample) => {
      if (sample.participantType !== 'HUMAN') exclude('NOT_HUMAN');
      else if (sample.mode !== 'PVP' && sample.mode !== 'AI_PRACTICE') {
        exclude('UNSUPPORTED_MODE');
      } else if (sample.resultStatus !== 'FINISHED') exclude('NOT_FINISHED');
      else if (config.requireExplicitConsent && !sample.consented) {
        exclude('NO_EXPLICIT_CONSENT');
      } else if (!isFiniteSample(sample)) exclude('INVALID_METRIC');
      else if (!isInRange(sample, config)) exclude('OUT_OF_RANGE');
      else if (seen.has(`${sample.matchId}:${sample.playerId}`)) {
        exclude('DUPLICATE_MATCH_PARTICIPANT');
      } else {
        seen.add(`${sample.matchId}:${sample.playerId}`);
        return true;
      }
      return false;
    });

  const byPlayer = new Map<string, PopulationDefaultInput[]>();
  for (const sample of valid) {
    const samples = byPlayer.get(sample.playerId) ?? [];
    if (samples.length < config.maximumMatchesPerPlayer) samples.push(sample);
    else exclude('PLAYER_MATCH_CAP');
    byPlayer.set(sample.playerId, samples);
  }

  const playerSamples = [...byPlayer.values()].filter(
    (samples) => samples.length >= config.minimumMatchesPerPlayer,
  );
  const profile =
    playerSamples.length > 0
      ? {
          wpm: median(
            playerSamples.map((samples) => medianSample(samples).wpm),
          ),
          accuracy: median(
            playerSamples.map((samples) => medianSample(samples).accuracy),
          ),
          reactionTimeMs: median(
            playerSamples.map(
              (samples) => medianSample(samples).reactionTimeMs,
            ),
          ),
        }
      : null;
  const playersBelowMinimum = [...byPlayer.values()].filter(
    (samples) => samples.length < config.minimumMatchesPerPlayer,
  ).length;
  for (let index = 0; index < playersBelowMinimum; index += 1) {
    exclude('INSUFFICIENT_MATCHES_PER_PLAYER');
  }
  const gateFailureReasons: PopulationDefaultGateFailure[] = [];
  if (playerSamples.length < config.minimumDistinctPlayers) {
    gateFailureReasons.push('INSUFFICIENT_PLAYERS');
  }
  if (playersBelowMinimum > 0) {
    gateFailureReasons.push('INSUFFICIENT_MATCHES_PER_PLAYER');
  }
  const sortedExclusionCounts = Object.fromEntries(
    Object.entries(exclusionCounts).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as Partial<Record<PopulationDefaultExclusion, number>>;

  return {
    configVersion: config.version,
    eligibleForRuntime: gateFailureReasons.length === 0 && profile !== null,
    exclusionReasons: Object.keys(
      sortedExclusionCounts,
    ) as PopulationDefaultExclusion[],
    exclusionCounts: sortedExclusionCounts,
    gateFailureReasons,
    queriedPlayers: new Set(input.map((sample) => sample.playerId)).size,
    validPlayers: byPlayer.size,
    distinctPlayers: playerSamples.length,
    validMatches: [...byPlayer.values()].reduce(
      (total, samples) => total + samples.length,
      0,
    ),
    usedMatches: playerSamples.reduce(
      (total, samples) => total + samples.length,
      0,
    ),
    playersBelowMinimum,
    perPlayerMatchCounts: Object.fromEntries(
      [...byPlayer.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([playerId, samples]) => [playerId, samples.length]),
    ),
    profile,
  };
}

export function serializePopulationDefaultReport(
  estimate: PopulationDefaultEstimate,
  context: PopulationDefaultReportContext = {
    generatedAt: new Date().toISOString(),
    allowlistCount: 0,
    queriedMatches: 0,
  },
): string {
  const playerContributions = Object.entries(estimate.perPlayerMatchCounts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([playerId, matchCount], index) => ({
      contributionUnit: `player-${String(index + 1).padStart(3, '0')}`,
      matchCount,
      playerId,
    }));
  const candidate = estimate.eligibleForRuntime ? estimate.profile : null;
  const report = {
    policyVersion: estimate.configVersion,
    generatedAt: context.generatedAt,
    gatePassed: estimate.eligibleForRuntime,
    gateFailureReasons: estimate.gateFailureReasons,
    allowlistCount: context.allowlistCount,
    queriedPlayers: estimate.queriedPlayers,
    validPlayers: estimate.validPlayers,
    queriedMatches: context.queriedMatches,
    validMatches: estimate.validMatches,
    usedMatches: estimate.usedMatches,
    playersBelowMinimum: estimate.playersBelowMinimum,
    exclusionCounts: estimate.exclusionCounts,
    playerContributions: playerContributions.map(
      ({ contributionUnit, matchCount }) => ({ contributionUnit, matchCount }),
    ),
    hardcodedDefault: POPULATION_DEFAULT_FALLBACK,
    populationCandidate: candidate,
    differenceFromHardcodedDefault: candidate
      ? {
          wpm: candidate.wpm - POPULATION_DEFAULT_FALLBACK.wpm,
          accuracy: candidate.accuracy - POPULATION_DEFAULT_FALLBACK.accuracy,
          reactionTimeMs:
            candidate.reactionTimeMs -
            POPULATION_DEFAULT_FALLBACK.reactionTimeMs,
        }
      : null,
  };
  return JSON.stringify(report, null, 2);
}
