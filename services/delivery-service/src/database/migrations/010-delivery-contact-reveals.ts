import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #211: who was shown which participant's phone number for a delivery, for support disputes. Never the
 * number itself. One row per delivery, viewer and field: the first and last time it was shown and how
 * often, so the driver app's polling doesn't grow the table.
 */
export class DeliveryContactReveals1700000000009 implements MigrationInterface {
  name = 'DeliveryContactReveals1700000000009';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "delivery_contact_reveals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "deliveryId" uuid NOT NULL,
        "viewerUserId" uuid NOT NULL,
        "viewerRole" character varying(30) NOT NULL,
        "field" character varying(30) NOT NULL,
        "firstRevealedAt" timestamptz NOT NULL DEFAULT now(),
        "lastRevealedAt" timestamptz NOT NULL DEFAULT now(),
        "revealCount" integer NOT NULL DEFAULT 1,
        CONSTRAINT "PK_delivery_contact_reveals" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_delivery_contact_reveals" UNIQUE ("deliveryId", "viewerUserId", "field"),
        CONSTRAINT "CHK_delivery_contact_reveals_field" CHECK ("field" IN ('customerPhone', 'restaurantPhone', 'driverPhone'))
      )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "delivery_contact_reveals"');
  }
}
