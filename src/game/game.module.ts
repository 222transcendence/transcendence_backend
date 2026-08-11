import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/entities/user.entity';
import { MatchHistory } from './entities/match-history.entity';
import { RedisModule } from '../redis/redis.module';
import { GameController } from './game.controller';
import { GameService } from './game.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, MatchHistory]), RedisModule],
  controllers: [GameController],
  providers: [GameService],
  exports: [TypeOrmModule, GameService],
})
export class GameModule {}
