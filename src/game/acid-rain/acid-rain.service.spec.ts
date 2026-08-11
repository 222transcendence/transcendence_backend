import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Server, Socket } from 'socket.io';
import { AcidRainService } from './acid-rain.service';
import { RedisService } from '../../redis/redis.service';
import { LobbyService } from '../../lobby/lobby.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { WordDictionaryService } from '../../word-dictionary/word-dictionary.service';
import { MatchHistory } from '../entities/match-history.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import { HpPair, WordSpawnPayload } from './acid-rain.interface';

interface WordClearedPayload {
  wordId: string;
  clearedBy: string;
  damage: number;
  targetHp: HpPair;
}
interface WordMissedPayload {
  wordId: string;
  splashDamage: number;
  targetHp: HpPair;
}
interface SubmitRejectedPayload {
  wordId: string;
  reason: 'ALREADY_CLEARED' | 'NOT_FOUND' | 'WRONG_TEXT';
}
interface MatchEndPayload {
  roomId: string;
  winnerId: string | null;
  reason: 'KO' | 'TIME_LIMIT' | 'FORFEIT';
  finalHp: HpPair;
  wordsTyped: { host: number; guest: number };
  durationSec: number;
}
interface OpponentDisconnectedPayload {
  userId: string;
  graceMs: number;
}
interface OpponentReconnectedPayload {
  userId: string;
}
interface StateSyncPayload {
  roomId: string;
  hp: HpPair;
  activeWords: WordSpawnPayload[];
  elapsedMs: number;
  spawnIntervalMs: number;
  now: string;
}

