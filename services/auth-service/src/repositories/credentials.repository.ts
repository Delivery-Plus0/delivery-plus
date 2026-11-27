import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager } from 'typeorm';
import { UserRole } from '@food-delivery/shared';
import { AccountStatus, Credential } from '../entities/credential.entity';

export interface AccountQuery {
  ids?: string[];
  roles?: UserRole[];
  status?: AccountStatus;
  emailVerified?: boolean;
  createdFrom?: Date;
  createdTo?: Date;
  page: number;
  limit: number;
}

/** The account fields staff may see: never hashes, codes, tokens or lockout counters. */
export interface AccountSummary {
  id: string;
  email: string;
  role: UserRole;
  status: AccountStatus;
  emailVerified: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export const toAccountSummary = (c: Credential): AccountSummary => ({
  id: c.id,
  email: c.email,
  role: c.role,
  status: c.status,
  emailVerified: c.emailVerified,
  suspendedAt: c.suspendedAt ?? null,
  suspendedReason: c.suspendedReason ?? null,
  lastLoginAt: c.lastLoginAt ?? null,
  createdAt: c.createdAt,
});

@Injectable()
export class CredentialsRepository {
  constructor(
    @InjectRepository(Credential)
    private readonly repo: Repository<Credential>,
  ) {}

  findByEmail(email: string): Promise<Credential | null> {
    return this.repo.findOne({ where: { email } });
  }

  findById(id: string): Promise<Credential | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(
    data: Pick<
      Credential,
      | 'email'
      | 'passwordHash'
      | 'role'
      | 'emailVerified'
      | 'failedLoginCount'
      | 'lockedUntil'
      | 'lastFailedLoginAt'
      | 'verificationTokenHash'
      | 'verificationTokenExpiresAt'
    >,
  ): Promise<Credential> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }
  /** Runs `work` in one transaction, so a password change and the session revoke land together or not at all. */
  transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.repo.manager.transaction(work);
  }

  async update(id: string, data: Partial<Credential>, manager?: EntityManager): Promise<Credential | null> {
    const repo = manager ? manager.getRepository(Credential) : this.repo;
    await repo.update({ id }, data);
    return this.findById(id);
  }

  async recordFailedLogin(id: string, failedAt: Date): Promise<Credential | null> {
    await this.repo.query(
      `
        UPDATE credentials
        SET "failedLoginCount" = CASE
          WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= $1 THEN 1
          ELSE "failedLoginCount" + 1
        END,
            "lastFailedLoginAt" = $1,
            "lockedUntil" = CASE
              WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= $1 THEN NULL
              ELSE "lockedUntil"
            END
        WHERE id = $2
      `,
      [failedAt, id],
    );

    return this.findById(id);
  }

  async resetFailureState(id: string): Promise<void> {
    await this.repo.update(
      { id },
      {
        failedLoginCount: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
      },
    );
  }

  /** #214: a successful password sign-in. */
  async recordLogin(id: string, at = new Date()): Promise<void> {
    await this.repo.update({ id }, { lastLoginAt: at });
  }

  /**
   * #214: the staff people directory's account side, for user-service (SYSTEM). Explicit filters
   * only; `ids` narrows to a set user-service already matched on profile fields.
   */
  async queryAccounts(filter: AccountQuery): Promise<[AccountSummary[], number]> {
    const qb = this.repo
      .createQueryBuilder('c')
      .select(['c.id', 'c.email', 'c.role', 'c.status', 'c.emailVerified', 'c.suspendedAt', 'c.suspendedReason', 'c.lastLoginAt', 'c.createdAt']);
    if (filter.ids) qb.andWhere('c.id IN (:...ids)', { ids: filter.ids.length ? filter.ids : ['00000000-0000-0000-0000-000000000000'] });
    if (filter.roles?.length) qb.andWhere('c.role IN (:...roles)', { roles: filter.roles });
    if (filter.status) qb.andWhere('c.status = :status', { status: filter.status });
    if (filter.emailVerified !== undefined) qb.andWhere('c.emailVerified = :emailVerified', { emailVerified: filter.emailVerified });
    if (filter.createdFrom) qb.andWhere('c.createdAt >= :createdFrom', { createdFrom: filter.createdFrom });
    if (filter.createdTo) qb.andWhere('c.createdAt < :createdTo', { createdTo: filter.createdTo });
    qb.orderBy('c.createdAt', 'DESC').addOrderBy('c.id', 'DESC').skip((filter.page - 1) * filter.limit).take(filter.limit);
    const [rows, total] = await qb.getManyAndCount();
    return [rows.map(toAccountSummary), total];
  }

  /** #203: a new code replaces any earlier one and resets the attempt counter. */
  async setVerificationCode(id: string, codeHash: string, expiresAt: Date, sentAt: Date): Promise<void> {
    await this.repo.update(
      { id },
      { verificationTokenHash: codeHash, verificationTokenExpiresAt: expiresAt, verificationAttempts: 0, verificationSentAt: sentAt },
    );
  }

  /**
   * #203: marks the email verified only if `codeHash` is still the live code (compare-and-set), so a
   * code works once even if two requests race. Returns whether this call verified it.
   */
  async consumeVerificationCode(id: string, codeHash: string, now: Date): Promise<boolean> {
    const result = await this.repo
      .createQueryBuilder()
      .update(Credential)
      .set({ emailVerified: true, verificationTokenHash: null, verificationTokenExpiresAt: null, verificationAttempts: 0 })
      .where('id = :id AND "verificationTokenHash" = :codeHash AND "verificationTokenExpiresAt" > :now', { id, codeHash, now })
      .execute();
    return Boolean(result.affected);
  }

  /**
   * #203: counts a wrong code in one atomic UPDATE; the attempt that reaches `maxAttempts` also clears
   * the code, so it can never be tried again.
   */
  async recordWrongVerificationCode(id: string, maxAttempts: number): Promise<void> {
    await this.repo.query(
      `UPDATE "credentials"
       SET "verificationAttempts" = "verificationAttempts" + 1,
           "verificationTokenHash" = CASE WHEN "verificationAttempts" + 1 >= $2 THEN NULL ELSE "verificationTokenHash" END,
           "verificationTokenExpiresAt" = CASE WHEN "verificationAttempts" + 1 >= $2 THEN NULL ELSE "verificationTokenExpiresAt" END
       WHERE id = $1 AND "verificationTokenHash" IS NOT NULL`,
      [id, maxAttempts],
    );
  }

  /** #202: suspend (with when and why) or reactivate an account. Returns the updated credential. */
  async setStatus(id: string, status: AccountStatus, reason: string | null, now = new Date()): Promise<Credential | null> {
    await this.repo.update(
      { id },
      status === 'SUSPENDED' ? { status, suspendedAt: now, suspendedReason: reason } : { status, suspendedAt: null, suspendedReason: null },
    );
    return this.findById(id);
  }

  /**
   * #215: compare-and-set of the account status in the caller's transaction. False when the account
   * already had that status (the staff action is then a no-op).
   */
  async setStatusIfChanged(manager: EntityManager, id: string, status: AccountStatus, reason: string | null, now = new Date()): Promise<boolean> {
    const from: AccountStatus = status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED';
    const result = await manager.update(
      Credential,
      { id, status: from },
      status === 'SUSPENDED' ? { status, suspendedAt: now, suspendedReason: reason } : { status, suspendedAt: null, suspendedReason: null },
    );
    return (result.affected ?? 0) > 0;
  }

  async deleteById(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}
