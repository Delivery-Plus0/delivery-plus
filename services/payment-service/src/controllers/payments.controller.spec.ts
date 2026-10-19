import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { AllExceptionsFilter, KafkaProducerService, PaymentStatus, UserRole } from '@food-delivery/shared';
import { PaymentsController } from './payments.controller';
import { PaymentsService, SIMULATE_FAILURE_DISABLED } from '../services/payments.service';
import { PaymentsRepository } from '../repositories/payments.repository';
import { OrderServiceClient } from '../common/order-service.client';

const jwtSecret = 'test-jwt-secret';
const customerId = '44444444-4444-41d4-a716-446655440000';
const paymentId = '55555555-5555-41d4-a716-446655440000';

/** A PENDING payment whose creation side effects are done, so processing it settles it at once. */
const pending = () => ({
  id: paymentId,
  orderId: '66666666-6666-41d4-a716-446655440000',
  customerId,
  amount: '35.00',
  status: PaymentStatus.PENDING,
  publishedEventStatus: PaymentStatus.PENDING,
  orderSyncedStatus: PaymentStatus.PENDING,
});

const payments = {
  findById: jest.fn(),
  claimProcessing: jest.fn(),
  settleProcessing: jest.fn(),
  acquireSideEffectsLease: jest.fn(),
};

/** The real PaymentsService with test hooks OFF, as in development and production (#201). */
@Module({
  imports: [JwtModule.register({ secret: jwtSecret })],
  controllers: [PaymentsController],
  providers: [
    {
      provide: PaymentsService,
      useFactory: () =>
        new PaymentsService(
          payments as unknown as PaymentsRepository,
          { updateOrderStatus: jest.fn() } as unknown as OrderServiceClient,
          { paymentSuccessRate: 1, paymentTestHooks: false, processingTimeoutMs: 60_000, processingAbandonMs: 900_000 } as never,
          { publish: jest.fn() } as unknown as KafkaProducerService,
        ),
    },
  ],
})
class PaymentsControllerTestModule {}

describe('PaymentsController: the simulateFailure test hook over HTTP (#201)', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let baseUrl: string;
  let token: string;

  beforeAll(async () => {
    app = await NestFactory.create(PaymentsControllerTestModule, { logger: false, abortOnError: false });
    // The same pipe and filter as main.ts.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter({ log: jest.fn() } as never));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    token = app.get(JwtService).sign({ sub: customerId, email: 'c@example.com', role: UserRole.CUSTOMER });
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    Object.values(payments).forEach((fn) => fn.mockReset());
  });

  const process = (body: unknown) =>
    fetch(`${baseUrl}/payments/${paymentId}/process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it.each([false, true])('answers 400 to { "simulateFailure": %s } and never touches the payment', async (simulateFailure) => {
    const response = await process({ simulateFailure });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ statusCode: 400, message: SIMULATE_FAILURE_DISABLED });
    expect(payments.findById).not.toHaveBeenCalled();
    expect(payments.claimProcessing).not.toHaveBeenCalled();
  });

  it('settles a payment sent without the hook, which is what clients do', async () => {
    payments.findById
      .mockResolvedValueOnce(pending())
      .mockResolvedValue({ ...pending(), status: PaymentStatus.COMPLETED, publishedEventStatus: PaymentStatus.COMPLETED, orderSyncedStatus: PaymentStatus.COMPLETED });
    payments.claimProcessing.mockResolvedValue(true);
    payments.settleProcessing.mockResolvedValue(true);

    const response = await process({});

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: paymentId, status: PaymentStatus.COMPLETED });
    expect(payments.settleProcessing).toHaveBeenCalledWith(paymentId, expect.any(String), PaymentStatus.COMPLETED, undefined);
  });
});
