import { DeliveryStatus, ForbiddenError, NotFoundError } from '@food-delivery/shared';
import { TrackingEventsBus, deliveryChannel, driverChannel } from '../common/tracking-events.bus';
import { DriverLocation } from '../entities/location.model';
import { TrackingStreamService, TrackingStreamSink } from './tracking-stream.service';
import { DeliveryTrackingContext, DeliveryTrackingInfo, TrackingService } from './tracking.service';
import { TrackingState, resolveTracking } from './tracking-state';

/** In-memory stand-in for Redis pub/sub: same subscribe/unsubscribe contract as TrackingEventsBus. */
class FakeBus {
  readonly channels = new Map<string, Set<() => void>>();

  async subscribe(channel: string, listener: () => void) {
    if (!this.channels.has(channel)) this.channels.set(channel, new Set());
    this.channels.get(channel)!.add(listener);
    return async () => {
      this.channels.get(channel)?.delete(listener);
      if (this.channels.get(channel)?.size === 0) this.channels.delete(channel);
    };
  }

  trigger(channel: string) {
    for (const listener of [...(this.channels.get(channel) ?? [])]) listener();
  }
}

class RecordingSink implements TrackingStreamSink {
  sent: DeliveryTrackingInfo[] = [];
  errors: { statusCode: number; message: string }[] = [];
  heartbeats = 0;
  closed = 0;
  send(snapshot: DeliveryTrackingInfo) {
    this.sent.push(snapshot);
  }
  heartbeat() {
    this.heartbeats += 1;
  }
  fail(error: { statusCode: number; message: string }) {
    this.errors.push(error);
  }
  close() {
    this.closed += 1;
  }
  last() {
    return this.sent[this.sent.length - 1];
  }
}

/** Flush promise chains without advancing fake time. */
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const DELIVERY = 'delivery-1';

