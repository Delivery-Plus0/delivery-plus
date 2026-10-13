import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, KafkaModule } from '@food-delivery/shared';
import { PaymentsModule } from './modules/payments/payments.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Payment } from './entities/payment.entity';
import { Refund } from './entities/refund.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Payment, Refund])),
    KafkaModule.register({
      clientId: 'payment-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      // Consumes order.cancelled for refunds (#56). Its handler is idempotent in the database, so no
      // Redis-backed durable idempotency is needed here.
      groupId: 'payment-service-group',
    }),
    PaymentsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
