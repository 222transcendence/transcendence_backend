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
import { User } from '../user/entities/user.entity';

@Injectable()
export class FriendService {
  constructor(
    @InjectRepository(Friend)
    private readonly friendRepository: Repository<Friend>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async sendFriendRequest(
    currentUserId: string,
    targetUserId: string,
  ): Promise<Friend> {
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

    return await this.friendRepository.save(friendRequest);
  }

  async respondFriendRequest(
    currentUserId: string,
    requestId: string,
    action: 'accept' | 'reject',
  ): Promise<Friend | { deleted: true }> {
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
      return await this.friendRepository.save(request);
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
      status: User['status'];
    }[]
  > {
    const relations = await this.friendRepository.find({
      where: [
        { requester: { id: currentUserId }, status: FriendStatus.ACCEPTED },
        { receiver: { id: currentUserId }, status: FriendStatus.ACCEPTED },
      ],
    });

    return relations.map((relation) => {
      const friendUser =
        relation.requester.id === currentUserId
          ? relation.receiver
          : relation.requester;

      return {
        id: friendUser.id,
        nickname: friendUser.nickname,
        status: friendUser.status,
      };
    });
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
}
