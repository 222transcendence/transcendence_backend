import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { User } from '../user/entities/user.entity';
import { Character } from './entities/character.entity';
import { Card } from './entities/card.entity';
import { MatchHistory } from './entities/match-history.entity';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, Character, Card, MatchHistory]),
    RedisModule,
  ],
  controllers: [GameController],
  providers: [GameService],
  exports: [GameService],
})
export class GameModule {}
