import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  JudgeWordSubmitInput,
  OpponentTypingEventPayload,
  AiMonitorCandidate,
  AiMonitorExecutionProfile,
  AiMonitorSnapshot,
  AiMonitorSnapshotPatch,
} from '../acid-rain.interface';
import { evaluateUtility } from './state-evaluator';
import {
  DefaultAiExecutionProfileFactory,
  DefaultAiProfileProvider,
  typoProbability,
  type AiExecutionProfileFactory,
  type AiProfileProvider,
} from './ai-execution-profile';
import { AiExecutor } from './ai-executor';
import type {
  AiExecutionTask,
  AiRuntimeWord,
  AiSchedulerRegistration,
  AiStateChange,
  Clock,
  Timer,
} from './ai-execution.types';
import {
  AI_CLOCK,
  AI_TIMER,
  AI_PROFILE_PROVIDER,
  AI_PROFILE_FACTORY,
} from './ai-execution.types';
import {
  DEFAULT_PLAYER_SKILL,
  effectiveWordsPerMinute,
} from '../../player-model';
import type { PlayerSkillProfile } from '../../player-model';
import type { PlayerRuntimeProfile } from '../../player-personalization.config';
import { PLAYER_PERSONALIZATION_CONFIG } from '../../player-personalization.config';
import type { UtilityDecision } from './state-evaluator';

interface SchedulerState extends AiSchedulerRegistration {
  task?: AiExecutionTask;
  latestActiveWords: readonly AiRuntimeWord[];
  latestStatus: AiStateChange['status'];
  generation: number;
  lastStateVersion: number;
  evaluationInProgress: boolean;
  reevaluationRequested: boolean;
  pendingChange?: AiStateChange;
  cycleId: number;
  abandonedWordIds: Set<string>;
  paused: boolean;
  destroyed: boolean;
  profileSnapshot: PlayerSkillProfile;
  runtimeProfile: PlayerRuntimeProfile;
  profileLoadStarted: boolean;
  registrationToken: string;
  typingStateVersion: number;
  executionProfile?: AiMonitorExecutionProfile;
  lastDecision: UtilityDecision;
  monitorPhase: NonNullable<OpponentTypingEventPayload['phase']>;
  previousTargetWordId: string | null;
  monitorStateVersion: number;
  latestMonitorSnapshot?: AiMonitorSnapshot;
  terminalEmitted: boolean;
}

const MAX_MONITOR_CANDIDATES = 5;

const systemClock: Clock = { now: () => Date.now() };
const systemTimer: Timer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

function defaultRuntimeProfile(): PlayerRuntimeProfile {
  return {
    wpm: DEFAULT_PLAYER_SKILL.wpm,
    accuracy: DEFAULT_PLAYER_SKILL.accuracy,
    reactionTimeMs: DEFAULT_PLAYER_SKILL.reactionTimeMs,
    sampleCount: 0,
    confidence: 0,
    source: 'DEFAULT',
    profileVersion: PLAYER_PERSONALIZATION_CONFIG.version,
    populationDefaultVersion: null,
    fallbackReason: 'NO_PERSONAL_SAMPLES',
    typoProbability: {
      value: null,
      sampleCount: 0,
      confidence: 0,
      available: false,
    },
    correctionDelayMs: {
      value: null,
      sampleCount: 0,
      confidence: 0,
      available: false,
    },
    abandonProbability: {
      value: null,
      sampleCount: 0,
      confidence: 0,
      available: false,
    },
    wordLengthPerformance: {
      short: { value: null, sampleCount: 0, confidence: 0, available: false },
      medium: { value: null, sampleCount: 0, confidence: 0, available: false },
      long: { value: null, sampleCount: 0, confidence: 0, available: false },
    },
  };
}

@Injectable()
export class AiScheduler {
  private readonly logger = new Logger(AiScheduler.name);
  private readonly rooms = new Map<string, SchedulerState>();

  constructor(
    private readonly executor: AiExecutor,
    @Optional()
    @Inject(AI_PROFILE_PROVIDER)
    private readonly profileProvider: AiProfileProvider = new DefaultAiProfileProvider(),
    @Optional()
    @Inject(AI_PROFILE_FACTORY)
    private readonly profileFactory: AiExecutionProfileFactory = new DefaultAiExecutionProfileFactory(),
    @Optional()
    @Inject(AI_CLOCK)
    private readonly clock: Clock = systemClock,
    @Optional()
    @Inject(AI_TIMER)
    private readonly timer: Timer = systemTimer,
  ) {}

