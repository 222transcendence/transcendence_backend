import { PlayerPerformanceProfileProvider } from './player-performance-profile-provider';
import type { PlayerPerformanceSample } from '../../player-model';
import * as playerModel from '../../player-model';

describe('PlayerPerformanceProfileProvider', () => {
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
      wpm: 56,
      accuracy: 0.896,
      reactionTimeMs: 720,
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
      wpm: 45,
      accuracy: 0.92,
      reactionTimeMs: 650,
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
