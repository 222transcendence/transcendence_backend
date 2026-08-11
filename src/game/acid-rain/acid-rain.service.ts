import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { LobbyService } from '../../lobby/lobby.service';
import { MatchHistory, MatchMode } from '../entities/match-history.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import {
  AcidRainSession,
  ActiveWord,
  HpPair,
  JudgeRejectionReason,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  MatchEndReason,
  PlayerPublic,
  SubmitRejectedReason,
  WordSpawnPayload,
  WordResolutionState,
} from './acid-rain.interface';
import { pickWord } from './word-picker';

const INITIAL_HP = 100;
const MATCH_DURATION_MS = 180_000;
const GRACE_PERIOD_MS = 30_000;
const LANE_COUNT = 5;
const REDIS_TTL = 1800; // seconds
const ATTEMPT_RESULT_TTL_MS = 5 * 60 * 1000;
const MATCH_END_RETRY_DELAY_MS = 1000;

type FinalizationStatus = 'PENDING' | 'COMPLETED' | 'FAILED';

interface ProcessedAttemptRecord {
  roomId: string;
  playerId: string;
  attemptId: string;
  wordId: string;
  text: string;
  result: JudgeWordSubmitResult;
  expiresAt: number;
  finalizationStatus?: FinalizationStatus;
}

interface JudgeCoreOutcome {
  result: JudgeWordSubmitResult;
  replayed: boolean;
  attemptKey?: string;
  finalizationStatus?: FinalizationStatus;
  sessionToPersist?: AcidRainSession;
}

interface MatchFinalizationState {
  snapshot: MatchFinalizationSnapshot;
  matchEndEmitted: boolean;
  acidRoomDeleted: boolean;
  lobbyRoomDeleted: boolean;
  roomClosedBroadcast: boolean;
  usersOnline: boolean;
  historySaved: boolean;
}

interface MatchFinalizationSnapshot {
  reason: MatchEndReason;
  winnerId: string | null;
  finalHp: HpPair;
  wordsTyped: { host: number; guest: number };
  durationSec: number;
}

