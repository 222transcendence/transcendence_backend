import { Test, TestingModule } from '@nestjs/testing';
import { FtStrategy } from './ft.strategy';
import { AuthService } from '../auth.service';

describe('FtStrategy', () => {
  let strategy: FtStrategy;

  const mockAuthService = {
    validateOrCreateFtUser: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FtStrategy,
        { provide: AuthService, useValue: mockAuthService },
      ],
    }).compile();

    strategy = module.get<FtStrategy>(FtStrategy);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(strategy).toBeDefined();
  });

  describe('validate', () => {
    it('should return user from authService with email and avatar from profile', async () => {
      const mockProfile = {
        username: 'testuser',
        emails: [{ value: 'testuser@student.42gyeongsan.kr' }],
        _json: { image: { link: 'http://cdn.42.fr/avatar.png' } },
      };
      const mockUser = { id: 'uuid', email: 'testuser@student.42gyeongsan.kr', nickname: 'testuser' };
      mockAuthService.validateOrCreateFtUser.mockResolvedValue(mockUser);

      const result = await strategy.validate('at', 'rt', mockProfile);

      expect(result).toEqual(mockUser);
      expect(mockAuthService.validateOrCreateFtUser).toHaveBeenCalledWith({
        email: 'testuser@student.42gyeongsan.kr',
        username: 'testuser',
        avatar: 'http://cdn.42.fr/avatar.png',
      });
    });

    it('should use fallback email and avatar when missing in profile', async () => {
      const mockProfile = { username: 'nomail', emails: [], _json: {} };
      const mockUser = { id: 'uuid2', email: 'nomail@student.42gyeongsan.kr', nickname: 'nomail' };
      mockAuthService.validateOrCreateFtUser.mockResolvedValue(mockUser);

      const result = await strategy.validate('at', 'rt', mockProfile);

      expect(result).toEqual(mockUser);
      expect(mockAuthService.validateOrCreateFtUser).toHaveBeenCalledWith({
        email: 'nomail@student.42gyeongsan.kr',
        username: 'nomail',
        avatar: 'default_avatar.png',
      });
    });
  });
});
