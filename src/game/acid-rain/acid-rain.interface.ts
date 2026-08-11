export type MatchEndReason = 'KO' | 'TIME_LIMIT' | 'FORFEIT';

export interface PlayerPublic {
  userId: string;
  nickname: string;
}

export interface HpPair {
  host: number;
  guest: number;
}

export interface WordSpawnPayload {
  wordId: string;
  text: string;
  /** 2벌식 키보드 기준 실제 타건 횟수 — 낙하 시간·데미지 계산에 쓰이므로 클라이언트도 함께 받는다. */
  keystrokes: number;
  lane: number;
  fallDurationMs: number;
  spawnedAt: string; // ISO8601
}

export interface AcidRainSession {
  roomId: string;
  host: PlayerPublic;
  guest: PlayerPublic;
  hp: HpPair;
  wordsTyped: { host: number; guest: number };
  activeWords: Map<string, ActiveWord>;
  startedAt: number; // Date.now()
  spawnLoopTimer: ReturnType<typeof setInterval> | null;
  missLoopTimer: ReturnType<typeof setInterval> | null;
  /** 현재 낙하 중인 단어별 레인 점유 현황 */
  occupiedLanes: Set<number>;
  /** wordId → cleared userId, 멱등 처리용 */
  clearedWords: Map<string, string>;
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
}
