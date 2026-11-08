import { RestaurantsRepository } from './restaurants.repository';
import { ListRestaurantsQueryDto } from '../dto/list-restaurants-query.dto';

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

  it('filters by delivery radius, sorts by distance, and counts before pagination', async () => {
    const restaurants = [{ id: 'near' }, { id: 'far' }] as any[];
    const countQuery = { getCount: jest.fn().mockResolvedValue(7) };
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      clone: jest.fn().mockReturnValue(countQuery),
      getRawAndEntities: jest.fn().mockResolvedValue({
        entities: restaurants,
        raw: [{ distanceKm: '1.2' }, { distanceKm: '4.8' }],
      }),
    };
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    };
    const service = new RestaurantsRepository(repository as any);
    const query = {
      page: 2,
      limit: 2,
      sortBy: 'name',
      sortOrder: 'DESC',
      lat: 30.0444,
      lng: 31.2357,
    } as ListRestaurantsQueryDto;

    const [items, total] = await service.list(query, 5);

    expect(items).toEqual([
      { restaurant: restaurants[0], distanceKm: 1.2 },
      { restaurant: restaurants[1], distanceKm: 4.8 },
    ]);
    expect(total).toBe(7);
    // #208: customers only see approved restaurants.
    expect(queryBuilder.where).toHaveBeenCalledWith(`r.approvalStatus = 'APPROVED'`);
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('r.latitude IS NOT NULL AND r.longitude IS NOT NULL');
    expect(queryBuilder.addSelect).toHaveBeenCalledWith(
      expect.stringContaining('COS(RADIANS(r.latitude))'),
      'distanceKm',
    );
    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('COALESCE(r.deliveryRadiusKm::double precision, :defaultRadiusKm)'),
      { lat: 30.0444, lng: 31.2357, defaultRadiusKm: 5 },
    );
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('"distanceKm"', 'ASC');
    expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('r.id', 'ASC');
    expect(queryBuilder.skip).toHaveBeenCalledWith(2);
    expect(queryBuilder.take).toHaveBeenCalledWith(2);
    expect(countQuery.getCount).toHaveBeenCalled();
  });

  it('preserves the unlocated list sort and paging behavior', async () => {
    const queryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[{ id: 'restaurant-a' }], 1]),
    };
    const repository = { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) };
    const service = new RestaurantsRepository(repository as any);
    const query = { page: 2, limit: 10, sortBy: 'name', sortOrder: 'ASC' } as ListRestaurantsQueryDto;

    const result = await service.list(query, 5);

    expect(result).toEqual([[{ restaurant: { id: 'restaurant-a' } }], 1]);
    expect(queryBuilder.orderBy).toHaveBeenCalledWith('r.name', 'ASC');
    expect(queryBuilder.skip).toHaveBeenCalledWith(10);
    expect(queryBuilder.take).toHaveBeenCalledWith(10);
  });
});