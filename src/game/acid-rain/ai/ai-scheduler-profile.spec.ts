import { AiExecutor } from './ai-executor';
import { AiScheduler } from './ai-scheduler';
import { Logger } from '@nestjs/common';
import type {
  AiExecutionProfileFactory,
  AiProfileProvider,
} from './ai-execution-profile';
import type { Clock, Timer } from './ai-execution.types';
import {
  DEFAULT_PLAYER_SKILL,
  type PlayerSkillProfile,
} from '../../player-model';

const word = {
  wordId: 'word-1',
  text: 'abc',
  keystrokes: 3,
  landAtMs: 10_000,
  damage: 2,
};

function createScheduler(
  profileProvider: AiProfileProvider,
  profileFactory: AiExecutionProfileFactory,
) {
  let now = 0;
  const clock: Clock = { now: () => now };
  const clearTimeout = jest.fn();
  const timer: Timer = {
    setTimeout: jest.fn(() => 1 as unknown as ReturnType<typeof setTimeout>),
    clearTimeout,
  };
  const scheduler = new AiScheduler(
    new AiExecutor(clock, { next: () => 1 }),
    profileProvider,
    profileFactory,
    clock,
    timer,
  );
  return {
    scheduler,
    timer,
    clearTimeout,
    setNow: (value: number) => (now = value),
  };
}

function registration(modelPlayerId: string) {
  return {
    roomId: 'room-1',
    aiParticipantId: 'ai:room-1',
    modelPlayerId,
    difficulty: 'NORMAL' as const,
    submitWord: jest.fn().mockResolvedValue({ accepted: false }),
    emitTypingProgress: jest.fn(),
  };
}

function executionProfile() {
  return {
    typingWpm: 45,
    accuracy: 0.92,
    reactionDelayMs: 650,
  };
}

