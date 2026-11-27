import { AdminRestaurantActionsController } from '../../controllers/admin-restaurant-actions.controller';
import { AdminRestaurantActionsService } from '../../services/admin-restaurant-actions.service';
import { AdminRestaurantsController } from '../../controllers/admin-restaurants.controller';
import { InternalRestaurantsController } from '../../controllers/internal-restaurants.controller';
import { AdminRestaurantsService } from '../../services/admin-restaurants.service';
import { StaffLookupsClient } from '../../common/staff-lookups.client';
import { SystemTokenService } from '../../common/system-token.service';
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
  controllers: [RestaurantsController, AdminRestaurantsController, AdminRestaurantActionsController, InternalRestaurantsController],
  providers: [
    RestaurantsService,
    RestaurantsRepository,
    S3StorageService,
    InternalAuthGuard,
    MenuServiceClient,
    AdminRestaurantsService,
    AdminRestaurantActionsService,
    StaffLookupsClient,
    SystemTokenService,
  ],
})
export class RestaurantsModule {}
