import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDrawsToUser1786310000000 implements MigrationInterface {
  name = 'AddDrawsToUser1786310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 무승부는 wins/losses 어느 쪽도 늘리지 않으므로, totalGames(=wins+losses+draws)에
    // 반영하려면 별도 카운터가 필요하다 (#77).
    await queryRunner.query(
      `ALTER TABLE "users" ADD "draws" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "draws"`);
  }
}
