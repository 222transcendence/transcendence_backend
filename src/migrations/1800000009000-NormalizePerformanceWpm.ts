import { MigrationInterface, QueryRunner } from 'typeorm';

export class NormalizePerformanceWpm1800000009000 implements MigrationInterface {
  name = 'NormalizePerformanceWpm1800000009000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "participant_performances"
      SET "typingWpm" =
        (("totalKeystrokes" + "correctionCount") / 5.0)
        / ("typingDurationMs" / 60000.0)
      WHERE "typingDurationMs" IS NOT NULL
        AND "typingDurationMs" > 0
        AND ("totalKeystrokes" + "correctionCount") > 0
    `);
  }

  public async down(): Promise<void> {
    // The old word-count metric cannot be reconstructed from normalized rows.
  }
}
