import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Server, Socket } from 'socket.io';
import { AcidRainService } from './acid-rain.service';
import { RedisService } from '../../redis/redis.service';
import { LobbyService } from '../../lobby/lobby.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { WordDictionaryService } from '../../word-dictionary/word-dictionary.service';
import { MatchHistory } from '../entities/match-history.entity';
import { MatchParticipant } from '../entities/match-participant.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import {
  AcidRainSession,
  HpMap,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  JudgeWordSubmitRejected,
  PlayerPublic,
  RankedParticipant,
  WordSpawnPayload,
} from './acid-rain.interface';

function assertRejected(
  result: JudgeWordSubmitResult,
): asserts result is JudgeWordSubmitRejected {
  if (result.accepted) throw new Error('expected a rejected submit result');
}

/** typeorm `In(ids)` produces a FindOperator whose `.value` holds the id array. */
function extractInIds(operator: unknown): string[] {
  const value = (operator as { value?: unknown } | undefined)?.value;
  return Array.isArray(value) ? (value as string[]) : [];
}

interface WordClearedPayload {
  wordId: string;
  clearedBy: string;
  targetUserId: string;
  damage: number;
  hp: HpMap;
}
interface WordMissedPayload {
  wordId: string;
  splashDamage: number;
  hp: HpMap;
}
interface PlayerEliminatedPayload {
  userId: string;
  rank: number;
  remainingPlayers: number;
}
interface MatchEndPayload {
  roomId: string;
  winnerId: string | null;
  reason: 'KO' | 'TIME_LIMIT' | 'FORFEIT';
  finalHp: HpMap;
  ranking: RankedParticipant[];
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
  hp: HpMap;
  activeWords: WordSpawnPayload[];
  elapsedMs: number;
  spawnIntervalMs: number;
  now: string;
}
interface SavedMatchHistory {
  winner: { id: string } | null;
  matchData: {
    reason: string;
    durationSec: number;
    participants: Array<{
      userId: string;
      finalHp: number;
      rank: number;
      wordsTyped: number;
    }>;
  };
  participants: Array<{ user: { id: string }; finalHp: number; rank: number }>;
}

