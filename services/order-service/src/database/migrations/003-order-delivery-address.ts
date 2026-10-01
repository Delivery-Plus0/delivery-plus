import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the drop-off address snapshot to orders. Additive only: the columns are nullable, so
 * existing orders stay valid and the change is safe to run before the new code is deployed.
 */
export class OrderDeliveryAddress1700000000002 implements MigrationInterface {
  name = 'OrderDeliveryAddress1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
        ADD COLUMN IF NOT EXISTS "deliveryAddress" varchar(500),
        ADD COLUMN IF NOT EXISTS "deliveryNotes" varchar(500),
        ADD COLUMN IF NOT EXISTS "deliveryLatitude" double precision,
        ADD COLUMN IF NOT EXISTS "deliveryLongitude" double precision
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orders"
        DROP COLUMN IF EXISTS "deliveryLongitude",
        DROP COLUMN IF EXISTS "deliveryLatitude",
        DROP COLUMN IF EXISTS "deliveryNotes",
        DROP COLUMN IF EXISTS "deliveryAddress"
    `);
  }
}
