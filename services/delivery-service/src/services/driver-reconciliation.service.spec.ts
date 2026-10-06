import { DeliveryStatus, DriverStatus } from '@food-delivery/shared';
import { DriverReconciliationService } from './driver-reconciliation.service';
import { DeliveriesRepository } from '../repositories/deliveries.repository';
import { DriverServiceClient } from '../common/driver-service.client';
import { AppConfig } from '../config/app-config';
import { Delivery } from '../entities/delivery.entity';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const GRACE = 60_000;

const finished = (id: string, driverId: string | undefined, status = DeliveryStatus.DELIVERED) =>
  ({ id, orderId: `order-${id}`, driverId, status, createdAt: new Date(NOW), updatedAt: new Date(NOW) }) as Delivery;

const driver = (id: string, status: DriverStatus, changedMsAgo: number) => ({
  id,
  userId: `user-${id}`,
  status,
  updatedAt: new Date(NOW - changedMsAgo).toISOString(),
});

describe('DriverReconciliationService (#98: drivers left BUSY after their delivery finished)', () => {
  let deliveries: jest.Mocked<Pick<DeliveriesRepository, 'findFinishedWithDriverSince' | 'findActiveByDriverId'>>;
  let drivers: jest.Mocked<Pick<DriverServiceClient, 'getDriver' | 'releaseDriver'>>;
  let service: DriverReconciliationService;

  beforeEach(() => {
    deliveries = {
      findFinishedWithDriverSince: jest.fn().mockResolvedValue([]),
      findActiveByDriverId: jest.fn().mockResolvedValue([]),
    };
    drivers = { getDriver: jest.fn(), releaseDriver: jest.fn().mockResolvedValue(undefined) };
    service = new DriverReconciliationService(
      deliveries as unknown as DeliveriesRepository,
      drivers as unknown as DriverServiceClient,
      { driverReconcileSweepMs: 0, driverReconcileGraceMs: GRACE } as AppConfig,
    );
  });

  it('releases a driver still BUSY with no active delivery once the grace period has passed', async () => {
    deliveries.findFinishedWithDriverSince.mockResolvedValue([finished('d1', 'drv-1')]);
    drivers.getDriver.mockResolvedValue(driver('drv-1', DriverStatus.BUSY, GRACE + 1_000));

    await expect(service.sweep(NOW)).resolves.toEqual(['drv-1']);
    expect(drivers.releaseDriver).toHaveBeenCalledWith('drv-1');
    expect(deliveries.findFinishedWithDriverSince).toHaveBeenCalledWith(new Date(NOW - 24 * 60 * 60 * 1000), 100);
  });

  it('leaves a driver who is on another active delivery alone', async () => {
    deliveries.findFinishedWithDriverSince.mockResolvedValue([finished('d1', 'drv-1')]);
    deliveries.findActiveByDriverId.mockResolvedValue([{ ...finished('d2', 'drv-1'), status: DeliveryStatus.DRIVER_ASSIGNED } as Delivery]);

    await expect(service.sweep(NOW)).resolves.toEqual([]);
    expect(drivers.getDriver).not.toHaveBeenCalled();
    expect(drivers.releaseDriver).not.toHaveBeenCalled();
  });

  it('leaves a driver who is no longer BUSY (already released, offline, suspended) alone', async () => {
    deliveries.findFinishedWithDriverSince.mockResolvedValue([finished('d1', 'drv-1'), finished('d2', 'drv-2'), finished('d3', 'drv-3')]);
    drivers.getDriver.mockImplementation(async (id) =>
      id === 'drv-1'
        ? driver(id, DriverStatus.AVAILABLE, GRACE * 10)
        : id === 'drv-2'
          ? driver(id, DriverStatus.OFFLINE, GRACE * 10)
          : driver(id, DriverStatus.SUSPENDED, GRACE * 10),
    );

    await expect(service.sweep(NOW)).resolves.toEqual([]);
    expect(drivers.releaseDriver).not.toHaveBeenCalled();
  });

  it('never releases a driver whose status changed within the grace period (could be mid-assignment)', async () => {
    deliveries.findFinishedWithDriverSince.mockResolvedValue([finished('d1', 'drv-1')]);
    drivers.getDriver.mockResolvedValue(driver('drv-1', DriverStatus.BUSY, GRACE - 1_000));

    await expect(service.sweep(NOW)).resolves.toEqual([]);
    expect(drivers.releaseDriver).not.toHaveBeenCalled();
  });

  it('does not release when driver-service gives no last-change time', async () => {
    deliveries.findFinishedWithDriverSince.mockResolvedValue([finished('d1', 'drv-1')]);
    drivers.getDriver.mockResolvedValue({ id: 'drv-1', userId: 'u', status: DriverStatus.BUSY });

    await expect(service.sweep(NOW)).resolves.toEqual([]);
    expect(drivers.releaseDriver).not.toHaveBeenCalled();
  });

  it('checks each driver once per sweep and carries on after one driver fails', async () => {
    deliveries.findFinishedWithDriverSince.mockResolvedValue([
      finished('d1', 'drv-1'),
      finished('d2', 'drv-1', DeliveryStatus.CANCELLED),
      finished('d3', 'drv-2'),
      finished('d4', undefined),
    ]);
    drivers.getDriver.mockImplementation(async (id) => {
      if (id === 'drv-1') throw new Error('driver-service unavailable');
      return driver(id, DriverStatus.BUSY, GRACE * 2);
    });

    await expect(service.sweep(NOW)).resolves.toEqual(['drv-2']);
    expect(drivers.getDriver).toHaveBeenCalledTimes(2);
    expect(drivers.releaseDriver).toHaveBeenCalledTimes(1);
  });

  it('skips a sweep while the previous one is still running', async () => {
    let finish: (value: Delivery[]) => void = () => undefined;
    deliveries.findFinishedWithDriverSince.mockReturnValueOnce(new Promise<Delivery[]>((resolve) => (finish = resolve)));

    const first = service.sweep(NOW);
    await expect(service.sweep(NOW)).resolves.toEqual([]);
    finish([]);
    await expect(first).resolves.toEqual([]);
    expect(deliveries.findFinishedWithDriverSince).toHaveBeenCalledTimes(1);
  });
});
