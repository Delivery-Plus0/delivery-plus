import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, RedisModule } from '@food-delivery/shared';
import { AuthModule } from './modules/auth/auth.module';
import { HealthController } from './controllers/health.controller';
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
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
