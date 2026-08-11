import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { avatarUploadOptions, AVATAR_URL_PREFIX } from './avatar-upload.config';
import { RedisService } from '../redis/redis.service';

@Controller('api/users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly redisService: RedisService,
  ) {}

  @Get('me')
  async getMe(@CurrentUser() user: User) {
    const { password, ...result } = user;
    return { timestamp: new Date().toISOString(), status: 200, data: result, error: null };
  }

  @Get(':id')
  async getUser(@Param('id') id: string) {
    const targetUser = await this.userService.findOne(id);
    const { password, email, ...result } = targetUser;
    return { timestamp: new Date().toISOString(), status: 200, data: result, error: null };
  }

  @Get(':id/status')
  async getUserStatus(@Param('id') id: string) {
    await this.userService.findOne(id); // 404 if not found
    const cached = await this.redisService.get(`user:${id}:status`);
    return { status: cached ?? 'OFFLINE' };
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
    return { timestamp: new Date().toISOString(), status: 200, data: result, error: null };
  }

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('avatar', avatarUploadOptions))
  async uploadAvatar(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }

    const avatarUrl = `${AVATAR_URL_PREFIX}/${file.filename}`;
    const updatedUser = await this.userService.update(user.id, {
      avatar: avatarUrl,
    });
    const { password, ...result } = updatedUser;
    return { timestamp: new Date().toISOString(), status: 200, data: result, error: null };
  }
}
