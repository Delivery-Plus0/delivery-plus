import { DeliveryEventType, KafkaConsumerService, TOPICS } from '@food-delivery/shared';
import { TrackingEventsBus } from '../common/tracking-events.bus';
import { DeliveryEventsBridge } from './delivery-events.bridge';

describe('DeliveryEventsBridge', () => {
  const setup = () => {
    type Handler = (event: unknown) => Promise<void>;
    const kafkaConsumer = {
      subscribe: jest.fn<Promise<void>, [string, string, Handler]>(async () => undefined),
      start: jest.fn(async () => undefined),
    };
    const events = { publishDeliveryChanged: jest.fn(async () => 1) };
    const bridge = new DeliveryEventsBridge(
      kafkaConsumer as unknown as KafkaConsumerService,
      events as unknown as TrackingEventsBus,
    );
    return { bridge, kafkaConsumer, events };
  };

  it('listens to every delivery lifecycle event (assignment, pickup, transit, end, cancel) and starts consuming', async () => {
    const { bridge, kafkaConsumer } = setup();
    await bridge.onModuleInit();

    const subscribed = kafkaConsumer.subscribe.mock.calls.map((call) => [call[0], call[1]]);
    expect(subscribed).toEqual(Object.values(DeliveryEventType).map((type) => [TOPICS.DELIVERY_EVENTS, type]));
    expect(kafkaConsumer.start).toHaveBeenCalledTimes(1);
  });

  it("wakes that delivery's subscribers, with the delivery id only", async () => {
    const { bridge, kafkaConsumer, events } = setup();
    await bridge.onModuleInit();
    const handler = kafkaConsumer.subscribe.mock.calls[1][2];

    await handler({ payload: { deliveryId: 'delivery-1', orderId: 'o-1', customerId: 'c-1', driverId: 'driver-1', status: 'DRIVER_ASSIGNED' } });

    expect(events.publishDeliveryChanged).toHaveBeenCalledWith('delivery-1');
  });

  it('skips a malformed event instead of failing the consumer', async () => {
    const { bridge, events } = setup();
    await bridge.handle({} as { deliveryId: string });
    expect(events.publishDeliveryChanged).not.toHaveBeenCalled();
  });
});
