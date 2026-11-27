import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { UserProfile } from '../entities/user-profile.entity';

@Injectable()
export class ProfilesRepository {
  private readonly logger = new Logger(ProfilesRepository.name);
  constructor(
    @InjectRepository(UserProfile)
    private readonly repo: Repository<UserProfile>,
  ) {}

  findById(id: string): Promise<UserProfile | null> {
    return this.repo.findOne({ where: { id } });
  }

  async create(
    data: Pick<UserProfile, 'id' | 'authCredentialId' | 'createdByService' | 'email' | 'fullName' | 'phone'>,
  ): Promise<UserProfile> {
    const entity = this.repo.create(data);
    return this.repo.save(entity);
  }

  async update(
    id: string,
    data: Partial<Pick<UserProfile, 'fullName' | 'phone' | 'address' | 'avatarUrl' | 'phoneVerifiedAt'>>,
  ): Promise<UserProfile | null> {
    await this.repo.update({ id }, data);
    return this.findById(id);
  }

  /** The profile that owns this phone, only when the phone is verified . */
  async findByVerifiedPhone(phone: string): Promise<UserProfile | null> {
    const matches = await this.repo
      .createQueryBuilder('p')
      .where('p.phone = :phone', { phone })
      .andWhere('p.phoneVerifiedAt IS NOT NULL')
      .take(2)
      .getMany();
    if (matches.length > 1) {
      // Nothing makes a verified phone unique.
      this.logger.warn(`phone.verified_duplicate users=${matches.map((match) => match.id).join(',')}`);
      return null;
    }
    return matches[0] ?? null;
  }

  /** #214: profile-side filters of the staff directory. */
  private adminFilter(filter: ProfileFilter): SelectQueryBuilder<UserProfile> {
    const qb = this.repo.createQueryBuilder('p');
    if (filter.namePrefix) {
      // A prefix of the full name or of any later word, case-insensitive. LIKE wildcards in the input are literal.
      const escaped = filter.namePrefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      qb.andWhere(`(p.fullName ILIKE :start ESCAPE '\\' OR p.fullName ILIKE :word ESCAPE '\\')`, { start: `${escaped}%`, word: `% ${escaped}%` });
    }
    if (filter.phoneVerified === true) qb.andWhere('p.phoneVerifiedAt IS NOT NULL');
    if (filter.phoneVerified === false) qb.andWhere('p.phoneVerifiedAt IS NULL');
    return qb;
  }

  /** A page of profiles, newest first, when only profile filters apply. */
  pageForAdmin(filter: ProfileFilter, page: number, limit: number): Promise<[UserProfile[], number]> {
    return this.adminFilter(filter)
      .orderBy('p.createdAt', 'DESC')
      .addOrderBy('p.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
  }

  /** The ids matching the profile filters, at most `cap + 1` (so the caller can tell "too many"). */
  async idsForAdmin(filter: ProfileFilter, cap: number): Promise<string[]> {
    const rows = await this.adminFilter(filter).select('p.id', 'id').orderBy('p.createdAt', 'DESC').limit(cap + 1).getRawMany<{ id: string }>();
    return rows.map((row) => row.id);
  }

  findByIds(ids: string[]): Promise<UserProfile[]> {
    return ids.length ? this.repo.find({ where: { id: In(ids) } }) : Promise.resolve([]);
  }

  /** #214: exact match on a normalized email or E.164 phone, verified or not. */
  findForAdminSearch(match: { email?: string; phone?: string }): Promise<UserProfile[]> {
    const qb = this.repo.createQueryBuilder('p');
    if (match.email) qb.where('LOWER(p.email) = :email', { email: match.email });
    else if (match.phone) qb.where('p.phone = :phone', { phone: match.phone });
    else return Promise.resolve([]);
    return qb.orderBy('p.createdAt', 'DESC').take(20).getMany();
  }
}

export interface ProfileFilter {
  namePrefix?: string;
  phoneVerified?: boolean;
}
