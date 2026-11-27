import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { EgyptianMobile, STAFF_PERMISSIONS, StaffPermission } from '@food-delivery/shared';
import { STAFF_MIN_PASSWORD_LENGTH } from '../services/staff.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class StaffPermissionsBody {
  @ApiProperty({ enum: STAFF_PERMISSIONS, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(STAFF_PERMISSIONS.length)
  @IsIn(STAFF_PERMISSIONS, { each: true })
  permissions!: StaffPermission[];
}

/** `POST /admin/auth/staff/invitations` (#216). */
export class InviteStaffDto extends StaffPermissionsBody {
  @ApiProperty({ example: 'ops.lead@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Why this person gets these permissions, for the audit log.' })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** `PATCH /admin/auth/staff/:id/permissions` (#216). */
export class SetStaffPermissionsDto extends StaffPermissionsBody {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class StaffReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 300 })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(300)
  reason!: string;
}

/** `POST /auth/staff/accept-invitation` (#216): public, the token is the proof. */
export class AcceptStaffInvitationDto {
  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(100)
  token!: string;

  @ApiProperty({ minLength: STAFF_MIN_PASSWORD_LENGTH, maxLength: 128 })
  @IsString()
  @MinLength(STAFF_MIN_PASSWORD_LENGTH)
  @MaxLength(128)
  password!: string;

  @ApiProperty({ example: 'Mona Ali' })
  @IsString()
  @Transform(trim)
  @MinLength(2)
  @MaxLength(100)
  fullName!: string;

  @ApiPropertyOptional({ example: '01012345678' })
  @EgyptianMobile()
  phone!: string;
}
