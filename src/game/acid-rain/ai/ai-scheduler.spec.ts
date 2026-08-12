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
    targetHp: { host: 100, guest: 99 },
    gameEnded: false,
    winnerId: null,
    loserId: null,
    endReason: null,
    wordCleared: {
      wordId: input.wordId,
      clearedBy: input.playerId,
      damage: 1,
      hp: { ai: 100 },
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
  });
  return {
    scheduler,
    submitted,
    callbacks,
    delays,
    runTimers: () => callbacks.splice(0).forEach((callback) => callback()),
    setNow: (value: number) => (now = value),
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
    test.callbacks[1]();
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
