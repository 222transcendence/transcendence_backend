import type {
  AiDifficulty,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  OpponentTypingEventPayload,
  AiMonitorSnapshotPatch,
} from '../acid-rain.interface';

export const AI_CLOCK = Symbol('AI_CLOCK');
export const AI_TIMER = Symbol('AI_TIMER');
export const AI_RANDOM_SOURCE = Symbol('AI_RANDOM_SOURCE');
export const AI_PROFILE_PROVIDER = Symbol('AI_PROFILE_PROVIDER');
export const AI_PROFILE_FACTORY = Symbol('AI_PROFILE_FACTORY');

export interface Clock {
  now(): number;
}

export interface Timer {
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

export interface RandomSource {
  next(): number;
}

export interface AiRuntimeWord {
  wordId: string;
  text: string;
  keystrokes: number;
  landAtMs: number;
  damage: number;
}

export interface AiTypingSegment {
  startMs: number;
  endMs: number;
  completionMs: number;
  kind: 'KEYSTROKE' | 'CORRECTION';
  keystrokeIndex: number;
}

export interface AiExecutionTask {
  roomId: string;
  wordId: string;
  text: string;
  selectedAtMs: number;
  reactionEndsAtMs: number;
  typingStartedAtMs: number;
  totalKeystrokes: number;
  perKeystrokeMs: number;
  timeline: readonly AiTypingSegment[];
  generation: number;
  token: string;
  timer: ReturnType<typeof setTimeout> | null;
  lastEmittedPartialText: string;
  progressWasVisible: boolean;
  progressCleared: boolean;
  nextEventAtMs: number | null;
  typingSnapshots: readonly string[];
}

export interface AiSubmissionCallback {
  (input: JudgeWordSubmitInput): Promise<JudgeWordSubmitResult>;
}

export interface AiTypingProgressCallback {
  (payload: OpponentTypingEventPayload): void;
}

export interface AiMonitorSnapshotCallback {
  (payload: AiMonitorSnapshotPatch): void;
}

export interface AiSchedulerRegistration {
  roomId: string;
  aiParticipantId: string;
  modelPlayerId: string;
  difficulty: AiDifficulty;
  submitWord: AiSubmissionCallback;
  emitTypingProgress: AiTypingProgressCallback;
  emitMonitorSnapshot?: AiMonitorSnapshotCallback;
}

export interface AiStateChange {
  roomId: string;
  stateVersion: number;
  activeWords: readonly AiRuntimeWord[];
  status: 'COUNTDOWN' | 'IN_PROGRESS' | 'FINISHED';
  event: 'SPAWN' | 'CLEAR' | 'MISS';
}
