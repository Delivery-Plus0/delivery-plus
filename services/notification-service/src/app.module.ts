import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { HealthController } from './controllers/health.controller';
import { NotificationsModule } from './modules/notifications.module';
import { Notification } from './entities/notification.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => buildTypeOrmConfig(config.databaseUrl, [Notification]),
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: '1h' },
      }),
    }),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    KafkaModule.register({
      clientId: 'notification-service',
      brokers: [process.env.KAFKA_BROKER || 'localhost:9092'],
      groupId: 'notification-service-group',
      durableIdempotency: true,
    }),
    NotificationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
