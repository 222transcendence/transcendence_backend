import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as http from 'http';
import * as net from 'net';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { URL } from 'url';
import { LobbyService, LobbyClient } from './lobby.service';
import { GameService } from '../game/game.service';
import { AiPracticeService } from '../game/ai-practice.service';
import { GameRoom, RoomStatus } from '../game/game.interface';
import { UserService } from '../user/user.service';
import { ChatGateway } from '../chat/chat.gateway';
import { websocketConnections } from '../metrics/metrics.registry';
import type { AiDifficulty } from '../game/acid-rain/acid-rain.interface';
import type {
  AiPracticeCancelledPayload,
  AiPracticeCreatedPayload,
  AiPracticeRejectedPayload,
} from '../game/ai-practice.interface';

interface LobbyRoom {
  id: string;
  hostUserId: string;
  maxPlayers: number;
  players: {
    userId: string;
    nickname: string;
    avatar?: string;
    ready: boolean;
  }[];
  status: 'WAITING' | 'IN_GAME';
  createdAt: string;
}

function toRoomStatus(s: RoomStatus): 'WAITING' | 'IN_GAME' {
  return s === RoomStatus.IN_GAME || s === RoomStatus.FINISHED
    ? 'IN_GAME'
    : 'WAITING';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface ExceptionWithResponse {
  getResponse(): unknown;
}

function hasExceptionResponse(value: unknown): value is ExceptionWithResponse {
  if (!isRecord(value)) return false;
  return typeof value.getResponse === 'function';
}

function rawWsDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function toLobbyRoom(room: GameRoom): LobbyRoom {
  return {
    id: room.id,
    hostUserId: room.hostUserId,
    maxPlayers: room.maxPlayers ?? 4,
    players: (room.players ?? []).map((p) => ({
      userId: p.userId,
      nickname: p.nickname,
      avatar: p.avatar,
      ready: p.ready,
    })),
    status: toRoomStatus(room.status),
    createdAt: room.createdAt,
  };
}

const ROOM_LEAVE_GRACE_MS = 10000;
const AI_PRACTICE_DIFFICULTIES = new Set<AiDifficulty>([
  'BEGINNER',
  'NORMAL',
  'HARD',
]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

@Injectable()
export class LobbyGateway implements OnModuleInit {
  private readonly logger = new Logger(LobbyGateway.name);
  private wss!: WebSocketServer;
  // userId → 방 이탈 유예 타이머. 로비→대기실 화면 전환처럼 소켓을 새로
  // 맺는 정상적인 재연결에서 방이 조용히 삭제되는 것을 막기 위함
  // (WEBSOCKET_PROTOCOL.md §0: 방 소속은 연결 인스턴스가 아니라 인증된
  // 사용자 기준으로 유지되어야 함).
  private readonly roomLeaveTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly gameService: GameService,
    private readonly aiPracticeService: AiPracticeService,
    private readonly lobbyService: LobbyService,
    private readonly chatGateway: ChatGateway,
  ) {}

  onModuleInit() {
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on(
      'connection',
      (ws: WebSocket, userId: string, nickname: string) => {
        this.onConnection(ws, userId, nickname);
      },
    );
  }

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

    // 유예 시간 내 재연결 — 예정된 방 이탈 취소 (페이지 전환 등 정상적인 재연결)
    const pendingLeave = this.roomLeaveTimers.get(userId);
    if (pendingLeave) {
      clearTimeout(pendingLeave);
      this.roomLeaveTimers.delete(userId);
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(rawWsDataToString(data)) as {
          type: string;
          payload?: unknown;
          seq?: number;
        };
        this.handleMessage(client, msg).catch((err) => {
          this.logger.error(`Handler error: ${String(err)}`);
          this.lobbyService.sendTo(client, 'ACTION_REJECTED', {
            message: err instanceof Error ? err.message : String(err),
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
        const userId = client.userId;
        // 새 소켓이 이미 연결돼 있으면(페이지 전환 시 새 소켓이 구 소켓보다
        // 먼저 도착하는 경쟁 조건) 타이머 없이 즉시 종료
        if (this.lobbyService.findClientByUserId(userId)) {
          return;
        }
        const timer = setTimeout(() => {
          this.roomLeaveTimers.delete(userId);
          this.chatGateway.sendSystemMessage(roomId, `${nickname} 님이 방을 나갔습니다.`).catch((err) => this.logger.error(`System message failed: ${String(err)}`));
          this.gameService
            .leaveRoom(roomId, userId)
            .then((updatedRoom) => {
              if (updatedRoom) {
                this.lobbyService.broadcast('ROOM_UPDATED', {
                  room: toLobbyRoom(updatedRoom),
                });
              } else {
                this.lobbyService.broadcast('ROOM_CLOSED', { roomId });
              }
              return this.broadcastRoomList();
            })
            .catch((err) =>
              this.logger.error(
                `Disconnect room cleanup failed: ${String(err)}`,
              ),
            );
        }, ROOM_LEAVE_GRACE_MS);
        this.roomLeaveTimers.set(userId, timer);
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
        await this.aiPracticeService.assertNoActivePractice(client.userId);
        const { maxPlayers } = (payload ?? {}) as { maxPlayers?: number };
        const room = await this.gameService.createRoom(
          client.userId,
          client.nickname,
          maxPlayers,
        );
        client.roomId = room.id;
        this.chatGateway.sendSystemMessage(room.id, `${client.nickname} 님이 입장하셨습니다.`).catch((err) => this.logger.error(`System message failed: ${String(err)}`));
        await this.broadcastRoomList();
        this.lobbyService.sendTo(client, 'ROOM_UPDATED', {
          room: toLobbyRoom(room),
        });
        break;
      }

      case 'JOIN_ROOM': {
        await this.aiPracticeService.assertNoActivePractice(client.userId);
        const { roomId } = payload as { roomId: string };
        // joinRoom()은 이미 참가한 유저를 idempotent하게 처리(재입장 시도를 성공으로
        // 취급)하므로, 새로 합류한 게 맞는지는 호출 전 스냅샷으로 미리 판단해야 한다 —
        // 그렇지 않으면 CREATE_ROOM 직후 프론트가 자동으로 보내는 JOIN_ROOM(호스트
        // 본인 재확인용)에도 "입장했습니다" 메시지가 중복으로 발송된다.
        const beforeRoom = await this.gameService.getRoom(roomId);
        const alreadyMember = !!beforeRoom?.players.some((p) => p.userId === client.userId);

        const room = await this.gameService.joinRoom(roomId, client.userId, client.nickname)
          .catch((err: Error) => {
            if (err?.constructor?.name === 'NotFoundException') {
              this.lobbyService.sendTo(client, 'ROOM_CLOSED', { roomId });
              return null;
            }
            throw err;
          });
        if (!room) break;
        client.roomId = room.id;
        if (!alreadyMember) {
          this.chatGateway.sendSystemMessage(room.id, `${client.nickname} 님이 입장하셨습니다.`).catch((err) => this.logger.error(`System message failed: ${String(err)}`));
        }
        await this.broadcastRoomList();
        this.lobbyService.broadcast('ROOM_UPDATED', {
          room: toLobbyRoom(room),
        });
        break;
      }

      case 'GET_ROOM': {
        const { roomId } = payload as { roomId: string };
        const room = await this.gameService.getRoom(roomId);
        if (!room) {
          // ACTION_REJECTED 대신 ROOM_CLOSED 전송: 프론트엔드가 재연결 루프 없이 로비로 이동
          this.lobbyService.sendTo(client, 'ROOM_CLOSED', { roomId });
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
        this.chatGateway.sendSystemMessage(roomId, `${client.nickname} 님이 방을 나갔습니다.`).catch((err) => this.logger.error(`System message failed: ${String(err)}`));
        const updatedRoom = await this.gameService.leaveRoom(roomId, client.userId);
        client.roomId = undefined;
        if (updatedRoom) {
          this.lobbyService.broadcast('ROOM_UPDATED', {
            room: toLobbyRoom(updatedRoom),
          });
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

        // 전원 ready + 최소 2명 → GAME_START
        const allReady =
          lobbyRoom.players.length >= 2 &&
          lobbyRoom.players.every((p) => p.ready);
        if (allReady) {
          this.lobbyService.clearRoomForAllClients(roomId);
          this.lobbyService.broadcast('GAME_START', { roomId });
        }
        break;
      }

      case 'CREATE_AI_PRACTICE': {
        try {
          this.assertAuthenticatedLobbyClient(client);
          const { requestId, difficulty } =
            this.parseCreateAiPracticePayload(payload);
          const result = await this.aiPracticeService.createAiPractice({
            ownerUserId: client.userId,
            ownerNickname: client.nickname,
            requestId,
            difficulty,
          });
          this.sendAiPracticeCreated(client, result);
        } catch (err) {
          this.sendAiPracticeRejected(client, err);
        }
        break;
      }

      case 'GET_ACTIVE_AI_PRACTICE': {
        try {
          this.assertAuthenticatedLobbyClient(client);
          if (payload !== undefined && !isRecord(payload)) {
            throw new Error('INVALID_PAYLOAD');
          }
          const session =
            await this.aiPracticeService.getActiveAiPracticeForUser(
              client.userId,
            );
          if (!session) {
            throw new Error('AI_PRACTICE_NOT_FOUND');
          }
          this.sendAiPracticeCreated(client, {
            roomId: session.roomId,
            mode: session.mode,
            difficulty: session.difficulty,
            participants: session.participants,
            expiresAt: session.expiresAt,
          });
        } catch (err) {
          this.sendAiPracticeRejected(client, err);
        }
        break;
      }

      case 'CANCEL_AI_PRACTICE': {
        try {
          this.assertAuthenticatedLobbyClient(client);
          const roomId = this.parseOptionalRoomIdPayload(payload);
          const active =
            await this.aiPracticeService.getActiveAiPracticeForUser(
              client.userId,
            );
          if (!active) throw new Error('AI_PRACTICE_NOT_FOUND');
          await this.aiPracticeService.cancelAiPractice(client.userId, roomId);
          this.lobbyService.sendTo(client, 'AI_PRACTICE_CANCELLED', {
            roomId: active.roomId,
          } satisfies AiPracticeCancelledPayload);
        } catch (err) {
          this.sendAiPracticeRejected(client, err);
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

  private parseCreateAiPracticePayload(payload: unknown): {
    requestId: string;
    difficulty: AiDifficulty;
  } {
    if (
      !isRecord(payload) ||
      typeof payload.requestId !== 'string' ||
      !REQUEST_ID_PATTERN.test(payload.requestId)
    ) {
      throw new Error('INVALID_PAYLOAD');
    }
    if (
      typeof payload.difficulty !== 'string' ||
      !AI_PRACTICE_DIFFICULTIES.has(payload.difficulty as AiDifficulty)
    ) {
      throw new Error('INVALID_DIFFICULTY');
    }
    return {
      requestId: payload.requestId,
      difficulty: payload.difficulty as AiDifficulty,
    };
  }

  private assertAuthenticatedLobbyClient(client: LobbyClient): void {
    if (!client.userId || !client.nickname) {
      throw new Error('UNAUTHORIZED');
    }
  }

  private parseOptionalRoomIdPayload(payload: unknown): string | undefined {
    if (payload === undefined) return undefined;
    if (!isRecord(payload)) throw new Error('INVALID_PAYLOAD');
    if (payload.roomId === undefined) return undefined;
    if (typeof payload.roomId !== 'string' || payload.roomId.length === 0) {
      throw new Error('INVALID_PAYLOAD');
    }
    return payload.roomId;
  }

  private sendAiPracticeCreated(
    client: LobbyClient,
    payload: AiPracticeCreatedPayload,
  ): void {
    this.lobbyService.sendTo(client, 'AI_PRACTICE_CREATED', payload);
  }

  private sendAiPracticeRejected(client: LobbyClient, err: unknown): void {
    const payload = this.toAiPracticeRejectedPayload(err);
    this.lobbyService.sendTo(client, 'AI_PRACTICE_REJECTED', payload);
  }

  private toAiPracticeRejectedPayload(err: unknown): AiPracticeRejectedPayload {
    if (err instanceof Error) {
      if (err.message === 'INVALID_DIFFICULTY') {
        return {
          code: 'INVALID_DIFFICULTY',
          message: 'difficulty must be BEGINNER, NORMAL, or HARD',
        };
      }
      if (err.message === 'UNAUTHORIZED') {
        return { code: 'UNAUTHORIZED', message: 'Unauthorized' };
      }
      if (err.message === 'AI_PRACTICE_NOT_FOUND') {
        return {
          code: 'AI_PRACTICE_NOT_FOUND',
          message: 'AI practice session not found',
        };
      }
      if (err.message === 'INVALID_PAYLOAD') {
        return {
          code: 'INVALID_PAYLOAD',
          message: 'Invalid AI practice payload',
        };
      }
    }
    const response = hasExceptionResponse(err) ? err.getResponse() : null;
    if (isRecord(response)) {
      const code =
        typeof response.code === 'string' ? response.code : 'CREATE_FAILED';
      const message =
        typeof response.message === 'string'
          ? response.message
          : 'Failed to create AI practice session';
      return {
        code: code as AiPracticeRejectedPayload['code'],
        message,
      };
    }
    return {
      code: 'CREATE_FAILED',
      message: 'Failed to create AI practice session',
    };
  }
}
