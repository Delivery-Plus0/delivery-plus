import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, RedisModule } from '@food-delivery/shared';
import { DriversModule } from './modules/drivers/drivers.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Driver } from './entities/driver.entity';
import { DriverDocument } from './entities/driver-document.entity';
import { DriverDocumentAccess } from './entities/driver-document-access.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Driver, DriverDocument, DriverDocumentAccess])),
    // #207: rate limits on document uploads and staff document reads.
    RedisModule.register({ url: config.redisUrl }),
    DriversModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
