import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
  WsException,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { UserService } from '../../user/user.service';
import { RedisService } from '../../redis/redis.service';
import { extractWsToken } from '../../common/websocket/ws-jwt.util';
import { websocketConnections } from '../../metrics/metrics.registry';
import { AcidRainService } from './acid-rain.service';
import { AiPracticeService } from '../ai-practice.service';
import { ChatGateway } from '../../chat/chat.gateway';
import { GameService } from '../game.service';
import { LobbyService } from '../../lobby/lobby.service';
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  LeaveSpectatePayload,
  MatchReadyEventPayload,
  ParticipantState,
  SpectateRoomPayload,
  TypingProgressPayload,
  WordSubmitPayload,
} from './acid-rain.interface';
import { RoomStatus, type GameRoom } from '../game.interface';

interface GameSocketData {
  userId?: string;
  nickname?: string;
  /** 현재 참여 중인 roomId (참가자 전용 — 재접속/FORFEIT 판정에 쓰임) */
  roomId?: string;
  /** 현재 관전 중인 roomId — room.players/세션에는 등록되지 않으므로 roomId와 분리해서
   *  관리한다. 참가자 전용 로직(handleDisconnect의 FORFEIT 판정 등)이 관전자를 상대방으로
   *  오인하지 않도록 절대 roomId와 섞지 않는다. */
  spectatingRoomId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

@WebSocketGateway({
  namespace: '/game',
  path: '/socketio',
  cors: { origin: '*' },
})
export class AcidRainGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(AcidRainGateway.name);

  // roomId → 현재 진행 중인 join 임계구역의 Promise. join_room이 room당 한 번에
  // 하나씩만 "join 소켓 + 인원수 체크 + match_ready 판단"을 수행하도록 직렬화한다
  // (양쪽이 거의 동시에 join_room을 보내면 서로의 client.join()이 아직 반영되기
  // 전에 fetchSockets()를 체크해 둘 다 "상대 대기"로 빠지는 레이스를 방지 — #144).
  private readonly roomJoinQueues = new Map<string, Promise<unknown>>();

