import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { TrackingModule } from './modules/tracking/tracking.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';

@Module({
  imports: [
    ConfigModule,
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    // delivery.events → realtime tracking triggers (#135). No durable idempotency: a redelivered event
    // only causes one more recompute, and an unchanged result is not resent to customers.
    KafkaModule.register({
      clientId: 'tracking-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      groupId: 'tracking-service-group',
    }),
    TrackingModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
