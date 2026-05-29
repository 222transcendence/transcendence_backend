import { UserStatus } from '../entities/user.entity';

export class UpdateUserDto {
  email?: string;
  nickname?: string;
  password?: string;
  avatar?: string;
  status?: UserStatus;
  wins?: number;
  losses?: number;
}
