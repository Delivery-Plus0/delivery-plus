import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StaffPermission as Permission } from '@food-delivery/shared';
import { StaffPermission } from '../entities/staff-permission.entity';

@Injectable()
export class StaffPermissionsRepository {
  constructor(
    @InjectRepository(StaffPermission)
    private readonly repo: Repository<StaffPermission>,
  ) {}

  /** The permissions a staff member holds, sorted, for the access token's `perms` claim. */
  async listFor(credentialId: string): Promise<Permission[]> {
    const rows = await this.repo.find({ where: { credentialId }, order: { permission: 'ASC' } });
    return rows.map((row) => row.permission);
  }
}
