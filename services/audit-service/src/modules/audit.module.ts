import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEvent } from '../entities/audit-event.entity';
import { AuditEventsRepository } from '../repositories/audit-events.repository';
import { AuditService } from '../services/audit.service';
import { AdminAuditController } from '../controllers/admin-audit.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AuditEvent])],
  controllers: [AdminAuditController],
  providers: [AuditEventsRepository, AuditService],
})
export class AuditModule {}
