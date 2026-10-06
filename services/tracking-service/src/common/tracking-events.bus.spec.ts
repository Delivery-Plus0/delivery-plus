import { EventEmitter } from 'events';
import Redis from 'ioredis';
import { TrackingEventsBus, deliveryChannel, driverChannel } from './tracking-events.bus';

/** ioredis stand-in: a publisher plus the duplicated subscriber connection the bus creates. */
function fakeRedis() {
  const subscriber = Object.assign(new EventEmitter(), {
    subscribe: jest.fn(async () => 1),
    unsubscribe: jest.fn(async () => 0),
    quit: jest.fn(async () => 'OK'),
  });
  const redis = {
    publish: jest.fn(async () => 1),
    duplicate: jest.fn(() => subscriber),
  };
  return { redis, subscriber };
}

describe('TrackingEventsBus', () => {
  it('publishes trigger-only messages on per-driver and per-delivery channels (no position, no customer data)', async () => {
    const { redis } = fakeRedis();
    const bus = new TrackingEventsBus(redis as unknown as Redis);

    await bus.publishDriverLocation('user-1');
    await bus.publishDeliveryChanged('delivery-1');

    expect(redis.publish).toHaveBeenNthCalledWith(1, 'tracking:driver:user-1', '1');
    expect(redis.publish).toHaveBeenNthCalledWith(2, 'tracking:delivery:delivery-1', '1');
  });

  it('subscribes a channel once for many local listeners, and unsubscribes after the last one leaves', async () => {
    const { redis, subscriber } = fakeRedis();
    const bus = new TrackingEventsBus(redis as unknown as Redis);
    const a = jest.fn();
    const b = jest.fn();

    const leaveA = await bus.subscribe(deliveryChannel('d-1'), a);
    const leaveB = await bus.subscribe(deliveryChannel('d-1'), b);
    expect(redis.duplicate).toHaveBeenCalledTimes(1);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);

    subscriber.emit('message', deliveryChannel('d-1'), '1');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    await leaveA();
    await leaveA();
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    await leaveB();
    expect(subscriber.unsubscribe).toHaveBeenCalledWith(deliveryChannel('d-1'));
    expect(bus.activeChannels()).toBe(0);
  });

  it('routes a message only to the listeners of its channel', async () => {
    const { redis, subscriber } = fakeRedis();
    const bus = new TrackingEventsBus(redis as unknown as Redis);
    const mine = jest.fn();
    const other = jest.fn();
    await bus.subscribe(driverChannel('user-1'), mine);
    await bus.subscribe(driverChannel('user-2'), other);

    subscriber.emit('message', driverChannel('user-1'), '1');

    expect(mine).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
  });

  it('a throwing listener does not stop the others', async () => {
    const { redis, subscriber } = fakeRedis();
    const bus = new TrackingEventsBus(redis as unknown as Redis);
    const ok = jest.fn();
    await bus.subscribe(deliveryChannel('d-1'), () => {
      throw new Error('boom');
    });
    await bus.subscribe(deliveryChannel('d-1'), ok);

    subscriber.emit('message', deliveryChannel('d-1'), '1');
    expect(ok).toHaveBeenCalledTimes(1);
  });
});
