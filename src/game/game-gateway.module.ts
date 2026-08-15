import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { UserModule } from '../user/user.module';
import { GameModule } from './game.module';
import { LobbyModule } from '../lobby/lobby.module';
import { ChatModule } from '../chat/chat.module';
import { WordDictionaryModule } from '../word-dictionary/word-dictionary.module';
import { AcidRainGateway } from './acid-rain/acid-rain.gateway';
import { AcidRainService } from './acid-rain/acid-rain.service';
import { AiExecutor } from './acid-rain/ai/ai-executor';
import { AiScheduler } from './acid-rain/ai/ai-scheduler';
import {
  DefaultAiExecutionProfileFactory,
  DefaultAiProfileProvider,
} from './acid-rain/ai/ai-execution-profile';
import { PlayerPerformanceProfileProvider } from './acid-rain/ai/player-performance-profile-provider';
import {
  AI_CLOCK,
  AI_PROFILE_FACTORY,
  AI_PROFILE_PROVIDER,
  AI_RANDOM_SOURCE,
  AI_TIMER,
} from './acid-rain/ai/ai-execution.types';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'secret_jwt_key',
      signOptions: { expiresIn: '15m' },
    }),
    UserModule,
    GameModule,
    LobbyModule,
    ChatModule,
    WordDictionaryModule,
  ],
  providers: [
    AcidRainGateway,
    AcidRainService,
    AiExecutor,
    AiScheduler,
    DefaultAiProfileProvider,
    DefaultAiExecutionProfileFactory,
    PlayerPerformanceProfileProvider,
    {
      provide: AI_PROFILE_PROVIDER,
      useExisting: PlayerPerformanceProfileProvider,
    },
    {
      provide: AI_PROFILE_FACTORY,
      useExisting: DefaultAiExecutionProfileFactory,
    },
    { provide: AI_CLOCK, useValue: { now: () => Date.now() } },
    {
      provide: AI_TIMER,
      useValue: {
        setTimeout: (callback: () => void, delayMs: number) =>
          setTimeout(callback, delayMs),
        clearTimeout: (timer: ReturnType<typeof setTimeout>) =>
          clearTimeout(timer),
      },
    },
    { provide: AI_RANDOM_SOURCE, useValue: { next: () => Math.random() } },
  ],
})
export class GameGatewayModule {}
