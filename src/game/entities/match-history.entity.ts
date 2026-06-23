import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  CreateDateColumn,
} from 'typeorm';
import { User } from '../../user/entities/user.entity';

@Entity('match_histories')
export class MatchHistory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ManyToOne(() => User, { eager: true })
  host_user: User;

  @ManyToOne(() => User, { eager: true })
  guest_user: User;

  @ManyToOne(() => User, { nullable: true, eager: true })
  winner?: User;

  @Column({ type: 'int', default: 0 })
  turns_played: number;

  @Column({ type: 'jsonb', nullable: true })
  match_data: any;

  @CreateDateColumn()
  createdAt: Date;
}
