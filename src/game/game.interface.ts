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

export interface GameRoom {
  id: string;
  status: RoomStatus;
  host: PlayerSession;
  guest?: PlayerSession;
  phase?: GamePhase;
  distance: number;
  currentTurn: number;
  statusEffects: {
    host: string[];
    guest: string[];
  };
  winnerId?: string;
}
