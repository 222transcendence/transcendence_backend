import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMatchHistoryMode1800000000000 implements MigrationInterface {
  name = 'AddMatchHistoryMode1800000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "match_history_mode_enum" AS ENUM('PVP', 'AI_PRACTICE')`,
    );
    await queryRunner.query(
      `ALTER TABLE "match_history" ADD COLUMN "mode" "match_history_mode_enum" NOT NULL DEFAULT 'PVP'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "match_history" DROP COLUMN "mode"`,
    );
    await queryRunner.query(
      `DROP TYPE "match_history_mode_enum"`,
    );
  }
}
