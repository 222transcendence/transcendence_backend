import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserService } from './user.service';
import { User, UserStatus } from './entities/user.entity';
import { NotFoundException } from '@nestjs/common';

const mockUser = {
  id: 'uuid-1234',
  email: 'test@example.com',
  nickname: 'tester',
  password: 'hashedpassword',
  avatar: 'default_avatar.png',
  status: UserStatus.OFFLINE,
  wins: 0,
  losses: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('UserService', () => {
  let service: UserService;
  let repository: Repository<User>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            create: jest.fn().mockImplementation((dto) => dto),
            save: jest.fn().mockImplementation((user) => Promise.resolve({ id: 'uuid-1234', ...user })),
            find: jest.fn().mockResolvedValue([mockUser]),
            findOne: jest.fn().mockImplementation((options) => {
              const id = options.where?.id;
              const email = options.where?.email;
              if (id === 'uuid-1234' || email === 'test@example.com') {
                return Promise.resolve(mockUser);
              }
              return Promise.resolve(null);
            }),
            remove: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    repository = module.get<Repository<User>>(getRepositoryToken(User));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a new user', async () => {
      const dto = { email: 'test@example.com', nickname: 'tester', password: 'hashedpassword' };
      const result = await service.create(dto);
      expect(repository.create).toHaveBeenCalledWith(dto);
      expect(repository.save).toHaveBeenCalled();
      expect(result).toHaveProperty('id', 'uuid-1234');
      expect(result.email).toBe(dto.email);
    });
  });

  describe('findAll', () => {
    it('should return an array of users', async () => {
      const result = await service.findAll();
      expect(repository.find).toHaveBeenCalled();
      expect(result).toEqual([mockUser]);
    });
  });

  describe('findOne', () => {
    it('should return a user if found', async () => {
      const result = await service.findOne('uuid-1234');
      expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'uuid-1234' } });
      expect(result).toEqual(mockUser);
    });

    it('should throw NotFoundException if user is not found', async () => {
      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByEmail', () => {
    it('should return a user by email', async () => {
      const result = await service.findByEmail('test@example.com');
      expect(repository.findOne).toHaveBeenCalledWith({ where: { email: 'test@example.com' } });
      expect(result).toEqual(mockUser);
    });

    it('should return null if user by email is not found', async () => {
      const result = await service.findByEmail('unknown@example.com');
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update a user details', async () => {
      const updateDto = { nickname: 'newnickname', status: UserStatus.ONLINE };
      const result = await service.update('uuid-1234', updateDto);
      expect(repository.save).toHaveBeenCalled();
      expect(result.nickname).toBe('newnickname');
      expect(result.status).toBe(UserStatus.ONLINE);
    });
  });

  describe('remove', () => {
    it('should remove the user', async () => {
      await service.remove('uuid-1234');
      expect(repository.remove).toHaveBeenCalled();
    });
  });
});
