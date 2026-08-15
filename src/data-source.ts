import { DataSource } from 'typeorm';
import { User } from './user/entities/user.entity';
import { Friend } from './friend/entities/friend.entity';
import {
  DbQueryLogger,
  PopulationDefaultReportLogger,
} from './metrics/db-query.logger';
import { ChatMessage } from './chat/entities/chat-message.entity';
import { MatchHistory } from './game/entities/match-history.entity';
import { MatchParticipant } from './game/entities/match-participant.entity';
import { WordDictionary } from './word-dictionary/entities/word-dictionary.entity';
import { ParticipantPerformance } from './game/entities/participant-performance.entity';
import * as dotenv from 'dotenv';

dotenv.config({ quiet: process.env.POPULATION_DEFAULT_REPORT === '1' });

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
  entities: [
    User,
    Friend,
    ChatMessage,
    MatchHistory,
    MatchParticipant,
    WordDictionary,
    ParticipantPerformance,
  ],
  migrations: [__dirname + '/migrations/*.ts', __dirname + '/migrations/*.js'],
  synchronize: false,
  logger:
    process.env.POPULATION_DEFAULT_REPORT === '1'
      ? new PopulationDefaultReportLogger()
      : new DbQueryLogger(),
  // TypeORM only calls logQuerySlow when maxQueryExecutionTime is truthy and
  // exceeded, so 0 would silently disable it. 1ms captures effectively every
  // query for the db_query_duration_seconds metric.
  maxQueryExecutionTime: 1,
});
