import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatMessage, MessageType } from './entities/chat-message.entity';

const HISTORY_LIMIT = 50;

@Injectable()
export class ChatService {
  constructor(
    @InjectRepository(ChatMessage)
    private readonly chatMessageRepository: Repository<ChatMessage>,
  ) {}

  async saveMessage(
    senderId: string,
    content: string,
    roomId?: string,
    type: MessageType = MessageType.NORMAL,
  ): Promise<ChatMessage> {
    const message = this.chatMessageRepository.create({
      sender: { id: senderId },
      content,
      roomId,
      type,
    });
    return await this.chatMessageRepository.save(message);
  }

  async getHistory(): Promise<ChatMessage[]> {
    return await this.chatMessageRepository.find({
      order: { createdAt: 'ASC' },
      take: HISTORY_LIMIT,
    });
  }
}
