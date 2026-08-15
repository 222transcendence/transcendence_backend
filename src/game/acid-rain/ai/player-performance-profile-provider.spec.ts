import { PlayerPerformanceProfileProvider } from './player-performance-profile-provider';
import type { PlayerPerformanceSample } from '../../player-model';
import * as playerModel from '../../player-model';

describe('PlayerPerformanceProfileProvider', () => {
  const context = {
    roomId: 'room-1',
    aiParticipantId: 'ai:room-1',
    modelPlayerId: 'user-1',
    difficulty: 'NORMAL' as const,
  };

  it('keeps runtime lookup independent from the #167 allowlist and labels one sample BLENDED', async () => {
    const source = {
      getRecentBehavior: jest.fn().mockResolvedValue({
        performanceSamples: [{ wpm: 100, accuracy: 0.8, reactionTimeMs: 1000 }],
        typoProbability: null,
        correctionDelayMs: null,
        abandonProbability: null,
        wordLengthPerformance: {
          short: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          medium: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          long: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
        },
        observationCounts: {
          typo: 0,
          correction: 0,
          abandon: 0,
          wordLength: 0,
        },
      }),
    };
    const provider = new PlayerPerformanceProfileProvider(source as never);
    await expect(provider.loadProfile(context)).resolves.toMatchObject({
      source: 'BLENDED',
      sampleCount: 1,
      typoProbability: { value: null, confidence: 0, available: false },
    });
    expect(source.getRecentBehavior).toHaveBeenCalledWith('user-1', 20);
  });

  it('uses PERSONALIZED only after the versioned core threshold', async () => {
    const source = {
      getRecentBehavior: jest.fn().mockResolvedValue({
        performanceSamples: Array.from({ length: 10 }, () => ({
          wpm: 100,
          accuracy: 0.8,
          reactionTimeMs: 1000,
        })),
        typoProbability: null,
        correctionDelayMs: null,
        abandonProbability: 0,
        wordLengthPerformance: {
          short: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          medium: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          long: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
        },
        observationCounts: {
          typo: 0,
          correction: 0,
          abandon: 5,
          wordLength: 0,
        },
      }),
    };
    const provider = new PlayerPerformanceProfileProvider(source as never);

    await expect(provider.loadProfile(context)).resolves.toMatchObject({
      source: 'PERSONALIZED',
      abandonProbability: { value: 0, available: true },
    });
  });

  it.each([
    [0, 'DEFAULT'],
    [1, 'BLENDED'],
    [9, 'BLENDED'],
    [10, 'PERSONALIZED'],
  ])('classifies %i complete core samples as %s', async (count, expected) => {
    const source = {
      getRecentBehavior: jest.fn().mockResolvedValue({
        performanceSamples: Array.from({ length: count }, () => ({
          wpm: 100,
          accuracy: 0.8,
          reactionTimeMs: 1000,
        })),
        typoProbability: null,
        correctionDelayMs: null,
        abandonProbability: null,
        wordLengthPerformance: {
          short: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          medium: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          long: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
        },
        observationCounts: {
          typo: 0,
          correction: 0,
          abandon: 0,
          wordLength: 0,
        },
      }),
    };
    const provider = new PlayerPerformanceProfileProvider(source as never);

    await expect(provider.loadProfile(context)).resolves.toMatchObject({
      source: expected,
      confidence: Number((count / (count + 4)).toFixed(4)),
    });
  });

  it('keeps missing behavior metrics unavailable while core source remains personalized', async () => {
    const source = {
      getRecentBehavior: jest.fn().mockResolvedValue({
        performanceSamples: Array.from({ length: 10 }, () => ({
          wpm: 100,
          accuracy: 0.8,
          reactionTimeMs: 1000,
        })),
        typoProbability: null,
        correctionDelayMs: null,
        abandonProbability: null,
        wordLengthPerformance: {
          short: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          medium: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
          long: {
            value: null,
            sampleCount: 0,
            confidence: 0,
            available: false,
          },
        },
        observationCounts: {
          typo: 0,
          correction: 0,
          abandon: 0,
          wordLength: 0,
        },
      }),
    };
    const provider = new PlayerPerformanceProfileProvider(source as never);
    const profile = await provider.loadProfile(context);

    expect(profile.source).toBe('PERSONALIZED');
    expect(profile.typoProbability).toEqual({
      value: null,
      sampleCount: 0,
      confidence: 0,
      available: false,
    });
    expect(profile.correctionDelayMs.available).toBe(false);
    expect(profile.abandonProbability.available).toBe(false);
  });

  it('returns a safe DEFAULT profile for a missing user or source failure', async () => {
    const source = {
      getRecentBehavior: jest
        .fn()
        .mockRejectedValue(new Error('db unavailable')),
    };
    const provider = new PlayerPerformanceProfileProvider(source as never);

    await expect(
      provider.loadProfile({ ...context, modelPlayerId: '' }),
    ).resolves.toMatchObject({ source: 'DEFAULT', sampleCount: 0 });
    await expect(provider.loadProfile(context)).resolves.toMatchObject({
      source: 'DEFAULT',
      sampleCount: 0,
    });
  });

  it('loads samples for the model player and delegates calculation to #100', async () => {
    const samples: PlayerPerformanceSample[] = [
      { wpm: 100, accuracy: 0.8, reactionTimeMs: 1000 },
    ];
    const source = {
      getRecentPerformance: jest.fn().mockResolvedValue(samples),
    };
    const provider = new PlayerPerformanceProfileProvider(source as never);

    await expect(
      provider.loadSkillProfile({
        roomId: 'room-1',
        aiParticipantId: 'ai:room-1',
        modelPlayerId: 'user-1',
        difficulty: 'NORMAL',
      }),
    ).resolves.toEqual({
      wpm: 118,
      accuracy: 0.88,
      reactionTimeMs: 1203,
      sampleCount: 1,
      confidence: 0.2,
    });
    expect(source.getRecentPerformance).toHaveBeenCalledWith('user-1');
  });

  it('propagates source and model errors to the scheduler preload boundary', async () => {
    const provider = new PlayerPerformanceProfileProvider({
      getRecentPerformance: jest
        .fn()
        .mockRejectedValue(new Error('database unavailable')),
    } as never);

    await expect(
      provider.loadSkillProfile({
        roomId: 'room-1',
        aiParticipantId: 'ai:room-1',
        modelPlayerId: 'user-1',
        difficulty: 'NORMAL',
      }),
    ).rejects.toThrow('database unavailable');
  });

  it('turns an empty source result into the default player skill profile', async () => {
    const provider = new PlayerPerformanceProfileProvider({
      getRecentPerformance: jest.fn().mockResolvedValue([]),
    } as never);

    await expect(
      provider.loadSkillProfile({
        roomId: 'room-1',
        aiParticipantId: 'ai:room-1',
        modelPlayerId: 'new-user',
        difficulty: 'NORMAL',
      }),
    ).resolves.toEqual({
      ...playerModel.DEFAULT_PLAYER_SKILL,
      sampleCount: 0,
      confidence: 0,
    });
  });

  it('labels buildPlayerSkillProfile errors separately from source errors', async () => {
    const buildSpy = jest
      .spyOn(playerModel, 'buildPlayerSkillProfile')
      .mockImplementation(() => {
        throw new Error('invalid model configuration');
      });
    const provider = new PlayerPerformanceProfileProvider({
      getRecentPerformance: jest.fn().mockResolvedValue([]),
    } as never);

    await expect(
      provider.loadSkillProfile({
        roomId: 'room-1',
        aiParticipantId: 'ai:room-1',
        modelPlayerId: 'user-1',
        difficulty: 'NORMAL',
      }),
    ).rejects.toThrow('AI profile model calculation failed');
    buildSpy.mockRestore();
  });
});
