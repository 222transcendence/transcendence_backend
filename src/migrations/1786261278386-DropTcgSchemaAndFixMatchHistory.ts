import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropTcgSchemaAndFixMatchHistory1786261278386
  implements MigrationInterface
{
  name = 'DropTcgSchemaAndFixMatchHistory1786261278386';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 산성비(Acid Rain) 전환으로 카드/캐릭터 개념이 폐기됨 (architecture_design/GAME_DESIGN.md §5).
    await queryRunner.query(`DROP TABLE IF EXISTS "cards"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "cards_type_enum"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "characters"`);

    // DATABASE_DESIGN.md의 MatchHistory 정의와 컬럼명을 맞춘다: turnsPlayed -> roundsPlayed.
    await queryRunner.query(
      `ALTER TABLE "match_history" RENAME COLUMN "turnsPlayed" TO "roundsPlayed"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "match_history" RENAME COLUMN "roundsPlayed" TO "turnsPlayed"`,
    );

    await queryRunner.query(`
      CREATE TABLE "characters" (
        "id" SERIAL NOT NULL,
        "name" character varying NOT NULL,
        "baseHp" integer NOT NULL,
        "baseAtk" integer NOT NULL,
        "baseDef" integer NOT NULL,
        "skills" jsonb NOT NULL DEFAULT '[]',
        CONSTRAINT "UQ_characters_name" UNIQUE ("name"),
        CONSTRAINT "PK_characters" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE TYPE "cards_type_enum" AS ENUM('MOVE', 'ATK_SWORD', 'ATK_GUN', 'DEF', 'SPECIAL')`,
    );
    await queryRunner.query(`
      CREATE TABLE "cards" (
        "id" SERIAL NOT NULL,
        "type" "cards_type_enum" NOT NULL,
        "valueTop" integer NOT NULL,
        "valueBottom" integer NOT NULL,
        CONSTRAINT "PK_cards" PRIMARY KEY ("id")
      )
    `);
  }
}
