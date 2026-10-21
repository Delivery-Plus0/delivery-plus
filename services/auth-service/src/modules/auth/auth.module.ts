import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Credential } from '../../entities/credential.entity';
import { AuthSession } from '../../entities/auth-session.entity';
import { StaffPermission } from '../../entities/staff-permission.entity';
import { StaffPermissionsRepository } from '../../repositories/staff-permissions.repository';
import { TestAdminService } from '../../bootstrap/test-admin.service';
import { SessionsRepository } from '../../repositories/sessions.repository';
import { SessionsService } from '../../services/sessions.service';
import { SessionCleanupService } from '../../services/session-cleanup.service';
import { InternalSessionsController } from '../../controllers/internal-sessions.controller';
import { InternalAuthGuard } from '../../guards/internal-auth.guard';
import { CredentialsRepository } from '../../repositories/credentials.repository';
import { UserServiceClient } from '../../common/user-service.client';
import { AuthService } from '../../services/auth.service';
import { AuthController } from '../../controllers/auth.controller';
import { APP_CONFIG, AppConfig } from '../../config/app-config';

@Module({
  imports: [
    TypeOrmModule.forFeature([Credential, AuthSession, StaffPermission]),
    JwtModule.registerAsync({
      useFactory: (config: AppConfig) => ({
        secret: config.jwtSecret,
        signOptions: { expiresIn: config.jwtExpiresIn },
      }),
      inject: [APP_CONFIG],
    }),
  ],
  controllers: [AuthController, InternalSessionsController],
  providers: [
    AuthService,
    CredentialsRepository,
    UserServiceClient,
    SessionsRepository,
    SessionsService,
    SessionCleanupService,
    StaffPermissionsRepository,
    TestAdminService,
    InternalAuthGuard,
  ],
})
export class AuthModule {}
