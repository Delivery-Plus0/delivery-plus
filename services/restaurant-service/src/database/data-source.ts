import { DataSource } from 'typeorm';
import { Restaurant } from '../entities/restaurant.entity';
import { RestaurantReview } from '../entities/restaurant-review.entity';
import { buildTypeOrmConfig } from './typeorm.config';

export default new DataSource(
  buildTypeOrmConfig(
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/restaurant_service',
    [Restaurant, RestaurantReview],
  ),
);
