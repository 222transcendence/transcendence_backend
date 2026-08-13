import { Injectable } from '@nestjs/common';
import {
  buildPlayerSkillProfile,
  DEFAULT_PLAYER_SKILL,
  type PlayerSkillProfile,
} from '../../player-model';
import type { AiDifficulty } from '../acid-rain.interface';
import type { AiProfileProvider } from './ai-execution-profile';
import { TypeOrmPlayerPerformanceSource } from '../../player-performance-source';

@Injectable()
export class PlayerPerformanceProfileProvider implements AiProfileProvider {
  constructor(private readonly source: TypeOrmPlayerPerformanceSource) {}

  getSkillProfile(): PlayerSkillProfile {
    return { ...DEFAULT_PLAYER_SKILL };
  }

  async loadSkillProfile(context: {
    roomId: string;
    aiParticipantId: string;
    modelPlayerId: string;
    difficulty: AiDifficulty;
  }): Promise<PlayerSkillProfile> {
    const samples = await this.source.getRecentPerformance(
      context.modelPlayerId,
    );
    try {
      return buildPlayerSkillProfile(samples);
    } catch (err) {
      throw new Error(`AI profile model calculation failed: ${String(err)}`);
    }
  }
}
