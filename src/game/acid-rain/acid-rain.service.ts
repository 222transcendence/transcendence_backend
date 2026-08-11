import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { MatchHistory } from '../entities/match-history.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import {
  AcidRainSession,
  ActiveWord,
  HpPair,
  MatchEndReason,
  PlayerPublic,
  WordSpawnPayload,
} from './acid-rain.interface';
import { pickWord } from './word-picker';

const INITIAL_HP = 100;
const MATCH_DURATION_MS = 180_000;
const GRACE_PERIOD_MS = 30_000;
const LANE_COUNT = 5;
const REDIS_TTL = 1800; // seconds

@Injectable()
export class AcidRainService implements OnModuleInit {
  private readonly logger = new Logger(AcidRainService.name);
  // roomId → in-memory session (단일 인스턴스 기준)
  private readonly sessions = new Map<string, AcidRainSession>();
  // roomId → grace timer
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly redisService: RedisService,
    @InjectRepository(MatchHistory)
    private readonly matchHistoryRepo: Repository<MatchHistory>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
  ) {}

  async onModuleInit() {
    const updated = await this.userRepo.update(
      { status: UserStatus.IN_GAME },
      { status: UserStatus.ONLINE },
    );
    const client = this.redisService.getClient();
    const keys = await client.keys('game:acidroom:*');
    if (keys.length > 0) await client.del(...keys);
    this.logger.log(
      `Boot cleanup: reset ${updated.affected ?? 0} IN_GAME users, cleared ${keys.length} stale sessions`,
    );
  }

  // ─── 세션 조회 ────────────────────────────────────────────────────────────

  getSession(roomId: string): AcidRainSession | undefined {
    return this.sessions.get(roomId);
  }

  // ─── 매치 시작 ────────────────────────────────────────────────────────────

  async startMatch(
    roomId: string,
    host: PlayerPublic,
    guest: PlayerPublic,
    server: Server,
  ): Promise<void> {
    if (this.sessions.has(roomId)) return; // 이미 진행 중

    const session: AcidRainSession = {
      roomId,
      host,
      guest,
      hp: { host: INITIAL_HP, guest: INITIAL_HP },
      wordsTyped: { host: 0, guest: 0 },
      activeWords: new Map(),
      startedAt: Date.now(),
      spawnLoopTimer: null,
      missLoopTimer: null,
      occupiedLanes: new Set(),
      clearedWords: new Map(),
      status: 'COUNTDOWN',
    };
    this.sessions.set(roomId, session);
    await this.persistSession(session);

    // 두 플레이어 상태 IN_GAME으로 전환
    await this.userRepo.update(
      [host.userId, guest.userId],
      { status: UserStatus.IN_GAME },
    );

    // 3초 카운트다운 후 IN_PROGRESS
    const startAt = new Date(Date.now() + 3000).toISOString();
    const now = new Date().toISOString();
    server.to(`game:${roomId}`).emit('match_start', {
      roomId,
      startAt,
      now,
      initialHp: INITIAL_HP,
    });

    setTimeout(() => {
      session.status = 'IN_PROGRESS';
      session.startedAt = Date.now();
      this.startSpawnLoop(session, server);
      this.startMissLoop(session, server);
      // 180초 후 강제 종료
      setTimeout(() => this.endMatch(roomId, 'TIME_LIMIT', server), MATCH_DURATION_MS);
    }, 3000);
  }

  // ─── 스폰 루프 ────────────────────────────────────────────────────────────

  private startSpawnLoop(session: AcidRainSession, server: Server): void {
    const tick = () => {
      if (session.status !== 'IN_PROGRESS') return;
      const elapsed = (Date.now() - session.startedAt) / 1000;
      const word = pickWord(elapsed);
      const wordId = `w_${randomUUID().slice(0, 8)}`;
      const lane = this.assignLane(session);
      const fallDurationMs = Math.round(
        (4000 + 250 * word.keystrokes) * Math.max(0.6, 1 - elapsed / 300),
      );
      const spawnedAt = new Date().toISOString();

      const active: ActiveWord = {
        wordId,
        text: word.text,
        keystrokes: word.keystrokes,
        lane,
        fallDurationMs,
        spawnedAt,
        landAt: Date.now() + fallDurationMs,
      };
      session.activeWords.set(wordId, active);
      session.occupiedLanes.add(lane);

      const payload: WordSpawnPayload = {
        wordId,
        text: word.text,
        keystrokes: word.keystrokes,
        lane,
        fallDurationMs,
        spawnedAt,
      };
      server.to(`game:${session.roomId}`).emit('word_spawn', payload);
      this.persistSession(session);

      // 다음 스폰 간격 계산 후 재귀 호출
      const interval = Math.max(700, 2000 - 50 * Math.floor(elapsed / 10));
      session.spawnLoopTimer = setTimeout(tick, interval);
    };

    const initialInterval = 2000;
    session.spawnLoopTimer = setTimeout(tick, initialInterval);
  }

  private assignLane(session: AcidRainSession): number {
    for (let i = 0; i < LANE_COUNT; i++) {
      if (!session.occupiedLanes.has(i)) return i;
    }
    return Math.floor(Math.random() * LANE_COUNT);
  }

  // ─── 바닥 도달(미스) 감지 루프 ───────────────────────────────────────────

  private startMissLoop(session: AcidRainSession, server: Server): void {
    session.missLoopTimer = setInterval(() => {
      if (session.status !== 'IN_PROGRESS') return;
      const now = Date.now();
      for (const [wordId, word] of session.activeWords) {
        if (now >= word.landAt) {
          session.activeWords.delete(wordId);
          session.occupiedLanes.delete(word.lane);

          const SPLASH = 3;
          session.hp.host = Math.max(0, session.hp.host - SPLASH);
          session.hp.guest = Math.max(0, session.hp.guest - SPLASH);

          server.to(`game:${session.roomId}`).emit('word_missed', {
            wordId,
            splashDamage: SPLASH,
            targetHp: { ...session.hp },
          });

          if (session.hp.host <= 0 || session.hp.guest <= 0) {
            this.endMatch(session.roomId, 'KO', server);
            return;
          }
        }
      }
    }, 200);
  }

  // ─── 단어 제출 판정 ───────────────────────────────────────────────────────

  judgeSubmit(
    roomId: string,
    userId: string,
    wordId: string,
    text: string,
    server: Server,
  ): void {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return;

    // 멱등: 이미 처리된 단어
    if (session.clearedWords.has(wordId)) {
      server.to(this.socketId(session, userId) ?? `game:${roomId}`).emit('submit_rejected', {
        wordId,
        reason: 'ALREADY_CLEARED',
      });
      return;
    }

    const word = session.activeWords.get(wordId);
    if (!word) {
      this.emitToUser(server, session, userId, 'submit_rejected', {
        wordId,
        reason: 'NOT_FOUND',
      });
      return;
    }

    if (word.text !== text) {
      this.emitToUser(server, session, userId, 'submit_rejected', {
        wordId,
        reason: 'WRONG_TEXT',
      });
      return;
    }

    // 정타 처리
    session.activeWords.delete(wordId);
    session.occupiedLanes.delete(word.lane);
    session.clearedWords.set(wordId, userId);

    const isHost = session.host.userId === userId;
    if (isHost) session.wordsTyped.host++;
    else session.wordsTyped.guest++;

    const damage = 5 + Math.ceil(word.keystrokes / 2);
    if (isHost) session.hp.guest = Math.max(0, session.hp.guest - damage);
    else session.hp.host = Math.max(0, session.hp.host - damage);

    server.to(`game:${roomId}`).emit('word_cleared', {
      wordId,
      clearedBy: userId,
      damage,
      targetHp: { ...session.hp },
    });

    this.persistSession(session);

    if (session.hp.host <= 0 || session.hp.guest <= 0) {
      this.endMatch(roomId, 'KO', server);
    }
  }

  // ─── 재접속 처리 ──────────────────────────────────────────────────────────

  handleDisconnect(roomId: string, userId: string, server: Server): void {
    const session = this.sessions.get(roomId);
    if (!session || session.status === 'FINISHED') return;

    const opponentId =
      session.host.userId === userId ? session.guest.userId : session.host.userId;

    server.to(`game:${roomId}`).emit('opponent_disconnected', {
      userId,
      graceMs: GRACE_PERIOD_MS,
    });

    const timer = setTimeout(() => {
      this.graceTimers.delete(roomId);
      const winnerId = opponentId;
      this.endMatch(roomId, 'FORFEIT', server, winnerId);
    }, GRACE_PERIOD_MS);

    this.graceTimers.set(roomId, timer);
  }

  handleReconnect(roomId: string, userId: string, server: Server, clientSocket: import('socket.io').Socket): void {
    const session = this.sessions.get(roomId);
    if (!session) return;

    // 유예 타이머 취소
    const timer = this.graceTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(roomId);
    }

    server.to(`game:${roomId}`).emit('opponent_reconnected', { userId });

    const elapsed = Date.now() - session.startedAt;
    const spawnInterval = Math.max(700, 2000 - 50 * Math.floor(elapsed / 10000));

    clientSocket.emit('state_sync', {
      roomId,
      hp: { ...session.hp },
      activeWords: Array.from(session.activeWords.values()).map(
        ({ wordId, text, keystrokes, lane, fallDurationMs, spawnedAt }) => ({
          wordId, text, keystrokes, lane, fallDurationMs, spawnedAt,
        }),
      ),
      elapsedMs: elapsed,
      spawnIntervalMs: spawnInterval,
      now: new Date().toISOString(),
    });
  }

  // ─── 매치 종료 ────────────────────────────────────────────────────────────

  async endMatch(
    roomId: string,
    reason: MatchEndReason,
    server: Server,
    overrideWinnerId?: string,
  ): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session || session.status === 'FINISHED') return;
    session.status = 'FINISHED';

    // 루프 정리
    if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
    if (session.missLoopTimer) clearInterval(session.missLoopTimer);

    let winnerId: string | null = overrideWinnerId ?? null;
    if (!winnerId) {
      if (reason === 'KO' || reason === 'TIME_LIMIT') {
        if (session.hp.host > session.hp.guest) winnerId = session.host.userId;
        else if (session.hp.guest > session.hp.host) winnerId = session.guest.userId;
        // 동률 무승부 → null
      }
    }

    const finalHp: HpPair = { ...session.hp };
    const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
    server.to(`game:${roomId}`).emit('match_end', {
      roomId,
      winnerId,
      reason,
      finalHp,
      wordsTyped: { ...session.wordsTyped },
      durationSec,
    });

    this.sessions.delete(roomId);
    await this.redisService.del(`game:acidroom:${roomId}`);

    // 두 플레이어 상태 ONLINE으로 복원
    await this.userRepo.update(
      [session.host.userId, session.guest.userId],
      { status: UserStatus.ONLINE },
    );

    await this.saveMatchHistory(session, winnerId, reason);
    this.logger.log(`Match ${roomId} ended — reason: ${reason}, winner: ${winnerId}`);
  }

  // ─── Redis 영속화 ─────────────────────────────────────────────────────────

  private async persistSession(session: AcidRainSession): Promise<void> {
    const serializable = {
      roomId: session.roomId,
      host: session.host,
      guest: session.guest,
      hp: session.hp,
      wordsTyped: session.wordsTyped,
      startedAt: session.startedAt,
      status: session.status,
      activeWords: Array.from(session.activeWords.entries()),
      clearedWords: Array.from(session.clearedWords.entries()),
    };
    await this.redisService.set(
      `game:acidroom:${session.roomId}`,
      JSON.stringify(serializable),
      REDIS_TTL,
    );
  }

  // ─── MatchHistory 저장 ────────────────────────────────────────────────────

  private async saveMatchHistory(
    session: AcidRainSession,
    winnerId: string | null,
    reason: MatchEndReason,
  ): Promise<void> {
    try {
      const [hostUser, guestUser] = await Promise.all([
        this.userRepo.findOneBy({ id: session.host.userId }),
        this.userRepo.findOneBy({ id: session.guest.userId }),
      ]);
      if (!hostUser || !guestUser) return;

      const winnerUser = winnerId
        ? await this.userRepo.findOneBy({ id: winnerId })
        : null;

      const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
      const history = this.matchHistoryRepo.create({
        hostUser,
        guestUser,
        winner: winnerUser,
        roundsPlayed: 1,
        matchData: {
          finalHp: session.hp,
          wordsTyped: session.wordsTyped,
          durationSec,
          reason,
        },
      });
      await this.matchHistoryRepo.save(history);

      // wins/losses 업데이트
      if (winnerId) {
        const loserId = winnerId === session.host.userId ? session.guest.userId : session.host.userId;
        await Promise.all([
          this.userRepo.increment({ id: winnerId }, 'wins', 1),
          this.userRepo.increment({ id: loserId }, 'losses', 1),
        ]);
      } else {
        // 무승부: 둘 다 losses 증가
        await Promise.all([
          this.userRepo.increment({ id: session.host.userId }, 'losses', 1),
          this.userRepo.increment({ id: session.guest.userId }, 'losses', 1),
        ]);
      }
    } catch (err) {
      this.logger.error('Failed to save MatchHistory', err);
    }
  }

  // ─── 유틸 ─────────────────────────────────────────────────────────────────

  private socketId(session: AcidRainSession, userId: string): string | null {
    // 단순 room emit으로 대체 — 개별 소켓 ID 추적은 gateway가 담당
    return null;
  }

  private emitToUser(
    server: Server,
    session: AcidRainSession,
    userId: string,
    event: string,
    data: unknown,
  ): void {
    // Gateway에서 클라이언트 소켓을 직접 emit하는 방식을 사용하므로
    // 여기서는 room에 emit (Gateway가 ConnectedSocket으로 직접 emit하는 경우 대비)
    server.to(`game:${session.roomId}`).emit(event, data);
  }
}
