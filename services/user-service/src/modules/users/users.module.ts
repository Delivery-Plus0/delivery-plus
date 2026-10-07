import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserProfile } from '../../entities/user-profile.entity';
import { PhoneVerification } from '../../entities/phone-verification.entity';
import { PhoneVerificationsRepository } from '../../repositories/phone-verifications.repository';
import { PhoneVerificationService } from '../../services/phone-verification.service';
import { DisabledSmsSender, SmsSender, TestSmsSender } from '../../sms/sms-sender';
import { Redis } from 'ioredis';
import { ProfilesRepository } from '../../repositories/profiles.repository';
import { UsersService } from '../../services/users.service';
import { UsersController } from '../../controllers/users.controller';
import { OrderServiceClient } from '../../common/order-service.client';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { InternalAuthGuard } from '../../guards/internal-auth.guard';
import { S3StorageService } from '@food-delivery/shared';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserProfile, PhoneVerification]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    ProfilesRepository,
    OrderServiceClient,
    InternalAuthGuard,
    S3StorageService,
    PhoneVerificationsRepository,
    PhoneVerificationService,
    {
      // #153: no real provider yet; the test sender exists only where the config allows it.
      provide: SmsSender,
      useFactory: (config: AppConfig, redis: Redis) =>
        config.smsProvider === 'test' ? new TestSmsSender(redis) : new DisabledSmsSender(),
      inject: [APP_CONFIG, 'REDIS_CLIENT'],
    },
  ],
})
export class UsersModule {}
