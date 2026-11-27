import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { DriversModule } from './modules/drivers/drivers.module';
import { HealthController } from './controllers/health.controller';
import { OutboxModule } from './common/outbox.module';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Driver } from './entities/driver.entity';
import { DriverDocument } from './entities/driver-document.entity';
import { DriverDocumentAccess } from './entities/driver-document-access.entity';
import { DriverReview } from './entities/driver-review.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Driver, DriverDocument, DriverDocumentAccess, DriverReview])),
    // #207: rate limits on document uploads and staff document reads.
    RedisModule.register({ url: config.redisUrl }),
    DriversModule,
    // #213: publishes this service's outbox (staff audit events); it consumes nothing.
    KafkaModule.register({
      clientId: 'driver-service',
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
