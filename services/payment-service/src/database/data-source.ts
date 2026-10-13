import { DataSource } from 'typeorm';
import { Payment } from '../entities/payment.entity';
import { Refund } from '../entities/refund.entity';
import { buildTypeOrmConfig } from './typeorm.config';

export default new DataSource(
  buildTypeOrmConfig(
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/payment_service',
    [Payment, Refund],
  ),
);
