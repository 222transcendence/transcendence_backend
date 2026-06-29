import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Friend } from './entities/friend.entity';
import { User } from '../user/entities/user.entity';
import { FriendService } from './friend.service';
import { FriendController } from './friend.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Friend, User])],
  providers: [FriendService],
  controllers: [FriendController],
  exports: [FriendService],
})
export class FriendModule {}
