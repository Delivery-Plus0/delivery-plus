import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { OrdersModule } from './modules/orders/orders.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Order } from './entities/order.entity';
import { OrderItem } from './entities/order-item.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Order, OrderItem])),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    KafkaModule.register({
      clientId: 'order-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      groupId: 'order-service-group',
      durableIdempotency: true,
    }),
    OrdersModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
