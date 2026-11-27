import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { HealthController } from './controllers/health.controller';
import { AuditModule } from './modules/audit.module';
import { AuditEvent } from './entities/audit-event.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildTypeOrmConfig(config.databaseUrl, [AuditEvent]),
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
    }),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    KafkaModule.register({
      clientId: 'audit-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      groupId: 'audit-service-group',
      durableIdempotency: true,
    }),
    AuditModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
