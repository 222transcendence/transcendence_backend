import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

export type ParticipantType = 'HUMAN' | 'AI';
export type MatchMode = 'PVP' | 'AI_PRACTICE';
export type ResultStatus = 'FINISHED' | 'ABORTED' | 'VOID';

@Entity('participant_performances')
@Index(['matchId'])
@Index(['userId'])
@Index(['participantType', 'resultStatus'])
export class ParticipantPerformance {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  matchId: string;

  @Column()
  participantId: string;

  @Column({ nullable: true })
  userId?: string;

  @Column()
  participantType: ParticipantType;

  @Column()
  mode: MatchMode;

  @Column()
  resultStatus: ResultStatus;

  @Column('int', { default: 0 })
  correctWords: number;

  @Column('int', { default: 0 })
  wrongAttempts: number;

  @Column('int', { default: 0 })
  missedWords: number;

  @Column('int', { default: 0 })
  typoCount: number;

  @Column('int', { default: 0 })
  correctionCount: number;

  @Column('int', { default: 0 })
  abandonedWords: number;

  @Column('int', { default: 0 })
  totalKeystrokes: number;

  @Column('float', { nullable: true })
  typingWpm: number | null;

  @Column('float', { nullable: true })
  effectiveWordsPerMinute: number | null;

  @Column('float', { nullable: true })
  accuracy: number | null;

  @Column('float', { nullable: true })
  avgReactionTimeMs: number | null;

  /** Total spawn-to-first-input latency, retained for compatibility. */
  @Column('float', { nullable: true })
  avgQueueTimeMs: number | null;

  /** Time from the previous submit (or spawn) to first input. */
  @Column('float', { nullable: true })
  avgAcquisitionTimeMs: number | null;

  /** Acquisition latency when no previous word was still being completed. */
  @Column('float', { nullable: true })
  avgInitialReactionTimeMs: number | null;

  @Column('float', { nullable: true })
  medianReactionTimeMs: number | null;

  @Column('float', { nullable: true })
  avgCompletionTimeMs: number | null;

  @Column('int', { default: 0 })
  sampleCount: number;

  @Column('int', { nullable: true })
  typingDurationMs: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
