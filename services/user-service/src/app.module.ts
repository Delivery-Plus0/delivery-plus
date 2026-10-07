import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware } from '@food-delivery/shared';
import { UsersModule } from './modules/users/users.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { UserProfile } from './entities/user-profile.entity';
import { PhoneVerification } from './entities/phone-verification.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';
import { RedisModule } from '@food-delivery/shared';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    RedisModule.register({ url: config.redisUrl }),
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [UserProfile, PhoneVerification])),
    UsersModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