  private runExclusive<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.roomJoinQueues.get(roomId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.roomJoinQueues.set(roomId, settled);
    void settled.finally(() => {
      if (this.roomJoinQueues.get(roomId) === settled) {
        this.roomJoinQueues.delete(roomId);
      }
    });
    return run;
  }

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
    private readonly acidRainService: AcidRainService,
    private readonly aiPracticeService: AiPracticeService,
    private readonly chatGateway: ChatGateway,
    private readonly gameService: GameService,
    private readonly lobbyService: LobbyService,
  ) {}

  // ─── 연결 ─────────────────────────────────────────────────────────────────

  async handleConnection(client: Socket) {
    try {
      const token = extractWsToken(client);
      const payload = this.jwtService.verify<{ sub: string }>(token, {
        secret: process.env.JWT_SECRET || 'secret_jwt_key',
      });
      const user = await this.userService.findOne(payload.sub);
      (client.data as GameSocketData).userId = user.id;
      (client.data as GameSocketData).nickname = user.nickname;
      websocketConnections.inc({ namespace: 'game' });
      this.logger.log(`Connected: ${client.id} (${user.nickname})`);
    } catch {
      this.logger.warn(`Unauthorized: ${client.id} — disconnecting`);
      client.disconnect();
    }
  }

  // ─── 연결 해제 ────────────────────────────────────────────────────────────

  handleDisconnect(client: Socket) {
    const { userId, nickname, roomId, spectatingRoomId } =
      client.data as GameSocketData;
    this.logger.log(
      `Disconnected: ${client.id} (${nickname ?? 'unknown'}) room=${roomId ?? 'none'}`,
    );

    if (userId) websocketConnections.dec({ namespace: 'game' });

    if (userId && roomId) {
      this.acidRainService.handleDisconnect(roomId, userId, this.server);
    }

    if (spectatingRoomId) {
      this.chatGateway
        .sendSystemMessage(
          spectatingRoomId,
          `${nickname ?? '관전자'} 님이 관전을 종료했습니다.`,
        )
        .catch((err) =>
          this.logger.error(
            `Failed to send spectator-leave system message: ${String(err)}`,
          ),
        );
    }
  }

  // ─── join_room ────────────────────────────────────────────────────────────

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: JoinRoomPayload,
  ) {
    const { userId, nickname } = client.data as GameSocketData;
    if (!userId || !nickname) throw new WsException('Unauthorized');

    const { roomId } = this.parseJoinRoomPayload(payload);
    this.logger.log(
      `join_room received: room=${roomId} user=${userId} socket=${client.id}`,
    );

    // 로비 Redis에서 방 정보 조회 (lobby.service가 저장하는 키 형식 사용)
    const rawRoom = await this.redisService.get(`game:room:${roomId}`);
    if (!rawRoom) {
      const aiPractice =
        await this.aiPracticeService.getAiPracticeSession(roomId);
      if (aiPractice) {
        const isOwner = aiPractice.ownerUserId === userId;
        if (!isOwner) {
          throw new WsException({
            code: 'NOT_A_PARTICIPANT',
            message: 'Not a participant of this room',
          });
        }
        await client.join(`game:${roomId}`);
        (client.data as GameSocketData).roomId = roomId;
        const existingSession = this.acidRainService.getSession(roomId);
        if (existingSession && existingSession.status !== 'FINISHED') {
          this.acidRainService.handleReconnect(
            roomId,
            userId,
            this.server,
            client,
          );
          return;
        }
        if (
          !aiPractice.participants.some(
            (participant) => participant.type === 'HUMAN' && participant.userId,
          ) ||
          !aiPractice.participants.some(
            (participant) => participant.type === 'AI',
          )
        ) {
          throw new WsException('AI practice session participants missing');
        }
        this.server.to(`game:${roomId}`).emit('match_ready', {
          roomId,
          protocolVersion: '1.0',
          participants: aiPractice.participants.map((participant) => ({
            ...participant,
            hp: 100,
          })),
        } satisfies MatchReadyEventPayload);
        await this.acidRainService.startMatch(
          roomId,
          this.server,
          aiPractice.participants,
          'AI_PRACTICE',
        );
        return;
      }
      throw new WsException('Room not found');
    }

    const room = JSON.parse(rawRoom) as GameRoom;

    const isParticipant = room.players.some(
      (player) => player.userId === userId,
    );
    if (!isParticipant) throw new WsException('Not a participant of this room');

    // join(소켓 입장) + 인원수 체크 + match_ready 판단을 방별로 직렬화한다 — 두
    // 플레이어가 거의 동시에 join_room을 보내도 서로의 join()이 반영되기 전에
    // fetchSockets()를 체크해 둘 다 "상대 대기"로 빠지는 레이스를 방지한다(#144).
    await this.runExclusive(roomId, async () => {
      await client.join(`game:${roomId}`);
      (client.data as GameSocketData).roomId = roomId;
      this.logger.log(
        `join_room joined socket room: room=${roomId} user=${userId} socket=${client.id}`,
      );

      const existingSession = this.acidRainService.getSession(roomId);

      if (existingSession && existingSession.status !== 'FINISHED') {
        // 재접속 — state_sync 전송
        this.logger.log(
          `join_room → reconnect branch: room=${roomId} user=${userId} sessionStatus=${existingSession.status}`,
        );
        this.acidRainService.handleReconnect(
          roomId,
          userId,
          this.server,
          client,
        );
        return;
      }

      if (room.status !== RoomStatus.WAITING) {
        this.logger.warn(
          `join_room rejected — room not waiting: room=${roomId} status=${room.status}`,
        );
        throw new WsException('Room is not waiting');
      }

      if (room.players.length < 2 || room.players.length > 4) {
        this.logger.warn(
          `join_room rejected — unsupported player count: room=${roomId} count=${room.players.length}`,
        );
        throw new WsException('Acid Rain supports 2 to 4 participants');
      }

      // 전원이 소켓 룸에 모두 입장했는지 확인
      const socketsInRoom = await this.server
        .in(`game:${roomId}`)
        .fetchSockets();
      this.logger.log(
        `join_room socket count check: room=${roomId} sockets=${socketsInRoom.length} ids=${socketsInRoom.map((s) => s.id).join(',')}`,
      );
      if (socketsInRoom.length < room.players.length) {
        // 아직 전원이 입장하지 않음 — 나머지 대기
        this.logger.log(
          `join_room waiting for opponent: room=${roomId} user=${userId}`,
        );
        return;
      }

      // match_ready 브로드캐스트
      const participants: ParticipantState[] = room.players.map((player) => ({
        participantId: player.userId,
        userId: player.userId,
        nickname: player.nickname,
        type: 'HUMAN',
        hp: 100,
      }));
      const readyPayload: MatchReadyEventPayload = {
        roomId,
        protocolVersion: '1.0',
        participants,
      };
      this.server.to(`game:${roomId}`).emit('match_ready', readyPayload);
      this.logger.log(
        `join_room match_ready broadcast: room=${roomId} hostUserId=${room.hostUserId} players=${room.players.length}`,
      );

      // 방 상태를 IN_GAME으로 전이하고 로비 전체에 알린다 — 매치가 실제로 시작되는
      // 이 시점에서 해야 한다(#153). SET_READY 시점에 미리 바꾸면 참가자 본인의
      // join_room이 "Room is not waiting"으로 거부되어 게임이 시작조차 안 되는 회귀가
      // 생긴다(실제로 재현해서 발견). 이 전이 덕분에 로비의 다른 유저 화면에서 "참가하기"가
      // "관전하기"로 바뀌고, getSpectatableRooms()도 이 방을 반환하기 시작한다.
      const startedRoom = await this.gameService.startGame(roomId);
      this.lobbyService.broadcast('ROOM_UPDATED', {
        room: {
          id: startedRoom.id,
          hostUserId: startedRoom.hostUserId,
          maxPlayers: startedRoom.maxPlayers,
          players: startedRoom.players.map((player) => ({
            userId: player.userId,
            nickname: player.nickname,
            avatar: player.avatar,
            ready: player.ready,
          })),
          status: 'IN_GAME' as const,
          createdAt: startedRoom.createdAt,
        },
      });

      // 매치 시작 (3초 카운트다운 포함)
      await this.acidRainService.startMatch(roomId, this.server, participants);
    });
  }

  // ─── leave_room ───────────────────────────────────────────────────────────

  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LeaveRoomPayload,
  ) {
    const { userId } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');

    const { roomId } = this.parseLeaveRoomPayload(payload);
    // 진행 중 퇴장 → 해당 참가자만 기권 탈락 처리. N인 매치에서는 생존자가 1명
    // 이하로 남을 때만 매치가 종료된다(leaveMatch 내부에서 판단).
    await this.acidRainService.leaveMatch(roomId, userId, this.server);

    await client.leave(`game:${roomId}`);
    (client.data as GameSocketData).roomId = undefined;
  }

  // ─── spectate_room (#70) ────────────────────────────────────────────────────

  @SubscribeMessage('spectate_room')
  async handleSpectateRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SpectateRoomPayload,
  ) {
    const { userId, nickname } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');

    const { roomId } = this.parseSpectateRoomPayload(payload);
    this.logger.log(
      `spectate_room received: room=${roomId} user=${userId} socket=${client.id}`,
    );

    // 진행 중인 매치가 아니면(대기 중/이미 종료) 관전 자체가 불가능하다. 참가자
    // 인원수 검증(join_room의 2인 제약)과는 무관 — 관전자는 room.players에 들어가지
    // 않으므로 이 검증을 거치지 않는다.
    const snapshot = this.acidRainService.getSpectatorSnapshot(roomId);
    if (!snapshot) {
      this.logger.warn(
        `spectate_room rejected — not spectatable: room=${roomId} user=${userId}`,
      );
      throw new WsException('Room is not currently spectatable');
    }

    await client.join(`game:${roomId}`);
    (client.data as GameSocketData).spectatingRoomId = roomId;
    this.logger.log(
      `spectate_room joined + state_sync sent: room=${roomId} user=${userId}`,
    );
    client.emit('state_sync', snapshot);
    this.chatGateway
      .sendSystemMessage(roomId, `${nickname ?? '관전자'} 님이 관전을 시작했습니다.`)
      .catch((err) =>
        this.logger.error(
          `Failed to send spectator-join system message: ${String(err)}`,
        ),
      );
  }

  // ─── leave_spectate (#70) ───────────────────────────────────────────────────

  @SubscribeMessage('leave_spectate')
  async handleLeaveSpectate(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LeaveSpectatePayload,
  ) {
    const { userId, nickname } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');

    const { roomId } = this.parseLeaveSpectatePayload(payload);

    await client.leave(`game:${roomId}`);
    (client.data as GameSocketData).spectatingRoomId = undefined;

    this.chatGateway
      .sendSystemMessage(roomId, `${nickname ?? '관전자'} 님이 관전을 종료했습니다.`)
      .catch((err) =>
        this.logger.error(
          `Failed to send spectator-leave system message: ${String(err)}`,
        ),
      );
  }

  // ─── typing_progress (#71) ────────────────────────────────────────────────

  @SubscribeMessage('typing_progress')
  handleTypingProgress(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: TypingProgressPayload,
  ): void {
    const { userId, spectatingRoomId } = client.data as GameSocketData;
    if (!userId || spectatingRoomId) return;

    if (
      !isRecord(payload) ||
      !isNonEmptyString(payload.roomId) ||
      typeof payload.partialText !== 'string'
    ) return;

    const { roomId, partialText } = payload;
    const session = this.acidRainService.getSession(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return;

    client.to(`game:${roomId}`).emit('opponent_typing', { participantId: userId, partialText });
  }

  // ─── word_submit ──────────────────────────────────────────────────────────

  @SubscribeMessage('word_submit')
  async handleWordSubmit(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WordSubmitPayload,
  ): Promise<void> {
    const { userId, spectatingRoomId } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');
    // 관전자는 매치 판정에 참여할 수 없다 — service의 isParticipant 검증이 최종
    // 방어선이지만, 여기서 먼저 걸러 불필요한 attemptId 기록을 남기지 않는다.
    if (spectatingRoomId) {
      throw new WsException('Spectators cannot submit words');
    }

    const { roomId, wordId, text, attemptId } =
      this.parseWordSubmitPayload(payload);
    const result = await this.acidRainService.submitWord(
      {
        roomId,
        playerId: userId,
        wordId,
        text,
        attemptId,
      },
      this.server,
    );

    if (!result.accepted) {
      client.emit('submit_rejected', result.submitRejected);
      return;
    }
  }

  private parseJoinRoomPayload(payload: unknown): JoinRoomPayload {
    if (!isRecord(payload) || !isNonEmptyString(payload.roomId)) {
      throw new WsException('Invalid join_room payload');
    }
    return { roomId: payload.roomId };
  }

  private parseLeaveRoomPayload(payload: unknown): LeaveRoomPayload {
    if (!isRecord(payload) || !isNonEmptyString(payload.roomId)) {
      throw new WsException('Invalid leave_room payload');
    }
    return { roomId: payload.roomId };
  }

  private parseSpectateRoomPayload(payload: unknown): SpectateRoomPayload {
    if (!isRecord(payload) || !isNonEmptyString(payload.roomId)) {
      throw new WsException('Invalid spectate_room payload');
    }
    return { roomId: payload.roomId };
  }

  private parseLeaveSpectatePayload(payload: unknown): LeaveSpectatePayload {
    if (!isRecord(payload) || !isNonEmptyString(payload.roomId)) {
      throw new WsException('Invalid leave_spectate payload');
    }
    return { roomId: payload.roomId };
  }

  private parseWordSubmitPayload(payload: unknown): WordSubmitPayload {
    if (
      !isRecord(payload) ||
      !isNonEmptyString(payload.roomId) ||
      !isNonEmptyString(payload.wordId) ||
      !isNonEmptyString(payload.text) ||
      typeof payload.clientTs !== 'number' ||
      !Number.isFinite(payload.clientTs) ||
      !isNonEmptyString(payload.attemptId)
    ) {
      throw new WsException('Invalid word_submit payload');
    }

    return {
      roomId: payload.roomId,
      wordId: payload.wordId,
      text: payload.text,
      clientTs: payload.clientTs,
      attemptId: payload.attemptId,
    };
  }
}
