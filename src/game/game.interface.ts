export enum RoomStatus {
  WAITING = 'WAITING',
  READY = 'READY',
  IN_GAME = 'IN_GAME',
  FINISHED = 'FINISHED',
}

export enum GamePhase {
  DRAW = 'DRAW',
  MOVE = 'MOVE',
  ATTACK = 'ATTACK',
  DEFENSE = 'DEFENSE',
  RESULT = 'RESULT',
}

export interface PlayerSession {
  userId: string;
  nickname: string;
  characterId: number;
  hp: number;
  cardsInHand: number[]; // 카드 ID 목록
  cardsSubmitted: number[]; // 현재 페이즈에 제출한 카드 ID 목록
}

export interface StatusEffect {
  type: 'POISON' | 'REGEN' | 'CONFUSE' | 'STUN';
  duration: number; // 남은 턴 수
}

export interface DiceDetail {
  count: number;
  successes: number;
  details: boolean[];
}

export interface GameRoom {
  id: string;
  status: RoomStatus;
  host: PlayerSession;
  guest?: PlayerSession;
  phase?: GamePhase;
  distance: number;
  currentTurn: number;
  statusEffects: {
    host: StatusEffect[];
    guest: StatusEffect[];
  };
  initiative?: 'host' | 'guest' | null; // 선공권 필드 추가
  lastDiceRoll?: {
    hostAtk?: DiceDetail;
    guestAtk?: DiceDetail;
    hostDef?: DiceDetail;
    guestDef?: DiceDetail;
  } | null;
  lastActionLog?: string[]; // 전투 중 발생한 스킬/상태이상 알림 로그
  winnerId?: string;
}

