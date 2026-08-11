import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LobbyGateway } from './lobby.gateway';
import { LobbyService } from './lobby.service';
import { GameModule } from '../game/game.module';
import { UserModule } from '../user/user.module';

@Module({
  imports: [
    GameModule,
    UserModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'secret_jwt_key',
    }),
  ],
  providers: [LobbyGateway, LobbyService],
  exports: [LobbyGateway, LobbyService],
})
export class LobbyModule {}
