import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateMatchParticipants1800000002000 implements MigrationInterface {
  name = 'CreateMatchParticipants1800000002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // match_participants 테이블 생성
    await queryRunner.query(`
      CREATE TABLE "match_participants" (
        "id"       UUID NOT NULL DEFAULT gen_random_uuid(),
        "matchId"  UUID NOT NULL,
        "userId"   UUID NOT NULL,
        "finalHp"  INTEGER NOT NULL DEFAULT 0,
        "rank"     INTEGER NOT NULL DEFAULT 0,
        CONSTRAINT "PK_match_participants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_match_participants_match"
          FOREIGN KEY ("matchId") REFERENCES "match_history"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_match_participants_user"
          FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_match_participants_matchId"
        ON "match_participants" ("matchId")
    `);

    // 기존 2인 매치 데이터 백필 — hostUser
    await queryRunner.query(`
      INSERT INTO "match_participants" ("matchId", "userId", "finalHp", "rank")
      SELECT
        mh."id",
        mh."hostUserId",
        COALESCE(
          (mh."matchData"->'finalHp'->>'host')::int,
          0
        ),
        CASE
          WHEN mh."winnerId" = mh."hostUserId" THEN 1
          WHEN mh."winnerId" IS NULL THEN 1  -- 무승부: 공동 1위
          ELSE 2
        END
      FROM "match_history" mh
      WHERE mh."hostUserId" IS NOT NULL
    `);

    // 기존 2인 매치 데이터 백필 — guestUser
    await queryRunner.query(`
      INSERT INTO "match_participants" ("matchId", "userId", "finalHp", "rank")
      SELECT
        mh."id",
        mh."guestUserId",
        COALESCE(
          (mh."matchData"->'finalHp'->>'guest')::int,
          0
        ),
        CASE
          WHEN mh."winnerId" = mh."guestUserId" THEN 1
          WHEN mh."winnerId" IS NULL THEN 1  -- 무승부: 공동 1위
          ELSE 2
        END
      FROM "match_history" mh
      WHERE mh."guestUserId" IS NOT NULL
    `);

    // hostUser/guestUser FK를 nullable로 변경 (N인 매치는 participants만 사용)
    await queryRunner.query(`
      ALTER TABLE "match_history"
        ALTER COLUMN "hostUserId" DROP NOT NULL,
        ALTER COLUMN "guestUserId" DROP NOT NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "match_history"
        ALTER COLUMN "hostUserId" SET NOT NULL,
        ALTER COLUMN "guestUserId" SET NOT NULL
    `);
    await queryRunner.query(`DROP INDEX "IDX_match_participants_matchId"`);
    await queryRunner.query(`DROP TABLE "match_participants"`);
  }
}
