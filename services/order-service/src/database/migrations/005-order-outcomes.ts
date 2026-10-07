import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Order outcomes (#143): who ended an order and why, and the payment status order-service learns
 * from payment events. Additive and nullable.
 *
 * Backfill only what the stored status proves: a FAILED order was ended by a declined payment
 * (FAILED is only ever set from payment), and its payment FAILED; a PAYMENT_PENDING order's payment
 * is PENDING; an order past CONFIRMED was paid. Older CANCELLED orders keep both unknown (null):
 * who cancelled them, and whether they had been paid, was never recorded.
 */
export class OrderOutcomes1700000000004 implements MigrationInterface {
  name = 'OrderOutcomes1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancelledBy" character varying(20)`);
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "cancellationReason" character varying(300)`);
    await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "paymentStatus" character varying(20)`);

    await queryRunner.query(`
      UPDATE "orders"
         SET "cancelledBy" = 'PAYMENT',
             "cancellationReason" = 'Your payment was declined, so the order was not placed.',
             "paymentStatus" = 'FAILED'
       WHERE "status" = 'FAILED' AND "cancelledBy" IS NULL`);
    await queryRunner.query(`UPDATE "orders" SET "paymentStatus" = 'PENDING' WHERE "status" = 'PAYMENT_PENDING' AND "paymentStatus" IS NULL`);
    await queryRunner.query(`
      UPDATE "orders" SET "paymentStatus" = 'COMPLETED'
       WHERE "status" IN ('CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP', 'DRIVER_ASSIGNED', 'PICKED_UP', 'DELIVERED')
         AND "paymentStatus" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "paymentStatus"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "cancellationReason"`);
    await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "cancelledBy"`);
  }
}
