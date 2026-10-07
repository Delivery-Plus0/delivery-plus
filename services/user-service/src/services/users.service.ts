import { Injectable } from '@nestjs/common';
import {
  ConflictError,
  ForbiddenError,
  JwtPayload,
  NotFoundError,
  UnauthorizedError,
  UserRole,
  S3StorageService,
} from '@food-delivery/shared';
import { ProfilesRepository } from '../repositories/profiles.repository';
import { OrderServiceClient } from '../common/order-service.client';
import { CreateProfileDto } from '../dto/create-profile.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { UserProfile } from '../entities/user-profile.entity';

@Injectable()
export class UsersService {
  private readonly avatarMaxSizeBytes = 5 * 1024 * 1024;

  constructor(
    private readonly profiles: ProfilesRepository,
    private readonly orderServiceClient: OrderServiceClient,
    private readonly storage: S3StorageService,
  ) {}

  async createProfile(dto: CreateProfileDto, createdByService: string): Promise<UserProfile> {
    if (!createdByService) {
      throw new UnauthorizedError('Missing trusted service identity');
    }

    if (dto.authCredentialId !== dto.userId) {
      throw new ConflictError('Auth credential id does not match profile user id');
    }

    const existing = await this.profiles.findById(dto.userId);
    if (existing) {
      throw new ConflictError(`Profile for user ${dto.userId} already exists`);
    }

    return this.profiles.create({
      id: dto.userId,
      authCredentialId: dto.authCredentialId,
      createdByService,
      email: dto.email,
      fullName: dto.fullName,
      phone: dto.phone,
    });
  }

  async getOwnProfile(requester: JwtPayload): Promise<UserProfile> {
    const profile = await this.loadProfile(requester.sub);
    this.assertCanAccessOwnProfile(profile, requester);
    this.assertStoredMapping(profile);
    this.assertIdentityConsistency(profile, requester);
    return profile;
  }

  async getProfileById(id: string, requester: JwtPayload): Promise<UserProfile> {
    const profile = await this.loadProfile(id);
    this.assertCanReadProfile(profile, requester);
    this.assertStoredMapping(profile);
    if (requester.sub === profile.id) {
      this.assertIdentityConsistency(profile, requester);
    }
    return profile;
  }

  async updateOwnProfile(requester: JwtPayload, dto: UpdateProfileDto): Promise<UserProfile> {
    await this.getOwnProfile(requester);
    const updated = await this.profiles.update(requester.sub, dto);
    return updated as UserProfile;
  }

  async createAvatarUploadUrl(requester: JwtPayload, contentType: string) {
    const profile = await this.getOwnProfile(requester);
    return this.storage.generateUploadUrl(
      `users/${profile.id}/avatar/`,
      contentType,
      this.avatarMaxSizeBytes,
    );
  }

  async confirmAvatarUpload(requester: JwtPayload, objectKey: string): Promise<UserProfile> {
    const profile = await this.getOwnProfile(requester);
    const verifiedUpload = await this.storage.verifyUploadedObject(
      objectKey,
      `users/${profile.id}/avatar/`,
      this.avatarMaxSizeBytes,
    );
    const updated = await this.profiles.update(profile.id, { avatarUrl: verifiedUpload.publicUrl });
    return updated as UserProfile;
  }

  /** Removes the caller's photo (#150): the profile falls back to initials. Repeating it is a no-op. */
  async removeAvatar(requester: JwtPayload): Promise<UserProfile> {
    const profile = await this.getOwnProfile(requester);
    if (!profile.avatarUrl) return profile;
    const updated = await this.profiles.update(profile.id, { avatarUrl: null as unknown as string });
    return updated as UserProfile;
  }

  async getOrderHistory(requester: JwtPayload, authHeader: string, page: number, limit: number): Promise<unknown> {
    if (!authHeader) {
      throw new UnauthorizedError('Missing authorization header');
    }
    await this.getOwnProfile(requester);
    return this.orderServiceClient.getOrderHistory(authHeader, page, limit);
  }

  private async loadProfile(userId: string): Promise<UserProfile> {
    const profile = await this.profiles.findById(userId);
    if (!profile) {
      throw new NotFoundError(`User ${userId} not found`);
    }
    return profile;
  }

  private assertCanReadProfile(profile: UserProfile, requester: JwtPayload): void {
    if (requester.role === UserRole.ADMIN || requester.sub === profile.id) {
      return;
    }
    throw new ForbiddenError('You do not have access to this profile');
  }

  private assertCanAccessOwnProfile(profile: UserProfile, requester: JwtPayload): void {
    if (requester.sub !== profile.id) {
      throw new ForbiddenError('You do not have access to this profile');
    }
  }

  private assertStoredMapping(profile: UserProfile): void {
    if (profile.authCredentialId !== profile.id) {
      throw new ConflictError('Stored auth credential mapping does not match profile id');
    }
  }

  private assertIdentityConsistency(profile: UserProfile, requester: JwtPayload): void {
    if (requester.sub !== profile.authCredentialId) {
      throw new ConflictError('Auth identity does not match the profile credential mapping');
    }
    if (requester.email !== profile.email) {
      throw new ConflictError('Auth identity does not match the stored profile');
    }
  }
}
