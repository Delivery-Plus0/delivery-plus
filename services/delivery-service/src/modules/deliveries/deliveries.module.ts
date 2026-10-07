import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from '../../entities/delivery.entity';
import { DeliveryRating } from '../../entities/delivery-rating.entity';
import { DriverRatingSummary } from '../../entities/driver-rating-summary.entity';
import { RatingsRepository } from '../../repositories/ratings.repository';
import { RatingsService } from '../../services/ratings.service';
import { DeliveriesRepository } from '../../repositories/deliveries.repository';
import { DeliveriesService } from '../../services/deliveries.service';
import { AutoDispatchService } from '../../services/auto-dispatch.service';
import { DriverReconciliationService } from '../../services/driver-reconciliation.service';
import { DeliveriesController } from '../../controllers/deliveries.controller';
import { OrderServiceClient } from '../../common/order-service.client';
import { DriverServiceClient } from '../../common/driver-service.client';
import { RestaurantServiceClient } from '../../common/restaurant-service.client';
import { UserServiceClient } from '../../common/user-service.client';
import { DriverCardService } from '../../services/driver-card.service';
import { DriverHistoryService } from '../../services/driver-history.service';
import { SystemTokenService } from '../../common/system-token.service';
import { OutboxRelayService } from '../../common/outbox-relay.service';
import { APP_CONFIG, AppConfig } from '../../config/app-config';

@Module({
  imports: [
    TypeOrmModule.forFeature([Delivery, DeliveryRating, DriverRatingSummary]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [DeliveriesController],
  providers: [
    OutboxRelayService,
    DeliveriesService,
    AutoDispatchService,
    DriverReconciliationService,
    DeliveriesRepository,
    OrderServiceClient,
    DriverServiceClient,
    RestaurantServiceClient,
    UserServiceClient,
    DriverCardService,
    DriverHistoryService,
    RatingsRepository,
    RatingsService,
    SystemTokenService,
  ],
})
export class DeliveriesModule {}
