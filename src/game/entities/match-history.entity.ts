import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { MatchParticipant } from './match-participant.entity';

export enum MatchMode {
  PVP = 'PVP',
  AI_PRACTICE = 'AI_PRACTICE',
}

@Entity('match_history')
export class MatchHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 하위호환: 기존 2인 매치 레코드에만 존재. N인 매치는 participants 사용 */
  @ManyToOne(() => User, { onDelete: 'CASCADE', eager: true, nullable: true })
  @JoinColumn({ name: 'hostUserId' })
  hostUser: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE', eager: true, nullable: true })
  @JoinColumn({ name: 'guestUserId' })
  guestUser: User;

  @ManyToOne(() => User, { onDelete: 'SET NULL', eager: true, nullable: true })
  @JoinColumn({ name: 'winnerId' })
  winner: User | null;

  /** N인 참가자 목록 (rank, finalHp 포함) */
  @OneToMany(() => MatchParticipant, (p) => p.match, { cascade: true, eager: true })
  participants: MatchParticipant[];

  @Column({ type: 'enum', enum: MatchMode, default: MatchMode.PVP })
  mode: MatchMode;

  @Column({ type: 'int' })
  roundsPlayed: number;

  @Column({ type: 'jsonb' })
  matchData: Record<string, unknown>;

  @CreateDateColumn()
  createdAt: Date;
}
