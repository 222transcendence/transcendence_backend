import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePerformanceTables1800000005000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "keystroke_records" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "matchId"          uuid NOT NULL,
        "participantId"    varchar NOT NULL,
        "userId"           varchar,
        "wordId"           varchar NOT NULL,
        "sequence"         integer NOT NULL,
        "partialText"      varchar NOT NULL,
        "textLength"       integer NOT NULL,
        "inputType"        varchar NOT NULL DEFAULT 'PROGRESS',
        "clientTs"         bigint,
        "serverReceivedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_keystroke_records" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_keystroke_match_part_word" ON "keystroke_records" ("matchId","participantId","wordId")`);
    await queryRunner.query(`CREATE INDEX "IDX_keystroke_received_at"     ON "keystroke_records" ("serverReceivedAt")`);

    await queryRunner.query(`
      CREATE TABLE "word_attempt_records" (
        "id"               uuid NOT NULL DEFAULT uuid_generate_v4(),
        "matchId"          uuid NOT NULL,
        "participantId"    varchar NOT NULL,
        "userId"           varchar,
        "wordId"           varchar NOT NULL,
        "attemptNo"        integer NOT NULL DEFAULT 1,
        "result"           varchar NOT NULL,
        "wordSpawnedAt"    TIMESTAMPTZ,
        "firstTypingAt"    TIMESTAMPTZ,
        "lastTypingAt"     TIMESTAMPTZ,
        "submitReceivedAt" TIMESTAMPTZ,
        "resolvedAt"       TIMESTAMPTZ NOT NULL,
        "submittedText"    varchar,
        "typoCount"        integer NOT NULL DEFAULT 0,
        "correctionCount"  integer NOT NULL DEFAULT 0,
        "totalKeystrokes"  integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_word_attempt_records" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_word_attempt_match_part"  ON "word_attempt_records" ("matchId","participantId")`);
    await queryRunner.query(`CREATE INDEX "IDX_word_attempt_match_word"  ON "word_attempt_records" ("matchId","wordId")`);

    await queryRunner.query(`
      CREATE TABLE "participant_performances" (
        "id"                  uuid NOT NULL DEFAULT uuid_generate_v4(),
        "matchId"             uuid NOT NULL,
        "participantId"       varchar NOT NULL,
        "userId"              varchar,
        "participantType"     varchar NOT NULL,
        "mode"                varchar NOT NULL,
        "resultStatus"        varchar NOT NULL,
        "correctWords"        integer NOT NULL DEFAULT 0,
        "wrongAttempts"       integer NOT NULL DEFAULT 0,
        "missedWords"         integer NOT NULL DEFAULT 0,
        "typoCount"           integer NOT NULL DEFAULT 0,
        "correctionCount"     integer NOT NULL DEFAULT 0,
        "abandonedWords"      integer NOT NULL DEFAULT 0,
        "totalKeystrokes"     integer NOT NULL DEFAULT 0,
        "typingWpm"           float,
        "accuracy"            float,
        "avgReactionTimeMs"   float,
        "medianReactionTimeMs" float,
        "avgCompletionTimeMs" float,
        "sampleCount"         integer NOT NULL DEFAULT 0,
        "typingDurationMs"    integer,
        "createdAt"           TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_participant_performances" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_perf_match_id"       ON "participant_performances" ("matchId")`);
    await queryRunner.query(`CREATE INDEX "IDX_perf_user_id"        ON "participant_performances" ("userId")`);
    await queryRunner.query(`CREATE INDEX "IDX_perf_type_status"    ON "participant_performances" ("participantType","resultStatus")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "participant_performances"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "word_attempt_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "keystroke_records"`);
  }
}
