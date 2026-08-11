import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Friend, FriendStatus } from './entities/friend.entity';
import { User, UserStatus } from '../user/entities/user.entity';
import { RedisService } from '../redis/redis.service';

type SafeUser = Pick<User, 'id' | 'nickname' | 'status' | 'avatar'>;

function sanitizeUser(user: User): SafeUser {
  return { id: user.id, nickname: user.nickname, status: user.status, avatar: user.avatar };
}

@Injectable()
export class FriendService {
  constructor(
    @InjectRepository(Friend)
    private readonly friendRepository: Repository<Friend>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly redisService: RedisService,
  ) {}

  async sendFriendRequest(
    currentUserId: string,
    targetUserId: string,
  ): Promise<{ id: string; requester: SafeUser; receiver: SafeUser; status: FriendStatus; createdAt: Date }> {
    if (currentUserId === targetUserId) {
      throw new BadRequestException('Cannot send friend request to yourself');
    }

    const [requester, receiver] = await Promise.all([
      this.userRepository.findOne({ where: { id: currentUserId } }),
      this.userRepository.findOne({ where: { id: targetUserId } }),
    ]);

    if (!requester || !receiver) {
      throw new NotFoundException('User not found');
    }

    const existingRelation = await this.findRelationBetweenUsers(
      currentUserId,
      targetUserId,
    );
    if (existingRelation) {
      if (existingRelation.status === FriendStatus.ACCEPTED) {
        throw new ConflictException('Already friends');
      }
      throw new ConflictException('Friend request already exists');
    }

    const friendRequest = this.friendRepository.create({
      requester,
      receiver,
      status: FriendStatus.PENDING,
    });

    const saved = await this.friendRepository.save(friendRequest);
    return {
      id: saved.id,
      requester: sanitizeUser(saved.requester),
      receiver: sanitizeUser(saved.receiver),
      status: saved.status,
      createdAt: saved.createdAt,
    };
  }

  async respondFriendRequest(
    currentUserId: string,
    requestId: string,
    action: 'accept' | 'reject',
  ): Promise<{ id: string; requester: SafeUser; receiver: SafeUser; status: FriendStatus; createdAt: Date } | { deleted: true }> {
    if (action !== 'accept' && action !== 'reject') {
      throw new BadRequestException('action must be accept or reject');
    }

    const request = await this.friendRepository.findOne({
      where: { id: requestId },
    });
    if (!request) {
      throw new NotFoundException('Friend request not found');
    }

    if (request.receiver.id !== currentUserId) {
      throw new ForbiddenException('Only receiver can respond to this request');
    }

    if (request.status !== FriendStatus.PENDING) {
      throw new ConflictException('Only PENDING request can be processed');
    }

    if (action === 'accept') {
      request.status = FriendStatus.ACCEPTED;
      const saved = await this.friendRepository.save(request);
      return {
        id: saved.id,
        requester: sanitizeUser(saved.requester),
        receiver: sanitizeUser(saved.receiver),
        status: saved.status,
        createdAt: saved.createdAt,
      };
    }

    await this.friendRepository.remove(request);
    return { deleted: true };
  }

  async removeFriend(
    currentUserId: string,
    friendUserId: string,
  ): Promise<void> {
    if (currentUserId === friendUserId) {
      throw new BadRequestException('Cannot remove yourself from friend list');
    }

    const relation = await this.findRelationBetweenUsers(
      currentUserId,
      friendUserId,
    );

    if (!relation || relation.status !== FriendStatus.ACCEPTED) {
      throw new NotFoundException('Accepted friend relation not found');
    }

    const isParticipant =
      relation.requester.id === currentUserId ||
      relation.receiver.id === currentUserId;

    if (!isParticipant) {
      throw new ForbiddenException('You are not part of this relation');
    }

    await this.friendRepository.remove(relation);
  }

  async getFriends(currentUserId: string): Promise<
    {
      id: string;
      nickname: string;
      status: string;
      avatar?: string;
    }[]
  > {
    const relations = await this.friendRepository.find({
      where: [
        { requester: { id: currentUserId }, status: FriendStatus.ACCEPTED },
        { receiver: { id: currentUserId }, status: FriendStatus.ACCEPTED },
      ],
    });

    const friends = relations.map((relation) =>
      relation.requester.id === currentUserId ? relation.receiver : relation.requester,
    );

    // Redis에서 실시간 상태 조회 (없으면 OFFLINE)
    const statuses = await Promise.all(
      friends.map((f) => this.redisService.get(`user:${f.id}:status`)),
    );

    return friends.map((f, i) => ({
      id: f.id,
      nickname: f.nickname,
      avatar: f.avatar,
      // 게임 로직은 DB status만 IN_GAME으로 갱신하고 Redis 프레즌스는 갱신하지 않으므로,
      // IN_GAME은 DB를 우선하고 그 외에는 Redis 프레즌스를 따른다.
      status: f.status === UserStatus.IN_GAME ? UserStatus.IN_GAME : (statuses[i] ?? 'OFFLINE'),
    }));
  }

  async getPendingRequests(
    currentUserId: string,
  ): Promise<{ id: string; requester: SafeUser; createdAt: Date }[]> {
    const requests = await this.friendRepository.find({
      where: { receiver: { id: currentUserId }, status: FriendStatus.PENDING },
    });
    return requests.map((r) => ({
      id: r.id,
      requester: sanitizeUser(r.requester),
      createdAt: r.createdAt,
    }));
  }

  async getSentRequests(
    currentUserId: string,
  ): Promise<{ id: string; receiver: SafeUser; createdAt: Date }[]> {
    const requests = await this.friendRepository.find({
      where: { requester: { id: currentUserId }, status: FriendStatus.PENDING },
    });
    return requests.map((r) => ({
      id: r.id,
      receiver: sanitizeUser(r.receiver),
      createdAt: r.createdAt,
    }));
  }

  private async findRelationBetweenUsers(
    currentUserId: string,
    targetUserId: string,
  ): Promise<Friend | null> {
    return await this.friendRepository.findOne({
      where: [
        { requester: { id: currentUserId }, receiver: { id: targetUserId } },
        { requester: { id: targetUserId }, receiver: { id: currentUserId } },
      ],
    });
  }

  async sendFriendRequestByNickname(currentUserId: string, nickname: string) {
    const target = await this.userRepository.findOne({ where: { nickname } });
    if (!target) {
      throw new NotFoundException(`User with nickname "${nickname}" not found`);
    }
    return this.sendFriendRequest(currentUserId, target.id);
  }
}
