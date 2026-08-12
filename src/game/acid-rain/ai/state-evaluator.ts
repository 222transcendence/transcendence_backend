export interface ActiveWordCandidate {
  wordId: string;
  keystrokes: number;
  landAtMs: number;
  /** Damage is authoritative server data and is never recalculated here. */
  damage: number;
}

export interface WordReservation {
  owner: 'SELF' | 'OTHER';
}

export type CurrentTarget = {
  wordId: string;
  execution:
    | { state: 'NOT_STARTED' }
    | { state: 'IN_PROGRESS'; remainingKeystrokes: number };
};

export interface AiTypingProfile {
  reactionMs: number;
  perKeystrokeMs: number;
  uncertaintyMs: number;
  urgencyWindowMs: number;
  damageWeight: number;
  urgencyWeight: number;
  opportunityCostWeight: number;
  switchMargin: number;
}

export interface UtilityEvaluationInput {
  nowMs: number;
  activeWords: readonly ActiveWordCandidate[];
  reservations: ReadonlyMap<string, WordReservation>;
  currentTarget?: CurrentTarget;
  profile: AiTypingProfile;
}

export type UtilityAction =
  | 'KEEP'
  | 'SWITCH'
  | 'ABANDON'
  | 'SELECT'
  | 'NO_TARGET';

export interface RankedCandidate {
  wordId: string;
  successProbability: number;
  urgency: number;
  completionMs: number;
  opportunityCost: number;
  utility: number;
}

export interface UtilityDecision {
  action: UtilityAction;
  targetWordId?: string;
  rankedCandidates: readonly RankedCandidate[];
  reason: string;
}

interface EvaluatedCandidate extends RankedCandidate {
  word: ActiveWordCandidate;
  baseExpectedValue: number;
}

const EPSILON = 1e-9;

export function evaluateUtility(
  input: UtilityEvaluationInput,
): UtilityDecision {
  validateInput(input);

  const words = new Map(input.activeWords.map((word) => [word.wordId, word]));
  const currentWord = input.currentTarget
    ? words.get(input.currentTarget.wordId)
    : undefined;
  const currentIsInProgress =
    currentWord !== undefined &&
    input.currentTarget?.execution.state === 'IN_PROGRESS';

  if (currentWord && currentIsInProgress) {
    const remaining = input.currentTarget!.execution;
    if (
      remaining.state === 'IN_PROGRESS' &&
      remaining.remainingKeystrokes > currentWord.keystrokes
    ) {
      throw new RangeError(
        'currentTarget.remainingKeystrokes exceeds word keystrokes',
      );
    }
  }

  const candidates = input.activeWords
    .filter((word) => input.reservations.get(word.wordId)?.owner !== 'OTHER')
    .map((word) => evaluateCandidate(word, input, currentIsInProgress));
  const feasible = candidates.filter(
    (candidate): candidate is EvaluatedCandidate => candidate !== undefined,
  );

  for (const candidate of feasible) {
    candidate.opportunityCost = opportunityCost(candidate, feasible, input);
    candidate.utility =
      candidate.baseExpectedValue -
      input.profile.opportunityCostWeight * candidate.opportunityCost;
  }
  feasible.sort(compareCandidates);

  const rankedCandidates = feasible.map(toRankedCandidate);
  const currentId = input.currentTarget?.wordId;
  const currentCandidate = currentId
    ? feasible.find((candidate) => candidate.wordId === currentId)
    : undefined;
  const best = feasible[0];

  if (currentCandidate) {
    if (
      best &&
      best.wordId !== currentCandidate.wordId &&
      best.utility > currentCandidate.utility + input.profile.switchMargin
    ) {
      return decision('SWITCH', best.wordId, rankedCandidates, 'better_target');
    }
    return decision(
      'KEEP',
      currentCandidate.wordId,
      rankedCandidates,
      'keep_target',
    );
  }

  if (best) {
    return decision(
      currentId ? 'SWITCH' : 'SELECT',
      best.wordId,
      rankedCandidates,
      currentId ? 'current_target_invalid' : 'select_best_target',
    );
  }

  return decision(
    currentId ? 'ABANDON' : 'NO_TARGET',
    undefined,
    rankedCandidates,
    currentId ? 'current_target_invalid' : 'no_feasible_target',
  );
}

function evaluateCandidate(
  word: ActiveWordCandidate,
  input: UtilityEvaluationInput,
  currentIsInProgress: boolean,
): EvaluatedCandidate | undefined {
  const isCurrent = input.currentTarget?.wordId === word.wordId;
  const completionMs =
    isCurrent && currentIsInProgress
      ? input.currentTarget!.execution.state === 'IN_PROGRESS'
        ? input.currentTarget!.execution.remainingKeystrokes *
          input.profile.perKeystrokeMs
        : 0
      : input.profile.reactionMs +
        word.keystrokes * input.profile.perKeystrokeMs;
  const remainingMs = word.landAtMs - input.nowMs;
  const slackMs = remainingMs - completionMs;

  if (slackMs <= 0) return undefined;

  const successProbability = clamp(
    slackMs / (slackMs + input.profile.uncertaintyMs),
    0,
    1,
  );
  const urgency = clamp(1 - remainingMs / input.profile.urgencyWindowMs, 0, 1);
  const baseExpectedValue =
    successProbability *
    (input.profile.damageWeight * word.damage +
      input.profile.urgencyWeight * urgency);

  return {
    word,
    wordId: word.wordId,
    successProbability,
    urgency,
    completionMs,
    opportunityCost: 0,
    utility: baseExpectedValue,
    baseExpectedValue,
  };
}

