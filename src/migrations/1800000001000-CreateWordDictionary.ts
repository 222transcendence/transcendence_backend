import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateWordDictionary1800000001000 implements MigrationInterface {
  name = 'CreateWordDictionary1800000001000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TYPE "word_dictionary_language_enum" AS ENUM('ko', 'en')`);
    await queryRunner.query(`CREATE TYPE "word_dictionary_content_type_enum" AS ENUM('word', 'phrase', 'sentence')`);
    await queryRunner.query(`CREATE TYPE "word_dictionary_difficulty_enum" AS ENUM('easy', 'normal', 'hard')`);
    await queryRunner.query(`CREATE TYPE "word_dictionary_category_enum" AS ENUM('common', 'tech', 'game', 'sentence')`);

    await queryRunner.query(`
      CREATE TABLE "word_dictionary" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "text" character varying NOT NULL,
        "language" "word_dictionary_language_enum" NOT NULL DEFAULT 'ko',
        "contentType" "word_dictionary_content_type_enum" NOT NULL DEFAULT 'word',
        "difficulty" "word_dictionary_difficulty_enum" NOT NULL DEFAULT 'normal',
        "category" "word_dictionary_category_enum" NOT NULL DEFAULT 'common',
        "length" integer NOT NULL,
        "keystrokes" integer NOT NULL,
        "source" character varying,
        "isActive" boolean NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_word_dictionary_text" UNIQUE ("text"),
        CONSTRAINT "CHK_word_dictionary_text_nonempty" CHECK ("text" <> ''),
        CONSTRAINT "PK_word_dictionary" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_word_dictionary_filter"
      ON "word_dictionary" ("language", "difficulty", "contentType", "isActive")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_word_dictionary_filter"`);
    await queryRunner.query(`DROP TABLE "word_dictionary"`);
    await queryRunner.query(`DROP TYPE "word_dictionary_category_enum"`);
    await queryRunner.query(`DROP TYPE "word_dictionary_difficulty_enum"`);
    await queryRunner.query(`DROP TYPE "word_dictionary_content_type_enum"`);
    await queryRunner.query(`DROP TYPE "word_dictionary_language_enum"`);
  }
}
