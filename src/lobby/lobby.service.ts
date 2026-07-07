import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';

export interface LobbyClient {
  ws: WebSocket;
  userId: string;
  nickname: string;
}

@Injectable()
export class LobbyService {
  private readonly logger = new Logger(LobbyService.name);
  private readonly clients = new Set<LobbyClient>();

  addClient(client: LobbyClient): void {
    this.clients.add(client);
    this.logger.log(`Lobby client connected: ${client.nickname} (${client.userId})`);
  }

  removeClient(client: LobbyClient): void {
    this.clients.delete(client);
    this.logger.log(`Lobby client disconnected: ${client.nickname}`);
  }

  findClientByUserId(userId: string): LobbyClient | undefined {
    for (const c of this.clients) {
      if (c.userId === userId) return c;
    }
    return undefined;
  }

  broadcast(type: string, payload: unknown): void {
    const msg = JSON.stringify({ type, payload });
    for (const c of this.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
      }
    }
  }

  sendTo(client: LobbyClient, type: string, payload: unknown): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify({ type, payload }));
    }
  }
}
