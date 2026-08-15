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
    @InjectRepository(MatchParticipant)
    private readonly participantRepository: Repository<MatchParticipant>,
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

    await this.redisService.set(
      `game:room:${roomId}`,
      JSON.stringify(room),
      ROOM_TTL,
    );
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
      return room; // 이미 방에 있으면 idempotent하게 현재 방 상태 반환
    }

    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');

    // #183: 다른 WAITING 방에 이미 참가 중이면 새 방 합류 전 그 방에서 먼저
    // 퇴장시킨다. 이 보장이 joinRoom() 내부에 있어야, 호출 경로(LobbyGateway든
    // 향후 다른 호출자든)와 무관하게 "유저는 최대 1개의 대기방에만 소속된다"는
    // 불변조건이 깨지지 않는다. IN_GAME/FINISHED 방은 대상에서 제외 —
    // AcidRainService 매치 세션과의 정합성 문제는 별도 이슈에서 다룬다.
    const otherWaitingRooms = await this.findWaitingRoomsForUser(
      userId,
      roomId,
    );
    for (const otherRoom of otherWaitingRooms) {
      await this.leaveRoom(otherRoom.id, userId);
    }

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

  async setReady(
    roomId: string,
    userId: string,
    ready: boolean,
  ): Promise<GameRoom> {
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

  /** 전원 ready로 게임이 실제로 시작될 때 방 상태를 IN_GAME으로 전이한다 (#153) —
   *  이걸 안 하면 로비 목록에서 이미 시작된 방이 계속 WAITING(참가 가능)으로 보인다. */
  async startGame(roomId: string): Promise<GameRoom> {
    const roomKey = `game:room:${roomId}`;
    const data = await this.redisService.get(roomKey);
    if (!data) throw new NotFoundException('Game room not found');

    const room = JSON.parse(data) as GameRoom;
    room.status = RoomStatus.IN_GAME;
    await this.redisService.set(roomKey, JSON.stringify(room), ROOM_TTL);
    return room;
  }

  /**
   * userId가 현재 소속된 다른 WAITING 방 목록 (excludeRoomId 제외).
   * IN_GAME/FINISHED 방은 포함하지 않는다 — 매치 세션(AcidRainService)과의
   * 정합성 문제는 별도 이슈에서 다룬다(#183 논의).
   */
  async findWaitingRoomsForUser(
    userId: string,
    excludeRoomId: string,
  ): Promise<GameRoom[]> {
    const client = this.redisService.getClient();
    const keys = await client.keys('game:room:*');
    const rooms: GameRoom[] = [];

    for (const key of keys) {
      if (key === `game:room:${excludeRoomId}`) continue;
      const data = await this.redisService.get(key);
      if (!data) continue;
      const room = JSON.parse(data) as GameRoom;
      if (
        room.status === RoomStatus.WAITING &&
        room.players.some((p) => p.userId === userId)
      ) {
        rooms.push(room);
      }
    }
    return rooms;
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

  /** 관전 가능한(현재 진행 중인) 방 목록 — deploy#70. getWaitingRooms()와 별도 메서드로
   *  분리해 기존 대기방 목록의 시맨틱에는 영향을 주지 않는다. */
  async getSpectatableRooms(): Promise<GameRoom[]> {
    const client = this.redisService.getClient();
    const keys = await client.keys('game:room:*');
    const rooms: GameRoom[] = [];

    for (const key of keys) {
      const data = await this.redisService.get(key);
      if (data) {
        const room = JSON.parse(data) as GameRoom;
        if (room.status === RoomStatus.IN_GAME) rooms.push(room);
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
      ROOM_TTL,
    );
  }

  // ─── #21 Stats & Leaderboard ────────────────────────────────────────────

  async getUserStats(userId: string) {
    const user = await this.userRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    const totalGames = user.wins + user.losses + user.draws;
    return {
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      totalGames,
      winRate:
        totalGames > 0 ? Math.round((user.wins / totalGames) * 100) / 100 : 0,
    };
  }

  /**
   * 유저의 전적 목록. N인 매치(participants 사용)와 기존 2인 매치
   * (hostUser/guestUser 사용) 모두 지원한다.
   */
  async getUserMatches(
    userId: string,
    page: number,
    limit: number,
    mode?: MatchMode,
  ) {
    const participantMatchIds = (
      await this.participantRepository
        .createQueryBuilder('p')
        .select('p.matchId', 'matchId')
        .where('p.userId = :userId', { userId })
        .getRawMany<{ matchId: string }>()
    ).map((r) => r.matchId);

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

    if (participantMatchIds.length > 0) {
      qb.where(
        '(m.id IN (:...participantMatchIds) OR m.hostUserId = :userId OR m.guestUserId = :userId)',
        { participantMatchIds, userId },
      );
    } else {
      qb.where('(m.hostUserId = :userId OR m.guestUserId = :userId)', {
        userId,
      });
    }
    if (mode) qb.andWhere('m.mode = :mode', { mode });

    const [matches, total] = await qb.getManyAndCount();

    const safeUser = (u: User | null | undefined) =>
      u ? { id: u.id, nickname: u.nickname, avatar: u.avatar } : null;

    return {
      matches: matches.map((m) => ({
        id: m.id,
        // N인 매치는 participants[], 구형 2인 매치는 hostUser/guestUser(하위호환)
        participants:
          m.participants?.map((p) => ({
            user: safeUser(p.user),
            finalHp: p.finalHp,
            rank: p.rank,
          })) ?? [],
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
    // winRate/totalGames는 DB 컬럼이 아니라 SQL ORDER BY로 표현할 수 없다.
    // 정렬 없이 전체를 가져온 뒤(기존에도 메모리에 전부 올려 slice(0, 50)
    // 했으므로 쿼리 특성 변화 없음) 통계 계산 후 JS에서 정렬한다.
    const users = await this.userRepository.find();
    const withStats = users.map((u) => {
      const totalGames = u.wins + u.losses + u.draws;
      return {
        id: u.id,
        nickname: u.nickname,
        avatar: u.avatar,
        wins: u.wins,
        losses: u.losses,
        draws: u.draws,
        totalGames,
        winRate:
          totalGames > 0 ? Math.round((u.wins / totalGames) * 100) / 100 : 0,
      };
    });

    withStats.sort((a, b) => {
      // 한 번도 안 한 유저는 losses가 0이라 예전 order(wins DESC, losses ASC)로는
      // 계속 진 유저보다 위로 갔다(#206) — 활동 여부를 최우선 기준으로 둔다.
      if (a.totalGames > 0 !== b.totalGames > 0) {
        return a.totalGames > 0 ? -1 : 1;
      }
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.losses - b.losses;
    });

    return withStats.slice(0, 50);
  }
}
