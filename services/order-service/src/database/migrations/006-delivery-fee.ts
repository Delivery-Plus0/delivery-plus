import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Delivery fee and its split (#145), stored per order at checkout. Additive and nullable.
 * Orders from before fees existed had no fee: they get subtotal = total, fee 0 and zero shares, so
 * nothing they cost or earned changes.
 */
export class DeliveryFee1700000000005 implements MigrationInterface {
  name = 'DeliveryFee1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['subtotalAmount', 'deliveryFee', 'driverFeeShare', 'platformFeeShare', 'driverCancelFeeShare']) {
      await queryRunner.query(`ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "${column}" numeric(10,2)`);
    }
    await queryRunner.query(`
      UPDATE "orders"
         SET "subtotalAmount" = "totalAmount", "deliveryFee" = 0,
             "driverFeeShare" = 0, "platformFeeShare" = 0, "driverCancelFeeShare" = 0
       WHERE "deliveryFee" IS NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ['driverCancelFeeShare', 'platformFeeShare', 'driverFeeShare', 'deliveryFee', 'subtotalAmount']) {
      await queryRunner.query(`ALTER TABLE "orders" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
