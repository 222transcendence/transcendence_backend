export type MatchEndReason = 'KO' | 'TIME_LIMIT' | 'FORFEIT';
export type WordResolutionState = 'ACTIVE' | 'CLEARED' | 'MISSED';
export type SubmitRejectedReason =
  | 'ALREADY_CLEARED'
  | 'NOT_FOUND'
  | 'WRONG_TEXT';
export type JudgeRejectionReason =
  | 'ROOM_NOT_FOUND'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_ELIMINATED'
  | 'WORD_NOT_FOUND'
  | 'WORD_ALREADY_RESOLVED'
  | 'DUPLICATE_ATTEMPT'
  | 'INCORRECT_TEXT'
  | 'GAME_NOT_ACTIVE';

export interface PlayerPublic {
  userId: string;
  nickname: string;
}

/** userId → 값. 탈락자도 항상 포함되며(값 0), 존재 자체는 §6.3 state_sync/word_cleared 등에서 유지된다. */
export type HpMap = Record<string, number>;

export interface WordSpawnPayload {
  wordId: string;
  text: string;
  /** 2벌식 키보드 기준 실제 타건 횟수 — 낙하 시간·데미지 계산에 쓰이므로 클라이언트도 함께 받는다. */
  keystrokes: number;
  lane: number;
  fallDurationMs: number;
  spawnedAt: string; // ISO8601
}

/** 매치 종료 시 확정되는 참가자별 순위. rank 1 = 우승(공동 우승 가능). */
export interface RankedParticipant {
  userId: string;
  rank: number;
}

export interface AcidRainSession {
  roomId: string;
  /** 매치 시작 시점에 확정되는 참가자 순서(2~4명) — 이후 인원이 늘거나 줄지 않는다. */
  players: PlayerPublic[];
  hp: HpMap;
  wordsTyped: Record<string, number>;
  /** 탈락 처리된 참가자 목록, 탈락 순서대로 push됨(동시 탈락은 같은 rank로 여러 명이 한 번에 push). */
  eliminated: RankedParticipant[];
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

export interface ActiveWord extends WordSpawnPayload {
  /** 바닥 도달 예정 시각 (ms epoch) */
  landAt: number;
}

export interface JoinRoomPayload {
  roomId: string;
}

export interface LeaveRoomPayload {
  roomId: string;
}

export interface WordSubmitPayload {
  roomId: string;
  wordId: string;
  text: string;
  clientTs: number;
  attemptId?: string;
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
  targetUserId: string;
  damage: number;
  hp: HpMap;
}

export interface WordMissedEventPayload {
  wordId: string;
  splashDamage: number;
  hp: HpMap;
}

export interface PlayerEliminatedEventPayload {
  userId: string;
  rank: number;
  remainingPlayers: number;
}

export interface MatchEndEventPayload {
  roomId: string;
  winnerId: string | null;
  reason: MatchEndReason;
  finalHp: HpMap;
  ranking: RankedParticipant[];
}

export interface SubmitRejectedEventPayload {
  wordId: string;
  reason: SubmitRejectedReason;
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
  targetUserId: string;
  hp: HpMap;
  /** targetUserId가 이 판정으로 탈락했으면 순위, 아니면 undefined */
  eliminatedRank?: number;
  /** 탈락 처리 이후(또는 탈락이 없었다면 판정 이전과 동일한) 생존자 수 */
  remainingPlayers: number;
  /** 이 판정으로 매치 자체가 끝났는지(생존자 1명 이하로 수렴) */
  gameEnded: boolean;
  winnerId: string | null;
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
  hp?: HpMap;
  gameEnded: false;
  winnerId: null;
  endReason: null;
  submitRejected: SubmitRejectedEventPayload;
}

export type JudgeWordSubmitResult =
  | JudgeWordSubmitAccepted
  | JudgeWordSubmitRejected;
