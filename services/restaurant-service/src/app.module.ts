import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CorrelationIdMiddleware, RedisModule } from '@food-delivery/shared';
import { RestaurantsModule } from './modules/restaurants/restaurants.module';
import { HealthController } from './controllers/health.controller';
import { ConfigModule } from './config/config.module';
import { loadConfig } from './config/app-config';
import { Restaurant } from './entities/restaurant.entity';
import { RestaurantReview } from './entities/restaurant-review.entity';
import { buildTypeOrmConfig } from './database/typeorm.config';

const config = loadConfig();

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forRoot(buildTypeOrmConfig(config.databaseUrl, [Restaurant, RestaurantReview])),
    RedisModule.register({ url: process.env.REDIS_URL || 'redis://localhost:6379' }),
    RestaurantsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
