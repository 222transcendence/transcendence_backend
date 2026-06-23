import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GameService } from './game.service';
import { RedisService } from '../redis/redis.service';
import { User, UserStatus } from '../user/entities/user.entity';
import { Character } from './entities/character.entity';
import { Card } from './entities/card.entity';
import { MatchHistory } from './entities/match-history.entity';
import { RoomStatus, GamePhase } from './game.interface';

describe('GameService', () => {
  let service: GameService;
  let redisStore: Record<string, string>;

  const mockUserRepository = {
    findOneBy: jest.fn(),
    save: jest.fn(),
  };

  const mockCharacterRepository = {
    findOneBy: jest.fn(),
  };

  const mockCardRepository = {
    findOneBy: jest.fn(),
  };

  const mockMatchHistoryRepository = {
    create: jest.fn().mockImplementation((dto: any): unknown => dto),
    save: jest.fn(),
  };

  const mockRedisService = {
    set: jest
      .fn()
      .mockImplementation((key: string, value: string): Promise<void> => {
        redisStore[key] = value;
        return Promise.resolve();
      }),
    get: jest.fn().mockImplementation((key: string): Promise<string | null> => {
      return Promise.resolve(redisStore[key] || null);
    }),
    getClient: jest.fn().mockReturnValue({
      keys: jest.fn().mockImplementation((): Promise<string[]> => {
        return Promise.resolve(Object.keys(redisStore));
      }),
    }),
  };

  beforeEach(async () => {
    redisStore = {};
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GameService,
        {
          provide: getRepositoryToken(User),
          useValue: mockUserRepository,
        },
        {
          provide: getRepositoryToken(Character),
          useValue: mockCharacterRepository,
        },
        {
          provide: getRepositoryToken(Card),
          useValue: mockCardRepository,
        },
        {
          provide: getRepositoryToken(MatchHistory),
          useValue: mockMatchHistoryRepository,
        },
        {
          provide: RedisService,
          useValue: mockRedisService,
        },
      ],
    }).compile();

    service = module.get<GameService>(GameService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('createRoom', () => {
    it('should create a room in WAITING status and update user status to IN_GAME', async () => {
      const mockUser = { id: 'user-1', status: UserStatus.ONLINE } as User;
      mockUserRepository.findOneBy.mockResolvedValue(mockUser);
      mockUserRepository.save.mockResolvedValue({
        ...mockUser,
        status: UserStatus.IN_GAME,
      });

      const room = await service.createRoom('user-1', 'host-nick', 1);

      expect(room).toBeDefined();
      expect(room.status).toBe(RoomStatus.WAITING);
      expect(room.host.userId).toBe('user-1');
      expect(room.host.nickname).toBe('host-nick');
      expect(mockUserRepository.save).toHaveBeenCalled();
    });
  });

  describe('joinRoom', () => {
    it('should join the room, transition status to IN_GAME/MOVE, and deal cards', async () => {
      const guestUser = { id: 'guest-1', status: UserStatus.ONLINE } as User;

      // Mock WAITING room setup
      const initialRoom = {
        id: 'room-123',
        status: RoomStatus.WAITING,
        host: {
          userId: 'host-1',
          nickname: 'host-nick',
          characterId: 1,
          hp: 20,
          cardsInHand: [],
          cardsSubmitted: [],
        },
        distance: 3,
        currentTurn: 1,
        statusEffects: { host: [], guest: [] },
      };
      redisStore['game:room:room-123'] = JSON.stringify(initialRoom);

      mockUserRepository.findOneBy.mockResolvedValue(guestUser);
      mockUserRepository.save.mockResolvedValue({
        ...guestUser,
        status: UserStatus.IN_GAME,
      });

      const updatedRoom = await service.joinRoom(
        'room-123',
        'guest-1',
        'guest-nick',
        2,
      );

      expect(updatedRoom.status).toBe(RoomStatus.IN_GAME);
      expect(updatedRoom.phase).toBe(GamePhase.MOVE);
      expect(updatedRoom.guest).toBeDefined();
      expect(updatedRoom.guest?.userId).toBe('guest-1');
      expect(updatedRoom.host.cardsInHand.length).toBe(5);
      expect(updatedRoom.guest?.cardsInHand.length).toBe(5);
    });
  });
});
