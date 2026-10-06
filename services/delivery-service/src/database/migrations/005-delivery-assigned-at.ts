import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records when a delivery's driver assignment was accepted (#46, assignment contract). Additive and
 * nullable. Deliveries assigned before this migration get their last update time as an approximation;
 * they are historical (assignment is never repeated), so nothing downstream relies on it being exact.
 */
export class DeliveryAssignedAt1700000000004 implements MigrationInterface {
  name = 'DeliveryAssignedAt1700000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" ADD COLUMN IF NOT EXISTS "assignedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(
      `UPDATE "deliveries" SET "assignedAt" = "updatedAt" WHERE "driverId" IS NOT NULL AND "assignedAt" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "deliveries" DROP COLUMN IF EXISTS "assignedAt"`);
  }
}
