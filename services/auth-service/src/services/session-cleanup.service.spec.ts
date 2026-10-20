import { AppConfig } from '../config/app-config';
import { SessionCleanupService } from './session-cleanup.service';
import { SessionsService } from './sessions.service';

describe('SessionCleanupService (#34)', () => {
  afterEach(() => jest.useRealTimers());

  const make = (intervalMs: number, deleteEnded = jest.fn().mockResolvedValue(3)) => ({
    deleteEnded,
    cleanup: new SessionCleanupService({ deleteEnded } as unknown as SessionsService, { sessionCleanupIntervalMs: intervalMs } as AppConfig),
  });

  it('deletes ended sessions on every interval', async () => {
    jest.useFakeTimers();
    const { cleanup, deleteEnded } = make(1000);

    cleanup.onModuleInit();
    await jest.advanceTimersByTimeAsync(3000);
    cleanup.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(3000);

    expect(deleteEnded).toHaveBeenCalledTimes(3);
  });

  it('does not schedule anything when the interval is 0', async () => {
    jest.useFakeTimers();
    const { cleanup, deleteEnded } = make(0);

    cleanup.onModuleInit();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(deleteEnded).not.toHaveBeenCalled();
  });

  it('returns how many it deleted, skips an overlapping run and survives a failure', async () => {
    let finish: (value: number) => void = () => undefined;
    const slow = jest.fn(() => new Promise<number>((resolve) => (finish = resolve)));
    const { cleanup } = make(0, slow);

    const first = cleanup.sweep();
    await expect(cleanup.sweep()).resolves.toBe(0);
    finish(5);
    await expect(first).resolves.toBe(5);

    slow.mockRejectedValueOnce(new Error('db down'));
    await expect(cleanup.sweep()).resolves.toBe(0);
    expect(slow).toHaveBeenCalledTimes(2);
  });
});
