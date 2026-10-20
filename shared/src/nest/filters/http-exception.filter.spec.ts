import { BadRequestException, Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AllExceptionsFilter, INTERNAL_ERROR_MESSAGE } from './http-exception.filter';
import { ConflictError } from '../../errors/app-error';

@Controller()
class ThrowingController {
  @Get('crash')
  secret() {
    throw new Error('secret: password=hunter2 host=db.internal');
  }

  @Get('db-error')
  queryFailed() {
    const error = new Error('duplicate key value violates unique constraint "UQ_users_email" at 10.0.3.7');
    error.name = 'QueryFailedError';
    throw error;
  }

  @Get('thrown-string')
  notAnError() {
    throw 'raw string with internals';
  }

  @Get('conflict')
  conflict() {
    throw new ConflictError('Order is already cancelled');
  }

  @Get('bad-request')
  badRequest() {
    throw new BadRequestException('name must be a string');
  }
}

@Module({ controllers: [ThrowingController] })
class TestModule {}

describe('AllExceptionsFilter (F3, #204)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  const logger = { log: jest.fn() };

  beforeAll(async () => {
    app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
    app.useGlobalFilters(new AllExceptionsFilter(logger as never));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => logger.log.mockClear());

  const get = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { 'x-correlation-id': 'corr-123' } });
    return { status: response.status, text: await response.text() };
  };

  it.each(['/crash', '/db-error', '/thrown-string'])('never returns the underlying error on 500 (%s)', async (path) => {
    const { status, text } = await get(path);

    expect(status).toBe(500);
    expect(text).not.toMatch(/secret|hunter2|db\.internal|duplicate key|10\.0\.3\.7|raw string/);
    expect(JSON.parse(text)).toMatchObject({ statusCode: 500, error: 'InternalServerError', message: INTERNAL_ERROR_MESSAGE });
  });

  it('logs the real error, with its stack, as an error', async () => {
    await get('/crash');

    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'error',
        statusCode: 500,
        cause: expect.objectContaining({ message: 'secret: password=hunter2 host=db.internal', stack: expect.any(String) }),
      }),
    );
  });

  it('keeps the message of errors meant for the client', async () => {
    await expect(get('/conflict')).resolves.toMatchObject({ status: 409 });
    expect(JSON.parse((await get('/conflict')).text)).toMatchObject({ error: 'Conflict', message: 'Order is already cancelled' });
    expect(JSON.parse((await get('/bad-request')).text)).toMatchObject({ statusCode: 400, message: 'name must be a string' });
  });
});
