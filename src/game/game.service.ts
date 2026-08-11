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
import { GameRoom, PlayerSession, RoomStatus } from './game.interface';
import { MatchMode } from './entities/match-history.entity';
import { randomUUID } from 'crypto';

const ROOM_TTL = 7200;

@Injectable()
export class GameService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(MatchHistory)
    private readonly matchHistoryRepository: Repository<MatchHistory>,
    private readonly redisService: RedisService,
  ) {}

  // ─── 로비 룸 관리 ──────────────────────────────────────────────────────────

  async createRoom(
    hostUserId: string,
    hostNickname: string,
    maxPlayers = 4,
  ): Promise<GameRoom> {
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
      players: [
        {
          userId: hostUserId,
          nickname: hostNickname,
          avatar: hostUser.avatar,
          ready: false,
        },
      ],
      createdAt: new Date().toISOString(),
    };

    await this.redisService.set(`game:room:${roomId}`, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  async joinRoom(
    roomId: string,
    userId: string,
    nickname: string,
  ): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) throw new NotFoundException('Game room not found');

    const room = JSON.parse(data) as GameRoom;

    if (room.status !== RoomStatus.WAITING) {
      throw new BadRequestException('Room is not in WAITING status');
    }
    if (room.players.length >= room.maxPlayers) {
      throw new BadRequestException('Room is already full');
    }
    if (room.players.some((p) => p.userId === userId)) {
      throw new BadRequestException('Already in this room');
    }

    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');

    room.players.push({ userId, nickname, avatar: user.avatar, ready: false });
    await this.redisService.set(roomKey, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  /**
   * 퇴장 처리:
   * - 호스트가 나가면 다음 플레이어가 호스트로 승격 (있는 경우), 없으면 방 삭제
   * - 일반 참가자가 나가면 players 배열에서 제거
   * @returns 갱신된 room (남은 플레이어 있을 때) 또는 null (방 삭제)
   */
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

    // 호스트가 나갔으면 첫 번째 남은 플레이어로 승격
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

    // 최소 2명 미만이면 ready 불가
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

  // ─── #21 Stats & Leaderboard ────────────────────────────────────────────

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

  async getUserMatches(userId: string, page: number, limit: number, mode?: MatchMode) {
    const baseWhere = mode
      ? [
          { hostUser: { id: userId }, mode },
          { guestUser: { id: userId }, mode },
        ]
      : [
          { hostUser: { id: userId } },
          { guestUser: { id: userId } },
        ];
    const [matches, total] = await this.matchHistoryRepository.findAndCount({
      where: baseWhere,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    const safeUser = (u: User | null) =>
      u ? { id: u.id, nickname: u.nickname, avatar: u.avatar } : null;

    return {
      matches: matches.map((m) => ({
        id: m.id,
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
