import { IsString, IsOptional, Length, Matches } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 20)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'Nickname can only contain alphanumeric characters, underscores, and hyphens.',
  })
  nickname?: string;

  @IsOptional()
  @IsString()
  avatar?: string;
}
