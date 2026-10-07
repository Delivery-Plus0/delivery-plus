import { DriverStatus } from '@food-delivery/shared';
import { DriverServiceClient } from '../common/driver-service.client';
import { AppConfig } from '../config/app-config';
import { DriverLedgerEntry, LedgerEntryStatus, LedgerEntryType } from '../entities/driver-ledger-entry.entity';
import { LedgerRepository } from '../repositories/ledger.repository';
import { EarningsService } from './earnings.service';

const NOW = new Date('2026-10-07T12:00:00Z');

const entry = (overrides: Partial<DriverLedgerEntry>): DriverLedgerEntry =>
  ({
    id: 'e-1',
    driverId: 'driver-1',
    deliveryId: 'd-1',
    orderId: 'o-1',
    type: LedgerEntryType.DELIVERY_EARNING,
    amount: '12.50',
    status: LedgerEntryStatus.PENDING,
    availableAt: new Date('2026-10-08T00:00:00Z'),
    settledAt: null,
    createdAt: NOW,
    ...overrides,
  }) as DriverLedgerEntry;

describe('EarningsService', () => {
  let ledger: { settleDue: jest.Mock; totals: jest.Mock; findPage: jest.Mock };
  let driverClient: { getOwnProfile: jest.Mock };
  let service: EarningsService;

  beforeEach(() => {
    ledger = {
      settleDue: jest.fn().mockResolvedValue(0),
      totals: jest.fn().mockResolvedValue({ pending: '12.50', available: '6.25', balance: '18.75' }),
      findPage: jest.fn().mockResolvedValue([[entry({}), entry({ id: 'e-2', type: LedgerEntryType.CANCELLATION_COMPENSATION, amount: '6.25', status: LedgerEntryStatus.AVAILABLE })], 2]),
    };
    driverClient = { getOwnProfile: jest.fn().mockResolvedValue({ id: 'driver-1', userId: 'u-1', status: DriverStatus.AVAILABLE }) };
    service = new EarningsService(
      ledger as unknown as LedgerRepository,
      driverClient as unknown as DriverServiceClient,
      { earningsSettlementHours: 12, earningsSettleSweepMs: 0 } as AppConfig,
    );
  });

  it("settles the caller's due entries, then reports ledger totals and entries", async () => {
    const earnings = await service.getForDriver('Bearer driver', 1, 20, NOW);

    expect(driverClient.getOwnProfile).toHaveBeenCalledWith('Bearer driver');
    expect(ledger.settleDue).toHaveBeenCalledWith(NOW, 'driver-1');
    expect(ledger.settleDue.mock.invocationCallOrder[0]).toBeLessThan(ledger.totals.mock.invocationCallOrder[0]);
    expect(earnings).toMatchObject({
      currency: 'EGP',
      pending: '12.50',
      available: '6.25',
      balance: '18.75',
      settlementHours: 12,
      total: 2,
      totalPages: 1,
    });
    expect(earnings.entries.map((e) => [e.type, e.amount, e.status])).toEqual([
      ['DELIVERY_EARNING', '12.50', 'PENDING'],
      ['CANCELLATION_COMPENSATION', '6.25', 'AVAILABLE'],
    ]);
    expect(Object.keys(earnings.entries[0]).sort()).toEqual(['amount', 'availableAt', 'createdAt', 'deliveryId', 'id', 'orderId', 'status', 'type']);
  });

  it('is empty for a user with no driver profile', async () => {
    driverClient.getOwnProfile.mockResolvedValue(null);
    await expect(service.getForDriver('Bearer x', 1, 20, NOW)).resolves.toMatchObject({ balance: '0.00', entries: [], total: 0 });
    expect(ledger.settleDue).not.toHaveBeenCalled();
  });

  it('sweeps due entries for every driver and survives a failed sweep', async () => {
    ledger.settleDue.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('db down'));
    await expect(service.sweep(NOW)).resolves.toBe(3);
    expect(ledger.settleDue).toHaveBeenCalledWith(NOW);
    await expect(service.sweep(NOW)).resolves.toBe(0);
  });
});
