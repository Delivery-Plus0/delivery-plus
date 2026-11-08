import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #207, second part: the review history. One row per staff decision, append-only: a trigger refuses
 * every UPDATE, so a decision can't be rewritten after the fact. Rows are deleted only with the driver
 * (account deletion, #233). Nothing is backfilled: earlier decisions left no record to copy.
 */
export class DriverReviews1700000000007 implements MigrationInterface {
  name = 'DriverReviews1700000000007';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "driver_reviews" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL,
        "reviewerUserId" uuid NOT NULL,
        "decision" character varying(20) NOT NULL,
        "note" character varying(300),
        "applicationSubmittedAt" timestamptz,
        "documentIds" uuid[] NOT NULL DEFAULT '{}',
        "reviewedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_driver_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "FK_driver_reviews_driver" FOREIGN KEY ("driverId") REFERENCES "drivers" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_driver_reviews_decision" CHECK ("decision" IN ('VERIFIED', 'REJECTED'))
      )`);
    await queryRunner.query('CREATE INDEX "IDX_driver_reviews_driver" ON "driver_reviews" ("driverId", "reviewedAt")');
    await queryRunner.query(`
      CREATE FUNCTION "driver_reviews_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'driver_reviews is append-only' USING ERRCODE = 'restrict_violation';
      END
      $$`);
    await queryRunner.query(
      'CREATE TRIGGER "TRG_driver_reviews_append_only" BEFORE UPDATE ON "driver_reviews" FOR EACH ROW EXECUTE FUNCTION "driver_reviews_append_only"()',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "driver_reviews"');
    await queryRunner.query('DROP FUNCTION "driver_reviews_append_only"()');
  }
}
