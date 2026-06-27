import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddGameSchema1717400000000 implements MigrationInterface {
  name = 'AddGameSchema1717400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

    await queryRunner.query(`
      CREATE TABLE "match_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "hostUserId" uuid NOT NULL,
        "guestUserId" uuid NOT NULL,
        "winnerId" uuid,
        "turnsPlayed" integer NOT NULL,
        "matchData" jsonb NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_match_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_match_history_host" FOREIGN KEY ("hostUserId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_history_guest" FOREIGN KEY ("guestUserId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_history_winner" FOREIGN KEY ("winnerId") REFERENCES "users"("id") ON DELETE SET NULL
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_match_history_host" ON "match_history" ("hostUserId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_match_history_guest" ON "match_history" ("guestUserId")`,
    );

    // Seed: starting characters.
    // MAGE values come from 게임 기능 명세서/게임 기능 명세서 - 캐릭터_마법사.md (HP12/ATK7/DEF7
    // + 정밀사격/전격/가시나무 숲/지략). WARRIOR/ROGUE have no design doc yet, so they are
    // seeded with the same base stats and no skills as a placeholder (see follow-up issue).
    await queryRunner.query(`
      INSERT INTO "characters" ("name", "baseHp", "baseAtk", "baseDef", "skills") VALUES
      ('MAGE', 12, 7, 7, '[
        {"name":"정밀사격","triggerDistance":"중/원거리","triggerPhase":"공격","requiredCards":"총2장 이상","effect":"ATK+6"},
        {"name":"전격","triggerDistance":"근거리","triggerPhase":"공격","requiredCards":"특수2장 이상","effect":"ATK+4, 입힌 대미지만큼 상대 카드 파괴"},
        {"name":"가시나무 숲","triggerDistance":"근거리","triggerPhase":"방어","requiredCards":"방어2장+특수1장 이상","effect":"DEF+7, 방어 성공 시 방어력-공격력 차만큼 데미지"},
        {"name":"지략","triggerDistance":"전거리","triggerPhase":"이동","requiredCards":"아무거나 3장 이상","effect":"카드 2장 추가 드로우"}
      ]'),
      ('WARRIOR', 12, 7, 7, '[]'),
      ('ROGUE', 12, 7, 7, '[]')
    `);

    // Seed: starting deck (MOVE x5, ATK_SWORD x4, ATK_GUN x4, DEF x4, SPECIAL x3 = 20 cards).
    // value_top/value_bottom are provisional placeholders pending game balancing
    // (see architecture_design/DATABASE_DESIGN.md).
    await queryRunner.query(`
      INSERT INTO "cards" ("type", "valueTop", "valueBottom") VALUES
      ('MOVE', 1, 0), ('MOVE', 2, 0), ('MOVE', 3, 0), ('MOVE', 4, 0), ('MOVE', 5, 0),
      ('ATK_SWORD', 2, 1), ('ATK_SWORD', 3, 1), ('ATK_SWORD', 4, 2), ('ATK_SWORD', 5, 2),
      ('ATK_GUN', 2, 1), ('ATK_GUN', 3, 1), ('ATK_GUN', 4, 2), ('ATK_GUN', 5, 2),
      ('DEF', 2, 1), ('DEF', 3, 1), ('DEF', 4, 2), ('DEF', 5, 2),
      ('SPECIAL', 1, 1), ('SPECIAL', 2, 1), ('SPECIAL', 3, 2)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_match_history_guest"`);
    await queryRunner.query(`DROP INDEX "IDX_match_history_host"`);
    await queryRunner.query(`DROP TABLE "match_history"`);
    await queryRunner.query(`DROP TABLE "cards"`);
    await queryRunner.query(`DROP TYPE "cards_type_enum"`);
    await queryRunner.query(`DROP TABLE "characters"`);
  }
}
