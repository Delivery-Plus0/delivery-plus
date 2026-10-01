# Case Study 04 — Notification Ownership

**Status: CURRENT (fixed in commit `8f0ecc0`)** · [Case studies](README.md) · Books: [17](../17-security-engineering.md), [04](../04-database-fundamentals.md) · Lab: [SEC-07](../labs/security-labs.md#sec-07-reproduce-a-bola-check)

## Symptom

`PATCH /api/notifications/:id/read` marked **any** user's notification as read, and a malformed ID was not rejected up front.

## Root cause

```ts
// before — services/notification-service/src/repositories/notifications.repository.ts
async markAsRead(id: string): Promise<void> {
  await this.repo.update(id, { isRead: true });
}
```
- The query's `WHERE` clause filtered only by ID; the caller's identity never reached the query.
- The ID was not validated as a UUID before reaching PostgreSQL, which expects a `uuid`.

## Why the naive version looked reasonable

- Listing notifications was already filtered by user, so the feature "worked" in the UI.
- Marking something as read feels harmless.

## Impact

- Low direct harm, but it is still an integrity bug: another user's notifications could be marked as read.
- It is a pattern risk: the same shape (`update(id, …)`) on a more sensitive table becomes a serious bug.

## Fix

Ownership goes **into the query**, not into a check before it:
```ts
async markAsReadForUser(id: string, userId: string): Promise<boolean> {
  const result = await this.repo.update({ id, userId }, { isRead: true });
  return (result.affected ?? 0) > 0;
}
```
- `affected = 0` means the notification is missing *or* belongs to someone else. Both return **404**, so the API doesn't reveal that the ID exists.
- The controller validates the ID (malformed → 400).

## Tests

- `notifications.controller.spec.ts`, `notifications.service.spec.ts`, and the repository update criteria in notification-service.
- Live: [SEC-07](../labs/security-labs.md#sec-07-reproduce-a-bola-check), where someone else's notification returns 404.

## Trade-offs

- **404 vs 403:** 404 hides existence; 403 is more honest for debugging. Notifications chose 404; deliveries chose 403 ([case study 02](02-delivery-ownership-bug.md)).
- Single-statement ownership (`WHERE id AND userId`) is atomic. A separate "read then check then write" is not, though here the owner never changes.

## What can still go wrong

- **TypeORM hazard.** In TypeORM 0.3, `undefined` values in *find* where clauses are ignored by default:
  - `findOne({ where: { id, userId: undefined } })` silently matches by ID only.
  - In *update* criteria, `undefined` binds as `NULL` and matches nothing.
  - So the update here is safe, but the same idea written as a `find` would not be. Make sure `userId` can never be undefined (it comes from the verified JWT).
- Pagination uses offset, so notification lists get slow for very active users ([DB-06](../labs/database-labs.md#db-06-offset-vs-keyset-pagination)).

## What a senior engineer would ask

1. Grep for `update(id` and `findOne({ where: { id` across services. Which other queries lack an owner column?
2. Should repositories make the owner a required parameter, so it can't be forgotten?
3. What does the 404 choice cost support staff investigating a customer's report?
