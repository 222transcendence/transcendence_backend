export enum RoomStatus {
  WAITING = 'WAITING',
  IN_GAME = 'IN_GAME',
  FINISHED = 'FINISHED',
}

export interface PlayerSession {
  userId: string;
  nickname: string;
  ready: boolean;
}

export interface GameRoom {
  id: string;
  status: RoomStatus;
  host: PlayerSession;
  guest?: PlayerSession;
  createdAt: string;
  winnerId?: string;
}
