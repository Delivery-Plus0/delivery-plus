import { MigrationInterface, QueryRunner } from 'typeorm';

/** #215: the notification type for staff decisions about a person's account, application or listing. */
export class AccountUpdateType1700000000005 implements MigrationInterface {
  name = 'AccountUpdateType1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'ACCOUNT_UPDATE'`);
  }

  public async down(): Promise<void> {
    // PostgreSQL can't drop an enum value; leaving it is harmless.
  }
}