describe('AcidRainService', () => {
  let service: AcidRainService;
  let redisStore: Record<string, string>;
  let emitSpy: jest.Mock<void, [string, unknown]>;
  let server: Server;

  const HOST: PlayerPublic = { userId: 'host-id', nickname: 'hostNick' };
  const GUEST: PlayerPublic = { userId: 'guest-id', nickname: 'guestNick' };
  const PLAYERS2: PlayerPublic[] = [HOST, GUEST];

  const P1: PlayerPublic = { userId: 'p1-id', nickname: 'P1' };
  const P2: PlayerPublic = { userId: 'p2-id', nickname: 'P2' };
  const P3: PlayerPublic = { userId: 'p3-id', nickname: 'P3' };
  const P4: PlayerPublic = { userId: 'p4-id', nickname: 'P4' };
  const PLAYERS3: PlayerPublic[] = [P1, P2, P3];
  const PLAYERS4: PlayerPublic[] = [P1, P2, P3, P4];

  const ROOM_ID = 'room-1';

  const mockUserRepository = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    findBy: jest.fn().mockImplementation((criteria: { id: unknown }) => {
      const ids = extractInIds(criteria.id);
      return Promise.resolve(ids.map((id) => ({ id, nickname: id })));
    }),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockParticipantRepository = {
    create: jest.fn().mockImplementation((dto: unknown) => dto),
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
              getRepository: (target: unknown) => {
                if (target === User) return mockUserRepository;
                if (target === MatchParticipant)
                  return mockParticipantRepository;
                return mockMatchHistoryRepository;
              },
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
    mockUserRepository.findBy.mockImplementation((criteria: { id: unknown }) => {
      const ids = extractInIds(criteria.id);
      return Promise.resolve(ids.map((id) => ({ id, nickname: id })));
    });
    mockUserRepository.increment.mockResolvedValue({ affected: 1 });
    mockParticipantRepository.create.mockImplementation((dto: unknown) => dto);
    mockMatchHistoryRepository.create.mockImplementation((dto: unknown) => dto);
    mockMatchHistoryRepository.save.mockResolvedValue({});
    mockMatchHistoryRepository.manager.transaction.mockImplementation(
      async (
        work: (manager: {
          getRepository: (target: unknown) => unknown;
        }) => Promise<unknown>,
      ) =>
        work({
          getRepository: (target: unknown) => {
            if (target === User) return mockUserRepository;
            if (target === MatchParticipant) return mockParticipantRepository;
            return mockMatchHistoryRepository;
          },
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

  async function startMatch(players: PlayerPublic[] = PLAYERS2): Promise<void> {
    await service.startMatch(ROOM_ID, players, server);
  }

  async function startAndReachFirstSpawn(
    players: PlayerPublic[] = PLAYERS2,
  ): Promise<WordSpawnPayload> {
    await service.startMatch(ROOM_ID, players, server);
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

  /** Directly injects a synthetic ACTIVE word into a session, bypassing the spawn loop/timers. */
  function injectActiveWord(
    session: AcidRainSession,
    wordId: string,
    text: string,
  ): void {
    session.activeWords.set(wordId, {
      wordId,
      text,
      keystrokes: 4,
      lane: 0,
      fallDurationMs: 5000,
      spawnedAt: new Date(Date.now()).toISOString(),
      landAt: Date.now() + 5000,
    });
  }

  function stopLoops(session: AcidRainSession): void {
    if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
    if (session.missLoopTimer) clearInterval(session.missLoopTimer);
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

  describe('submitWord — damage formula (GAME_DESIGN.md §3.6, 2-player)', () => {
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
          targetUserId: GUEST.userId,
          gameEnded: false,
          winnerId: null,
        }),
      );
      if (result.accepted) {
        expect(result.wordCleared).toEqual({
          wordId: word.wordId,
          clearedBy: HOST.userId,
          targetUserId: GUEST.userId,
          damage: result.damage,
          hp: result.hp,
        });
      }
    });

    it('correct hit deals 5 + ceil(keystrokes/2) to the (only) opponent', async () => {
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
      expect(cleared[0].targetUserId).toBe(GUEST.userId);
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

    it('a miss (word lands unclaimed) deals fixed 3 splash damage to all survivors', async () => {
      const word = await startAndReachFirstSpawn();
      await jest.advanceTimersByTimeAsync(word.fallDurationMs + 200); // miss loop ticks every 200ms

      const missed = eventsNamed<WordMissedPayload>('word_missed');
      expect(missed).toHaveLength(1);
      expect(missed[0].splashDamage).toBe(3);
      expect(missed[0].hp).toEqual({ [HOST.userId]: 97, [GUEST.userId]: 97 });
      expect(
        service.getSession(ROOM_ID)?.resolvedWords.get(word.wordId),
      ).toEqual({
        state: 'MISSED',
      });
    });

    it('returns KO metadata when a correct submission brings the opponent to 0 HP', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp[GUEST.userId] = 1;

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(true);
      if (!result.accepted) return;
      expect(result.gameEnded).toBe(true);
      expect(result.endReason).toBe('KO');
      expect(result.winnerId).toBe(HOST.userId);
      // 2-player match: the eliminated GUEST leaves exactly 1 survivor (HOST),
      // so GUEST's rank is remainingAfter(1) + 1 = 2.
      expect(result.eliminatedRank).toBe(2);
      expect(result.hp).toEqual({ [HOST.userId]: 100, [GUEST.userId]: 0 });
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
      await startMatch();
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
      expect(result.hp).toEqual(hpBefore);
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

    it('rejects submission from a player who is already eliminated (PLAYER_ELIMINATED)', async () => {
      const word = await startAndReachFirstSpawn(PLAYERS3);
      const session = service.getSession(ROOM_ID)!;
      session.eliminated.push({ userId: P3.userId, rank: 3 });
      session.hp[P3.userId] = 0;
      const hpBefore = { ...session.hp };

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: P3.userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(false);
      assertRejected(result);
      expect(result.reason).toBe('PLAYER_ELIMINATED');
      expect(result.submitRejected).toEqual({
        wordId: word.wordId,
        reason: 'NOT_FOUND',
      });
      expect(session.activeWords.has(word.wordId)).toBe(true);
      expect(session.hp).toEqual(hpBefore);
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
      session.hp[GUEST.userId] = 1;

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
      await startMatch();
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
      session.hp[GUEST.userId] = 1;

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

    it('replays a KO attempt after session deletion without repeating broadcasts or finalization', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp[GUEST.userId] = 1;

      const first = await service.submitWord(
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
      expect(replay).toEqual(first);
      expect(eventsNamed<WordClearedPayload>('word_cleared')).toHaveLength(0);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      expect(mockMatchHistoryRepository.save).not.toHaveBeenCalled();
      expect(mockLobbyService.broadcast).not.toHaveBeenCalled();
    });

    it('retries only KO finalization after an endMatch failure on attempt replay', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp[GUEST.userId] = 1;
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
      expect(completedReplay).toEqual(replay);
      expect(mockMatchHistoryRepository.save).not.toHaveBeenCalled();
      expect(mockLobbyService.broadcast).not.toHaveBeenCalled();
    });

    it('automatically retries an attemptId-free KO finalization failure without repeating broadcasts', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      session.hp[GUEST.userId] = 1;
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

  describe('match end conditions (2-player)', () => {
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
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      await jest.advanceTimersByTimeAsync(180_000);

      expect(endMatchSpy).toHaveBeenCalledWith(ROOM_ID, 'TIME_LIMIT', server);
    });

    it('catches TIME_LIMIT finalization failure and retries without repeating match_end', async () => {
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
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

    it('retries miss-splash KO finalization failure without repeating match_end', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      session.hp[HOST.userId] = 3;
      session.hp[GUEST.userId] = 50;
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
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      session.hp[HOST.userId] = 40;
      session.hp[GUEST.userId] = 70;

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended[0]).toEqual(
        expect.objectContaining({
          reason: 'TIME_LIMIT',
          winnerId: GUEST.userId,
        }),
      );
    });

    it('runs match finalization side effects only once for repeated endMatch calls', async () => {
      await startMatch();
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
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      // simulate HOST having already been eliminated (e.g. by an earlier leave/disconnect)
      session.eliminated.push({ userId: HOST.userId, rank: 2 });
      session.hp[HOST.userId] = 0;
      mockRedisService.del
        .mockRejectedValueOnce(new Error('redis down'))
        .mockImplementation((key: string) => {
          delete redisStore[key];
          return Promise.resolve();
        });
      emitSpy.mockClear();
      jest.clearAllMocks();

      await expect(
        service.endMatch(ROOM_ID, 'FORFEIT', server),
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

    it('commits match history and stats exactly once when finalization is retried after a mid-transaction failure', async () => {
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      session.hp[HOST.userId] = 30;
      session.hp[GUEST.userId] = 70;
      stopLoops(session);

      const committedHistories: SavedMatchHistory[] = [];
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
          const pendingHistories: SavedMatchHistory[] = [];
          const pendingStats: typeof committedStats = {
            [HOST.userId]: { ...committedStats[HOST.userId] },
            [GUEST.userId]: { ...committedStats[GUEST.userId] },
          };
          const txMatchHistoryRepo = {
            create: mockMatchHistoryRepository.create,
            save: jest.fn((history: SavedMatchHistory) => {
              pendingHistories.push(history);
              return Promise.resolve(history);
            }),
          };
          const txParticipantRepo = {
            create: jest.fn((dto: unknown) => dto),
          };
          const txUserRepo = {
            findBy: mockUserRepository.findBy,
            increment: jest.fn(
              (
                criteria: { id: string },
                field: 'wins' | 'losses' | 'draws',
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
                if (field !== 'draws') {
                  pendingStats[criteria.id][field] += amount;
                }
                return Promise.resolve({ affected: 1 });
              },
            ),
          };

          await work({
            getRepository: (target: unknown) => {
              if (target === User) return txUserRepo;
              if (target === MatchParticipant) return txParticipantRepo;
              return txMatchHistoryRepo;
            },
          });
          committedHistories.push(...pendingHistories);
          committedStats[HOST.userId] = pendingStats[HOST.userId];
          committedStats[GUEST.userId] = pendingStats[GUEST.userId];
        },
      );

      await expect(
        service.endMatch(ROOM_ID, 'TIME_LIMIT', server),
      ).rejects.toThrow('loss update failed');
      expect(committedHistories).toHaveLength(0);

      // the automatic retry timer (MATCH_END_RETRY_DELAY_MS) re-runs endMatch with the
      // same stored reason/snapshot and this time the increment succeeds.
      await jest.advanceTimersByTimeAsync(1000);

      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(1);
      expect(eventsNamed<MatchEndPayload>('match_end')[0]).toEqual(
        expect.objectContaining({
          reason: 'TIME_LIMIT',
          winnerId: GUEST.userId,
        }),
      );
      expect(committedHistories).toHaveLength(1);
      expect(committedHistories[0].matchData.reason).toBe('TIME_LIMIT');
      expect(committedHistories[0].participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            finalHp: 30,
            user: expect.objectContaining({ id: HOST.userId }),
          }),
          expect.objectContaining({
            finalHp: 70,
            user: expect.objectContaining({ id: GUEST.userId }),
          }),
        ]),
      );
      expect(committedHistories[0].winner?.id).toBe(GUEST.userId);
      expect(committedStats[GUEST.userId].wins).toBe(1);
      expect(committedStats[HOST.userId].losses).toBe(1);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });
  });

  describe('disconnect / reconnect (2-player)', () => {
    it('starts a 30s grace period and forfeits to the opponent if no reconnect', async () => {
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);

      service.handleDisconnect(ROOM_ID, HOST.userId, server);
      expect(
        eventsNamed<OpponentDisconnectedPayload>('opponent_disconnected'),
      ).toContainEqual({
        userId: HOST.userId,
        graceMs: 30_000,
      });

      await jest.advanceTimersByTimeAsync(30_000);

      const eliminated = eventsNamed<PlayerEliminatedPayload>(
        'player_eliminated',
      );
      expect(eliminated).toContainEqual({
        userId: HOST.userId,
        rank: 2,
        remainingPlayers: 1,
      });
      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toContainEqual(
        expect.objectContaining({ reason: 'FORFEIT', winnerId: GUEST.userId }),
      );
    });

    it('retries FORFEIT finalization failure after a disconnect grace-timeout elimination', async () => {
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
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
      const saved = mockMatchHistoryRepository.save.mock
        .calls[0][0] as SavedMatchHistory;
      expect(saved.winner?.id).toBe(GUEST.userId);
      expect(saved.matchData.reason).toBe('FORFEIT');
      expect(mockLobbyService.broadcast).toHaveBeenCalledTimes(1);
    });

    it('cancels the grace timer and sends state_sync on reconnect within the grace period', async () => {
      await startMatch();
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

  describe('endMatch persistence (2-player)', () => {
    it('saves MatchHistory with finalHp/ranking/durationSec and updates wins/losses', async () => {
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(mockMatchHistoryRepository.save).toHaveBeenCalled();
      const saved = mockMatchHistoryRepository.save.mock
        .calls[0][0] as SavedMatchHistory;
      expect(saved.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            finalHp: 100,
            user: expect.objectContaining({ id: HOST.userId }),
          }),
          expect.objectContaining({
            finalHp: 100,
            user: expect.objectContaining({ id: GUEST.userId }),
          }),
        ]),
      );
      expect(saved.matchData.durationSec).toBeGreaterThanOrEqual(0);
      expect(saved.matchData.reason).toBe('TIME_LIMIT');
      // equal HP at TIME_LIMIT is a tie/draw — no unique winner
      expect(saved.winner).toBeNull();
      expect(saved.participants).toHaveLength(2);
    });

    it('does not complete finalization when required users are missing from history transaction', async () => {
      await startMatch();
      await jest.advanceTimersByTimeAsync(3000);
      let missingGuestOnce = true;
      mockUserRepository.findBy.mockImplementation((criteria: { id: unknown }) => {
        const ids = extractInIds(criteria.id);
        if (missingGuestOnce) {
          missingGuestOnce = false;
          return Promise.resolve(
            ids
              .filter((id) => id !== GUEST.userId)
              .map((id) => ({ id, nickname: id })),
          );
        }
        return Promise.resolve(ids.map((id) => ({ id, nickname: id })));
      });

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

  // ─── N-player (battle royale) specific coverage (#94) ──────────────────────

  describe('N-player — random target selection on correct word (GAME_DESIGN §3.6)', () => {
    it('always damages a valid survivor candidate (not the clearer, not eliminated) across many trials', async () => {
      const players = PLAYERS4;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);

      const seenTargets = new Set<string>();
      for (let i = 0; i < 40; i++) {
        const wordId = `w_trial_${i}`;
        const text = `단어${i}`;
        injectActiveWord(session, wordId, text);
        const result = await submitWord({
          roomId: ROOM_ID,
          playerId: players[0].userId,
          wordId,
          text,
        });
        expect(result.accepted).toBe(true);
        if (!result.accepted) continue;
        expect(result.targetUserId).not.toBe(players[0].userId);
        expect(players.slice(1).map((p) => p.userId)).toContain(
          result.targetUserId,
        );
        seenTargets.add(result.targetUserId);
        // reset HP so the candidate pool doesn't shrink across trials
        session.hp[result.targetUserId] = 100;
      }

      // with real Math.random and 3 candidates over 40 trials, expect more than one distinct target
      expect(seenTargets.size).toBeGreaterThan(1);
    });

    it('pins the damaged target deterministically when Math.random is mocked', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      const randomSpy = jest.spyOn(Math, 'random');

      injectActiveWord(session, 'w_pin_low', 'low');
      randomSpy.mockReturnValueOnce(0); // candidates[0] of [P2, P3]
      const first = await submitWord({
        roomId: ROOM_ID,
        playerId: players[0].userId,
        wordId: 'w_pin_low',
        text: 'low',
      });
      expect(first.accepted).toBe(true);
      if (first.accepted) expect(first.targetUserId).toBe(players[1].userId);

      session.hp[players[1].userId] = 100;
      injectActiveWord(session, 'w_pin_high', 'high');
      randomSpy.mockReturnValueOnce(0.999); // candidates[1] of [P2, P3]
      const second = await submitWord({
        roomId: ROOM_ID,
        playerId: players[0].userId,
        wordId: 'w_pin_high',
        text: 'high',
      });
      expect(second.accepted).toBe(true);
      if (second.accepted) expect(second.targetUserId).toBe(players[2].userId);

      randomSpy.mockRestore();
    });
  });

  describe('N-player — elimination via word_cleared', () => {
    it('eliminating one of 3 players (2 survivors remain) keeps the match IN_PROGRESS and excludes them from future targeting', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      session.hp[players[1].userId] = 1; // about to die
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0); // picks first candidate

      injectActiveWord(session, 'w_kill', 'kill');
      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: players[0].userId,
        wordId: 'w_kill',
        text: 'kill',
      });

      expect(result.accepted).toBe(true);
      if (!result.accepted) return;
      expect(result.targetUserId).toBe(players[1].userId);
      expect(result.eliminatedRank).toBe(3);
      expect(result.remainingPlayers).toBe(2);
      expect(result.gameEnded).toBe(false);
      expect(service.getSession(ROOM_ID)?.status).toBe('IN_PROGRESS');

      const eliminated = eventsNamed<PlayerEliminatedPayload>(
        'player_eliminated',
      );
      expect(eliminated).toContainEqual({
        userId: players[1].userId,
        rank: 3,
        remainingPlayers: 2,
      });
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);

      // future targeting must exclude the eliminated player
      randomSpy.mockReturnValue(0);
      injectActiveWord(session, 'w_after', 'after');
      const after = await submitWord({
        roomId: ROOM_ID,
        playerId: players[0].userId,
        wordId: 'w_after',
        text: 'after',
      });
      expect(after.accepted).toBe(true);
      if (after.accepted) expect(after.targetUserId).toBe(players[2].userId);

      randomSpy.mockRestore();
    });
  });

  describe('N-player — splash (word_missed) multi-elimination', () => {
    it('can eliminate multiple players in the same tick, and they share the same rank', async () => {
      const players = PLAYERS4;
      const word = await startAndReachFirstSpawn(players);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      session.hp[players[0].userId] = 3;
      session.hp[players[1].userId] = 3;
      session.hp[players[2].userId] = 50;
      session.hp[players[3].userId] = 50;
      const activeWord = session.activeWords.get(word.wordId)!;
      activeWord.landAt = Date.now();

      await jest.advanceTimersByTimeAsync(200);

      const eliminated = eventsNamed<PlayerEliminatedPayload>(
        'player_eliminated',
      );
      expect(eliminated).toContainEqual({
        userId: players[0].userId,
        rank: 3,
        remainingPlayers: 2,
      });
      expect(eliminated).toContainEqual({
        userId: players[1].userId,
        rank: 3,
        remainingPlayers: 2,
      });
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      expect(service.getSession(ROOM_ID)?.status).toBe('IN_PROGRESS');
    });

    it('a full simultaneous wipeout via splash ends the match as a mutual draw (winnerId null, all tied at rank 1)', async () => {
      const players = PLAYERS3;
      const word = await startAndReachFirstSpawn(players);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      // simulate an earlier elimination so only 2 survivors remain
      session.eliminated.push({ userId: players[0].userId, rank: 3 });
      session.hp[players[0].userId] = 0;
      session.hp[players[1].userId] = 3;
      session.hp[players[2].userId] = 3;
      const activeWord = session.activeWords.get(word.wordId)!;
      activeWord.landAt = Date.now();

      await jest.advanceTimersByTimeAsync(200);

      const missed = eventsNamed<WordMissedPayload>('word_missed');
      expect(missed).toHaveLength(1);
      expect(missed[0].hp[players[1].userId]).toBe(0);
      expect(missed[0].hp[players[2].userId]).toBe(0);

      const eliminated = eventsNamed<PlayerEliminatedPayload>(
        'player_eliminated',
      );
      expect(eliminated).toContainEqual({
        userId: players[1].userId,
        rank: 1,
        remainingPlayers: 0,
      });
      expect(eliminated).toContainEqual({
        userId: players[2].userId,
        rank: 1,
        remainingPlayers: 0,
      });

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toHaveLength(1);
      expect(ended[0].winnerId).toBeNull();
      expect(ended[0].reason).toBe('KO');
      expect(ended[0].ranking).toEqual(
        expect.arrayContaining([
          { userId: players[1].userId, rank: 1 },
          { userId: players[2].userId, rank: 1 },
          { userId: players[0].userId, rank: 3 },
        ]),
      );
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });
  });

  describe('N-player — TIME_LIMIT competition ranking', () => {
    it('ranks survivors by HP descending with tied HP sharing rank and the next distinct rank skipping ahead', async () => {
      const players = PLAYERS4;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      session.hp[players[0].userId] = 80;
      session.hp[players[1].userId] = 50;
      session.hp[players[2].userId] = 50;
      session.hp[players[3].userId] = 10;

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toHaveLength(1);
      expect(ended[0].winnerId).toBe(players[0].userId);
      expect(ended[0].ranking).toEqual(
        expect.arrayContaining([
          { userId: players[0].userId, rank: 1 },
          { userId: players[1].userId, rank: 2 },
          { userId: players[2].userId, rank: 2 },
          { userId: players[3].userId, rank: 4 }, // competition ranking: skips rank 3
        ]),
      );
    });

    it('yields winnerId null when 2+ players are tied at the top HP', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      session.hp[players[0].userId] = 60;
      session.hp[players[1].userId] = 60;
      session.hp[players[2].userId] = 30;

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended[0].winnerId).toBeNull();
      expect(ended[0].ranking).toEqual(
        expect.arrayContaining([
          { userId: players[0].userId, rank: 1 },
          { userId: players[1].userId, rank: 1 },
          { userId: players[2].userId, rank: 3 },
        ]),
      );
    });
  });

  describe('N-player — disconnect grace-timeout elimination', () => {
    it('with 3+ players, eliminating one who leaves 2+ survivors keeps the match IN_PROGRESS, and their later word_submit is rejected (PLAYER_ELIMINATED)', async () => {
      const players = PLAYERS3;
      const word = await startAndReachFirstSpawn(players);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session); // avoid the already-spawned word missing mid-grace-period

      service.handleDisconnect(ROOM_ID, players[2].userId, server);
      await jest.advanceTimersByTimeAsync(30_000);

      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      expect(service.getSession(ROOM_ID)?.status).toBe('IN_PROGRESS');
      const eliminated = eventsNamed<PlayerEliminatedPayload>(
        'player_eliminated',
      );
      expect(eliminated).toContainEqual({
        userId: players[2].userId,
        rank: 3,
        remainingPlayers: 2,
      });

      const hpBefore = { ...service.getSession(ROOM_ID)!.hp };
      const rejected = await submitWord({
        roomId: ROOM_ID,
        playerId: players[2].userId,
        wordId: word.wordId,
        text: word.text,
      });

      expect(rejected.accepted).toBe(false);
      assertRejected(rejected);
      expect(rejected.reason).toBe('PLAYER_ELIMINATED');
      expect(rejected.submitRejected).toEqual({
        wordId: word.wordId,
        reason: 'NOT_FOUND',
      });
      expect(service.getSession(ROOM_ID)?.hp).toEqual(hpBefore);
    });

    it('cascading from 2 to 1 survivor ends the match with FORFEIT and the sole survivor as winner', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      // simulate an earlier elimination leaving 2 survivors
      session.eliminated.push({ userId: players[2].userId, rank: 3 });
      session.hp[players[2].userId] = 0;

      service.handleDisconnect(ROOM_ID, players[1].userId, server);
      await jest.advanceTimersByTimeAsync(30_000);

      const eliminated = eventsNamed<PlayerEliminatedPayload>(
        'player_eliminated',
      );
      expect(eliminated).toContainEqual({
        userId: players[1].userId,
        rank: 2,
        remainingPlayers: 1,
      });
      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toContainEqual(
        expect.objectContaining({
          reason: 'FORFEIT',
          winnerId: players[0].userId,
        }),
      );
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });
  });

  describe('N-player — eliminateOnLeave (leave_room, no grace timer)', () => {
    it('immediately eliminates a player; with 2+ survivors remaining the match continues', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);

      await service.eliminateOnLeave(ROOM_ID, players[2].userId, server);

      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      expect(service.getSession(ROOM_ID)?.status).toBe('IN_PROGRESS');
      expect(
        eventsNamed<PlayerEliminatedPayload>('player_eliminated'),
      ).toContainEqual({
        userId: players[2].userId,
        rank: 3,
        remainingPlayers: 2,
      });
    });

    it('immediately ends the match with FORFEIT (no timer needed) when it drops survivors to exactly 1', async () => {
      await startMatch(PLAYERS2);
      await jest.advanceTimersByTimeAsync(3000);

      await service.eliminateOnLeave(ROOM_ID, HOST.userId, server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toContainEqual(
        expect.objectContaining({ reason: 'FORFEIT', winnerId: GUEST.userId }),
      );
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });

    it('is a no-op when there is no in-progress session for the room', async () => {
      await expect(
        service.eliminateOnLeave('no-such-room', 'someone', server),
      ).resolves.toBeUndefined();
      expect(eventsNamed('match_end')).toHaveLength(0);
      expect(eventsNamed('player_eliminated')).toHaveLength(0);
    });
  });

  describe('N-player — saveMatchHistory stats & MatchParticipant rows', () => {
    it('unique winner: winner wins++, everyone else losses++, MatchParticipant rows carry correct finalHp/rank', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      session.hp[players[0].userId] = 70;
      session.hp[players[1].userId] = 40;
      session.hp[players[2].userId] = 10;

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: players[0].userId },
        'wins',
        1,
      );
      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: players[1].userId },
        'losses',
        1,
      );
      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: players[2].userId },
        'losses',
        1,
      );
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'draws',
        expect.anything(),
      );

      const saved = mockMatchHistoryRepository.save.mock
        .calls[0][0] as SavedMatchHistory;
      expect(saved.participants).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            finalHp: 70,
            rank: 1,
            user: expect.objectContaining({ id: players[0].userId }),
          }),
          expect.objectContaining({
            finalHp: 40,
            rank: 2,
            user: expect.objectContaining({ id: players[1].userId }),
          }),
          expect.objectContaining({
            finalHp: 10,
            rank: 3,
            user: expect.objectContaining({ id: players[2].userId }),
          }),
        ]),
      );
    });

    it('draw/mutual-wipe (no unique winner): only the tied rank-1 players draws++, clear lower ranks get losses++', async () => {
      const players = PLAYERS3;
      await startMatch(players);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      stopLoops(session);
      session.hp[players[0].userId] = 50;
      session.hp[players[1].userId] = 50;
      session.hp[players[2].userId] = 20;

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      // players[0]/[1] are tied for 1st — draws only, no wins/losses
      for (const p of [players[0], players[1]]) {
        expect(mockUserRepository.increment).toHaveBeenCalledWith(
          { id: p.userId },
          'draws',
          1,
        );
      }
      // players[2] unambiguously finished last — losses, not draws
      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: players[2].userId },
        'losses',
        1,
      );
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        { id: players[2].userId },
        'draws',
        expect.anything(),
      );
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'wins',
        expect.anything(),
      );

      const saved = mockMatchHistoryRepository.save.mock
        .calls[0][0] as SavedMatchHistory;
      expect(saved.winner).toBeNull();
    });
  });
});
