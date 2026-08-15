import { MigrationInterface, QueryRunner } from 'typeorm';
import { countKeystrokes } from '../game/acid-rain/keystroke-count';

export class AlignWordDictionaryKeystrokes1800000008000 implements MigrationInterface {
  name = 'AlignWordDictionaryKeystrokes1800000008000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      `SELECT "id", "text" FROM "word_dictionary" WHERE "language" = 'ko'`,
    )) as Array<{ id: string; text: string }>;
    for (const row of rows) {
      let keystrokes: number;
      try {
        keystrokes = countKeystrokes(row.text);
      } catch {
        continue;
      }
      const difficulty =
        keystrokes <= 5 ? 'easy' : keystrokes <= 9 ? 'normal' : 'hard';
      await queryRunner.query(
        `UPDATE "word_dictionary" SET "keystrokes" = $1, "difficulty" = $2, "updatedAt" = now() WHERE "id" = $3`,
        [keystrokes, difficulty, row.id],
      );
    }
  }

  public async down(): Promise<void> {
    // Corrected counts are derived data; reverting would restore stale values.
  }
}
