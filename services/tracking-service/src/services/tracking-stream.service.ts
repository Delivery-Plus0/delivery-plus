import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { TrackingEventsBus, deliveryChannel, driverChannel } from '../common/tracking-events.bus';
import { DeliveryTrackingContext, DeliveryTrackingInfo, TrackingService } from './tracking.service';
import { TrackingState } from './tracking-state';

/** Where a subscription writes. The controller adapts it to Server-Sent Events; tests record calls. */
export interface TrackingStreamSink {
  /** A tracking snapshot, the same model as GET /tracking/delivery/:id. */
  send(snapshot: DeliveryTrackingInfo): void;
  /** Keepalive with no data, so proxies keep the connection and clients can tell it's alive. */
  heartbeat(): void;
  /** Terminal error; `close()` follows. */
  fail(error: TrackingStreamError): void;
  close(): void;
}

export interface TrackingStreamError {
  statusCode: number;
  message: string;
}

export interface TrackingSubscription {
  close(reason?: string): Promise<void>;
}

type StreamConfig = Pick<AppConfig, 'locationStaleAfterSeconds' | 'streamHeartbeatMs' | 'streamResyncMs'>;

/**
 * Realtime tracking for one customer and one delivery (#135), independent of the wire format.
 *
 * Every state it sends comes from TrackingService, so the #32 lifecycle rules and delivery-service's
 * authorization stay the single source of truth:
 * - open: subscribe to the delivery's trigger channel, then load (and authorize) the delivery, then
 *   subscribe to its driver's channel, then send the first snapshot. Anything that changes in between
 *   triggers a recompute, so no update is lost between the snapshot and the subscriptions.
 * - driver location report → recompute from the stored position (no HTTP).
 * - delivery change, or the periodic resync → reload the delivery (re-authorizing with the caller's
 *   token), follow a reassignment to the new driver's channel, recompute.
 * - LIVE position → a timer recomputes exactly when it crosses the stale threshold.
 * Recomputes run one at a time (coalesced), and a snapshot is sent only when something visible
 * changed, so duplicates and races can't reorder or repeat what the client sees. ENDED is sent once
 * and closes the stream; an authorization or dependency failure sends an error and closes it.
 */
@Injectable()
export class TrackingStreamService {
  private readonly logger = new Logger(TrackingStreamService.name);
  private openCount = 0;

  constructor(
    private readonly tracking: TrackingService,
    private readonly events: TrackingEventsBus,
    @Inject(APP_CONFIG) private readonly config: StreamConfig,
  ) {}

  /** Opens a subscription, or throws (403/404/…) before anything is written to the sink. */
  async open(deliveryId: string, authHeader: string, sink: TrackingStreamSink): Promise<TrackingSubscription> {
    const subscription = new Subscription(deliveryId, authHeader, sink, this.tracking, this.events, this.config, {
      opened: () => {
        this.openCount += 1;
        this.logger.log(`tracking.stream.opened delivery=${deliveryId} open=${this.openCount}`);
      },
      closed: (reason, durationMs, eventsSent) => {
        this.openCount -= 1;
        this.logger.log(
          `tracking.stream.closed delivery=${deliveryId} reason=${reason} durationMs=${durationMs} events=${eventsSent} open=${this.openCount}`,
        );
      },
      failed: (error) => this.logger.warn(`tracking.stream.failed delivery=${deliveryId} status=${error.statusCode}`),
    });
    try {
      await subscription.start();
    } catch (error) {
      this.logger.warn(`tracking.stream.rejected delivery=${deliveryId} status=${statusOf(error)}`);
      throw error;
    }
    return subscription;
  }

  /** Streams currently open on this instance. */
  openStreams(): number {
    return this.openCount;
  }
}

type Mode = 'location' | 'full';

interface Hooks {
  opened(): void;
  closed(reason: string, durationMs: number, eventsSent: number): void;
  failed(error: TrackingStreamError): void;
}

