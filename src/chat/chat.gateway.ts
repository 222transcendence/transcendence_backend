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
import { MessageType } from './entities/chat-message.entity';

@WebSocketGateway({ namespace: '/chat', cors: { origin: '*' } })
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = this.extractToken(client);
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || 'secret_jwt_key',
      });
      const user = await this.userService.findOne(payload.sub);
      client.data.user = user;
      this.logger.log(`Client connected: ${client.id} (user: ${user.nickname})`);
    } catch {
      this.logger.warn(`Unauthorized connection: ${client.id} — disconnecting`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const nickname = client.data.user?.nickname ?? client.id;
    this.logger.log(`Client disconnected: ${client.id} (user: ${nickname})`);
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

    const payload = {
      id: saved.id,
      sender: {
        id: saved.sender.id,
        nickname: saved.sender.nickname,
        avatar: saved.sender.avatar,
      },
      content: saved.content,
      roomId: saved.roomId,
      type: saved.type,
      createdAt: saved.createdAt,
    };

    this.server.emit('receive_message', payload);
    return payload;
  }

  private extractToken(client: Socket): string {
    // Support: auth.token or query.token
    const authToken: string | undefined =
      client.handshake.auth?.token ?? client.handshake.query?.token;

    if (!authToken) {
      throw new WsException('Missing token');
    }

    // Strip "Bearer " prefix if present
    return authToken.startsWith('Bearer ')
      ? authToken.slice(7)
      : authToken;
  }
}
