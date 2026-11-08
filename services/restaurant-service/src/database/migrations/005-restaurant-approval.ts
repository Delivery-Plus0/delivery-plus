import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #208: restaurant applications and approval.
 *
 * - `approvalStatus` is separate from the operating `status`, so a suspension and an approval never fight
 *   over one column. Every existing restaurant becomes APPROVED (it stays visible and keeps working);
 *   only restaurants created from now on start as a DRAFT.
 * - The application fields are all nullable: the submit endpoint decides what is required.
 * - `restaurant_reviews`: one append-only row per staff decision (an UPDATE trigger refuses changes),
 *   deleted only with the restaurant.
 */
export class RestaurantApproval1700000000004 implements MigrationInterface {
  name = 'RestaurantApproval1700000000004';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Backfill existing rows as APPROVED through the column default, then make new rows start as DRAFT.
    await queryRunner.query(`ALTER TABLE "restaurants" ADD COLUMN "approvalStatus" character varying(20) NOT NULL DEFAULT 'APPROVED'`);
    await queryRunner.query(`ALTER TABLE "restaurants" ALTER COLUMN "approvalStatus" SET DEFAULT 'DRAFT'`);
    await queryRunner.query(`
      ALTER TABLE "restaurants" ADD CONSTRAINT "CHK_restaurants_approval_status"
        CHECK ("approvalStatus" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'))`);
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "submittedAt" timestamptz');
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "approvedAt" timestamptz');
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "approvalNote" character varying(300)');
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "legalName" character varying(200)');
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "commercialRegistrationNumber" character varying(50)');
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "taxCardNumber" character varying(50)');
    await queryRunner.query('ALTER TABLE "restaurants" ADD COLUMN "contactPhone" character varying(20)');
    await queryRunner.query(`ALTER TABLE "restaurants" ADD COLUMN "cuisineTags" text[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`
      ALTER TABLE "restaurants" ADD CONSTRAINT "CHK_restaurants_contact_phone"
        CHECK ("contactPhone" IS NULL OR "contactPhone" ~ '^\\+201[0125][0-9]{8}$')`);
    await queryRunner.query(`ALTER TABLE "restaurants" ADD CONSTRAINT "CHK_restaurants_cuisine_tags" CHECK (cardinality("cuisineTags") <= 5)`);
    // The review queue: submitted restaurants, oldest first.
    await queryRunner.query(
      `CREATE INDEX "IDX_restaurants_review_queue" ON "restaurants" ("submittedAt" ASC, "id" ASC) WHERE "approvalStatus" = 'SUBMITTED'`,
    );

    await queryRunner.query(`
      CREATE TABLE "restaurant_reviews" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "restaurantId" uuid NOT NULL,
        "reviewerUserId" uuid NOT NULL,
        "decision" character varying(20) NOT NULL,
        "note" character varying(300),
        "applicationSubmittedAt" timestamptz NOT NULL,
        "reviewedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_restaurant_reviews" PRIMARY KEY ("id"),
        CONSTRAINT "FK_restaurant_reviews_restaurant" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE,
        CONSTRAINT "CHK_restaurant_reviews_decision" CHECK ("decision" IN ('APPROVED', 'REJECTED'))
      )`);
    await queryRunner.query('CREATE INDEX "IDX_restaurant_reviews_restaurant" ON "restaurant_reviews" ("restaurantId", "reviewedAt")');
    await queryRunner.query(`
      CREATE FUNCTION "restaurant_reviews_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'restaurant_reviews is append-only' USING ERRCODE = 'restrict_violation';
      END
      $$`);
    await queryRunner.query(
      'CREATE TRIGGER "TRG_restaurant_reviews_append_only" BEFORE UPDATE ON "restaurant_reviews" FOR EACH ROW EXECUTE FUNCTION "restaurant_reviews_append_only"()',
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "restaurant_reviews"');
    await queryRunner.query('DROP FUNCTION "restaurant_reviews_append_only"()');
    await queryRunner.query('DROP INDEX "IDX_restaurants_review_queue"');
    await queryRunner.query('ALTER TABLE "restaurants" DROP CONSTRAINT "CHK_restaurants_cuisine_tags"');
    await queryRunner.query('ALTER TABLE "restaurants" DROP CONSTRAINT "CHK_restaurants_contact_phone"');
    await queryRunner.query('ALTER TABLE "restaurants" DROP CONSTRAINT "CHK_restaurants_approval_status"');
    for (const column of [
      'cuisineTags',
      'contactPhone',
      'taxCardNumber',
      'commercialRegistrationNumber',
      'legalName',
      'approvalNote',
      'approvedAt',
      'submittedAt',
      'approvalStatus',
    ]) {
      await queryRunner.query(`ALTER TABLE "restaurants" DROP COLUMN "${column}"`);
    }
  }
}
