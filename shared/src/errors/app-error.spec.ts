import { OutOfDeliveryAreaError } from './app-error';

describe('OutOfDeliveryAreaError', () => {
  it('exposes the conflict code and rounded distance details', () => {
    const error = new OutOfDeliveryAreaError(6.126, 5);

    expect(error).toMatchObject({
      statusCode: 409,
      error: 'OutOfDeliveryArea',
      details: { distanceKm: 6.13, maxRadiusKm: 5 },
    });
  });
});
