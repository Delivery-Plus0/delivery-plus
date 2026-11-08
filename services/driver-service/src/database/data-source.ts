import { DataSource } from 'typeorm';
import { Driver } from '../entities/driver.entity';
import { DriverDocument } from '../entities/driver-document.entity';
import { DriverDocumentAccess } from '../entities/driver-document-access.entity';
import { DriverReview } from '../entities/driver-review.entity';
import { buildTypeOrmConfig } from './typeorm.config';

export default new DataSource(
  buildTypeOrmConfig(
    process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/driver_service',
    [Driver, DriverDocument, DriverDocumentAccess, DriverReview],
  ),
);
