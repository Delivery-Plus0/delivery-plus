import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, KafkaModule, RedisModule } from '@food-delivery/shared';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './controllers/health.controller';
import { OutboxModule } from './common/outbox.module';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Credential } from './entities/credential.entity';
import { AuthSession } from './entities/auth-session.entity';
import { StaffPermission } from './entities/staff-permission.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Credential, AuthSession, StaffPermission])),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    AuthModule,
    // #213: publishes this service's outbox (staff audit events); it consumes nothing.
    KafkaModule.register({
      clientId: 'auth-service',
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
