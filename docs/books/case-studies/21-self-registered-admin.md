# Case Study 21 — Self-Registered Admin

**Status: OPEN — CRITICAL (found while writing this library; not fixed; confirmed by reading the code, not yet reproduced live)** · [Case studies](README.md) · Book: [17](../17-security-engineering.md) · Lab: [SEC-08](../labs/security-labs.md#sec-08-self-registered-admin)

## Symptom

Public registration accepts a `role` field, and `ADMIN` is one of the accepted values.

## Root cause

`services/auth-service/src/dto/register.dto.ts`:
```ts
@IsEnum(UserRole, { message: 'role must be one of CUSTOMER, RESTAURANT_OWNER, DRIVER, ADMIN' })
role?: UserRole;
```
`services/auth-service/src/services/auth.service.ts`:
```ts
const role = dto.role ?? UserRole.CUSTOMER;
// … credential created with that role; the issued JWT carries it
```
- Validation checks that the value is *a* role, not that the caller may *choose* it.
- `POST /api/auth/register` is public, and email verification is off by default (`EMAIL_VERIFICATION_REQUIRED=false`).

## Why the naive version looked reasonable

- Early in development, one register endpoint for every actor (customer, restaurant owner, driver) is convenient for seeding and demos. The seed scripts register owners and drivers this way.
- The DTO validates the field, so it *looks* like input validation was done.
- Nobody listed "which fields may an anonymous caller set?"

## Impact

Anyone can become **ADMIN** with one request, and ADMIN bypasses ownership checks throughout the platform. From the code:

| Service | What ADMIN can do |
| --- | --- |
| payment-service | issue refunds (admin-only since [case study 01](01-failed-payment-race.md)) and read any payment |
| order-service | read any order; drive status transitions |
| delivery-service | read, create, assign and cancel any delivery |
| driver-service | list available drivers (plates), set any driver's status |
| tracking-service | read any driver's location |
| restaurant-service, user-service | admin paths in each |

This also defeats the fixes in case studies [02](02-delivery-ownership-bug.md), [03](03-public-driver-endpoint.md) and [18](18-system-token.md). Self-selecting `RESTAURANT_OWNER` or `DRIVER` is a lesser, related problem: business roles normally need vetting.

## Fix (proposed; not applied, per this library's "no application changes" rule)

1. **Public registration accepts only self-service roles.** Remove ADMIN from the accepted values, with an explicit allow-list:
   ```ts
   const SELF_SERVICE_ROLES = [UserRole.CUSTOMER, UserRole.DRIVER, UserRole.RESTAURANT_OWNER] as const;
   @IsIn(SELF_SERVICE_ROLES) role?: ...
   ```
   Also check it in the service, not just the DTO (defence in depth).
2. **Business roles behind approval.** DRIVER and RESTAURANT_OWNER start as `pending` until reviewed. This is a product decision.
3. **Admins are created out of band:** a seed or CLI with a one-time bootstrap, or an admin-only endpoint.
4. **Audit existing accounts:** `SELECT email, "createdAt" FROM credentials WHERE role = 'ADMIN';` in `auth_service`. Investigate unknown admins, rotate `JWT_SECRET`, and review refunds.
5. **Tests:**
   - a DTO test that `role: ADMIN` is rejected with 400;
   - an API test registering with ADMIN and asserting 400 (or that the stored role is CUSTOMER);
   - a test that the existing roles still register (seeds depend on them).

## Trade-offs

- The seed scripts (`scripts/seed.ts`, `scripts/seed-demo.ts`, `scripts/seed-e2e.ts`) register owners and drivers through this endpoint. They keep working if those roles stay self-service, and only the ADMIN path needs another route.
- An approval flow is real product work. The urgent part (ADMIN) is a one-line allow-list.

## What can still go wrong

- Other DTOs that accept privileged fields (`role`, `status`, `ownerId`, `isVerified`). Mass-assignment review: grep DTOs for fields a caller should not control.
- JWTs already issued to self-made admins stay valid for up to 1 h after the fix, unless `JWT_SECRET` is rotated.

## What a senior engineer would ask

1. Is this exploitable in any deployed environment *right now*? Who checks, today?
2. Why didn't any of our security reviews or tests list "who can set `role`"?
3. What is the *class* of bug (mass assignment / privilege selection), and where else does it occur?
4. Should the response disclose role at all on registration?
