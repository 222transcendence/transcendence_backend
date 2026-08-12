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
import { GameRoom } from '../game.interface';
import type {
  JoinRoomPayload,
  LeaveRoomPayload,
  PlayerPublic,
  WordSubmitPayload,
} from './acid-rain.interface';

interface GameSocketData {
  userId?: string;
  nickname?: string;
  /** 현재 참여 중인 roomId (재접속 처리용) */
  roomId?: string;
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

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly redisService: RedisService,
    private readonly acidRainService: AcidRainService,
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
    this.logger.log(`Disconnected: ${client.id} (${nickname ?? 'unknown'})`);

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

    const { roomId } = payload;

    // 로비 Redis에서 방 정보 조회 (game.service가 저장하는 GameRoom 형식)
    const rawRoom = await this.redisService.get(`game:room:${roomId}`);
    if (!rawRoom) throw new WsException('Room not found');

    const room = JSON.parse(rawRoom) as GameRoom;

    const isParticipant = room.players.some((p) => p.userId === userId);
    if (!isParticipant) throw new WsException('Not a participant of this room');

    await client.join(`game:${roomId}`);
    (client.data as GameSocketData).roomId = roomId;

    const existingSession = this.acidRainService.getSession(roomId);

    if (existingSession && existingSession.status !== 'FINISHED') {
      // 재접속 — state_sync 전송
      this.acidRainService.handleReconnect(roomId, userId, this.server, client);
      return;
    }

    // 로비 룸의 참가자(2~4명) 전원이 /game 소켓에 입장했는지 확인
    const socketsInRoom = await this.server.in(`game:${roomId}`).fetchSockets();
    if (socketsInRoom.length < room.players.length) {
      // 아직 전원이 입장하지 않음 — 나머지 대기
      return;
    }

    const players: PlayerPublic[] = room.players.map((p) => ({
      userId: p.userId,
      nickname: p.nickname,
    }));

    // match_ready 브로드캐스트
    this.server.to(`game:${roomId}`).emit('match_ready', {
      roomId,
      protocolVersion: '1.0',
      players,
    });

    // 매치 시작 (3초 카운트다운 포함)
    await this.acidRainService.startMatch(roomId, players, this.server);
  }

  // ─── leave_room ───────────────────────────────────────────────────────────

  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: LeaveRoomPayload,
  ) {
    const { userId } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');

    const { roomId } = payload;
    // 명시적 퇴장 → 즉시 탈락 처리 (매치 진행 중이 아니면 내부에서 no-op)
    await this.acidRainService.eliminateOnLeave(roomId, userId, this.server);

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

    const { roomId, wordId, text, attemptId } = payload;
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
}
