import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ReviewDriverApplicationDto } from './driver-application.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Every staff mutation carries a reason for the audit log (ADR 002). Never shown to the driver. */
export class AdminReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Why, for the audit log. Not shown to the driver.' })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** `POST /admin/drivers/:id/review` (#215): the #207 review, plus the audit reason. */
export class AdminReviewDriverDto extends ReviewDriverApplicationDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Why, for the audit log. The `note` is what the driver reads.' })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
