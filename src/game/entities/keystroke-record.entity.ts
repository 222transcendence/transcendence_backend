import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity('keystroke_records')
@Index(['matchId', 'participantId', 'wordId'])
@Index(['serverReceivedAt'])
export class KeystrokeRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  matchId: string;

  @Column()
  participantId: string;

  @Column({ nullable: true })
  userId?: string;

  @Column()
  wordId: string;

  @Column('int')
  sequence: number;

  @Column()
  partialText: string;

  @Column('int')
  textLength: number;

  /** PROGRESS | BACKSPACE | CLEAR */
  @Column({ default: 'PROGRESS' })
  inputType: string;

  @Column({ type: 'bigint', nullable: true })
  clientTs?: number;

  @CreateDateColumn({ type: 'timestamptz' })
  serverReceivedAt: Date;
}
