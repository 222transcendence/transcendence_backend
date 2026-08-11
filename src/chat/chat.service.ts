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
    const saved = await this.chatMessageRepository.save(message);
    // eager 관계가 부분 객체({id})로 채워질 수 있어 재조회
    return await this.chatMessageRepository.findOneOrFail({ where: { id: saved.id } });
  }

  async getHistory() {
    const messages = await this.chatMessageRepository.find({
      order: { createdAt: 'ASC' },
      take: HISTORY_LIMIT,
    });

    return messages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      roomId: msg.roomId,
      type: msg.type,
      createdAt: msg.createdAt,
      sender: {
        id: msg.sender.id,
        nickname: msg.sender.nickname,
        avatar: msg.sender.avatar,
      },
    }));
  }
}
