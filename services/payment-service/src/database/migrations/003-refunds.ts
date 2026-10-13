import { MigrationInterface, QueryRunner } from 'typeorm';

/** The refund audit table (#56): one refund per payment, written with the payment's move to REFUNDED. */
export class Refunds1700000000002 implements MigrationInterface {
  name = 'Refunds1700000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "refunds" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "paymentId" uuid NOT NULL,
        "orderId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "currency" character varying(3) NOT NULL,
        "initiatedBy" character varying(20) NOT NULL,
        "requestedBy" character varying(255),
        "reason" character varying(300) NOT NULL,
        "source" character varying(120) NOT NULL,
        "provider" character varying(20) NOT NULL,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_refunds" PRIMARY KEY ("id"),
        CONSTRAINT "FK_refunds_payment" FOREIGN KEY ("paymentId") REFERENCES "payments"("id")
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_refunds_payment" ON "refunds" ("paymentId")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_refunds_orderId" ON "refunds" ("orderId")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "refunds"`);
  }
}
