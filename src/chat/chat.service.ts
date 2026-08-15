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

  /** 방 입장/퇴장 등 서버가 생성하는 SYSTEM 메시지 — 실제 sender User 없이 저장 */
  async saveSystemMessage(roomId: string, content: string): Promise<ChatMessage> {
    const message = this.chatMessageRepository.create({
      sender: null,
      content,
      roomId,
      type: MessageType.SYSTEM,
    });
    return await this.chatMessageRepository.save(message);
  }

  async getHistory() {
    const messages = await this.chatMessageRepository.find({
      where: [{ type: MessageType.NORMAL }, { type: MessageType.SYSTEM }],
      order: { createdAt: 'DESC' },
      take: HISTORY_LIMIT,
    });
    messages.reverse(); // 최신 50개를 오름차순으로 정렬

    return messages.map((msg) => ({
      id: msg.id,
      content: msg.content,
      roomId: msg.roomId,
      type: msg.type,
      createdAt: msg.createdAt,
      sender: msg.sender
        ? { id: msg.sender.id, nickname: msg.sender.nickname, avatar: msg.sender.avatar }
        : { id: 'system', nickname: 'SYSTEM', avatar: null },
    }));
  }
}