@Injectable()
export class AcidRainService implements OnModuleInit {
  private readonly logger = new Logger(AcidRainService.name);
  // roomId → in-memory session (단일 인스턴스 기준)
  private readonly sessions = new Map<string, AcidRainSession>();
  // roomId → grace timer
  private readonly graceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly processedAttempts = new Map<
    string,
    ProcessedAttemptRecord
  >();
  private readonly endingMatches = new Map<string, Promise<void>>();
  private readonly matchFinalizations = new Map<
    string,
    MatchFinalizationState
  >();
  private readonly pendingSessionPersists = new Map<string, Promise<void>>();
  private readonly matchEndRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly redisService: RedisService,
    private readonly lobbyService: LobbyService,
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
      countdownTimer: null,
      spawnLoopTimer: null,
      missLoopTimer: null,
      matchEndTimer: null,
      occupiedLanes: new Set(),
      resolvedWords: new Map(),
      status: 'COUNTDOWN',
    };
    this.sessions.set(roomId, session);
    await this.persistSession(session);

    // 두 플레이어 상태 IN_GAME으로 전환
    await this.userRepo.update([host.userId, guest.userId], {
      status: UserStatus.IN_GAME,
    });

    // 3초 카운트다운 후 IN_PROGRESS
    const startAt = new Date(Date.now() + 3000).toISOString();
    const now = new Date().toISOString();
    server.to(`game:${roomId}`).emit('match_start', {
      roomId,
      startAt,
      now,
      initialHp: INITIAL_HP,
    });

    session.countdownTimer = setTimeout(() => {
      session.status = 'IN_PROGRESS';
      session.startedAt = Date.now();
      this.startSpawnLoop(session, server);
      this.startMissLoop(session, server);
      // 180초 후 강제 종료
      session.matchEndTimer = setTimeout(
        () => this.safeEndMatch(roomId, 'TIME_LIMIT', server),
        MATCH_DURATION_MS,
      );
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
      void this.persistSession(session);

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
          session.resolvedWords.set(wordId, { state: 'MISSED' });

          const SPLASH = 3;
          session.hp.host = Math.max(0, session.hp.host - SPLASH);
          session.hp.guest = Math.max(0, session.hp.guest - SPLASH);

          server.to(`game:${session.roomId}`).emit('word_missed', {
            wordId,
            splashDamage: SPLASH,
            targetHp: { ...session.hp },
          });

          if (session.hp.host <= 0 || session.hp.guest <= 0) {
            this.safeEndMatch(session.roomId, 'KO', server);
            return;
          }

          void this.persistSession(session);
        }
      }
    }, 200);
  }

  // ─── 단어 제출 판정 ───────────────────────────────────────────────────────

  async submitWord(
    input: JudgeWordSubmitInput,
    server: Server,
  ): Promise<JudgeWordSubmitResult> {
    const outcome = this.judgeWordSubmitCore(input);
    const result = outcome.result;

    if (outcome.replayed) {
      if (
        result.accepted &&
        result.gameEnded &&
        outcome.attemptKey &&
        outcome.finalizationStatus !== 'COMPLETED'
      ) {
        await this.finalizeKoAttempt(outcome.attemptKey, result, server);
      }
      return result;
    }

    if (result.accepted) {
      server
        .to(`game:${result.roomId}`)
        .emit('word_cleared', result.wordCleared);
      if (result.gameEnded && outcome.attemptKey) {
        await this.finalizeKoAttempt(outcome.attemptKey, result, server);
      } else if (result.gameEnded) {
        await this.endMatch(result.roomId, 'KO', server);
      } else if (outcome.sessionToPersist) {
        await this.persistSession(outcome.sessionToPersist);
      }
    }

    return result;
  }

  private judgeWordSubmitCore(input: JudgeWordSubmitInput): JudgeCoreOutcome {
    const { roomId, playerId, wordId, text, attemptId } = input;
    this.cleanupExpiredAttempts();

    const attemptKey = this.attemptKey(input);
    if (attemptKey) {
      const stored = this.processedAttempts.get(attemptKey);
      if (stored) {
        return {
          result: this.cloneJudgeResult(stored.result),
          replayed: true,
          attemptKey,
          finalizationStatus: stored.finalizationStatus,
        };
      }
    }

    const session = this.sessions.get(roomId);
    if (!session) {
      return {
        result: this.rejected(input, 'ROOM_NOT_FOUND'),
        replayed: false,
      };
    }

    if (session.status !== 'IN_PROGRESS') {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(input, 'GAME_NOT_ACTIVE', undefined, session),
      );
    }

    if (!this.isParticipant(session, playerId)) {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(input, 'PLAYER_NOT_FOUND', undefined, session),
      );
    }

    const resolved = session.resolvedWords.get(wordId);
    if (resolved) {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(input, 'WORD_ALREADY_RESOLVED', resolved.state, session),
      );
    }

    const word = session.activeWords.get(wordId);
    if (!word) {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(input, 'WORD_NOT_FOUND', undefined, session),
      );
    }

    if (word.text !== text) {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(input, 'INCORRECT_TEXT', 'ACTIVE', session),
      );
    }

    session.activeWords.delete(wordId);
    session.occupiedLanes.delete(word.lane);
    session.resolvedWords.set(wordId, {
      state: 'CLEARED',
      playerId,
      attemptId,
    });

    const isHost = session.host.userId === playerId;
    if (isHost) session.wordsTyped.host++;
    else session.wordsTyped.guest++;

    const damage = 5 + Math.ceil(word.keystrokes / 2);
    if (isHost) session.hp.guest = Math.max(0, session.hp.guest - damage);
    else session.hp.host = Math.max(0, session.hp.host - damage);

    const gameEnded = session.hp.host <= 0 || session.hp.guest <= 0;
    const winnerId = gameEnded ? this.determineWinner(session) : null;
    const loserId = winnerId
      ? winnerId === session.host.userId
        ? session.guest.userId
        : session.host.userId
      : null;
    const wordCleared = {
      wordId,
      clearedBy: playerId,
      damage,
      targetHp: { ...session.hp },
    };

    const result: JudgeWordSubmitResult = {
      accepted: true,
      roomId,
      playerId,
      wordId,
      attemptId,
      wordStateBefore: 'ACTIVE',
      wordStateAfter: 'CLEARED',
      damage,
      targetHp: { ...session.hp },
      gameEnded,
      winnerId,
      loserId,
      endReason: gameEnded ? 'KO' : null,
      wordCleared,
    };
    return this.recordOutcome(attemptKey, input, result, session);
  }

  // ─── 재접속 처리 ──────────────────────────────────────────────────────────

  handleDisconnect(roomId: string, userId: string, server: Server): void {
    const session = this.sessions.get(roomId);
    if (!session || session.status === 'FINISHED') return;

    const opponentId =
      session.host.userId === userId
        ? session.guest.userId
        : session.host.userId;

    server.to(`game:${roomId}`).emit('opponent_disconnected', {
      userId,
      graceMs: GRACE_PERIOD_MS,
    });

    const timer = setTimeout(() => {
      this.graceTimers.delete(roomId);
      const winnerId = opponentId;
      this.safeEndMatch(roomId, 'FORFEIT', server, winnerId);
    }, GRACE_PERIOD_MS);

    this.graceTimers.set(roomId, timer);
  }

  handleReconnect(
    roomId: string,
    userId: string,
    server: Server,
    clientSocket: import('socket.io').Socket,
  ): void {
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
    const spawnInterval = Math.max(
      700,
      2000 - 50 * Math.floor(elapsed / 10000),
    );

    clientSocket.emit('state_sync', {
      roomId,
      hp: { ...session.hp },
      activeWords: Array.from(session.activeWords.values()).map(
        ({ wordId, text, keystrokes, lane, fallDurationMs, spawnedAt }) => ({
          wordId,
          text,
          keystrokes,
          lane,
          fallDurationMs,
          spawnedAt,
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
    const existing = this.endingMatches.get(roomId);
    if (existing) return existing;

    const session = this.sessions.get(roomId);
    if (!session) return;

    const promise = this.finalizeMatch(
      session,
      roomId,
      reason,
      server,
      overrideWinnerId,
    );
    this.endingMatches.set(roomId, promise);
    try {
      await promise;
    } catch (err) {
      this.logger.error('Failed to finalize Acid Rain match', err);
      this.scheduleEndMatchRetry(roomId, reason, server, overrideWinnerId);
      throw err;
    } finally {
      this.endingMatches.delete(roomId);
    }
  }

  private safeEndMatch(
    roomId: string,
    reason: MatchEndReason,
    server: Server,
    overrideWinnerId?: string,
  ): void {
    void this.endMatch(roomId, reason, server, overrideWinnerId).catch(() => {
      // endMatch logs and schedules retry; timer callers intentionally swallow.
    });
  }

  private scheduleEndMatchRetry(
    roomId: string,
    reason: MatchEndReason,
    server: Server,
    overrideWinnerId?: string,
  ): void {
    if (!this.sessions.has(roomId) || this.matchEndRetryTimers.has(roomId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.matchEndRetryTimers.delete(roomId);
      this.safeEndMatch(roomId, reason, server, overrideWinnerId);
    }, MATCH_END_RETRY_DELAY_MS);
    timer.unref?.();
    this.matchEndRetryTimers.set(roomId, timer);
  }

  private async finalizeMatch(
    session: AcidRainSession,
    roomId: string,
    reason: MatchEndReason,
    server: Server,
    overrideWinnerId?: string,
  ): Promise<void> {
    let finalization = this.matchFinalizations.get(roomId);
    if (!finalization) {
      finalization = {
        snapshot: this.createFinalizationSnapshot(
          session,
          reason,
          overrideWinnerId,
        ),
        matchEndEmitted: false,
        acidRoomDeleted: false,
        lobbyRoomDeleted: false,
        roomClosedBroadcast: false,
        usersOnline: false,
        historySaved: false,
      };
      this.matchFinalizations.set(roomId, finalization);
    }

    session.status = 'FINISHED';

    // 루프 정리
    if (session.countdownTimer) clearTimeout(session.countdownTimer);
    if (session.spawnLoopTimer) clearTimeout(session.spawnLoopTimer);
    if (session.missLoopTimer) clearInterval(session.missLoopTimer);
    if (session.matchEndTimer) clearTimeout(session.matchEndTimer);
    const retryTimer = this.matchEndRetryTimers.get(roomId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.matchEndRetryTimers.delete(roomId);
    }

    const { snapshot } = finalization;
    if (!finalization.matchEndEmitted) {
      server.to(`game:${roomId}`).emit('match_end', {
        roomId,
        winnerId: snapshot.winnerId,
        reason: snapshot.reason,
        finalHp: { ...snapshot.finalHp },
        wordsTyped: { ...snapshot.wordsTyped },
        durationSec: snapshot.durationSec,
      });
      finalization.matchEndEmitted = true;
    }

    if (!finalization.acidRoomDeleted) {
      await this.awaitPendingSessionPersist(roomId);
      await this.redisService.del(`game:acidroom:${roomId}`);
      finalization.acidRoomDeleted = true;
    }
    if (!finalization.lobbyRoomDeleted) {
      await this.redisService.getClient().del(`game:room:${roomId}`);
      finalization.lobbyRoomDeleted = true;
    }
    if (!finalization.roomClosedBroadcast) {
      this.lobbyService.broadcast('ROOM_CLOSED', { roomId });
      finalization.roomClosedBroadcast = true;
    }

    // 두 플레이어 상태 ONLINE으로 복원
    if (!finalization.usersOnline) {
      await this.userRepo.update([session.host.userId, session.guest.userId], {
        status: UserStatus.ONLINE,
      });
      finalization.usersOnline = true;
    }

    if (!finalization.historySaved) {
      await this.saveMatchHistory(session, snapshot);
      finalization.historySaved = true;
    }

    this.sessions.delete(roomId);
    this.matchFinalizations.delete(roomId);
    this.logger.log(
      `Match ${roomId} ended — reason: ${snapshot.reason}, winner: ${snapshot.winnerId}`,
    );
  }

  private createFinalizationSnapshot(
    session: AcidRainSession,
    reason: MatchEndReason,
    overrideWinnerId?: string,
  ): MatchFinalizationSnapshot {
    let winnerId: string | null = overrideWinnerId ?? null;
    if (!winnerId && (reason === 'KO' || reason === 'TIME_LIMIT')) {
      if (session.hp.host > session.hp.guest) winnerId = session.host.userId;
      else if (session.hp.guest > session.hp.host)
        winnerId = session.guest.userId;
      // 동률 무승부 → null
    }

    return {
      reason,
      winnerId,
      finalHp: { ...session.hp },
      wordsTyped: { ...session.wordsTyped },
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
    };
  }

  // ─── Redis 영속화 ─────────────────────────────────────────────────────────

  private async persistSession(session: AcidRainSession): Promise<void> {
    if (session.status === 'FINISHED') return;

    const roomId = session.roomId;
    const previous = this.pendingSessionPersists.get(roomId);
    const persist = (previous ?? Promise.resolve())
      .catch((err: unknown) => {
        this.logger.error('Previous Acid Rain session persist failed', err);
      })
      .then(async () => {
        if (session.status === 'FINISHED') return;

        const serializable = {
          roomId: session.roomId,
          host: session.host,
          guest: session.guest,
          hp: session.hp,
          wordsTyped: session.wordsTyped,
          startedAt: session.startedAt,
          status: session.status,
          activeWords: Array.from(session.activeWords.entries()),
          resolvedWords: Array.from(session.resolvedWords.entries()),
        };
        await this.redisService.set(
          `game:acidroom:${session.roomId}`,
          JSON.stringify(serializable),
          REDIS_TTL,
        );
      })
      .catch((err: unknown) => {
        this.logger.error('Failed to persist Acid Rain session', err);
      });

    this.pendingSessionPersists.set(roomId, persist);
    void persist.finally(() => {
      if (this.pendingSessionPersists.get(roomId) === persist) {
        this.pendingSessionPersists.delete(roomId);
      }
    });

    await persist;
  }

  private async awaitPendingSessionPersist(roomId: string): Promise<void> {
    const pending = this.pendingSessionPersists.get(roomId);
    if (pending) await pending;
  }

  // ─── MatchHistory 저장 ────────────────────────────────────────────────────

  private async saveMatchHistory(
    session: AcidRainSession,
    snapshot: MatchFinalizationSnapshot,
    mode: MatchMode = MatchMode.PVP,
  ): Promise<void> {
    try {
      await this.matchHistoryRepo.manager.transaction(async (manager) => {
        const userRepo = manager.getRepository(User);
        const matchHistoryRepo = manager.getRepository(MatchHistory);
        const [hostUser, guestUser] = await Promise.all([
          userRepo.findOneBy({ id: session.host.userId }),
          userRepo.findOneBy({ id: session.guest.userId }),
        ]);
        if (!hostUser || !guestUser) {
          throw new Error('Acid Rain match participant not found');
        }

        const winnerUser = snapshot.winnerId
          ? await userRepo.findOneBy({ id: snapshot.winnerId })
          : null;
        if (snapshot.winnerId && !winnerUser) {
          throw new Error('Acid Rain match winner not found');
        }

        const history = matchHistoryRepo.create({
          hostUser,
          guestUser,
          winner: winnerUser,
          mode,
          roundsPlayed: 1,
          matchData: {
            finalHp: { ...snapshot.finalHp },
            wordsTyped: { ...snapshot.wordsTyped },
            durationSec: snapshot.durationSec,
            reason: snapshot.reason,
          },
        });
        await matchHistoryRepo.save(history);

        // PVP만 wins/losses에 반영 — AI 연습은 랭킹에 영향 없음 (#104)
        if (mode !== MatchMode.PVP) return;

        if (snapshot.winnerId) {
          const loserId =
            snapshot.winnerId === session.host.userId
              ? session.guest.userId
              : session.host.userId;
          const [winnerUpdate, loserUpdate] = await Promise.all([
            userRepo.increment({ id: snapshot.winnerId }, 'wins', 1),
            userRepo.increment({ id: loserId }, 'losses', 1),
          ]);
          this.assertStatsUpdated(winnerUpdate, 'winner wins');
          this.assertStatsUpdated(loserUpdate, 'loser losses');
        } else {
          // 무승부: 둘 다 losses 증가
          const [hostUpdate, guestUpdate] = await Promise.all([
            userRepo.increment({ id: session.host.userId }, 'losses', 1),
            userRepo.increment({ id: session.guest.userId }, 'losses', 1),
          ]);
          this.assertStatsUpdated(hostUpdate, 'host losses');
          this.assertStatsUpdated(guestUpdate, 'guest losses');
        }
      });
    } catch (err) {
      this.logger.error('Failed to save MatchHistory', err);
      throw err;
    }
  }

  private assertStatsUpdated(
    result: { affected?: number | null },
    label: string,
  ): void {
    if ((result.affected ?? 0) <= 0) {
      throw new Error(`Failed to update Acid Rain ${label}`);
    }
  }

  // ─── 유틸 ─────────────────────────────────────────────────────────────────

  private rejected(
    input: JudgeWordSubmitInput,
    reason: JudgeRejectionReason,
    wordState?: WordResolutionState,
    session?: AcidRainSession,
  ): JudgeWordSubmitResult {
    return {
      accepted: false,
      roomId: input.roomId,
      playerId: input.playerId,
      wordId: input.wordId,
      attemptId: input.attemptId,
      reason,
      wordStateBefore: wordState,
      wordStateAfter: wordState,
      damage: 0,
      targetHp: session ? { ...session.hp } : undefined,
      gameEnded: false,
      winnerId: null,
      loserId: null,
      endReason: null,
      submitRejected: {
        wordId: input.wordId,
        reason: this.toSubmitRejectedReason(reason, wordState),
      },
    };
  }

  private recordOutcome(
    attemptKey: string | undefined,
    input: JudgeWordSubmitInput,
    result: JudgeWordSubmitResult,
    sessionToPersist?: AcidRainSession,
  ): JudgeCoreOutcome {
    if (!attemptKey || !input.attemptId) {
      return { result, replayed: false, sessionToPersist };
    }

    const storedResult = this.cloneJudgeResult(result);
    const finalizationStatus =
      storedResult.accepted && storedResult.gameEnded ? 'PENDING' : undefined;
    this.processedAttempts.set(attemptKey, {
      roomId: input.roomId,
      playerId: input.playerId,
      attemptId: input.attemptId,
      wordId: input.wordId,
      text: input.text,
      result: storedResult,
      expiresAt: Date.now() + ATTEMPT_RESULT_TTL_MS,
      finalizationStatus,
    });

    return {
      result,
      replayed: false,
      attemptKey,
      finalizationStatus,
      sessionToPersist,
    };
  }

  private async finalizeKoAttempt(
    attemptKey: string,
    result: JudgeWordSubmitResult,
    server: Server,
  ): Promise<void> {
    const record = this.processedAttempts.get(attemptKey);
    if (record?.finalizationStatus === 'COMPLETED') return;

    if (record) record.finalizationStatus = 'PENDING';
    try {
      await this.endMatch(result.roomId, 'KO', server);
      const updated = this.processedAttempts.get(attemptKey);
      if (updated) updated.finalizationStatus = 'COMPLETED';
    } catch (err) {
      const updated = this.processedAttempts.get(attemptKey);
      if (updated) updated.finalizationStatus = 'FAILED';
      throw err;
    }
  }

  private attemptKey(input: JudgeWordSubmitInput): string | undefined {
    if (!input.attemptId) return undefined;
    return `${input.roomId}:${input.playerId}:${input.attemptId}`;
  }

  private cleanupExpiredAttempts(): void {
    const now = Date.now();
    for (const [key, record] of this.processedAttempts) {
      if (record.expiresAt <= now) this.processedAttempts.delete(key);
    }
  }

  private cloneJudgeResult(
    result: JudgeWordSubmitResult,
  ): JudgeWordSubmitResult {
    if (result.accepted) {
      return {
        ...result,
        targetHp: { ...result.targetHp },
        wordCleared: {
          ...result.wordCleared,
          targetHp: { ...result.wordCleared.targetHp },
        },
      };
    }

    return {
      ...result,
      targetHp: result.targetHp ? { ...result.targetHp } : undefined,
      submitRejected: { ...result.submitRejected },
    };
  }

  private isParticipant(session: AcidRainSession, playerId: string): boolean {
    return (
      session.host.userId === playerId || session.guest.userId === playerId
    );
  }

  private wordState(
    session: AcidRainSession,
    wordId: string,
  ): WordResolutionState | undefined {
    const resolved = session.resolvedWords.get(wordId);
    if (resolved) return resolved.state;
    if (session.activeWords.has(wordId)) return 'ACTIVE';
    return undefined;
  }

  private toSubmitRejectedReason(
    reason: JudgeRejectionReason,
    wordState?: WordResolutionState,
  ): SubmitRejectedReason {
    if (reason === 'INCORRECT_TEXT') return 'WRONG_TEXT';
    if (reason === 'WORD_ALREADY_RESOLVED' && wordState === 'CLEARED') {
      return 'ALREADY_CLEARED';
    }
    return 'NOT_FOUND';
  }

  private determineWinner(session: AcidRainSession): string | null {
    if (session.hp.host > session.hp.guest) return session.host.userId;
    if (session.hp.guest > session.hp.host) return session.guest.userId;
    return null;
  }
}
