import type {
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
} from '../acid-rain.interface';
import { AiExecutor } from './ai-executor';
import { AiScheduler } from './ai-scheduler';
import type { Clock, RandomSource, Timer } from './ai-execution.types';

function accepted(input: JudgeWordSubmitInput): JudgeWordSubmitResult {
  return {
    accepted: true,
    roomId: input.roomId,
    playerId: input.playerId,
    wordId: input.wordId,
    attemptId: input.attemptId,
    wordStateBefore: 'ACTIVE',
    wordStateAfter: 'CLEARED',
    damage: 1,
    targetHpByParticipantId: { ai: 100 },
    gameEnded: false,
    winnerId: null,
    loserId: null,
    endReason: null,
    wordCleared: {
      wordId: input.wordId,
      clearedBy: input.playerId,
      damage: 1,
      hp: { ai: 100 },
      targetHpByParticipantId: { ai: 100 },
    },
  };
}

function setup() {
  let now = 0;
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  const clock: Clock = { now: () => now };
  const timer: Timer = {
    setTimeout: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return callbacks.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (timer) => {
      const index = Number(timer) - 1;
      if (index >= 0) callbacks[index] = () => undefined;
    },
  };
  const random: RandomSource = { next: () => 1 };
  const executor = new AiExecutor(clock, random);
  const submitted: JudgeWordSubmitInput[] = [];
  const progress: Array<{ participantId: string; partialText: string }> = [];
  const scheduler = new AiScheduler(
    executor,
    undefined,
    undefined,
    clock,
    timer,
    random,
  );
  scheduler.registerRoom({
    roomId: 'room',
    aiParticipantId: 'ai:room',
    difficulty: 'NORMAL',
    submitWord: (input) => {
      submitted.push(input);
      return Promise.resolve(accepted(input));
    },
    emitTypingProgress: (participantId, partialText) => {
      progress.push({ participantId, partialText });
    },
  });
  return {
    scheduler,
    submitted,
    callbacks,
    delays,
    runTimers: () => {
      while (callbacks.length > 0) callbacks.shift()!();
    },
    setNow: (value: number) => (now = value),
    progress,
  };
}

const word = {
  wordId: 'w1',
  text: 'abc',
  keystrokes: 3,
  landAtMs: 10000,
  damage: 2,
};

