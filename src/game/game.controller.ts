import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { GameService } from './game.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MatchMode } from './entities/match-history.entity';

// 구 REST 방 엔드포인트(POST rooms 등)는 로비 WebSocket(/ws/lobby)으로 완전히 대체되어
// 제거됨 — 실사용처 없음 확인됨 (WEBSOCKET_PROTOCOL.md §6.5, #78).
@Controller('api/game')
@UseGuards(JwtAuthGuard)
export class GameController {
  constructor(private readonly gameService: GameService) {}

  // ─── #21 Stats & Leaderboard ────────────────────────────────────────────

  @Get('users/:id/stats')
  async getUserStats(@Param('id') userId: string) {
    const data = await this.gameService.getUserStats(userId);
    return {
      timestamp: new Date().toISOString(),
      status: 200,
      data,
      error: null,
    };
  }

  @Get('users/:id/matches')
  async getUserMatches(
    @Param('id') userId: string,
    @Query('page') page = '1',
    @Query('limit') limit = '10',
    @Query('mode') mode?: string,
  ) {
    const matchMode = mode === 'PVP' ? MatchMode.PVP
      : mode === 'AI_PRACTICE' ? MatchMode.AI_PRACTICE
      : undefined;
    const data = await this.gameService.getUserMatches(
      userId,
      Math.max(1, parseInt(page)),
      Math.min(50, parseInt(limit)),
      matchMode,
    );
    return {
      timestamp: new Date().toISOString(),
      status: 200,
      data,
      error: null,
    };
  }

  @Get('leaderboard')
  async getLeaderboard() {
    const data = await this.gameService.getLeaderboard();
    return {
      timestamp: new Date().toISOString(),
      status: 200,
      data,
      error: null,
    };
  }
}
