import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Server, Socket } from 'socket.io';
import { AcidRainService } from './acid-rain.service';
import { AiScheduler } from './ai/ai-scheduler';
import { ACID_RAIN_RANDOM } from './acid-rain.service';
import { RedisService } from '../../redis/redis.service';
import { LobbyService } from '../../lobby/lobby.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { WordDictionaryService } from '../../word-dictionary/word-dictionary.service';
import { PerformanceService } from './performance.service';
import { MatchHistory } from '../entities/match-history.entity';
import { MatchParticipant } from '../entities/match-participant.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import {
  AcidRainSession,
  HpByParticipantId,
  ParticipantPublic,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  JudgeWordSubmitRejected,
  WordSpawnPayload,
  PlayerEliminatedEventPayload,
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
  let serverToSpy: jest.Mock;
  let server: Server;
  let randomMock: jest.Mock<number, []>;
  let mockAiScheduler: {
    registerRoom: jest.Mock;
    onStateChange: jest.Mock;
    invalidate: jest.Mock;
    destroy: jest.Mock;
    getLatestMonitorSnapshot: jest.Mock;
    emitTerminal: jest.Mock;
  };

  const HOST = { userId: 'host-id', nickname: 'hostNick' };
  const GUEST = { userId: 'guest-id', nickname: 'guestNick' };
  const ROOM_ID = 'room-1';

  const HOST_PARTICIPANT: ParticipantPublic = {
    participantId: HOST.userId,
    userId: HOST.userId,
    nickname: HOST.nickname,
    type: 'HUMAN',
  };
  const GUEST_PARTICIPANT: ParticipantPublic = {
    participantId: GUEST.userId,
    userId: GUEST.userId,
    nickname: GUEST.nickname,
    type: 'HUMAN',
  };
  const TWO_PLAYERS: ParticipantPublic[] = [
    HOST_PARTICIPANT,
    GUEST_PARTICIPANT,
  ];

  function setHp(
    session: AcidRainSession,
    participantId: string,
    hp: number,
  ): void {
    session.hpByParticipantId[participantId] = hp;
    const participant = session.participants.find(
      (candidate) => candidate.participantId === participantId,
    );
    if (participant) participant.hp = hp;
  }

  function wordsTypedOf(
    session: AcidRainSession,
    participantId: string,
  ): number {
    return session.participants.find(
      (candidate) => candidate.participantId === participantId,
    )!.wordsTyped;
  }

  const mockUserRepository = {
    update: jest.fn().mockResolvedValue({ affected: 0 }),
    findOneBy: jest
      .fn()
      .mockImplementation(({ id }: { id: string }) =>
        Promise.resolve({ id, nickname: id }),
      ),
    findBy: jest
      .fn()
      .mockImplementation(({ id }: { id: { value: string[] } }) =>
        Promise.resolve(id.value.map((i) => ({ id: i, nickname: i }))),
      ),
    increment: jest.fn().mockResolvedValue({ affected: 1 }),
  };

  const mockMatchParticipantRepository = {
    create: jest.fn().mockImplementation((dto: unknown) => dto),
    save: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue([]),
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
                  return mockMatchParticipantRepository;
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

  const mockPerformanceService = {
    flushWordAttempt: jest.fn().mockResolvedValue(undefined),
    saveParticipantPerformances: jest.fn().mockResolvedValue(undefined),
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
    mockUserRepository.findBy.mockImplementation(
      ({ id }: { id: { value: string[] } }) =>
        Promise.resolve(id.value.map((i) => ({ id: i, nickname: i }))),
    );
    mockUserRepository.increment.mockResolvedValue({ affected: 1 });
    mockMatchParticipantRepository.create.mockImplementation(
      (dto: unknown) => dto,
    );
    mockMatchParticipantRepository.save.mockResolvedValue([]);
    mockMatchHistoryRepository.create.mockImplementation((dto: unknown) => dto);
    mockMatchHistoryRepository.save.mockResolvedValue({});
    mockMatchParticipantRepository.create.mockImplementation(
      (dto: unknown) => dto,
    );
    mockMatchParticipantRepository.save.mockResolvedValue({});
    mockMatchHistoryRepository.manager.transaction.mockImplementation(
      async (
        work: (manager: {
          getRepository: (target: unknown) => unknown;
        }) => Promise<unknown>,
      ) =>
        work({
          getRepository: (target: unknown) => {
            if (target === User) return mockUserRepository;
            if (target === MatchParticipant)
              return mockMatchParticipantRepository;
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
    randomMock = jest.fn<number, []>().mockReturnValue(0);
    mockAiScheduler = {
      registerRoom: jest.fn(),
      onStateChange: jest.fn(),
      invalidate: jest.fn(),
      destroy: jest.fn(),
      getLatestMonitorSnapshot: jest.fn(),
      emitTerminal: jest.fn(),
    };
    serverToSpy = jest.fn().mockReturnValue({ emit: emitSpy });
    server = { to: serverToSpy } as unknown as Server;

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
        { provide: PerformanceService, useValue: mockPerformanceService },
        { provide: ACID_RAIN_RANDOM, useValue: randomMock },
        { provide: AiScheduler, useValue: mockAiScheduler },
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
    await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
    await jest.advanceTimersByTimeAsync(3000); // countdown
    await jest.advanceTimersByTimeAsync(1000); // fixed initial spawn delay
    const spawns = eventsNamed<WordSpawnPayload>('word_spawn');
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    return spawns[0];
  }

  async function submitWord(
    input: JudgeWordSubmitInput,
  ): Promise<JudgeWordSubmitResult> {
    return service.submitWord(input, server);
  }

  function addActiveWord(
    roomId: string,
    wordId: string,
    text: string,
    landAt = Number.MAX_SAFE_INTEGER,
  ): void {
    const session = service.getSession(roomId)!;
    session.activeWords.set(wordId, {
      wordId,
      text,
      keystrokes: 6,
      lane: session.activeWords.size % 5,
      fallDurationMs: 5500,
      spawnedAt: new Date(0).toISOString(),
      landAt,
      damage: 8,
    });
  }

  async function startParticipants(
    participants: ParticipantPublic[],
    mode: 'PVP' | 'AI_PRACTICE' = 'PVP',
  ): Promise<void> {
    await service.startMatch(ROOM_ID, server, participants, mode);
    await jest.advanceTimersByTimeAsync(3000);
  }

  describe('spawn — fall duration formula (GAME_DESIGN.md §3.5)', () => {
    it('fallDurationMs = (4000 + 250*keystrokes) * max(0.6, 1 - elapsedSec/300)', async () => {
      const word = await startAndReachFirstSpawn();
      const elapsedSec = 1; // fixed 1000ms initial spawn delay (countdown doesn't count toward session.startedAt)
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

  describe('spawn count ramp (#195)', () => {
    it('spawnCountForElapsed starts at 2, grows by 1 every 30s, caps at 4', () => {
      const spawnCountForElapsed = (
        service as unknown as {
          spawnCountForElapsed: (elapsedSec: number) => number;
        }
      ).spawnCountForElapsed;
      expect(spawnCountForElapsed.call(service, 0)).toBe(2);
      expect(spawnCountForElapsed.call(service, 29)).toBe(2);
      expect(spawnCountForElapsed.call(service, 30)).toBe(3);
      expect(spawnCountForElapsed.call(service, 60)).toBe(4);
      expect(spawnCountForElapsed.call(service, 300)).toBe(4);
    });

    it('a single tick spawns multiple words early in the match', async () => {
      let uniqueWordCounter = 0;
      mockWordDictionaryService.pickWord.mockImplementation(() => ({
        text: `틱단어${uniqueWordCounter++}`,
        keystrokes: 6,
      }));
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT]);
      const session = service.getSession(ROOM_ID)!;
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);

      await jest.advanceTimersByTimeAsync(1000); // first tick

      expect(session.activeWords.size).toBe(2);
    });
  });

  describe('spawn volume scales with participant count (#100)', () => {
    let uniqueWordCounter = 0;
    beforeEach(() => {
      uniqueWordCounter = 0;
      mockWordDictionaryService.pickWord.mockImplementation(() => ({
        text: `단어${uniqueWordCounter++}`,
        keystrokes: 6,
      }));
    });

    // missLoopTimer가 낙하 시간(fallDurationMs≈5.5s)이 지난 단어를 MISSED로 치워버리면
    // 활성 단어 수가 한도까지 쌓이는지 관찰할 수 없다 — 스폰 로직만 격리해서 본다.
    function stopMissLoop(): void {
      const session = service.getSession(ROOM_ID)!;
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
    }

    it('caps concurrent active words at 5 per participant (2 players → 10)', async () => {
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT]);
      stopMissLoop();
      // 스폰 간격은 초반 1000ms에서 시작해 서서히 짧아지고, 틱당 2~4개씩 스폰된다(#195)
      // — 한도(10)까지 넉넉히 흘려보낸다
      for (let i = 0; i < 24; i++) {
        await jest.advanceTimersByTimeAsync(2500);
      }

      const session = service.getSession(ROOM_ID)!;
      expect(session.maxActiveWords).toBe(10);
      expect(session.activeWords.size).toBeLessThanOrEqual(10);
      expect(session.activeWords.size).toBe(10);
    });

    it('caps concurrent active words at 5 per participant (4 players → 20)', async () => {
      const P3 = {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'p3',
        type: 'HUMAN' as const,
      };
      const P4 = {
        participantId: 'player-4',
        userId: 'player-4',
        nickname: 'p4',
        type: 'HUMAN' as const,
      };
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT, P3, P4]);
      stopMissLoop();
      for (let i = 0; i < 36; i++) {
        await jest.advanceTimersByTimeAsync(2500);
      }

      const session = service.getSession(ROOM_ID)!;
      expect(session.maxActiveWords).toBe(20);
      expect(session.activeWords.size).toBe(20);
    });
  });

  describe('lane assignment avoids adjacent lanes when possible (#100)', () => {
    let uniqueWordCounter = 0;
    beforeEach(() => {
      uniqueWordCounter = 0;
      mockWordDictionaryService.pickWord.mockImplementation(() => ({
        text: `단어${uniqueWordCounter++}`,
        keystrokes: 6,
      }));
    });

    function stopMissLoop(): void {
      const session = service.getSession(ROOM_ID)!;
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
    }

    it('never places two simultaneously-empty-lane spawns in adjacent lanes while non-adjacent lanes remain free', async () => {
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT]);
      stopMissLoop();
      const session = service.getSession(ROOM_ID)!;
      // spawnOneWord를 직접 3번 호출해 5레인 중 3개만 채운다(인접 회피가 항상 가능한
      // 범위) — 틱당 스폰 개수(#195)나 타이밍 램프가 바뀌어도 이 테스트가 흔들리지
      // 않도록 tick()/advanceTimersByTimeAsync 대신 private 메서드를 직접 호출한다.
      // 4번째부터는 회피할 빈 레인이 없어 인접 배치로 폴백하는 게 정상 동작 —
      // 별도 테스트로 커버.
      const spawnOneWord = (
        service as unknown as {
          spawnOneWord: (
            session: unknown,
            server: Server,
            elapsed: number,
          ) => boolean;
        }
      ).spawnOneWord;
      for (let i = 0; i < 3; i++) {
        spawnOneWord.call(service, session, server, 1);
      }
      const lanes = Array.from(session.activeWords.values())
        .map((w) => w.lane)
        .sort((a, b) => a - b);
      expect(lanes.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < lanes.length; i++) {
        expect(lanes[i] - lanes[i - 1]).toBeGreaterThanOrEqual(2);
      }
    });

    it('falls back to an adjacent lane once no non-adjacent empty lane remains', async () => {
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT]);
      stopMissLoop();
      for (let i = 0; i < 8; i++) {
        await jest.advanceTimersByTimeAsync(2500);
      }

      const session = service.getSession(ROOM_ID)!;
      const laneSet = new Set(
        Array.from(session.activeWords.values()).map((w) => w.lane),
      );
      // 5레인을 다 채우고도 더 스폰됐다면(#100 인원수 비례 단어량) 반드시 어딘가는
      // 인접 배치될 수밖에 없다.
      expect(laneSet.size).toBe(5);
    });

    it('reuses lanes (stacks multiple words per lane) once active word count exceeds LANE_COUNT', async () => {
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT]);
      stopMissLoop();
      for (let i = 0; i < 24; i++) {
        await jest.advanceTimersByTimeAsync(2500);
      }

      const session = service.getSession(ROOM_ID)!;
      // maxActiveWords(10) > LANE_COUNT(5)이므로 어떤 레인은 반드시 2개 이상을 담아야 한다
      const laneCounts = new Map<number, number>();
      for (const w of session.activeWords.values()) {
        laneCounts.set(w.lane, (laneCounts.get(w.lane) ?? 0) + 1);
      }
      expect(Math.max(...laneCounts.values())).toBeGreaterThanOrEqual(2);
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

    it('starts a three-player session with participant-id HP state', async () => {
      await service.startMatch(ROOM_ID, server, [
        HOST_PARTICIPANT,
        GUEST_PARTICIPANT,
        {
          participantId: 'guest-2',
          userId: 'guest-2',
          nickname: 'guest-2',
          type: 'HUMAN',
        },
      ]);
      const session = service.getSession(ROOM_ID)!;
      expect(session.participants).toHaveLength(3);
      expect(session.hpByParticipantId).toEqual({
        [HOST.userId]: 100,
        [GUEST.userId]: 100,
        'guest-2': 100,
      });
    });
  });

  describe('#136 spawn invariants', () => {
    beforeEach(() => {
      mockWordDictionaryService.pickWord.mockReturnValue({
        text: '테스트',
        keystrokes: 6,
      });
    });

    it('skips a spawn tick when maxActiveWords ACTIVE words already exist', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      const session = service.getSession(ROOM_ID)!;
      // #100: 상한이 인원수 비례(maxActiveWords)로 바뀌었으므로 고정 5가 아니라
      // 그 값만큼 채워야 한다(2인 매치 기준 10).
      for (let i = 0; i < session.maxActiveWords; i++) {
        addActiveWord(ROOM_ID, `w-${i}`, `word-${i}`);
      }
      emitSpy.mockClear();

      await jest.advanceTimersByTimeAsync(2000);

      expect(eventsNamed('word_spawn')).toHaveLength(0);
      expect(session.activeWords.size).toBe(session.maxActiveWords);
    });

    it('adds at most one word when four ACTIVE words exist', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      for (let i = 0; i < 4; i++) addActiveWord(ROOM_ID, `w-${i}`, `word-${i}`);
      mockWordDictionaryService.pickWord.mockReturnValue({
        text: 'new-word',
        keystrokes: 6,
      });

      await jest.advanceTimersByTimeAsync(2000);

      expect(service.getSession(ROOM_ID)!.activeWords.size).toBe(5);
      expect(eventsNamed('word_spawn')).toHaveLength(1);
    });

    it('skips duplicate ACTIVE text after bounded candidate retries', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      addActiveWord(ROOM_ID, 'existing', '테스트');
      emitSpy.mockClear();

      await jest.advanceTimersByTimeAsync(4000);

      expect(eventsNamed('word_spawn')).toHaveLength(0);
      expect(service.getSession(ROOM_ID)!.activeWords.size).toBe(1);
    });

    it('spawns a unique replacement candidate when the picker first returns a duplicate', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      addActiveWord(ROOM_ID, 'existing', '테스트');
      mockWordDictionaryService.pickWord
        .mockReturnValueOnce({ text: '테스트', keystrokes: 6 })
        .mockReturnValueOnce({ text: '고유단어', keystrokes: 7 });

      await jest.advanceTimersByTimeAsync(2000);

      expect(eventsNamed<WordSpawnPayload>('word_spawn')[0].text).toBe(
        '고유단어',
      );
    });
  });

  describe('#136 target, HP, elimination, and ranking', () => {
    const threePlayers: ParticipantPublic[] = [
      {
        participantId: HOST.userId,
        userId: HOST.userId,
        nickname: HOST.nickname,
        type: 'HUMAN',
      },
      {
        participantId: GUEST.userId,
        userId: GUEST.userId,
        nickname: GUEST.nickname,
        type: 'HUMAN',
      },
      {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'player-3',
        type: 'HUMAN',
      },
    ];

    it('uses injected RNG to select one living target and excludes the attacker', async () => {
      randomMock.mockReturnValue(0.99);
      await startParticipants(threePlayers);
      addActiveWord(ROOM_ID, 'w-target', '공격');

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w-target',
        text: '공격',
      });

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.wordCleared.targetParticipantId).toBe('player-3');
        expect(result.targetHpByParticipantId).toEqual({
          [HOST.userId]: 100,
          [GUEST.userId]: 100,
          'player-3': 92,
        });
      }
    });

    it('excludes an eliminated participant from the target candidates', async () => {
      await startParticipants(threePlayers);
      const eliminated = service.getSession(ROOM_ID)!.participants[2];
      eliminated.hp = 0;
      eliminated.status = 'ELIMINATED';
      randomMock.mockReturnValue(0);
      addActiveWord(ROOM_ID, 'w-target', '공격');

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w-target',
        text: '공격',
      });

      expect(result.accepted && result.wordCleared.targetParticipantId).toBe(
        GUEST.userId,
      );
    });

    it('rejects a word_submit from an eliminated participant and leaves everyone else untouched (#157)', async () => {
      await startParticipants(threePlayers);
      const session = service.getSession(ROOM_ID)!;
      const eliminated = session.participants[2];
      eliminated.hp = 0;
      eliminated.status = 'ELIMINATED';
      const hostHpBefore = session.participants[0].hp;
      const guestHpBefore = session.participants[1].hp;
      addActiveWord(ROOM_ID, 'w-elim', '공격');

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: 'player-3',
        wordId: 'w-elim',
        text: '공격',
      });

      assertRejected(result);
      expect(result.reason).toBe('PLAYER_ELIMINATED');
      expect(session.participants[0].hp).toBe(hostHpBefore);
      expect(session.participants[1].hp).toBe(guestHpBefore);
      // 탈락자 본인이 지우려던 단어도 여전히 ACTIVE로 남아 있어야 한다(멋대로 지워지지 않음).
      expect(service.getSession(ROOM_ID)!.activeWords.has('w-elim')).toBe(true);
      expect(eventsNamed('word_cleared')).toHaveLength(0);
    });

    it('clears with zero damage when no living target exists and preserves 1:1 targetHp', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      const guest = service.getSession(ROOM_ID)!.participants[1];
      guest.hp = 0;
      guest.status = 'ELIMINATED';
      service.getSession(ROOM_ID)!.hpByParticipantId[GUEST.userId] = 0;
      addActiveWord(ROOM_ID, 'w-no-target', '공격');

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w-no-target',
        text: '공격',
      });

      expect(result.accepted).toBe(true);
      if (result.accepted) {
        expect(result.damage).toBe(0);
        expect(result.targetHpByParticipantId).toEqual({
          [HOST.userId]: 100,
          [GUEST.userId]: 0,
        });
        expect(eventsNamed('word_cleared')).toHaveLength(1);
      }
    });

    it('broadcasts player_eliminated with a live rank the instant a participant is knocked out mid-match (deploy#68)', async () => {
      await startParticipants(threePlayers);
      const session = service.getSession(ROOM_ID)!;
      const target = session.participants[2];
      target.hp = 8; // addActiveWord() 단어의 damage와 정확히 일치 → 정확히 0으로 탈락
      session.hpByParticipantId['player-3'] = 8;
      randomMock.mockReturnValue(0.99); // HOST/GUEST 중이 아니라 player-3을 타겟으로 선택
      addActiveWord(ROOM_ID, 'w-ko', '공격');

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w-ko',
        text: '공격',
      });

      expect(result.accepted).toBe(true);
      const eliminated = eventsNamed<PlayerEliminatedEventPayload>(
        'player_eliminated',
      );
      expect(eliminated).toHaveLength(1);
      expect(eliminated[0]).toEqual({
        userId: 'player-3',
        rank: 3,
        finalHp: 0,
      });
      // 3인전에서 1명만 탈락했으므로 나머지 둘의 매치는 계속된다.
      expect(eventsNamed('match_end')).toHaveLength(0);
    });

    it('applies one damage event to one target and clamps HP at zero', async () => {
      await startParticipants(threePlayers);
      const target = service.getSession(ROOM_ID)!.participants[1];
      target.hp = 1;
      randomMock.mockReturnValue(0);
      addActiveWord(ROOM_ID, 'w-ko', '공격');

      await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w-ko',
        text: '공격',
      });

      expect(target.hp).toBe(0);
      expect(target.status).toBe('ELIMINATED');
      expect(target.eliminationOrder).toBe(1);
      expect(eventsNamed('word_cleared')).toHaveLength(1);
    });

    it('assigns one elimination order to all participants eliminated by one miss batch', async () => {
      await startParticipants(threePlayers);
      const session = service.getSession(ROOM_ID)!;
      setHp(session, HOST.userId, 3);
      setHp(session, GUEST.userId, 3);
      session.participants[2].hp = 100;
      addActiveWord(ROOM_ID, 'miss-1', '미스1', 0);
      addActiveWord(ROOM_ID, 'miss-2', '미스2', 0);

      await jest.advanceTimersByTimeAsync(200);

      expect(session.participants[0].status).toBe('ELIMINATED');
      expect(session.participants[1].status).toBe('ELIMINATED');
      expect(session.participants[0].eliminationOrder).toBe(
        session.participants[1].eliminationOrder,
      );
    });

    it('uses TIME_LIMIT HP and wordsTyped ordering with competition ranks', async () => {
      await startParticipants([
        ...threePlayers,
        {
          participantId: 'player-4',
          userId: 'player-4',
          nickname: 'player-4',
          type: 'HUMAN',
        },
      ]);
      const session = service.getSession(ROOM_ID)!;
      const values = [
        [100, 2],
        [100, 2],
        [90, 9],
        [80, 1],
      ];
      session.participants.forEach((participant, index) => {
        participant.hp = values[index][0];
        participant.wordsTyped = values[index][1];
        session.hpByParticipantId[participant.participantId] = participant.hp;
      });

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const [payload] = eventsNamed<MatchEndPayload>('match_end');
      expect(payload.ranking).toEqual([
        { participantId: HOST.userId, rank: 1 },
        { participantId: GUEST.userId, rank: 1 },
        { participantId: 'player-3', rank: 3 },
        { participantId: 'player-4', rank: 4 },
      ]);
      expect(payload.winnerId).toBeNull();
    });

    it('TIME_LIMIT ranks a mid-match forfeit below all survivors regardless of stale HP/wordsTyped (backend#185)', async () => {
      await startParticipants([
        ...threePlayers,
        {
          participantId: 'player-4',
          userId: 'player-4',
          nickname: 'player-4',
          type: 'HUMAN',
        },
      ]);
      const session = service.getSession(ROOM_ID)!;

      // player-3 explicitly leaves mid-match — forfeited with high HP/wordsTyped
      // frozen at the moment they left (mirrors leaveMatch/forfeitParticipant).
      const forfeited = session.participants.find(
        (participant) => participant.participantId === 'player-3',
      )!;
      forfeited.status = 'ELIMINATED';
      forfeited.eliminationOrder = 1;
      forfeited.hp = 90;
      forfeited.wordsTyped = 20;
      session.hpByParticipantId['player-3'] = 90;

      setHp(session, HOST.userId, 40);
      setHp(session, GUEST.userId, 10);
      setHp(session, 'player-4', 30);

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const [payload] = eventsNamed<MatchEndPayload>('match_end');
      expect(payload.ranking).toEqual([
        { participantId: HOST.userId, rank: 1 },
        { participantId: 'player-4', rank: 2 },
        { participantId: GUEST.userId, rank: 3 },
        { participantId: 'player-3', rank: 4 },
      ]);
      expect(payload.winnerId).toBe(HOST.userId);
    });

    it('breaks a simultaneous-elimination tie by wordsTyped, higher typing ranking higher (backend#186)', async () => {
      await startParticipants([
        ...threePlayers,
        {
          participantId: 'player-4',
          userId: 'player-4',
          nickname: 'player-4',
          type: 'HUMAN',
        },
      ]);
      const session = service.getSession(ROOM_ID)!;

      // GUEST is eliminated earlier (lower eliminationOrder) — always ranks last
      // regardless of the tie below.
      const guest = session.participants.find(
        (participant) => participant.participantId === GUEST.userId,
      )!;
      guest.status = 'ELIMINATED';
      guest.eliminationOrder = 1;
      guest.hp = 0;
      guest.wordsTyped = 3;
      session.hpByParticipantId[GUEST.userId] = 0;

      // player-3 and player-4 are eliminated in the same batch (e.g. same splash
      // damage) — eliminateBatch() assigns them the identical eliminationOrder.
      const third = session.participants.find(
        (participant) => participant.participantId === 'player-3',
      )!;
      third.status = 'ELIMINATED';
      third.eliminationOrder = 2;
      third.hp = 0;
      third.wordsTyped = 15;
      session.hpByParticipantId['player-3'] = 0;

      const fourth = session.participants.find(
        (participant) => participant.participantId === 'player-4',
      )!;
      fourth.status = 'ELIMINATED';
      fourth.eliminationOrder = 2;
      fourth.hp = 0;
      fourth.wordsTyped = 5;
      session.hpByParticipantId['player-4'] = 0;

      await service.endMatch(ROOM_ID, 'KO', server);

      const [payload] = eventsNamed<MatchEndPayload>('match_end');
      expect(payload.ranking).toEqual([
        { participantId: HOST.userId, rank: 1 },
        { participantId: 'player-3', rank: 2 },
        { participantId: 'player-4', rank: 3 },
        { participantId: GUEST.userId, rank: 4 },
      ]);
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
          hp: { ...result.targetHpByParticipantId },
          targetHpByParticipantId: { ...result.targetHpByParticipantId },
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
      ).toMatchObject({
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
      ).toMatchObject({
        state: 'MISSED',
      });
    });

    it('returns KO metadata when a correct submission brings a player to 0 HP', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      setHp(session, GUEST.userId, 1);

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
      expect(result.targetHpByParticipantId).toEqual({
        [HOST.userId]: 100,
        [GUEST.userId]: 0,
      });
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
      const hpAfterFirst = {
        ...service.getSession(ROOM_ID)!.hpByParticipantId,
      };

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
      expect(service.getSession(ROOM_ID)?.hpByParticipantId).toEqual(
        hpAfterFirst,
      );
    });

    it('rejects an unknown wordId', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
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
      const hpBefore = { ...session.hpByParticipantId };

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: 'intruder-id',
        wordId: word.wordId,
        text: word.text,
      });

      expect(result.accepted).toBe(false);
      assertRejected(result);
      expect(result.reason).toBe('PLAYER_NOT_FOUND');
      expect(result.targetHpByParticipantId).toEqual(hpBefore);
      expect(session.activeWords.has(word.wordId)).toBe(true);
      expect(session.hpByParticipantId).toEqual(hpBefore);
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
      const hpBefore = { ...session.hpByParticipantId };

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
      expect(session.hpByParticipantId).toEqual(hpBefore);
    });

    it('rejects a submission for an already missed word', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      await jest.advanceTimersByTimeAsync(word.fallDurationMs + 200);
      const hpAfterMiss = { ...session.hpByParticipantId };

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
      expect(session.hpByParticipantId).toEqual(hpAfterMiss);
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
      const hpAfterFirst = {
        ...service.getSession(ROOM_ID)!.hpByParticipantId,
      };

      const second = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'same-attempt',
      });

      expect(first.accepted).toBe(true);
      expect(second).toEqual(first);
      expect(service.getSession(ROOM_ID)?.hpByParticipantId).toEqual(
        hpAfterFirst,
      );
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
      ).toMatchObject({
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
      setHp(session, GUEST.userId, 1);

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
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
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
      setHp(session, GUEST.userId, 1);

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
      setHp(session, GUEST.userId, 1);

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
      setHp(session, GUEST.userId, 1);
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
      setHp(session, GUEST.userId, 1);
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
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);
      await jest.advanceTimersByTimeAsync(180_000);

      expect(endMatchSpy).toHaveBeenCalledWith(ROOM_ID, 'TIME_LIMIT', server);
    });

    it('catches TIME_LIMIT finalization failure and retries without repeating match_end', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
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
      setHp(session, HOST.userId, 3);
      setHp(session, GUEST.userId, 50);
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
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      setHp(session, HOST.userId, 40);
      setHp(session, GUEST.userId, 70);

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

    it('a tied TIME_LIMIT is a draw: winnerId is null and neither wins nor losses change', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      setHp(session, HOST.userId, 55);
      setHp(session, GUEST.userId, 55);

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended[0]).toEqual(
        expect.objectContaining({ reason: 'TIME_LIMIT', winnerId: null }),
      );
      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: HOST.userId },
        'draws',
        1,
      );
      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: GUEST.userId },
        'draws',
        1,
      );
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'wins',
        1,
      );
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'losses',
        1,
      );
    });

    it('runs match finalization side effects only once for repeated endMatch calls', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
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
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
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
        service.leaveMatch(ROOM_ID, HOST.userId, server),
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

    it('leaveMatch forfeits only the leaving participant in a 3-player match — the other two keep playing', async () => {
      const THIRD = {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'p3',
        type: 'HUMAN' as const,
      };
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT, THIRD]);

      await service.leaveMatch(ROOM_ID, HOST.userId, server);

      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
      const session = service.getSession(ROOM_ID)!;
      const host = session.participants.find(
        (p) => p.participantId === HOST.userId,
      )!;
      expect(host.status).toBe('ELIMINATED');
      expect(host.hp).toBe(0);
      const survivors = session.participants.filter(
        (p) => p.status === 'ACTIVE',
      );
      expect(survivors.map((p) => p.participantId).sort()).toEqual(
        [GUEST.userId, 'player-3'].sort(),
      );
    });

    it('leaveMatch ends the match once a 3-player forfeit leaves exactly one survivor', async () => {
      const THIRD = {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'p3',
        type: 'HUMAN' as const,
      };
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT, THIRD]);
      const session = service.getSession(ROOM_ID)!;
      const third = session.participants.find(
        (p) => p.participantId === 'player-3',
      )!;
      third.hp = 0;
      third.status = 'ELIMINATED';
      third.eliminationOrder = 1;

      await service.leaveMatch(ROOM_ID, HOST.userId, server);

      const ended = eventsNamed<MatchEndPayload>('match_end');
      expect(ended).toHaveLength(1);
      expect(ended[0]).toEqual(
        expect.objectContaining({ reason: 'FORFEIT', winnerId: GUEST.userId }),
      );
    });

    it('commits match history and stats once when finalization is retried after partial DB failure', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      setHp(session, HOST.userId, 30);
      setHp(session, GUEST.userId, 70);
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);

      const committedHistories: Array<{
        matchData: { reason: string; finalHp: HpByParticipantId };
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
          const txMatchParticipantRepo = {
            create: mockMatchParticipantRepository.create,
            save: jest.fn().mockResolvedValue([]),
          };
          const txUserRepo = {
            findOneBy: mockUserRepository.findOneBy,
            findBy: mockUserRepository.findBy,
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
            getRepository: (target: unknown) => {
              if (target === User) return txUserRepo;
              if (target === MatchParticipant) return txMatchParticipantRepo;
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
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

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
        [HOST.userId]: 30,
        [GUEST.userId]: 70,
      });
      expect(committedHistories[0].winner?.id).toBe(GUEST.userId);
      expect(committedStats[GUEST.userId].wins).toBe(1);
      expect(committedStats[HOST.userId].losses).toBe(1);
      expect(service.getSession(ROOM_ID)).toBeUndefined();
    });
  });

  describe('disconnect / reconnect (#161 — no forced forfeit on disconnect)', () => {
    it('broadcasts opponent_disconnected without a grace deadline and does not end the match even long after the old 30s window', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);

      service.handleDisconnect(ROOM_ID, HOST.userId, server);
      expect(
        eventsNamed<OpponentDisconnectedPayload>('opponent_disconnected'),
      ).toContainEqual({ userId: HOST.userId });

      await jest.advanceTimersByTimeAsync(60_000);

      expect(service.getSession(ROOM_ID)?.status).toBe('IN_PROGRESS');
      const host = session.participants.find(
        (participant) => participant.participantId === HOST.userId,
      )!;
      expect(host.status).toBe('ACTIVE');
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
    });

    it('still lets a disconnected participant be targeted and damaged by others', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      service.handleDisconnect(ROOM_ID, GUEST.userId, server);
      randomMock.mockReturnValue(0);
      addActiveWord(ROOM_ID, 'w-hit-disconnected', '공격');

      const result = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'w-hit-disconnected',
        text: '공격',
      });

      expect(result.accepted && result.wordCleared.targetParticipantId).toBe(
        GUEST.userId,
      );
      expect(
        result.accepted && result.wordCleared.hp[GUEST.userId],
      ).toBeLessThan(100);
    });

    it('sends state_sync and opponent_reconnected on reconnect', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      await jest.advanceTimersByTimeAsync(2000); // one word spawned

      service.handleDisconnect(ROOM_ID, HOST.userId, server);
      await jest.advanceTimersByTimeAsync(2000);

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
    });

    it('sends the latest materialized FULL monitor snapshot only to the reconnecting socket', async () => {
      await startParticipants(
        [
          {
            participantId: HOST.userId,
            userId: HOST.userId,
            nickname: HOST.nickname,
            type: 'HUMAN',
          },
          {
            participantId: 'ai:room-1',
            nickname: 'ACID BOT',
            type: 'AI',
            aiDifficulty: 'NORMAL',
          },
        ],
        'AI_PRACTICE',
      );
      mockAiScheduler.getLatestMonitorSnapshot.mockReturnValue({
        roomId: ROOM_ID,
        participantId: 'ai:room-1',
        stateVersion: 4,
        timestamp: new Date().toISOString(),
        kind: 'FULL',
        currentDecision: {
          action: 'SELECT',
          phase: 'REACTION',
          targetWordId: 'word-1',
          previousTargetWordId: null,
        },
        profile: {
          wpm: 45,
          accuracy: 0.92,
          reactionTimeMs: 650,
          sampleCount: 0,
          confidence: 0,
          source: null,
        },
        executionProfile: {
          difficulty: 'NORMAL',
          typingWpm: 45,
          accuracy: 0.92,
          reactionDelayMs: 650,
          typoProbability: 0.08,
          correctionDelayMs: 150,
          abandonProbability: 0.06,
        },
        candidates: [],
        completedKeystrokes: 0,
        totalKeystrokes: 3,
      });
      const clientEmit = jest.fn<void, [string, unknown]>();
      service.handleReconnect(ROOM_ID, HOST.userId, server, {
        emit: clientEmit,
      } as unknown as Socket);

      expect(clientEmit).toHaveBeenNthCalledWith(
        2,
        'ai_monitor_snapshot',
        expect.objectContaining({ roomId: ROOM_ID, kind: 'FULL' }),
      );
      expect(eventsNamed('ai_monitor_snapshot')).toHaveLength(0);
    });

    const fourPlayers: ParticipantPublic[] = [
      {
        participantId: HOST.userId,
        userId: HOST.userId,
        nickname: HOST.nickname,
        type: 'HUMAN',
      },
      {
        participantId: GUEST.userId,
        userId: GUEST.userId,
        nickname: GUEST.nickname,
        type: 'HUMAN',
      },
      {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'three',
        type: 'HUMAN',
      },
      {
        participantId: 'player-4',
        userId: 'player-4',
        nickname: 'four',
        type: 'HUMAN',
      },
    ];

    it('does not eliminate anyone in a 4-player match when one participant disconnects (#161)', async () => {
      await startParticipants(fourPlayers);
      const session = service.getSession(ROOM_ID)!;
      if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
      if (session.missLoopTimer) clearInterval(session.missLoopTimer);

      service.handleDisconnect(ROOM_ID, 'player-3', server);
      await jest.advanceTimersByTimeAsync(60_000);

      expect(
        session.participants.filter(
          (participant) => participant.status === 'ACTIVE',
        ),
      ).toHaveLength(4);
      expect(eventsNamed<MatchEndPayload>('match_end')).toHaveLength(0);
    });
  });

  describe('spectator snapshot (#70)', () => {
    it('returns a state_sync-shaped snapshot while the match is in progress', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
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
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(service.getSpectatorSnapshot(ROOM_ID)).toBeNull();
    });
  });

  describe('endMatch persistence', () => {
    it('saves MatchHistory with finalHp/wordsTyped/durationSec and updates wins/losses', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(mockMatchHistoryRepository.save).toHaveBeenCalled();
      const saved = mockMatchHistoryRepository.save.mock.calls[0][0] as {
        matchData: {
          finalHp: HpByParticipantId;
          wordsTyped: Record<string, number>;
          durationSec: number;
          reason: string;
        };
      };
      expect(saved.matchData.finalHp).toEqual({
        [HOST.userId]: 100,
        [GUEST.userId]: 100,
      });
      expect(saved.matchData.wordsTyped).toEqual({
        [HOST.userId]: 0,
        [GUEST.userId]: 0,
      });
      expect(saved.matchData.durationSec).toBeGreaterThanOrEqual(0);
      expect(saved.matchData.reason).toBe('TIME_LIMIT');
      expect(mockMatchParticipantRepository.create).toHaveBeenCalledTimes(2);
      expect(mockMatchParticipantRepository.save).toHaveBeenCalledTimes(1);
    });

    it('does not complete finalization when required users are missing from history transaction', async () => {
      await service.startMatch(ROOM_ID, server, TWO_PLAYERS);
      await jest.advanceTimersByTimeAsync(3000);
      let missingGuestOnce = true;
      mockUserRepository.findBy.mockImplementation(
        ({ id }: { id: { value: string[] } }) => {
          const ids = missingGuestOnce
            ? id.value.filter((i) => i !== GUEST.userId)
            : id.value;
          missingGuestOnce = false;
          return Promise.resolve(ids.map((i) => ({ id: i, nickname: i })));
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

    it('N-player TIME_LIMIT: sole rank-1 winner gets wins, everyone else gets losses', async () => {
      const P3 = {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'p3',
        type: 'HUMAN' as const,
      };
      const P4 = {
        participantId: 'player-4',
        userId: 'player-4',
        nickname: 'p4',
        type: 'HUMAN' as const,
      };
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT, P3, P4]);
      const session = service.getSession(ROOM_ID)!;
      setHp(session, HOST.userId, 90);
      setHp(session, GUEST.userId, 40);
      setHp(session, 'player-3', 20);
      setHp(session, 'player-4', 10);

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      expect(mockUserRepository.increment).toHaveBeenCalledWith(
        { id: HOST.userId },
        'wins',
        1,
      );
      for (const loserId of [GUEST.userId, 'player-3', 'player-4']) {
        expect(mockUserRepository.increment).toHaveBeenCalledWith(
          { id: loserId },
          'losses',
          1,
        );
      }
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'draws',
        1,
      );
      expect(mockMatchParticipantRepository.create).toHaveBeenCalledTimes(4);
    });

    it('N-player TIME_LIMIT: a tied rank-1 draws for the tied pair, losses for the rest', async () => {
      const P3 = {
        participantId: 'player-3',
        userId: 'player-3',
        nickname: 'p3',
        type: 'HUMAN' as const,
      };
      const P4 = {
        participantId: 'player-4',
        userId: 'player-4',
        nickname: 'p4',
        type: 'HUMAN' as const,
      };
      await startParticipants([HOST_PARTICIPANT, GUEST_PARTICIPANT, P3, P4]);
      const session = service.getSession(ROOM_ID)!;
      setHp(session, HOST.userId, 80);
      setHp(session, GUEST.userId, 80);
      setHp(session, 'player-3', 30);
      setHp(session, 'player-4', 10);

      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);

      for (const drawId of [HOST.userId, GUEST.userId]) {
        expect(mockUserRepository.increment).toHaveBeenCalledWith(
          { id: drawId },
          'draws',
          1,
        );
      }
      for (const loserId of ['player-3', 'player-4']) {
        expect(mockUserRepository.increment).toHaveBeenCalledWith(
          { id: loserId },
          'losses',
          1,
        );
      }
      expect(mockUserRepository.increment).not.toHaveBeenCalledWith(
        expect.anything(),
        'wins',
        1,
      );
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

  describe('#136 state_sync, idempotency, and cleanup', () => {
    it('restores all active words and participant state for a four-player reconnect', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: 'player-3',
          userId: 'player-3',
          nickname: 'three',
          type: 'HUMAN',
        },
        {
          participantId: 'player-4',
          userId: 'player-4',
          nickname: 'four',
          type: 'HUMAN',
        },
      ]);
      for (let i = 0; i < 5; i++)
        addActiveWord(ROOM_ID, `active-${i}`, `단어-${i}`, 10000 + i);
      const socketEmit = jest.fn<void, [string, unknown]>();
      const socket = { emit: socketEmit } as unknown as Socket;

      service.handleReconnect(ROOM_ID, HOST.userId, server, socket);

      const payload = socketEmit.mock.calls[0][1] as StateSyncPayload;
      expect(payload.activeWords).toHaveLength(5);
      expect(payload.participants).toHaveLength(4);
      expect(
        payload.participants.every((participant) => participant.hp === 100),
      ).toBe(true);
    });

    it('serializes an AI participant without a user id in state_sync', async () => {
      await startParticipants(
        [
          {
            participantId: HOST.userId,
            userId: HOST.userId,
            nickname: HOST.nickname,
            type: 'HUMAN',
          },
          {
            participantId: 'ai:practice',
            nickname: 'ACID BOT',
            type: 'AI',
            aiDifficulty: 'NORMAL',
          },
        ],
        'AI_PRACTICE',
      );
      const socketEmit = jest.fn<void, [string, unknown]>();
      const socket = { emit: socketEmit } as unknown as Socket;

      service.handleReconnect(ROOM_ID, HOST.userId, server, socket);

      const payload = socketEmit.mock.calls[0][1] as StateSyncPayload;
      expect(payload.participants[1]).toEqual(
        expect.objectContaining({ participantId: 'ai:practice', type: 'AI' }),
      );
      expect(payload.participants[1]).not.toHaveProperty('userId');
    });

    it('replays the same attempt without applying a second terminal side effect', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      addActiveWord(ROOM_ID, 'idempotent', '멱등');
      const input = {
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'idempotent',
        text: '멱등',
        attemptId: 'same-attempt',
      };

      const first = await submitWord(input);
      const emitsAfterFirst = eventsNamed('word_cleared').length;
      const second = await submitWord(input);

      expect(second).toEqual(first);
      expect(eventsNamed('word_cleared')).toHaveLength(emitsAfterFirst);
      expect(wordsTypedOf(service.getSession(ROOM_ID)!, HOST.userId)).toBe(1);
    });

    it('resolves submit and miss event-loop races with one terminal transition', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      addActiveWord(ROOM_ID, 'race', '경합', 0);
      const submit = {
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: 'race',
        text: '경합',
        attemptId: 'race-submit',
      };

      const [submitted] = await Promise.all([
        Promise.resolve().then(() => submitWord(submit)),
        Promise.resolve().then(async () => {
          await jest.advanceTimersByTimeAsync(200);
        }),
      ]);

      expect(['CLEARED', 'MISSED']).toContain(
        service.getSession(ROOM_ID)!.resolvedWords.get('race')?.state,
      );
      expect(
        eventsNamed('word_cleared').length + eventsNamed('word_missed').length,
      ).toBeLessThanOrEqual(1);
      expect(
        submitted.accepted || submitted.reason === 'WORD_ALREADY_RESOLVED',
      ).toBe(true);
    });

    it('does not let a stale callback mutate a replacement session with the same room id', async () => {
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      const oldSession = service.getSession(ROOM_ID)!;
      await service.endMatch(ROOM_ID, 'TIME_LIMIT', server);
      await startParticipants([
        {
          participantId: HOST.userId,
          userId: HOST.userId,
          nickname: HOST.nickname,
          type: 'HUMAN',
        },
        {
          participantId: GUEST.userId,
          userId: GUEST.userId,
          nickname: GUEST.nickname,
          type: 'HUMAN',
        },
      ]);
      const replacement = service.getSession(ROOM_ID)!;
      if (replacement.spawnLoopTimer) clearTimeout(replacement.spawnLoopTimer);
      if (replacement.missLoopTimer) clearInterval(replacement.missLoopTimer);
      const spawnLoop = (
        service as unknown as {
          startSpawnLoop: (session: unknown, server: Server) => void;
        }
      ).startSpawnLoop;
      spawnLoop.call(service, oldSession, server);
      await jest.advanceTimersByTimeAsync(2000);

      expect(replacement.activeWords.size).toBe(0);
      expect(eventsNamed('word_spawn')).toHaveLength(0);
    });
  });

  describe('#136 AI practice history', () => {
    it('provides an outbound opponent_typing callback without exposing wordId', async () => {
      let registration:
        | {
            emitTypingProgress: (payload: {
              participantId: string;
              partialText: string;
              wordId?: string;
              phase?: string;
            }) => void;
          }
        | undefined;
      mockAiScheduler.registerRoom.mockImplementation((value: unknown) => {
        registration = value as {
          emitTypingProgress: (payload: {
            participantId: string;
            partialText: string;
            wordId?: string;
            phase?: string;
          }) => void;
        };
      });
      await startParticipants(
        [
          {
            participantId: HOST.userId,
            userId: HOST.userId,
            nickname: HOST.nickname,
            type: 'HUMAN',
          },
          {
            participantId: 'ai:room-1',
            nickname: 'ACID BOT',
            type: 'AI',
            aiDifficulty: 'NORMAL',
          },
        ],
        'AI_PRACTICE',
      );

      registration!.emitTypingProgress({
        participantId: 'ai:room-1',
        partialText: '가',
        wordId: 'private-word',
        phase: 'TYPING',
      });

      expect(emitSpy).toHaveBeenCalledWith('opponent_typing', {
        participantId: 'ai:room-1',
        partialText: '가',
        wordId: 'private-word',
        phase: 'TYPING',
      });
      expect(emitSpy.mock.calls.at(-1)?.[1]).toHaveProperty(
        'wordId',
        'private-word',
      );
    });

    it('broadcasts monitor patches only through the current game room and orders terminal before invalidate', async () => {
      let registration:
        | {
            emitMonitorSnapshot: (payload: {
              roomId: string;
              participantId: string;
              stateVersion: number;
              timestamp: string;
              kind: 'FULL' | 'PHASE' | 'TERMINAL' | 'DECISION';
            }) => void;
          }
        | undefined;
      mockAiScheduler.registerRoom.mockImplementation((value: unknown) => {
        registration = value as typeof registration;
      });
      await startParticipants(
        [
          {
            participantId: HOST.userId,
            userId: HOST.userId,
            nickname: HOST.nickname,
            type: 'HUMAN',
          },
          {
            participantId: 'ai:room-1',
            nickname: 'ACID BOT',
            type: 'AI',
            aiDifficulty: 'NORMAL',
          },
        ],
        'AI_PRACTICE',
      );

      registration!.emitMonitorSnapshot({
        roomId: ROOM_ID,
        participantId: 'ai:room-1',
        stateVersion: 1,
        timestamp: new Date().toISOString(),
        kind: 'PHASE',
      });
      expect(serverToSpy).toHaveBeenCalledWith(`game:${ROOM_ID}`);
      expect(emitSpy).toHaveBeenCalledWith(
        'ai_monitor_snapshot',
        expect.objectContaining({ roomId: ROOM_ID, kind: 'PHASE' }),
      );

      await service.endMatch(ROOM_ID, 'FORFEIT', server);
      expect(
        mockAiScheduler.emitTerminal.mock.invocationCallOrder[0],
      ).toBeLessThan(mockAiScheduler.invalidate.mock.invocationCallOrder[0]);
    });

    it('registers and cleans the AI scheduler through finalizeMatch', async () => {
      await startParticipants(
        [
          {
            participantId: HOST.userId,
            userId: HOST.userId,
            nickname: HOST.nickname,
            type: 'HUMAN',
          },
          {
            participantId: 'ai:room-1',
            nickname: 'ACID BOT',
            type: 'AI',
            aiDifficulty: 'NORMAL',
          },
        ],
        'AI_PRACTICE',
      );

      expect(mockAiScheduler.registerRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          roomId: ROOM_ID,
          aiParticipantId: 'ai:room-1',
          modelPlayerId: HOST.userId,
          difficulty: 'NORMAL',
        }),
      );
      await service.endMatch(ROOM_ID, 'FORFEIT', server);
      expect(mockAiScheduler.invalidate).toHaveBeenCalledWith(ROOM_ID);
      expect(mockAiScheduler.destroy).toHaveBeenCalledWith(ROOM_ID);
    });

    it('does not advance stateVersion for rejected submit and advances for accepted clear', async () => {
      const word = await startAndReachFirstSpawn();
      const session = service.getSession(ROOM_ID)!;
      const beforeRejected = session.stateVersion;
      const rejected = await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: 'wrong',
        attemptId: 'rejected-state-version',
      });
      expect(rejected.accepted).toBe(false);
      expect(session.stateVersion).toBe(beforeRejected);

      await submitWord({
        roomId: ROOM_ID,
        playerId: HOST.userId,
        wordId: word.wordId,
        text: word.text,
        attemptId: 'accepted-state-version',
      });
      expect(session.stateVersion).toBeGreaterThan(beforeRejected);
    });

    it('does not look up an AI participant as a User winner and skips PvP statistics', async () => {
      const aiId = 'ai:practice';
      await startParticipants(
        [
          {
            participantId: HOST.userId,
            userId: HOST.userId,
            nickname: HOST.nickname,
            type: 'HUMAN',
          },
          {
            participantId: aiId,
            nickname: 'ACID BOT',
            type: 'AI',
            aiDifficulty: 'NORMAL',
          },
        ],
        'AI_PRACTICE',
      );
      const session = service.getSession(ROOM_ID)!;
      session.participants[0].hp = 0;
      session.participants[0].status = 'ELIMINATED';
      session.participants[1].hp = 100;
      session.participants[1].status = 'ACTIVE';
      session.hpByParticipantId[HOST.userId] = 0;
      session.hpByParticipantId[aiId] = 100;

      await service.endMatch(ROOM_ID, 'KO', server);

      expect(mockUserRepository.findBy).toHaveBeenCalledTimes(1);
      const [{ id: findByCriteria }] = mockUserRepository.findBy.mock
        .calls[0] as [{ id: { value: string[] } }];
      expect(findByCriteria.value).toEqual([HOST.userId]);
      expect(mockMatchParticipantRepository.create).toHaveBeenCalledTimes(1);
      expect(mockUserRepository.increment).not.toHaveBeenCalled();
      expect(mockMatchHistoryRepository.save).toHaveBeenCalled();
    });
  });
});
