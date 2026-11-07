import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PrivateDocumentStorage } from '@food-delivery/shared';
import { Driver } from '../../entities/driver.entity';
import { DriverDocument } from '../../entities/driver-document.entity';
import { DriverDocumentAccess } from '../../entities/driver-document-access.entity';
import { DriversRepository } from '../../repositories/drivers.repository';
import { DriverApplicationRepository } from '../../repositories/driver-application.repository';
import { DriversService } from '../../services/drivers.service';
import { DRIVER_DOCUMENT_STORAGE, DriverApplicationService } from '../../services/driver-application.service';
import { DriversController } from '../../controllers/drivers.controller';
import { DriverApplicationController } from '../../controllers/driver-application.controller';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { UserServiceClient } from '../../common/user-service.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([Driver, DriverDocument, DriverDocumentAccess]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  // The application controller first: its `me/…` routes must be matched before any `:id/…` route.
  controllers: [DriverApplicationController, DriversController],
  providers: [
    DriversService,
    DriversRepository,
    UserServiceClient,
    DriverApplicationService,
    DriverApplicationRepository,
    {
      provide: DRIVER_DOCUMENT_STORAGE,
      useFactory: (config: AppConfig) => new PrivateDocumentStorage({ bucket: config.documentsBucket }),
      inject: [APP_CONFIG],
    },
  ],
})
export class DriversModule {}
