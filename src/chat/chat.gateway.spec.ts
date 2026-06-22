import { Test, TestingModule } from '@nestjs/testing';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';
import { JwtService } from '@nestjs/jwt';
import { UserService } from '../user/user.service';
import { MessageType } from './entities/chat-message.entity';
import { WsException } from '@nestjs/websockets';

describe('ChatGateway', () => {
  let gateway: ChatGateway;
  let chatService: ChatService;
  let jwtService: JwtService;
  let userService: UserService;

  const mockChatService = {
    saveMessage: jest.fn(),
    getHistory: jest.fn(),
  };
  const mockJwtService = { verify: jest.fn() };
  const mockUserService = { findOne: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatGateway,
        { provide: ChatService, useValue: mockChatService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: UserService, useValue: mockUserService },
      ],
    }).compile();

    gateway = module.get<ChatGateway>(ChatGateway);
    chatService = module.get<ChatService>(ChatService);
    jwtService = module.get<JwtService>(JwtService);
    userService = module.get<UserService>(UserService);

    // mock server
    gateway.server = { emit: jest.fn() } as any;
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    it('should authenticate and store user on valid token', async () => {
      const mockSocket = {
        id: 'socket-1',
        handshake: { auth: { token: 'Bearer valid.jwt.token' }, query: {} },
        data: {},
        disconnect: jest.fn(),
      } as any;

      const mockUser = { id: 'user-1', nickname: 'Alice' };
      mockJwtService.verify.mockReturnValue({ sub: 'user-1' });
      mockUserService.findOne.mockResolvedValue(mockUser);

      await gateway.handleConnection(mockSocket);

      expect(mockJwtService.verify).toHaveBeenCalledWith('valid.jwt.token', expect.any(Object));
      expect(mockSocket.data.user).toBe(mockUser);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('should disconnect client on invalid token', async () => {
      const mockSocket = {
        id: 'socket-2',
        handshake: { auth: { token: 'Bearer bad.token' }, query: {} },
        data: {},
        disconnect: jest.fn(),
      } as any;

      mockJwtService.verify.mockImplementation(() => {
        throw new Error('invalid');
      });

      await gateway.handleConnection(mockSocket);
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });

    it('should disconnect when no token provided', async () => {
      const mockSocket = {
        id: 'socket-3',
        handshake: { auth: {}, query: {} },
        data: {},
        disconnect: jest.fn(),
      } as any;

      await gateway.handleConnection(mockSocket);
      expect(mockSocket.disconnect).toHaveBeenCalled();
    });
  });

  describe('handleMessage', () => {
    it('should save and broadcast message', async () => {
      const mockUser = { id: 'user-1', nickname: 'Alice', avatar: 'avatar.png' };
      const mockSocket = { data: { user: mockUser } } as any;

      const savedMessage = {
        id: 'msg-1',
        sender: mockUser,
        content: 'Hello World',
        roomId: undefined,
        type: MessageType.NORMAL,
        createdAt: new Date(),
      };

      mockChatService.saveMessage.mockResolvedValue(savedMessage);

      const dto = { content: 'Hello World', type: MessageType.NORMAL };
      await gateway.handleMessage(mockSocket, dto);

      expect(mockChatService.saveMessage).toHaveBeenCalledWith(
        'user-1',
        'Hello World',
        undefined,
        MessageType.NORMAL,
      );
      expect(gateway.server.emit).toHaveBeenCalledWith(
        'receive_message',
        expect.objectContaining({ content: 'Hello World' }),
      );
    });

    it('should throw WsException if user not set', async () => {
      const mockSocket = { data: {} } as any;
      const dto = { content: 'Hello' };

      await expect(
        gateway.handleMessage(mockSocket, dto as any),
      ).rejects.toThrow(WsException);
    });
  });
});
