import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type {
  JudgeWordSubmitInput,
  OpponentTypingEventPayload,
} from '../acid-rain.interface';
import { evaluateUtility } from './state-evaluator';
import {
  DefaultAiExecutionProfileFactory,
  DefaultAiProfileProvider,
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
import { DEFAULT_PLAYER_SKILL } from '../../player-model';
import type { PlayerSkillProfile } from '../../player-model';

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
  profileLoadStarted: boolean;
  registrationToken: string;
  typingStateVersion: number;
}

const systemClock: Clock = { now: () => Date.now() };
const systemTimer: Timer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

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
      profileLoadStarted:
        typeof this.profileProvider.loadSkillProfile === 'function',
      registrationToken: randomUUID(),
      typingStateVersion: 0,
    };
    this.rooms.set(registration.roomId, state);
    if (state.profileLoadStarted) void this.preloadProfile(state);
  }

  onStateChange(change: AiStateChange): void {
    const state = this.rooms.get(change.roomId);
    if (!state || state.destroyed || change.status !== 'IN_PROGRESS') return;
    if (change.stateVersion <= state.lastStateVersion) return;
    state.lastStateVersion = change.stateVersion;

    if (
      state.task &&
      !change.activeWords.some((word) => word.wordId === state.task?.wordId)
    ) {
      this.invalidateTask(state);
    }

    state.latestActiveWords = change.activeWords;
    state.latestStatus = change.status;
    state.abandonedWordIds.clear();
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
    this.invalidateTask(state);
    state.destroyed = true;
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
      const execution = this.profileFactory.create(skill, state.difficulty);
      const profile = this.executor.evaluatorProfile(
        execution,
        state.difficulty,
      );
      const currentTarget = state.task
        ? this.executor.currentTarget(state.task, this.clock.now())
        : undefined;
      const candidates = change.activeWords.filter(
        (word) => !state.abandonedWordIds.has(word.wordId),
      );
      const decision = evaluateUtility({
        nowMs: this.clock.now(),
        activeWords: candidates,
        reservations: this.selfReservation(state.task),
        currentTarget,
        profile: {
          reactionMs: profile.reactionMs,
          perKeystrokeMs: profile.perKeystrokeMs,
          uncertaintyMs: profile.uncertaintyMs,
          urgencyWindowMs: profile.urgencyWindowMs,
          damageWeight: profile.damageWeight,
          urgencyWeight: profile.urgencyWeight,
          opportunityCostWeight: profile.opportunityCostWeight,
          switchMargin: profile.switchMargin,
        },
      });

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
      this.schedule(state, word, profile);
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
    if (!this.profileProvider.loadSkillProfile) return;

    const registrationToken = state.registrationToken;
    const modelPlayerId = state.modelPlayerId;
    try {
      const profile = await this.profileProvider.loadSkillProfile({
        roomId: state.roomId,
        aiParticipantId: state.aiParticipantId,
        modelPlayerId,
        difficulty: state.difficulty,
      });
      if (
        this.rooms.get(state.roomId) !== state ||
        state.destroyed ||
        state.registrationToken !== registrationToken ||
        state.modelPlayerId !== modelPlayerId
      ) {
        return;
      }
      state.profileSnapshot = profile;
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
    phase: OpponentTypingEventPayload['phase'],
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
    state.emitTypingProgress({
      participantId: state.aiParticipantId,
      partialText,
      wordId: task.wordId,
      completedKeystrokes,
      totalKeystrokes: task.totalKeystrokes,
      phase,
      stateVersion: ++state.typingStateVersion,
    });
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
    }
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
