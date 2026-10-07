import { QueryRunner } from 'typeorm';
import { NormalizePhones1700000000003 } from './004-normalize-phones';

describe('NormalizePhones migration', () => {
  it('stores Egyptian mobiles as E.164, clears what is not one, and leaves normalized values alone', async () => {
    const rows = [
      { id: 'a', phone: '0020-109-278-4342' },
      { id: 'b', phone: '+201112345678' },
      { id: 'c', phone: '+1 555 010 2030' },
      { id: 'd', phone: '01212345678' },
    ];
    const query = jest.fn().mockImplementation(async (sql: string) => (sql.startsWith('SELECT') ? rows : undefined));

    await new NormalizePhones1700000000003().up({ query } as unknown as QueryRunner);

    const updates = query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE')).map(([, params]) => params);
    expect(updates).toEqual([
      ['+201092784342', 'a'],
      [null, 'c'],
      ['+201212345678', 'd'],
    ]);
  });
});
