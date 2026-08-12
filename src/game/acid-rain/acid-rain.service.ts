import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { RedisService } from '../../redis/redis.service';
import { LobbyService } from '../../lobby/lobby.service';
import { ChatGateway } from '../../chat/chat.gateway';
import {
  activeGames,
  wordSpawnedTotal,
  wordClearedTotal,
  wordMissedTotal,
  matchEndedTotal,
} from '../../metrics/metrics.registry';
import { MatchHistory, MatchMode } from '../entities/match-history.entity';
import { MatchParticipant } from '../entities/match-participant.entity';
import { User, UserStatus } from '../../user/entities/user.entity';
import {
  AcidRainSession,
  ActiveWord,
  ActiveWordStatePayload,
  HpPair,
  HpByParticipantId,
  JudgeRejectionReason,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  MatchEndEventPayload,
  MatchEndReason,
  ParticipantState,
  ParticipantRuntime,
  ParticipantPublic,
  PlayerPublic,
  RankingEntry,
  StateSyncEventPayload,
  SubmitRejectedReason,
  WordMissedEventPayload,
  WordSpawnPayload,
  WordResolutionState,
} from './acid-rain.interface';
import { WordDictionaryService } from '../../word-dictionary/word-dictionary.service';

const INITIAL_HP = 100;
const MATCH_DURATION_MS = 180_000;
const GRACE_PERIOD_MS = 30_000;
const LANE_COUNT = 5;
const REDIS_TTL = 1800; // seconds
const ATTEMPT_RESULT_TTL_MS = 5 * 60 * 1000;
const MATCH_END_RETRY_DELAY_MS = 1000;
export const ACID_RAIN_RANDOM = Symbol('ACID_RAIN_RANDOM');
const MAX_ACTIVE_WORDS = 5;
const SPLASH_DAMAGE = 3;

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
  finalHpByParticipantId: HpByParticipantId;
  wordsTypedByParticipantId: Record<string, number>;
  durationSec: number;
}

