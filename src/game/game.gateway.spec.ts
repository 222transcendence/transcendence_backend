import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { GameGateway } from './game.gateway';
import { UserService } from '../user/user.service';

describe('GameGateway', () => {
  let gateway: GameGateway;

  const mockJwtService = { verify: jest.fn() };
  const mockUserService = { findOne: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameGateway,
        { provide: JwtService, useValue: mockJwtService },
        { provide: UserService, useValue: mockUserService },
      ],
    }).compile();

    gateway = module.get<GameGateway>(GameGateway);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(gateway).toBeDefined();
  });

  describe('handleConnection', () => {
    it('authenticates and stores user on a valid token', async () => {
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

      expect(mockJwtService.verify).toHaveBeenCalledWith(
        'valid.jwt.token',
        expect.any(Object),
      );
      expect(mockSocket.data.user).toBe(mockUser);
      expect(mockSocket.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects the client on an invalid token', async () => {
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

    it('disconnects the client when no token is provided', async () => {
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

  describe('handleDisconnect', () => {
    it('logs disconnect without throwing when no user was authenticated', () => {
      const mockSocket = { id: 'socket-4', data: {} } as any;

      expect(() => gateway.handleDisconnect(mockSocket)).not.toThrow();
    });
  });
});
