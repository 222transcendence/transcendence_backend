import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

export enum CharacterName {
  WARRIOR = 'WARRIOR',
  MAGE = 'MAGE',
  ROGUE = 'ROGUE',
}

export interface CharacterSkill {
  name: string;
  triggerDistance: string;
  triggerPhase: string;
  requiredCards: string;
  effect: string;
}

@Entity('characters')
export class Character {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: CharacterName;

  @Column({ type: 'int' })
  baseHp: number;

  @Column({ type: 'int' })
  baseAtk: number;

  @Column({ type: 'int' })
  baseDef: number;

  @Column({ type: 'jsonb', default: [] })
  skills: CharacterSkill[];
}
