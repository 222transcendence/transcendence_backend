export type MatchEndReason = 'KO' | 'TIME_LIMIT' | 'FORFEIT';
export type WordResolutionState = 'ACTIVE' | 'CLEARED' | 'MISSED';
export type ParticipantType = 'HUMAN' | 'AI';
export type AiDifficulty = 'BEGINNER' | 'NORMAL' | 'HARD';
export type SubmitRejectedReason =
  | 'ALREADY_CLEARED'
  | 'NOT_FOUND'
  | 'WRONG_TEXT';
export type JudgeRejectionReason =
  | 'ROOM_NOT_FOUND'
  | 'PLAYER_NOT_FOUND'
  | 'WORD_NOT_FOUND'
  | 'WORD_ALREADY_RESOLVED'
  | 'DUPLICATE_ATTEMPT'
  | 'INCORRECT_TEXT'
  | 'GAME_NOT_ACTIVE';

export interface PlayerPublic {
  userId: string;
  nickname: string;
}

export interface ParticipantPublic {
  participantId: string;
  userId?: string;
  nickname: string;
  type: ParticipantType;
  aiDifficulty?: AiDifficulty;
}

export interface ParticipantState extends ParticipantPublic {
  hp: number;
  rank?: number;
  status?: 'ACTIVE' | 'ELIMINATED' | 'DISCONNECTED';
  eliminationOrder?: number;
}

export interface ParticipantRuntime extends ParticipantState {
  wordsTyped: number;
  eliminatedAt?: number;
}

export interface HpPair {
  host: number;
  guest: number;
}

export type HpByParticipantId = Record<string, number>;

export interface RankingEntry {
  participantId: string;
  rank: number;
}

export interface WordSpawnPayload {
  wordId: string;
  text: string;
  /** 2벌식 키보드 기준 실제 타건 횟수 — 낙하 시간·데미지 계산에 쓰이므로 클라이언트도 함께 받는다. */
  keystrokes: number;
  lane: number;
  fallDurationMs: number;
  spawnedAt: string; // ISO8601
  landAt: string; // ISO8601
  damage: number;
}

export interface ActiveWordStatePayload extends WordSpawnPayload {
  status: 'ACTIVE';
}

export interface AcidRainSession {
  roomId: string;
  host: PlayerPublic;
  guest: PlayerPublic;
  participants: ParticipantRuntime[];
  hp: HpPair;
  hpByParticipantId: HpByParticipantId;
  wordsTyped: { host: number; guest: number };
  activeWords: Map<string, ActiveWord>;
  startedAt: number; // Date.now()
  countdownTimer: ReturnType<typeof setTimeout> | null;
  spawnLoopTimer: ReturnType<typeof setTimeout> | null;
  missLoopTimer: ReturnType<typeof setInterval> | null;
  matchEndTimer: ReturnType<typeof setTimeout> | null;
  /** 현재 낙하 중인 단어별 레인 점유 현황 */
  occupiedLanes: Set<number>;
  /** wordId → 최종 단어 상태, ACTIVE가 아닌 단어의 재판정 방지용 */
  resolvedWords: Map<string, ResolvedWord>;
  nextEliminationOrder: number;
  mode: 'PVP' | 'AI_PRACTICE';
  status: 'COUNTDOWN' | 'IN_PROGRESS' | 'FINISHED';
  /** participantId → wordId → 타건 추적 상태 (#160) */
  typingTracker: Map<string, Map<string, WordTypingState>>;
}

export interface ActiveWord extends Omit<WordSpawnPayload, 'landAt'> {
  /** 바닥 도달 예정 시각 (ms epoch) */
  landAt: number;
}

export interface TypingProgressPayload {
  roomId: string;
  /** 현재 입력 중인 텍스트 (빈 문자열이면 입력 초기화) */
  partialText: string;
  /** 현재 목표 단어 ID (#160) */
  wordId?: string;
  /** 클라이언트 타임스탬프 — 참고용, 권위 있는 계산에는 사용 안 함 (#160) */
  clientTs?: number;
}

