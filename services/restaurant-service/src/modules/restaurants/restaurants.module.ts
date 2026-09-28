import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from '../../entities/restaurant.entity';
import { RestaurantsRepository } from '../../repositories/restaurants.repository';
import { RestaurantsService } from '../../services/restaurants.service';
import { RestaurantsController } from '../../controllers/restaurants.controller';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { S3StorageService } from '@food-delivery/shared';

@Module({
  imports: [
    TypeOrmModule.forFeature([Restaurant]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [RestaurantsController],
  providers: [RestaurantsService, RestaurantsRepository, S3StorageService],
})
export class RestaurantsModule {}