class Subscription implements TrackingSubscription {
  private context: DeliveryTrackingContext | null = null;
  private lastSentKey: string | null = null;
  private eventsSent = 0;
  private closed = false;
  private readonly startedAt = Date.now();
  private pending: Mode | null = null;
  private queue: Promise<void> = Promise.resolve();
  private unsubscribeDelivery: (() => Promise<void>) | null = null;
  private unsubscribeDriver: (() => Promise<void>) | null = null;
  private followedDriverUserId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deliveryId: string,
    private readonly authHeader: string,
    private readonly sink: TrackingStreamSink,
    private readonly tracking: Pick<TrackingService, 'loadDeliveryContext' | 'snapshot'>,
    private readonly events: Pick<TrackingEventsBus, 'subscribe'>,
    private readonly config: StreamConfig,
    private readonly hooks: Hooks,
  ) {}

  async start(): Promise<void> {
    this.unsubscribeDelivery = await this.events.subscribe(deliveryChannel(this.deliveryId), () => this.schedule('full'));
    try {
      this.context = await this.tracking.loadDeliveryContext(this.deliveryId, this.authHeader);
      await this.followDriver();
    } catch (error) {
      // Not authorized (or the delivery can't be read): nothing was written; just drop the channels.
      this.closed = true;
      await this.unsubscribeAll();
      throw error;
    }
    this.hooks.opened();
    this.heartbeatTimer = setInterval(() => this.sink.heartbeat(), this.config.streamHeartbeatMs);
    this.resyncTimer = setInterval(() => this.schedule('full'), this.config.streamResyncMs);
    this.schedule('location');
    await this.queue;
  }

  /** Idempotent: stops timers, leaves every channel, ends the sink. */
  async close(reason = 'closed'): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    await this.unsubscribeAll();
    this.sink.close();
    this.hooks.closed(reason, Date.now() - this.startedAt, this.eventsSent);
  }

  /** Queue a recompute; a pending one absorbs it (a full reload covers a location recompute). */
  private schedule(mode: Mode): void {
    if (this.closed) return;
    if (this.pending) {
      if (mode === 'full') this.pending = 'full';
      return;
    }
    this.pending = mode;
    this.queue = this.queue.then(() => this.run());
  }

  private async run(): Promise<void> {
    const mode = this.pending;
    this.pending = null;
    if (!mode || this.closed || !this.context) return;
    try {
      if (mode === 'full') {
        this.context = await this.tracking.loadDeliveryContext(this.deliveryId, this.authHeader);
        await this.followDriver();
      }
      if (this.closed) return;
      this.emit(await this.tracking.snapshot(this.context));
    } catch (error) {
      await this.fail(error);
    }
  }

  private emit(snapshot: DeliveryTrackingInfo): void {
    if (this.closed) return;
    // locationAgeSeconds is left out on purpose: clients age the position locally, and resending an
    // unchanged position only because a second passed would defeat the dedupe.
    const key = JSON.stringify([
      snapshot.tracking,
      snapshot.status,
      snapshot.driverId ?? null,
      snapshot.location?.latitude ?? null,
      snapshot.location?.longitude ?? null,
      snapshot.location?.updatedAt ?? null,
    ]);
    if (key !== this.lastSentKey) {
      this.lastSentKey = key;
      this.eventsSent += 1;
      this.sink.send(snapshot);
    }
    this.armStaleTimer(snapshot);
    if (snapshot.tracking === TrackingState.ENDED) void this.close('ended');
  }

  /** A LIVE position turns STALE without any new event; recompute right after the threshold. */
  private armStaleTimer(snapshot: DeliveryTrackingInfo): void {
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = null;
    if (snapshot.tracking !== TrackingState.LIVE || snapshot.locationAgeSeconds === null) return;
    const delayMs = (this.config.locationStaleAfterSeconds - snapshot.locationAgeSeconds + 1) * 1000;
    this.staleTimer = setTimeout(() => this.schedule('location'), Math.max(delayMs, 1000));
  }

  /** Listen to the current driver's reports only; a reassignment drops the previous driver. */
  private async followDriver(): Promise<void> {
    const userId = this.context?.driverUserId ?? null;
    if (userId === this.followedDriverUserId) return;
    const previous = this.unsubscribeDriver;
    this.unsubscribeDriver = null;
    this.followedDriverUserId = userId;
    await previous?.();
    if (userId) {
      this.unsubscribeDriver = await this.events.subscribe(driverChannel(userId), () => this.schedule('location'));
    }
  }

  private async fail(error: unknown): Promise<void> {
    if (this.closed) return;
    const statusCode = statusOf(error);
    const streamError: TrackingStreamError = {
      statusCode,
      message: statusCode < 500 && error instanceof Error ? error.message : 'Tracking is temporarily unavailable',
    };
    this.hooks.failed(streamError);
    this.sink.fail(streamError);
    await this.close('error');
  }

  private clearTimers(): void {
    for (const timer of [this.heartbeatTimer, this.resyncTimer]) if (timer) clearInterval(timer);
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.heartbeatTimer = this.resyncTimer = this.staleTimer = null;
  }

  private async unsubscribeAll(): Promise<void> {
    const pending = [this.unsubscribeDelivery, this.unsubscribeDriver];
    this.unsubscribeDelivery = this.unsubscribeDriver = null;
    this.followedDriverUserId = null;
    await Promise.all(pending.map((unsubscribe) => unsubscribe?.()));
  }
}

function statusOf(error: unknown): number {
  return error instanceof AppError ? error.statusCode : 503;
}
