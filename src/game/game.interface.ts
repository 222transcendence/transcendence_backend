export enum RoomStatus {
  WAITING = 'WAITING',
  IN_GAME = 'IN_GAME',
  FINISHED = 'FINISHED',
}

export interface PlayerSession {
  userId: string;
  nickname: string;
  avatar?: string;
  ready: boolean;
}

export interface GameRoom {
  id: string;
  hostUserId: string;
  maxPlayers: number;
  status: RoomStatus;
  players: PlayerSession[];
  createdAt: string;
  winnerId?: string;
}
