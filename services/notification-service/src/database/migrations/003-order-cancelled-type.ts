import { MigrationInterface, QueryRunner } from 'typeorm';

/** Notification type for orders the restaurant or the platform cancels (#154). */
export class OrderCancelledType1700000000002 implements MigrationInterface {
  name = 'OrderCancelledType1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "notification_type" ADD VALUE IF NOT EXISTS 'ORDER_CANCELLED'`);
  }

  public async down(): Promise<void> {
    // PostgreSQL can't drop an enum value; leaving it is harmless.
  }
}
