import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, MoreThan, Repository } from 'typeorm';
import { PhoneVerification } from '../entities/phone-verification.entity';

export type NewPhoneVerification = Pick<PhoneVerification, 'id' | 'userId' | 'phone' | 'codeHash' | 'expiresAt'>;

/** What the send limits look at, read under the user's lock. */
export type SendHistory = { latestSentAt: Date | null; sentByUser: number; sentToPhone: number };

@Injectable()
export class PhoneVerificationsRepository {
  constructor(
    @InjectRepository(PhoneVerification)
    private readonly repo: Repository<PhoneVerification>,
  ) {}

  /**
   * Runs `decide` and the insert it returns under a per-user advisory lock, so two requests at once
   * can't both pass the cooldown and send two codes. `decide` gets the send history and returns the
   * row to insert, or throws to refuse.
   */
  async createUnderLimits(
    userId: string,
    phone: string,
    since: Date,
    decide: (history: SendHistory) => NewPhoneVerification,
  ): Promise<PhoneVerification> {
    return this.repo.manager.transaction(async (manager: EntityManager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`phone-verification:${userId}`]);
      const repo = manager.getRepository(PhoneVerification);
      const [latest, sentByUser, sentToPhone] = await Promise.all([
        repo.findOne({ where: { userId }, order: { createdAt: 'DESC' } }),
        repo.count({ where: { userId, createdAt: MoreThan(since) } }),
        repo.count({ where: { phone, createdAt: MoreThan(since) } }),
      ]);
      const row = decide({ latestSentAt: latest?.createdAt ?? null, sentByUser, sentToPhone });
      return repo.save(repo.create(row));
    });
  }

  /** The user's most recent code, with its hash; only this one can be verified. */
  latestForUser(userId: string): Promise<PhoneVerification | null> {
    return this.repo
      .createQueryBuilder('v')
      .addSelect('v.codeHash')
      .where('v.userId = :userId', { userId })
      .orderBy('v.createdAt', 'DESC')
      .getOne();
  }

  /**
   * Counts one attempt, atomically and only while attempts remain and the code is unused. Returns the
   * new attempt count, or null when no attempt was left.
   */
  async registerAttempt(id: string, maxAttempts: number): Promise<number | null> {
    const result: unknown = await this.repo.query(
      `UPDATE "phone_verifications" SET "attempts" = "attempts" + 1
       WHERE "id" = $1 AND "attempts" < $2 AND "consumedAt" IS NULL
       RETURNING "attempts"`,
      [id, maxAttempts],
    );
    return updatedRows<{ attempts: number }>(result)[0]?.attempts ?? null;
  }

  /**
   * Uses the code and marks the phone verified on the profile, together. False when the code was
   * already used (a concurrent request won).
   */
  async consumeAndVerify(id: string, userId: string, phone: string): Promise<boolean> {
    return this.repo.manager.transaction(async (manager: EntityManager) => {
      const used = updatedRows(await manager.query(
        `UPDATE "phone_verifications" SET "consumedAt" = now() WHERE "id" = $1 AND "consumedAt" IS NULL RETURNING "id"`,
        [id],
      ));
      if (!used.length) return false;
      await manager.query(
        `UPDATE "user_profiles" SET "phone" = $1, "phoneVerifiedAt" = now(), "updatedAt" = now() WHERE "id" = $2`,
        [phone, userId],
      );
      return true;
    });
  }

  /** Drops a row whose message could not be sent, so it neither counts nor blocks a retry. */
  async delete(id: string): Promise<void> {
    await this.repo.delete({ id });
  }
}

/** pg returns [rows, affected] for UPDATE … RETURNING through TypeORM's query(). */
function updatedRows<T>(result: unknown): T[] {
  return Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as T[]) : [];
}
