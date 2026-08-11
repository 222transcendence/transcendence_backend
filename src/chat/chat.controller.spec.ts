import { Test, TestingModule } from '@nestjs/testing';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { MessageType } from './entities/chat-message.entity';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

describe('ChatController', () => {
  let controller: ChatController;
  let chatService: ChatService;

  const mockChatService = {
    getHistory: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [{ provide: ChatService, useValue: mockChatService }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ChatController>(ChatController);
    chatService = module.get<ChatService>(ChatService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('GET /api/chat/history', () => {
    it('should return array of messages from service', async () => {
      const messages = [
        {
          id: 'uuid-1',
          content: 'Hello',
          type: MessageType.NORMAL,
          createdAt: new Date(),
          sender: { id: 'user-1', nickname: 'Alice' },
        },
      ];
      mockChatService.getHistory.mockResolvedValue(messages);

      const result = await controller.getHistory();
      expect(chatService.getHistory).toHaveBeenCalled();
      expect(result.data).toEqual(messages);
      expect(result.error).toBeNull();
      expect(result.status).toBe(200);
    });
  });
});
