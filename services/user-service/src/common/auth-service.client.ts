import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppError, UserRole } from '@food-delivery/shared';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { SystemTokenService } from './system-token.service';

const AUTH_SERVICE_TIMEOUT_MS = 5000;

/** The account fields auth-service shares with the staff directory (#214). */
export interface AccountSummary {
  id: string;
  email: string;
  role: UserRole;
  status: 'ACTIVE' | 'SUSPENDED';
  emailVerified: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface AccountQuery {
  ids?: string[];
  roles?: UserRole[];
  status?: 'ACTIVE' | 'SUSPENDED';
  emailVerified?: boolean;
  createdFrom?: string;
  createdTo?: string;
  page: number;
  limit: number;
}

export class AccountDirectoryUnavailableError extends AppError {
  constructor() {
    super(503, 'AccountDirectoryUnavailable', 'The account directory is not available right now. Please try again.');
  }
}

/** POST /internal/auth/accounts/query with a SYSTEM token (#202, #214). */
@Injectable()
export class AuthServiceClient {
  private readonly logger = new Logger(AuthServiceClient.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly systemToken: SystemTokenService,
  ) {}

  async queryAccounts(query: AccountQuery, correlationId?: string): Promise<{ items: AccountSummary[]; total: number }> {
    let response: Response;
    try {
      response = await fetch(`${this.config.authServiceUrl}/internal/auth/accounts/query`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await this.systemToken.mint(),
          ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
        },
        body: JSON.stringify(query),
        signal: AbortSignal.timeout(AUTH_SERVICE_TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn(`auth.accounts.query_failed: ${error instanceof Error ? error.name : 'error'}`);
      throw new AccountDirectoryUnavailableError();
    }
    if (!response.ok) {
      this.logger.warn(`auth.accounts.query_failed status=${response.status}`);
      throw new AccountDirectoryUnavailableError();
    }
    return (await response.json()) as { items: AccountSummary[]; total: number };
  }
}
