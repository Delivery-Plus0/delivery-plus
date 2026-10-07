import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const RATING_COMMENT_MAX = 500;

/** POST /deliveries/:id/rating body. Who rates and which driver come from the token and the delivery. */
export class CreateRatingDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  score!: number;

  @ApiPropertyOptional({ maxLength: RATING_COMMENT_MAX, description: 'Trimmed; blank is stored as no comment.' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @MaxLength(RATING_COMMENT_MAX)
  comment?: string;
}

export class RatingDto {
  @ApiProperty() score!: number;
  @ApiProperty({ nullable: true, type: String }) comment!: string | null;
  @ApiProperty() createdAt!: Date;
}

/** GET /deliveries/:id/rating for the order's customer: the rating, or whether they can still rate. */
export class DeliveryRatingStatusDto {
  @ApiProperty({ nullable: true, type: RatingDto }) rating!: RatingDto | null;
  @ApiProperty() canRate!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Why rating is not possible (null when canRate).' })
  reason!: string | null;
  @ApiProperty({ nullable: true, type: Date, description: 'Last moment a rating is accepted (14 days after delivery).' })
  closesAt!: Date | null;
}

/** GET /deliveries/me/rating-summary: the calling driver's rating, without any customer identity. */
export class DriverRatingSummaryDto {
  @ApiProperty({ nullable: true, type: Number, description: 'One decimal; null until the first rating.' })
  average!: number | null;
  @ApiProperty() count!: number;
  @ApiProperty({ type: [RatingDto] }) recentComments!: RatingDto[];
}
