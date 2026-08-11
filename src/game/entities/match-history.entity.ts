import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

export enum MatchMode {
  PVP = 'PVP',
  AI_PRACTICE = 'AI_PRACTICE',
}

@Entity('match_history')
export class MatchHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', eager: true })
  @JoinColumn({ name: 'hostUserId' })
  hostUser: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE', eager: true })
  @JoinColumn({ name: 'guestUserId' })
  guestUser: User;

  @ManyToOne(() => User, { onDelete: 'SET NULL', eager: true, nullable: true })
  @JoinColumn({ name: 'winnerId' })
  winner: User | null;

  @Column({ type: 'enum', enum: MatchMode, default: MatchMode.PVP })
  mode: MatchMode;

  @Column({ type: 'int' })
  roundsPlayed: number;

  @Column({ type: 'jsonb' })
  matchData: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
