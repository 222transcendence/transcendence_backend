import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddFriendSchema1717320000000 implements MigrationInterface {
  name = 'AddFriendSchema1717320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "friends_status_enum" AS ENUM('PENDING', 'ACCEPTED')`,
    );

    await queryRunner.query(`
      CREATE TABLE "friends" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "requesterId" uuid NOT NULL,
        "receiverId" uuid NOT NULL,
        "status" "friends_status_enum" NOT NULL DEFAULT 'PENDING',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_friends" PRIMARY KEY ("id"),
        CONSTRAINT "FK_friends_requester" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_friends_receiver" FOREIGN KEY ("receiverId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_friends_direction" UNIQUE ("requesterId", "receiverId")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_friends_requester_status" ON "friends" ("requesterId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_friends_receiver_status" ON "friends" ("receiverId", "status")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_friends_receiver_status"`);
    await queryRunner.query(`DROP INDEX "IDX_friends_requester_status"`);
    await queryRunner.query(`DROP TABLE "friends"`);
    await queryRunner.query(`DROP TYPE "friends_status_enum"`);
  }
}
