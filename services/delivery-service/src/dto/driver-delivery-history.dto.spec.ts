import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DriverHistoryQueryDto } from './driver-delivery-history.dto';

async function check(query: Record<string, unknown>) {
  const dto = plainToInstance(DriverHistoryQueryDto, query);
  const errors = await validate(dto);
  return { dto, fields: errors.map((error) => error.property) };
}

describe('DriverHistoryQueryDto', () => {
  it('defaults to page 1 of 20, all statuses', async () => {
    const { dto, fields } = await check({});
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ page: 1, limit: 20 });
    expect(dto.status).toBeUndefined();
  });

  it('accepts the three filters and numeric strings from the query', async () => {
    for (const status of ['active', 'completed', 'cancelled']) {
      const { dto, fields } = await check({ status, page: '2', limit: '50' });
      expect(fields).toEqual([]);
      expect(dto).toMatchObject({ status, page: 2, limit: 50 });
    }
  });

  it('rejects unknown filters and out-of-range paging', async () => {
    expect((await check({ status: 'DELIVERED' })).fields).toEqual(['status']);
    expect((await check({ page: '0' })).fields).toEqual(['page']);
    expect((await check({ limit: '51' })).fields).toEqual(['limit']);
    expect((await check({ limit: '2.5' })).fields).toEqual(['limit']);
  });
});
