import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * #206 makes verification binding: only a VERIFIED driver can go online or be dispatched. Every driver
 * that exists before this migration is a seeded or E2E account (production starts empty), and they
 * could already take deliveries, so PENDING ones are marked VERIFIED to keep those stacks working.
 * REJECTED drivers stay rejected. Drivers registered afterwards start PENDING as before.
 *
 * `down` is a no-op: after this runs there is no way to tell which drivers were PENDING.
 */
export class VerifyExistingDrivers1700000000003 implements MigrationInterface {
  name = 'VerifyExistingDrivers1700000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "drivers" SET "verificationStatus" = 'VERIFIED', "verifiedAt" = COALESCE("verifiedAt", now()) WHERE "verificationStatus" = 'PENDING'`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty (see above).
  }
}
