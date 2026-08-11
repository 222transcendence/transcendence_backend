/**
 * 단어 사전 초기 데이터 seed 스크립트.
 * 실행: npx ts-node -r tsconfig-paths/register src/word-dictionary/seed.ts
 */
import 'dotenv/config';
import { AppDataSource } from '../data-source';
import { seedWordDictionary } from './word-dictionary.seeder';

async function main() {
  await AppDataSource.initialize();
  await seedWordDictionary(AppDataSource);
  await AppDataSource.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
