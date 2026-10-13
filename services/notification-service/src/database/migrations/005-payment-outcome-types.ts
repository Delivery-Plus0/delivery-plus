import { MigrationInterface, QueryRunner } from 'typeorm';

/** Notification types for a declined payment and a refunded one (#53/#56). */
export class PaymentOutcomeTypes1700000000004 implements MigrationInterface {
  name = 'PaymentOutcomeTypes1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PAYMENT_FAILED'`);
    await queryRunner.query(`ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'PAYMENT_REFUNDED'`);
  }

  public async down(): Promise<void> {
    // PostgreSQL can't drop an enum value; leaving them is harmless.
  }
}
