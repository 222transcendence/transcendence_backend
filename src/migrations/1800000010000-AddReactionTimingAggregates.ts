import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddReactionTimingAggregates1800000010000 implements MigrationInterface {
  name = 'AddReactionTimingAggregates1800000010000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "participant_performances"
        ADD COLUMN "avgQueueTimeMs" double precision,
        ADD COLUMN "avgAcquisitionTimeMs" double precision,
        ADD COLUMN "avgInitialReactionTimeMs" double precision
    `);

    await queryRunner.query(`
      WITH ordered AS (
        SELECT
          a."matchId",
          a."participantId",
          a."wordSpawnedAt",
          a."firstTypingAt",
          MAX(a."submitReceivedAt") OVER (
            PARTITION BY a."matchId", a."participantId"
            ORDER BY a."firstTypingAt"
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
          ) AS "previousSubmitAt"
        FROM "word_attempt_records" a
        WHERE a."wordSpawnedAt" IS NOT NULL
          AND a."firstTypingAt" IS NOT NULL
      ), aggregates AS (
        SELECT
          "matchId",
          "participantId",
          AVG(GREATEST(0, EXTRACT(EPOCH FROM
            (COALESCE("previousSubmitAt", "wordSpawnedAt") - "wordSpawnedAt")
          ) * 1000)) AS "avgQueueTimeMs",
          AVG(GREATEST(0, EXTRACT(EPOCH FROM
            ("firstTypingAt" - GREATEST(
              "wordSpawnedAt", COALESCE("previousSubmitAt", "wordSpawnedAt")
            ))
          ) * 1000)) AS "avgAcquisitionTimeMs",
          AVG(GREATEST(0, EXTRACT(EPOCH FROM
            ("firstTypingAt" - "wordSpawnedAt")
          ) * 1000)) FILTER (
            WHERE "previousSubmitAt" IS NULL
              OR "previousSubmitAt" <= "wordSpawnedAt"
          ) AS "avgInitialReactionTimeMs"
        FROM ordered
        GROUP BY "matchId", "participantId"
      )
      UPDATE "participant_performances" p
      SET "avgQueueTimeMs" = a."avgQueueTimeMs",
          "avgAcquisitionTimeMs" = a."avgAcquisitionTimeMs",
          "avgInitialReactionTimeMs" = a."avgInitialReactionTimeMs"
      FROM aggregates a
      WHERE p."matchId" = a."matchId"
        AND p."participantId" = a."participantId"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "participant_performances"
        DROP COLUMN "avgInitialReactionTimeMs",
        DROP COLUMN "avgAcquisitionTimeMs",
        DROP COLUMN "avgQueueTimeMs"
    `);
  }
}
