import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Delivery } from './entities/delivery.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Delivery])),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    KafkaModule.register({
      clientId: 'delivery-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      groupId: 'delivery-service-group',
      durableIdempotency: true,
    }),
    DeliveriesModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
