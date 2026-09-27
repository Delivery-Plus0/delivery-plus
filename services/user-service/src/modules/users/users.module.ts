import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserProfile } from '../../entities/user-profile.entity';
import { ProfilesRepository } from '../../repositories/profiles.repository';
import { UsersService } from '../../services/users.service';
import { UsersController } from '../../controllers/users.controller';
import { OrderServiceClient } from '../../common/order-service.client';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { InternalAuthGuard } from '../../guards/internal-auth.guard';
import { S3StorageService } from '@food-delivery/shared';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserProfile]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [UsersController],
  providers: [UsersService, ProfilesRepository, OrderServiceClient, InternalAuthGuard, S3StorageService],
})
export class UsersModule {}
