import { DataSource } from 'typeorm';
import {
  WordDictionary,
  WordLanguage,
  WordContentType,
  WordDifficulty,
  WordCategory,
} from './entities/word-dictionary.entity';
import { SEED_WORDS } from './seed-words';

const LOW_MAX = 5;
const MID_MAX = 9;

function toDifficulty(keystrokes: number): WordDifficulty {
  if (keystrokes <= LOW_MAX) return WordDifficulty.EASY;
  if (keystrokes <= MID_MAX) return WordDifficulty.NORMAL;
  return WordDifficulty.HARD;
}

export async function seedWordDictionary(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository(WordDictionary);

  // 중복 제거 (text 유니크 보장)
  const unique = new Map<string, (typeof SEED_WORDS)[number]>();
  for (const w of SEED_WORDS) {
    if (!unique.has(w.text)) unique.set(w.text, w);
  }

  let inserted = 0;
  let skipped = 0;

  for (const [, entry] of unique) {
    const exists = await repo.findOneBy({ text: entry.text });
    if (exists) { skipped++; continue; }

    await repo.save(
      repo.create({
        text: entry.text,
        keystrokes: entry.keystrokes,
        difficulty: toDifficulty(entry.keystrokes),
        language: WordLanguage.KO,
        contentType: WordContentType.WORD,
        category: WordCategory.COMMON,
        length: [...entry.text].length,
        source: 'word-bank-v1',
        isActive: true,
      }),
    );
    inserted++;
  }

  console.log(`[WordDictionarySeeder] inserted=${inserted} skipped=${skipped}`);
}
