import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Check,
} from 'typeorm';

export enum WordLanguage {
  KO = 'ko',
  EN = 'en',
}

export enum WordContentType {
  WORD = 'word',
  PHRASE = 'phrase',
  SENTENCE = 'sentence',
}

export enum WordDifficulty {
  EASY = 'easy',
  NORMAL = 'normal',
  HARD = 'hard',
}

export enum WordCategory {
  COMMON = 'common',
  TECH = 'tech',
  GAME = 'game',
  SENTENCE = 'sentence',
}

@Entity('word_dictionary')
@Index(['language', 'difficulty', 'contentType', 'isActive'])
@Check(`"text" <> ''`)
export class WordDictionary {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  text: string;

  @Column({ type: 'enum', enum: WordLanguage, default: WordLanguage.KO })
  language: WordLanguage;

  @Column({ type: 'enum', enum: WordContentType, default: WordContentType.WORD })
  contentType: WordContentType;

  @Column({ type: 'enum', enum: WordDifficulty, default: WordDifficulty.NORMAL })
  difficulty: WordDifficulty;

  @Column({ type: 'enum', enum: WordCategory, default: WordCategory.COMMON })
  category: WordCategory;

  /** 글자(음절) 수 */
  @Column({ type: 'int' })
  length: number;

  /** 2벌식 기준 타건 횟수 */
  @Column({ type: 'int' })
  keystrokes: number;

  @Column({ nullable: true })
  source?: string;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
