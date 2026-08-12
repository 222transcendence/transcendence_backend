import { MigrationInterface, QueryRunner } from 'typeorm';

export class NullableChatMessageSender1800000003000 implements MigrationInterface {
  name = 'NullableChatMessageSender1800000003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // SYSTEM 메시지는 실제 User가 보내지 않으므로 senderId를 nullable로 변경
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        DROP CONSTRAINT IF EXISTS "FK_chat_messages_senderId"
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        ALTER COLUMN "senderId" DROP NOT NULL
    `);
    // 실제 FK 제약 이름은 TypeORM 자동 생성명을 따르므로 존재하는 제약을 조회해 재생성
    await queryRunner.query(`
      DO $$
      DECLARE
        fk_name text;
      BEGIN
        SELECT constraint_name INTO fk_name
        FROM information_schema.table_constraints
        WHERE table_name = 'chat_messages'
          AND constraint_type = 'FOREIGN KEY';
        IF fk_name IS NOT NULL THEN
          EXECUTE format('ALTER TABLE "chat_messages" DROP CONSTRAINT %I', fk_name);
        END IF;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        ADD CONSTRAINT "FK_chat_messages_senderId"
        FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE SET NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        DROP CONSTRAINT IF EXISTS "FK_chat_messages_senderId"
    `);
    await queryRunner.query(`
      DELETE FROM "chat_messages" WHERE "senderId" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        ALTER COLUMN "senderId" SET NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "chat_messages"
        ADD CONSTRAINT "FK_chat_messages_senderId"
        FOREIGN KEY ("senderId") REFERENCES "users"("id") ON DELETE CASCADE
    `);
  }
}
