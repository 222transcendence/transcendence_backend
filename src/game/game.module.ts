import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../user/entities/user.entity';
import { MatchHistory } from './entities/match-history.entity';
import { MatchParticipant } from './entities/match-participant.entity';
import { KeystrokeRecord } from './entities/keystroke-record.entity';
import { WordAttemptRecord } from './entities/word-attempt-record.entity';
import { ParticipantPerformance } from './entities/participant-performance.entity';
import { RedisModule } from '../redis/redis.module';
import { GameController } from './game.controller';
import { GameService } from './game.service';
import { AiPracticeService } from './ai-practice.service';
import { PerformanceService } from './acid-rain/performance.service';
import { TypeOrmPlayerPerformanceSource } from './player-performance-source';
import { TypeOrmPlayerBehaviorSource } from './player-behavior-source';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      MatchHistory,
      MatchParticipant,
      KeystrokeRecord,
      WordAttemptRecord,
      ParticipantPerformance,
    ]),
    RedisModule,
  ],
  controllers: [GameController],
  providers: [
    GameService,
    AiPracticeService,
    PerformanceService,
    TypeOrmPlayerPerformanceSource,
    TypeOrmPlayerBehaviorSource,
  ],
  exports: [
    TypeOrmModule,
    GameService,
    AiPracticeService,
    PerformanceService,
    TypeOrmPlayerPerformanceSource,
    TypeOrmPlayerBehaviorSource,
  ],
})
export class GameModule {}
