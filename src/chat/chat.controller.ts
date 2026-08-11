import { Controller, Get, UseGuards } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('api/chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('history')
  async getHistory() {
    const data = await this.chatService.getHistory();
    return { timestamp: new Date().toISOString(), status: 200, data, error: null };
  }
}
