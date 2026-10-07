import { Repository } from 'typeorm';
import { MenuItem } from '../entities/menu-item.entity';
import { MenuItemImage } from '../entities/menu-item-image.entity';
import { MenuItemImagesRepository } from './menu-item-images.repository';

/** An in-memory stand-in for the two tables, enough to check ordering and the mirrored primary. */
function fakeStore(initial: MenuItemImage[]) {
  let rows = [...initial];
  const itemUpdates: Record<string, unknown>[] = [];
  const images = {
    create: (data: Partial<MenuItemImage>) => data,
    save: async (data: Partial<MenuItemImage>) => {
      const row = { id: `img-${rows.length + 1}`, createdAt: new Date(rows.length), ...data } as MenuItemImage;
      rows.push(row);
      return row;
    },
    delete: async ({ id }: { id: string }) => {
      rows = rows.filter((row) => row.id !== id);
    },
    update: async ({ id }: { id: string }, patch: Partial<MenuItemImage>) => {
      rows = rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
    },
    find: async () => [...rows].sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime()),
  };
  const items = { update: async (_where: unknown, patch: Record<string, unknown>) => void itemUpdates.push(patch) };
  const manager = {
    getRepository: (entity: unknown) => (entity === MenuItem ? items : images),
    query: async () => [{ next: rows.length ? Math.max(...rows.map((row) => row.position)) + 1 : 0 }],
  };
  const repo = { manager: { transaction: (work: (m: typeof manager) => unknown) => work(manager) } };
  return { repository: new MenuItemImagesRepository(repo as unknown as Repository<MenuItemImage>), itemUpdates, rows: () => rows };
}

const image = (id: string, position: number, url = `https://cdn/${id}.png`) =>
  ({ id, menuItemId: 'item-1', url, position, createdAt: new Date(position) }) as MenuItemImage;

describe('MenuItemImagesRepository', () => {
  it('appends after the existing images and mirrors the first one as the primary', async () => {
    const store = fakeStore([image('a', 0)]);

    const images = await store.repository.append('item-1', 'https://cdn/new.png');

    expect(images.map((i) => [i.url, i.position])).toEqual([
      ['https://cdn/a.png', 0],
      ['https://cdn/new.png', 1],
    ]);
    expect(store.itemUpdates[store.itemUpdates.length - 1]).toEqual({ imageUrl: 'https://cdn/a.png' });
  });

  it('makes the first upload the primary', async () => {
    const store = fakeStore([]);
    await store.repository.append('item-1', 'https://cdn/first.png');
    expect(store.itemUpdates[store.itemUpdates.length - 1]).toEqual({ imageUrl: 'https://cdn/first.png' });
  });

  it('renumbers after a removal, promotes the next image, and clears the primary when none are left', async () => {
    const store = fakeStore([image('a', 0), image('b', 1), image('c', 2)]);

    const afterFirst = await store.repository.remove('item-1', 'a');
    expect(afterFirst.map((i) => [i.id, i.position])).toEqual([
      ['b', 0],
      ['c', 1],
    ]);
    expect(store.itemUpdates[store.itemUpdates.length - 1]).toEqual({ imageUrl: 'https://cdn/b.png' });

    await store.repository.remove('item-1', 'b');
    await store.repository.remove('item-1', 'c');
    expect(store.rows()).toEqual([]);
    expect(store.itemUpdates[store.itemUpdates.length - 1]).toEqual({ imageUrl: null });
  });
});
