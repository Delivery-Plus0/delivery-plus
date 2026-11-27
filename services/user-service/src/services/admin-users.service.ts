import { Injectable } from '@nestjs/common';
import { BadRequestError, NotFoundError, PaginatedResult, UserRole } from '@food-delivery/shared';
import { ProfilesRepository } from '../repositories/profiles.repository';
import { UserProfile } from '../entities/user-profile.entity';
import { AccountQuery, AccountSummary, AuthServiceClient } from '../common/auth-service.client';
import { AdminListUsersQueryDto, AdminSearchUsersDto } from '../dto/admin-users.dto';

/** Profile matches a combined (account + profile) filter may narrow to before staff must refine it. */
export const DIRECTORY_MATCH_CAP = 1000;

/**
 * The staff view of a person (#214): profile and account. It may carry phone and email (staff with
 * support.read; the admin app masks them by default) but never hashes, codes or tokens.
 */
export interface StaffUserView {
  id: string;
  fullName: string | null;
  email: string;
  phone: string | null;
  phoneVerified: boolean;
  avatarUrl: string | null;
  role: UserRole | null;
  status: 'ACTIVE' | 'SUSPENDED' | null;
  emailVerified: boolean | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface StaffUserDetail extends StaffUserView {
  address: string | null;
  /** Status changes are in the audit log: GET /api/admin/audit?targetType=USER&targetId=<id>. */
  auditTrail: { targetType: 'USER'; targetId: string };
}

export class DirectoryFilterTooBroadError extends BadRequestError {
  constructor() {
    super(`More than ${DIRECTORY_MATCH_CAP} people match the name and phone filters; narrow them down`);
  }
}

const toView = (profile: UserProfile | undefined, account: AccountSummary | undefined): StaffUserView => {
  const id = (profile?.id ?? account?.id) as string;
  return {
    id,
    fullName: profile?.fullName ?? null,
    email: account?.email ?? profile?.email ?? '',
    phone: profile?.phone ?? null,
    phoneVerified: Boolean(profile?.phoneVerifiedAt),
    avatarUrl: profile?.avatarUrl ?? null,
    role: account?.role ?? null,
    status: account?.status ?? null,
    emailVerified: account?.emailVerified ?? null,
    suspendedAt: account?.suspendedAt ?? null,
    suspendedReason: account?.suspendedReason ?? null,
    lastLoginAt: account?.lastLoginAt ?? null,
    createdAt: new Date((account?.createdAt ?? profile?.createdAt) as string | Date).toISOString(),
  };
};

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly accounts: AuthServiceClient,
  ) {}

  /**
   * One paginated list across two services without reading auth-service's database (ADR 002):
   * - account filters only: auth-service pages, user-service adds the profiles;
   * - profile filters only (or none): user-service pages, auth-service adds the accounts;
   * - both: the profile filters give an id set (at most DIRECTORY_MATCH_CAP), auth-service pages within it.
   */
  async list(query: AdminListUsersQueryDto, correlationId?: string): Promise<PaginatedResult<StaffUserView>> {
    const profileFilter = { namePrefix: query.q, phoneVerified: query.phoneVerified };
    const hasProfileFilter = query.q !== undefined || query.phoneVerified !== undefined;
    const accountFilter: Omit<AccountQuery, 'page' | 'limit'> = {
      roles: query.role ? [query.role as UserRole] : undefined,
      status: query.status,
      emailVerified: query.emailVerified,
      createdFrom: query.createdFrom,
      createdTo: query.createdTo,
    };
    const hasAccountFilter = Object.values(accountFilter).some((value) => value !== undefined);

    if (!hasAccountFilter) {
      const [profiles, total] = await this.profiles.pageForAdmin(profileFilter, query.page, query.limit);
      const accounts = await this.accountsFor(profiles.map((p) => p.id), correlationId);
      return this.page(profiles.map((p) => toView(p, accounts.get(p.id))), query, total);
    }

    let ids: string[] | undefined;
    if (hasProfileFilter) {
      ids = await this.profiles.idsForAdmin(profileFilter, DIRECTORY_MATCH_CAP);
      if (ids.length > DIRECTORY_MATCH_CAP) throw new DirectoryFilterTooBroadError();
      if (ids.length === 0) return this.page([], query, 0);
    }
    const { items, total } = await this.accounts.queryAccounts({ ...accountFilter, ids, page: query.page, limit: query.limit }, correlationId);
    const profiles = new Map((await this.profiles.findByIds(items.map((a) => a.id))).map((p) => [p.id, p]));
    return this.page(items.map((a) => toView(profiles.get(a.id), a)), query, total);
  }

  /** Exact phone or email (#217 decision). Exactly one of them. */
  async search(dto: AdminSearchUsersDto, correlationId?: string): Promise<{ items: StaffUserView[] }> {
    if (Boolean(dto.email) === Boolean(dto.phone)) throw new BadRequestError('Search by exactly one of phone or email');
    const profiles = await this.profiles.findForAdminSearch(dto);
    const accounts = await this.accountsFor(profiles.map((p) => p.id), correlationId);
    return { items: profiles.map((p) => toView(p, accounts.get(p.id))) };
  }

  async detail(id: string, correlationId?: string): Promise<StaffUserDetail> {
    const profile = await this.profiles.findById(id);
    const accounts = await this.accountsFor([id], correlationId);
    const account = accounts.get(id);
    if (!profile && !account) throw new NotFoundError('User not found');
    return { ...toView(profile ?? undefined, account), address: profile?.address ?? null, auditTrail: { targetType: 'USER', targetId: id } };
  }

  private async accountsFor(ids: string[], correlationId?: string): Promise<Map<string, AccountSummary>> {
    if (ids.length === 0) return new Map();
    const { items } = await this.accounts.queryAccounts({ ids, page: 1, limit: ids.length }, correlationId);
    return new Map(items.map((account) => [account.id, account]));
  }

  private page(items: StaffUserView[], query: AdminListUsersQueryDto, total: number): PaginatedResult<StaffUserView> {
    return { items, page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) || 1 };
  }
}
