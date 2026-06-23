import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

export enum CardType {
  MOVE = 'MOVE',
  ATK_SWORD = 'ATK_SWORD',
  ATK_GUN = 'ATK_GUN',
  DEF = 'DEF',
  SPECIAL = 'SPECIAL',
}

@Entity('cards')
export class Card {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({
    type: 'enum',
    enum: CardType,
  })
  type: CardType;

  @Column({ type: 'int' })
  value_top: number;

  @Column({ type: 'int' })
  value_bottom: number;
}
