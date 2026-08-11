import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as http from 'http';
import * as net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { LobbyService, LobbyClient } from './lobby.service';
import { GameService } from '../game/game.service';
import { GameRoom, RoomStatus } from '../game/game.interface';
import { UserService } from '../user/user.service';
import { websocketConnections } from '../metrics/metrics.registry';

interface LobbyRoom {
  id: string;
  host: { userId: string; nickname: string; ready: boolean };
  guest: { userId: string; nickname: string; ready: boolean } | null;
  status: 'WAITING' | 'IN_GAME';
  createdAt: string;
}

function toRoomStatus(s: RoomStatus): 'WAITING' | 'IN_GAME' {
  return s === RoomStatus.IN_GAME || s === RoomStatus.FINISHED
    ? 'IN_GAME'
    : 'WAITING';
}

function toLobbyRoom(room: GameRoom): LobbyRoom {
  return {
    id: room.id,
    host: {
      userId: room.host.userId,
      nickname: room.host.nickname,
      ready: room.host.ready,
    },
    guest: room.guest
      ? {
          userId: room.guest.userId,
          nickname: room.guest.nickname,
          ready: room.guest.ready,
        }
      : null,
    status: toRoomStatus(room.status),
    createdAt: room.createdAt,
  };
}

@Injectable()
export class LobbyGateway implements OnModuleInit {
  private readonly logger = new Logger(LobbyGateway.name);
  private wss!: WebSocketServer;

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly gameService: GameService,
    private readonly lobbyService: LobbyService,
  ) {}

  onModuleInit() {
    // wss is created without its own server; we attach to HTTP server in main.ts
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on(
      'connection',
      (ws: WebSocket, userId: string, nickname: string) => {
        this.onConnection(ws, userId, nickname);
      },
    );
  }

  /** Called from main.ts on HTTP upgrade events for /ws/lobby */
  handleUpgrade(
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    const rawUrl = request.url ?? '/';
    const url = new URL(
      rawUrl,
      `http://${request.headers.host ?? 'localhost'}`,
    );

    if (url.pathname !== '/ws/lobby') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    let userId: string;
    try {
      const payload = this.jwtService.verify<{ sub: string }>(token, {
        secret: process.env.JWT_SECRET || 'secret_jwt_key',
      });
      userId = payload.sub;
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    this.userService
      .findOne(userId)
      .then((user) => {
        this.wss.handleUpgrade(request, socket, head, (ws) => {
          this.wss.emit('connection', ws, userId, user.nickname);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  }

  private onConnection(ws: WebSocket, userId: string, nickname: string): void {
    const client: LobbyClient = { ws, userId, nickname };
    this.lobbyService.addClient(client);
    websocketConnections.inc({ namespace: 'lobby' });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          type: string;
          payload?: unknown;
          seq?: number;
        };
        this.handleMessage(client, msg).catch((err) => {
          this.logger.error(`Handler error: ${String(err)}`);
          this.lobbyService.sendTo(client, 'ACTION_REJECTED', {
            message: String(err?.message ?? err),
          });
        });
      } catch {
        this.lobbyService.sendTo(client, 'ACTION_REJECTED', {
          message: 'Invalid JSON',
        });
      }
    });

    ws.on('close', () => {
      this.lobbyService.removeClient(client);
      websocketConnections.dec({ namespace: 'lobby' });
      if (client.roomId) {
        const roomId = client.roomId;
        this.gameService.leaveRoom(roomId, client.userId)
          .then((updatedRoom) => {
            if (updatedRoom) {
              this.lobbyService.broadcast('ROOM_UPDATED', { room: toLobbyRoom(updatedRoom) });
            } else {
              this.lobbyService.broadcast('ROOM_CLOSED', { roomId });
            }
            return this.broadcastRoomList();
          })
          .catch((err) => this.logger.error(`Disconnect room cleanup failed: ${String(err)}`));
      }
    });

    ws.on('error', (err) => {
      this.logger.error(`WS error for ${nickname}: ${String(err)}`);
    });
  }

  private async handleMessage(
    client: LobbyClient,
    msg: { type: string; payload?: unknown; seq?: number },
  ): Promise<void> {
    const { type, payload } = msg;

    switch (type) {
      case 'LIST_ROOMS': {
        const rooms = await this.gameService.getWaitingRooms();
        this.lobbyService.sendTo(client, 'ROOM_LIST', {
          rooms: rooms.map(toLobbyRoom),
        });
        break;
      }

      case 'CREATE_ROOM': {
        const room = await this.gameService.createRoom(
          client.userId,
          client.nickname,
        );
        const lobbyRoom = toLobbyRoom(room);
        await this.broadcastRoomList();
        this.lobbyService.sendTo(client, 'ROOM_UPDATED', { room: lobbyRoom });
        break;
      }

      case 'JOIN_ROOM': {
        const { roomId } = payload as { roomId: string };
        const room = await this.gameService.joinRoom(
          roomId,
          client.userId,
          client.nickname,
        );
        const lobbyRoom = toLobbyRoom(room);
        await this.broadcastRoomList();
        this.lobbyService.broadcast('ROOM_UPDATED', { room: lobbyRoom });
        break;
      }

      case 'GET_ROOM': {
        const { roomId } = payload as { roomId: string };
        const room = await this.gameService.getRoom(roomId);
        if (!room) {
          this.lobbyService.sendTo(client, 'ACTION_REJECTED', {
            message: 'Room not found',
          });
        } else {
          client.roomId = room.id;
          this.lobbyService.sendTo(client, 'ROOM_UPDATED', {
            room: toLobbyRoom(room),
          });
        }
        break;
      }

      case 'LEAVE_ROOM': {
        const { roomId } = payload as { roomId: string };
        const updatedRoom = await this.gameService.leaveRoom(roomId, client.userId);
        client.roomId = undefined;
        if (updatedRoom) {
          this.lobbyService.broadcast('ROOM_UPDATED', { room: toLobbyRoom(updatedRoom) });
        } else {
          this.lobbyService.broadcast('ROOM_CLOSED', { roomId });
        }
        await this.broadcastRoomList();
        break;
      }

      case 'SET_READY': {
        const { roomId, ready } = payload as { roomId: string; ready: boolean };
        const room = await this.gameService.setReady(
          roomId,
          client.userId,
          ready,
        );
        const lobbyRoom = toLobbyRoom(room);
        this.lobbyService.broadcast('ROOM_UPDATED', { room: lobbyRoom });

        // Both players ready → GAME_START
        if (lobbyRoom.host.ready && lobbyRoom.guest && lobbyRoom.guest.ready) {
          this.lobbyService.clearRoomForAllClients(roomId);
          this.lobbyService.broadcast('GAME_START', { roomId });
        }
        break;
      }

      default:
        this.lobbyService.sendTo(client, 'ACTION_REJECTED', {
          message: `Unknown message type: ${type}`,
        });
    }
  }

  private async broadcastRoomList(): Promise<void> {
    const rooms = await this.gameService.getWaitingRooms();
    this.lobbyService.broadcast('ROOM_LIST', { rooms: rooms.map(toLobbyRoom) });
  }
}
