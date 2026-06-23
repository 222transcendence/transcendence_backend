import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('characters')
export class Character {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ unique: true })
  name: string;

  @Column({ type: 'int' })
  base_hp: number;

  @Column({ type: 'int' })
  base_atk: number;

  @Column({ type: 'int' })
  base_def: number;

  @Column({ type: 'jsonb', nullable: true })
  skills: any;
}
