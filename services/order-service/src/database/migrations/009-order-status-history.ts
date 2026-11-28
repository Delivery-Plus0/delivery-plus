import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #217: every status change of an order, written in the same transaction as the change itself (the
 * compare-and-set in OrdersRepository.updateStatus) and at creation. Orders placed before this migration
 * have no history: it can't be rebuilt (the outbox rows are relayed and pruned, not kept).
 */
export class OrderStatusHistory1700000000008 implements MigrationInterface {
  name = 'OrderStatusHistory1700000000008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "order_status_history" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "orderId" uuid NOT NULL,
        "fromStatus" character varying(30),
        "toStatus" character varying(30) NOT NULL,
        "actorType" character varying(20) NOT NULL,
        "actorId" character varying(100),
        "reason" character varying(500),
        "at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT "PK_order_status_history" PRIMARY KEY ("id"),
        CONSTRAINT "FK_order_status_history_order" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_order_status_history_actor" CHECK ("actorType" IN ('CUSTOMER', 'RESTAURANT', 'DRIVER', 'SYSTEM', 'STAFF'))
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_order_status_history_order_at" ON "order_status_history" ("orderId", "at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "order_status_history"`);
  }
}
