import { BadRequestException, ConflictException } from '@nestjs/common';
import { AiPracticeService } from './ai-practice.service';
import { RoomStatus } from './game.interface';

describe('AiPracticeService', () => {
  let service: AiPracticeService;
  let redisStore: Record<string, string>;
  let redisTtls: Record<string, number | undefined>;
  let redisGet: jest.Mock<Promise<string | null>, [string]>;
  let redisDel: jest.Mock<Promise<void>, [string]>;
  let redisClientDel: jest.Mock<Promise<void>, string[]>;
  let redisEval: jest.Mock<Promise<unknown>, [string, number, ...unknown[]]>;

  const USER = {
    id: 'user-1',
    nickname: 'human',
  };
  const REQUEST_ID = 'request_123';

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-12T00:00:00.000Z'));
    redisStore = {};
    redisTtls = {};
    redisGet = jest.fn((key: string) =>
      Promise.resolve(redisStore[key] ?? null),
    );
    redisDel = jest.fn((key: string) => {
      delete redisStore[key];
      delete redisTtls[key];
      return Promise.resolve();
    });
    redisClientDel = jest.fn((...keys: string[]) => {
      keys.forEach((key) => {
        delete redisStore[key];
        delete redisTtls[key];
      });
      return Promise.resolve();
    });
    redisEval = jest.fn(
      (script: string, numberOfKeys: number, ...args: unknown[]) => {
        expect(script).toEqual(expect.any(String));
        expect(numberOfKeys).toBe(3);
        const keys = args.slice(0, 3) as string[];
        if (args.length === 6) {
          keys.forEach((key, index) => {
            if (redisStore[key] === args[index + 3]) {
              delete redisStore[key];
              delete redisTtls[key];
            }
          });
          return Promise.resolve('OK');
        }

        const [idempotencyKey, roomKey, userKey] = keys;
        const idempotencyValue = args[3] as string;
        const roomValue = args[4] as string;
        const userValue = args[5] as string;
        const expiresAt = args[6] as number;
        const difficulty = args[7] as string;
        const existing = redisStore[idempotencyKey];
        if (existing) {
          const record = JSON.parse(existing) as {
            difficulty: string;
            result: { roomId: string };
          };
          if (record.difficulty !== difficulty) {
            return Promise.resolve(['CONFLICT', '']);
          }
          const lock = redisStore[userKey];
          const lockRecord = lock
            ? (JSON.parse(lock) as { roomId: string })
            : null;
          if (
            redisStore[`game:ai-practice:room:${record.result.roomId}`] &&
            lockRecord &&
            lockRecord.roomId === record.result.roomId
          ) {
            return Promise.resolve(['REPLAY', existing]);
          }
          delete redisStore[idempotencyKey];
          delete redisTtls[idempotencyKey];
        }
        const existingLock = redisStore[userKey];
        if (existingLock) {
          const lock = JSON.parse(existingLock) as { roomId: string };
          if (redisStore[`game:ai-practice:room:${lock.roomId}`]) {
            return Promise.resolve(['ACTIVE', '']);
          }
          delete redisStore[userKey];
          delete redisTtls[userKey];
        }
        redisStore[idempotencyKey] = idempotencyValue;
        redisStore[roomKey] = roomValue;
        redisStore[userKey] = userValue;
        redisTtls[idempotencyKey] = expiresAt;
        redisTtls[roomKey] = expiresAt;
        redisTtls[userKey] = expiresAt;
        return Promise.resolve(['CREATED', idempotencyValue]);
      },
    );
    const redisService = {
      get: redisGet,
      del: redisDel,
      getClient: jest.fn(() => ({
        keys: jest.fn((pattern: string) => {
          const prefix = pattern.replace('*', '');
          return Promise.resolve(
            Object.keys(redisStore).filter((key) => key.startsWith(prefix)),
          );
        }),
        del: redisClientDel,
        eval: redisEval,
      })),
    };
    service = new AiPracticeService(redisService as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function hasExceptionResponse(value: unknown): value is {
    getResponse(): unknown;
  } {
    if (typeof value !== 'object' || value === null) return false;
    return (
      typeof (value as { getResponse?: unknown }).getResponse === 'function'
    );
  }

  function responseCode(err: unknown): string | undefined {
    if (hasExceptionResponse(err)) {
      const response = err.getResponse() as { code?: string };
      return response.code;
    }
    return undefined;
  }

  async function expectRejectCode(
    promise: Promise<unknown>,
    errorClass: new (...args: never[]) => Error,
    code: string,
  ): Promise<void> {
    try {
      await promise;
      throw new Error('Expected promise to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(errorClass);
      expect(responseCode(err)).toBe(code);
    }
  }

  async function createPractice(requestId = REQUEST_ID) {
    return service.createAiPractice({
      ownerUserId: USER.id,
      ownerNickname: USER.nickname,
      requestId,
      difficulty: 'NORMAL',
    });
  }

  it('creates private AI practice metadata with HUMAN and AI participants', async () => {
    const result = await createPractice();

    expect(result.mode).toBe('AI_PRACTICE');
    expect(result.roomId).toEqual(expect.any(String));
    expect(result).not.toHaveProperty('matchId');
    expect(result.participants).toEqual([
      {
        participantId: USER.id,
        userId: USER.id,
        nickname: USER.nickname,
        type: 'HUMAN',
      },
      {
        participantId: `ai:${result.roomId}`,
        nickname: 'ACID BOT',
        avatar: '/ai-avatar.svg',
        type: 'AI',
        aiDifficulty: 'NORMAL',
      },
    ]);
    expect(result.participants[1]).not.toHaveProperty('userId');
    expect(Object.keys(redisStore)).toEqual(
      expect.arrayContaining([
        `game:ai-practice:room:${result.roomId}`,
        `game:ai-practice:user:${USER.id}`,
        `game:ai-practice:idempotency:${USER.id}:${REQUEST_ID}`,
      ]),
    );
    expect(new Set(Object.values(redisTtls)).size).toBe(1);
  });

  it('returns the same result for the same requestId and payload', async () => {
    const first = await createPractice();
    const second = await createPractice();

    expect(second).toEqual(first);
    expect(
      Object.keys(redisStore).filter((key) =>
        key.startsWith('game:ai-practice:room:'),
      ),
    ).toHaveLength(1);
  });

  it('rejects the same requestId with a different difficulty', async () => {
    await createPractice();

    await expectRejectCode(
      service.createAiPractice({
        ownerUserId: USER.id,
        ownerNickname: USER.nickname,
        requestId: REQUEST_ID,
        difficulty: 'HARD',
      }),
      ConflictException,
      'DUPLICATE_REQUEST_CONFLICT',
    );
  });

  it('rejects malformed requestId and invalid difficulty', async () => {
    await expect(
      service.createAiPractice({
        ownerUserId: USER.id,
        ownerNickname: USER.nickname,
        requestId: 'bad',
        difficulty: 'NORMAL',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expectRejectCode(
      service.createAiPractice({
        ownerUserId: USER.id,
        ownerNickname: USER.nickname,
        requestId: REQUEST_ID,
        difficulty: 'EASY' as never,
      }),
      BadRequestException,
      'INVALID_DIFFICULTY',
    );
  });

  it('rejects creation while the user is in a public PvP room', async () => {
    redisStore['game:room:public-1'] = JSON.stringify({
      id: 'public-1',
      hostUserId: USER.id,
      maxPlayers: 2,
      status: RoomStatus.WAITING,
      players: [{ userId: USER.id, nickname: USER.nickname, ready: false }],
      createdAt: new Date().toISOString(),
    });

    await expectRejectCode(
      createPractice(),
      ConflictException,
      'ACTIVE_PVP_ROOM_EXISTS',
    );
  });

  it('rejects a second active practice with a new requestId', async () => {
    await createPractice();

    await expectRejectCode(
      createPractice('request_456'),
      ConflictException,
      'ACTIVE_AI_PRACTICE_EXISTS',
    );
  });

  it('rolls back all Redis keys written during creation failure', async () => {
    redisEval.mockRejectedValueOnce(new Error('redis failed'));

    await expectRejectCode(
      createPractice(),
      BadRequestException,
      'CREATE_FAILED',
    );
    expect(Object.keys(redisStore)).toHaveLength(0);
  });

  it('preserves CREATE_FAILED when the atomic script response fails', async () => {
    redisEval.mockRejectedValueOnce(new Error('redis failed'));

    await expectRejectCode(
      createPractice(),
      BadRequestException,
      'CREATE_FAILED',
    );
  });

  it('does not replay an idempotency record when its session is missing', async () => {
    const first = await createPractice();
    delete redisStore[`game:ai-practice:room:${first.roomId}`];
    delete redisStore[`game:ai-practice:user:${USER.id}`];

    const second = await createPractice();

    expect(second.roomId).not.toBe(first.roomId);
  });

  it('cleans a user lock when its room metadata is missing', async () => {
    const first = await createPractice();
    delete redisStore[`game:ai-practice:room:${first.roomId}`];

    await expect(
      service.getActiveAiPracticeForUser(USER.id),
    ).resolves.toBeNull();
    expect(redisStore[`game:ai-practice:user:${USER.id}`]).toBeUndefined();
  });

  it('does not expose a room without its user lock', async () => {
    const first = await createPractice();
    delete redisStore[`game:ai-practice:user:${USER.id}`];

    await expect(
      service.getAiPracticeSession(first.roomId),
    ).resolves.toBeNull();
    expect(redisStore[`game:ai-practice:room:${first.roomId}`]).toBeUndefined();
  });

  it('uses one absolute expiry for all three keys', async () => {
    await createPractice();

    expect(new Set(Object.values(redisTtls)).size).toBe(1);
    expect(redisEval).toHaveBeenCalledTimes(1);
  });

  it('allows exactly one session for concurrent different requestIds', async () => {
    const outcomes = await Promise.allSettled([
      createPractice('request_123'),
      createPractice('request_456'),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      Object.keys(redisStore).filter((key) =>
        key.startsWith('game:ai-practice:room:'),
      ),
    ).toHaveLength(1);
  });

  it('replays the same room and participants for concurrent identical requests', async () => {
    const outcomes = await Promise.all([createPractice(), createPractice()]);

    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[1].participants[1].participantId).toBe(
      outcomes[0].participants[1].participantId,
    );
  });

  it('resolves concurrent same requestId conflicts deterministically', async () => {
    const outcomes = await Promise.allSettled([
      createPractice(),
      service.createAiPractice({
        ...USER,
        ownerUserId: USER.id,
        ownerNickname: USER.nickname,
        requestId: REQUEST_ID,
        difficulty: 'HARD',
      }),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === 'rejected'),
    ).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(responseCode(rejected?.reason)).toBe('DUPLICATE_REQUEST_CONFLICT');
  });

  it('does not let an ambiguous failure remove another request success', async () => {
    redisEval.mockRejectedValueOnce(new Error('ambiguous response'));

    const outcomes = await Promise.allSettled([
      createPractice('request_123'),
      createPractice('request_456'),
    ]);

    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(
      true,
    );
    const roomKeys = Object.keys(redisStore).filter((key) =>
      key.startsWith('game:ai-practice:room:'),
    );
    expect(roomKeys).toHaveLength(1);
    const roomId = roomKeys[0].split(':').pop();
    expect(redisStore[`game:ai-practice:user:${USER.id}`]).toContain(roomId);
    expect(
      Object.keys(redisStore).filter((key) =>
        key.startsWith(`game:ai-practice:idempotency:${USER.id}:`),
      ),
    ).toHaveLength(1);
  });

  it('keeps practice metadata after a plain lobby disconnect equivalent', async () => {
    const result = await createPractice();

    expect(await service.getActiveAiPracticeForUser(USER.id)).toMatchObject({
      roomId: result.roomId,
      ownerUserId: USER.id,
    });
  });

  it('cleans room, user lock, and idempotency on explicit cancel', async () => {
    const result = await createPractice();

    await service.cancelAiPractice(USER.id, result.roomId);

    expect(Object.keys(redisStore)).toHaveLength(0);
  });

  it('allows a new requestId after explicit cancel', async () => {
    const first = await createPractice();
    await service.cancelAiPractice(USER.id, first.roomId);

    const second = await createPractice('request_456');

    expect(second.roomId).not.toBe(first.roomId);
  });

  it('allows the cancelled requestId to create a new session', async () => {
    const first = await createPractice();
    await service.cancelAiPractice(USER.id, first.roomId);

    const second = await createPractice();

    expect(second.roomId).not.toBe(first.roomId);
  });

  it('cleans stale practice metadata when TTL window has expired', async () => {
    const result = await createPractice();
    jest.setSystemTime(new Date('2026-08-12T00:10:01.000Z'));

    await expect(
      service.getActiveAiPracticeForUser(USER.id),
    ).resolves.toBeNull();
    expect(redisClientDel).toHaveBeenCalledWith(
      `game:ai-practice:room:${result.roomId}`,
      `game:ai-practice:user:${USER.id}`,
      `game:ai-practice:idempotency:${USER.id}:${REQUEST_ID}`,
    );
  });

  it('keeps metadata valid without an AI socket', async () => {
    const result = await createPractice();

    await expect(service.getAiPracticeSession(result.roomId)).resolves.toEqual(
      expect.objectContaining({
        roomId: result.roomId,
        participants: result.participants,
      }),
    );
  });
});
