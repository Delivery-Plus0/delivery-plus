import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Driver delivery history (#142): when each stage happened, and an index for "this driver's
 * deliveries, newest first". Additive and nullable. Finished deliveries from before this migration
 * get their last update time as the delivered/cancelled time: a terminal delivery is never updated
 * again, so that is when it finished. Their pickup time is unknown and stays null.
 */
export class DeliveryStageTimes1700000000005 implements MigrationInterface {
  name = 'DeliveryStageTimes1700000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "pickedUpAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `UPDATE "deliveries" SET "deliveredAt" = "updatedAt" WHERE "status" = 'DELIVERED' AND "deliveredAt" IS NULL`,
    );
    await queryRunner.query(
      `UPDATE "deliveries" SET "cancelledAt" = "updatedAt" WHERE "status" = 'CANCELLED' AND "cancelledAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_deliveries_driver_updated" ON "deliveries" ("driverId", "updatedAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deliveries_driver_updated"`);
    await queryRunner.query(`ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "cancelledAt"`);
    await queryRunner.query(`ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "deliveredAt"`);
    await queryRunner.query(`ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "pickedUpAt"`);
  }
}
