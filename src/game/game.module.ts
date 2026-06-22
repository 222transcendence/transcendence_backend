import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Character } from './entities/character.entity';
import { Card } from './entities/card.entity';
import { MatchHistory } from './entities/match-history.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Character, Card, MatchHistory])],
  exports: [TypeOrmModule],
})
export class GameModule {}
