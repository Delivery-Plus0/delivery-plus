import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import { PRIVATE_DOCUMENT_CONTENT_TYPES } from '@food-delivery/shared';

const DATE_ONLY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** PUT /drivers/me/application (#207): the application fields, while it is a draft. */
export class SaveDriverApplicationDto {
  @ApiProperty({
    description: 'The 14-digit Egyptian national ID. Only its last 4 digits and a keyed hash are stored.',
    example: '29001011234567',
    writeOnly: true,
  })
  @IsString()
  @Transform(trim)
  @Matches(/^[23]\d{13}$/, { message: 'nationalIdNumber must be a 14-digit Egyptian national ID' })
  nationalIdNumber!: string;

  @ApiProperty({ description: 'Driving licence expiry date, YYYY-MM-DD (Cairo).', example: '2028-05-31' })
  @IsString()
  @Matches(DATE_ONLY, { message: 'drivingLicenceExpiresOn must be a YYYY-MM-DD date' })
  drivingLicenceExpiresOn!: string;

  @ApiProperty({ description: 'Vehicle licence expiry date, YYYY-MM-DD (Cairo).', example: '2027-01-15' })
  @IsString()
  @Matches(DATE_ONLY, { message: 'vehicleLicenceExpiresOn must be a YYYY-MM-DD date' })
  vehicleLicenceExpiresOn!: string;
}

const CONTENT_TYPES = Object.keys(PRIVATE_DOCUMENT_CONTENT_TYPES);

/** POST /drivers/me/documents/:type/upload-url (#207). */
export class RequestDocumentUploadDto {
  @ApiProperty({ enum: CONTENT_TYPES, example: 'image/jpeg' })
  @IsIn(CONTENT_TYPES)
  contentType!: string;
}

/** POST /drivers/me/documents/:type/confirm (#207): the `objectKey` the upload URL returned. */
export class ConfirmDocumentUploadDto {
  @ApiProperty({ example: 'pending/drivers/0b6c…/selfie/7d1e….jpg' })
  @IsString()
  @MaxLength(255)
  objectKey!: string;
}
