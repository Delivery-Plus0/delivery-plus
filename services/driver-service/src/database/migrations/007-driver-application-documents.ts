import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #207: the driver application. Every new column is nullable and nothing is backfilled, so existing
 * drivers keep their verification status: VERIFIED drivers stay on the road, and PENDING ones become
 * drafts (PENDING with no `submittedAt`) that must upload documents and submit before review.
 *
 * - drivers: the national ID's last four digits and its HMAC (unique: one ID, one driver account), the
 *   two licence expiry dates and `submittedAt`.
 * - driver_documents: one row per uploaded version of each document, at most 5 per type.
 * - driver_document_access: who read which document and when; no URL, no foreign keys.
 */
export class DriverApplicationDocuments1700000000006 implements MigrationInterface {
  name = 'DriverApplicationDocuments1700000000006';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE "drivers" ADD COLUMN "submittedAt" timestamptz');
    await queryRunner.query('ALTER TABLE "drivers" ADD COLUMN "nationalIdLast4" character varying(4)');
    await queryRunner.query('ALTER TABLE "drivers" ADD COLUMN "nationalIdHash" character varying(64)');
    await queryRunner.query('ALTER TABLE "drivers" ADD COLUMN "drivingLicenceExpiresOn" date');
    await queryRunner.query('ALTER TABLE "drivers" ADD COLUMN "vehicleLicenceExpiresOn" date');
    await queryRunner.query(`
      ALTER TABLE "drivers" ADD CONSTRAINT "CHK_drivers_national_id" CHECK (
        ("nationalIdLast4" IS NULL AND "nationalIdHash" IS NULL)
        OR ("nationalIdLast4" IS NOT NULL AND "nationalIdHash" IS NOT NULL
            AND "nationalIdLast4" ~ '^[0-9]{4}$' AND "nationalIdHash" ~ '^[0-9a-f]{64}$')
      )`);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_drivers_national_id_hash" ON "drivers" ("nationalIdHash") WHERE "nationalIdHash" IS NOT NULL');
    // The review queue: submitted drivers waiting for a decision, oldest first.
    await queryRunner.query(`CREATE INDEX "IDX_drivers_review_queue" ON "drivers" ("submittedAt" ASC, "id" ASC) WHERE "verificationStatus" = 'PENDING' AND "submittedAt" IS NOT NULL`);

    await queryRunner.query(`
      CREATE TABLE "driver_documents" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "driverId" uuid NOT NULL,
        "type" character varying(30) NOT NULL,
        "version" integer NOT NULL,
        "isCurrent" boolean NOT NULL DEFAULT true,
        "objectKey" character varying(255) NOT NULL,
        "contentType" character varying(30) NOT NULL,
        "sizeBytes" integer NOT NULL,
        "sha256" character(64) NOT NULL,
        "uploadedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_driver_documents" PRIMARY KEY ("id"),
        CONSTRAINT "FK_driver_documents_driver" FOREIGN KEY ("driverId") REFERENCES "drivers" ("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_driver_documents_object_key" UNIQUE ("objectKey"),
        CONSTRAINT "CHK_driver_documents_type" CHECK ("type" IN ('national-id-front', 'national-id-back', 'driving-licence', 'vehicle-licence', 'selfie')),
        CONSTRAINT "CHK_driver_documents_content_type" CHECK ("contentType" IN ('image/jpeg', 'image/png', 'application/pdf')),
        CONSTRAINT "CHK_driver_documents_size" CHECK ("sizeBytes" BETWEEN 1 AND 10485760),
        CONSTRAINT "CHK_driver_documents_version" CHECK ("version" BETWEEN 1 AND 5),
        CONSTRAINT "CHK_driver_documents_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
      )`);
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_driver_documents_version" ON "driver_documents" ("driverId", "type", "version")');
    await queryRunner.query('CREATE UNIQUE INDEX "UQ_driver_documents_current" ON "driver_documents" ("driverId", "type") WHERE "isCurrent"');

    await queryRunner.query(`
      CREATE TABLE "driver_document_access" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "staffUserId" uuid NOT NULL,
        "driverId" uuid NOT NULL,
        "documentId" uuid NOT NULL,
        "documentType" character varying(30) NOT NULL,
        "documentVersion" integer NOT NULL,
        "accessedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_driver_document_access" PRIMARY KEY ("id")
      )`);
    await queryRunner.query('CREATE INDEX "IDX_driver_document_access_driver" ON "driver_document_access" ("driverId", "accessedAt")');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE "driver_document_access"');
    await queryRunner.query('DROP TABLE "driver_documents"');
    await queryRunner.query('DROP INDEX "IDX_drivers_review_queue"');
    await queryRunner.query('DROP INDEX "UQ_drivers_national_id_hash"');
    await queryRunner.query('ALTER TABLE "drivers" DROP CONSTRAINT "CHK_drivers_national_id"');
    await queryRunner.query('ALTER TABLE "drivers" DROP COLUMN "vehicleLicenceExpiresOn"');
    await queryRunner.query('ALTER TABLE "drivers" DROP COLUMN "drivingLicenceExpiresOn"');
    await queryRunner.query('ALTER TABLE "drivers" DROP COLUMN "nationalIdHash"');
    await queryRunner.query('ALTER TABLE "drivers" DROP COLUMN "nationalIdLast4"');
    await queryRunner.query('ALTER TABLE "drivers" DROP COLUMN "submittedAt"');
  }
}
