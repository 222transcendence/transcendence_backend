import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { LobbyService } from '../../lobby/lobby.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { activeGames } from '../../metrics/metrics.registry';
import { MatchHistory, MatchMode } from '../entities/match-history.entity';
import { MatchParticipant } from '../entities/match-participant.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import {
  AcidRainSession,
  ActiveWord,
  HpMap,
  JudgeRejectionReason,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  MatchEndReason,
  PlayerPublic,
  RankedParticipant,
  SubmitRejectedReason,
  WordClearedEventPayload,
  WordSpawnPayload,
  WordResolutionState,
} from './acid-rain.interface';
import { WordDictionaryService } from '../../word-dictionary/word-dictionary.service';

const INITIAL_HP = 100;
const MATCH_DURATION_MS = 180_000;
const GRACE_PERIOD_MS = 30_000;
const LANE_COUNT = 5;
const SPLASH_DAMAGE = 3;
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
  ranking: RankedParticipant[];
  finalHp: HpMap;
  wordsTyped: Record<string, number>;
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
    private readonly wordDictionaryService: WordDictionaryService,
    private readonly chatGateway: ChatGateway,
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
    players: PlayerPublic[],
    server: Server,
  ): Promise<void> {
    if (this.sessions.has(roomId)) return; // 이미 진행 중

    const hp: HpMap = {};
    const wordsTyped: Record<string, number> = {};
    for (const p of players) {
      hp[p.userId] = INITIAL_HP;
      wordsTyped[p.userId] = 0;
    }

    const session: AcidRainSession = {
      roomId,
      players,
      hp,
      wordsTyped,
      eliminated: [],
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
    activeGames.set(this.sessions.size);
    await this.persistSession(session);

    // 참가자 전원 상태 IN_GAME으로 전환 (DB + Redis + 친구 실시간 알림)
    const userIds = players.map((p) => p.userId);
    await this.userRepo.update(userIds, { status: UserStatus.IN_GAME });
    await Promise.all(
      userIds.map((id) => this.chatGateway.setUserStatus(id, 'IN_GAME')),
    );
    await Promise.all(
      userIds.map((id) => this.chatGateway.notifyFriends(id, 'IN_GAME')),
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
      const word = this.wordDictionaryService.pickWord(elapsed);
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

          // 스플래시는 그 시점 생존자 전원에게 적용된다 (탈락자 제외, GAME_DESIGN §3.6)
          const eliminatedIds = new Set(
            session.eliminated.map((e) => e.userId),
          );
          const survivorsBefore = session.players.filter(
            (p) => !eliminatedIds.has(p.userId),
          );
          for (const p of survivorsBefore) {
            session.hp[p.userId] = Math.max(
              0,
              session.hp[p.userId] - SPLASH_DAMAGE,
            );
          }

          server.to(`game:${session.roomId}`).emit('word_missed', {
            wordId,
            splashDamage: SPLASH_DAMAGE,
            hp: { ...session.hp },
          });

          const newlyDead = survivorsBefore
            .filter((p) => session.hp[p.userId] <= 0)
            .map((p) => p.userId);
          const eliminatedEntries = this.eliminateBatch(session, newlyDead);
          const remainingPlayers =
            session.players.length - session.eliminated.length;
          for (const entry of eliminatedEntries) {
            server.to(`game:${session.roomId}`).emit('player_eliminated', {
              userId: entry.userId,
              rank: entry.rank,
              remainingPlayers,
            });
          }

          if (remainingPlayers <= 1) {
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

      if (result.eliminatedRank !== undefined) {
        server.to(`game:${result.roomId}`).emit('player_eliminated', {
          userId: result.targetUserId,
          rank: result.eliminatedRank,
          remainingPlayers: result.remainingPlayers,
        });
      }

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

    if (session.eliminated.some((e) => e.userId === playerId)) {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(input, 'PLAYER_ELIMINATED', undefined, session),
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
    session.wordsTyped[playerId] = (session.wordsTyped[playerId] ?? 0) + 1;

    // 지운 사람을 제외한 생존자 중 서버가 무작위로 1인을 골라 데미지를 준다 (GAME_DESIGN §3.6)
    const eliminatedIds = new Set(session.eliminated.map((e) => e.userId));
    const candidates = session.players
      .filter((p) => p.userId !== playerId && !eliminatedIds.has(p.userId))
      .map((p) => p.userId);
    const targetUserId =
      candidates[Math.floor(Math.random() * candidates.length)];

    const damage = 5 + Math.ceil(word.keystrokes / 2);
    session.hp[targetUserId] = Math.max(0, session.hp[targetUserId] - damage);

    let eliminatedRank: number | undefined;
    if (session.hp[targetUserId] <= 0) {
      const [entry] = this.eliminateBatch(session, [targetUserId]);
      eliminatedRank = entry.rank;
    }

    const remainingPlayers = session.players.length - session.eliminated.length;
    const gameEnded = remainingPlayers <= 1;
    const winnerId = gameEnded ? this.findSoleSurvivor(session) : null;

    const wordCleared: WordClearedEventPayload = {
      wordId,
      clearedBy: playerId,
      targetUserId,
      damage,
      hp: { ...session.hp },
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
      targetUserId,
      hp: { ...session.hp },
      eliminatedRank,
      remainingPlayers,
      gameEnded,
      winnerId,
      endReason: gameEnded ? 'KO' : null,
      wordCleared,
    };
    return this.recordOutcome(attemptKey, input, result, session);
  }

  // ─── 탈락 처리 (정타/스플래시/연결끊김/퇴장 공통) ─────────────────────────

  /**
   * userIds 전원을 한 번에 탈락 처리하고 같은 순위(rank)를 부여한다.
   * 이미 탈락 처리된 userId는 건너뛴다. 반환값은 새로 탈락한 항목만 포함한다.
   */
  private eliminateBatch(
    session: AcidRainSession,
    userIds: string[],
  ): RankedParticipant[] {
    const alreadyEliminated = new Set(session.eliminated.map((e) => e.userId));
    const freshIds = userIds.filter((id) => !alreadyEliminated.has(id));
    if (freshIds.length === 0) return [];

    const survivorsBefore = session.players.length - session.eliminated.length;
    const remainingAfter = survivorsBefore - freshIds.length;
    const rank = remainingAfter + 1;
    const entries = freshIds.map((userId) => ({ userId, rank }));
    session.eliminated.push(...entries);
    return entries;
  }

  private findSoleSurvivor(session: AcidRainSession): string | null {
    const eliminatedIds = new Set(session.eliminated.map((e) => e.userId));
    const survivors = session.players.filter(
      (p) => !eliminatedIds.has(p.userId),
    );
    return survivors.length === 1 ? survivors[0].userId : null;
  }

  /** 연결 끊김 유예 만료 또는 명시적 퇴장으로 즉시 탈락 처리한다. */
  private async eliminateParticipant(
    session: AcidRainSession,
    userId: string,
    server: Server,
  ): Promise<void> {
    const entries = this.eliminateBatch(session, [userId]);
    if (entries.length === 0) return;

    session.hp[userId] = 0;
    const remainingPlayers = session.players.length - session.eliminated.length;
    server.to(`game:${session.roomId}`).emit('player_eliminated', {
      userId,
      rank: entries[0].rank,
      remainingPlayers,
    });

    if (remainingPlayers <= 1) {
      await this.endMatch(session.roomId, 'FORFEIT', server);
    } else {
      await this.persistSession(session);
    }
  }

  /** leave_room으로 명시적 퇴장 시 즉시 탈락 처리 (유예 없음). */
  async eliminateOnLeave(
    roomId: string,
    userId: string,
    server: Server,
  ): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return;
    await this.eliminateParticipant(session, userId, server);
  }

  // ─── 재접속 처리 ──────────────────────────────────────────────────────────

  handleDisconnect(roomId: string, userId: string, server: Server): void {
    const session = this.sessions.get(roomId);
    if (!session || session.status === 'FINISHED') return;

    server.to(`game:${roomId}`).emit('opponent_disconnected', {
      userId,
      graceMs: GRACE_PERIOD_MS,
    });

    const timer = setTimeout(() => {
      this.graceTimers.delete(roomId);
      const current = this.sessions.get(roomId);
      if (!current || current.status === 'FINISHED') return;
      void this.eliminateParticipant(current, userId, server).catch(
        (err: unknown) => {
          this.logger.error('Failed to process disconnect elimination', err);
        },
      );
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
  ): Promise<void> {
    const existing = this.endingMatches.get(roomId);
    if (existing) return existing;

    const session = this.sessions.get(roomId);
    if (!session) return;

    const promise = this.finalizeMatch(session, roomId, reason, server);
    this.endingMatches.set(roomId, promise);
    try {
      await promise;
    } catch (err) {
      this.logger.error('Failed to finalize Acid Rain match', err);
      this.scheduleEndMatchRetry(roomId, reason, server);
      throw err;
    } finally {
      this.endingMatches.delete(roomId);
    }
  }

  private safeEndMatch(
    roomId: string,
    reason: MatchEndReason,
    server: Server,
  ): void {
    void this.endMatch(roomId, reason, server).catch(() => {
      // endMatch logs and schedules retry; timer callers intentionally swallow.
    });
  }

  private scheduleEndMatchRetry(
    roomId: string,
    reason: MatchEndReason,
    server: Server,
  ): void {
    if (!this.sessions.has(roomId) || this.matchEndRetryTimers.has(roomId)) {
      return;
    }

    const timer = setTimeout(() => {
      this.matchEndRetryTimers.delete(roomId);
      this.safeEndMatch(roomId, reason, server);
    }, MATCH_END_RETRY_DELAY_MS);
    timer.unref?.();
    this.matchEndRetryTimers.set(roomId, timer);
  }

  private async finalizeMatch(
    session: AcidRainSession,
    roomId: string,
    reason: MatchEndReason,
    server: Server,
  ): Promise<void> {
    let finalization = this.matchFinalizations.get(roomId);
    if (!finalization) {
      finalization = {
        snapshot: this.createFinalizationSnapshot(session, reason),
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
        ranking: snapshot.ranking.map((r) => ({ ...r })),
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

    // 참가자 전원 상태 ONLINE으로 복원 (DB + Redis + 친구 실시간 알림)
    if (!finalization.usersOnline) {
      const userIds = session.players.map((p) => p.userId);
      await this.userRepo.update(userIds, { status: UserStatus.ONLINE });
      await Promise.all(
        userIds.map((id) => this.chatGateway.setUserStatus(id, 'ONLINE')),
      );
      await Promise.all(
        userIds.map((id) => this.chatGateway.notifyFriends(id, 'ONLINE')),
      );
      finalization.usersOnline = true;
    }

    if (!finalization.historySaved) {
      await this.saveMatchHistory(session, snapshot);
      finalization.historySaved = true;
    }

    this.sessions.delete(roomId);
    activeGames.set(this.sessions.size);
    this.matchFinalizations.delete(roomId);
    this.logger.log(
      `Match ${roomId} ended — reason: ${snapshot.reason}, winner: ${snapshot.winnerId}`,
    );
  }

  /**
   * 탈락자는 session.eliminated에 이미 순위가 매겨져 있다. 남은 생존자는
   * TIME_LIMIT이면 HP 내림차순(동점자는 같은 순위 공유), KO/FORFEIT이면
   * 생존자가 정확히 1명이거나(그 사람이 1위) 0명(동시 전멸 → 전원 무승부,
   * §3.1/설계 결정)이다.
   */
  private computeRanking(session: AcidRainSession): {
    winnerId: string | null;
    ranking: RankedParticipant[];
  } {
    const eliminatedIds = new Set(session.eliminated.map((e) => e.userId));
    const survivors = session.players.filter(
      (p) => !eliminatedIds.has(p.userId),
    );
    const ranking: RankedParticipant[] = [...session.eliminated];

    if (survivors.length === 0) {
      return { winnerId: null, ranking: this.sortRanking(ranking) };
    }

    if (survivors.length === 1) {
      ranking.push({ userId: survivors[0].userId, rank: 1 });
      return {
        winnerId: survivors[0].userId,
        ranking: this.sortRanking(ranking),
      };
    }

    const sorted = [...survivors].sort(
      (a, b) => session.hp[b.userId] - session.hp[a.userId],
    );
    let rank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (
        i > 0 &&
        session.hp[sorted[i].userId] < session.hp[sorted[i - 1].userId]
      ) {
        rank = i + 1;
      }
      ranking.push({ userId: sorted[i].userId, rank });
    }
    const topRankCount = sorted.filter(
      (p) => session.hp[p.userId] === session.hp[sorted[0].userId],
    ).length;
    const winnerId = topRankCount === 1 ? sorted[0].userId : null;

    return { winnerId, ranking: this.sortRanking(ranking) };
  }

  private sortRanking(ranking: RankedParticipant[]): RankedParticipant[] {
    return [...ranking].sort((a, b) => a.rank - b.rank);
  }

  private createFinalizationSnapshot(
    session: AcidRainSession,
    reason: MatchEndReason,
  ): MatchFinalizationSnapshot {
    const { winnerId, ranking } = this.computeRanking(session);
    return {
      reason,
      winnerId,
      ranking,
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
          players: session.players,
          hp: session.hp,
          wordsTyped: session.wordsTyped,
          eliminated: session.eliminated,
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
        const participantRepo = manager.getRepository(MatchParticipant);

        const playerIds = session.players.map((p) => p.userId);
        const users = await userRepo.findBy({ id: In(playerIds) });
        if (users.length !== playerIds.length) {
          throw new Error('Acid Rain match participant not found');
        }
        const userById = new Map(users.map((u) => [u.id, u]));

        const winnerUser = snapshot.winnerId
          ? userById.get(snapshot.winnerId)
          : null;
        if (snapshot.winnerId && !winnerUser) {
          throw new Error('Acid Rain match winner not found');
        }

        const history = matchHistoryRepo.create({
          winner: winnerUser ?? null,
          mode,
          roundsPlayed: 1,
          matchData: {
            participants: snapshot.ranking.map((r) => ({
              userId: r.userId,
              finalHp: snapshot.finalHp[r.userId] ?? 0,
              rank: r.rank,
              wordsTyped: snapshot.wordsTyped[r.userId] ?? 0,
            })),
            durationSec: snapshot.durationSec,
            reason: snapshot.reason,
          },
          participants: snapshot.ranking.map((r) =>
            participantRepo.create({
              user: userById.get(r.userId),
              finalHp: snapshot.finalHp[r.userId] ?? 0,
              rank: r.rank,
            }),
          ),
        });
        await matchHistoryRepo.save(history);

        // PVP만 wins/losses/draws에 반영 — AI 연습은 랭킹에 영향 없음 (#104)
        if (mode !== MatchMode.PVP) return;

        const topRankCount = snapshot.ranking.filter(
          (r) => r.rank === 1,
        ).length;

        if (snapshot.winnerId && topRankCount === 1) {
          const loserIds = playerIds.filter((id) => id !== snapshot.winnerId);
          const winnerUpdate = await userRepo.increment(
            { id: snapshot.winnerId },
            'wins',
            1,
          );
          this.assertStatsUpdated(winnerUpdate, 'winner wins');
          await Promise.all(
            loserIds.map(async (loserId) => {
              const loserUpdate = await userRepo.increment(
                { id: loserId },
                'losses',
                1,
              );
              this.assertStatsUpdated(loserUpdate, `loser losses (${loserId})`);
            }),
          );
        } else {
          // 무승부(동시 전멸 포함 공동 1위) — 승패 대신 draws 증가
          await Promise.all(
            playerIds.map(async (userId) => {
              const drawUpdate = await userRepo.increment(
                { id: userId },
                'draws',
                1,
              );
              this.assertStatsUpdated(drawUpdate, `draw (${userId})`);
            }),
          );
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
      hp: session ? { ...session.hp } : undefined,
      gameEnded: false,
      winnerId: null,
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
        hp: { ...result.hp },
        wordCleared: {
          ...result.wordCleared,
          hp: { ...result.wordCleared.hp },
        },
      };
    }

    return {
      ...result,
      hp: result.hp ? { ...result.hp } : undefined,
      submitRejected: { ...result.submitRejected },
    };
  }

  private isParticipant(session: AcidRainSession, playerId: string): boolean {
    return session.players.some((p) => p.userId === playerId);
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
}
