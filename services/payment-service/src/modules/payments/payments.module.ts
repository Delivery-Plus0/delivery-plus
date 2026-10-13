import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from '../../entities/payment.entity';
import { Refund } from '../../entities/refund.entity';
import { RefundWorkerService } from '../../services/refund-worker.service';
import { PaymentsRepository } from '../../repositories/payments.repository';
import { PaymentsService } from '../../services/payments.service';
import { PaymentsController } from '../../controllers/payments.controller';
import { OrderServiceClient } from '../../common/order-service.client';
import { SystemTokenService } from '../../common/system-token.service';
import { APP_CONFIG, AppConfig } from '../../config/app-config';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Refund]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({ secret: config.jwtSecret }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, RefundWorkerService, PaymentsRepository, OrderServiceClient, SystemTokenService],
})
export class PaymentsModule {}
