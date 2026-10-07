import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Driver } from '../../entities/driver.entity';
import { DriversRepository } from '../../repositories/drivers.repository';
import { DriversService } from '../../services/drivers.service';
import { DriversController } from '../../controllers/drivers.controller';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { UserServiceClient } from '../../common/user-service.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([Driver]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [DriversController],
  providers: [DriversService, DriversRepository, UserServiceClient],
})
export class DriversModule {}
