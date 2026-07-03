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
import { UserService } from '../user/user.service';
import { GameService } from './game.service';
import { User } from '../user/entities/user.entity';
import { GameRoom, RoomStatus } from './game.interface';
import { extractWsToken } from '../common/websocket/ws-jwt.util';

interface GameSocketData {
  user?: User;
}

@WebSocketGateway({ namespace: '/game', path: '/socketio', cors: { origin: '*' } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(GameGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly gameService: GameService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = extractWsToken(client);
      const payload = this.jwtService.verify<{ sub: string }>(token, {
        secret: process.env.JWT_SECRET || 'secret_jwt_key',
      });
      const user = await this.userService.findOne(payload.sub);
      (client.data as GameSocketData).user = user;
      this.logger.log(`Client connected: ${client.id} (user: ${user.nickname})`);
    } catch {
      this.logger.warn(`Unauthorized connection: ${client.id} — disconnecting`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const user = (client.data as GameSocketData).user;
    this.logger.log(
      `Client disconnected: ${client.id} (user: ${user?.nickname ?? client.id})`,
    );
  }

  // ─── #24 join_room ────────────────────────────────────────────────────────

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string },
  ) {
    const user = (client.data as GameSocketData).user;
    if (!user) throw new WsException('Unauthorized');

    const room = await this.gameService.getRoom(payload.roomId);
    if (!room) throw new WsException('Room not found');

    const isParticipant =
      room.host.userId === user.id ||
      (room.guest && room.guest.userId === user.id);
    if (!isParticipant) throw new WsException('Not a participant of this room');

    await client.join(`game:${payload.roomId}`);
    this.logger.log(`${user.nickname} joined socket room game:${payload.roomId}`);

    // 두 플레이어 모두 소켓 룸에 입장했으면 game_start 브로드캐스트 (#24)
    const socketsInRoom = await this.server
      .in(`game:${payload.roomId}`)
      .fetchSockets();

    if (socketsInRoom.length === 2 && room.status === RoomStatus.IN_GAME) {
      this.server.to(`game:${payload.roomId}`).emit('game_start', {
        type: 'GAME_START',
        payload: {
          roomId: room.id,
          host: {
            userId: room.host.userId,
            nickname: room.host.nickname,
            characterId: room.host.characterId,
            hp: room.host.hp,
            cardsInHand: room.host.cardsInHand,
          },
          guest: room.guest
            ? {
                userId: room.guest.userId,
                nickname: room.guest.nickname,
                characterId: room.guest.characterId,
                hp: room.guest.hp,
                cardsInHand: room.guest.cardsInHand,
              }
            : null,
          phase: room.phase,
          distance: room.distance,
          currentTurn: room.currentTurn,
        },
        seq: 0,
      });
      this.logger.log(`GAME_START broadcasted to game:${payload.roomId}`);
    }

    return { event: 'joined', data: { roomId: payload.roomId } };
  }

  // ─── #24 leave_room ───────────────────────────────────────────────────────

  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string },
  ) {
    const user = (client.data as GameSocketData).user;
    if (!user) throw new WsException('Unauthorized');

    await client.leave(`game:${payload.roomId}`);

    // 상대방에게 퇴장 알림
    client.to(`game:${payload.roomId}`).emit('player_left', {
      type: 'PLAYER_LEFT',
      payload: { userId: user.id, nickname: user.nickname },
      seq: 0,
    });

    this.logger.log(`${user.nickname} left socket room game:${payload.roomId}`);
    return { event: 'left', data: { roomId: payload.roomId } };
  }

  // ─── #25 submit_cards / #26 phase_update broadcast ───────────────────────

  @SubscribeMessage('submit_cards')
  async handleSubmitCards(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { roomId: string; cardIds: number[] },
  ) {
    const user = (client.data as GameSocketData).user;
    if (!user) throw new WsException('Unauthorized');

    let updatedRoom: GameRoom;
    try {
      updatedRoom = await this.gameService.submitCards(
        payload.roomId,
        user.id,
        payload.cardIds,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Submit failed';
      throw new WsException(message);
    }

    // 제출 확인 응답 (요청한 클라이언트에게만)
    client.emit('cards_accepted', {
      type: 'CARDS_ACCEPTED',
      payload: { roomId: payload.roomId },
      seq: 0,
    });

    // 양쪽 모두 제출 완료되어 페이즈가 전환된 경우 PHASE_UPDATE 브로드캐스트 (#26)
    const hostSubmitted = updatedRoom.host.cardsSubmitted.length === 0; // 리셋됐으면 전환 완료
    const guestSubmitted =
      !updatedRoom.guest || updatedRoom.guest.cardsSubmitted.length === 0;

    if (hostSubmitted && guestSubmitted) {
      this.broadcastPhaseUpdate(payload.roomId, updatedRoom);
    }

    return { event: 'submit_cards', data: null };
  }

  // ─── #26 PHASE_UPDATE helper ──────────────────────────────────────────────

  private broadcastPhaseUpdate(roomId: string, room: GameRoom) {
    this.server.to(`game:${roomId}`).emit('phase_update', {
      type: 'PHASE_UPDATE',
      payload: {
        roomId: room.id,
        status: room.status,
        currentPhase: room.phase,
        initiative: room.initiative ?? null,
        distance: room.distance,
        currentTurn: room.currentTurn,
        hostHp: room.host.hp,
        guestHp: room.guest?.hp ?? 0,
        hostCardsInHand: room.host.cardsInHand,
        guestCardsInHand: room.guest?.cardsInHand ?? [],
        statusEffects: room.statusEffects,
        diceResults: room.lastDiceRoll ?? null,
        skillsTriggered: room.lastActionLog ?? [],
        winnerId: room.winnerId ?? null,
      },
      seq: 0,
    });
    this.logger.log(
      `PHASE_UPDATE broadcasted to game:${roomId} — phase: ${room.phase ?? 'FINISHED'}`,
    );
  }
}