/** 단어 하나에 대한 참가자별 인메모리 타건 추적 상태 (#160) */
export interface WordTypingState {
  sequence: number;
  firstTypingAt: Date | null;
  lastTypingAt: Date | null;
  prevPartialText: string;
  typoCount: number;
  correctionCount: number;
  totalKeystrokes: number;
  keystrokeBuffer: Array<{
    wordId: string;
    sequence: number;
    partialText: string;
    textLength: number;
    inputType: string;
    clientTs?: number;
    serverReceivedAt: Date;
  }>;
}

export interface OpponentTypingEventPayload {
  participantId: string;
  partialText: string;
}

export interface JoinRoomPayload {
  roomId: string;
}

export interface LeaveRoomPayload {
  roomId: string;
}

/** JoinRoomPayload와 모양은 같지만 의미(관전 입장)를 명확히 구분하기 위한 별도 타입 */
export interface SpectateRoomPayload {
  roomId: string;
}

/** 관전 종료(인앱 이동 등 명시적 종료) — 소켓 disconnect를 기다리지 않고 즉시 정리하기 위함 */
export interface LeaveSpectatePayload {
  roomId: string;
}

export interface WordSubmitPayload {
  roomId: string;
  wordId: string;
  text: string;
  clientTs: number;
  attemptId: string;
}

export interface JudgeWordSubmitInput {
  roomId: string;
  playerId: string;
  wordId: string;
  text: string;
  attemptId?: string;
}

export interface WordClearedEventPayload {
  wordId: string;
  clearedBy: string;
  targetParticipantId?: string;
  damage: number;
  hp: HpByParticipantId;
  targetHpByParticipantId?: HpByParticipantId;
}

export interface WordMissedEventPayload {
  wordId: string;
  splashDamage: number;
  hp: HpByParticipantId;
}

export interface SubmitRejectedEventPayload {
  wordId: string;
  reason: SubmitRejectedReason;
}

export interface MatchReadyEventPayload {
  roomId: string;
  protocolVersion: string;
  participants: ParticipantState[];
}

export interface StateSyncEventPayload {
  roomId: string;
  participants: ParticipantState[];
  hp: HpByParticipantId;
  activeWords: ActiveWordStatePayload[];
  elapsedMs: number;
  spawnIntervalMs: number;
  now: string;
}

export interface MatchEndEventPayload {
  roomId: string;
  winnerId: string | null;
  reason: MatchEndReason;
  finalHp: HpByParticipantId;
  ranking: RankingEntry[];
  wordsTyped: Record<string, number>;
  durationSec: number;
}

export interface ResolvedWord {
  state: Exclude<WordResolutionState, 'ACTIVE'>;
  playerId?: string;
  attemptId?: string;
  spawnedAt?: string; // ISO8601, 반응시간 계산용 (#160)
}

export interface JudgeWordSubmitAccepted {
  accepted: true;
  roomId: string;
  playerId: string;
  wordId: string;
  attemptId?: string;
  wordStateBefore: 'ACTIVE';
  wordStateAfter: 'CLEARED';
  damage: number;
  targetHp: HpPair;
  targetHpByParticipantId?: HpByParticipantId;
  gameEnded: boolean;
  winnerId: string | null;
  loserId: string | null;
  endReason: Extract<MatchEndReason, 'KO'> | null;
  wordCleared: WordClearedEventPayload;
}

export interface JudgeWordSubmitRejected {
  accepted: false;
  roomId: string;
  playerId: string;
  wordId: string;
  attemptId?: string;
  reason: JudgeRejectionReason;
  wordStateBefore?: WordResolutionState;
  wordStateAfter?: WordResolutionState;
  damage: 0;
  targetHp?: HpPair;
  targetHpByParticipantId?: HpByParticipantId;
  gameEnded: false;
  winnerId: null;
  loserId: null;
  endReason: null;
  submitRejected: SubmitRejectedEventPayload;
}

export type JudgeWordSubmitResult =
  | JudgeWordSubmitAccepted
  | JudgeWordSubmitRejected;
