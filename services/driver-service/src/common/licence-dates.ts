/** #207: licences expiring this many days ahead (Cairo calendar days) are flagged to the driver. */
export const LICENCE_WARNING_DAYS = 14;

/** The calendar date in Cairo, YYYY-MM-DD: licence expiry dates are Cairo dates. */
export function cairoDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** A YYYY-MM-DD date plus whole calendar days (no time zone involved: it is already a calendar date). */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export const LICENCE_FIELDS = ['drivingLicenceExpiresOn', 'vehicleLicenceExpiresOn'] as const;
export type LicenceField = (typeof LICENCE_FIELDS)[number];

/** The licences valid today but expiring within the warning window, soonest first. */
export function expiringLicences(
  driver: Record<LicenceField, string | null>,
  today: string,
): { field: LicenceField; expiresOn: string }[] {
  const until = addDays(today, LICENCE_WARNING_DAYS);
  return LICENCE_FIELDS.filter((field) => {
    const expiresOn = driver[field];
    return expiresOn !== null && expiresOn >= today && expiresOn <= until;
  })
    .map((field) => ({ field, expiresOn: driver[field] as string }))
    .sort((a, b) => a.expiresOn.localeCompare(b.expiresOn));
}
