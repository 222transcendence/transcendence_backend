import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AiExecutionProfile } from '../../player-model';
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
    let cursor = typingStartedAtMs;
    const typoChance = typoProbability(
      profile.execution.accuracy,
      profile.config,
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
      text: word.text,
      selectedAtMs,
      reactionEndsAtMs,
      typingStartedAtMs,
      totalKeystrokes: word.keystrokes,
      perKeystrokeMs: profile.perKeystrokeMs,
      timeline,
      generation,
      token,
      timer,
    };
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

    const completed = new Set<number>();
    for (const segment of task.timeline) {
      if (segment.kind === 'KEYSTROKE' && segment.completionMs <= nowMs) {
        completed.add(segment.keystrokeIndex);
      }
    }
    const completedCount = Math.min(
      task.totalKeystrokes,
      Math.max(0, completed.size),
    );
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

  actionRequiresTask(action: UtilityAction): boolean {
    return action === 'SELECT' || action === 'SWITCH';
  }
}
