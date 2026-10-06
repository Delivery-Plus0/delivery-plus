import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { LocationRepository } from '../../repositories/location.repository';
import { TrackingService } from '../../services/tracking.service';
import { TrackingStreamService } from '../../services/tracking-stream.service';
import { ETA_ESTIMATOR, NO_ETA_ESTIMATOR } from '../../services/eta';
import { DeliveryEventsBridge } from '../../services/delivery-events.bridge';
import { TrackingEventsBus } from '../../common/tracking-events.bus';
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
    // No routing provider yet (#46): ETAs are reported as NOT_ESTIMATED; a provider replaces this.
    { provide: ETA_ESTIMATOR, useValue: NO_ETA_ESTIMATOR },
    TrackingStreamService,
    TrackingEventsBus,
    DeliveryEventsBridge,
    LocationRepository,
    DeliveryServiceClient,
    DriverServiceClient,
    SystemTokenService,
  ],
  exports: [LocationRepository],
})
export class TrackingModule {}

