import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #151: each notification also stores a message key and its parameters, so the apps render it in the
 * reader's language. `title`/`message` stay (English) for older clients. Older rows stay null and are
 * shown as stored.
 */
export class NotificationMessageKey1700000000003 implements MigrationInterface {
  name = 'NotificationMessageKey1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "messageKey" character varying(64)`);
    await queryRunner.query(`ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "params" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "params"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP COLUMN IF EXISTS "messageKey"`);
  }
}
