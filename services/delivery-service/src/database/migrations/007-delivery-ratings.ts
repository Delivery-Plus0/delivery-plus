import { MigrationInterface, QueryRunner } from 'typeorm';

/** Driver ratings (#144): one rating per delivery, plus each driver's running count and sum. */
export class DeliveryRatings1700000000006 implements MigrationInterface {
  name = 'DeliveryRatings1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "delivery_ratings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "deliveryId" uuid NOT NULL,
        "driverId" character varying NOT NULL,
        "customerId" uuid NOT NULL,
        "score" smallint NOT NULL,
        "comment" character varying(500),
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_delivery_ratings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_delivery_ratings_score" CHECK ("score" BETWEEN 1 AND 5)
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_delivery_ratings_delivery" ON "delivery_ratings" ("deliveryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_delivery_ratings_driver_created" ON "delivery_ratings" ("driverId", "createdAt")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "driver_rating_summaries" (
        "driverId" character varying NOT NULL,
        "ratingCount" integer NOT NULL DEFAULT 0,
        "ratingSum" integer NOT NULL DEFAULT 0,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_driver_rating_summaries" PRIMARY KEY ("driverId")
      )`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "driver_rating_summaries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "delivery_ratings"`);
  }
}
