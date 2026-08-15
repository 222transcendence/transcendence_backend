import { MigrationInterface, QueryRunner } from 'typeorm';
import { countKeystrokes } from '../game/acid-rain/keystroke-count';

const LOW_MAX_KEYSTROKES = 5;
const MID_MAX_KEYSTROKES = 9;

export class RecalculateDictionaryKeystrokes1800000011000 implements MigrationInterface {
  name = 'RecalculateDictionaryKeystrokes1800000011000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows = (await queryRunner.query(
      'SELECT "id", "text" FROM "word_dictionary"',
    )) as Array<{ id: string; text: string }>;

    for (const row of rows) {
      const keystrokes = countKeystrokes(row.text);
      const difficulty =
        keystrokes <= LOW_MAX_KEYSTROKES
          ? 'easy'
          : keystrokes <= MID_MAX_KEYSTROKES
            ? 'normal'
            : 'hard';
      await queryRunner.query(
        'UPDATE "word_dictionary" SET "keystrokes" = $1, "difficulty" = $2, "updatedAt" = now() WHERE "id" = $3',
        [keystrokes, difficulty, row.id],
      );
    }
  }

  public async down(): Promise<void> {
    // The corrected counts are derived from the current dictionary text and
    // cannot be safely restored to the previous, potentially stale values.
  }
}
