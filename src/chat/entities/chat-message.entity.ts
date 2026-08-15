import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

export enum MessageType {
  NORMAL = 'NORMAL',
  INVITE = 'INVITE',
  SYSTEM = 'SYSTEM',
}

@Entity('chat_messages')
export class ChatMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // SYSTEM 메시지는 실제 유저가 보내지 않으므로 null 허용
  @ManyToOne(() => User, { onDelete: 'SET NULL', eager: true, nullable: true })
  @JoinColumn({ name: 'senderId' })
  sender: User | null;

  @Column({ type: 'text' })
  content: string;

  @Column({ nullable: true })
  roomId?: string;

  @Column({
    type: 'enum',
    enum: MessageType,
    default: MessageType.NORMAL,
  })
  type: MessageType;

  @CreateDateColumn()
  createdAt: Date;
}