@Injectable()
export class AcidRainService implements OnModuleInit {
  private readonly logger = new Logger(AcidRainService.name);
  // roomId → in-memory session (단일 인스턴스 기준)
  private readonly sessions = new Map<string, AcidRainSession>();
  // `${roomId}:${userId}` → grace timer. userId까지 키에 포함하는 이유는 3~4인 매치에서
  // 서로 다른 두 참가자가 동시에 끊기면 roomId만으로는 타이머가 서로 덮어써서 재접속
  // 취소 로직이 꼬이기 때문(#157).
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
    @Optional()
    @Inject(ACID_RAIN_RANDOM)
    private readonly random: () => number = Math.random,
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
    participantPublics: ParticipantPublic[] = [
      {
        participantId: host.userId,
        userId: host.userId,
        nickname: host.nickname,
        type: 'HUMAN',
      },
      {
        participantId: guest.userId,
        userId: guest.userId,
        nickname: guest.nickname,
        type: 'HUMAN',
      },
    ],
    mode: 'PVP' | 'AI_PRACTICE' = 'PVP',
  ): Promise<void> {
    if (this.sessions.has(roomId)) return; // 이미 진행 중

    const participants = participantPublics.map((participant) => ({
      ...participant,
      hp: INITIAL_HP,
      wordsTyped: 0,
      status: 'ACTIVE' as const,
    }));
    const hpByParticipantId = Object.fromEntries(
      participants.map((participant) => [
        participant.participantId,
        INITIAL_HP,
      ]),
    );
    const session: AcidRainSession = {
      roomId,
      host,
      guest,
      participants,
      hp: { host: INITIAL_HP, guest: INITIAL_HP },
      hpByParticipantId,
      wordsTyped: { host: 0, guest: 0 },
      activeWords: new Map(),
      startedAt: Date.now(),
      countdownTimer: null,
      spawnLoopTimer: null,
      missLoopTimer: null,
      matchEndTimer: null,
      occupiedLanes: new Set(),
      resolvedWords: new Map(),
      nextEliminationOrder: 1,
      mode,
      status: 'COUNTDOWN',
    };
    this.sessions.set(roomId, session);
    activeGames.set(this.sessions.size);
    await this.persistSession(session);

    // 두 플레이어 상태 IN_GAME으로 전환 (DB + Redis + 친구 실시간 알림)
    const humanIds = participants
      .filter(
        (participant) => participant.type === 'HUMAN' && participant.userId,
      )
      .map((participant) => participant.userId!);
    await this.userRepo.update(humanIds, {
      status: UserStatus.IN_GAME,
    });
    await Promise.all(
      humanIds.map((id) => this.chatGateway.setUserStatus(id, 'IN_GAME')),
    );
    await Promise.all(
      humanIds.map((id) => this.chatGateway.notifyFriends(id, 'IN_GAME')),
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
    const scheduleNext = (elapsedSec: number) => {
      const interval = Math.max(700, 2000 - 50 * Math.floor(elapsedSec / 10));
      session.spawnLoopTimer = setTimeout(tick, interval);
    };

    const tick = () => {
      if (
        this.sessions.get(session.roomId) !== session ||
        session.status !== 'IN_PROGRESS'
      ) {
        return;
      }
      const elapsed = (Date.now() - session.startedAt) / 1000;
      if (session.activeWords.size >= MAX_ACTIVE_WORDS) {
        scheduleNext(elapsed);
        return;
      }

      let word = this.wordDictionaryService.pickWord(elapsed);
      const activeTexts = new Set(
        Array.from(session.activeWords.values()).map((active) => active.text),
      );
      for (
        let attempt = 0;
        attempt < 10 && activeTexts.has(word.text);
        attempt++
      ) {
        word = this.wordDictionaryService.pickWord(elapsed);
      }
      if (activeTexts.has(word.text)) {
        scheduleNext(elapsed);
        return;
      }
      const wordId = `w_${randomUUID().slice(0, 8)}`;
      const lane = this.assignLane(session);
      const fallDurationMs = Math.round(
        (4000 + 250 * word.keystrokes) * Math.max(0.6, 1 - elapsed / 300),
      );
      const spawnedAt = new Date().toISOString();
      const landAtMs = Date.now() + fallDurationMs;
      const damage = this.damageForKeystrokes(word.keystrokes);

      const active: ActiveWord = {
        wordId,
        text: word.text,
        keystrokes: word.keystrokes,
        lane,
        fallDurationMs,
        spawnedAt,
        landAt: landAtMs,
        damage,
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
        landAt: new Date(landAtMs).toISOString(),
        damage,
      };
      server.to(`game:${session.roomId}`).emit('word_spawn', payload);
      wordSpawnedTotal.inc();
      void this.persistSession(session);

      // 다음 스폰 간격 계산 후 재귀 호출
      scheduleNext(elapsed);
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
      if (
        this.sessions.get(session.roomId) !== session ||
        session.status !== 'IN_PROGRESS'
      ) {
        return;
      }
      this.syncCanonicalFromCompatibility(session);
      const now = Date.now();
      const missed: string[] = [];
      for (const [wordId, word] of session.activeWords) {
        if (
          now >= word.landAt &&
          this.transitionWord(session, wordId, 'MISSED')
        ) {
          missed.push(wordId);
        }
      }
      if (missed.length === 0) return;

      const newlyEliminated = new Set<string>();
      for (const participant of this.aliveParticipants(session)) {
        const hp = Math.max(0, participant.hp - SPLASH_DAMAGE);
        participant.hp = hp;
        session.hpByParticipantId[participant.participantId] = hp;
        if (hp === 0) newlyEliminated.add(participant.participantId);
      }
      this.syncCompatibilityHp(session);
      this.eliminateBatch(session, [...newlyEliminated]);

      for (const wordId of missed) {
        const payload: WordMissedEventPayload = {
          wordId,
          splashDamage: SPLASH_DAMAGE,
          hp: this.hpByParticipantId(session),
        };
        server.to(`game:${session.roomId}`).emit('word_missed', payload);
        wordMissedTotal.inc();
      }

      if (this.aliveParticipants(session).length <= 1) {
        this.safeEndMatch(session.roomId, 'KO', server);
      } else {
        void this.persistSession(session);
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
      wordClearedTotal.inc();
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
    this.syncCanonicalFromCompatibility(session);

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

    // 탈락한 참가자는 맞을 수 없을 뿐 아니라(selectAttackTarget이 이미 걸러줌) 본인이
    // 단어를 지워 다른 생존자를 공격하는 것도 막아야 한다 — 3~4인 매치에서 이 검사가
    // 없으면 탈락자가 계속 게임에 영향을 줄 수 있었다.
    const submitter = session.participants.find(
      (participant) => participant.participantId === playerId,
    );
    if (!submitter || submitter.status !== 'ACTIVE' || submitter.hp <= 0) {
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

    if (!this.transitionWord(session, wordId, 'CLEARED', playerId, attemptId)) {
      return this.recordOutcome(
        attemptKey,
        input,
        this.rejected(
          input,
          'WORD_ALREADY_RESOLVED',
          session.resolvedWords.get(wordId)?.state,
          session,
        ),
      );
    }

    submitter.wordsTyped++;
    this.incrementWordsTypedCompatibility(session, playerId);

    const target = this.selectAttackTarget(session, playerId);
    const damage = target ? this.damageForKeystrokes(word.keystrokes) : 0;
    if (target) this.applyDamage(session, target.participantId, damage);

    const gameEnded = this.aliveParticipants(session).length <= 1;
    const winnerId = gameEnded ? this.determineWinner(session) : null;
    const loserId =
      winnerId && session.participants.length === 2
        ? winnerId === session.host.userId
          ? session.guest.userId
          : session.host.userId
        : null;
    const wordCleared = {
      wordId,
      clearedBy: playerId,
      ...(target ? { targetParticipantId: target.participantId } : {}),
      damage,
      hp: this.hpByParticipantId(session),
      ...(session.participants.length > 2
        ? { targetHpByParticipantId: this.hpByParticipantId(session) }
        : {}),
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
      ...(session.participants.length > 2
        ? { targetHpByParticipantId: this.hpByParticipantId(session) }
        : {}),
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

    server.to(`game:${roomId}`).emit('opponent_disconnected', {
      userId,
      graceMs: GRACE_PERIOD_MS,
    });

    const graceKey = `${roomId}:${userId}`;
    const timer = setTimeout(() => {
      this.graceTimers.delete(graceKey);
      // 그 한 명만 탈락 처리 — 3~4인 매치에서는 나머지가 계속 진행되고, 2인 매치에서는
      // 결과적으로 남은 한 명이 즉시 승자가 되어 지금까지와 동일하게 동작한다(#157).
      this.eliminateParticipant(roomId, userId, server, 'FORFEIT');
    }, GRACE_PERIOD_MS);

    this.graceTimers.set(graceKey, timer);
  }

  handleReconnect(
    roomId: string,
    userId: string,
    server: Server,
    clientSocket: import('socket.io').Socket,
  ): void {
    const session = this.sessions.get(roomId);
    if (!session) return;
    this.syncCanonicalFromCompatibility(session);

    // 본인 유예 타이머만 취소 — 같은 방에서 다른 참가자가 별도로 끊긴 상태라면 그
    // 타이머는 건드리지 않는다(#157).
    const graceKey = `${roomId}:${userId}`;
    const timer = this.graceTimers.get(graceKey);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(graceKey);
    }

    server.to(`game:${roomId}`).emit('opponent_reconnected', { userId });

    clientSocket.emit('state_sync', this.buildStateSyncPayload(session));
  }

  /**
   * 특정 참가자 한 명만 탈락 처리한다 — 연결 끊김 유예 만료(handleDisconnect)와 명시적
   * 퇴장(AcidRainGateway.handleLeaveRoom) 양쪽에서 재사용한다(#157). 이전에는 두 경로
   * 모두 "상대"를 session.host/session.guest 2슬롯으로 하드코딩해 매치 전체를 끝내버렸다.
   * 이 한 명을 뺀 나머지가 아직 2명 이상 생존해 있으면 매치는 계속되고, 생존자가 1명
   * 이하로 줄면 자연스럽게 endMatch로 이어진다. 2인 매치에서는 결과적으로 지금까지와
   * 동일하게 동작한다(한 명 탈락 → 즉시 남은 한 명이 승자).
   */
  eliminateParticipant(
    roomId: string,
    participantId: string,
    server: Server,
    reason: MatchEndReason,
  ): void {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return;

    const participant = session.participants.find(
      (candidate) => candidate.participantId === participantId,
    );
    if (!participant || participant.status !== 'ACTIVE') return;

    participant.hp = 0;
    session.hpByParticipantId[participantId] = 0;
    this.syncCompatibilityHp(session);
    this.eliminateBatch(session, [participantId]);

    if (this.aliveParticipants(session).length <= 1) {
      this.safeEndMatch(roomId, reason, server);
    } else {
      // 매치는 계속되지만 나머지 참가자들의 HP 화면을 즉시 갱신해줘야 한다 — 다음
      // word_cleared/word_missed까지 기다리게 두지 않는다.
      server
        .to(`game:${roomId}`)
        .emit('state_sync', this.buildStateSyncPayload(session));
      void this.persistSession(session);
    }
  }

  /**
   * 세션 상태를 state_sync 페이로드로 변환하는 순수 함수. 재접속(handleReconnect)과
   * 관전 입장(getSpectatorSnapshot) 양쪽에서 재사용한다 — session.host/session.guest를
   * 직접 참조하지 않고 participantStates/hpByParticipantId 변환 헬퍼만 거친다.
   */
  private buildStateSyncPayload(
    session: AcidRainSession,
  ): StateSyncEventPayload {
    const elapsed = Date.now() - session.startedAt;
    const spawnInterval = Math.max(
      700,
      2000 - 50 * Math.floor(elapsed / 10000),
    );

    return {
      roomId: session.roomId,
      participants: this.participantStates(session),
      hp: this.hpByParticipantId(session),
      activeWords: Array.from(session.activeWords.values()).map(
        ({
          wordId,
          text,
          keystrokes,
          lane,
          fallDurationMs,
          spawnedAt,
          landAt,
          damage,
        }): ActiveWordStatePayload => ({
          wordId,
          text,
          keystrokes,
          lane,
          fallDurationMs,
          spawnedAt,
          landAt: new Date(landAt).toISOString(),
          damage,
          status: 'ACTIVE',
        }),
      ),
      elapsedMs: elapsed,
      spawnIntervalMs: spawnInterval,
      now: new Date().toISOString(),
    };
  }

  /**
   * 관전자 입장 시 보낼 초기 스냅샷. 매치가 진행 중(IN_PROGRESS)일 때만 값을 반환하고,
   * 세션이 없거나 아직 COUNTDOWN/이미 FINISHED면 null — 게이트웨이가 거부 사유로 사용한다.
   * 관전자는 room.players/세션 어디에도 등록되지 않으므로 이 메서드는 조회만 하고 아무
   * 상태도 바꾸지 않는다.
   */
  getSpectatorSnapshot(roomId: string): StateSyncEventPayload | null {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return null;
    return this.buildStateSyncPayload(session);
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
      const payload: MatchEndEventPayload = {
        roomId,
        winnerId: snapshot.winnerId,
        reason: snapshot.reason,
        finalHp: snapshot.finalHpByParticipantId,
        ranking: this.rankingForParticipants(session, snapshot),
        wordsTyped: snapshot.wordsTypedByParticipantId,
        durationSec: snapshot.durationSec,
      };
      server.to(`game:${roomId}`).emit('match_end', payload);
      matchEndedTotal.inc({ reason: snapshot.reason });
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

    // 두 플레이어 상태 ONLINE으로 복원 (DB + Redis + 친구 실시간 알림)
    if (!finalization.usersOnline) {
      const humanIds = session.participants
        .filter(
          (participant) => participant.type === 'HUMAN' && participant.userId,
        )
        .map((participant) => participant.userId!);
      await this.userRepo.update(humanIds, {
        status: UserStatus.ONLINE,
      });
      await Promise.all(
        humanIds.map((id) => this.chatGateway.setUserStatus(id, 'ONLINE')),
      );
      await Promise.all(
        humanIds.map((id) => this.chatGateway.notifyFriends(id, 'ONLINE')),
      );
      finalization.usersOnline = true;
    }

    if (!finalization.historySaved) {
      await this.saveMatchHistory(
        session,
        snapshot,
        session.mode === 'AI_PRACTICE' ? MatchMode.AI_PRACTICE : MatchMode.PVP,
      );
      finalization.historySaved = true;
    }

    this.sessions.delete(roomId);
    this.deleteProcessedAttemptsForRoom(roomId);
    activeGames.set(this.sessions.size);
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
    this.syncCanonicalFromCompatibility(session);
    const ranking = this.calculateRanking(session, reason);
    // FORFEIT도 랭킹에서 승자를 추론해야 한다 — eliminateParticipant(#157)가 탈락 처리
    // 후 남은 생존자를 승자로 명시하지 않고 endMatch를 호출하기 때문에(3~4인 매치에서는
    // "상대"가 하나로 정해지지 않으므로 overrideWinnerId를 줄 수 없다), FORFEIT이어도
    // ranking 기반 추론이 없으면 winnerId가 항상 null이 되어버린다.
    let winnerId: string | null = overrideWinnerId ?? null;
    if (!winnerId) {
      const first = ranking.filter((entry) => entry.rank === 1);
      if (first.length === 1) winnerId = first[0].participantId;
    }

    return {
      reason,
      winnerId,
      finalHp: { ...session.hp },
      wordsTyped: { ...session.wordsTyped },
      finalHpByParticipantId: this.hpByParticipantId(session),
      wordsTypedByParticipantId: this.allWordsTypedByParticipantId(session),
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
    };
  }

  // ─── Redis 영속화 ─────────────────────────────────────────────────────────

  private async persistSession(session: AcidRainSession): Promise<void> {
    if (
      this.sessions.get(session.roomId) !== session ||
      session.status === 'FINISHED'
    ) {
      return;
    }

    const roomId = session.roomId;
    const previous = this.pendingSessionPersists.get(roomId);
    const persist = (previous ?? Promise.resolve())
      .catch((err: unknown) => {
        this.logger.error('Previous Acid Rain session persist failed', err);
      })
      .then(async () => {
        if (
          this.sessions.get(session.roomId) !== session ||
          session.status === 'FINISHED'
        ) {
          return;
        }

        const serializable = {
          roomId: session.roomId,
          host: session.host,
          guest: session.guest,
          participants: session.participants,
          hpByParticipantId: session.hpByParticipantId,
          mode: session.mode,
          nextEliminationOrder: session.nextEliminationOrder,
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
        const matchParticipantRepo = manager.getRepository(MatchParticipant);
        const [hostUser, guestUser] = await Promise.all([
          userRepo.findOneBy({ id: session.host.userId }),
          session.mode === 'AI_PRACTICE'
            ? Promise.resolve(null)
            : userRepo.findOneBy({ id: session.guest.userId }),
        ]);
        if (!hostUser || (session.mode !== 'AI_PRACTICE' && !guestUser)) {
          throw new Error('Acid Rain match participant not found');
        }

        const winnerParticipant = snapshot.winnerId
          ? session.participants.find(
              (participant) => participant.participantId === snapshot.winnerId,
            )
          : undefined;
        const winnerUser =
          winnerParticipant?.type === 'HUMAN' && winnerParticipant.userId
            ? await userRepo.findOneBy({ id: winnerParticipant.userId })
            : null;
        if (
          winnerParticipant?.type === 'HUMAN' &&
          snapshot.winnerId &&
          !winnerUser
        ) {
          throw new Error('Acid Rain match winner not found');
        }

        const history = matchHistoryRepo.create({
          hostUser,
          ...(guestUser ? { guestUser } : {}),
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

        // N인 참가자 목록 — 2인 매치도 포함해 항상 채운다(getUserMatches가 이미
        // participants[]를 조회하도록 구현돼 있음 — #157 이전에는 이 테이블에 PVP 매치가
        // 한 번도 저장되지 않아 3~4인 매치의 3번째/4번째 참가자가 전적에서 아예 누락됐다).
        const ranking = this.rankingForParticipants(session, snapshot);
        const humanParticipants = session.participants.filter(
          (participant) => participant.type === 'HUMAN' && participant.userId,
        );
        const participantUsers = await Promise.all(
          humanParticipants.map((participant) =>
            userRepo.findOneBy({ id: participant.userId! }),
          ),
        );
        const participantRows = humanParticipants
          .map((participant, index) => {
            const user = participantUsers[index];
            if (!user) return null;
            const rank =
              ranking.find(
                (entry) => entry.participantId === participant.participantId,
              )?.rank ?? 0;
            return matchParticipantRepo.create({
              match: history,
              user,
              finalHp:
                snapshot.finalHpByParticipantId[participant.participantId] ?? 0,
              rank,
            });
          })
          .filter((row): row is MatchParticipant => row !== null);
        if (participantRows.length > 0) {
          await matchParticipantRepo.save(participantRows);
        }

        // PVP만 wins/losses/draws에 반영 — AI 연습은 랭킹에 영향 없음 (#104)
        if (mode !== MatchMode.PVP) return;

        const rank1Ids = ranking
          .filter((entry) => entry.rank === 1)
          .map((entry) => entry.participantId);
        const winnerHumanIds = humanParticipants
          .filter((participant) => rank1Ids.includes(participant.participantId))
          .map((participant) => participant.userId!);
        const loserHumanIds = humanParticipants
          .filter(
            (participant) => !rank1Ids.includes(participant.participantId),
          )
          .map((participant) => participant.userId!);

        if (winnerHumanIds.length === 1) {
          // 단독 1위 — 승자는 wins, 나머지 전원은 losses.
          const [winnerUpdate, ...loserUpdates] = await Promise.all([
            userRepo.increment({ id: winnerHumanIds[0] }, 'wins', 1),
            ...loserHumanIds.map((id) =>
              userRepo.increment({ id }, 'losses', 1),
            ),
          ]);
          this.assertStatsUpdated(winnerUpdate, 'winner wins');
          loserUpdates.forEach((update) =>
            this.assertStatsUpdated(update, 'loser losses'),
          );
        } else {
          // 공동 1위(무승부) — 승패 어느 쪽도 아니지만 게임을 하긴 했으므로 참가자 전원을
          // draws로 카운트한다.
          const drawUpdates = await Promise.all(
            humanParticipants.map((participant) =>
              userRepo.increment({ id: participant.userId! }, 'draws', 1),
            ),
          );
          drawUpdates.forEach((update) =>
            this.assertStatsUpdated(update, 'participant draws'),
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

  private deleteProcessedAttemptsForRoom(roomId: string): void {
    for (const [key, record] of this.processedAttempts) {
      if (record.roomId === roomId) this.processedAttempts.delete(key);
    }
  }

  private cloneJudgeResult(
    result: JudgeWordSubmitResult,
  ): JudgeWordSubmitResult {
    if (result.accepted) {
      return {
        ...result,
        targetHp: { ...result.targetHp },
        targetHpByParticipantId: result.targetHpByParticipantId
          ? { ...result.targetHpByParticipantId }
          : undefined,
        wordCleared: {
          ...result.wordCleared,
          hp: { ...result.wordCleared.hp },
        },
      };
    }

    return {
      ...result,
      targetHp: result.targetHp ? { ...result.targetHp } : undefined,
      targetHpByParticipantId: result.targetHpByParticipantId
        ? { ...result.targetHpByParticipantId }
        : undefined,
      submitRejected: { ...result.submitRejected },
    };
  }

  private isParticipant(session: AcidRainSession, playerId: string): boolean {
    return session.participants.some(
      (participant) => participant.participantId === playerId,
    );
  }

  private transitionWord(
    session: AcidRainSession,
    wordId: string,
    state: 'CLEARED' | 'MISSED',
    playerId?: string,
    attemptId?: string,
  ): boolean {
    const word = session.activeWords.get(wordId);
    if (!word || session.resolvedWords.has(wordId)) return false;
    session.activeWords.delete(wordId);
    session.occupiedLanes.delete(word.lane);
    session.resolvedWords.set(wordId, { state, playerId, attemptId });
    return true;
  }

  private aliveParticipants(session: AcidRainSession): ParticipantRuntime[] {
    return session.participants.filter(
      (participant) => participant.status === 'ACTIVE' && participant.hp > 0,
    );
  }

  private selectAttackTarget(
    session: AcidRainSession,
    attackerId: string,
  ): ParticipantRuntime | undefined {
    const candidates = this.aliveParticipants(session).filter(
      (participant) => participant.participantId !== attackerId,
    );
    if (candidates.length === 0) return undefined;
    const index = Math.min(
      candidates.length - 1,
      Math.max(0, Math.floor(this.random() * candidates.length)),
    );
    return candidates[index];
  }

  private applyDamage(
    session: AcidRainSession,
    participantId: string,
    damage: number,
  ): void {
    const participant = session.participants.find(
      (candidate) => candidate.participantId === participantId,
    );
    if (!participant || participant.status !== 'ACTIVE') return;
    participant.hp = Math.max(0, participant.hp - damage);
    session.hpByParticipantId[participantId] = participant.hp;
    this.syncCompatibilityHp(session);
    if (participant.hp === 0) this.eliminateBatch(session, [participantId]);
  }

  private eliminateBatch(
    session: AcidRainSession,
    participantIds: string[],
  ): void {
    const ids = [...new Set(participantIds)].filter((participantId) => {
      const participant = session.participants.find(
        (candidate) => candidate.participantId === participantId,
      );
      return participant?.status === 'ACTIVE' && participant.hp <= 0;
    });
    if (ids.length === 0) return;
    const order = session.nextEliminationOrder++;
    for (const participantId of ids) {
      const participant = session.participants.find(
        (candidate) => candidate.participantId === participantId,
      )!;
      participant.status = 'ELIMINATED';
      participant.eliminatedAt = Date.now();
      participant.eliminationOrder = order;
      participant.rank = undefined;
    }
  }

  private incrementWordsTypedCompatibility(
    session: AcidRainSession,
    participantId: string,
  ): void {
    if (participantId === session.host.userId) session.wordsTyped.host++;
    if (participantId === session.guest.userId) session.wordsTyped.guest++;
  }

  private syncCompatibilityHp(session: AcidRainSession): void {
    session.hp.host = session.hpByParticipantId[session.host.userId] ?? 0;
    session.hp.guest = session.hpByParticipantId[session.guest.userId] ?? 0;
  }

  private syncCanonicalFromCompatibility(session: AcidRainSession): void {
    if (session.participants.length !== 2) return;
    const host = session.participants.find(
      (participant) => participant.participantId === session.host.userId,
    );
    const guest = session.participants.find(
      (participant) => participant.participantId === session.guest.userId,
    );
    if (!host || !guest) return;
    host.hp = session.hp.host;
    guest.hp = session.hp.guest;
    session.hpByParticipantId[host.participantId] = host.hp;
    session.hpByParticipantId[guest.participantId] = guest.hp;
    if (host.hp <= 0 || guest.hp <= 0) {
      this.eliminateBatch(
        session,
        [host, guest]
          .filter((participant) => participant.hp <= 0)
          .map((participant) => participant.participantId),
      );
    }
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
    if (reason === 'PLAYER_ELIMINATED') return 'PLAYER_ELIMINATED';
    if (reason === 'WORD_ALREADY_RESOLVED' && wordState === 'CLEARED') {
      return 'ALREADY_CLEARED';
    }
    return 'NOT_FOUND';
  }

  private determineWinner(session: AcidRainSession): string | null {
    // aliveParticipants 기준으로 통일한다 — host/guest HP만 비교하면 3~4인 매치에서
    // 마지막 생존자가 3번째/4번째 참가자일 때 틀린 승자를 반환했다.
    const alive = this.aliveParticipants(session);
    return alive.length === 1 ? alive[0].participantId : null;
  }

  private damageForKeystrokes(keystrokes: number): number {
    return 5 + Math.ceil(keystrokes / 2);
  }

  private participantStates(session: AcidRainSession): ParticipantState[] {
    return session.participants.map((participant) => ({ ...participant }));
  }

  private hpByParticipantId(session: AcidRainSession): HpByParticipantId {
    return { ...session.hpByParticipantId };
  }

  private hpPairToParticipantHp(
    session: AcidRainSession,
    hp: HpPair,
  ): HpByParticipantId {
    return {
      [session.host.userId]: hp.host,
      [session.guest.userId]: hp.guest,
    };
  }

  private wordsTypedByParticipantId(
    session: AcidRainSession,
    wordsTyped: { host: number; guest: number },
  ): Record<string, number> {
    return {
      [session.host.userId]: wordsTyped.host,
      [session.guest.userId]: wordsTyped.guest,
    };
  }

  private allWordsTypedByParticipantId(
    session: AcidRainSession,
  ): Record<string, number> {
    return Object.fromEntries(
      session.participants.map((participant) => [
        participant.participantId,
        participant.wordsTyped,
      ]),
    );
  }

  private calculateRanking(
    session: AcidRainSession,
    reason: MatchEndReason,
  ): RankingEntry[] {
    const participants = [...session.participants];
    if (reason === 'TIME_LIMIT') {
      participants.sort((a, b) => b.hp - a.hp || b.wordsTyped - a.wordsTyped);
      const entries: RankingEntry[] = [];
      let previous: ParticipantRuntime | undefined;
      let rank = 0;
      for (let index = 0; index < participants.length; index++) {
        const current = participants[index];
        if (
          !previous ||
          current.hp !== previous.hp ||
          current.wordsTyped !== previous.wordsTyped
        ) {
          rank = index + 1;
        }
        entries.push({ participantId: current.participantId, rank });
        previous = current;
      }
      return entries;
    }

    const alive = participants.filter(
      (participant) => participant.status === 'ACTIVE',
    );
    const eliminated = participants
      .filter((participant) => participant.status === 'ELIMINATED')
      .sort((a, b) => (b.eliminationOrder ?? 0) - (a.eliminationOrder ?? 0));
    const ordered = [...alive, ...eliminated];
    const entries: RankingEntry[] = [];
    let rank = 0;
    let previousOrder: number | undefined;
    ordered.forEach((participant, index) => {
      const order =
        participant.status === 'ACTIVE'
          ? Number.MAX_SAFE_INTEGER
          : participant.eliminationOrder;
      if (index === 0 || order !== previousOrder) rank = index + 1;
      entries.push({ participantId: participant.participantId, rank });
      previousOrder = order;
    });
    return entries;
  }

  private rankingForParticipants(
    session: AcidRainSession,
    snapshot: MatchFinalizationSnapshot,
  ): RankingEntry[] {
    return this.calculateRanking(session, snapshot.reason);
  }

  private rankingForCurrentOneVsOne(
    session: AcidRainSession,
    snapshot: MatchFinalizationSnapshot,
  ): RankingEntry[] {
    if (!snapshot.winnerId) {
      return [
        { participantId: session.host.userId, rank: 1 },
        { participantId: session.guest.userId, rank: 1 },
      ];
    }

    const loserId =
      snapshot.winnerId === session.host.userId
        ? session.guest.userId
        : session.host.userId;
    return [
      { participantId: snapshot.winnerId, rank: 1 },
      { participantId: loserId, rank: 2 },
    ];
  }
}