function opportunityCost(
  selected: EvaluatedCandidate,
  feasible: readonly EvaluatedCandidate[],
  input: UtilityEvaluationInput,
): number {
  return feasible.reduce((total, alternative) => {
    if (alternative.wordId === selected.wordId) return total;

    const completionMsAfterSelected =
      input.profile.reactionMs +
      alternative.word.keystrokes * input.profile.perKeystrokeMs;
    const becomesUnreachable =
      input.nowMs + selected.completionMs + completionMsAfterSelected >=
      alternative.word.landAtMs;

    return becomesUnreachable ? total + alternative.baseExpectedValue : total;
  }, 0);
}

function compareCandidates(
  left: EvaluatedCandidate,
  right: EvaluatedCandidate,
): number {
  const utilityDifference = right.utility - left.utility;
  if (Math.abs(utilityDifference) > EPSILON) return utilityDifference;
  return left.wordId.localeCompare(right.wordId);
}

function toRankedCandidate(candidate: EvaluatedCandidate): RankedCandidate {
  const { word, baseExpectedValue, ...ranked } = candidate;
  void word;
  void baseExpectedValue;
  return ranked;
}

function decision(
  action: UtilityAction,
  targetWordId: string | undefined,
  rankedCandidates: readonly RankedCandidate[],
  reason: string,
): UtilityDecision {
  return targetWordId
    ? { action, targetWordId, rankedCandidates, reason }
    : { action, rankedCandidates, reason };
}

function validateInput(input: UtilityEvaluationInput): void {
  if (!Number.isFinite(input.nowMs)) {
    throw new RangeError('nowMs must be finite');
  }

  const profileEntries = Object.entries(input.profile) as Array<
    [keyof AiTypingProfile, number]
  >;
  for (const [name, value] of profileEntries) {
    if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  }
  for (const name of [
    'reactionMs',
    'uncertaintyMs',
    'urgencyWindowMs',
    'damageWeight',
    'urgencyWeight',
    'opportunityCostWeight',
    'switchMargin',
  ] as const) {
    if (input.profile[name] < 0) {
      throw new RangeError(`${name} must be non-negative`);
    }
  }
  if (input.profile.perKeystrokeMs <= 0) {
    throw new RangeError('perKeystrokeMs must be positive');
  }
  if (input.profile.urgencyWindowMs <= 0) {
    throw new RangeError('urgencyWindowMs must be positive');
  }
  if (input.profile.damageWeight + input.profile.urgencyWeight <= 0) {
    throw new RangeError('damageWeight or urgencyWeight must be positive');
  }

  const ids = new Set<string>();
  for (const word of input.activeWords) {
    if (!word.wordId || ids.has(word.wordId)) {
      throw new RangeError('active word IDs must be non-empty and unique');
    }
    ids.add(word.wordId);
    if (!Number.isInteger(word.keystrokes) || word.keystrokes < 1) {
      throw new RangeError('keystrokes must be a positive integer');
    }
    if (!Number.isFinite(word.landAtMs)) {
      throw new RangeError('landAtMs must be finite');
    }
    if (!Number.isFinite(word.damage) || word.damage < 0) {
      throw new RangeError('damage must be finite and non-negative');
    }
  }

  for (const [wordId, reservation] of input.reservations) {
    if (!ids.has(wordId)) continue;
    if (reservation.owner !== 'SELF' && reservation.owner !== 'OTHER') {
      throw new RangeError('reservation owner is invalid');
    }
  }

  const current = input.currentTarget;
  if (!current) return;
  if (!current.wordId) throw new RangeError('currentTarget.wordId is required');

  // A missing current target is a normal state-sync invalidation. Do not
  // validate execution progress until the word is present in activeWords.
  const currentWord = input.activeWords.find(
    (word) => word.wordId === current.wordId,
  );
  if (!currentWord || current.execution.state === 'NOT_STARTED') return;

  if (current.execution.state !== 'IN_PROGRESS') {
    throw new RangeError('currentTarget execution state is invalid');
  }
  if (
    !Number.isInteger(current.execution.remainingKeystrokes) ||
    current.execution.remainingKeystrokes < 0 ||
    current.execution.remainingKeystrokes > currentWord.keystrokes
  ) {
    throw new RangeError('remainingKeystrokes is invalid');
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
