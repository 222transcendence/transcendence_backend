import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AiExecutionProfile } from '../../player-model';
import { createHangulTypingSnapshots } from './hangul-ime';
import type { UtilityAction, CurrentTarget } from './state-evaluator';
import type {
  AiExecutionTask,
  AiRuntimeWord,
  AiTypingSegment,
  Clock,
  RandomSource,
} from './ai-execution.types';
import { AI_CLOCK, AI_RANDOM_SOURCE } from './ai-execution.types';
import {
  createEvaluatorProfile,
  typoProbability,
  type AiEvaluatorProfile,
} from './ai-execution-profile';

const systemClock: Clock = { now: () => Date.now() };
const systemRandom: RandomSource = { next: () => Math.random() };

@Injectable()
export class AiExecutor {
  constructor(
    @Optional()
    @Inject(AI_CLOCK)
    private readonly clock: Clock = systemClock,
    @Optional()
    @Inject(AI_RANDOM_SOURCE)
    private readonly random: RandomSource = systemRandom,
  ) {}

  evaluatorProfile(
    execution: AiExecutionProfile,
    difficulty: 'BEGINNER' | 'NORMAL' | 'HARD',
  ): AiEvaluatorProfile {
    return createEvaluatorProfile(execution, difficulty);
  }

  shouldAbandon(profile: AiEvaluatorProfile): boolean {
    return this.random.next() < profile.config.abandonProbability;
  }

  createTask(
    roomId: string,
    word: AiRuntimeWord,
    profile: AiEvaluatorProfile,
    generation: number,
    token: string,
    timer: ReturnType<typeof setTimeout> | null = null,
  ): AiExecutionTask {
    const selectedAtMs = this.clock.now();
    const jitterMs = (this.random.next() * 2 - 1) * profile.config.jitterMs;
    const reactionDelayMs = Math.max(
      profile.config.minimumAsyncDelayMs,
      profile.execution.reactionDelayMs + jitterMs,
    );
    const reactionEndsAtMs = selectedAtMs + reactionDelayMs;
    const typingStartedAtMs = reactionEndsAtMs;
    const timeline: AiTypingSegment[] = [];
    const normalizedText = word.text.normalize('NFC');
    const typingSnapshots = createHangulTypingSnapshots(normalizedText);
    let cursor = typingStartedAtMs;
    const typoChance = typoProbability(
      profile.execution.accuracy,
      profile.config,
      profile.execution.typoProbability,
    );

    for (let index = 0; index < word.keystrokes; index += 1) {
      const startMs = cursor;
      const endMs = startMs + profile.perKeystrokeMs;
      const typo = this.random.next() < typoChance;
      const completionMs = typo
        ? endMs + profile.config.correctionDelayMs
        : endMs;
      timeline.push({
        startMs,
        endMs,
        completionMs,
        kind: 'KEYSTROKE',
        keystrokeIndex: index,
      });
      if (typo) {
        timeline.push({
          startMs: endMs,
          endMs: completionMs,
          completionMs,
          kind: 'CORRECTION',
          keystrokeIndex: index,
        });
      }
      cursor = completionMs;
    }

    return {
      roomId,
      wordId: word.wordId,
      text: normalizedText,
      selectedAtMs,
      reactionEndsAtMs,
      typingStartedAtMs,
      totalKeystrokes: word.keystrokes,
      perKeystrokeMs: profile.perKeystrokeMs,
      timeline,
      generation,
      token,
      timer,
      lastEmittedPartialText: '',
      progressWasVisible: false,
      progressCleared: false,
      nextEventAtMs: null,
      typingSnapshots,
    };
  }

  partialText(task: AiExecutionTask, nowMs: number): string {
    if (nowMs < task.reactionEndsAtMs) return '';
    const completed = this.completedKeystrokes(task, nowMs);
    return task.typingSnapshots[completed - 1] ?? '';
  }

  completedKeystrokesAt(task: AiExecutionTask, nowMs: number): number {
    return this.completedKeystrokes(task, nowMs);
  }

  typingSnapshot(task: AiExecutionTask, completedKeystrokes: number): string {
    if (completedKeystrokes >= task.totalKeystrokes) return task.text;
    return task.typingSnapshots[completedKeystrokes - 1] ?? '';
  }

  isCorrecting(task: AiExecutionTask, nowMs: number): boolean {
    return task.timeline.some(
      (segment) =>
        segment.kind === 'CORRECTION' &&
        segment.startMs <= nowMs &&
        nowMs < segment.completionMs,
    );
  }

  nextProgressAtMs(task: AiExecutionTask, nowMs: number): number | undefined {
    return task.timeline
      .filter(
        (segment) =>
          (segment.kind === 'KEYSTROKE' && segment.completionMs > nowMs) ||
          (segment.kind === 'CORRECTION' && segment.startMs > nowMs),
      )
      .reduce<number | undefined>((next, segment) => {
        const boundary =
          segment.kind === 'CORRECTION'
            ? segment.startMs
            : segment.completionMs;
        return next === undefined ? boundary : Math.min(next, boundary);
      }, undefined);
  }

  currentTarget(
    task: AiExecutionTask,
    nowMs: number,
  ): CurrentTarget | undefined {
    if (nowMs < task.reactionEndsAtMs) {
      return {
        wordId: task.wordId,
        execution: { state: 'NOT_STARTED' },
      };
    }

    const completedCount = this.completedKeystrokes(task, nowMs);
    return {
      wordId: task.wordId,
      execution: {
        state: 'IN_PROGRESS',
        remainingKeystrokes: Math.min(
          task.totalKeystrokes,
          Math.max(0, task.totalKeystrokes - completedCount),
        ),
      },
    };
  }

  completionMs(task: AiExecutionTask): number {
    return task.timeline.reduce(
      (latest, segment) => Math.max(latest, segment.completionMs),
      task.typingStartedAtMs,
    );
  }

  private completedKeystrokes(task: AiExecutionTask, nowMs: number): number {
    const completed = new Set<number>();
    for (const segment of task.timeline) {
      if (segment.kind === 'KEYSTROKE' && segment.completionMs <= nowMs) {
        completed.add(segment.keystrokeIndex);
      }
    }
    return Math.min(task.totalKeystrokes, Math.max(0, completed.size));
  }

  actionRequiresTask(action: UtilityAction): boolean {
    return action === 'SELECT' || action === 'SWITCH';
  }
}
