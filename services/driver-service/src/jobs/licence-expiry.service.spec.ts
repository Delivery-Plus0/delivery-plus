import { AppConfig } from '../config/app-config';
import { LicenceExpiryRepository } from '../repositories/licence-expiry.repository';
import { LicenceExpiryService } from './licence-expiry.service';

describe('LicenceExpiryService (#207)', () => {
  let repository: { run: jest.Mock };
  let service: LicenceExpiryService;

  beforeEach(() => {
    repository = { run: jest.fn().mockResolvedValue({ expired: [], skippedBusy: 0, expiringSoon: 0 }) };
    service = new LicenceExpiryService(repository as unknown as LicenceExpiryRepository, { licenceExpiryCheckIntervalMs: 0 } as AppConfig);
  });

  it('uses the Cairo calendar date and a 14-day warning window', async () => {
    // 22:30 UTC on 7 November is already 8 November in Cairo (UTC+2).
    await service.run(new Date('2026-11-07T22:30:00Z'));
    expect(repository.run).toHaveBeenCalledWith('2026-11-08', '2026-11-22');
  });

  it('crosses month and year ends in the window', async () => {
    await service.run(new Date('2026-12-25T10:00:00Z'));
    expect(repository.run).toHaveBeenCalledWith('2026-12-25', '2027-01-08');
  });

  it('skips a run while the previous one is still going', async () => {
    let finish: (value: unknown) => void = () => undefined;
    repository.run.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    const first = service.run(new Date('2026-11-08T10:00:00Z'));
    expect(await service.run(new Date('2026-11-08T10:00:00Z'))).toBeNull();
    finish({ expired: [], skippedBusy: 0, expiringSoon: 0 });
    await first;
    expect(repository.run).toHaveBeenCalledTimes(1);
  });

  it('survives a failed run and runs again next time', async () => {
    repository.run.mockRejectedValueOnce(new Error('db down'));
    expect(await service.run(new Date('2026-11-08T10:00:00Z'))).toBeNull();
    await expect(service.run(new Date('2026-11-08T11:00:00Z'))).resolves.toEqual({ expired: [], skippedBusy: 0, expiringSoon: 0 });
  });

  it('starts no timer when the interval is 0', () => {
    const spy = jest.spyOn(global, 'setInterval');
    service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runs on its interval and stops with the module', () => {
    jest.useFakeTimers();
    try {
      const timed = new LicenceExpiryService(repository as unknown as LicenceExpiryRepository, { licenceExpiryCheckIntervalMs: 60_000 } as AppConfig);
      timed.onModuleInit();
      jest.advanceTimersByTime(60_000);
      expect(repository.run).toHaveBeenCalledTimes(1);
      timed.onModuleDestroy();
      jest.advanceTimersByTime(120_000);
      expect(repository.run).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