describe('TrackingStreamService', () => {
  let bus: FakeBus;
  let sink: RecordingSink;
  let delivery: Omit<DeliveryTrackingContext, 'deliveryId'>;
  let allowed: boolean;
  let dependencyDown: boolean;
  let locations: Map<string, DriverLocation>;
  let tracking: { loadDeliveryContext: jest.Mock; snapshot: jest.Mock };
  let service: TrackingStreamService;

  const reportLocation = (userId: string, latitude: number, secondsAgo = 0) =>
    locations.set(userId, {
      userId,
      latitude,
      longitude: 31.2357,
      updatedAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    });

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    bus = new FakeBus();
    sink = new RecordingSink();
    delivery = { status: DeliveryStatus.DRIVER_ASSIGNED, driverId: 'driver-1', driverUserId: 'user-1' };
    allowed = true;
    dependencyDown = false;
    locations = new Map();
    // The real lifecycle rules, over in-memory stores.
    tracking = {
      loadDeliveryContext: jest.fn(async (deliveryId: string) => {
        if (dependencyDown) throw new Error('delivery-service unreachable');
        if (!allowed) throw new ForbiddenError('You do not have access to this delivery');
        return { deliveryId, ...delivery };
      }),
      snapshot: jest.fn(async (context: DeliveryTrackingContext) => {
        const location = context.driverUserId ? (locations.get(context.driverUserId) ?? null) : null;
        return {
          deliveryId: context.deliveryId,
          status: context.status,
          driverId: context.driverId,
          ...resolveTracking(context.status, context.driverId, location, new Date(), 60),
        };
      }),
    };
    service = new TrackingStreamService(
      tracking as unknown as TrackingService,
      bus as unknown as TrackingEventsBus,
      { locationStaleAfterSeconds: 60, streamHeartbeatMs: 15_000, streamResyncMs: 30_000 },
    );
  });

  afterEach(() => jest.useRealTimers());

  describe('authorization', () => {
    it('authorized: sends the current state first, then listens to the delivery and its driver', async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);

      expect(tracking.loadDeliveryContext).toHaveBeenCalledWith(DELIVERY, 'Bearer customer');
      expect(sink.sent).toHaveLength(1);
      expect(sink.last()).toMatchObject({ tracking: TrackingState.LIVE, location: { latitude: 30.0444 } });
      expect(bus.channels.has(deliveryChannel(DELIVERY))).toBe(true);
      expect(bus.channels.has(driverChannel('user-1'))).toBe(true);
    });

    it.each([
      ['another customer', new ForbiddenError('You do not have access to this delivery')],
      ['an unknown delivery', new NotFoundError('Delivery not found')],
    ])('%s: rejected before anything is sent, and no channel is left behind', async (_label, error) => {
      tracking.loadDeliveryContext.mockRejectedValueOnce(error);

      await expect(service.open(DELIVERY, 'Bearer other', sink)).rejects.toBe(error);
      expect(sink.sent).toHaveLength(0);
      expect(sink.closed).toBe(0);
      expect(bus.channels.size).toBe(0);
      expect(service.openStreams()).toBe(0);
    });

    it('re-authorizes on every resync: access lost → error event, stream closed, nothing more sent', async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);
      allowed = false;

      jest.advanceTimersByTime(30_000);
      await settle();

      expect(sink.errors).toEqual([{ statusCode: 403, message: 'You do not have access to this delivery' }]);
      expect(sink.closed).toBe(1);
      expect(bus.channels.size).toBe(0);
      reportLocation('user-1', 31);
      bus.trigger(driverChannel('user-1'));
      await settle();
      expect(sink.sent).toHaveLength(1);
    });
  });

  describe('lifecycle transitions', () => {
    it('NO_DRIVER → assigned → first position, without reconnecting', async () => {
      delivery = { status: DeliveryStatus.CREATED, driverId: undefined, driverUserId: null };
      await service.open(DELIVERY, 'Bearer customer', sink);
      expect(sink.last()).toMatchObject({ tracking: TrackingState.NO_DRIVER, location: null });
      expect([...bus.channels.keys()]).toEqual([deliveryChannel(DELIVERY)]);

      // delivery.driver_assigned → bridge → delivery channel
      delivery = { status: DeliveryStatus.DRIVER_ASSIGNED, driverId: 'driver-1', driverUserId: 'user-1' };
      bus.trigger(deliveryChannel(DELIVERY));
      await settle();
      expect(sink.last()).toMatchObject({ tracking: TrackingState.AWAITING_LOCATION, driverId: 'driver-1', location: null });
      expect(bus.channels.has(driverChannel('user-1'))).toBe(true);

      // the driver app reports → driver channel
      reportLocation('user-1', 30.0444);
      bus.trigger(driverChannel('user-1'));
      await settle();
      expect(sink.last()).toMatchObject({ tracking: TrackingState.LIVE, location: { latitude: 30.0444 } });
      expect(sink.sent.map((s) => s.tracking)).toEqual(['NO_DRIVER', 'AWAITING_LOCATION', 'LIVE']);
    });

    it('a location report is pushed from the stored position, without reloading the delivery', async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);
      tracking.loadDeliveryContext.mockClear();

      reportLocation('user-1', 30.05);
      bus.trigger(driverChannel('user-1'));
      await settle();

      expect(sink.last()).toMatchObject({ tracking: TrackingState.LIVE, location: { latitude: 30.05 } });
      expect(tracking.loadDeliveryContext).not.toHaveBeenCalled();
    });

    it('LIVE turns STALE on its own once the position crosses the threshold', async () => {
      reportLocation('user-1', 30.0444, 50);
      await service.open(DELIVERY, 'Bearer customer', sink);
      expect(sink.last().tracking).toBe(TrackingState.LIVE);

      jest.advanceTimersByTime(10_000);
      await settle();
      expect(sink.sent).toHaveLength(1);

      jest.advanceTimersByTime(1_000);
      await settle();
      expect(sink.last()).toMatchObject({ tracking: TrackingState.STALE, location: { latitude: 30.0444 } });
    });

    it.each([DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED])(
      '%s: ENDED once, no position, then the stream closes and goes quiet',
      async (status) => {
        reportLocation('user-1', 30.0444);
        await service.open(DELIVERY, 'Bearer customer', sink);

        delivery = { status, driverId: 'driver-1', driverUserId: null };
        bus.trigger(deliveryChannel(DELIVERY));
        await settle();

        expect(sink.last()).toMatchObject({ tracking: TrackingState.ENDED, location: null });
        expect(sink.closed).toBe(1);
        expect(bus.channels.size).toBe(0);

        reportLocation('user-1', 31);
        bus.trigger(driverChannel('user-1'));
        jest.advanceTimersByTime(60_000);
        await settle();
        expect(sink.sent.filter((s) => s.location !== null && s.tracking === TrackingState.ENDED)).toHaveLength(0);
        expect(sink.sent).toHaveLength(2);
        expect(sink.heartbeats).toBe(0);
      },
    );

    it('a delivery already finished at open: one ENDED snapshot and an immediate close', async () => {
      delivery = { status: DeliveryStatus.DELIVERED, driverId: 'driver-1', driverUserId: null };
      await service.open(DELIVERY, 'Bearer customer', sink);
      expect(sink.sent).toEqual([expect.objectContaining({ tracking: TrackingState.ENDED, location: null })]);
      expect(sink.closed).toBe(1);
      expect(service.openStreams()).toBe(0);
    });

    it("reassignment: follows the new driver and never sends the previous driver's position", async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);

      delivery = { status: DeliveryStatus.DRIVER_ASSIGNED, driverId: 'driver-2', driverUserId: 'user-2' };
      bus.trigger(deliveryChannel(DELIVERY));
      await settle();
      expect(sink.last()).toMatchObject({ driverId: 'driver-2', tracking: TrackingState.AWAITING_LOCATION, location: null });
      expect(bus.channels.has(driverChannel('user-1'))).toBe(false);
      expect(bus.channels.has(driverChannel('user-2'))).toBe(true);

      reportLocation('user-1', 29.9);
      bus.trigger(driverChannel('user-1'));
      await settle();
      expect(sink.sent.filter((s) => s.location?.latitude === 29.9)).toHaveLength(0);

      reportLocation('user-2', 30.1);
      bus.trigger(driverChannel('user-2'));
      await settle();
      expect(sink.last()).toMatchObject({ driverId: 'driver-2', location: { latitude: 30.1 } });
    });
  });

  describe('duplicates, ordering and load', () => {
    it('duplicate triggers send nothing new when nothing visible changed', async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);

      bus.trigger(driverChannel('user-1'));
      bus.trigger(driverChannel('user-1'));
      bus.trigger(deliveryChannel(DELIVERY));
      jest.advanceTimersByTime(30_000);
      await settle();

      expect(sink.sent).toHaveLength(1);
    });

    it('a burst of triggers is coalesced and applied in order (latest stored position wins)', async () => {
      reportLocation('user-1', 30.0);
      await service.open(DELIVERY, 'Bearer customer', sink);
      tracking.loadDeliveryContext.mockClear();
      tracking.snapshot.mockClear();

      for (let i = 1; i <= 5; i++) {
        reportLocation('user-1', 30 + i / 100);
        bus.trigger(driverChannel('user-1'));
        bus.trigger(deliveryChannel(DELIVERY));
      }
      await settle();

      expect(tracking.loadDeliveryContext.mock.calls.length).toBeLessThanOrEqual(2);
      expect(sink.last().location?.latitude).toBe(30.05);
      const latitudes = sink.sent.map((s) => s.location?.latitude ?? 0);
      expect([...latitudes].sort((a, b) => a - b)).toEqual(latitudes);
    });
  });

  describe('failures and cleanup', () => {
    it('a dependency failure ends the stream with a retryable error (no misleading state)', async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);
      dependencyDown = true;

      bus.trigger(deliveryChannel(DELIVERY));
      await settle();

      expect(sink.errors).toEqual([{ statusCode: 503, message: 'Tracking is temporarily unavailable' }]);
      expect(sink.closed).toBe(1);
      expect(sink.sent).toHaveLength(1);
    });

    it('heartbeats keep the connection alive while nothing changes', async () => {
      reportLocation('user-1', 30.0444);
      await service.open(DELIVERY, 'Bearer customer', sink);
      jest.advanceTimersByTime(45_000);
      await settle();
      expect(sink.heartbeats).toBe(3);
    });

    it('close (client gone): leaves every channel, stops all timers, is idempotent', async () => {
      reportLocation('user-1', 30.0444);
      const subscription = await service.open(DELIVERY, 'Bearer customer', sink);
      expect(service.openStreams()).toBe(1);

      await subscription.close('client_closed');
      await subscription.close('client_closed');

      expect(bus.channels.size).toBe(0);
      expect(sink.closed).toBe(1);
      expect(service.openStreams()).toBe(0);
      jest.advanceTimersByTime(120_000);
      await settle();
      expect(sink.heartbeats).toBe(0);
      expect(tracking.loadDeliveryContext).toHaveBeenCalledTimes(1);
    });
  });
});
