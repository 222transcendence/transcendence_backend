import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateChatMessages1750000000000 implements MigrationInterface {
  name = 'CreateChatMessages1750000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."chat_messages_type_enum" AS ENUM('NORMAL', 'INVITE')
    `);

    await queryRunner.query(`
      CREATE TABLE "chat_messages" (
        "id"        uuid NOT NULL DEFAULT uuid_generate_v4(),
        "content"   text NOT NULL,
        "roomId"    character varying,
        "type"      "public"."chat_messages_type_enum" NOT NULL DEFAULT 'NORMAL',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "senderId"  uuid,
        CONSTRAINT "PK_chat_messages" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        ADD CONSTRAINT "FK_chat_messages_sender"
        FOREIGN KEY ("senderId")
        REFERENCES "users"("id")
        ON DELETE CASCADE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "chat_messages" DROP CONSTRAINT "FK_chat_messages_sender"`,
    );
    await queryRunner.query(`DROP TABLE "chat_messages"`);
    await queryRunner.query(`DROP TYPE "public"."chat_messages_type_enum"`);
  }
}
