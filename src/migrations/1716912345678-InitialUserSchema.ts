import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialUserSchema1716912345678 implements MigrationInterface {
  name = 'InitialUserSchema1716912345678';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Create status enum type
    await queryRunner.query(
      `CREATE TYPE "users_status_enum" AS ENUM('ONLINE', 'OFFLINE', 'IN_GAME')`,
    );

    // 2. Create users table
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "email" character varying NOT NULL,
        "nickname" character varying NOT NULL,
        "password" character varying,
        "avatar" character varying NOT NULL DEFAULT 'default_avatar.png',
        "status" "users_status_enum" NOT NULL DEFAULT 'OFFLINE',
        "wins" integer NOT NULL DEFAULT 0,
        "losses" integer NOT NULL DEFAULT 0,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_email" UNIQUE ("email"),
        CONSTRAINT "UQ_nickname" UNIQUE ("nickname"),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 1. Drop users table
    await queryRunner.query(`DROP TABLE "users"`);

    // 2. Drop status enum type
    await queryRunner.query(`DROP TYPE "users_status_enum"`);
  }
}
