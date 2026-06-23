import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
} from '@nestjs/common';
import { GameService } from './game.service';
import { CreateRoomDto, JoinRoomDto, SubmitCardsDto } from './dto/game.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../user/entities/user.entity';

@Controller('game')
@UseGuards(JwtAuthGuard)
export class GameController {
  constructor(private readonly gameService: GameService) {}

  @Post('rooms')
  async createRoom(@Req() req: any, @Body() dto: CreateRoomDto) {
    const user = (req as { user: User }).user;
    const room = await this.gameService.createRoom(
      user.id,
      user.nickname,
      dto.characterId,
    );
    return {
      timestamp: new Date().toISOString(),
      status: 201,
      data: room,
      error: null,
    };
  }

  @Post('rooms/:id/join')
  async joinRoom(
    @Req() req: any,
    @Param('id') roomId: string,
    @Body() dto: JoinRoomDto,
  ) {
    const user = (req as { user: User }).user;
    const room = await this.gameService.joinRoom(
      roomId,
      user.id,
      user.nickname,
      dto.characterId,
    );
    return {
      timestamp: new Date().toISOString(),
      status: 200,
      data: room,
      error: null,
    };
  }

  @Get('rooms')
  async getWaitingRooms() {
    const rooms = await this.gameService.getWaitingRooms();
    return {
      timestamp: new Date().toISOString(),
      status: 200,
      data: rooms,
      error: null,
    };
  }

  @Post('rooms/:id/submit')
  async submitCards(
    @Req() req: any,
    @Param('id') roomId: string,
    @Body() dto: SubmitCardsDto,
  ) {
    const user = (req as { user: User }).user;
    const room = await this.gameService.submitCards(
      roomId,
      user.id,
      dto.cardIds,
    );
    return {
      timestamp: new Date().toISOString(),
      status: 200,
      data: room,
      error: null,
    };
  }
}
