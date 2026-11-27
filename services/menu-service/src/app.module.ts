import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { MenuModule } from './modules/menu/menu.module';
import { HealthController } from './controllers/health.controller';
import { OutboxModule } from './common/outbox.module';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Category } from './entities/category.entity';
import { MenuItem } from './entities/menu-item.entity';
import { MenuItemImage } from './entities/menu-item-image.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Category, MenuItem, MenuItemImage])),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    MenuModule,
    // #213: publishes this service's outbox (staff audit events); it consumes nothing.
    KafkaModule.register({
      clientId: 'menu-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      producerOnly: true,
    }),
    OutboxModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