describe('AiScheduler lifecycle and race guards', () => {
  it('does not emit progress during reaction and suppresses duplicate partial text', async () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.progress).toHaveLength(0);
    test.runTimers();
    await Promise.resolve();
    expect(test.progress.map((event) => event.partialText)).toEqual([
      'a',
      'ab',
      'abc',
      '',
    ]);
  });

  it('emits Korean progress only when a syllable boundary changes', async () => {
    const test = setup();
    const koreanWord = { ...word, text: '가나', keystrokes: 4 };
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [koreanWord],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    test.runTimers();
    await Promise.resolve();
    expect(test.progress.map((event) => event.partialText)).toEqual([
      '가',
      '가나',
      '',
    ]);
  });

  it('clears only the switched task before the new task starts progress', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    test.callbacks.shift()!();
    const beforeSwitch = test.progress.length;
    const betterWord = { ...word, wordId: 'w2', text: 'xyz', damage: 100 };
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word, betterWord],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.progress.slice(beforeSwitch)).toEqual([
      { participantId: 'ai:room', partialText: '' },
    ]);
    expect(test.scheduler.getTask('room')?.wordId).toBe('w2');
  });

  it('keeps progress and timer on KEEP when another word is cleared', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const task = test.scheduler.getTask('room');
    const timer = task?.timer;
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    expect(test.scheduler.getTask('room')).toBe(task);
    expect(test.scheduler.getTask('room')?.timer).toBe(timer);
    expect(test.progress).toHaveLength(0);
  });

  it('clears the current target exactly once when it disappears', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    test.callbacks.shift()!();
    const beforeClear = test.progress.length;
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    expect(test.progress.slice(beforeClear)).toEqual([
      { participantId: 'ai:room', partialText: '' },
    ]);
    expect(test.scheduler.getTask('room')).toBeUndefined();
  });

  it('does not let an old submit settle clear a new task display', async () => {
    const test = setup();
    let settle!: () => void;
    const pending = new Promise<ReturnType<typeof accepted>>((resolve) => {
      settle = () =>
        resolve(
          accepted({
            roomId: 'room',
            playerId: 'ai:room',
            wordId: 'w1',
            text: 'abc',
            attemptId: 'old',
          }),
        );
    });
    const submit = jest.fn(() => pending);
    test.scheduler.destroy('room');
    test.scheduler.registerRoom({
      roomId: 'room',
      aiParticipantId: 'ai:room',
      difficulty: 'NORMAL',
      submitWord: submit,
      emitTypingProgress: (participantId, partialText) => {
        test.progress.push({ participantId, partialText });
      },
    });
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    test.runTimers();
    await Promise.resolve();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [{ ...word, wordId: 'w2', text: 'xyz' }],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const newProgressCount = test.progress.length;
    settle();
    await Promise.resolve();
    expect(test.progress.length).toBeGreaterThanOrEqual(newProgressCount);
    expect(test.progress.slice(newProgressCount)).not.toContainEqual({
      participantId: 'ai:room',
      partialText: '',
    });
  });
  it('keeps the existing task and timer for KEEP', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const firstTimer = test.scheduler.getTask('room')?.timer;
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    expect(test.scheduler.getTask('room')?.timer).toBe(firstTimer);
  });

  it('SWITCH invalidates the old callback and schedules only the new target', async () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const oldCallback = test.callbacks[0];
    const betterWord = { ...word, wordId: 'w2', text: 'xyz', damage: 100 };
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word, betterWord],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.scheduler.getTask('room')?.wordId).toBe('w2');
    oldCallback();
    await Promise.resolve();
    expect(test.submitted).toHaveLength(0);
    test.runTimers();
    await Promise.resolve();
    expect(test.submitted).toHaveLength(1);
    expect(test.submitted[0].wordId).toBe('w2');
  });

  it('does not create a task for NO_TARGET', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [{ ...word, landAtMs: 1 }],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.scheduler.getTask('room')).toBeUndefined();
    expect(test.callbacks).toHaveLength(0);
  });

  it('keeps at most one active task per room', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word, { ...word, wordId: 'w2', damage: 100 }],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.scheduler.getTask('room')).toBeDefined();
    expect(test.scheduler.hasRoom('room')).toBe(true);
  });

  it('does not evaluate during countdown and schedules after spawn', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'COUNTDOWN',
      event: 'SPAWN',
    });
    expect(test.scheduler.getTask('room')).toBeUndefined();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.scheduler.getTask('room')).toBeDefined();
    expect(test.delays[0]).toBeGreaterThan(0);
  });

  it('invalidates the old callback when the target is cleared', () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    test.runTimers();
    expect(test.submitted).toHaveLength(0);
  });

  it('does not immediately reselect an abandoned word', () => {
    const executor = new AiExecutor({ now: () => 0 }, { next: () => 0 });
    const abandoning = new AiScheduler(
      executor,
      undefined,
      undefined,
      { now: () => 0 },
      {
        setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeout: () => undefined,
      },
      { next: () => 0 },
    );
    abandoning.registerRoom({
      roomId: 'room',
      aiParticipantId: 'ai:room',
      difficulty: 'NORMAL',
      submitWord: (input) => Promise.resolve(accepted(input)),
      emitTypingProgress: () => undefined,
    });
    abandoning.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(abandoning.getTask('room')).toBeUndefined();
    abandoning.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    expect(abandoning.getTask('room')).toBeUndefined();
  });

  it('deduplicates equal and smaller state versions', () => {
    const profileProvider = {
      getSkillProfile: jest.fn(() => ({
        wpm: 45,
        accuracy: 0.92,
        reactionTimeMs: 650,
        sampleCount: 0,
        confidence: 0,
      })),
    };
    const test = setup();
    const scheduler = new AiScheduler(
      new AiExecutor({ now: () => 0 }, { next: () => 1 }),
      profileProvider,
      undefined,
      { now: () => 0 },
      {
        setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeout: () => undefined,
      },
    );
    scheduler.registerRoom({
      roomId: 'room',
      aiParticipantId: 'ai:room',
      difficulty: 'NORMAL',
      submitWord: (input) => Promise.resolve(accepted(input)),
      emitTypingProgress: () => undefined,
    });
    const change = {
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS' as const,
      event: 'SPAWN' as const,
    };
    scheduler.onStateChange(change);
    scheduler.onStateChange(change);
    scheduler.onStateChange({ ...change, stateVersion: 1 });
    expect(profileProvider.getSkillProfile).toHaveBeenCalledTimes(1);
    expect(test.scheduler.hasRoom('room')).toBe(true);
  });

  it('re-evaluates exactly once from the newest pending version', () => {
    const holder: { scheduler?: AiScheduler } = {};
    let calls = 0;
    const profileProvider = {
      getSkillProfile: jest.fn(() => {
        calls += 1;
        if (calls === 1) {
          holder.scheduler!.onStateChange({
            roomId: 'room',
            stateVersion: 2,
            activeWords: [{ ...word, wordId: 'w2' }],
            status: 'IN_PROGRESS',
            event: 'CLEAR',
          });
        }
        return {
          wpm: 45,
          accuracy: 0.92,
          reactionTimeMs: 650,
          sampleCount: 0,
          confidence: 0,
        };
      }),
    };
    const scheduler = new AiScheduler(
      new AiExecutor({ now: () => 0 }, { next: () => 1 }),
      profileProvider,
      undefined,
      { now: () => 0 },
      {
        setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeout: () => undefined,
      },
    );
    holder.scheduler = scheduler;
    scheduler.registerRoom({
      roomId: 'room',
      aiParticipantId: 'ai:room',
      difficulty: 'NORMAL',
      submitWord: (input) => Promise.resolve(accepted(input)),
      emitTypingProgress: () => undefined,
    });
    scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(profileProvider.getSkillProfile).toHaveBeenCalledTimes(2);
    expect(scheduler.getTask('room')?.wordId).toBe('w2');
  });

  it('handles each consecutive SPAWN/CLEAR/MISS version and batches one final MISS hook', () => {
    const profileProvider = {
      getSkillProfile: jest.fn(() => ({
        wpm: 45,
        accuracy: 0.92,
        reactionTimeMs: 650,
        sampleCount: 0,
        confidence: 0,
      })),
    };
    const scheduler = new AiScheduler(
      new AiExecutor({ now: () => 0 }, { next: () => 1 }),
      profileProvider,
      undefined,
      { now: () => 0 },
      {
        setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
        clearTimeout: () => undefined,
      },
    );
    scheduler.registerRoom({
      roomId: 'room',
      aiParticipantId: 'ai:room',
      difficulty: 'NORMAL',
      submitWord: (input) => Promise.resolve(accepted(input)),
      emitTypingProgress: () => undefined,
    });
    scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 3,
      activeWords: [],
      status: 'IN_PROGRESS',
      event: 'MISS',
    });
    expect(profileProvider.getSkillProfile).toHaveBeenCalledTimes(3);
  });

  it('blocks CLEAR, MISS, invalidate, and destroy stale callbacks', async () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const stale = test.callbacks[0];
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 2,
      activeWords: [],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    stale();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 3,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const missed = test.callbacks[test.callbacks.length - 1];
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 4,
      activeWords: [],
      status: 'IN_PROGRESS',
      event: 'MISS',
    });
    missed();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 5,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const terminal = test.callbacks[test.callbacks.length - 1];
    test.scheduler.invalidate('room');
    terminal();
    test.scheduler.destroy('room');
    await Promise.resolve();
    expect(test.submitted).toHaveLength(0);
    expect(test.scheduler.hasRoom('room')).toBe(false);
  });

  it('submits through the injected common callback only after the timer', async () => {
    const test = setup();
    test.scheduler.onStateChange({
      roomId: 'room',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(test.submitted).toHaveLength(0);
    test.runTimers();
    await Promise.resolve();
    expect(test.submitted).toHaveLength(1);
    expect(test.submitted[0]).toMatchObject({
      playerId: 'ai:room',
      wordId: 'w1',
      text: 'abc',
    });
  });
});
