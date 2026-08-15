import { Test, TestingModule } from '@nestjs/testing';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { RedisService } from '../redis/redis.service';
import { User, UserStatus } from './entities/user.entity';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

const mockUser: User = {
  id: 'uuid-1234',
  email: 'test@example.com',
  nickname: 'tester',
  password: 'hashedpassword',
  avatar: 'default_avatar.png',
  status: UserStatus.OFFLINE,
  wins: 0,
  losses: 0,
  draws: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('UserController', () => {
  let controller: UserController;
  let service: UserService;

  const mockUserService = {
    findOne: jest.fn(),
    findByNickname: jest.fn(),
    update: jest.fn(),
  };
  const mockRedisService = { set: jest.fn(), get: jest.fn().mockResolvedValue(null), del: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: mockUserService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
    service = module.get<UserService>(UserService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getMe', () => {
    it('should return own profile excluding password', async () => {
      const result = await controller.getMe(mockUser);
      expect(result.data).not.toHaveProperty('password');
      expect(result.data.id).toBe(mockUser.id);
      expect(result.data.email).toBe(mockUser.email);
    });
  });

  describe('getUser', () => {
    it('should return public profile excluding password and email', async () => {
      mockUserService.findOne.mockResolvedValue(mockUser);

      const result = await controller.getUser('uuid-1234');
      expect(service.findOne).toHaveBeenCalledWith('uuid-1234');
      expect(result.data).not.toHaveProperty('password');
      expect(result.data).not.toHaveProperty('email');
      expect(result.data.id).toBe(mockUser.id);
      expect(result.data.nickname).toBe(mockUser.nickname);
    });

    it('should propagate NotFoundException if user does not exist', async () => {
      mockUserService.findOne.mockRejectedValue(new NotFoundException());

      await expect(controller.getUser('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateMe', () => {
    it('should successfully update own profile', async () => {
      const updateDto = { nickname: 'newname', avatar: 'newavatar.png' };
      const updatedUser = { ...mockUser, ...updateDto };
      mockUserService.findByNickname.mockResolvedValue(null);
      mockUserService.update.mockResolvedValue(updatedUser);

      const result = await controller.updateMe(mockUser, updateDto);
      expect(service.findByNickname).toHaveBeenCalledWith('newname');
      expect(service.update).toHaveBeenCalledWith(mockUser.id, updateDto);
      expect(result.data).not.toHaveProperty('password');
      expect(result.data.nickname).toBe('newname');
      expect(result.data.avatar).toBe('newavatar.png');
    });

    it('should throw ConflictException if nickname is already taken by another user', async () => {
      const updateDto = { nickname: 'alreadytaken' };
      const anotherUser = { ...mockUser, id: 'uuid-5678', nickname: 'alreadytaken' };
      mockUserService.findByNickname.mockResolvedValue(anotherUser);

      await expect(controller.updateMe(mockUser, updateDto)).rejects.toThrow(ConflictException);
      expect(service.update).not.toHaveBeenCalled();
    });

    it('should allow nickname if it belongs to the current user itself', async () => {
      const updateDto = { nickname: 'tester' };
      mockUserService.findByNickname.mockResolvedValue(mockUser);
      mockUserService.update.mockResolvedValue(mockUser);

      const result = await controller.updateMe(mockUser, updateDto);
      expect(service.findByNickname).toHaveBeenCalledWith('tester');
      expect(service.update).toHaveBeenCalledWith(mockUser.id, updateDto);
      expect(result.data.nickname).toBe('tester');
    });

    it('should reset avatar to the default instead of forwarding null (#203)', async () => {
      const updateDto = { avatar: null };
      const updatedUser = { ...mockUser, avatar: 'default_avatar.png' };
      mockUserService.update.mockResolvedValue(updatedUser);

      const result = await controller.updateMe(mockUser, updateDto);
      expect(service.update).toHaveBeenCalledWith(mockUser.id, {
        avatar: 'default_avatar.png',
      });
      expect(result.data.avatar).toBe('default_avatar.png');
    });
  });

  describe('uploadAvatar', () => {
    const mockFile = {
      filename: 'generated-uuid.png',
    } as Express.Multer.File;

    it('should upload avatar and return updated profile excluding password', async () => {
      const updatedUser = { ...mockUser, avatar: '/uploads/avatars/generated-uuid.png' };
      mockUserService.update.mockResolvedValue(updatedUser);

      const result = await controller.uploadAvatar(mockUser, mockFile);

      expect(service.update).toHaveBeenCalledWith(mockUser.id, {
        avatar: '/uploads/avatars/generated-uuid.png',
      });
      expect(result.data).not.toHaveProperty('password');
      expect(result.data.avatar).toBe('/uploads/avatars/generated-uuid.png');
    });

    it('should throw BadRequestException when no file is provided', async () => {
      await expect(
        controller.uploadAvatar(mockUser, undefined as unknown as Express.Multer.File),
      ).rejects.toThrow(BadRequestException);
      expect(service.update).not.toHaveBeenCalled();
    });
  });
});
