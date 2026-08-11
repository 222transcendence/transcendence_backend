import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatService } from './chat.service';
import { ChatMessage, MessageType } from './entities/chat-message.entity';

const mockRepo = () => ({
  create: jest.fn(),
  save: jest.fn(),
  find: jest.fn(),
  findOneOrFail: jest.fn(),
});

describe('ChatService', () => {
  let service: ChatService;
  let repo: jest.Mocked<Repository<ChatMessage>>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatService,
        { provide: getRepositoryToken(ChatMessage), useFactory: mockRepo },
      ],
    }).compile();

    service = module.get<ChatService>(ChatService);
    repo = module.get(getRepositoryToken(ChatMessage));
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('saveMessage', () => {
    it('should create and save a message', async () => {
      const msg = {
        id: 'uuid-1',
        content: 'hello',
        type: MessageType.NORMAL,
        sender: { id: 'user-1' },
        roomId: undefined,
        createdAt: new Date(),
      } as unknown as ChatMessage;

      repo.create.mockReturnValue(msg);
      repo.save.mockResolvedValue(msg);
      repo.findOneOrFail.mockResolvedValue(msg);

      const result = await service.saveMessage('user-1', 'hello');
      expect(repo.create).toHaveBeenCalledWith({
        sender: { id: 'user-1' },
        content: 'hello',
        roomId: undefined,
        type: MessageType.NORMAL,
      });
      expect(repo.save).toHaveBeenCalledWith(msg);
      expect(repo.findOneOrFail).toHaveBeenCalledWith({
        where: { id: msg.id },
      });
      expect(result).toBe(msg);
    });

    it('should save a INVITE message with roomId', async () => {
      const msg = {
        id: 'uuid-2',
        content: 'join me',
        type: MessageType.INVITE,
        sender: { id: 'user-1' },
        roomId: 'room-42',
        createdAt: new Date(),
      } as unknown as ChatMessage;

      repo.create.mockReturnValue(msg);
      repo.save.mockResolvedValue(msg);
      repo.findOneOrFail.mockResolvedValue(msg);

      const result = await service.saveMessage(
        'user-1',
        'join me',
        'room-42',
        MessageType.INVITE,
      );
      expect(repo.create).toHaveBeenCalledWith({
        sender: { id: 'user-1' },
        content: 'join me',
        roomId: 'room-42',
        type: MessageType.INVITE,
      });
      expect(result.type).toBe(MessageType.INVITE);
    });
  });

  describe('getHistory', () => {
    it('should return up to 50 messages with sanitized sender fields', async () => {
      const sender = {
        id: 'user-1',
        nickname: 'Alice',
        avatar: 'avatar.png',
        password: 'secret',
        email: 'a@b.com',
      };
      const msgs = [
        {
          id: 'uuid-1',
          content: 'hi',
          roomId: null,
          type: MessageType.NORMAL,
          createdAt: new Date(),
          sender,
        },
      ] as unknown as ChatMessage[];
      repo.find.mockResolvedValue(msgs);

      const result = await service.getHistory();
      expect(repo.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
        take: 50,
      });
      expect(result[0].sender).toEqual({
        id: 'user-1',
        nickname: 'Alice',
        avatar: 'avatar.png',
      });
      expect((result[0].sender as any).password).toBeUndefined();
      expect((result[0].sender as any).email).toBeUndefined();
    });
  });
});
