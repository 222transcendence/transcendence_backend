import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTargetKeystrokesToWordAttempts1800000006000
  implements MigrationInterface
{
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "word_attempt_records" ADD COLUMN "targetKeystrokes" integer',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE "word_attempt_records" DROP COLUMN "targetKeystrokes"',
    );
  }
}
