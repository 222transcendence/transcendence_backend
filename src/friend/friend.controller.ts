import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { FriendService } from './friend.service';
import { RespondFriendRequestDto } from './dto/respond-friend-request.dto';

@Controller('api/friends')
export class FriendController {
  constructor(private readonly friendService: FriendService) {}

  // Auth merge 전 임시 처리: current user는 x-user-id 헤더로 전달받습니다.
  @Post(':userId')
  async sendFriendRequest(
    @Headers('x-user-id') currentUserId: string,
    @Param('userId') targetUserId: string,
  ) {
    this.validateCurrentUserHeader(currentUserId);
    return await this.friendService.sendFriendRequest(
      currentUserId,
      targetUserId,
    );
  }

  // Auth merge 전 임시 처리: current user는 x-user-id 헤더로 전달받습니다.
  @Patch(':requestId')
  async respondFriendRequest(
    @Headers('x-user-id') currentUserId: string,
    @Param('requestId') requestId: string,
    @Body() body: RespondFriendRequestDto,
  ) {
    this.validateCurrentUserHeader(currentUserId);
    return await this.friendService.respondFriendRequest(
      currentUserId,
      requestId,
      body.action,
    );
  }

  // Auth merge 전 임시 처리: current user는 x-user-id 헤더로 전달받습니다.
  @Delete(':userId')
  async removeFriend(
    @Headers('x-user-id') currentUserId: string,
    @Param('userId') friendUserId: string,
  ) {
    this.validateCurrentUserHeader(currentUserId);
    await this.friendService.removeFriend(currentUserId, friendUserId);
    return { deleted: true };
  }

  // Auth merge 전 임시 처리: current user는 x-user-id 헤더로 전달받습니다.
  @Get()
  async getFriends(@Headers('x-user-id') currentUserId: string) {
    this.validateCurrentUserHeader(currentUserId);
    return await this.friendService.getFriends(currentUserId);
  }

  private validateCurrentUserHeader(currentUserId?: string): void {
    if (!currentUserId) {
      throw new BadRequestException('x-user-id header is required');
    }
  }
}
