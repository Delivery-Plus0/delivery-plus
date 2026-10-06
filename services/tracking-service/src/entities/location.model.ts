export interface DriverLocation {
  userId: string;
  latitude: number;
  longitude: number;
  /** Server receive time (ISO 8601). The only clock freshness (LIVE/STALE) is measured with. */
  updatedAt: string;
  /** The driver's active delivery when the report was accepted (#60); absent on pre-#60 records. */
  deliveryId?: string;
  /** The client's claimed capture time, kept only to reject replays and reordering (#60). Untrusted. */
  recordedAt?: string;
}
