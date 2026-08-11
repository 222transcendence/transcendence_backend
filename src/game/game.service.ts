import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RedisService } from '../redis/redis.service';
import { User, UserStatus } from '../user/entities/user.entity';
import { MatchHistory } from './entities/match-history.entity';
import { GameRoom, RoomStatus } from './game.interface';
import { randomUUID } from 'crypto';

@Injectable()
export class GameService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(MatchHistory)
    private readonly matchHistoryRepository: Repository<MatchHistory>,
    private readonly redisService: RedisService,
  ) {}

  // ─── 로비 룸 관리 (LobbyGateway가 의존하는 범용 로직) ──────────────────────
  // 산성비(Acid Rain) 전환으로 캐릭터/카드 개념은 없음 (GAME_DESIGN.md §5).
  // 매치 시작은 두 플레이어의 SET_READY 이후 게임 게이트웨이(#74)가 처리한다.

  /**
   * 방 생성 (Host)
   */
  async createRoom(
    hostUserId: string,
    hostNickname: string,
  ): Promise<GameRoom> {
    const roomId = randomUUID();
    const roomKey = `game:room:${roomId}`;

    const hostUser = await this.userRepository.findOneBy({ id: hostUserId });
    if (!hostUser) throw new NotFoundException('Host user not found');
    hostUser.status = UserStatus.IN_GAME;
    await this.userRepository.save(hostUser);

    const room: GameRoom = {
      id: roomId,
      status: RoomStatus.WAITING,
      host: { userId: hostUserId, nickname: hostNickname, ready: false },
      createdAt: new Date().toISOString(),
    };

    await this.redisService.set(roomKey, JSON.stringify(room), 7200);
    return room;
  }

  /**
   * 방 입장 (Guest). 게임은 양쪽 SET_READY 이후 시작되므로 상태는 WAITING을 유지한다.
   */
  async joinRoom(
    roomId: string,
    guestUserId: string,
    guestNickname: string,
  ): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const roomData = await this.redisService.get(roomKey);
    if (!roomData) throw new NotFoundException('Game room not found');

    const room = JSON.parse(roomData) as GameRoom;
    if (room.status !== RoomStatus.WAITING) {
      throw new BadRequestException('Room is not in WAITING status');
    }
    if (room.guest) {
      throw new BadRequestException('Room is already full');
    }
    if (room.host.userId === guestUserId) {
      throw new BadRequestException('Cannot join your own room');
    }

    const guestUser = await this.userRepository.findOneBy({ id: guestUserId });
    if (!guestUser) throw new NotFoundException('Guest user not found');
    guestUser.status = UserStatus.IN_GAME;
    await this.userRepository.save(guestUser);

    room.guest = { userId: guestUserId, nickname: guestNickname, ready: false };

    await this.redisService.set(roomKey, JSON.stringify(room), 7200);
    return room;
  }

  /**
   * 대기 중인 방 목록 조회
   */
  async getWaitingRooms(): Promise<GameRoom[]> {
    const client = this.redisService.getClient();
    const keys = await client.keys('game:room:*');
    const rooms: GameRoom[] = [];

    for (const key of keys) {
      const data = await this.redisService.get(key);
      if (data) {
        const room = JSON.parse(data) as GameRoom;
        if (room.status === RoomStatus.WAITING) {
          rooms.push(room);
        }
      }
    }
    return rooms;
  }

  async getRoom(roomId: string): Promise<GameRoom | null> {
    const data = await this.redisService.get(`game:room:${roomId}`);
    return data ? (JSON.parse(data) as GameRoom) : null;
  }

  async setRoomWithTTL(room: GameRoom): Promise<void> {
    await this.redisService.set(
      `game:room:${room.id}`,
      JSON.stringify(room),
      7200, // 2시간 TTL (#23)
    );
  }

  /**
   * Host leaves → delete room. Guest leaves → remove guest from room.
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) return;

    const room = JSON.parse(data) as GameRoom;

    if (room.host.userId === userId) {
      await this.redisService.getClient().del(roomKey);
      await this.userRepository.update(userId, { status: UserStatus.ONLINE });
    } else if (room.guest?.userId === userId) {
      room.guest = undefined;
      await this.redisService.set(roomKey, JSON.stringify(room), 7200);
      await this.userRepository.update(userId, { status: UserStatus.ONLINE });
    }
  }

  /**
   * Toggle ready flag for host or guest. Both ready → status stays WAITING until game gateway starts.
   */
  async setReady(
    roomId: string,
    userId: string,
    ready: boolean,
  ): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) throw new NotFoundException('Game room not found');

    const room = JSON.parse(data) as GameRoom;

    if (room.host.userId === userId) {
      room.host.ready = ready;
    } else if (room.guest?.userId === userId) {
      room.guest.ready = ready;
    } else {
      throw new BadRequestException('User is not in this room');
    }

    await this.redisService.set(roomKey, JSON.stringify(room), 7200);
    return room;
  }

  // ─── #21 Stats & Leaderboard ────────────────────────────────────────────

  async getUserStats(userId: string) {
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const totalGames = user.wins + user.losses;
    return {
      wins: user.wins,
      losses: user.losses,
      totalGames,
      winRate:
        totalGames > 0 ? Math.round((user.wins / totalGames) * 100) / 100 : 0,
    };
  }

  async getUserMatches(userId: string, page: number, limit: number) {
    const [matches, total] = await this.matchHistoryRepository.findAndCount({
      where: [{ hostUser: { id: userId } }, { guestUser: { id: userId } }],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const safeUser = (u: User | null) =>
      u ? { id: u.id, nickname: u.nickname, avatar: u.avatar } : null;
    const mapped = matches.map((m) => ({
      id: m.id,
      hostUser: safeUser(m.hostUser),
      guestUser: safeUser(m.guestUser),
      winner: safeUser(m.winner),
      roundsPlayed: m.roundsPlayed,
      matchData: m.matchData,
      createdAt: m.createdAt,
    }));
    return { matches: mapped, total, page, limit };
  }

  async getLeaderboard() {
    const users = await this.userRepository.find({
      order: { wins: 'DESC', losses: 'ASC' },
    });
    return users
      .slice(0, 50)
      .map((u) => {
        const totalGames = u.wins + u.losses;
        return {
          id: u.id,
          nickname: u.nickname,
          avatar: u.avatar,
          wins: u.wins,
          losses: u.losses,
          totalGames,
          winRate: totalGames > 0 ? Math.round((u.wins / totalGames) * 100) / 100 : 0,
        };
      });
  }
}
