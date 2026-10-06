import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export type TrackingTrigger = () => void;

export function driverChannel(userId: string): string {
  return `tracking:driver:${userId}`;
}

export function deliveryChannel(deliveryId: string): string {
  return `tracking:delivery:${deliveryId}`;
}

/**
 * Realtime fan-out for delivery tracking (#135), over the Redis the service already uses. Messages are
 * triggers only ("something changed for this driver/delivery"): they carry no location or customer
 * data, and every subscriber recomputes its state from the authoritative stores. Redis pub/sub reaches
 * every tracking-service instance, so a report handled by one instance wakes subscribers on all of them.
 * Delivery is at-most-once; streams resync periodically to cover a lost message.
 *
 * One subscriber connection per instance; each channel is subscribed once, however many local
 * listeners share it, and unsubscribed when the last one leaves.
 */
@Injectable()
export class TrackingEventsBus implements OnModuleDestroy {
  private readonly logger = new Logger(TrackingEventsBus.name);
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<TrackingTrigger>>();

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  publishDriverLocation(userId: string): Promise<number> {
    return this.redis.publish(driverChannel(userId), '1');
  }

  publishDeliveryChanged(deliveryId: string): Promise<number> {
    return this.redis.publish(deliveryChannel(deliveryId), '1');
  }

  /** Calls `listener` on every message on `channel` until the returned function is called. */
  async subscribe(channel: string, listener: TrackingTrigger): Promise<() => Promise<void>> {
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.connection().subscribe(channel);
    }
    set.add(listener);

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(channel);
        await this.connection().unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  /** Channels this instance currently listens to (observability and tests). */
  activeChannels(): number {
    return this.listeners.size;
  }

  async onModuleDestroy(): Promise<void> {
    this.listeners.clear();
    await this.subscriber?.quit().catch(() => undefined);
  }

  private connection(): Redis {
    if (!this.subscriber) {
      // A connection in subscriber mode can't run other commands, so it is separate from REDIS_CLIENT.
      this.subscriber = this.redis.duplicate();
      this.subscriber.on('message', (channel: string) => this.dispatch(channel));
      this.subscriber.on('error', (error: Error) => this.logger.warn(`tracking.bus.error ${error.message}`));
    }
    return this.subscriber;
  }

  private dispatch(channel: string): void {
    for (const listener of [...(this.listeners.get(channel) ?? [])]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn(`tracking.bus.listener_failed ${channel}: ${(error as Error).message}`);
      }
    }
  }
}
