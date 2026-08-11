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
import { AcidRainService } from './acid-rain.service';
import type { JoinRoomPayload, LeaveRoomPayload, WordSubmitPayload } from './acid-rain.interface';

interface GameSocketData {
  userId?: string;
  nickname?: string;
  /** 현재 참여 중인 roomId (재접속 처리용) */
  roomId?: string;
}

@WebSocketGateway({ namespace: '/game', path: '/socketio', cors: { origin: '*' } })
export class AcidRainGateway implements OnGatewayConnection, OnGatewayDisconnect {
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

    // 로비 Redis에서 방 정보 조회 (lobby.service가 저장하는 키 형식 사용)
    const rawRoom = await this.redisService.get(`game:room:${roomId}`);
    if (!rawRoom) throw new WsException('Room not found');

    const room = JSON.parse(rawRoom) as {
      host: { userId: string; nickname: string };
      guest?: { userId: string; nickname: string } | null;
      status: string;
    };

    const isParticipant =
      room.host.userId === userId || room.guest?.userId === userId;
    if (!isParticipant) throw new WsException('Not a participant of this room');

    await client.join(`game:${roomId}`);
    (client.data as GameSocketData).roomId = roomId;

    const existingSession = this.acidRainService.getSession(roomId);

    if (existingSession && existingSession.status !== 'FINISHED') {
      // 재접속 — state_sync 전송
      this.acidRainService.handleReconnect(roomId, userId, this.server, client);
      return;
    }

    // 양쪽 소켓이 모두 룸에 입장했는지 확인
    const socketsInRoom = await this.server.in(`game:${roomId}`).fetchSockets();
    if (socketsInRoom.length < 2) {
      // 첫 번째 플레이어 — 상대방 대기
      return;
    }

    // guest 정보 확인
    if (!room.guest) {
      throw new WsException('Guest not in room yet');
    }

    const host = { userId: room.host.userId, nickname: room.host.nickname };
    const guest = { userId: room.guest.userId, nickname: room.guest.nickname };

    // match_ready 브로드캐스트
    this.server.to(`game:${roomId}`).emit('match_ready', {
      roomId,
      protocolVersion: '1.0',
      players: { host, guest },
    });

    // 매치 시작 (3초 카운트다운 포함)
    await this.acidRainService.startMatch(roomId, host, guest, this.server);
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
    const session = this.acidRainService.getSession(roomId);

    if (session && session.status === 'IN_PROGRESS') {
      // 진행 중 퇴장 → FORFEIT
      await this.acidRainService.endMatch(roomId, 'FORFEIT', this.server,
        session.host.userId === userId ? session.guest.userId : session.host.userId,
      );
    }

    await client.leave(`game:${roomId}`);
    (client.data as GameSocketData).roomId = undefined;
  }

  // ─── word_submit ──────────────────────────────────────────────────────────

  @SubscribeMessage('word_submit')
  handleWordSubmit(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: WordSubmitPayload,
  ) {
    const { userId } = client.data as GameSocketData;
    if (!userId) throw new WsException('Unauthorized');

    const { roomId, wordId, text } = payload;

    // submit_rejected는 제출자에게만 emit해야 하므로 client를 넘김
    const session = this.acidRainService.getSession(roomId);
    if (!session) {
      client.emit('submit_rejected', { wordId, reason: 'NOT_FOUND' });
      return;
    }

    // Service에 판정 위임 (레이스 컨디션은 단일 인스턴스 Node.js 이벤트 루프로 보장)
    // submit_rejected는 room emit이 아닌 client emit이 필요하므로 여기서 직접 처리
    this.judgeAndEmit(client, userId, roomId, wordId, text);
  }

  // word_submit 판정을 gateway에서 처리해 submit_rejected를 client에게만 보냄
  private judgeAndEmit(
    client: Socket,
    userId: string,
    roomId: string,
    wordId: string,
    text: string,
  ): void {
    const session = this.acidRainService.getSession(roomId);
    if (!session || session.status !== 'IN_PROGRESS') return;

    if (session.clearedWords.has(wordId)) {
      client.emit('submit_rejected', { wordId, reason: 'ALREADY_CLEARED' });
      return;
    }

    const word = session.activeWords.get(wordId);
    if (!word) {
      client.emit('submit_rejected', { wordId, reason: 'NOT_FOUND' });
      return;
    }

    if (word.text !== text) {
      client.emit('submit_rejected', { wordId, reason: 'WRONG_TEXT' });
      return;
    }

    // 정타 처리는 Service에 위임
    this.acidRainService.judgeSubmit(roomId, userId, wordId, text, this.server);
  }
}
