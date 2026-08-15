import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEffectiveWordsPerMinute1800000007000 implements MigrationInterface {
  name = 'AddEffectiveWordsPerMinute1800000007000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "participant_performances" ADD COLUMN "effectiveWordsPerMinute" float`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "participant_performances" DROP COLUMN "effectiveWordsPerMinute"`,
    );
  }
}
