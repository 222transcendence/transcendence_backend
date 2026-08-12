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
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  MatchReadyEventPayload,
  ParticipantState,
  WordSubmitPayload,
} from './acid-rain.interface';
import { RoomStatus, type GameRoom } from '../game.interface';

interface GameSocketData {
  userId?: string;
  nickname?: string;
  /** 현재 참여 중인 roomId (재접속 처리용) */
  roomId?: string;
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
    const { userId, nickname, roomId } = client.data as GameSocketData;
    this.logger.log(
      `Disconnected: ${client.id} (${nickname ?? 'unknown'}) room=${roomId ?? 'none'}`,
    );

    if (userId) websocketConnections.dec({ namespace: 'game' });

    if (userId && roomId) {
      this.acidRainService.handleDisconnect(roomId, userId, this.server);
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
        throw new WsException({
          code: 'AI_PRACTICE_NOT_READY',
          message: 'AI practice is not available yet',
        });
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

      if (room.players.length !== 2) {
        this.logger.warn(
          `join_room rejected — unsupported player count: room=${roomId} count=${room.players.length}`,
        );
        throw new WsException(
          'Current Acid Rain engine supports exactly 2 participants until #136',
        );
      }

      // 양쪽 소켓이 모두 룸에 입장했는지 확인
      const socketsInRoom = await this.server
        .in(`game:${roomId}`)
        .fetchSockets();
      this.logger.log(
        `join_room socket count check: room=${roomId} sockets=${socketsInRoom.length} ids=${socketsInRoom.map((s) => s.id).join(',')}`,
      );
      if (socketsInRoom.length < 2) {
        // 첫 번째 플레이어 — 상대방 대기
        this.logger.log(
          `join_room waiting for opponent: room=${roomId} user=${userId}`,
        );
        return;
      }

      const [hostPlayer, guestPlayer] = room.players;
      const host = {
        userId: hostPlayer.userId,
        nickname: hostPlayer.nickname,
      };
      const guest = {
        userId: guestPlayer.userId,
        nickname: guestPlayer.nickname,
      };

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
        `join_room match_ready broadcast: room=${roomId} host=${host.userId} guest=${guest.userId}`,
      );

      // 매치 시작 (3초 카운트다운 포함)
      await this.acidRainService.startMatch(roomId, host, guest, this.server);
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
    const session = this.acidRainService.getSession(roomId);

    if (session && session.status === 'IN_PROGRESS') {
      // 진행 중 퇴장 → FORFEIT
      await this.acidRainService.endMatch(
        roomId,
        'FORFEIT',
        this.server,
        session.host.userId === userId
          ? session.guest.userId
          : session.host.userId,
      );
    }

    await client.leave(`game:${roomId}`);
    (client.data as GameSocketData).roomId = undefined;
  }

  // ─── word_submit ──────────────────────────────────────────────────────────

  @SubscribeMessage('word_submit')
  async handleWordSubmit(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WordSubmitPayload,
  ): Promise<void> {
    const { userId } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');

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
