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
  hp: HpPair;
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
  status: 'COUNTDOWN' | 'IN_PROGRESS' | 'FINISHED';
}

export interface ActiveWord extends Omit<WordSpawnPayload, 'landAt'> {
  /** 바닥 도달 예정 시각 (ms epoch) */
  landAt: number;
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
  targetParticipantId: string;
  damage: number;
  hp: HpByParticipantId;
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
  gameEnded: false;
  winnerId: null;
  loserId: null;
  endReason: null;
  submitRejected: SubmitRejectedEventPayload;
}

export type JudgeWordSubmitResult =
  | JudgeWordSubmitAccepted
  | JudgeWordSubmitRejected;
