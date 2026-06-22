import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { AppDataSource } from './data-source';
import { UserModule } from './user/user.module';
import { FriendModule } from './friend/friend.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { MetricsModule } from './metrics/metrics.module';
import { ChatModule } from './chat/chat.module';
import { GameGatewayModule } from './game/game-gateway.module';
import { GameModule } from './game/game.module';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      ...AppDataSource.options,
      autoLoadEntities: true,
    }),
    UserModule,
    FriendModule,
    RedisModule,
    AuthModule,
    MetricsModule,
    ChatModule,
    GameGatewayModule,
    GameModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
