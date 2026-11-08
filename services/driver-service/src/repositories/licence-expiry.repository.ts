import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** One advisory lock for the whole job, so it runs once at a time across every instance. */
export const LICENCE_EXPIRY_LOCK = 'driver-service:licence-expiry';

/** Shown to the driver as `verificationNote` when a licence expiry sends them back to re-review. */
export const LICENCE_EXPIRED_NOTE =
  'A licence on your application has expired. Upload the renewed licence, update its expiry date and submit your application again.';

export interface LicenceExpiryOutcome {
  /** Drivers taken off VERIFIED and sent back to a draft (and offline if they were online). */
  expired: string[];
  /** VERIFIED drivers with an expired licence left alone because they are on a delivery; retried next run. */
  skippedBusy: number;
  /** VERIFIED drivers with a licence expiring between today and the warning date (inclusive). */
  expiringSoon: number;
}

/**
 * The licence expiry check (#207). Dates are Cairo calendar dates (YYYY-MM-DD) computed by the caller;
 * a licence is valid through its expiry date and expired from the next day.
 */
@Injectable()
export class LicenceExpiryRepository {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /**
   * One pass in one transaction holding the job's advisory lock; null when another instance holds it.
   *
   * A VERIFIED driver with an expired licence goes back to a draft for re-review: PENDING, no
   * `submittedAt` (so they can upload the renewed licence and submit), no `verifiedAt`, a note saying
   * why, and OFFLINE if they were AVAILABLE. It is one compare-and-set UPDATE, so a claim racing it
   * either lands first (the driver is BUSY and skipped) or finds the driver no longer VERIFIED.
   *
   * - A null expiry never counts as expired: drivers verified before the application have none.
   * - BUSY drivers are skipped so a delivery isn't left without its driver; the next run retries them.
   */
  async run(today: string, warnUntil: string): Promise<LicenceExpiryOutcome | null> {
    return this.dataSource.transaction(async (manager) => {
      const [lock] = await manager.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS "locked"', [LICENCE_EXPIRY_LOCK]);
      if (!lock?.locked) return null;

      const expired: { id: string }[] = await manager.query(
        `UPDATE "drivers" SET
           "verificationStatus" = 'PENDING',
           "submittedAt" = NULL,
           "verifiedAt" = NULL,
           "verificationNote" = $2,
           "status" = CASE WHEN "status" = 'AVAILABLE' THEN 'OFFLINE'::"driver_status" ELSE "status" END,
           "availableSince" = CASE WHEN "status" = 'AVAILABLE' THEN NULL ELSE "availableSince" END,
           "updatedAt" = now()
         WHERE "verificationStatus" = 'VERIFIED'
           AND "status" <> 'BUSY'
           AND ("drivingLicenceExpiresOn" < $1::date OR "vehicleLicenceExpiresOn" < $1::date)
         RETURNING "id"`,
        [today, LICENCE_EXPIRED_NOTE],
      ).then((result: unknown) => (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result) as { id: string }[]);

      const [counts] = await manager.query(
        `SELECT
           COUNT(*) FILTER (WHERE "status" = 'BUSY'
             AND ("drivingLicenceExpiresOn" < $1::date OR "vehicleLicenceExpiresOn" < $1::date)) AS "skippedBusy",
           COUNT(*) FILTER (WHERE "drivingLicenceExpiresOn" BETWEEN $1::date AND $2::date
             OR "vehicleLicenceExpiresOn" BETWEEN $1::date AND $2::date) AS "expiringSoon"
         FROM "drivers"
         WHERE "verificationStatus" = 'VERIFIED'`,
        [today, warnUntil],
      );
      return {
        expired: expired.map((row) => row.id),
        skippedBusy: Number(counts?.skippedBusy ?? 0),
        expiringSoon: Number(counts?.expiringSoon ?? 0),
      };
    });
  }
}
