import { RestaurantsRepository } from './restaurants.repository';

describe('RestaurantsRepository', () => {
  it('filters owner selection by the authenticated owner id', async () => {
    const ownedRestaurant = { id: 'restaurant-a', ownerId: 'owner-a' } as any;
    const repository = {
      find: jest.fn().mockResolvedValue([ownedRestaurant]),
    };
    const restaurants = new RestaurantsRepository(repository as any);

    await expect(restaurants.findByOwner('owner-a')).resolves.toEqual([ownedRestaurant]);
    expect(repository.find).toHaveBeenCalledWith({
      where: { ownerId: 'owner-a' },
      order: { createdAt: 'DESC' },
    });
  });
});