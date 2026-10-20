/**
 * F8 (#204): TypeORM ignores a `where` property whose value is `undefined`, so
 * `findOne({ where: { id: undefined } })` matches the first row of the table, and
 * `update({ id: undefined }, …)` can hit every row. Every service's DataSource sets
 * `invalidWhereValuesBehavior` to this, which makes such a query throw instead. TypeORM applies it
 * to find options and to update/delete criteria.
 *
 * A plain object (shared has no TypeORM dependency); typed as TypeORM's InvalidFindOptionsWhereBehavior.
 */
export const STRICT_WHERE_VALUES = { undefined: 'throw' } as const;
