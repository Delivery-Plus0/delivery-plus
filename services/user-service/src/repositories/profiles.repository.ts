import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserProfile } from '../entities/user-profile.entity';

@Injectable()
export class ProfilesRepository {
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
}
