import { MigrationInterface, QueryRunner } from 'typeorm';

/** Driver earnings ledger (#145): append-only, one entry per (delivery, type). */
export class DriverLedger1700000000007 implements MigrationInterface {
  name = 'DriverLedger1700000000007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "driver_ledger_entries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "driverId" character varying NOT NULL,
        "deliveryId" uuid NOT NULL,
        "orderId" uuid NOT NULL,
        "type" character varying(40) NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "status" character varying(20) NOT NULL,
        "availableAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "settledAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_driver_ledger_entries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_driver_ledger_status" CHECK ("status" IN ('PENDING', 'AVAILABLE'))
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_driver_ledger_delivery_type" ON "driver_ledger_entries" ("deliveryId", "type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_driver_ledger_driver_created" ON "driver_ledger_entries" ("driverId", "createdAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "driver_ledger_entries"`);
  }
}
