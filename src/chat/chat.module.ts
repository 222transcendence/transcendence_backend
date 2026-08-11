import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ChatMessage } from './entities/chat-message.entity';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { UserModule } from '../user/user.module';
import { FriendModule } from '../friend/friend.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ChatMessage]),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'secret_jwt_key',
      signOptions: { expiresIn: '15m' },
    }),
    UserModule,
    FriendModule,
  ],
  providers: [ChatGateway, ChatService],
  controllers: [ChatController],
  exports: [ChatService, ChatGateway],
})
export class ChatModule {}
