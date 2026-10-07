import { DataSource } from 'typeorm';
import { UserProfile } from '../entities/user-profile.entity';
import { PhoneVerification } from '../entities/phone-verification.entity';
import { buildTypeOrmConfig } from './typeorm.config';

export default new DataSource(
  buildTypeOrmConfig(
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/user_service',
    [UserProfile, PhoneVerification],
  ),
);
