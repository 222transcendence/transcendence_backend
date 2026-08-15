import { GameService } from './game.service';

describe('GameService public room lifecycle', () => {
  let service: GameService;
  let redisStore: Record<string, string>;
  let userRepository: {
    findOneBy: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(() => {
    redisStore = {};
    const redisService = {
      set: jest.fn((key: string, value: string) => {
        redisStore[key] = value;
        return Promise.resolve();
      }),
      get: jest.fn((key: string) => Promise.resolve(redisStore[key] ?? null)),
      del: jest.fn((key: string) => {
        delete redisStore[key];
        return Promise.resolve();
      }),
      getClient: jest.fn(() => ({
        keys: jest.fn((pattern: string) => {
          const prefix = pattern.replace('*', '');
          return Promise.resolve(
            Object.keys(redisStore).filter((key) => key.startsWith(prefix)),
          );
        }),
        del: jest.fn((...keys: string[]) => {
          keys.forEach((key) => delete redisStore[key]);
          return Promise.resolve();
        }),
      })),
    };
    userRepository = {
      findOneBy: jest.fn(({ id }: { id: string }) =>
        Promise.resolve({ id, nickname: id, avatar: null }),
      ),
      update: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
    service = new GameService(
      userRepository as never,
      {} as never,
      {} as never,
      redisService as never,
    );
  });

  it('does not expose AI practice keys in the public waiting room list', async () => {
    redisStore['game:ai-practice:room:practice-1'] = JSON.stringify({
      mode: 'AI_PRACTICE',
      roomId: 'practice-1',
    });
    const publicRoom = await service.createRoom('user-1', 'host', 2);

    await expect(service.getWaitingRooms()).resolves.toEqual([publicRoom]);
  });

  it('keeps existing CREATE_ROOM/JOIN_ROOM/LEAVE_ROOM/SET_READY flow working', async () => {
    const room = await service.createRoom('user-1', 'host', 2);

    expect(room.players).toHaveLength(1);
    const joined = await service.joinRoom(room.id, 'user-2', 'guest');
    expect(joined.players).toHaveLength(2);
    const ready = await service.setReady(room.id, 'user-1', true);
    expect(
      ready.players.find((player) => player.userId === 'user-1')?.ready,
    ).toBe(true);
    const left = await service.leaveRoom(room.id, 'user-2');
    expect(left?.players).toHaveLength(1);
  });

  describe('startGame (#153)', () => {
    it('transitions the room to IN_GAME and persists it', async () => {
      const room = await service.createRoom('user-1', 'host', 2);
      await service.joinRoom(room.id, 'user-2', 'guest');

      const started = await service.startGame(room.id);

      expect(started.status).toBe('IN_GAME');
      await expect(service.getRoom(room.id)).resolves.toEqual(
        expect.objectContaining({ status: 'IN_GAME' }),
      );
    });

    it('removes the room from getWaitingRooms and surfaces it via getSpectatableRooms', async () => {
      const room = await service.createRoom('user-1', 'host', 2);
      await service.joinRoom(room.id, 'user-2', 'guest');
      await service.startGame(room.id);

      await expect(service.getWaitingRooms()).resolves.toEqual([]);
      await expect(service.getSpectatableRooms()).resolves.toEqual([
        expect.objectContaining({ id: room.id, status: 'IN_GAME' }),
      ]);
    });

    it('throws NotFoundException for a room that does not exist', async () => {
      await expect(service.startGame('missing-room')).rejects.toThrow(
        'Game room not found',
      );
    });
  });

  describe('joinRoom eviction from other WAITING rooms (#183)', () => {
    it('evicts the user from a different WAITING room when joining a new one', async () => {
      const roomA = await service.createRoom('user-1', 'host', 4);
      await service.joinRoom(roomA.id, 'user-2', 'guest');
      const roomB = await service.createRoom('user-3', 'other-host', 4);

      const joined = await service.joinRoom(roomB.id, 'user-2', 'guest');

      expect(joined.players.map((p) => p.userId)).toContain('user-2');
      const updatedRoomA = await service.getRoom(roomA.id);
      expect(updatedRoomA?.players.some((p) => p.userId === 'user-2')).toBe(
        false,
      );
    });

    it('does not evict the user from a room that already transitioned to IN_GAME', async () => {
      const roomA = await service.createRoom('user-1', 'host', 2);
      await service.joinRoom(roomA.id, 'user-2', 'guest');
      await service.startGame(roomA.id);
      const roomB = await service.createRoom('user-3', 'other-host', 4);

      await service.joinRoom(roomB.id, 'user-2', 'guest');

      const stillInRoomA = await service.getRoom(roomA.id);
      expect(stillInRoomA?.players.some((p) => p.userId === 'user-2')).toBe(
        true,
      );
    });

    it('deletes the other WAITING room entirely if the evicted user was its only player', async () => {
      const roomA = await service.createRoom('user-2', 'host', 4);
      const roomB = await service.createRoom('user-3', 'other-host', 4);

      await service.joinRoom(roomB.id, 'user-2', 'guest');

      await expect(service.getRoom(roomA.id)).resolves.toBeNull();
    });

    it('findWaitingRoomsForUser excludes the given excludeRoomId even when the user is a member there', async () => {
      const roomA = await service.createRoom('user-1', 'host', 4);

      const found = await service.findWaitingRoomsForUser('user-1', roomA.id);

      expect(found).toEqual([]);
    });
  });
});
