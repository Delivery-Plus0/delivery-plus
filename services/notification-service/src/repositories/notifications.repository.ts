import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from '../entities/notification.entity';

@Injectable()
export class NotificationsRepository {
  constructor(
    @InjectRepository(Notification)
    private readonly repo: Repository<Notification>,
  ) {}

  async create(userId: string, type: NotificationType, title: string, message: string): Promise<Notification> {
    const notification = this.repo.create({ userId, type, title, message });
    return this.repo.save(notification);
  }

  async findByUserId(userId: string, limit = 50, offset = 0): Promise<[Notification[], number]> {
    return this.repo.findAndCount({
      where: { userId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }

  /** Marks the notification read only if it belongs to `userId`; returns whether it did. */
  async markAsReadForUser(id: string, userId: string): Promise<boolean> {
    const result = await this.repo.update({ id, userId }, { isRead: true });
    return (result.affected ?? 0) > 0;
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.repo.update({ userId, isRead: false }, { isRead: true });
  }
}
