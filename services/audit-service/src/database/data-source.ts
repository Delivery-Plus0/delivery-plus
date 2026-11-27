import { DataSource } from 'typeorm';
import { AuditEvent } from '../entities/audit-event.entity';
import { buildTypeOrmConfig } from './typeorm.config';

export default new DataSource(
  buildTypeOrmConfig(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/audit_service', [AuditEvent]),
);
