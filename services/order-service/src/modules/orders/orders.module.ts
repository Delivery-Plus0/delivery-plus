import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from '../../entities/order.entity';
import { OrderItem } from '../../entities/order-item.entity';
import { OrdersRepository } from '../../repositories/orders.repository';
import { OrdersService } from '../../services/orders.service';
import { OrdersController } from '../../controllers/orders.controller';
import { CartServiceClient } from '../../common/cart-service.client';
import { RestaurantServiceClient } from '../../common/restaurant-service.client';
import { UserServiceClient } from '../../common/user-service.client';
import { OutboxRelayService } from '../../common/outbox-relay.service';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { RolesGuard } from '@food-delivery/shared';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersRepository,
    OutboxRelayService,
    CartServiceClient,
    RestaurantServiceClient,
    UserServiceClient,
    RolesGuard,
  ],
})
export class OrdersModule {}
