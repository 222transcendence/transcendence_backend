import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSystemChatMessageType1800000004000 implements MigrationInterface {
  name = 'AddSystemChatMessageType1800000004000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // MessageType.SYSTEM이 엔티티에는 있었지만 이 값을 실제 DB enum에 추가하는
    // 마이그레이션이 누락되어 있었다 — SYSTEM 메시지를 저장하면 항상
    // "invalid input value for enum" 에러가 발생하고 있었다.
    await queryRunner.query(`
      ALTER TYPE "public"."chat_messages_type_enum" ADD VALUE IF NOT EXISTS 'SYSTEM'
    `);
  }

  async down(): Promise<void> {
    // Postgres는 enum에서 값을 제거하는 것을 직접 지원하지 않는다.
    // 되돌리려면 새 타입을 만들고 컬럼을 마이그레이션해야 하며, 이 마이그레이션
    // 범위를 벗어난다 — down은 의도적으로 no-op.
  }
}
