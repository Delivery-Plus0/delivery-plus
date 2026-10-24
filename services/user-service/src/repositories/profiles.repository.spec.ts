import { Logger } from '@nestjs/common';
import { ProfilesRepository } from './profiles.repository';

describe('ProfilesRepository.findByVerifiedPhone (#35)', () => {
  const repoWith = (rows: unknown[]) => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(rows),
    };
    const inner = { createQueryBuilder: jest.fn(() => qb) };
    return { repository: new ProfilesRepository(inner as never), qb };
  };

  afterEach(() => jest.restoreAllMocks());

  it('returns the profile when exactly one verified profile has the phone', async () => {
    const { repository, qb } = repoWith([{ id: 'u-1' }]);

    await expect(repository.findByVerifiedPhone('+201012345678')).resolves.toEqual({ id: 'u-1' });

    expect(qb.take).toHaveBeenCalledWith(2);
  });

  it('returns null when none does', async () => {
    const { repository } = repoWith([]);

    await expect(repository.findByVerifiedPhone('+201012345678')).resolves.toBeNull();
  });

  it('returns null and warns, without the phone, when two profiles claim it', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { repository } = repoWith([{ id: 'u-1' }, { id: 'u-2' }]);

    await expect(repository.findByVerifiedPhone('+201012345678')).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('u-1,u-2'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('+201012345678'));
  });
});