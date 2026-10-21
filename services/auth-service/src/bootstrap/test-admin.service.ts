import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { BootstrapRefusedError, bootstrapAdmin } from './bootstrap-admin';

/**
 * Test and development stacks only (TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD, refused in production):
 * creates the stack's super admin at startup, through the same bootstrap as the CLI, so the seeds and
 * the E2E have an admin with every permission. Does nothing once any admin exists.
 */
@Injectable()
export class TestAdminService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TestAdminService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.testAdmin) return;
    try {
      const admin = await bootstrapAdmin(this.dataSource, this.config.testAdmin);
      this.logger.log(`Created the test super admin ${admin.email}`);
    } catch (error) {
      if (error instanceof BootstrapRefusedError && error.message.startsWith('Staff already exist')) return;
      this.logger.error(`Could not create the test super admin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
