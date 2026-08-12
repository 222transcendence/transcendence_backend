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
import { Server, Socket } from 'socket.io';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { JwtService } from '@nestjs/jwt';
import { ChatService } from './chat.service';
import { SendMessageDto } from './dto/send-message.dto';
import { UserService } from '../user/user.service';
import { FriendService } from '../friend/friend.service';
import { RedisService } from '../redis/redis.service';
import { MessageType } from './entities/chat-message.entity';
import { websocketConnections } from '../metrics/metrics.registry';

export type OnlineStatus = 'ONLINE' | 'OFFLINE' | 'IN_GAME';

const USER_STATUS_TTL = 86400; // 24h fallback TTL

@WebSocketGateway({ namespace: '/chat', path: '/socketio', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  // userId → Set of socketIds (user may have multiple tabs)
  private readonly userSockets = new Map<string, Set<string>>();
  // socketId → userId
  private readonly socketUser = new Map<string, string>();

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
    private readonly friendService: FriendService,
    private readonly redisService: RedisService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'secret_jwt_key',
      });
      const user = await this.userService.findOne(payload.sub);
      client.data.user = user;

      this.trackSocket(user.id, client.id);
      await this.setUserStatus(user.id, 'ONLINE');
      await this.notifyFriends(user.id, 'ONLINE');
      websocketConnections.inc({ namespace: 'chat' });

      this.logger.log(`Client connected: ${client.id} (user: ${user.nickname})`);
    } catch {
      this.logger.warn(`Unauthorized connection: ${client.id} — disconnecting`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const user = client.data.user;
    const nickname = user?.nickname ?? client.id;
    this.logger.log(`Client disconnected: ${client.id} (user: ${nickname})`);

    if (user) {
      this.untrackSocket(user.id, client.id);
      websocketConnections.dec({ namespace: 'chat' });
      // Only go OFFLINE when all sockets for this user are gone
      if (!this.userSockets.has(user.id)) {
        await this.setUserStatus(user.id, 'OFFLINE');
        await this.notifyFriends(user.id, 'OFFLINE');
      }
    }
  }

  @UsePipes(new ValidationPipe({
    whitelist: true,
    exceptionFactory: (errors: ValidationError[]) => new WsException(errors),
  }))
  @SubscribeMessage('send_message')
  async handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() dto: SendMessageDto,
  ) {
    const user = client.data.user;
    if (!user) {
      throw new WsException('Unauthorized');
    }

    const saved = await this.chatService.saveMessage(
      user.id,
      dto.content,
      dto.roomId,
      dto.type ?? MessageType.NORMAL,
    );

    // saveMessage()는 인증된 user.id로 항상 sender를 채우므로 이 경로에서는 null이 될 수 없다
    const sender = saved.sender!;
    const payload = {
      id: saved.id,
      sender: {
        id: sender.id,
        nickname: sender.nickname,
        avatar: sender.avatar,
      },
      content: saved.content,
      roomId: saved.roomId,
      type: saved.type,
      createdAt: saved.createdAt,
    };

    if (dto.type === MessageType.INVITE && dto.targetUserId) {
      // INVITE는 수신자 소켓에만 전달 (발신자 제외)
      const targetSockets = this.userSockets.get(dto.targetUserId);
      for (const sid of (targetSockets ?? [])) {
        this.server.to(sid).emit('receive_message', payload);
      }
    } else {
      this.server.emit('receive_message', payload);
    }
    return payload;
  }

  async setUserStatus(userId: string, status: OnlineStatus): Promise<void> {
    await this.redisService.set(`user:${userId}:status`, status, USER_STATUS_TTL);
  }

  async getUserStatus(userId: string): Promise<OnlineStatus | null> {
    const val = await this.redisService.get(`user:${userId}:status`);
    return (val as OnlineStatus) ?? null;
  }

  private trackSocket(userId: string, socketId: string) {
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)!.add(socketId);
    this.socketUser.set(socketId, userId);
  }

  private untrackSocket(userId: string, socketId: string) {
    this.socketUser.delete(socketId);
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  async notifyFriends(userId: string, status: OnlineStatus) {
    try {
      const friends = await this.friendService.getFriends(userId);
      const payload = { userId, status };

      for (const friend of friends) {
        const friendSockets = this.userSockets.get(friend.id);
        if (friendSockets) {
          for (const socketId of friendSockets) {
            this.server.to(socketId).emit('friend_status_update', payload);
          }
        }
      }
    } catch {
      this.logger.warn(`Failed to notify friends for user ${userId}`);
    }
  }

  async sendSystemMessage(roomId: string, content: string): Promise<void> {
    // 저장해두지 않으면, 이 메시지가 방금 생성한 방으로 막 진입해 채팅 소켓을
    // 아직 연결하지 못한 클라이언트(예: 방을 막 만든 호스트 본인)는 놓친다 —
    // 이후 히스토리 조회(getHistory)로 복구할 수 있도록 항상 영속화한다.
    const saved = await this.chatService.saveSystemMessage(roomId, content);
    this.server.emit('receive_message', {
      id: saved.id,
      content: saved.content,
      roomId: saved.roomId,
      type: saved.type,
      sender: { id: 'system', nickname: 'SYSTEM', avatar: null },
      createdAt: saved.createdAt.toISOString(),
    });
  }

  private extractToken(client: Socket): string {
    const authToken: string | undefined =
      client.handshake.auth?.token ?? client.handshake.query?.token;

    if (!authToken) {
      throw new WsException('Missing token');
    }

    return authToken.startsWith('Bearer ')
      ? authToken.slice(7)
      : authToken;
  }
}
