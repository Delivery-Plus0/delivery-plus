import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AccountStatus, Credential } from '../entities/credential.entity';

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

  async update(id: string, data: Partial<Credential>): Promise<Credential | null> {
    await this.repo.update({ id }, data);
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

  async deleteById(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}
