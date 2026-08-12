import type { AiExecutionProfile } from '../../player-model';
import { AiExecutor } from './ai-executor';
import { createEvaluatorProfile } from './ai-execution-profile';
import type { Clock, RandomSource } from './ai-execution.types';

function execution(): AiExecutionProfile {
  return { typingWpm: 60, accuracy: 0.9, reactionDelayMs: 100 };
}

function profile() {
  return createEvaluatorProfile(execution(), 'NORMAL');
}

function taskWithRandom(values: number[]) {
  let now = 0;
  const clock: Clock = { now: () => now };
  const random: RandomSource = { next: () => values.shift() ?? 1 };
  const executor = new AiExecutor(clock, random);
  const task = executor.createTask(
    'room',
    { wordId: 'word', text: 'abc', keystrokes: 3, landAtMs: 5000, damage: 1 },
    profile(),
    1,
    'token',
  );
  return { executor, task, setNow: (value: number) => (now = value) };
}

describe('AiExecutor timeline progress', () => {
  it('reports NOT_STARTED during reaction delay', () => {
    const { executor, task } = taskWithRandom([1, 1, 1]);
    expect(executor.currentTarget(task, task.reactionEndsAtMs - 1)).toEqual({
      wordId: 'word',
      execution: { state: 'NOT_STARTED' },
    });
  });

  it('counts a normal keystroke immediately after its end', () => {
    const { executor, task, setNow } = taskWithRandom([0.5, 1, 1, 1]);
    const firstKeyEnd = task.timeline.find(
      (segment) => segment.kind === 'KEYSTROKE',
    )!.endMs;
    setNow(firstKeyEnd);
    expect(executor.currentTarget(task, firstKeyEnd)).toEqual({
      wordId: 'word',
      execution: { state: 'IN_PROGRESS', remainingKeystrokes: 2 },
    });
  });

  it('does not count a typo before or during correction', () => {
    const { executor, task, setNow } = taskWithRandom([0.5, 0, 1, 1]);
    const typo = task.timeline.find(
      (segment) =>
        segment.kind === 'KEYSTROKE' && segment.completionMs > segment.endMs,
    )!;
    setNow(typo.endMs);
    expect(executor.currentTarget(task, typo.endMs)?.execution).toEqual({
      state: 'IN_PROGRESS',
      remainingKeystrokes: 3,
    });
    setNow(typo.completionMs - 1);
    expect(
      executor.currentTarget(task, typo.completionMs - 1)?.execution,
    ).toEqual({
      state: 'IN_PROGRESS',
      remainingKeystrokes: 3,
    });
    setNow(typo.completionMs);
    expect(executor.currentTarget(task, typo.completionMs)?.execution).toEqual({
      state: 'IN_PROGRESS',
      remainingKeystrokes: 2,
    });
  });

  it('counts each typo keystroke once and clamps remaining progress', () => {
    const { executor, task, setNow } = taskWithRandom([0.5, 0, 0, 1]);
    const end = executor.completionMs(task);
    setNow(end + 1000);
    const current = executor.currentTarget(task, end + 1000)!;
    expect(current.execution).toEqual({
      state: 'IN_PROGRESS',
      remainingKeystrokes: 0,
    });
    if (current.execution.state === 'IN_PROGRESS') {
      expect(current.execution.remainingKeystrokes).toBeGreaterThanOrEqual(0);
      expect(current.execution.remainingKeystrokes).toBeLessThanOrEqual(
        task.totalKeystrokes,
      );
    }
  });

  it('includes reaction and typing time in the final completion time', () => {
    const { executor, task } = taskWithRandom([0.5, 1, 1, 1]);
    expect(executor.completionMs(task) - task.selectedAtMs).toBe(
      task.reactionEndsAtMs -
        task.selectedAtMs +
        task.totalKeystrokes * task.perKeystrokeMs,
    );
  });

  it('adds correction time and deterministic jitter to completion', () => {
    const normal = taskWithRandom([0.5, 1, 1, 1]);
    const typo = taskWithRandom([0.5, 0, 1, 1]);
    const jittered = taskWithRandom([1, 1, 1, 1]);
    expect(normal.executor.completionMs(typo.task)).toBeGreaterThan(
      normal.executor.completionMs(normal.task),
    );
    expect(jittered.task.reactionEndsAtMs).toBeGreaterThan(
      normal.task.reactionEndsAtMs,
    );
    expect(taskWithRandom([0.5, 0, 1, 1]).task).toEqual(typo.task);
  });
});
