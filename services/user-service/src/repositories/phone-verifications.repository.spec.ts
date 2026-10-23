import { PhoneVerificationsRepository } from './phone-verifications.repository';

describe('PhoneVerificationsRepository purpose scoping (#35)', () => {
  function setup() {
    const inner = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((row) => row),
      save: jest.fn(async (row) => row),
    };
    const manager = { query: jest.fn(), getRepository: jest.fn(() => inner) };
    const outer = {
      manager: { transaction: (run: (m: unknown) => unknown) => run(manager) },
      query: jest.fn().mockResolvedValue([[{ id: 'v-1', attempts: 1 }], 1]),
    };
    return { inner, outer, repository: new PhoneVerificationsRepository(outer as never) };
  }
  const row = { id: 'v-1', userId: 'u-1', phone: '+201012345678', codeHash: 'h', expiresAt: new Date() };

  it('reads the latest row and both send counts for the given purpose only', async () => {
    const { inner, repository } = setup();
    await repository.createUnderLimits('u-1', row.phone, new Date(), () => row, 'password_reset');

    expect(inner.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u-1', purpose: 'password_reset' } }));
    for (const [arg] of inner.count.mock.calls) expect(arg.where.purpose).toBe('password_reset');
    expect(inner.save).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'password_reset' }));
  });

  it('defaults to phone verification', async () => {
    const { inner, repository } = setup();
    await repository.createUnderLimits('u-1', row.phone, new Date(), () => row);
    expect(inner.findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u-1', purpose: 'phone_verification' } }));
  });

  it('counts attempts and consumes only rows of the given purpose', async () => {
    const { outer, repository } = setup();
    await repository.registerAttempt('v-1', 5, 'password_reset');
    expect(outer.query.mock.calls[0][0]).toContain('"purpose" = $3');
    expect(outer.query.mock.calls[0][1]).toEqual(['v-1', 5, 'password_reset']);

    await repository.consume('v-1', 'password_reset');
    expect(outer.query.mock.calls[1][0]).toContain('"purpose" = $2');
    expect(outer.query.mock.calls[1][1]).toEqual(['v-1', 'password_reset']);
  });
});