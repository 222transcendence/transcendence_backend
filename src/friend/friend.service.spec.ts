import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { FriendService } from './friend.service';
import { Friend, FriendStatus } from './entities/friend.entity';
import { User, UserStatus } from '../user/entities/user.entity';
import { RedisService } from '../redis/redis.service';

describe('FriendService', () => {
  let service: FriendService;
  let friendRepository: Repository<Friend>;
  let userRepository: Repository<User>;
  let redisService: RedisService;

  const userA: User = {
    id: 'user-a',
    email: 'a@test.com',
    nickname: 'userA',
    avatar: 'default_avatar.png',
    status: UserStatus.ONLINE,
    wins: 0,
    losses: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const userB: User = {
    id: 'user-b',
    email: 'b@test.com',
    nickname: 'userB',
    avatar: 'default_avatar.png',
    status: UserStatus.OFFLINE,
    wins: 0,
    losses: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FriendService,
        {
          provide: getRepositoryToken(Friend),
          useValue: {
            create: jest.fn(),
            save: jest.fn(),
            findOne: jest.fn(),
            find: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<FriendService>(FriendService);
    friendRepository = module.get<Repository<Friend>>(
      getRepositoryToken(Friend),
    );
    userRepository = module.get<Repository<User>>(getRepositoryToken(User));
    redisService = module.get<RedisService>(RedisService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('sendFriendRequest should create request', async () => {
    jest
      .spyOn(userRepository, 'findOne')
      .mockResolvedValueOnce(userA)
      .mockResolvedValueOnce(userB);
    jest.spyOn(friendRepository, 'findOne').mockResolvedValue(null);
    const created = {
      id: 'req-1',
      requester: userA,
      receiver: userB,
      status: FriendStatus.PENDING,
    } as Friend;
    jest.spyOn(friendRepository, 'create').mockReturnValue(created);
    jest.spyOn(friendRepository, 'save').mockResolvedValue(created);

    const result = await service.sendFriendRequest('user-a', 'user-b');

    expect(result.status).toBe(FriendStatus.PENDING);
  });

  it('sendFriendRequest should fail for self request', async () => {
    await expect(service.sendFriendRequest('user-a', 'user-a')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('sendFriendRequest should fail when user does not exist', async () => {
    jest
      .spyOn(userRepository, 'findOne')
      .mockResolvedValueOnce(userA)
      .mockResolvedValueOnce(null);

    await expect(
      service.sendFriendRequest('user-a', 'missing'),
    ).rejects.toThrow(NotFoundException);
  });

  it('sendFriendRequest should fail for duplicate pending relation including reverse direction', async () => {
    jest
      .spyOn(userRepository, 'findOne')
      .mockResolvedValueOnce(userA)
      .mockResolvedValueOnce(userB);
    jest.spyOn(friendRepository, 'findOne').mockResolvedValue({
      id: 'req-1',
      requester: userB,
      receiver: userA,
      status: FriendStatus.PENDING,
    } as Friend);

    await expect(service.sendFriendRequest('user-a', 'user-b')).rejects.toThrow(
      ConflictException,
    );
  });

  it('respondFriendRequest should accept request', async () => {
    const request = {
      id: 'req-1',
      requester: userA,
      receiver: userB,
      status: FriendStatus.PENDING,
    } as Friend;

    jest.spyOn(friendRepository, 'findOne').mockResolvedValue(request);
    jest.spyOn(friendRepository, 'save').mockResolvedValue({
      ...request,
      status: FriendStatus.ACCEPTED,
    });

    const result = await service.respondFriendRequest(
      'user-b',
      'req-1',
      'accept',
    );
    expect((result as Friend).status).toBe(FriendStatus.ACCEPTED);
  });

  it('respondFriendRequest should reject request by deleting row', async () => {
    const request = {
      id: 'req-1',
      requester: userA,
      receiver: userB,
      status: FriendStatus.PENDING,
    } as Friend;

    jest.spyOn(friendRepository, 'findOne').mockResolvedValue(request);
    const removeSpy = jest
      .spyOn(friendRepository, 'remove')
      .mockResolvedValue(request);

    const result = await service.respondFriendRequest(
      'user-b',
      'req-1',
      'reject',
    );
    expect(result).toEqual({ deleted: true });
    expect(removeSpy).toHaveBeenCalledWith(request);
  });

  it('respondFriendRequest should fail for unauthorized user', async () => {
    const request = {
      id: 'req-1',
      requester: userA,
      receiver: userB,
      status: FriendStatus.PENDING,
    } as Friend;
    jest.spyOn(friendRepository, 'findOne').mockResolvedValue(request);

    await expect(
      service.respondFriendRequest('user-a', 'req-1', 'accept'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('removeFriend should remove accepted relation', async () => {
    const accepted = {
      id: 'f-1',
      requester: userA,
      receiver: userB,
      status: FriendStatus.ACCEPTED,
    } as Friend;

    jest.spyOn(friendRepository, 'findOne').mockResolvedValue(accepted);
    jest.spyOn(friendRepository, 'remove').mockResolvedValue(accepted);

    await expect(
      service.removeFriend('user-a', 'user-b'),
    ).resolves.toBeUndefined();
  });

  it('getFriends should return friend list with online status', async () => {
    const accepted = {
      id: 'f-1',
      requester: userA,
      receiver: userB,
      status: FriendStatus.ACCEPTED,
    } as Friend;

    jest.spyOn(friendRepository, 'find').mockResolvedValue([accepted]);

    const result = await service.getFriends('user-a');

    expect(result).toEqual([
      {
        id: 'user-b',
        nickname: 'userB',
        avatar: userB.avatar,
        status: UserStatus.OFFLINE,
      },
    ]);
  });

  it('getFriends should report IN_GAME from DB status even if Redis presence says ONLINE', async () => {
    const inGameUserB = { ...userB, status: UserStatus.IN_GAME };
    const accepted = {
      id: 'f-1',
      requester: userA,
      receiver: inGameUserB,
      status: FriendStatus.ACCEPTED,
    } as Friend;

    jest.spyOn(friendRepository, 'find').mockResolvedValue([accepted]);
    jest.spyOn(redisService, 'get').mockResolvedValue(UserStatus.ONLINE);

    const result = await service.getFriends('user-a');

    expect(result).toEqual([
      {
        id: 'user-b',
        nickname: 'userB',
        avatar: userB.avatar,
        status: UserStatus.IN_GAME,
      },
    ]);
  });
});
