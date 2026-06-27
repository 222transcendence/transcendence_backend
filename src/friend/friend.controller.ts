import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { FriendService } from './friend.service';
import { RespondFriendRequestDto } from './dto/respond-friend-request.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from '../user/entities/user.entity';

@Controller('api/friends')
@UseGuards(JwtAuthGuard)
export class FriendController {
  constructor(private readonly friendService: FriendService) {}

  @Post(':userId')
  async sendFriendRequest(
    @CurrentUser() user: User,
    @Param('userId') targetUserId: string,
  ) {
    return await this.friendService.sendFriendRequest(user.id, targetUserId);
  }

  @Patch(':requestId')
  async respondFriendRequest(
    @CurrentUser() user: User,
    @Param('requestId') requestId: string,
    @Body() body: RespondFriendRequestDto,
  ) {
    return await this.friendService.respondFriendRequest(
      user.id,
      requestId,
      body.action,
    );
  }

  @Delete(':userId')
  async removeFriend(
    @CurrentUser() user: User,
    @Param('userId') friendUserId: string,
  ) {
    await this.friendService.removeFriend(user.id, friendUserId);
    return { deleted: true };
  }

  @Get('requests')
  async getPendingRequests(@CurrentUser() user: User) {
    return await this.friendService.getPendingRequests(user.id);
  }

  @Get()
  async getFriends(@CurrentUser() user: User) {
    return await this.friendService.getFriends(user.id);
  }
}
