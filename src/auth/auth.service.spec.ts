import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { UserService } from '../user/user.service';
import { JwtService } from '@nestjs/jwt';
import { RedisService } from '../redis/redis.service';

describe('AuthService', () => {
  let service: AuthService;

  const mockUserService = {
    findByEmail: jest.fn(),
    findByNickname: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  };
  const mockJwtService = { sign: jest.fn(), verify: jest.fn() };
  const mockRedisService = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UserService, useValue: mockUserService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('validateOrCreateFtUser', () => {
    it('should return existing user found by email', async () => {
      const existing = { id: 'uuid', email: 'u@42.fr', nickname: 'u' };
      mockUserService.findByEmail.mockResolvedValue(existing);

      const result = await service.validateOrCreateFtUser({ email: 'u@42.fr', username: 'u', avatar: 'a.png' });

      expect(result).toEqual(existing);
      expect(mockUserService.create).not.toHaveBeenCalled();
    });

    it('should create new user when email not found and nickname is unique', async () => {
      const created = { id: 'uuid', email: 'new@42.fr', nickname: 'newuser', avatar: 'a.png' };
      mockUserService.findByEmail.mockResolvedValue(null);
      mockUserService.findByNickname.mockResolvedValue(null);
      mockUserService.create.mockResolvedValue(created);

      const result = await service.validateOrCreateFtUser({ email: 'new@42.fr', username: 'newuser', avatar: 'a.png' });

      expect(result).toEqual(created);
      expect(mockUserService.create).toHaveBeenCalledWith({ email: 'new@42.fr', nickname: 'newuser', avatar: 'a.png' });
    });

    it('should append random suffix when nickname already taken', async () => {
      const created = { id: 'uuid', email: 'dup@42.fr', nickname: 'taken_123', avatar: 'a.png' };
      mockUserService.findByEmail.mockResolvedValue(null);
      mockUserService.findByNickname.mockResolvedValue({ id: 'other' });
      mockUserService.create.mockResolvedValue(created);

      const result = await service.validateOrCreateFtUser({ email: 'dup@42.fr', username: 'taken', avatar: 'a.png' });

      expect(result).toBeDefined();
      expect(mockUserService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'dup@42.fr', nickname: expect.stringMatching(/^taken_\d+$/) }),
      );
    });
  });
});
