import { IsNumber, IsArray } from 'class-validator';

export class CreateRoomDto {
  @IsNumber()
  characterId: number;
}

export class JoinRoomDto {
  @IsNumber()
  characterId: number;
}

export class SubmitCardsDto {
  @IsArray()
  @IsNumber({}, { each: true })
  cardIds: number[];
}
