import { DataSource } from 'typeorm';
import { User } from './user/entities/user.entity';
import { Friend } from './friend/entities/friend.entity';
import { Character } from './game/entities/character.entity';
import { Card } from './game/entities/card.entity';
import { MatchHistory } from './game/entities/match-history.entity';
import * as dotenv from 'dotenv';

dotenv.config();

export const AppDataSource = new DataSource({
  type: 'postgres',
  url:
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@localhost:5432/transcendence',
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT) : 5432,
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: [User, Friend, Character, Card, MatchHistory],
  migrations: [__dirname + '/migrations/*.ts', __dirname + '/migrations/*.js'],
  synchronize: false,
  logging: true,
});
