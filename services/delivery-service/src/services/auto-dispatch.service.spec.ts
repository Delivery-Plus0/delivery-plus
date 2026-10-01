import {
  BadRequestError,
  ConflictError,
  DeliveryStatus,
  InvalidStateTransitionError,
  KafkaConsumerService,
  OrderEventType,
  TOPICS,
  UserRole,
} from '@food-delivery/shared';
import { AutoDispatchService } from './auto-dispatch.service';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { Delivery } from '../entities/delivery.entity';
import { AppConfig } from '../config/app-config';

const delivery = (status: DeliveryStatus, id = 'delivery-1', orderId = 'order-1') =>
  ({ id, orderId, status, createdAt: new Date(), updatedAt: new Date() }) as Delivery;
const noDriver = () => new ConflictError('No available drivers to assign');

describe('AutoDispatchService', () => {
  let service: AutoDispatchService;
  let deliveriesService: jest.Mocked<Pick<DeliveriesService, 'create' | 'assignDriver'>>;
  let repo: jest.Mocked<Pick<DeliveriesRepository, 'findByOrderId' | 'findWaitingForDriver'>>;
  let kafkaConsumer: { subscribe: jest.Mock; start: jest.Mock };

  const build = (sweepMs = 0) =>
    new AutoDispatchService(
      deliveriesService as unknown as DeliveriesService,
      repo as unknown as DeliveriesRepository,
      kafkaConsumer as unknown as KafkaConsumerService,
      { autoDispatchSweepMs: sweepMs } as AppConfig,
    );

  beforeEach(() => {
    deliveriesService = { create: jest.fn(), assignDriver: jest.fn() };
    repo = { findByOrderId: jest.fn(), findWaitingForDriver: jest.fn().mockResolvedValue([]) };
    kafkaConsumer = { subscribe: jest.fn(), start: jest.fn() };
    service = build();
  });

  describe('order.ready_for_pickup', () => {
    it('subscribes to ready-for-pickup order events and dispatches the order in the payload', async () => {
      await service.onModuleInit();
      expect(kafkaConsumer.subscribe).toHaveBeenCalledWith(TOPICS.ORDER_EVENTS, OrderEventType.READY_FOR_PICKUP, expect.any(Function));
      expect(kafkaConsumer.start).toHaveBeenCalled();

      repo.findByOrderId.mockResolvedValue(delivery(DeliveryStatus.DRIVER_ASSIGNED));
      const handler = kafkaConsumer.subscribe.mock.calls[0][2];
      await handler({ payload: { orderId: 'order-1' } });
      expect(repo.findByOrderId).toHaveBeenCalledWith('order-1');
    });

    it('creates the delivery and assigns a driver with dispatch (ADMIN) rights, no API call needed', async () => {
      repo.findByOrderId.mockResolvedValue(null);
      deliveriesService.create.mockResolvedValue(delivery(DeliveryStatus.CREATED));

      await service.dispatchOrder('order-1');

      expect(deliveriesService.create).toHaveBeenCalledWith(
        expect.objectContaining({ role: UserRole.ADMIN }),
        { orderId: 'order-1' },
      );
      expect(deliveriesService.assignDriver).toHaveBeenCalledWith('delivery-1', expect.objectContaining({ role: UserRole.ADMIN }));
    });

    it.each([DeliveryStatus.DRIVER_ASSIGNED, DeliveryStatus.PICKED_UP, DeliveryStatus.DELIVERED, DeliveryStatus.CANCELLED])(
      'does nothing for a redelivered/replayed event when the delivery is already %s (no second delivery, no second driver)',
      async (status) => {
        repo.findByOrderId.mockResolvedValue(delivery(status));

        await service.dispatchOrder('order-1');

        expect(deliveriesService.create).not.toHaveBeenCalled();
        expect(deliveriesService.assignDriver).not.toHaveBeenCalled();
      },
    );

    it('assigns an existing delivery that is still waiting (e.g. created manually, or no driver last time)', async () => {
      repo.findByOrderId.mockResolvedValue(delivery(DeliveryStatus.CREATED));

      await service.dispatchOrder('order-1');

      expect(deliveriesService.create).not.toHaveBeenCalled();
      expect(deliveriesService.assignDriver).toHaveBeenCalledWith('delivery-1', expect.anything());
    });

    it('continues with the manual delivery when a manual dispatch created it first (one delivery)', async () => {
      repo.findByOrderId.mockResolvedValueOnce(null).mockResolvedValueOnce(delivery(DeliveryStatus.CREATED, 'manual-1'));
      deliveriesService.create.mockRejectedValue(new ConflictError('A delivery already exists for order order-1'));

      await service.dispatchOrder('order-1');

      expect(deliveriesService.assignDriver).toHaveBeenCalledWith('manual-1', expect.anything());
    });

    it('treats a manual assignment winning the race as done, not as a failure', async () => {
      repo.findByOrderId.mockResolvedValue(delivery(DeliveryStatus.CREATED));
      deliveriesService.assignDriver.mockRejectedValue(new InvalidStateTransitionError('Delivery', 'DRIVER_ASSIGNED', 'DRIVER_ASSIGNED'));

      await expect(service.dispatchOrder('order-1')).resolves.toBeUndefined();
    });

    it('leaves the delivery waiting when no driver is free, without failing the event (no dead letter)', async () => {
      repo.findByOrderId.mockResolvedValue(null);
      deliveriesService.create.mockResolvedValue(delivery(DeliveryStatus.CREATED));
      deliveriesService.assignDriver.mockRejectedValue(noDriver());

      await expect(service.dispatchOrder('order-1')).resolves.toBeUndefined();
    });

    it('skips an order that is no longer ready (stale event) without failing', async () => {
      repo.findByOrderId.mockResolvedValue(null);
      deliveriesService.create.mockRejectedValue(new BadRequestError('Order order-1 is not ready for pickup (status CANCELLED)'));

      await expect(service.dispatchOrder('order-1')).resolves.toBeUndefined();
      expect(deliveriesService.assignDriver).not.toHaveBeenCalled();
    });

    it('lets unexpected failures propagate so the consumer retries (then dead-letters) the event', async () => {
      repo.findByOrderId.mockResolvedValue(null);
      deliveriesService.create.mockRejectedValue(new Error('order-service down'));

      await expect(service.dispatchOrder('order-1')).rejects.toThrow('order-service down');
    });
  });

  describe('sweep (driver came online later)', () => {
    it('assigns waiting deliveries oldest first', async () => {
      repo.findWaitingForDriver.mockResolvedValue([delivery(DeliveryStatus.CREATED, 'old'), delivery(DeliveryStatus.CREATED, 'new')]);

      await service.sweep();

      expect(deliveriesService.assignDriver.mock.calls.map((call) => call[0])).toEqual(['old', 'new']);
    });

    it('stops the batch as soon as no driver is free', async () => {
      repo.findWaitingForDriver.mockResolvedValue([delivery(DeliveryStatus.CREATED, 'a'), delivery(DeliveryStatus.CREATED, 'b')]);
      deliveriesService.assignDriver.mockRejectedValue(noDriver());

      await service.sweep();

      expect(deliveriesService.assignDriver).toHaveBeenCalledTimes(1);
    });

    it('never throws out of the timer; errors are logged and retried next tick', async () => {
      repo.findWaitingForDriver.mockRejectedValue(new Error('db down'));
      await expect(service.sweep()).resolves.toBeUndefined();
    });

    it('does not overlap with a sweep that is still running', async () => {
      let release!: () => void;
      repo.findWaitingForDriver.mockReturnValue(new Promise((resolve) => (release = () => resolve([]))));

      const first = service.sweep();
      await service.sweep();
      release();
      await first;

      expect(repo.findWaitingForDriver).toHaveBeenCalledTimes(1);
    });

    it('runs on the configured interval and stops on shutdown; 0 disables it', async () => {
      jest.useFakeTimers();
      try {
        const timed = build(1000);
        const sweep = jest.spyOn(timed, 'sweep').mockResolvedValue();
        await timed.onModuleInit();
        jest.advanceTimersByTime(3000);
        expect(sweep).toHaveBeenCalledTimes(3);
        timed.onModuleDestroy();
        jest.advanceTimersByTime(3000);
        expect(sweep).toHaveBeenCalledTimes(3);

        const disabled = build(0);
        const disabledSweep = jest.spyOn(disabled, 'sweep').mockResolvedValue();
        await disabled.onModuleInit();
        jest.advanceTimersByTime(60_000);
        expect(disabledSweep).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });
  });
});
