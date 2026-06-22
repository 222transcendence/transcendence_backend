import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { FriendController } from '../src/friend/friend.controller';
import { FriendService } from '../src/friend/friend.service';
import { UserStatus } from '../src/user/entities/user.entity';

describe('FriendController (e2e-lite)', () => {
  let app: INestApplication<App>;

  const friendServiceMock = {
    sendFriendRequest: jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'PENDING' }),
    respondFriendRequest: jest
      .fn()
      .mockResolvedValue({ id: 'req-1', status: 'ACCEPTED' }),
    removeFriend: jest.fn().mockResolvedValue(undefined),
    getFriends: jest.fn().mockResolvedValue([
      {
        id: 'user-b',
        nickname: 'userB',
        status: UserStatus.ONLINE,
      },
    ]),
  };

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [FriendController],
      providers: [
        {
          provide: FriendService,
          useValue: friendServiceMock,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    await app.close();
  });

  it('GET /api/friends should require x-user-id header', () => {
    return request(app.getHttpServer()).get('/api/friends').expect(400);
  });

  it('GET /api/friends should return friend list', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/friends')
      .set('x-user-id', 'user-a')
      .expect(200);

    const friends = res.body as { status: UserStatus }[];
    expect(friends[0]?.status).toBe(UserStatus.ONLINE);
  });
});
