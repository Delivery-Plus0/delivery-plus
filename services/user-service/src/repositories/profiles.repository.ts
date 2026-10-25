import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
}
