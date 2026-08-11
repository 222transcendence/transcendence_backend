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
import { MatchParticipant } from './entities/match-participant.entity';
import { GameRoom, RoomStatus } from './game.interface';
import { randomUUID } from 'crypto';

const ROOM_TTL = 7200;

@Injectable()
export class GameService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(MatchHistory)
    private readonly matchHistoryRepository: Repository<MatchHistory>,
    @InjectRepository(MatchParticipant)
    private readonly participantRepository: Repository<MatchParticipant>,
    private readonly redisService: RedisService,
  ) {}

  // ─── 로비 룸 관리 ──────────────────────────────────────────────────────────

  async createRoom(hostUserId: string, hostNickname: string, maxPlayers = 4): Promise<GameRoom> {
    if (maxPlayers < 2 || maxPlayers > 4) {
      throw new BadRequestException('maxPlayers must be between 2 and 4');
    }
    const hostUser = await this.userRepository.findOneBy({ id: hostUserId });
    if (!hostUser) throw new NotFoundException('Host user not found');

    const roomId = randomUUID();
    const room: GameRoom = {
      id: roomId,
      hostUserId,
      maxPlayers,
      status: RoomStatus.WAITING,
      players: [{ userId: hostUserId, nickname: hostNickname, avatar: hostUser.avatar, ready: false }],
      createdAt: new Date().toISOString(),
    };
    await this.redisService.set(`game:room:${roomId}`, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  async joinRoom(roomId: string, userId: string, nickname: string): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) throw new NotFoundException('Game room not found');

    const room = JSON.parse(data) as GameRoom;
    if (room.status !== RoomStatus.WAITING) throw new BadRequestException('Room is not in WAITING status');
    if (room.players.length >= room.maxPlayers) throw new BadRequestException('Room is already full');
    if (room.players.some((p) => p.userId === userId)) throw new BadRequestException('Already in this room');

    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');

    room.players.push({ userId, nickname, avatar: user.avatar, ready: false });
    await this.redisService.set(roomKey, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  async leaveRoom(roomId: string, userId: string): Promise<GameRoom | null> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) return null;

    const room = JSON.parse(data) as GameRoom;
    room.players = room.players.filter((p) => p.userId !== userId);
    await this.userRepository.update(userId, { status: UserStatus.ONLINE });

    if (room.players.length === 0) {
      await this.redisService.getClient().del(roomKey);
      return null;
    }
    if (room.hostUserId === userId) {
      room.hostUserId = room.players[0].userId;
      room.players[0].ready = false;
    }
    await this.redisService.set(roomKey, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  async setReady(roomId: string, userId: string, ready: boolean): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) throw new NotFoundException('Game room not found');

    const room = JSON.parse(data) as GameRoom;
    const player = room.players.find((p) => p.userId === userId);
    if (!player) throw new BadRequestException('User is not in this room');
    if (ready && room.players.length < 2) {
      throw new BadRequestException('Need at least 2 players to be ready');
    }
    player.ready = ready;
    await this.redisService.set(roomKey, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  async getWaitingRooms(): Promise<GameRoom[]> {
    const client = this.redisService.getClient();
    const keys = await client.keys('game:room:*');
    const rooms: GameRoom[] = [];
    for (const key of keys) {
      const data = await this.redisService.get(key);
      if (data) {
        const room = JSON.parse(data) as GameRoom;
        if (room.status === RoomStatus.WAITING) rooms.push(room);
      }
    }
    return rooms;
  }

  async getRoom(roomId: string): Promise<GameRoom | null> {
    const data = await this.redisService.get(`game:room:${roomId}`);
    return data ? (JSON.parse(data) as GameRoom) : null;
  }

  async setRoomWithTTL(room: GameRoom): Promise<void> {
    await this.redisService.set(`game:room:${room.id}`, JSON.stringify(room), ROOM_TTL);
  }

  // ─── Stats & Leaderboard ───────────────────────────────────────────────────

  async getUserStats(userId: string) {
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const totalGames = user.wins + user.losses;
    return {
      wins: user.wins,
      losses: user.losses,
      totalGames,
      winRate: totalGames > 0 ? Math.round((user.wins / totalGames) * 100) / 100 : 0,
    };
  }

  /**
   * 유저의 전적 목록.
   * N인 매치(participants 사용)와 기존 2인 매치(hostUser/guestUser 사용) 모두 지원.
   */
  async getUserMatches(userId: string, page: number, limit: number) {
    // participants 테이블을 통해 이 유저가 참가한 매치 ID 조회
    const participantMatchIds = await this.participantRepository
      .createQueryBuilder('p')
      .select('p.matchId')
      .where('p.userId = :userId', { userId })
      .getRawMany<{ p_matchId: string }>();

    const matchIds = participantMatchIds.map((r) => r.p_matchId);

    // 구형 2인 매치(hostUser/guestUser)로 참가한 것 포함해 union where
    const qb = this.matchHistoryRepository
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.hostUser', 'hostUser')
      .leftJoinAndSelect('m.guestUser', 'guestUser')
      .leftJoinAndSelect('m.winner', 'winner')
      .leftJoinAndSelect('m.participants', 'participants')
      .leftJoinAndSelect('participants.user', 'participantUser')
      .orderBy('m.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (matchIds.length > 0) {
      qb.where(
        '(m.id IN (:...matchIds) OR m.hostUserId = :userId OR m.guestUserId = :userId)',
        { matchIds, userId },
      );
    } else {
      qb.where('(m.hostUserId = :userId OR m.guestUserId = :userId)', { userId });
    }

    const [matches, total] = await qb.getManyAndCount();

    const safeUser = (u: User | null | undefined) =>
      u ? { id: u.id, nickname: u.nickname, avatar: u.avatar } : null;

    return {
      matches: matches.map((m) => ({
        id: m.id,
        // N인 매치는 participants, 구형은 hostUser/guestUser
        participants: m.participants?.map((p) => ({
          user: safeUser(p.user),
          finalHp: p.finalHp,
          rank: p.rank,
        })) ?? [],
        // 하위호환 필드 (구형 2인 매치에만 존재)
        hostUser: safeUser(m.hostUser),
        guestUser: safeUser(m.guestUser),
        winner: safeUser(m.winner),
        roundsPlayed: m.roundsPlayed,
        matchData: m.matchData,
        createdAt: m.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  async getLeaderboard() {
    const users = await this.userRepository.find({
      order: { wins: 'DESC', losses: 'ASC' },
    });
    return users.slice(0, 50).map((u) => {
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