  registerRoom(registration: AiSchedulerRegistration): void {
    if (this.rooms.has(registration.roomId)) return;
    const state: SchedulerState = {
      ...registration,
      latestActiveWords: [],
      latestStatus: 'COUNTDOWN',
      generation: 0,
      lastStateVersion: -1,
      evaluationInProgress: false,
      reevaluationRequested: false,
      cycleId: 0,
      abandonedWordIds: new Set(),
      paused: false,
      destroyed: false,
      profileSnapshot: { ...DEFAULT_PLAYER_SKILL },
      runtimeProfile: defaultRuntimeProfile(),
      profileLoadStarted:
        typeof this.profileProvider.loadProfile === 'function' ||
        typeof this.profileProvider.loadSkillProfile === 'function',
      registrationToken: randomUUID(),
      typingStateVersion: 0,
      lastDecision: {
        action: 'NO_TARGET',
        rankedCandidates: [],
        reason: 'not_evaluated',
      },
      monitorPhase: 'IDLE',
      previousTargetWordId: null,
      monitorStateVersion: 0,
      terminalEmitted: false,
    };
    this.rooms.set(registration.roomId, state);
    if (state.profileLoadStarted) void this.preloadProfile(state);
  }

  onStateChange(change: AiStateChange): void {
    const state = this.rooms.get(change.roomId);
    if (
      !state ||
      state.destroyed ||
      state.terminalEmitted ||
      change.status !== 'IN_PROGRESS'
    )
      return;
    if (change.stateVersion <= state.lastStateVersion) return;
    state.lastStateVersion = change.stateVersion;

    if (
      state.task &&
      !change.activeWords.some((word) => word.wordId === state.task?.wordId)
    ) {
      state.previousTargetWordId = state.task.wordId;
      this.invalidateTask(state);
    }

    state.latestActiveWords = change.activeWords;
    state.latestStatus = change.status;
    const activeWordIds = new Set(
      change.activeWords.map((activeWord) => activeWord.wordId),
    );
    for (const abandonedWordId of state.abandonedWordIds) {
      if (!activeWordIds.has(abandonedWordId)) {
        state.abandonedWordIds.delete(abandonedWordId);
      }
    }
    state.cycleId += 1;

    if (state.evaluationInProgress) {
      state.reevaluationRequested = true;
      state.pendingChange = change;
      return;
    }
    this.reevaluate(state, change);
  }

  pause(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    state.paused = true;
    this.invalidateTask(state);
  }

  invalidate(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (!state) return;
    state.destroyed = true;
    this.invalidateTask(state);
  }

  destroy(roomId: string): void {
    this.invalidate(roomId);
    this.rooms.delete(roomId);
  }

  getTask(roomId: string): AiExecutionTask | undefined {
    return this.rooms.get(roomId)?.task;
  }

