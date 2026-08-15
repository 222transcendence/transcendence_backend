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
  // userId → 방 이탈 유예 타이머(어느 방에 대한 것인지 roomId도 함께 기록).
  // 로비→대기실 화면 전환처럼 소켓을 새로 맺는 정상적인 재연결에서 방이 조용히
  // 삭제되는 것을 막기 위함(WEBSOCKET_PROTOCOL.md §0: 방 소속은 연결 인스턴스가
  // 아니라 인증된 사용자 기준으로 유지되어야 함). roomId를 반드시 함께 확인해야
  // 하는 이유(#145): 유저가 소켓 재연결 자체는 했지만 실제로는 다른 방으로
  // 이동한 경우까지 "재접속"으로 오인하면, 이전 방의 유예 타이머가 잘못
  // 취소되어 그 방의 참가자 항목이 영영 정리되지 않는다.
  private readonly roomLeaveTimers = new Map<
    string,
    { roomId: string; timer: ReturnType<typeof setTimeout> }
  >();

  private cancelPendingLeave(userId: string, roomId: string): void {
    const pending = this.roomLeaveTimers.get(userId);
    if (pending && pending.roomId === roomId) {
      clearTimeout(pending.timer);
      this.roomLeaveTimers.delete(userId);
    }
  }

  // 호스트가 나가서 다른 플레이어로 자동 승격됐을 때 채팅창에 알림 — 기존
  // 입/퇴장 메시지와 동일한 fire-and-forget 패턴.
  private announceHostChange(roomId: string, room: GameRoom): void {
    const newHost = room.players.find((p) => p.userId === room.hostUserId);
    if (!newHost) return;
    this.chatGateway
      .sendSystemMessage(
        roomId,
        `${newHost.nickname} 님이 호스트가 되었습니다.`,
      )
      .catch((err) =>
        this.logger.error(`System message failed: ${String(err)}`),
      );
  }

  /** 특정 방에서 유저 1명이 빠진 뒤의 알림(시스템 메시지 + 호스트 변경 안내 +
   *  ROOM_UPDATED/ROOM_CLOSED 브로드캐스트)을 보낸다. Redis 상태 변경 자체는
   *  호출자가 이미 끝낸 뒤(LEAVE_ROOM의 명시적 leaveRoom()이든, JOIN_ROOM의
   *  joinRoom() 내부 eviction이든) 그 결과를 조회/통지하는 역할만 한다 —
   *  LEAVE_ROOM 케이스와 JOIN_ROOM으로 인한 강제 퇴장(#183) 양쪽에서 재사용. */
  private notifyRoomLeft(
    roomId: string,
    updatedRoom: GameRoom | null,
    wasHost: boolean,
    leaverUserId: string,
    leaverNickname: string,
  ): void {
    this.chatGateway
      .sendSystemMessage(roomId, `${leaverNickname} 님이 방을 나갔습니다.`)
      .catch((err) =>
        this.logger.error(`System message failed: ${String(err)}`),
      );

    if (updatedRoom) {
      if (wasHost && updatedRoom.hostUserId !== leaverUserId) {
        this.announceHostChange(roomId, updatedRoom);
      }
      this.lobbyService.broadcast('ROOM_UPDATED', {
        room: toLobbyRoom(updatedRoom),
      });
    } else {
      this.lobbyService.broadcast('ROOM_CLOSED', { roomId });
    }
  }

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
      (ws: WebSocket, userId: string, nickname: string, avatar?: string) => {
        this.onConnection(ws, userId, nickname, avatar);
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
          this.wss.emit('connection', ws, userId, user.nickname, user.avatar);
        });
      })
      .catch(() => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
  }

  private onConnection(
    ws: WebSocket,
    userId: string,
    nickname: string,
    avatar?: string,
  ): void {
    const client: LobbyClient = { ws, userId, nickname, avatar };
    this.lobbyService.addClient(client);
    websocketConnections.inc({ namespace: 'lobby' });

    // 이 시점에는 아직 어느 방으로 (재)입장할지 알 수 없으므로 방 이탈 유예
    // 타이머 취소는 여기서 하지 않는다 — GET_ROOM/JOIN_ROOM 등으로 실제 방에
    // 합류하는 시점에 cancelPendingLeave()로 처리한다(#145).

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
        // 같은 방으로 재연결한 경우에만(페이지 전환 시 새 소켓이 구 소켓보다
        // 먼저 도착하는 경쟁 조건) 정리 타이머를 생략한다. userId만 보고
        // "어딘가에 연결돼 있으면 재접속"으로 판단하면, 유저가 실제로는 다른
        // 방으로 이동한 경우까지 재접속으로 오인해 이전 방의 참가자 항목이
        // 영영 정리되지 않는다(#145).
        const reconnected = this.lobbyService.findClientByUserId(userId);
        if (reconnected?.roomId === roomId) {
          return;
        }
        const timer = setTimeout(() => {
          this.roomLeaveTimers.delete(userId);
          this.chatGateway
            .sendSystemMessage(roomId, `${nickname} 님이 방을 나갔습니다.`)
            .catch((err) =>
              this.logger.error(`System message failed: ${String(err)}`),
            );
          this.gameService
            .getRoom(roomId)
            .then((beforeRoom) => {
              const wasHost = beforeRoom?.hostUserId === userId;
              return this.gameService
                .leaveRoom(roomId, userId)
                .then((updatedRoom) => {
                  if (updatedRoom) {
                    if (wasHost && updatedRoom.hostUserId !== userId) {
                      this.announceHostChange(roomId, updatedRoom);
                    }
                    this.lobbyService.broadcast('ROOM_UPDATED', {
                      room: toLobbyRoom(updatedRoom),
                    });
                  } else {
                    this.lobbyService.broadcast('ROOM_CLOSED', { roomId });
                  }
                  return this.broadcastRoomList();
                });
            })
            .catch((err) =>
              this.logger.error(
                `Disconnect room cleanup failed: ${String(err)}`,
              ),
            );
        }, ROOM_LEAVE_GRACE_MS);
        this.roomLeaveTimers.set(userId, { roomId, timer });
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

      case 'LIST_SPECTATABLE_ROOMS': {
        const rooms = await this.gameService.getSpectatableRooms();
        this.lobbyService.sendTo(client, 'SPECTATABLE_ROOM_LIST', {
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
        this.chatGateway
          .sendSystemMessage(room.id, `${client.nickname} 님이 입장하셨습니다.`)
          .catch((err) =>
            this.logger.error(`System message failed: ${String(err)}`),
          );
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
        const alreadyMember = !!beforeRoom?.players.some(
          (p) => p.userId === client.userId,
        );

        // #183: joinRoom()이 내부적으로 다른 WAITING 방에서 퇴장시키므로, 알림에
        // 필요한 "퇴장 전" 정보(특히 host 여부)는 호출 전에 미리 스냅샷해둔다.
        // 이미 대상 방의 멤버라면(idempotent 재확인 호출) 불변조건상 다른 WAITING
        // 방에 남아있을 수 없으므로 스캔을 생략한다.
        const roomsToEvict = alreadyMember
          ? []
          : await this.gameService.findWaitingRoomsForUser(
              client.userId,
              roomId,
            );

        const room = await this.gameService
          .joinRoom(roomId, client.userId, client.nickname)
          .catch((err: Error) => {
            if (err?.constructor?.name === 'NotFoundException') {
              this.lobbyService.sendTo(client, 'ROOM_CLOSED', { roomId });
              return null;
            }
            throw err;
          });
        if (!room) break;
        client.roomId = room.id;
        this.cancelPendingLeave(client.userId, room.id);
        if (!alreadyMember) {
          this.chatGateway
            .sendSystemMessage(
              room.id,
              `${client.nickname} 님이 입장하셨습니다.`,
            )
            .catch((err) =>
              this.logger.error(`System message failed: ${String(err)}`),
            );
        }

        // #183: 강제 퇴장된 이전 방들에도 LEAVE_ROOM과 동일한 알림을 보낸다 —
        // 그렇지 않으면 그 방의 남은 참가자들은 유저가 조용히 사라진 것만 본다.
        for (const evictedRoom of roomsToEvict) {
          const wasHost = evictedRoom.hostUserId === client.userId;
          const updatedRoom = await this.gameService.getRoom(evictedRoom.id);
          // 새로 들어간 방(room.id)뿐 아니라 강제 퇴장시키는 이 방에 대해서도
          // 취소해야 한다 — 안 그러면 여기 남아있던 유예 타이머가 그대로 살아
          // 있다가 나중에 같은 나가기 메시지를 또 보낸다(#201).
          this.cancelPendingLeave(client.userId, evictedRoom.id);
          this.notifyRoomLeft(
            evictedRoom.id,
            updatedRoom,
            wasHost,
            client.userId,
            client.nickname,
          );
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
          this.cancelPendingLeave(client.userId, room.id);
          this.lobbyService.sendTo(client, 'ROOM_UPDATED', {
            room: toLobbyRoom(room),
          });
        }
        break;
      }

      case 'LEAVE_ROOM': {
        const { roomId } = payload as { roomId: string };
        const beforeRoom = await this.gameService.getRoom(roomId);
        const wasHost = beforeRoom?.hostUserId === client.userId;
        const updatedRoom = await this.gameService.leaveRoom(
          roomId,
          client.userId,
        );
        client.roomId = undefined;
        // close 이벤트가 이 비동기 처리보다 먼저 실행돼 유예 타이머를 걸어둔
        // 경우, 여기서 취소하지 않으면 ROOM_LEAVE_GRACE_MS 뒤 같은 나가기
        // 메시지가 또 발송된다(#201).
        this.cancelPendingLeave(client.userId, roomId);
        this.notifyRoomLeft(
          roomId,
          updatedRoom,
          wasHost,
          client.userId,
          client.nickname,
        );
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

        // 전원 ready + 최소 2명 → GAME_START. 방 상태를 IN_GAME으로 전이하는 시점은
        // 여기가 아니라 AcidRainGateway.handleJoinRoom이 실제로 매치를 시작하는 순간이다
        // (#153) — 여기서 미리 IN_GAME으로 바꾸면 참가자 본인의 join_room이 "Room is not
        // waiting"으로 거부되어 게임 자체가 시작되지 않는 회귀가 생긴다.
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
            ownerAvatar: client.avatar,
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
