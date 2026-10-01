import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateOrderDto } from './create-order.dto';

/** Runs a checkout body through the same ValidationPipe options as main.ts. */
describe('CreateOrderDto at the request boundary', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreateOrderDto }) as Promise<CreateOrderDto>;

  it('accepts an empty body (existing clients rely on the profile address)', async () => {
    await expect(validate({})).resolves.toBeInstanceOf(CreateOrderDto);
  });

  it('accepts an address with notes and both coordinates, trimming text', async () => {
    const dto = await validate({
      deliveryAddress: '  9 Nile Corniche ',
      deliveryNotes: ' Gate 42 ',
      deliveryLatitude: 30.0444,
      deliveryLongitude: 31.2357,
    });
    expect(dto).toMatchObject({ deliveryAddress: '9 Nile Corniche', deliveryNotes: 'Gate 42' });
  });

  it.each([
    ['a blank address', { deliveryAddress: '   ' }],
    ['an address over 500 characters', { deliveryAddress: 'x'.repeat(501) }],
    ['a non-string address', { deliveryAddress: 42 }],
    ['notes over 500 characters', { deliveryNotes: 'x'.repeat(501) }],
    ['a latitude without a longitude', { deliveryAddress: 'A', deliveryLatitude: 30 }],
    ['a longitude without a latitude', { deliveryAddress: 'A', deliveryLongitude: 31 }],
    ['an out-of-range latitude', { deliveryAddress: 'A', deliveryLatitude: 91, deliveryLongitude: 31 }],
    ['an out-of-range longitude', { deliveryAddress: 'A', deliveryLatitude: 30, deliveryLongitude: 181 }],
    ['an unknown field', { deliveryAddress: 'A', status: 'DELIVERED' }],
  ])('rejects %s with 400', async (_label, body) => {
    await expect(validate(body)).rejects.toBeInstanceOf(BadRequestException);
  });
});
