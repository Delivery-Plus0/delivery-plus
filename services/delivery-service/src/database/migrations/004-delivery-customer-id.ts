import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stores the order's customer on the delivery, so delivery events can say whom to notify (#5).
 * Additive and nullable: deliveries created before this migration keep NULL and their events carry
 * no customerId (notification-service skips those instead of guessing a recipient).
 */
export class DeliveryCustomerId1700000000003 implements MigrationInterface {
  name = 'DeliveryCustomerId1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "customerId" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "customerId"`);
  }
}
