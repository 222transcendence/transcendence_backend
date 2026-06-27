import {
  WebSocketGateway,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { UserService } from '../user/user.service';
import { User } from '../user/entities/user.entity';
import { extractWsToken } from '../common/websocket/ws-jwt.util';

interface GameSocketData {
  user?: User;
}

@WebSocketGateway({ namespace: '/game', cors: { origin: '*' } })
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameGateway.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly userService: UserService,
  ) {}

  async handleConnection(client: Socket) {
    try {
      const token = extractWsToken(client);
      const payload = this.jwtService.verify<{ sub: string }>(token, {
        secret: process.env.JWT_SECRET || 'secret_jwt_key',
      });
      const user = await this.userService.findOne(payload.sub);
      (client.data as GameSocketData).user = user;
      this.logger.log(
        `Client connected: ${client.id} (user: ${user.nickname})`,
      );
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
}
