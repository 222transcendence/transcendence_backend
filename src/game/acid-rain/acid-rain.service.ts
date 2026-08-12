import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
  HpByParticipantId,
  JudgeRejectionReason,
  JudgeWordSubmitInput,
  JudgeWordSubmitResult,
  MatchEndEventPayload,
  MatchEndReason,
  ParticipantState,
  ParticipantRuntime,
  ParticipantPublic,
  RankingEntry,
  StateSyncEventPayload,
  SubmitRejectedReason,
  WordClearedEventPayload,
  WordMissedEventPayload,
  WordSpawnPayload,
  WordResolutionState,
} from './acid-rain.interface';
import { WordDictionaryService } from '../../word-dictionary/word-dictionary.service';
import { PerformanceService } from './performance.service';
import { AiScheduler } from './ai/ai-scheduler';
import { AiExecutor } from './ai/ai-executor';
import { toAiRuntimeWords } from './ai/active-word.mapper';
import type { AiStateChange } from './ai/ai-execution.types';

const INITIAL_HP = 100;
const MATCH_DURATION_MS = 180_000;
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
  finalHpByParticipantId: HpByParticipantId;
  wordsTypedByParticipantId: Record<string, number>;
  durationSec: number;
  ranking: RankingEntry[];
}

@Injectable()
export class AcidRainService implements OnModuleInit {
  private readonly logger = new Logger(AcidRainService.name);
  // roomId → in-memory session (단일 인스턴스 기준)
  private readonly sessions = new Map<string, AcidRainSession>();
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
    private readonly performanceService: PerformanceService,
    @InjectRepository(MatchHistory)
    private readonly matchHistoryRepo: Repository<MatchHistory>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Optional()
    @Inject(ACID_RAIN_RANDOM)
    private readonly random: () => number = Math.random,
    @Optional()
    private readonly aiScheduler: AiScheduler = new AiScheduler(
      new AiExecutor(),
    ),
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
    server: Server,
    participantPublics: ParticipantPublic[],
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
      participants,
      hpByParticipantId,
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
      typingTracker: new Map(),
      stateVersion: 0,
    };
    this.sessions.set(roomId, session);
    if (mode === 'AI_PRACTICE') {
      const ai = participants.find((participant) => participant.type === 'AI');
      if (!ai?.aiDifficulty) {
        throw new Error('AI practice session is missing AI difficulty');
      }
      this.aiScheduler.registerRoom({
        roomId,
        aiParticipantId: ai.participantId,
        difficulty: ai.aiDifficulty,
        submitWord: (input) => this.submitWord(input, server),
        emitTypingProgress: (participantId, partialText) => {
          server.to(`game:${roomId}`).emit('opponent_typing', {
            participantId,
            partialText,
          });
        },
      });
    }
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
      session.stateVersion += 1;

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
      this.notifyAiStateChanged(session, server, 'SPAWN');
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
      this.eliminateBatch(session, [...newlyEliminated]);

      for (const wordId of missed) {
        const payload: WordMissedEventPayload = {
          wordId,
          splashDamage: SPLASH_DAMAGE,
          hp: this.hpByParticipantId(session),
        };
        server.to(`game:${session.roomId}`).emit('word_missed', payload);
        wordMissedTotal.inc();
        this.flushMissedWordAttempts(session, wordId);
      }

      if (this.aliveParticipants(session).length <= 1) {
        this.safeEndMatch(session.roomId, 'KO', server);
      } else {
        this.notifyAiStateChanged(session, server, 'MISS');
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
      this.flushWordAttemptOnClear(input, result.roomId);
      if (result.gameEnded && outcome.attemptKey) {
        await this.finalizeKoAttempt(outcome.attemptKey, result, server);
      } else if (result.gameEnded) {
        await this.endMatch(result.roomId, 'KO', server);
      } else if (outcome.sessionToPersist) {
        this.notifyAiStateChanged(outcome.sessionToPersist, server, 'CLEAR');
        await this.persistSession(outcome.sessionToPersist);
      }
    }

    return result;
  }

  private flushWordAttemptOnClear(
    input: JudgeWordSubmitInput,
    roomId: string,
  ): void {
    const session = this.sessions.get(roomId);
    if (!session) return;
    const participant = session.participants.find(
      (p) => p.participantId === input.playerId,
    );
    if (!participant) return;
    const wordTracker = session.typingTracker.get(input.playerId);
    const state = wordTracker?.get(input.wordId);
    const now = new Date();
    const spawnedAtStr = session.resolvedWords.get(input.wordId)?.spawnedAt;
    const wordSpawnedAt = spawnedAtStr ? new Date(spawnedAtStr) : null;
    void this.performanceService
      .flushWordAttempt({
        matchId: roomId,
        participantId: input.playerId,
        userId: participant.userId,
        wordId: input.wordId,
        result: state?.typoCount === 0 ? 'CORRECT' : 'CORRECT_AFTER_CORRECTION',
        submittedText: input.text,
        submitReceivedAt: now,
        resolvedAt: now,
        wordSpawnedAt,
        state: state ?? this.emptyWordTypingState(),
      })
      .catch((err: unknown) =>
        this.logger.error('flushWordAttempt error', err),
      );
    wordTracker?.delete(input.wordId);
  }

  private emptyWordTypingState() {
    return {
      sequence: 0,
      firstTypingAt: null,
      lastTypingAt: null,
      prevPartialText: '',
      typoCount: 0,
      correctionCount: 0,
      totalKeystrokes: 0,
      keystrokeBuffer: [],
    };
  }

  private flushWrongAttempt(
    session: AcidRainSession,
    input: JudgeWordSubmitInput,
    wordSpawnedAtStr: string,
    submittedText: string,
  ): void {
    const participant = session.participants.find(
      (p) => p.participantId === input.playerId,
    );
    if (!participant || participant.type === 'AI') return;
    const now = new Date();
    const wordTracker = session.typingTracker.get(input.playerId);
    const state = wordTracker?.get(input.wordId) ?? this.emptyWordTypingState();
    void this.performanceService
      .flushWordAttempt({
        matchId: session.roomId,
        participantId: input.playerId,
        userId: participant.userId,
        wordId: input.wordId,
        result: 'WRONG',
        submittedText,
        submitReceivedAt: now,
        resolvedAt: now,
        wordSpawnedAt: wordSpawnedAtStr ? new Date(wordSpawnedAtStr) : null,
        state,
      })
      .catch((err: unknown) =>
        this.logger.error('flushWrongAttempt error', err),
      );
  }

  private flushMissedWordAttempts(
    session: AcidRainSession,
    wordId: string,
  ): void {
    const now = new Date();
    const spawnedAtStr = session.resolvedWords.get(wordId)?.spawnedAt;
    const wordSpawnedAt = spawnedAtStr ? new Date(spawnedAtStr) : null;
    for (const participant of session.participants) {
      if (participant.type === 'AI') continue;
      const wordTracker = session.typingTracker.get(participant.participantId);
      const state = wordTracker?.get(wordId) ?? this.emptyWordTypingState();
      void this.performanceService
        .flushWordAttempt({
          matchId: session.roomId,
          participantId: participant.participantId,
          userId: participant.userId,
          wordId,
          result: 'MISSED',
          submittedText: null,
          submitReceivedAt: null,
          resolvedAt: now,
          wordSpawnedAt,
          state,
        })
        .catch((err: unknown) =>
          this.logger.error('flushWordAttempt(missed) error', err),
        );
      wordTracker?.delete(wordId);
    }
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
      this.flushWrongAttempt(session, input, word.spawnedAt, text);
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

    const target = this.selectAttackTarget(session, playerId);
    const damage = target ? this.damageForKeystrokes(word.keystrokes) : 0;
    if (target) this.applyDamage(session, target.participantId, damage);

    const gameEnded = this.aliveParticipants(session).length <= 1;
    const winnerId = gameEnded ? this.determineWinner(session) : null;
    const loserId =
      winnerId && session.participants.length === 2
        ? session.participants.find(
            (participant) => participant.participantId !== winnerId,
          )!.participantId
        : null;
    const wordCleared: WordClearedEventPayload = {
      wordId,
      clearedBy: playerId,
      ...(target ? { targetParticipantId: target.participantId } : {}),
      damage,
      hp: this.hpByParticipantId(session),
      targetHpByParticipantId: this.hpByParticipantId(session),
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
      targetHpByParticipantId: this.hpByParticipantId(session),
      gameEnded,
      winnerId,
      loserId,
      endReason: gameEnded ? 'KO' : null,
      wordCleared,
    };
    return this.recordOutcome(attemptKey, input, result, session);
  }

  // ─── 재접속 처리 ──────────────────────────────────────────────────────────

  // 연결이 끊긴 참가자는 소켓이 없으니 애초에 단어를 제출(공격)할 수 없고, 반대로 다른
  // 생존자들의 타겟 선택/스플래시 데미지는 연결 여부와 무관하게 살아있는 참가자 전원을
  // 대상으로 하므로 계속 맞을 수는 있다 — 이미 자연스러운 페널티가 있다. 언제든 다시
  // join_room으로 재접속할 수 있고, 매치 자체도 MATCH_DURATION_MS(180초) 하드 타임아웃이
  // 있어 무한정 멈춰있을 수 없다. 그래서 강제 탈락/그레이스 타이머는 두지 않는다(#161) —
  // 화장실을 다녀오거나 새로고침이 잠깐 오래 걸리는 정상적인 경우까지 게임에서 쫓아내는
  // 부작용만 있었다. (명시적 "나가기"는 다르다 — AcidRainGateway.handleLeaveRoom은 계속
  // leaveMatch로 즉시 탈락 처리한다.)
  handleDisconnect(roomId: string, userId: string, server: Server): void {
    const session = this.sessions.get(roomId);
    if (!session || session.status === 'FINISHED') return;

    server.to(`game:${roomId}`).emit('opponent_disconnected', { userId });
  }

  /**
   * 명시적 leave_room(IN_PROGRESS 중)을 위한 진입점. disconnect의 유예 타이머와 달리
   * 즉시 탈락 처리한다. endMatch 실패 시 에러를 그대로 호출부(게이트웨이)로 전파한다.
   */
  async leaveMatch(
    roomId: string,
    userId: string,
    server: Server,
  ): Promise<void> {
    const session = this.sessions.get(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return;
    await this.applyForfeitAndMaybeEnd(session, userId, server);
  }

  /**
   * 참가자 1명을 기권 탈락 처리한 뒤, 생존자가 1명 이하로 남았을 때만 매치를 종료한다
   * (N인 매치에서 1명이 나가도 나머지 생존자들의 게임은 계속된다).
   */
  private async applyForfeitAndMaybeEnd(
    session: AcidRainSession,
    participantId: string,
    server: Server,
  ): Promise<void> {
    this.forfeitParticipant(session, participantId);
    if (this.aliveParticipants(session).length <= 1) {
      await this.endMatch(session.roomId, 'FORFEIT', server);
    } else {
      void this.persistSession(session);
    }
  }

  private forfeitParticipant(
    session: AcidRainSession,
    participantId: string,
  ): void {
    const participant = session.participants.find(
      (candidate) => candidate.participantId === participantId,
    );
    if (!participant || participant.status !== 'ACTIVE') return;
    participant.hp = 0;
    session.hpByParticipantId[participantId] = 0;
    this.eliminateBatch(session, [participantId]);
  }

  handleReconnect(
    roomId: string,
    userId: string,
    server: Server,
    clientSocket: import('socket.io').Socket,
  ): void {
    const session = this.sessions.get(roomId);
    if (!session) return;

    server.to(`game:${roomId}`).emit('opponent_reconnected', { userId });

    clientSocket.emit('state_sync', this.buildStateSyncPayload(session));
  }

  /**
   * 세션 상태를 state_sync 페이로드로 변환하는 순수 함수. 재접속(handleReconnect)과
   * 관전 입장(getSpectatorSnapshot) 양쪽에서 재사용한다 — participantStates/
   * hpByParticipantId 변환 헬퍼만 거친다.
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

    this.aiScheduler.invalidate(roomId);
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
        ranking: snapshot.ranking,
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
    this.aiScheduler.destroy(roomId);
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
  ): MatchFinalizationSnapshot {
    const ranking = this.calculateRanking(session, reason);
    let winnerId: string | null = null;
    const first = ranking.filter((entry) => entry.rank === 1);
    if (first.length === 1) winnerId = first[0].participantId;

    return {
      reason,
      winnerId,
      finalHpByParticipantId: this.hpByParticipantId(session),
      wordsTypedByParticipantId: this.allWordsTypedByParticipantId(session),
      durationSec: Math.round((Date.now() - session.startedAt) / 1000),
      ranking,
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
          participants: session.participants,
          hpByParticipantId: session.hpByParticipantId,
          mode: session.mode,
          nextEliminationOrder: session.nextEliminationOrder,
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

  /**
   * N인(2~4) 참가자 모델 기준 전적 저장. hostUser/guestUser는 하위호환 컬럼이라 신규
   * 레코드에는 채우지 않는다 — participants(MatchParticipant) 조인 테이블이 정본이다
   * (game.service.ts의 getUserMatches()가 이미 그쪽을 읽음). AI 참가자는 User FK가 없어
   * MatchParticipant 대상에서 제외한다.
   *
   * 승패 스탯 규칙: 단독 1위만 wins+1, 나머지 HUMAN 전원 losses+1. 1위가 동점(공동 1위)이면
   * 그 동점자들만 draws+1, 나머지는 losses+1.
   */
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

        const humanParticipants = session.participants.filter(
          (participant) => participant.type === 'HUMAN' && participant.userId,
        );
        const humanUserIds = humanParticipants.map(
          (participant) => participant.userId!,
        );
        const users = await userRepo.findBy({ id: In(humanUserIds) });
        if (users.length !== humanParticipants.length) {
          throw new Error('Acid Rain match participant not found');
        }
        const usersById = new Map(users.map((user) => [user.id, user]));

        const winnerUser = snapshot.winnerId
          ? (usersById.get(snapshot.winnerId) ?? null)
          : null;

        const history = matchHistoryRepo.create({
          winner: winnerUser,
          mode,
          roundsPlayed: 1,
          matchData: {
            finalHp: { ...snapshot.finalHpByParticipantId },
            wordsTyped: { ...snapshot.wordsTypedByParticipantId },
            durationSec: snapshot.durationSec,
            reason: snapshot.reason,
          },
        });
        await matchHistoryRepo.save(history);

        const rankByParticipantId = new Map(
          snapshot.ranking.map((entry) => [entry.participantId, entry.rank]),
        );
        const participantRows = humanParticipants.map((participant) =>
          participantRepo.create({
            match: history,
            user: usersById.get(participant.userId!)!,
            finalHp: participant.hp,
            rank: rankByParticipantId.get(participant.participantId) ?? 0,
          }),
        );
        await participantRepo.save(participantRows);

        // PVP만 wins/losses/draws에 반영 — AI 연습은 랭킹에 영향 없음 (#104)
        if (mode !== MatchMode.PVP) return;

        const rank1UserIds = humanParticipants
          .filter(
            (participant) =>
              rankByParticipantId.get(participant.participantId) === 1,
          )
          .map((participant) => participant.userId!);
        const soleWinner = rank1UserIds.length === 1;
        const winnerIds = soleWinner ? rank1UserIds : [];
        const drawIds = soleWinner ? [] : rank1UserIds;
        const loserIds = humanUserIds.filter(
          (userId) => !winnerIds.includes(userId) && !drawIds.includes(userId),
        );

        const updates = await Promise.all([
          ...winnerIds.map((id) => userRepo.increment({ id }, 'wins', 1)),
          ...drawIds.map((id) => userRepo.increment({ id }, 'draws', 1)),
          ...loserIds.map((id) => userRepo.increment({ id }, 'losses', 1)),
        ]);
        updates.forEach((update) =>
          this.assertStatsUpdated(update, 'participant stat update'),
        );
      });
    } catch (err) {
      this.logger.error('Failed to save MatchHistory', err);
      throw err;
    }

    const resultStatus = snapshot.winnerId ? 'FINISHED' : 'ABORTED';
    await this.performanceService.saveParticipantPerformances(
      session,
      session.roomId,
      resultStatus,
    );
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
      targetHpByParticipantId: session
        ? this.hpByParticipantId(session)
        : undefined,
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
        targetHpByParticipantId: { ...result.targetHpByParticipantId },
        wordCleared: {
          ...result.wordCleared,
          hp: { ...result.wordCleared.hp },
          targetHpByParticipantId: {
            ...result.wordCleared.targetHpByParticipantId,
          },
        },
      };
    }

    return {
      ...result,
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
    session.resolvedWords.set(wordId, {
      state,
      playerId,
      attemptId,
      spawnedAt: word.spawnedAt,
    });
    session.stateVersion += 1;
    return true;
  }

  private notifyAiStateChanged(
    session: AcidRainSession,
    _server: Server,
    event: AiStateChange['event'],
  ): void {
    if (session.mode !== 'AI_PRACTICE' || session.status !== 'IN_PROGRESS') {
      return;
    }
    this.aiScheduler.onStateChange({
      roomId: session.roomId,
      stateVersion: session.stateVersion,
      activeWords: toAiRuntimeWords(session.activeWords),
      status: session.status,
      event,
    });
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
}
