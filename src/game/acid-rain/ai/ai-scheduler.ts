import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { JudgeWordSubmitInput } from '../acid-rain.interface';
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
}

const systemClock: Clock = { now: () => Date.now() };
const systemTimer: Timer = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

@Injectable()
export class AiScheduler {
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
    this.rooms.set(registration.roomId, {
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
    });
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
      const skill = this.profileProvider.getSkillProfile({
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
      this.emitProgress(
        state,
        task,
        this.executor.partialText(task, eventAtMs),
      );
      if (this.isCurrentTask(state, task, generation, token)) {
        this.scheduleNextTaskEvent(state, task, generation, token, eventAtMs);
      }
      return;
    }
    if (!this.lastActiveWord(state, wordId)) return;
    this.emitProgress(state, task, task.text);
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

  private emitProgress(
    state: SchedulerState,
    task: AiExecutionTask,
    partialText: string,
  ): void {
    if (!partialText || partialText === task.lastEmittedPartialText) return;
    if (!this.isCurrentTask(state, task, task.generation, task.token)) return;
    task.lastEmittedPartialText = partialText;
    task.progressWasVisible = true;
    state.emitTypingProgress(state.aiParticipantId, partialText);
  }

  private clearProgress(state: SchedulerState, task: AiExecutionTask): void {
    if (!task.progressWasVisible || task.progressCleared) return;
    task.progressCleared = true;
    if (this.isCurrentTask(state, task, task.generation, task.token)) {
      state.emitTypingProgress(state.aiParticipantId, '');
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