describe('AiScheduler profile preload snapshot', () => {
  it('loads once, uses default before completion, then uses the snapshot on the next evaluation', async () => {
    let resolveProfile!: (profile: PlayerSkillProfile) => void;
    const profile = { ...DEFAULT_PLAYER_SKILL, wpm: 90 };
    const loadSkillProfile = jest.fn(
      () =>
        new Promise<PlayerSkillProfile>(
          (resolve) => (resolveProfile = resolve),
        ),
    );
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const createdSkills: PlayerSkillProfile[] = [];
    const profileFactory: AiExecutionProfileFactory = {
      create: jest.fn((skill) => {
        createdSkills.push(skill);
        return executionProfile();
      }),
    };
    const { scheduler } = createScheduler(profileProvider, profileFactory);

    scheduler.registerRoom(registration('human-1'));
    scheduler.registerRoom(registration('human-1'));
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(createdSkills[0]).toEqual(DEFAULT_PLAYER_SKILL);
    expect(loadSkillProfile).toHaveBeenCalledTimes(1);
    expect(loadSkillProfile).toHaveBeenCalledWith({
      roomId: 'room-1',
      aiParticipantId: 'ai:room-1',
      modelPlayerId: 'human-1',
      difficulty: 'NORMAL',
    });

    resolveProfile(profile);
    await Promise.resolve();
    expect(createdSkills).toHaveLength(1);
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    expect(createdSkills.at(-1)).toEqual(profile);
    expect(loadSkillProfile).toHaveBeenCalledTimes(1);
  });

  it('keeps the active task and timer stable when preload completes', async () => {
    let resolveProfile!: (profile: PlayerSkillProfile) => void;
    const loadSkillProfile = jest.fn(
      () =>
        new Promise<PlayerSkillProfile>(
          (resolve) => (resolveProfile = resolve),
        ),
    );
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const profileFactory: AiExecutionProfileFactory = {
      create: jest.fn(() => executionProfile()),
    };
    const { scheduler, timer, clearTimeout } = createScheduler(
      profileProvider,
      profileFactory,
    );

    scheduler.registerRoom(registration('human-1'));
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    const taskBefore = scheduler.getTask('room-1');
    const timersBefore = (timer.setTimeout as jest.Mock).mock.calls.length;
    resolveProfile({ ...DEFAULT_PLAYER_SKILL, wpm: 80 });
    await Promise.resolve();

    expect(scheduler.getTask('room-1')).toBe(taskBefore);
    expect((timer.setTimeout as jest.Mock).mock.calls.length).toBe(
      timersBefore,
    );
    expect(clearTimeout).not.toHaveBeenCalled();
  });

  it('keeps the room active with default profile after a DB error without retrying', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const loadSkillProfile = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'));
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const createdSkills: PlayerSkillProfile[] = [];
    const profileFactory: AiExecutionProfileFactory = {
      create: jest.fn((skill) => {
        createdSkills.push(skill);
        return executionProfile();
      }),
    };
    const { scheduler } = createScheduler(profileProvider, profileFactory);

    scheduler.registerRoom(registration('human-1'));
    await Promise.resolve();
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(scheduler.hasRoom('room-1')).toBe(true);
    expect(createdSkills[0]).toEqual(DEFAULT_PLAYER_SKILL);
    expect(loadSkillProfile).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('room=room-1 modelPlayerId=human-1'),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('database unavailable'),
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('partialText'),
    );
    errorSpy.mockRestore();
  });

  it('keeps the default profile and logs a distinct model error', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const loadSkillProfile = jest
      .fn()
      .mockRejectedValue(
        new Error(
          'AI profile model calculation failed: invalid model configuration',
        ),
      );
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const createdSkills: PlayerSkillProfile[] = [];
    const profileFactory: AiExecutionProfileFactory = {
      create: jest.fn((skill) => {
        createdSkills.push(skill);
        return executionProfile();
      }),
    };
    const { scheduler } = createScheduler(profileProvider, profileFactory);

    scheduler.registerRoom(registration('human-1'));
    await Promise.resolve();
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(scheduler.hasRoom('room-1')).toBe(true);
    expect(createdSkills[0]).toEqual(DEFAULT_PLAYER_SKILL);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('AI profile model calculation failed'),
    );
    errorSpy.mockRestore();
  });

  it('does not apply a stale result after destroy and same-room replacement', async () => {
    const resolvers: Array<(profile: PlayerSkillProfile) => void> = [];
    const loadSkillProfile = jest.fn(
      () =>
        new Promise<PlayerSkillProfile>((resolve) => resolvers.push(resolve)),
    );
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const createdSkills: PlayerSkillProfile[] = [];
    const profileFactory: AiExecutionProfileFactory = {
      create: jest.fn((skill) => {
        createdSkills.push(skill);
        return executionProfile();
      }),
    };
    const { scheduler } = createScheduler(profileProvider, profileFactory);

    scheduler.registerRoom(registration('old-human'));
    scheduler.destroy('room-1');
    scheduler.registerRoom(registration('new-human'));
    resolvers[0]({ ...DEFAULT_PLAYER_SKILL, wpm: 140 });
    await Promise.resolve();
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(createdSkills.at(-1)).toEqual(DEFAULT_PLAYER_SKILL);

    resolvers[1]({ ...DEFAULT_PLAYER_SKILL, wpm: 80 });
    await Promise.resolve();
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 2,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'CLEAR',
    });
    expect(createdSkills.at(-1)?.wpm).toBe(80);
    expect(loadSkillProfile).toHaveBeenCalledTimes(2);
  });

  it('does not apply a preload result after invalidate', async () => {
    let resolveProfile!: (profile: PlayerSkillProfile) => void;
    const loadSkillProfile = jest.fn(
      () =>
        new Promise<PlayerSkillProfile>(
          (resolve) => (resolveProfile = resolve),
        ),
    );
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const create = jest.fn(() => executionProfile());
    const { scheduler } = createScheduler(profileProvider, { create });

    scheduler.registerRoom(registration('human-1'));
    scheduler.invalidate('room-1');
    resolveProfile({ ...DEFAULT_PLAYER_SKILL, wpm: 120 });
    await Promise.resolve();
    scheduler.onStateChange({
      roomId: 'room-1',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('isolates profiles when two rooms resolve in reverse order', async () => {
    const resolvers: Array<(profile: PlayerSkillProfile) => void> = [];
    const loadSkillProfile = jest.fn(
      () =>
        new Promise<PlayerSkillProfile>((resolve) => resolvers.push(resolve)),
    );
    const profileProvider: AiProfileProvider = {
      getSkillProfile: jest.fn(() => ({ ...DEFAULT_PLAYER_SKILL })),
      loadSkillProfile,
    };
    const skills: PlayerSkillProfile[] = [];
    const profileFactory: AiExecutionProfileFactory = {
      create: jest.fn((skill) => {
        skills.push(skill);
        return executionProfile();
      }),
    };
    const { scheduler } = createScheduler(profileProvider, profileFactory);

    scheduler.registerRoom({ ...registration('human-a'), roomId: 'room-a' });
    scheduler.registerRoom({ ...registration('human-b'), roomId: 'room-b' });
    resolvers[1]({ ...DEFAULT_PLAYER_SKILL, wpm: 80 });
    resolvers[0]({ ...DEFAULT_PLAYER_SKILL, wpm: 70 });
    await Promise.resolve();
    scheduler.onStateChange({
      roomId: 'room-a',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    scheduler.onStateChange({
      roomId: 'room-b',
      stateVersion: 1,
      activeWords: [word],
      status: 'IN_PROGRESS',
      event: 'SPAWN',
    });
    expect(skills.at(-2)?.wpm).toBe(70);
    expect(skills.at(-1)?.wpm).toBe(80);
  });
});
