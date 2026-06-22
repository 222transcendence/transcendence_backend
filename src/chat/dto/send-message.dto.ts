import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { MessageType } from '../entities/chat-message.entity';

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  content: string;

  @IsOptional()
  @IsString()
  roomId?: string;

  @IsOptional()
  @IsEnum(MessageType)
  type?: MessageType;
}
