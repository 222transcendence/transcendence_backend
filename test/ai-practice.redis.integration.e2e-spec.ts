import Redis from 'ioredis';
import { AiPracticeService } from '../src/game/ai-practice.service';

const enabled =
  process.env.AI_INTEGRATION === '1' &&
  process.env.AI_REDIS_INTEGRATION === '1';
const describeRedis = enabled ? describe : describe.skip;

describeRedis('AI practice Redis integration', () => {
  let redis: Redis;
  let service: AiPracticeService;
  const ownerUserId = 'ai110-redis-integration-user';
  const redisKeys = [
    `game:ai-practice:user:${ownerUserId}`,
    `game:ai-practice:idempotency:${ownerUserId}:ai110-redis-001`,
    `game:ai-practice:idempotency:${ownerUserId}:ai110-redis-002`,
  ];

  beforeAll(async () => {
    redis = new Redis(
      process.env.AI_TEST_REDIS_URL || 'redis://localhost:6379',
    );
    await redis.ping();
    service = new AiPracticeService({
      get: (key: string) => redis.get(key),
      getClient: () => redis,
    } as never);
  });

  beforeEach(async () => {
    await redis.del(...redisKeys);
    const roomKeys = await redis.keys('game:ai-practice:room:*');
    if (roomKeys.length > 0) await redis.del(...roomKeys);
  });

  afterAll(async () => {
    await redis.del(...redisKeys);
    await redis.quit();
  });

  const input = (
    requestId: string,
    difficulty: 'BEGINNER' | 'NORMAL' | 'HARD' = 'NORMAL',
  ) => ({
    ownerUserId,
    ownerNickname: 'AI Redis Test User',
    ownerAvatar: 'test.png',
    requestId,
    difficulty,
  });

  it('creates, replays idempotently, exposes TTL, and cancels the same session', async () => {
    const first = await service.createAiPractice(input('ai110-redis-001'));
    const replay = await service.createAiPractice(input('ai110-redis-001'));

    expect(replay).toEqual(first);
    expect(await redis.exists(`game:ai-practice:room:${first.roomId}`)).toBe(1);
    expect(
      await redis.pttl(`game:ai-practice:room:${first.roomId}`),
    ).toBeGreaterThan(0);

    await service.cancelAiPractice(ownerUserId, first.roomId);
    expect(await service.getActiveAiPracticeForUser(ownerUserId)).toBeNull();
    expect(await redis.exists(`game:ai-practice:room:${first.roomId}`)).toBe(0);
  });

  it('rejects a request conflict and atomically permits only one concurrent session', async () => {
    await service.createAiPractice(input('ai110-redis-001'));
    await expect(
      service.createAiPractice(input('ai110-redis-001', 'HARD')),
    ).rejects.toMatchObject({
      response: { code: 'DUPLICATE_REQUEST_CONFLICT' },
    });

    await service.cancelAiPractice(ownerUserId);
    const results = await Promise.allSettled([
      service.createAiPractice(input('ai110-redis-001')),
      service.createAiPractice(input('ai110-redis-002', 'HARD')),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });

  it('does not delete a replacement room when stale cleanup targets the old room', async () => {
    const first = await service.createAiPractice(input('ai110-redis-001'));
    await service.cancelAiPractice(ownerUserId, first.roomId);
    const second = await service.createAiPractice(
      input('ai110-redis-002', 'HARD'),
    );

    expect(await service.getAiPracticeSession(second.roomId)).toMatchObject({
      roomId: second.roomId,
      difficulty: 'HARD',
    });
    expect(await redis.exists(`game:ai-practice:room:${second.roomId}`)).toBe(
      1,
    );
  });
});
