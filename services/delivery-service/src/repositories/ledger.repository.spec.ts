import { EntityManager, Repository } from 'typeorm';
import { DriverLedgerEntry, LedgerEntryType } from '../entities/driver-ledger-entry.entity';
import { LedgerRepository } from './ledger.repository';

describe('LedgerRepository', () => {
  const query = jest.fn();
  const repo = new LedgerRepository({ query, findAndCount: jest.fn() } as unknown as Repository<DriverLedgerEntry>);

  beforeEach(() => query.mockReset());

  it('appends inside the given transaction and ignores a second entry for the same (delivery, type)', async () => {
    const manager = { query: jest.fn() } as unknown as EntityManager;
    const availableAt = new Date('2026-10-08T00:00:00Z');

    await repo.appendOnce(manager, { driverId: 'd', deliveryId: 'del', orderId: 'o', type: LedgerEntryType.DELIVERY_EARNING, amount: '12.50', availableAt });

    const [sql, params] = (manager.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('ON CONFLICT ("deliveryId", "type") DO NOTHING');
    expect(sql).toContain("'PENDING'");
    expect(params).toEqual(['d', 'del', 'o', 'DELIVERY_EARNING', '12.50', availableAt]);
  });

  it('settles only due PENDING entries, for one driver or all', async () => {
    const now = new Date('2026-10-07T12:00:00Z');
    query.mockResolvedValueOnce([[], 2]).mockResolvedValueOnce([[], 0]);

    await expect(repo.settleDue(now, 'driver-1')).resolves.toBe(2);
    await expect(repo.settleDue(now)).resolves.toBe(0);

    expect(query.mock.calls[0][0]).toContain(`WHERE "status" = 'PENDING' AND "availableAt" <= $1 AND "driverId" = $2`);
    expect(query.mock.calls[0][1]).toEqual([now, 'driver-1']);
    expect(query.mock.calls[1][1]).toEqual([now]);
  });

  it('computes the balance as the sum of all entries, never a stored number', async () => {
    query.mockResolvedValueOnce([{ pending: '12.50', available: '6.25', balance: '18.75' }]);

    await expect(repo.totals('driver-1')).resolves.toEqual({ pending: '12.50', available: '6.25', balance: '18.75' });
    expect(query.mock.calls[0][0]).toContain('COALESCE(SUM("amount"), 0)');
  });
});
