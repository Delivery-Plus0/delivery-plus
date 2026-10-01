import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LocationRepository } from '../../repositories/location.repository';
import { TrackingService } from '../../services/tracking.service';
import { TrackingController } from '../../controllers/tracking.controller';
import { DeliveryServiceClient } from '../../common/delivery-service.client';
import { DriverServiceClient } from '../../common/driver-service.client';
import { SystemTokenService } from '../../common/system-token.service';
import { APP_CONFIG, AppConfig } from '../../config/app-config';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [TrackingController],
  providers: [
    TrackingService,
    LocationRepository,
    DeliveryServiceClient,
    DriverServiceClient,
    SystemTokenService,
  ],
  exports: [LocationRepository],
})
export class TrackingModule {}

