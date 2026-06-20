import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get('me')
  async getMe(@CurrentUser() user: User) {
    const { password, ...result } = user;
    return result;
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    const targetUser = await this.userService.findOne(id);
    const { password, email, ...result } = targetUser;
    return result;
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: User,
    @Body() updateProfileDto: UpdateProfileDto,
  ) {
    const { nickname } = updateProfileDto;

    if (nickname) {
      const existing = await this.userService.findByNickname(nickname);
      if (existing && existing.id !== user.id) {
        throw new ConflictException('Nickname is already taken');
      }
    }

    const updatedUser = await this.userService.update(user.id, updateProfileDto);
    const { password, ...result } = updatedUser;
    return result;
  }
}
