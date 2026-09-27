import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Category } from '../../entities/category.entity';
import { MenuItem } from '../../entities/menu-item.entity';
import { CategoriesRepository } from '../../repositories/categories.repository';
import { MenuItemsRepository } from '../../repositories/menu-items.repository';
import { RestaurantServiceClient } from '../../common/restaurant-service.client';
import { MenuService } from '../../services/menu.service';
import { MenuController } from '../../controllers/menu.controller';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { S3StorageService } from '@food-delivery/shared';

@Module({
  imports: [
    TypeOrmModule.forFeature([Category, MenuItem]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [MenuController],
  providers: [MenuService, CategoriesRepository, MenuItemsRepository, RestaurantServiceClient, S3StorageService],
})
export class MenuModule {}