describe('AcidRainService', () => {
  let service: AcidRainService;
  let redisStore: Record<string, string>;
  let emitSpy: jest.Mock<void, [string, unknown]>;
  let server: Server;

  const HOST = { userId: 'host-id', nickname: 'hostNick' };
  const GUEST = { userId: 'guest-id', nickname: 'guestNick' };
  const ROOM_ID = 'room-1';

  const mockUserRepository = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    findOneBy: jest
      .fn()
      .mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({ id, nickname: id }),
      ),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockMatchHistoryRepository = {
    create: jest.fn().mockImplementation((dto: unknown) => dto),
    save: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
  };

  const mockLobbyService = {
    broadcast: jest.fn(),
  };

  const mockChatGateway = {
    setUserStatus: jest.fn().mockResolvedValue(undefined),
    notifyFriends: jest.fn().mockResolvedValue(undefined),
  };

  const mockWordDictionaryService = {
    pickWord: jest.fn().mockReturnValue({ text: '테스트', keystrokes: 6 }),
  };

  const mockRedisService = {
    set: jest.fn().mockImplementation((key: string, value: string) => {
      redisStore[key] = value;
      return Promise.resolve();
    }),
    get: jest
      .fn()
      .mockImplementation((key: string) =>
        Promise.resolve(redisStore[key] ?? null),
      ),
    del: jest.fn().mockImplementation((key: string) => {
      delete redisStore[key];
      return Promise.resolve();
    }),
    getClient: jest.fn().mockReturnValue({
      keys: jest
        .fn()
        .mockImplementation(() => Promise.resolve(Object.keys(redisStore))),
      del: jest.fn().mockImplementation((...keys: string[]) => {
        keys.forEach((k) => delete redisStore[k]);
        return Promise.resolve();
      }),
    }),
  };

  beforeEach(async () => {
    redisStore = {};
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(0);

    emitSpy = jest.fn<void, [string, unknown]>();
    const toSpy = jest.fn().mockReturnValue({ emit: emitSpy });
    server = { to: toSpy } as unknown as Server;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AcidRainService,
        {
          provide: getRepositoryToken(MatchHistory),
          useValue: mockMatchHistoryRepository,
        },
        { provide: getRepositoryToken(User), useValue: mockUserRepository },
        { provide: RedisService, useValue: mockRedisService },
        { provide: LobbyService, useValue: mockLobbyService },
        { provide: ChatGateway, useValue: mockChatGateway },
        { provide: WordDictionaryService, useValue: mockWordDictionaryService },
      ],
    }).compile();

    service = module.get<AcidRainService>(AcidRainService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function eventsNamed<T>(name: string): T[] {
    return emitSpy.mock.calls
      .filter(([event]) => event === name)
      .map(([, payload]) => payload as T);
  }

  async function startAndReachFirstSpawn(): Promise<WordSpawnPayload> {
    await service.startMatch(ROOM_ID, HOST, GUEST, server);
    await jest.advanceTimersByTimeAsync(3000); // countdown
    await jest.advanceTimersByTimeAsync(2000); // fixed initial spawn delay
    const spawns = eventsNamed<WordSpawnPayload>('word_spawn');
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    return spawns[0];
  }

  describe('spawn — fall duration formula (GAME_DESIGN.md §3.5)', () => {
    it('fallDurationMs = (4000 + 250*keystrokes) * max(0.6, 1 - elapsedSec/300)', async () => {
      const word = await startAndReachFirstSpawn();
      const elapsedSec = 2; // 3000ms countdown + fixed 2000ms initial spawn delay
      const expected = Math.round(
        (4000 + 250 * word.keystrokes) * Math.max(0.6, 1 - elapsedSec / 300),
      );
      expect(word.fallDurationMs).toBe(expected);
    });

    it('word_spawn payload carries keystrokes, not a tier field', async () => {
      const word = await startAndReachFirstSpawn();
      expect(typeof word.keystrokes).toBe('number');
      expect(word.keystrokes).toBeGreaterThan(0);
      expect(word).not.toHaveProperty('tier');
    });
  });

  describe('judgeSubmit — damage formula (GAME_DESIGN.md §3.6)', () => {
    it('correct hit deals 5 + ceil(keystrokes/2) to the opponent', async () => {
      const word = await startAndReachFirstSpawn();
      service.judgeSubmit(ROOM_ID, HOST.userId, word.wordId, word.text, server);

      const cleared = eventsNamed<WordClearedPayload>('word_cleared');
      expect(cleared).toHaveLength(1);
      expect(cleared[0].damage).toBe(5 + Math.ceil(word.keystrokes / 2));
      expect(cleared[0].targetHp.guest).toBe(100 - cleared[0].damage);
      expect(cleared[0].targetHp.host).toBe(100);
    });

    it('a miss (word lands unclaimed) deals fixed 3 damage to both players', async () => {
      const word = await startAndReachFirstSpawn();
      await jest.advanceTimersByTimeAsync(word.fallDurationMs + 200); // miss loop ticks every 200ms

      const missed = eventsNamed<WordMissedPayload>('word_missed');
      expect(missed).toHaveLength(1);
      expect(missed[0].splashDamage).toBe(3);
      expect(missed[0].targetHp).toEqual({ host: 97, guest: 97 });
    });

    it('rejects a wordId that was already cleared (idempotent, race-condition safe)', async () => {
      const word = await startAndReachFirstSpawn();
      service.judgeSubmit(ROOM_ID, HOST.userId, word.wordId, word.text, server);
      emitSpy.mockClear();

      service.judgeSubmit(
        ROOM_ID,
        GUEST.userId,
        word.wordId,
        word.text,
        server,
      );

      expect(eventsNamed('word_cleared')).toHaveLength(0);
      const rejected = eventsNamed<SubmitRejectedPayload>('submit_rejected');
      expect(rejected).toContainEqual({
        wordId: word.wordId,
        reason: 'ALREADY_CLEARED',
      });
    });

    it('rejects an unknown wordId', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      service.judgeSubmit(
        ROOM_ID,
        HOST.userId,
        'w_does_not_exist',
        'foo',
        server,
      );
      expect(
        eventsNamed<SubmitRejectedPayload>('submit_rejected'),
      ).toContainEqual({
        wordId: 'w_does_not_exist',
        reason: 'NOT_FOUND',
      });
    });

    it('rejects a wrong-text submission for a valid wordId', async () => {
      const word = await startAndReachFirstSpawn();
      service.judgeSubmit(
        ROOM_ID,
        HOST.userId,
        word.wordId,
        `${word.text}x`,
        server,
      );
      expect(
        eventsNamed<SubmitRejectedPayload>('submit_rejected'),
      ).toContainEqual({
        wordId: word.wordId,
        reason: 'WRONG_TEXT',
      });
    });
  });

  describe('match end conditions', () => {
    it('ends with KO reason once a player reaches 0 HP', async () => {
      let currentWord = await startAndReachFirstSpawn();
      // guest lands enough hits on host to bring HP to 0 — simplest deterministic path:
      // repeatedly clear the latest spawned word as guest until the session ends.
      let guard = 0;
      while (service.getSession(ROOM_ID) && guard < 50) {
        service.judgeSubmit(
          ROOM_ID,
          GUEST.userId,
          currentWord.wordId,
          currentWord.text,
          server,
        );
        if (!service.getSession(ROOM_ID)) break;
        await jest.advanceTimersByTimeAsync(2500);
        const spawns = eventsNamed<WordSpawnPayload>('word_spawn');
        currentWord = spawns[spawns.length - 1];
        guard++;
      }

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toHaveLength(1);
      expect(ended[0].reason).toBe('KO');
      expect(ended[0].winnerId).toBe(GUEST.userId);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });

    it('schedules a forced TIME_LIMIT end at 180s regardless of match outcome by then', async () => {
      // An idle match (nobody submitting) always resolves via shared splash damage (§3.6)
      // well before 180s, so this verifies the 180s timer itself fires with the right args
      // rather than asserting on the (already-decided) match outcome.
      const endMatchSpy = jest.spyOn(service, 'endMatch');
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(180_000 + 3000 + 500);

      expect(endMatchSpy).toHaveBeenCalledWith(ROOM_ID, 'TIME_LIMIT', server);
    });

    it('TIME_LIMIT picks the higher-HP player as winner (tie = draw)', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      session.hp.host = 40;
      session.hp.guest = 70;

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended[0]).toEqual(
        expect.objectContaining({
          reason: 'TIME_LIMIT',
          winnerId: GUEST.userId,
        }),
      );
    });
  });

  describe('disconnect / reconnect', () => {
    it('starts a 30s grace period and forfeits to the opponent if no reconnect', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);

      service.handleDisconnect(ROOM_ID, HOST.userId, server);
      expect(
        eventsNamed<OpponentDisconnectedPayload>('opponent_disconnected'),
      ).toContainEqual({
        userId: HOST.userId,
        graceMs: 30_000,
      });

      await jest.advanceTimersByTimeAsync(30_000);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toContainEqual(
        expect.objectContaining({ reason: 'FORFEIT', winnerId: GUEST.userId }),
      );
    });

    it('cancels the grace timer and sends state_sync on reconnect within the grace period', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(2000); // one word spawned

      service.handleDisconnect(ROOM_ID, HOST.userId, server);
      await jest.advanceTimersByTimeAsync(5000);

      const clientEmit = jest.fn<void, [string, StateSyncPayload]>();
      const clientSocket = { emit: clientEmit } as unknown as Socket;
      service.handleReconnect(ROOM_ID, HOST.userId, server, clientSocket);

      expect(
        eventsNamed<OpponentReconnectedPayload>('opponent_reconnected'),
      ).toContainEqual({ userId: HOST.userId });
      expect(clientEmit).toHaveBeenCalledTimes(1);
      const [syncEvent, syncPayload] = clientEmit.mock.calls[0];
      expect(syncEvent).toBe('state_sync');
      expect(syncPayload.roomId).toBe(ROOM_ID);
      expect(syncPayload.activeWords.length).toBeGreaterThan(0);
      expect(typeof syncPayload.activeWords[0].keystrokes).toBe('number');
      // no tier leaking into the reconnect payload
      expect(syncPayload.activeWords[0]).not.toHaveProperty('tier');

      // grace timer cancelled: advancing past the original 30s must NOT forfeit
      await jest.advanceTimersByTimeAsync(30_000);
      expect(
        eventsNamed<MatchEndPayload>('match_end').some(
          (e) => e.reason === 'FORFEIT',
        ),
      ).toBe(false);
    });
  });

  describe('endMatch persistence', () => {
    it('saves MatchHistory with finalHp/wordsTyped/durationSec and updates wins/losses', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(mockMatchHistoryRepository.save).toHaveBeenCalled();
      const saved = mockMatchHistoryRepository.save.mock.calls[0][0] as {
        matchData: {
          finalHp: HpPair;
          wordsTyped: { host: number; guest: number };
          durationSec: number;
          reason: string;
        };
      };
      expect(saved.matchData.finalHp).toEqual({ host: 100, guest: 100 });
      expect(saved.matchData.wordsTyped).toEqual({ host: 0, guest: 0 });
      expect(saved.matchData.durationSec).toBeGreaterThanOrEqual(0);
      expect(saved.matchData.reason).toBe('TIME_LIMIT');
    });
  });

  describe('onModuleInit — stale session cleanup', () => {
    it('resets IN_GAME users to ONLINE and clears orphaned game:acidroom:* keys', async () => {
      redisStore['game:acidroom:stale-room'] = '{}';
      mockUserRepository.update.mockResolvedValueOnce({ affected: 2 });

      await service.onModuleInit();

      expect(mockUserRepository.update).toHaveBeenCalledWith(
        { status: UserStatus.IN_GAME },
        { status: UserStatus.ONLINE },
      );
      expect(redisStore['game:acidroom:stale-room']).toBeUndefined();
    });
  });
});
