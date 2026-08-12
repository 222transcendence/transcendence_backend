import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
} from 'typeorm';

export type WordAttemptResult =
  | 'CORRECT'
  | 'WRONG'
  | 'CORRECT_AFTER_CORRECTION'
  | 'GIVE_UP'
  | 'MISSED'
  | 'ALREADY_CLEARED';

@Entity('word_attempt_records')
@Index(['matchId', 'participantId'])
@Index(['matchId', 'wordId'])
export class WordAttemptRecord {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  matchId: string;

  @Column()
  participantId: string;

  @Column({ nullable: true })
  userId?: string;

  @Column()
  wordId: string;

  @Column('int', { default: 1 })
  attemptNo: number;

  @Column()
  result: WordAttemptResult;

  @Column({ type: 'timestamptz', nullable: true })
  firstTypingAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastTypingAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submitReceivedAt: Date | null;

  @Column({ type: 'timestamptz' })
  resolvedAt: Date;

  @Column({ nullable: true })
  submittedText: string | null;

  @Column('int', { default: 0 })
  typoCount: number;

  @Column('int', { default: 0 })
  correctionCount: number;

  @Column('int', { default: 0 })
  totalKeystrokes: number;
}
