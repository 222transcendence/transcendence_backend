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
import {
  HpPair,
  HpByParticipantId,
  ParticipantPublic,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  JudgeWordSubmitRejected,
  WordSpawnPayload,
} from './acid-rain.interface';

function assertRejected(
  result: JudgeWordSubmitResult,
): asserts result is JudgeWordSubmitRejected {
  if (result.accepted) throw new Error('expected a rejected submit result');
}

interface WordClearedPayload {
  wordId: string;
  clearedBy: string;
  damage: number;
  targetParticipantId: string;
  hp: HpByParticipantId;
}
interface WordMissedPayload {
  wordId: string;
  splashDamage: number;
  hp: HpByParticipantId;
}
interface MatchEndPayload {
  roomId: string;
  winnerId: string | null;
  reason: 'KO' | 'TIME_LIMIT' | 'FORFEIT';
  finalHp: HpByParticipantId;
  ranking: { participantId: string; rank: number }[];
  wordsTyped: Record<string, number>;
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
  participants: Array<{
    participantId: string;
    userId?: string;
    nickname: string;
    type: 'HUMAN' | 'AI';
    hp: number;
  }>;
  hp: HpByParticipantId;
  activeWords: Array<WordSpawnPayload & { status: 'ACTIVE' }>;
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
    manager: {
      transaction: jest
        .fn()
        .mockImplementation(
          async (
            work: (manager: {
              getRepository: (target: unknown) => unknown;
            }) => Promise<unknown>,
          ) =>
            work({
              getRepository: (target: unknown) =>
                target === User
                  ? mockUserRepository
                  : mockMatchHistoryRepository,
            }),
        ),
    },
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
    mockUserRepository.update.mockResolvedValue({ affected: 0 });
    mockUserRepository.findOneBy.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve({ id, nickname: id }),
    );
    mockUserRepository.increment.mockResolvedValue({ affected: 1 });
    mockMatchHistoryRepository.create.mockImplementation((dto: unknown) => dto);
    mockMatchHistoryRepository.save.mockResolvedValue({});
    mockMatchHistoryRepository.manager.transaction.mockImplementation(
      async (
        work: (manager: {
          getRepository: (target: unknown) => unknown;
        }) => Promise<unknown>,
      ) =>
        work({
          getRepository: (target: unknown) =>
            target === User ? mockUserRepository : mockMatchHistoryRepository,
        }),
    );
    mockRedisService.set.mockImplementation((key: string, value: string) => {
      redisStore[key] = value;
      return Promise.resolve();
    });
    mockRedisService.get.mockImplementation((key: string) =>
      Promise.resolve(redisStore[key] ?? null),
    );
    mockRedisService.del.mockImplementation((key: string) => {
      delete redisStore[key];
      return Promise.resolve();
    });
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
    jest.clearAllTimers();
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

  async function submitWord(
    input: JudgeWordSubmitInput,
  ): Promise<JudgeWordSubmitResult> {
    return service.submitWord(input, server);
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

    it('word_spawn exposes landAt and damage for frontend and AI decision making', async () => {
      const word = await startAndReachFirstSpawn();

      expect(Date.parse(word.landAt)).toBeGreaterThan(
        Date.parse(word.spawnedAt),
      );
      expect(word.damage).toBe(5 + Math.ceil(word.keystrokes / 2));
      expect(word).not.toHaveProperty('status');
    });
  });

  describe('participant contract', () => {
    it('can represent an AI participant without a fake User row', () => {
      const aiParticipant: ParticipantPublic = {
        participantId: 'ai:room-1:normal',
        nickname: 'ACID BOT',
        type: 'AI',
        aiDifficulty: 'NORMAL',
      };

      expect(aiParticipant.userId).toBeUndefined();
      expect(aiParticipant.aiDifficulty).toBe('NORMAL');
    });
  });

  describe('submitWord — damage formula (GAME_DESIGN.md §3.6)', () => {
    it('accepts a correct socket-free judge request and returns broadcast data', async () => {
      const word = await startAndReachFirstSpawn();
      const input: JudgeWordSubmitInput = {
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'attempt-1',
      };

      const result = await submitWord(input);

      expect(result).toEqual(
        expect.objectContaining({
          accepted: true,
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: word.wordId,
          attemptId: 'attempt-1',
          wordStateBefore: 'ACTIVE',
          wordStateAfter: 'CLEARED',
          damage: 5 + Math.ceil(word.keystrokes / 2),
          gameEnded: false,
          winnerId: null,
          loserId: null,
        }),
      );
      if (result.accepted) {
        expect(result.wordCleared).toEqual({
          wordId: word.wordId,
          clearedBy: HOST.userId,
          damage: result.damage,
          targetParticipantId: GUEST.userId,
          hp: {
            [HOST.userId]: result.targetHp.host,
            [GUEST.userId]: result.targetHp.guest,
          },
        });
      }
    });

    it('correct hit deals 5 + ceil(keystrokes/2) to the opponent', async () => {
      const word = await startAndReachFirstSpawn();
      await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      const cleared = eventsNamed<WordClearedPayload>('word_cleared');
      expect(cleared).toHaveLength(1);
      expect(cleared[0].damage).toBe(5 + Math.ceil(word.keystrokes / 2));
      expect(cleared[0].targetParticipantId).toBe(GUEST.userId);
      expect(cleared[0].hp[GUEST.userId]).toBe(100 - cleared[0].damage);
      expect(cleared[0].hp[HOST.userId]).toBe(100);
    });

    it('marks a correct submission as ACTIVE to CLEARED', async () => {
      const word = await startAndReachFirstSpawn();

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(true);
      expect(result.wordStateBefore).toBe('ACTIVE');
      expect(result.wordStateAfter).toBe('CLEARED');
      expect(service.getSession(ROOM_ID)?.activeWords.has(word.wordId)).toBe(
        false,
      );
      expect(
        service.getSession(ROOM_ID)?.resolvedWords.get(word.wordId),
      ).toEqual({
        state: 'CLEARED',
        playerId: HOST.userId,
        attemptId: undefined,
      });
    });

    it('a miss (word lands unclaimed) deals fixed 3 damage to both players', async () => {
      const word = await startAndReachFirstSpawn();
      await jest.advanceTimersByTimeAsync(word.fallDurationMs + 200); // miss loop ticks every 200ms

      const missed = eventsNamed<WordMissedPayload>('word_missed');
      expect(missed).toHaveLength(1);
      expect(missed[0].splashDamage).toBe(3);
      expect(missed[0].hp).toEqual({
        [HOST.userId]: 97,
        [GUEST.userId]: 97,
      });
      expect(
        service.getSession(ROOM_ID)?.resolvedWords.get(word.wordId),
      ).toEqual({
        state: 'MISSED',
      });
    });

    it('returns KO metadata when a correct submission brings a player to 0 HP', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp.guest = 1;

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(true);
      expect(result.gameEnded).toBe(true);
      expect(result.endReason).toBe('KO');
      expect(result.winnerId).toBe(HOST.userId);
      expect(result.loserId).toBe(GUEST.userId);
      expect(result.targetHp).toEqual({ host: 100, guest: 0 });
    });

    it('rejects a wordId that was already cleared (idempotent, race-condition safe)', async () => {
      const word = await startAndReachFirstSpawn();
      await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });
      emitSpy.mockClear();

      const rejected = await submitWord({
        roomId: ROOM_ID,
        playerId: GUEST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(eventsNamed('word_cleared')).toHaveLength(0);
      expect(eventsNamed('submit_rejected')).toHaveLength(0);
      expect(rejected.accepted).toBe(false);
      assertRejected(rejected);
      expect(rejected.submitRejected).toEqual({
        wordId: word.wordId,
        reason: 'ALREADY_CLEARED',
      });
    });

    it('rejects a second direct judge call for the same cleared word without more damage', async () => {
      const word = await startAndReachFirstSpawn();
      const first = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });
      const hpAfterFirst = { ...service.getSession(ROOM_ID)!.hp };

      const second = await submitWord({
        roomId: ROOM_ID,
        playerId: GUEST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'late-ai-attempt',
      });

      expect(first.accepted).toBe(true);
      expect(second).toEqual(
        expect.objectContaining({
          accepted: false,
          reason: 'WORD_ALREADY_RESOLVED',
          wordStateBefore: 'CLEARED',
          wordStateAfter: 'CLEARED',
          damage: 0,
          gameEnded: false,
        }),
      );
      expect(service.getSession(ROOM_ID)?.hp).toEqual(hpAfterFirst);
    });

    it('rejects an unknown wordId', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w_does_not_exist',
        text: 'foo',
      });
      expect(eventsNamed('submit_rejected')).toHaveLength(0);
      expect(result.accepted).toBe(false);
      assertRejected(result);
      expect(result.submitRejected).toEqual({
        wordId: 'w_does_not_exist',
        reason: 'NOT_FOUND',
      });
    });

    it('rejects a missing room without mutating the input object', async () => {
      const input: JudgeWordSubmitInput = {
        roomId: 'missing-room',
        playerId: HOST.userId,
        wordId: 'w_missing',
        text: 'foo',
        attemptId: 'attempt-missing-room',
      };
      const snapshot = { ...input };

      const result = await submitWord(input);

      expect(result).toEqual(
        expect.objectContaining({
          accepted: false,
          reason: 'ROOM_NOT_FOUND',
          submitRejected: { wordId: 'w_missing', reason: 'NOT_FOUND' },
        }),
      );
      expect(input).toEqual(snapshot);
    });

    it('rejects a non-participant before applying any damage', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      const hpBefore = { ...session.hp };

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: 'intruder-id',
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(false);
      assertRejected(result);
      expect(result.reason).toBe('PLAYER_NOT_FOUND');
      expect(result.targetHp).toEqual(hpBefore);
      expect(session.activeWords.has(word.wordId)).toBe(true);
      expect(session.hp).toEqual(hpBefore);
    });

    it('rejects a wrong-text submission for a valid wordId', async () => {
      const word = await startAndReachFirstSpawn();
      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: `${word.text}x`,
      });
      expect(eventsNamed('submit_rejected')).toHaveLength(0);
      expect(result.accepted).toBe(false);
      assertRejected(result);
      expect(result.submitRejected).toEqual({
        wordId: word.wordId,
        reason: 'WRONG_TEXT',
      });
    });

    it('rejects a submission after the match is no longer active', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.status = 'FINISHED';

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'after-finished',
      });

      expect(result.accepted).toBe(false);
      assertRejected(result);
      expect(result.reason).toBe('GAME_NOT_ACTIVE');
      expect(result.submitRejected).toEqual({
        wordId: word.wordId,
        reason: 'NOT_FOUND',
      });
    });

    it('rejects incorrect text without changing word state, HP, or winner state', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      const hpBefore = { ...session.hp };

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: `${word.text}x`,
        attemptId: 'wrong-attempt',
      });

      expect(result).toEqual(
        expect.objectContaining({
          accepted: false,
          reason: 'INCORRECT_TEXT',
          wordStateBefore: 'ACTIVE',
          wordStateAfter: 'ACTIVE',
          damage: 0,
          gameEnded: false,
          winnerId: null,
          loserId: null,
        }),
      );
      expect(session.activeWords.has(word.wordId)).toBe(true);
      expect(session.resolvedWords.has(word.wordId)).toBe(false);
      expect(session.hp).toEqual(hpBefore);
    });

    it('rejects a submission for an already missed word', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      await jest.advanceTimersByTimeAsync(word.fallDurationMs + 200);
      const hpAfterMiss = { ...session.hp };

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(result).toEqual(
        expect.objectContaining({
          accepted: false,
          reason: 'WORD_ALREADY_RESOLVED',
          wordStateBefore: 'MISSED',
          wordStateAfter: 'MISSED',
          damage: 0,
        }),
      );
      expect(session.hp).toEqual(hpAfterMiss);
    });

    it('returns the first result for a duplicate attemptId without applying state twice', async () => {
      const word = await startAndReachFirstSpawn();
      const first = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'same-attempt',
      });
      const hpAfterFirst = { ...service.getSession(ROOM_ID)!.hp };

      const second = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'same-attempt',
      });

      expect(first.accepted).toBe(true);
      expect(second).toEqual(first);
      expect(service.getSession(ROOM_ID)?.hp).toEqual(hpAfterFirst);
    });

    it('does not let two players collide when they use the same attemptId', async () => {
      const word = await startAndReachFirstSpawn();
      const hostWrong = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: `${word.text}x`,
        attemptId: 'shared-attempt',
      });

      const guestCorrect = await submitWord({
        roomId: ROOM_ID,
        playerId: GUEST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'shared-attempt',
      });

      expect(hostWrong.accepted).toBe(false);
      expect(guestCorrect.accepted).toBe(true);
      expect(
        service.getSession(ROOM_ID)?.resolvedWords.get(word.wordId),
      ).toEqual({
        state: 'CLEARED',
        playerId: GUEST.userId,
        attemptId: 'shared-attempt',
      });
    });

    it('returns the original result when the same attemptId is replayed with different wordId and text', async () => {
      const word = await startAndReachFirstSpawn();

      const first = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: `${word.text}x`,
        attemptId: 'mutated-attempt',
      });
      const second = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w_other',
        text: 'other',
        attemptId: 'mutated-attempt',
      });

      expect(second).toEqual(first);
      expect(service.getSession(ROOM_ID)?.activeWords.has(word.wordId)).toBe(
        true,
      );
    });

    it('does not cache ROOM_NOT_FOUND attempt results', async () => {
      const missing = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w_missing',
        text: 'foo',
        attemptId: 'room-not-found-attempt',
      });
      expect(missing.accepted).toBe(false);
      assertRejected(missing);
      expect(missing.reason).toBe('ROOM_NOT_FOUND');

      const word = await startAndReachFirstSpawn();
      const accepted = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'room-not-found-attempt',
      });

      expect(accepted.accepted).toBe(true);
      expect(accepted.wordId).toBe(word.wordId);
    });

    it('expires attempt replay records after the TTL', async () => {
      const word = await startAndReachFirstSpawn();
      const first = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'ttl-attempt',
      });

      jest.setSystemTime(10 * 60 * 1000);
      const afterTtl = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'ttl-attempt',
      });

      expect(first.accepted).toBe(true);
      expect(afterTtl.accepted).toBe(false);
      assertRejected(afterTtl);
      expect(afterTtl.reason).toBe('WORD_ALREADY_RESOLVED');
    });

    it('uses the socket-free submitWord entry point while preserving broadcasts', async () => {
      const word = await startAndReachFirstSpawn();

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: GUEST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(true);
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(1);
    });

    it('awaits KO finalization through the socket-free submitWord entry point', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp.guest = 1;

      const result = await service.submitWord(
        {
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: word.wordId,
          text: word.text,
          attemptId: 'ko-attempt',
        },
        server,
      );

      expect(result.accepted).toBe(true);
      expect(result.gameEnded).toBe(true);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledWith('ROOM_CLOSED', {
        roomId: ROOM_ID,
      });
    });

    it('awaits delayed spawn persistence before deleting acidroom during KO finalization', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      mockRedisService.set.mockClear();
      mockRedisService.set.mockImplementation((key: string, value: string) => {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            redisStore[key] = value;
            resolve();
          }, 10);
        });
      });
      await jest.advanceTimersByTimeAsync(2000);
      const word = eventsNamed<WordSpawnPayload>('word_spawn')[0];
      const session = service.getSession(ROOM_ID)!;
      session.hp.guest = 1;

      const submitPromise = service.submitWord(
        {
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: word.wordId,
          text: word.text,
          attemptId: 'ko-no-stale-persist',
        },
        server,
      );
      await jest.advanceTimersByTimeAsync(10);
      await submitPromise;
      await jest.advanceTimersByTimeAsync(20);

      expect(mockRedisService.set).toHaveBeenCalledTimes(1);
      expect(redisStore[`game:acidroom:${ROOM_ID}`]).toBeUndefined();
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });

    it('cleans attempt records after successful match finalization', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp.guest = 1;

      await service.submitWord(
        {
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: word.wordId,
          text: word.text,
          attemptId: 'ko-replay',
        },
        server,
      );
      emitSpy.mockClear();
      jest.clearAllMocks();

      const replay = await service.submitWord(
        {
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: 'w_mutated',
          text: 'mutated',
          attemptId: 'ko-replay',
        },
        server,
      );

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(replay).toEqual(
        expect.objectContaining({
          accepted: false,
          reason: 'ROOM_NOT_FOUND',
          submitRejected: { wordId: 'w_mutated', reason: 'NOT_FOUND' },
        }),
      );
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(0);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      expect(mockMatchHistoryRepository.save).not.toHaveBeenCalled();
      expect(mockLobbyService.broadcast).not.toHaveBeenCalled();
    });

    it('retries only KO finalization after an endMatch failure on attempt replay', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp.guest = 1;
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });

      await expect(
        service.submitWord(
          {
            roomId: ROOM_ID,
            playerId: HOST.userId,
            wordId: word.wordId,
            text: word.text,
            attemptId: 'ko-failed-finalization',
          },
          server,
        ),
      ).rejects.toThrow('redis down');
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);

      emitSpy.mockClear();
      jest.clearAllMocks();
      const replay = await service.submitWord(
        {
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: word.wordId,
          text: word.text,
          attemptId: 'ko-failed-finalization',
        },
        server,
      );

      expect(replay.accepted).toBe(true);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(0);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);

      jest.clearAllMocks();
      const completedReplay = await service.submitWord(
        {
          roomId: ROOM_ID,
          playerId: HOST.userId,
          wordId: word.wordId,
          text: word.text,
          attemptId: 'ko-failed-finalization',
        },
        server,
      );
      expect(completedReplay).toEqual(
        expect.objectContaining({
          accepted: false,
          reason: 'ROOM_NOT_FOUND',
          submitRejected: { wordId: word.wordId, reason: 'NOT_FOUND' },
        }),
      );
      expect(mockMatchHistoryRepository.save).not.toHaveBeenCalled();
      expect(mockLobbyService.broadcast).not.toHaveBeenCalled();
    });

    it('automatically retries an attemptId-free KO finalization failure without repeating broadcasts', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp.guest = 1;
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });

      await expect(
        service.submitWord(
          {
            roomId: ROOM_ID,
            playerId: HOST.userId,
            wordId: word.wordId,
            text: word.text,
          },
          server,
        ),
      ).rejects.toThrow('redis down');
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
    });
  });

  describe('match end conditions', () => {
    it('ends with KO reason once a player reaches 0 HP', async () => {
      let currentWord = await startAndReachFirstSpawn();
      // guest lands enough hits on host to bring HP to 0 — simplest deterministic path:
      // repeatedly clear the latest spawned word as guest until the session ends.
      let guard = 0;
      while (service.getSession(ROOM_ID) && guard < 50) {
        await submitWord({
          roomId: ROOM_ID,
          playerId: GUEST.userId,
          wordId: currentWord.wordId,
          text: currentWord.text,
        });
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
      const endMatchSpy = jest.spyOn(service, 'endMatch');
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
      await jest.advanceTimersByTimeAsync(180_000);

      expect(endMatchSpy).toHaveBeenCalledWith(
        ROOM_ID,
        'TIME_LIMIT',
        server,
        undefined,
      );
    });

    it('catches TIME_LIMIT finalization failure and retries without repeating match_end', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });
      emitSpy.mockClear();

      await jest.advanceTimersByTimeAsync(180_000);
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockRedisService.del).toHaveBeenCalledTimes(2);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
    });

    it('retries miss KO finalization failure without repeating match_end', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      session.hp.host = 3;
      session.hp.guest = 50;
      const activeWord = session.activeWords.get(word.wordId)!;
      activeWord.landAt = Date.now();
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });
      emitSpy.mockClear();

      await jest.advanceTimersByTimeAsync(200);
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(eventsNamed<WordMissedPayload>('word_missed')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')).toEqual([
        expect.objectContaining({ reason: 'KO', winnerId: GUEST.userId }),
      ]);

      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
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
          finalHp: { [HOST.userId]: 40, [GUEST.userId]: 70 },
          ranking: [
            { participantId: GUEST.userId, rank: 1 },
            { participantId: HOST.userId, rank: 2 },
          ],
        }),
      );
    });

    it('runs match finalization side effects only once for repeated endMatch calls', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      jest.clearAllMocks();
      emitSpy.mockClear();

      await Promise.all([
        service.endMatch(ROOM_ID, 'TIME_LIMIT', server),
        service.endMatch(ROOM_ID, 'TIME_LIMIT', server),
      ]);

      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockRedisService.del).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
      expect(mockUserRepository.update).toHaveBeenCalledTimes(1);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });

    it('automatically retries direct FORFEIT finalization failure without repeating completed side effects', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });
      emitSpy.mockClear();
      jest.clearAllMocks();

      await expect(
        service.endMatch(ROOM_ID, 'FORFEIT', server, GUEST.userId),
      ).rejects.toThrow('redis down');
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(eventsNamed<MatchEndPayload>('match_end')).toEqual([
        expect.objectContaining({ reason: 'FORFEIT', winnerId: GUEST.userId }),
      ]);

      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
    });

    it('commits match history and stats once when finalization is retried after partial DB failure', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      session.hp.host = 30;
      session.hp.guest = 70;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);

      const committedHistories: Array<{
        matchData: { reason: string; finalHp: HpPair };
        winner: { id: string } | null;
      }> = [];
      const committedStats: Record<string, { wins: number; losses: number }> = {
        [HOST.userId]: { wins: 0, losses: 0 },
        [GUEST.userId]: { wins: 0, losses: 0 },
      };
      let failLoserLossOnce = true;
      mockMatchHistoryRepository.manager.transaction.mockImplementation(
        async (
          work: (manager: {
            getRepository: (target: unknown) => unknown;
          }) => Promise<unknown>,
        ) => {
          const pendingHistories: typeof committedHistories = [];
          const pendingStats: typeof committedStats = {
            [HOST.userId]: { ...committedStats[HOST.userId] },
            [GUEST.userId]: { ...committedStats[GUEST.userId] },
          };
          const txMatchHistoryRepo = {
            create: mockMatchHistoryRepository.create,
            save: jest.fn((history: (typeof committedHistories)[number]) => {
              pendingHistories.push(history);
              return Promise.resolve(history);
            }),
          };
          const txUserRepo = {
            findOneBy: mockUserRepository.findOneBy,
            increment: jest.fn(
              (
                criteria: { id: string },
                field: 'wins' | 'losses',
                amount: number,
              ) => {
                if (
                  failLoserLossOnce &&
                  criteria.id === HOST.userId &&
                  field === 'losses'
                ) {
                  failLoserLossOnce = false;
                  return Promise.reject(new Error('loss update failed'));
                }
                pendingStats[criteria.id][field] += amount;
                return Promise.resolve({ affected: 1 });
              },
            ),
          };

          await work({
            getRepository: (target: unknown) =>
              target === User ? txUserRepo : txMatchHistoryRepo,
          });
          committedHistories.push(...pendingHistories);
          committedStats[HOST.userId] = pendingStats[HOST.userId];
          committedStats[GUEST.userId] = pendingStats[GUEST.userId];
        },
      );

      await expect(
        service.endMatch(ROOM_ID, 'TIME_LIMIT', server),
      ).rejects.toThrow('loss update failed');
      await service.endMatch(ROOM_ID, 'FORFEIT', server, HOST.userId);

      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')[0]).toEqual(
        expect.objectContaining({
          reason: 'TIME_LIMIT',
          winnerId: GUEST.userId,
        }),
      );
      expect(committedHistories).toHaveLength(1);
      expect(committedHistories[0].matchData.reason).toBe('TIME_LIMIT');
      expect(committedHistories[0].matchData.finalHp).toEqual({
        host: 30,
        guest: 70,
      });
      expect(committedHistories[0].winner?.id).toBe(GUEST.userId);
      expect(committedStats[GUEST.userId].wins).toBe(1);
      expect(committedStats[HOST.userId].losses).toBe(1);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
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

    it('retries FORFEIT finalization failure with the original override winner', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });
      emitSpy.mockClear();

      service.handleDisconnect(ROOM_ID, HOST.userId, server);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(eventsNamed<MatchEndPayload>('match_end')).toEqual([
        expect.objectContaining({ reason: 'FORFEIT', winnerId: GUEST.userId }),
      ]);

      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      const saved = mockMatchHistoryRepository.save.mock.calls[0][0] as {
        winner: { id: string } | null;
        matchData: { reason: string };
      };
      expect(saved.winner?.id).toBe(GUEST.userId);
      expect(saved.matchData.reason).toBe('FORFEIT');
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
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
      expect(syncPayload.hp).toEqual({
        [HOST.userId]: 100,
        [GUEST.userId]: 100,
      });
      expect(syncPayload.participants).toEqual([
        expect.objectContaining({
          participantId: HOST.userId,
          userId: HOST.userId,
          type: 'HUMAN',
        }),
        expect.objectContaining({
          participantId: GUEST.userId,
          userId: GUEST.userId,
          type: 'HUMAN',
        }),
      ]);
      expect(syncPayload.activeWords.length).toBeGreaterThan(0);
      const [activeWord] = syncPayload.activeWords;
      expect(typeof activeWord.keystrokes).toBe('number');
      expect(activeWord.status).toBe('ACTIVE');
      expect(typeof activeWord.damage).toBe('number');
      expect(typeof activeWord.landAt).toBe('string');
      // no tier leaking into the reconnect payload
      expect(activeWord).not.toHaveProperty('tier');

      // grace timer cancelled: advancing past the original 30s must NOT forfeit
      await jest.advanceTimersByTimeAsync(30_000);
      expect(
        eventsNamed<MatchEndPayload>('match_end').some(
          (e) => e.reason === 'FORFEIT',
        ),
      ).toBe(false);
    });
  });

  describe('spectator snapshot (#70)', () => {
    it('returns a state_sync-shaped snapshot while the match is in progress', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(2000); // one word spawned

      const snapshot = service.getSpectatorSnapshot(ROOM_ID);

      expect(snapshot).not.toBeNull();
      expect(snapshot?.roomId).toBe(ROOM_ID);
      expect(snapshot?.hp).toEqual({
        [HOST.userId]: 100,
        [GUEST.userId]: 100,
      });
      expect(snapshot?.participants).toEqual([
        expect.objectContaining({ participantId: HOST.userId, type: 'HUMAN' }),
        expect.objectContaining({ participantId: GUEST.userId, type: 'HUMAN' }),
      ]);
      expect(snapshot?.activeWords.length).toBeGreaterThan(0);
    });

    it('returns null before the match starts (no session yet)', () => {
      expect(service.getSpectatorSnapshot(ROOM_ID)).toBeNull();
    });

    it('returns null once the match has ended', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(service.getSpectatorSnapshot(ROOM_ID)).toBeNull();
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

    it('does not complete finalization when required users are missing from history transaction', async () => {
      await service.startMatch(ROOM_ID, HOST, GUEST, server);
      await jest.advanceTimersByTimeAsync(3000);
      let missingGuestOnce = true;
      mockUserRepository.findOneBy.mockImplementation(
        ({ id }: { id: string }) => {
          if (missingGuestOnce && id === GUEST.userId) {
            missingGuestOnce = false;
            return Promise.resolve(null);
          }
          return Promise.resolve({ id, nickname: id });
        },
      );

      await expect(
        service.endMatch(ROOM_ID, 'TIME_LIMIT', server),
      ).rejects.toThrow('Acid Rain match participant not found');
      expect(service.getSession(ROOM_ID)?.status).toBe('FINISHED');
      expect(mockMatchHistoryRepository.save).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1000);

      expect(service.getSession(ROOM_ID)).toBeUndefined();
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(mockMatchHistoryRepository.save).toHaveBeenCalledTimes(1);
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
