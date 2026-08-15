import { IsString, IsOptional, Length, Matches } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(2, 20)
  @Matches(/^[a-zA-Z0-9_-]+$/, {
    message: 'Nickname can only contain alphanumeric characters, underscores, and hyphens.',
  })
  nickname?: string;

  // null = 아바타 삭제(기본 아바타로 되돌리기) 요청. @IsOptional()은 null도
  // 그대로 통과시키므로(#203) 별도 검증 없이 타입만 명시한다.
  @IsOptional()
  @IsString()
  avatar?: string | null;
}
