import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { EGYPTIAN_MOBILE_MESSAGE, EgyptianMobile } from '@food-delivery/shared';

/** Trims a string; a blank one becomes null (clears an optional field). */
const trimOrNull = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const REGISTRATION_NUMBER = /^[0-9A-Za-z][0-9A-Za-z/ -]{0,49}$/;

/**
 * #208: the application fields an owner can send with create or update. Only the legal name is required
 * to submit (owner decision), together with the contact phone and the location.
 */
export class RestaurantApplicationFieldsDto {
  @ApiPropertyOptional({ description: 'Legal (registered) name. Required to submit. Never public.', maxLength: 200, example: 'Sunset Grill LLC' })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName?: string | null;

  @ApiPropertyOptional({ description: 'Commercial registration number. Optional. Never public.', maxLength: 50 })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @Matches(REGISTRATION_NUMBER, { message: 'commercialRegistrationNumber may contain only letters, digits, spaces, "-" and "/"' })
  commercialRegistrationNumber?: string | null;

  @ApiPropertyOptional({ description: 'Tax card number. Optional. Never public.', maxLength: 50 })
  @IsOptional()
  @Transform(trimOrNull)
  @IsString()
  @Matches(REGISTRATION_NUMBER, { message: 'taxCardNumber may contain only letters, digits, spaces, "-" and "/"' })
  taxCardNumber?: string | null;

  @ApiPropertyOptional({
    description: 'Egyptian mobile the restaurant answers, stored as E.164 (+201XXXXXXXXX). Required to submit. Never public.',
    example: '01012345678',
  })
  @IsOptional()
  @EgyptianMobile({ message: EGYPTIAN_MOBILE_MESSAGE })
  contactPhone?: string | null;

  @ApiPropertyOptional({ type: [String], maxItems: 5, description: 'Up to 5 cuisine labels shown to customers.', example: ['Burgers', 'Fries'] })
  @IsOptional()
  @Transform(({ value }) =>
    Array.isArray(value)
      ? [...new Set(value.map((tag) => (typeof tag === 'string' ? tag.trim() : tag)).filter((tag) => tag !== ''))]
      : value,
  )
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MinLength(2, { each: true })
  @MaxLength(30, { each: true })
  cuisineTags?: string[];
}

export const RESTAURANT_REVIEW_DECISIONS = ['APPROVED', 'REJECTED'] as const;

/** POST /restaurants/:id/review (#208, staff with onboarding.review). */
export class ReviewRestaurantApplicationDto {
  @ApiProperty({ enum: RESTAURANT_REVIEW_DECISIONS })
  @IsIn(RESTAURANT_REVIEW_DECISIONS)
  decision!: (typeof RESTAURANT_REVIEW_DECISIONS)[number];

  @ApiPropertyOptional({ minLength: 3, maxLength: 300, description: 'Shown to the owner. Required to reject: say what to fix.' })
  @ValidateIf((dto: ReviewRestaurantApplicationDto) => dto.decision === 'REJECTED' || dto.note !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  note?: string;

  @ApiProperty({
    description: "The application's submittedAt as the reviewer saw it. If the owner resubmitted since, the review is refused (409).",
    example: '2026-11-08T10:15:00.000Z',
  })
  @IsISO8601({ strict: true })
  submittedAt!: string;
}
