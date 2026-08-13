import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';
import type { AiDifficulty } from './acid-rain/acid-rain.interface';
import { GameRoom, RoomStatus } from './game.interface';
import {
  AI_PRACTICE_MODE,
  AiPracticeCreatedPayload,
  AiPracticeIdempotencyRecord,
  AiPracticeRejectCode,
  AiPracticeSession,
  CreateAiPracticeInput,
} from './ai-practice.interface';

const AI_PRACTICE_TTL_SECONDS = 600;
const AI_PRACTICE_ROOM_PREFIX = 'game:ai-practice:room:';
const AI_PRACTICE_USER_PREFIX = 'game:ai-practice:user:';
const AI_PRACTICE_IDEMPOTENCY_PREFIX = 'game:ai-practice:idempotency:';
const VALID_AI_DIFFICULTIES = new Set<AiDifficulty>([
  'BEGINNER',
  'NORMAL',
  'HARD',
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

const CREATE_AI_PRACTICE_SCRIPT = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local decoded, record = pcall(cjson.decode, existing)
  if decoded and record.difficulty == ARGV[5] then
    local room = redis.call('GET', KEYS[2])
    local lock = redis.call('GET', KEYS[3])
    local lockDecoded, lockRecord = pcall(cjson.decode, lock or '')
    if room and lockDecoded and lockRecord.roomId == record.result.roomId then
      return { 'REPLAY', existing }
    end
  elseif decoded and record.difficulty ~= ARGV[5] then
    return { 'CONFLICT', '' }
  end
  redis.call('DEL', KEYS[1])
end

local existingLock = redis.call('GET', KEYS[3])
if existingLock then
  local lockDecoded, lockRecord = pcall(cjson.decode, existingLock)
  if not lockDecoded then
    return { 'ACTIVE', '' }
  end
  local existingRoom = redis.call('GET', 'game:ai-practice:room:' .. lockRecord.roomId)
  if existingRoom then
    return { 'ACTIVE', '' }
  end
  redis.call('DEL', KEYS[3])
end

redis.call('SET', KEYS[1], ARGV[1], 'PXAT', ARGV[4])
redis.call('SET', KEYS[2], ARGV[2], 'PXAT', ARGV[4])
redis.call('SET', KEYS[3], ARGV[3], 'PXAT', ARGV[4])
return { 'CREATED', ARGV[1] }
`;

const CONDITIONAL_DELETE_SCRIPT = `
for index = 1, #KEYS do
  if redis.call('GET', KEYS[index]) == ARGV[index] then
    redis.call('DEL', KEYS[index])
  end
end
return 'OK'
`;

interface AiPracticeUserLock {
  roomId: string;
  expiresAt: string;
}

@Injectable()
export class AiPracticeService {
  constructor(private readonly redisService: RedisService) {}

  async createAiPractice(
    input: CreateAiPracticeInput,
  ): Promise<AiPracticeCreatedPayload> {
    this.assertValidRequest(input.requestId, input.difficulty);

    const idempotencyKey = this.idempotencyKey(
      input.ownerUserId,
      input.requestId,
    );
    await this.assertNoActivePublicRoom(input.ownerUserId);

    const roomId = randomUUID();
    const createdAtMs = Date.now();
    const expiresAtMs = createdAtMs + AI_PRACTICE_TTL_SECONDS * 1000;
    const createdAt = new Date(createdAtMs).toISOString();
    const expiresAt = new Date(expiresAtMs).toISOString();
    const result = this.createResult(input, roomId, expiresAt);
    const session: AiPracticeSession = {
      mode: AI_PRACTICE_MODE,
      roomId,
      ownerUserId: input.ownerUserId,
      difficulty: input.difficulty,
      participants: result.participants,
      status: 'CREATED',
      createdAt,
      expiresAt,
    };
    const idempotencyRecord: AiPracticeIdempotencyRecord = {
      requestId: input.requestId,
      ownerUserId: input.ownerUserId,
      difficulty: input.difficulty,
      result,
      createdAt,
      expiresAt,
    };
    const roomKey = this.roomKey(roomId);
    const userKey = this.userKey(input.ownerUserId);
    const idempotencyValue = JSON.stringify(idempotencyRecord);
    const roomValue = JSON.stringify(session);
    const userValue = JSON.stringify({
      roomId,
      expiresAt,
    } satisfies AiPracticeUserLock);
    let response: [string, string];
    try {
      response = (await this.redisService
        .getClient()
        .eval(
          CREATE_AI_PRACTICE_SCRIPT,
          3,
          idempotencyKey,
          roomKey,
          userKey,
          idempotencyValue,
          roomValue,
          userValue,
          expiresAtMs,
          input.difficulty,
        )) as [string, string];
    } catch (err) {
      const reconciled = await this.reconcileAmbiguousCreate(
        idempotencyKey,
        roomKey,
        userKey,
        idempotencyValue,
        roomValue,
        userValue,
        result,
      );
      if (reconciled) return reconciled;
      throw new BadRequestException({
        code: 'CREATE_FAILED' satisfies AiPracticeRejectCode,
        message: 'Failed to create AI practice session',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    return this.handleCreateResult(response[0], response[1]);
  }

  async getActiveAiPracticeForUser(
    userId: string,
  ): Promise<AiPracticeSession | null> {
    const userKey = this.userKey(userId);
    const lock = await this.getJson<AiPracticeUserLock>(userKey);
    if (!lock) return null;

    const session = await this.getAiPracticeSession(lock.roomId);
    if (!session || this.isExpiredIso(lock.expiresAt, session.expiresAt)) {
      await this.cleanupByRoomId(lock.roomId, userId);
      return null;
    }
    return session;
  }

  async assertNoActivePractice(userId: string): Promise<void> {
    const activePractice = await this.getActiveAiPracticeForUser(userId);
    if (activePractice) {
      this.throwConflict(
        'ACTIVE_AI_PRACTICE_EXISTS',
        'User already has an active AI practice session',
      );
    }
  }

  async getAiPracticeSession(
    roomId: string,
  ): Promise<AiPracticeSession | null> {
    const session = await this.getJson<AiPracticeSession>(this.roomKey(roomId));
    if (!session) return null;
    const lock = await this.getJson<AiPracticeUserLock>(
      this.userKey(session.ownerUserId),
    );
    if (!lock || lock.roomId !== roomId) {
      await this.cleanupByRoomId(roomId, session.ownerUserId);
      return null;
    }
    if (this.isExpiredIso(session.expiresAt)) {
      await this.cleanupByRoomId(roomId, session.ownerUserId);
      return null;
    }
    return session;
  }

  async cancelAiPractice(userId: string, roomId?: string): Promise<void> {
    const active = await this.getActiveAiPracticeForUser(userId);
    if (!active) return;
    if (roomId && active.roomId !== roomId) {
      this.throwConflict(
        'AI_PRACTICE_NOT_FOUND',
        'AI practice session not found for this user',
      );
    }
    try {
      await this.cleanupByRoomId(active.roomId, userId);
    } catch (err) {
      throw new BadRequestException({
        code: 'CLEANUP_FAILED' satisfies AiPracticeRejectCode,
        message: 'Failed to clean up AI practice session',
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private createResult(
    input: CreateAiPracticeInput,
    roomId: string,
    expiresAt: string,
  ): AiPracticeCreatedPayload {
    return {
      roomId,
      mode: AI_PRACTICE_MODE,
      difficulty: input.difficulty,
      participants: [
        {
          participantId: input.ownerUserId,
          userId: input.ownerUserId,
          nickname: input.ownerNickname,
          avatar: input.ownerAvatar,
          type: 'HUMAN',
        },
        {
          participantId: `ai:${roomId}`,
          nickname: 'ACID BOT',
          avatar: '/ai-avatar.svg',
          type: 'AI',
          aiDifficulty: input.difficulty,
        },
      ],
      expiresAt,
    };
  }

  private assertValidRequest(
    requestId: string,
    difficulty: AiDifficulty,
  ): void {
    if (!REQUEST_ID_PATTERN.test(requestId)) {
      throw new BadRequestException({
        code: 'INVALID_PAYLOAD' satisfies AiPracticeRejectCode,
        message:
          'requestId must be 8-128 characters and contain only letters, numbers, underscores, or hyphens',
      });
    }
    if (!VALID_AI_DIFFICULTIES.has(difficulty)) {
      throw new BadRequestException({
        code: 'INVALID_DIFFICULTY' satisfies AiPracticeRejectCode,
        message: 'difficulty must be BEGINNER, NORMAL, or HARD',
      });
    }
  }

  private async assertNoActivePublicRoom(userId: string): Promise<void> {
    const keys = await this.redisService.getClient().keys('game:room:*');
    for (const key of keys) {
      const data = await this.redisService.get(key);
      if (!data) continue;
      const room = JSON.parse(data) as GameRoom;
      if (
        room.status !== RoomStatus.FINISHED &&
        room.players.some((player) => player.userId === userId)
      ) {
        this.throwConflict(
          'ACTIVE_PVP_ROOM_EXISTS',
          'User is already in a public PvP room or game',
        );
      }
    }
  }

  private async cleanupByRoomId(
    roomId: string,
    fallbackUserId?: string,
  ): Promise<void> {
    const session = await this.getJson<AiPracticeSession>(this.roomKey(roomId));
    const ownerUserId = session?.ownerUserId ?? fallbackUserId;
    const keys = [this.roomKey(roomId)];
    const userLock = ownerUserId
      ? await this.getJson<AiPracticeUserLock>(this.userKey(ownerUserId))
      : null;
    if (ownerUserId && (!userLock || userLock.roomId === roomId)) {
      keys.push(this.userKey(ownerUserId));
      keys.push(...(await this.findIdempotencyKeys(ownerUserId, roomId)));
    }
    await this.deleteKeys(keys);
  }

  private async findIdempotencyKeys(
    ownerUserId: string,
    roomId: string,
  ): Promise<string[]> {
    const pattern = `${AI_PRACTICE_IDEMPOTENCY_PREFIX}${ownerUserId}:*`;
    const keys = await this.redisService.getClient().keys(pattern);
    const matching: string[] = [];
    for (const key of keys) {
      const record = await this.getJson<AiPracticeIdempotencyRecord>(key);
      if (record?.result.roomId === roomId) matching.push(key);
    }
    return matching;
  }

  private async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.redisService.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  }

  private isExpiredIso(...expiresAtValues: string[]): boolean {
    return expiresAtValues.some(
      (expiresAt) => Date.parse(expiresAt) <= Date.now(),
    );
  }

  private async deleteKeys(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redisService.getClient().del(...keys);
  }

  private handleCreateResult(
    code: string,
    value: string,
  ): AiPracticeCreatedPayload {
    if (code === 'CONFLICT') {
      this.throwConflict(
        'DUPLICATE_REQUEST_CONFLICT',
        'Same requestId was already used with a different difficulty',
      );
    }
    if (code === 'ACTIVE') {
      this.throwConflict(
        'ACTIVE_AI_PRACTICE_EXISTS',
        'User already has an active AI practice session',
      );
    }
    if (code !== 'CREATED' && code !== 'REPLAY') {
      throw new Error(`Unexpected AI practice result: ${code}`);
    }
    const record = JSON.parse(value) as AiPracticeIdempotencyRecord;
    return record.result;
  }

  private async reconcileAmbiguousCreate(
    idempotencyKey: string,
    roomKey: string,
    userKey: string,
    idempotencyValue: string,
    roomValue: string,
    userValue: string,
    result: AiPracticeCreatedPayload,
  ): Promise<AiPracticeCreatedPayload | null> {
    let actualIdempotency: string | null;
    let actualRoom: string | null;
    let actualUser: string | null;
    try {
      [actualIdempotency, actualRoom, actualUser] = await Promise.all([
        this.redisService.get(idempotencyKey),
        this.redisService.get(roomKey),
        this.redisService.get(userKey),
      ]);
    } catch {
      return null;
    }
    if (
      actualIdempotency === idempotencyValue &&
      actualRoom === roomValue &&
      actualUser === userValue
    ) {
      return result;
    }
    try {
      await this.redisService
        .getClient()
        .eval(
          CONDITIONAL_DELETE_SCRIPT,
          3,
          idempotencyKey,
          roomKey,
          userKey,
          idempotencyValue,
          roomValue,
          userValue,
        );
    } catch {
      // Preserve the original error. Any remaining keys retain their TTL.
    }
    return null;
  }

  private throwConflict(code: AiPracticeRejectCode, message: string): never {
    throw new ConflictException({ code, message });
  }

  private roomKey(roomId: string): string {
    return `${AI_PRACTICE_ROOM_PREFIX}${roomId}`;
  }

  private userKey(userId: string): string {
    return `${AI_PRACTICE_USER_PREFIX}${userId}`;
  }

  private idempotencyKey(userId: string, requestId: string): string {
    return `${AI_PRACTICE_IDEMPOTENCY_PREFIX}${userId}:${requestId}`;
  }
}
