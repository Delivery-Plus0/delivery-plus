import { Injectable } from '@nestjs/common';
import { PaginatedResult } from '@food-delivery/shared';
import { DriversRepository } from '../repositories/drivers.repository';
import { Driver } from '../entities/driver.entity';
import { cairoDate } from '../common/licence-dates';
import { StaffDriverSummary, StaffLookupsClient } from '../common/staff-lookups.client';
import { DriverApplicationService, StaffDriverApplicationView } from './driver-application.service';
import { AdminDriverQueueQueryDto, AdminListDriversQueryDto } from '../dto/admin-drivers.dto';

/** One row of the staff driver list (#214). `fullName` is null when user-service doesn't answer. */
export interface StaffDriverRow {
  id: string;
  userId: string;
  fullName: string | null;
  vehicleType: string;
  licensePlate: string;
  status: Driver['status'];
  verificationStatus: Driver['verificationStatus'];
  submittedAt: Date | null;
  verifiedAt: Date | null;
  drivingLicenceExpiresOn: string | null;
  vehicleLicenceExpiresOn: string | null;
  createdAt: Date;
}

/**
 * The staff driver page (#214): the application with its review history and current documents
 * (read a document through POST /drivers/:id/documents/:type/read-url, which is recorded), plus the
 * ledger balance and rating from delivery-service. `summary` is null when delivery-service doesn't answer.
 */
export interface StaffDriverDetail {
  driver: StaffDriverRow;
  application: StaffDriverApplicationView;
  summary: StaffDriverSummary | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AdminDriversService {
  constructor(
    private readonly drivers: DriversRepository,
    private readonly applications: DriverApplicationService,
    private readonly lookups: StaffLookupsClient,
  ) {}

  async list(query: AdminListDriversQueryDto, now = new Date()): Promise<PaginatedResult<StaffDriverRow>> {
    const [rows, total] = await this.drivers.findForAdmin(
      {
        status: query.status,
        verificationStatus: query.verificationStatus,
        platePrefix: query.q,
        licenceExpiringBy:
          query.licenceExpiringWithinDays === undefined ? undefined : cairoDate(new Date(now.getTime() + query.licenceExpiringWithinDays * DAY_MS)),
      },
      query.page,
      query.limit,
    );
    return this.page(rows, total, query.page, query.limit);
  }

  async queue(query: AdminDriverQueueQueryDto): Promise<PaginatedResult<StaffDriverRow>> {
    const [rows, total] = await this.drivers.findForAdmin({ queue: true }, query.page, query.limit);
    return this.page(rows, total, query.page, query.limit);
  }

  async detail(driverId: string, now = new Date()): Promise<StaffDriverDetail> {
    const application = await this.applications.getApplicationForStaff(driverId, now); // 404s an unknown driver
    const driver = (await this.drivers.findById(driverId)) as Driver;
    const [names, summary] = await Promise.all([this.lookups.names([driver.userId]), this.lookups.driverSummary(driverId)]);
    return { driver: toRow(driver, names), application, summary };
  }

  private async page(rows: Driver[], total: number, page: number, limit: number): Promise<PaginatedResult<StaffDriverRow>> {
    const names = await this.lookups.names(rows.map((row) => row.userId));
    return { items: rows.map((row) => toRow(row, names)), page, limit, total, totalPages: Math.ceil(total / limit) || 1 };
  }
}

const toRow = (driver: Driver, names: Map<string, string> | null): StaffDriverRow => ({
  id: driver.id,
  userId: driver.userId,
  fullName: names?.get(driver.userId) ?? null,
  vehicleType: driver.vehicleType,
  licensePlate: driver.licensePlate,
  status: driver.status,
  verificationStatus: driver.verificationStatus,
  submittedAt: driver.submittedAt,
  verifiedAt: driver.verifiedAt,
  drivingLicenceExpiresOn: driver.drivingLicenceExpiresOn,
  vehicleLicenceExpiresOn: driver.vehicleLicenceExpiresOn,
  createdAt: driver.createdAt,
});