  hasRoom(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  getLatestMonitorSnapshot(roomId: string): AiMonitorSnapshot | undefined {
    const snapshot = this.rooms.get(roomId)?.latestMonitorSnapshot;
    return snapshot ? this.cloneMonitorSnapshot(snapshot) : undefined;
  }

  /** Emits the sole terminal patch before invalidate/destroy removes the room. */
  emitTerminal(roomId: string): void {
    const state = this.rooms.get(roomId);
    if (!state || state.destroyed || state.terminalEmitted) return;
    state.terminalEmitted = true;
    if (!state.latestMonitorSnapshot) {
      const skill = state.profileLoadStarted
        ? state.profileSnapshot
        : this.profileProvider.getSkillProfile({
            roomId: state.roomId,
            aiParticipantId: state.aiParticipantId,
          });
      const execution = this.profileFactory.create(
        skill,
        state.difficulty,
        state.runtimeProfile,
      );
      const evaluator = this.executor.evaluatorProfile(
        execution,
        state.difficulty,
      );
      state.executionProfile = {
        difficulty: state.difficulty,
        typingWpm: execution.typingWpm,
        effectiveWordsPerMinute:
          execution.effectiveWordsPerMinute ??
          effectiveWordsPerMinute(
            execution.typingWpm,
            execution.reactionDelayMs,
          ),
        accuracy: execution.accuracy,
        reactionDelayMs: execution.reactionDelayMs,
        typoProbability: typoProbability(
          execution.accuracy,
          evaluator.config,
          execution.typoProbability,
        ),
        correctionDelayMs: evaluator.config.correctionDelayMs,
        abandonProbability: evaluator.config.abandonProbability,
      };
    }
    this.publishMonitorPatch(state, {
      roomId,
      participantId: state.aiParticipantId,
      stateVersion: ++state.monitorStateVersion,
      timestamp: new Date().toISOString(),
      kind: 'TERMINAL',
      currentDecision: {
        ...(state.latestMonitorSnapshot?.currentDecision ?? {
          action: 'NO_TARGET' as const,
          targetWordId: null,
          previousTargetWordId: null,
        }),
        phase: 'IDLE',
      },
      completedKeystrokes: state.task
        ? this.executor.completedKeystrokesAt(state.task, this.clock.now())
        : (state.latestMonitorSnapshot?.completedKeystrokes ?? 0),
    });
  }

  private reevaluate(state: SchedulerState, change: AiStateChange): void {
    state.evaluationInProgress = true;
    try {
      if (state.paused || state.destroyed) return;
      const skill = state.profileLoadStarted
        ? state.profileSnapshot
        : this.profileProvider.getSkillProfile({
            roomId: state.roomId,
            aiParticipantId: state.aiParticipantId,
          });
      const execution = this.profileFactory.create(
        skill,
        state.difficulty,
        state.runtimeProfile,
      );
      const profile = this.executor.evaluatorProfile(
        execution,
        state.difficulty,
      );
      const currentTarget = state.task
        ? this.executor.currentTarget(state.task, this.clock.now())
        : undefined;
      // A selected task already owns the current acquisition/busy interval,
      // including its reaction phase. A SWITCH must not charge another full
      // reaction merely because the previous task had not started typing yet.
      const hasCurrentTask = state.task !== undefined;
      const candidates = change.activeWords.filter(
        (word) => !state.abandonedWordIds.has(word.wordId),
      );
      const decision = evaluateUtility({
        nowMs: this.clock.now(),
        activeWords: candidates,
        reservations: this.selfReservation(state.task),
        currentTarget,
        profile: {
          reactionMs: hasCurrentTask ? 0 : profile.reactionMs,
          perKeystrokeMs: profile.perKeystrokeMs,
          uncertaintyMs: profile.uncertaintyMs,
          urgencyWindowMs: profile.urgencyWindowMs,
          damageWeight: profile.damageWeight,
          urgencyWeight: profile.urgencyWeight,
          opportunityCostWeight: profile.opportunityCostWeight,
          switchMargin: profile.switchMargin,
        },
      });

      state.executionProfile = {
        difficulty: state.difficulty,
        typingWpm: execution.typingWpm,
        effectiveWordsPerMinute:
          execution.effectiveWordsPerMinute ??
          effectiveWordsPerMinute(
            execution.typingWpm,
            execution.reactionDelayMs,
          ),
        accuracy: execution.accuracy,
        reactionDelayMs: execution.reactionDelayMs,
        typoProbability: typoProbability(
          execution.accuracy,
          profile.config,
          execution.typoProbability,
        ),
        correctionDelayMs: profile.config.correctionDelayMs,
        abandonProbability: profile.config.abandonProbability,
      };
      state.previousTargetWordId =
        state.task?.wordId ?? state.previousTargetWordId;
      state.lastDecision = decision;
      this.emitDecision(state, decision, change.activeWords);

      if (decision.action === 'KEEP') return;
      if (decision.action === 'ABANDON') {
        if (state.task) state.abandonedWordIds.add(state.task.wordId);
        this.invalidateTask(state);
        return;
      }
      if (decision.action === 'NO_TARGET') {
        this.invalidateTask(state);
        return;
      }
      if (
        !decision.targetWordId ||
        !this.executor.actionRequiresTask(decision.action)
      ) {
        return;
      }
      const word = candidates.find(
        (candidate) => candidate.wordId === decision.targetWordId,
      );
      if (!word) return;
      this.schedule(
        state,
        word,
        profile,
        decision.action === 'SWITCH' && hasCurrentTask ? 0 : undefined,
      );
    } finally {
      state.evaluationInProgress = false;
      if (state.reevaluationRequested) {
        state.reevaluationRequested = false;
        const latest = state.pendingChange;
        state.pendingChange = undefined;
        if (!state.destroyed && latest) this.reevaluate(state, latest);
      }
    }
  }

  private async preloadProfile(state: SchedulerState): Promise<void> {
    if (
      !this.profileProvider.loadProfile &&
      !this.profileProvider.loadSkillProfile
    )
      return;

    const registrationToken = state.registrationToken;
    const modelPlayerId = state.modelPlayerId;
    try {
      const profile = this.profileProvider.loadProfile
        ? await this.profileProvider.loadProfile({
            roomId: state.roomId,
            aiParticipantId: state.aiParticipantId,
            modelPlayerId,
            difficulty: state.difficulty,
          })
        : await this.profileProvider.loadSkillProfile!({
            roomId: state.roomId,
            aiParticipantId: state.aiParticipantId,
            modelPlayerId,
            difficulty: state.difficulty,
          });
      if (
        this.rooms.get(state.roomId) !== state ||
        state.destroyed ||
        state.terminalEmitted ||
        state.registrationToken !== registrationToken ||
        state.modelPlayerId !== modelPlayerId
      ) {
        return;
      }
      if ('source' in profile) {
        state.runtimeProfile = profile as PlayerRuntimeProfile;
        state.profileSnapshot = {
          wpm: profile.wpm,
          accuracy: profile.accuracy,
          reactionTimeMs: profile.reactionTimeMs,
          sampleCount: profile.sampleCount,
          confidence: profile.confidence,
        };
      } else {
        state.profileSnapshot = profile;
      }
    } catch (err) {
      if (this.rooms.get(state.roomId) !== state || state.destroyed) return;
      this.logger.error(
        `AI profile preload failed for room=${state.roomId} modelPlayerId=${modelPlayerId}: ${String(err)}`,
      );
    }
  }

  private schedule(
    state: SchedulerState,
    word: AiRuntimeWord,
    profile: ReturnType<AiExecutor['evaluatorProfile']>,
    reactionDelayOverrideMs?: number,
  ): void {
    this.invalidateTask(state);
    if (this.executor.shouldAbandon(profile)) {
      state.abandonedWordIds.add(word.wordId);
      return;
    }
    const generation = ++state.generation;
    const token = randomUUID();
    const task = this.executor.createTask(
      state.roomId,
      word,
      profile,
      generation,
      token,
      null,
      reactionDelayOverrideMs,
    );
    state.task = task;
    this.emitPhase(state, task, 'REACTION', 0, '');
    this.scheduleNextTaskEvent(state, task, generation, token);
  }

  private scheduleNextTaskEvent(
    state: SchedulerState,
    task: AiExecutionTask,
    generation: number,
    token: string,
    afterMs = this.clock.now(),
  ): void {
    const nextAtMs = this.executor.nextProgressAtMs(task, afterMs);
    if (nextAtMs === undefined) return;
    task.nextEventAtMs = nextAtMs;
    task.timer = this.timer.setTimeout(
      () =>
        void this.handleTaskEvent(
          state.roomId,
          generation,
          token,
          task.wordId,
          nextAtMs,
        ),
      Math.max(0, nextAtMs - afterMs),
    );
  }

  private async handleTaskEvent(
    roomId: string,
    generation: number,
    token: string,
    wordId: string,
    eventAtMs: number,
  ): Promise<void> {
    const state = this.rooms.get(roomId);
    if (!state || !state.task || state.destroyed || state.paused) return;
    const task = state.task;
    if (
      task.generation !== generation ||
      task.token !== token ||
      task.wordId !== wordId ||
      state.generation !== generation
    ) {
      return;
    }
    task.timer = null;
    task.nextEventAtMs = null;
    const completionMs = this.executor.completionMs(task);
    if (eventAtMs < completionMs) {
      const completed = this.executor.completedKeystrokesAt(task, eventAtMs);
      this.emitPhase(
        state,
        task,
        this.executor.isCorrecting(task, eventAtMs) ? 'CORRECTING' : 'TYPING',
        completed,
        this.executor.typingSnapshot(task, completed),
      );
      if (this.isCurrentTask(state, task, generation, token)) {
        this.scheduleNextTaskEvent(state, task, generation, token, eventAtMs);
      }
      return;
    }
    if (!this.lastActiveWord(state, wordId)) return;
    this.emitPhase(state, task, 'TYPING', task.totalKeystrokes, task.text);
    if (!this.isCurrentTask(state, task, generation, token)) return;
    const input: JudgeWordSubmitInput = {
      roomId,
      playerId: state.aiParticipantId,
      wordId,
      text: task.text,
      attemptId: `${roomId}:${token}`,
      aiTiming: {
        firstTypingAtMs: task.typingStartedAtMs,
        submitReceivedAtMs: completionMs,
        correctionCount: task.timeline.filter(
          (segment) => segment.kind === 'CORRECTION',
        ).length,
        totalKeystrokes: task.totalKeystrokes,
      },
    };
    await state.submitWord(input);
    if (this.isCurrentTask(state, task, generation, token)) {
      this.clearProgress(state, task);
      state.task = undefined;
    }
  }

  private lastActiveWord(
    state: SchedulerState,
    wordId: string,
  ): AiRuntimeWord | undefined {
    return state.latestStatus === 'IN_PROGRESS'
      ? state.latestActiveWords.find((word) => word.wordId === wordId)
      : undefined;
  }

  private selfReservation(
    task: AiExecutionTask | undefined,
  ): ReadonlyMap<string, { owner: 'SELF' }> {
    return task
      ? new Map([[task.wordId, { owner: 'SELF' as const }]])
      : new Map();
  }

  private invalidateTask(state: SchedulerState): void {
    const task = state.task;
    if (task?.timer) this.timer.clearTimeout(task.timer);
    if (task) this.clearProgress(state, task);
    state.generation += 1;
    state.task = undefined;
  }

  private emitPhase(
    state: SchedulerState,
    task: AiExecutionTask,
    phase: NonNullable<OpponentTypingEventPayload['phase']>,
    completedKeystrokes: number,
    partialText: string,
  ): void {
    if (!this.isCurrentTask(state, task, task.generation, task.token)) return;
    if (
      partialText === task.lastEmittedPartialText &&
      phase !== 'CORRECTING' &&
      task.progressWasVisible
    )
      return;
    task.lastEmittedPartialText = partialText;
    task.progressWasVisible = true;
    state.monitorPhase = phase;
    state.emitTypingProgress({
      participantId: state.aiParticipantId,
      partialText,
      wordId: task.wordId,
      completedKeystrokes,
      totalKeystrokes: task.totalKeystrokes,
      phase,
      stateVersion: ++state.typingStateVersion,
    });
    this.emitMonitorPhase(state, task, phase, completedKeystrokes);
  }

  private clearProgress(state: SchedulerState, task: AiExecutionTask): void {
    if (!task.progressWasVisible || task.progressCleared) return;
    task.progressCleared = true;
    if (this.isCurrentTask(state, task, task.generation, task.token)) {
      state.emitTypingProgress({
        participantId: state.aiParticipantId,
        partialText: '',
        wordId: task.wordId,
        completedKeystrokes: task.totalKeystrokes,
        totalKeystrokes: task.totalKeystrokes,
        phase: 'IDLE',
        stateVersion: ++state.typingStateVersion,
      });
      state.monitorPhase = 'IDLE';
      this.emitMonitorPhase(state, task, 'IDLE', task.totalKeystrokes);
    }
  }

  private emitDecision(
    state: SchedulerState,
    decision: UtilityDecision,
    activeWords: readonly AiRuntimeWord[],
  ): void {
    this.publishMonitorPatch(state, {
      roomId: state.roomId,
      participantId: state.aiParticipantId,
      stateVersion: ++state.monitorStateVersion,
      timestamp: new Date().toISOString(),
      kind: state.latestMonitorSnapshot ? 'DECISION' : 'FULL',
      currentDecision: {
        action: decision.action,
        phase: state.monitorPhase,
        targetWordId: decision.targetWordId ?? null,
        previousTargetWordId: state.previousTargetWordId,
      },
      profile: this.toMonitorProfile(state),
      executionProfile: state.executionProfile!,
      candidates: this.toMonitorCandidates(activeWords, decision),
      completedKeystrokes: state.task
        ? this.executor.completedKeystrokesAt(state.task, this.clock.now())
        : 0,
      totalKeystrokes: state.task?.totalKeystrokes ?? 0,
    });
  }

  private emitMonitorPhase(
    state: SchedulerState,
    task: AiExecutionTask,
    phase: NonNullable<OpponentTypingEventPayload['phase']>,
    completedKeystrokes: number,
  ): void {
    if (!state.latestMonitorSnapshot) return;
    this.publishMonitorPatch(state, {
      roomId: state.roomId,
      participantId: state.aiParticipantId,
      stateVersion: ++state.monitorStateVersion,
      timestamp: new Date().toISOString(),
      kind: 'PHASE',
      currentDecision: {
        ...state.latestMonitorSnapshot.currentDecision,
        phase,
      },
      completedKeystrokes,
      totalKeystrokes: task.totalKeystrokes,
    });
  }

  private toMonitorCandidates(
    activeWords: readonly AiRuntimeWord[],
    decision: UtilityDecision,
  ): AiMonitorCandidate[] {
    const ranked = new Map(
      decision.rankedCandidates.map((candidate) => [
        candidate.wordId,
        candidate,
      ]),
    );
    const now = this.clock.now();
    return activeWords.slice(0, MAX_MONITOR_CANDIDATES).map((word) => {
      const candidate = ranked.get(word.wordId);
      return {
        wordId: word.wordId,
        utility: candidate?.utility ?? null,
        successProbability: candidate?.successProbability ?? null,
        urgency: candidate?.urgency ?? null,
        completionMs: candidate?.completionMs ?? null,
        opportunityCost: candidate?.opportunityCost ?? null,
        remainingMs: word.landAtMs - now,
        eligible: candidate !== undefined,
        selected: decision.targetWordId === word.wordId,
      };
    });
  }

  private publishMonitorPatch(
    state: SchedulerState,
    patch: AiMonitorSnapshotPatch,
  ): void {
    if (state.terminalEmitted && patch.kind !== 'TERMINAL') return;
    const materialized: AiMonitorSnapshot = {
      ...(state.latestMonitorSnapshot ?? {
        roomId: state.roomId,
        participantId: state.aiParticipantId,
        currentDecision: {
          action: 'NO_TARGET' as const,
          phase: 'IDLE' as const,
          targetWordId: null,
          previousTargetWordId: null,
        },
        profile: this.toMonitorProfile(state),
        executionProfile: state.executionProfile!,
        candidates: [],
        completedKeystrokes: 0,
        totalKeystrokes: 0,
      }),
      ...patch,
      kind: 'FULL',
    };
    state.latestMonitorSnapshot = materialized;
    if (!state.emitMonitorSnapshot) return;
    try {
      state.emitMonitorSnapshot({ ...patch });
    } catch (err) {
      this.logger.error(
        `AI monitor snapshot emit failed for room=${state.roomId}: ${String(err)}`,
      );
    }
  }

  private cloneMonitorSnapshot(snapshot: AiMonitorSnapshot): AiMonitorSnapshot {
    return {
      ...snapshot,
      currentDecision: { ...snapshot.currentDecision },
      profile: { ...snapshot.profile },
      executionProfile: { ...snapshot.executionProfile },
      candidates: snapshot.candidates.map((candidate) => ({ ...candidate })),
    };
  }

  private toMonitorProfile(state: SchedulerState) {
    const profile = state.runtimeProfile;
    return {
      wpm: profile.wpm,
      accuracy: profile.accuracy,
      reactionTimeMs: profile.reactionTimeMs,
      sampleCount: profile.sampleCount,
      confidence: profile.confidence,
      source: profile.source,
      profileVersion: profile.profileVersion,
      populationDefaultVersion: profile.populationDefaultVersion,
      fallbackReason: profile.fallbackReason,
      metricConfidence: {
        wpm: {
          sampleCount: profile.sampleCount,
          confidence: profile.confidence,
          available: profile.sampleCount > 0,
        },
        accuracy: {
          sampleCount: profile.sampleCount,
          confidence: profile.confidence,
          available: profile.sampleCount > 0,
        },
        reactionTimeMs: {
          sampleCount: profile.sampleCount,
          confidence: profile.confidence,
          available: profile.sampleCount > 0,
        },
        typoProbability: profile.typoProbability,
        correctionDelayMs: profile.correctionDelayMs,
        abandonProbability: profile.abandonProbability,
        shortWordPerformance: profile.wordLengthPerformance.short,
        mediumWordPerformance: profile.wordLengthPerformance.medium,
        longWordPerformance: profile.wordLengthPerformance.long,
      },
    };
  }

  private isCurrentTask(
    state: SchedulerState,
    task: AiExecutionTask,
    generation: number,
    token: string,
  ): boolean {
    return (
      state.task === task &&
      task.generation === generation &&
      task.token === token &&
      state.generation === generation &&
      !state.destroyed &&
      !state.paused &&
      state.latestStatus === 'IN_PROGRESS' &&
      Boolean(this.lastActiveWord(state, task.wordId))
    );
  }
}
