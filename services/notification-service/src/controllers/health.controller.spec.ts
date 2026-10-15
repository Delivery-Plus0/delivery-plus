import { ServiceUnavailableException } from '@nestjs/common';

import { Connection } from 'typeorm';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ready when the database answers', async () => {
    const connection = { query: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const controller = new HealthController(connection as unknown as Connection);

    await expect(controller.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { postgres: 'ok' },
    });
    expect(connection.query).toHaveBeenCalledWith('SELECT 1');
  });

  it('answers 503 instead of 200 when the database is down', async () => {
    const connection = {
      query: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    };
    const controller = new HealthController(connection as unknown as Connection);

    const error = await controller.readiness().catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ status: 'error', checks: { postgres: 'error' } });
    // The connection error (host, port) must not reach whoever polls the probe.
    expect(JSON.stringify(error.getResponse())).not.toContain('10.0.0.5');
  });

  it('keeps liveness independent of the database', () => {
    const connection = { query: jest.fn() };
    const controller = new HealthController(connection as unknown as Connection);

    expect(controller.liveness()).toEqual({ status: 'OK' });
    expect(connection.query).not.toHaveBeenCalled();
  });
});
