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

  @ManyToOne(() => User, { onDelete: 'CASCADE', eager: true })
  @JoinColumn({ name: 'senderId' })
  sender: User;

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
