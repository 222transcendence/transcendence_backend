import {
  Entity,
  PrimaryGeneratedColumn,
  ManyToOne,
  JoinColumn,
  Column,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';
import { MatchHistory } from './match-history.entity';

@Entity('match_participants')
export class MatchParticipant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => MatchHistory, (m) => m.participants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'matchId' })
  match: MatchHistory;

  @ManyToOne(() => User, { onDelete: 'CASCADE', eager: true })
  @JoinColumn({ name: 'userId' })
  user: User;

  /** 매치 종료 시점 HP (0 이하면 탈락) */
  @Column({ type: 'int', default: 0 })
  finalHp: number;

  /** 순위 (1=1위/우승, 2=2위, …). 공동 우승은 동일 rank 허용 */
  @Column({ type: 'int', default: 0 })
  rank: number;
}
