import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { ReviewRestaurantApplicationDto } from './restaurant-application.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Every staff mutation carries a reason for the audit log (ADR 002). Never shown to the owner. */
export class AdminRestaurantReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Why, for the audit log. Not shown to the owner.' })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

/** `POST /admin/restaurants/:id/review` (#215): the #208 review, plus the audit reason. */
export class AdminReviewRestaurantDto extends ReviewRestaurantApplicationDto {
  @ApiProperty({ minLength: 3, maxLength: 500, description: 'Why, for the audit log. The `note` is what the owner reads.' })
  @IsString()
  @Transform(trim)
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
