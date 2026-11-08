import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from '../../entities/restaurant.entity';
import { RestaurantReview } from '../../entities/restaurant-review.entity';
import { RestaurantsRepository } from '../../repositories/restaurants.repository';
import { RestaurantsService } from '../../services/restaurants.service';
import { RestaurantsController } from '../../controllers/restaurants.controller';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { S3StorageService } from '@food-delivery/shared';
import { InternalAuthGuard } from '../../guards/internal-auth.guard';
import { MenuServiceClient } from '../../common/menu-service.client';

@Module({
  imports: [
    TypeOrmModule.forFeature([Restaurant, RestaurantReview]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [RestaurantsController],
  providers: [RestaurantsService, RestaurantsRepository, S3StorageService, InternalAuthGuard, MenuServiceClient],
})
export class RestaurantsModule {}
