# Case Study 18 — System Token

**Status: CURRENT (a known weakness, documented in the code)** · [Case studies](README.md) · Books: [17](../17-security-engineering.md), [10](../10-microservices-and-domain-design.md) · Lab: [SEC-03](../labs/security-labs.md#sec-03-mint-and-inspect-a-system-token)

## What it is

payment-service, delivery-service and tracking-service each have a `SystemTokenService` (`services/<svc>/src/common/system-token.service.ts`):
```ts
const token = await this.jwtService.signAsync(
  { sub: 'system:delivery-service', email: 'delivery-service@internal', role: UserRole.ADMIN },
  { secret: this.config.jwtSecret, expiresIn: '5m' },
);
```
They use it to call other services' admin-only routes: order status transitions, driver status, and the available-driver list.

## Why it was built this way

- Every service already verifies JWTs with the shared `JWT_SECRET`, so a token signed with it "just works" everywhere.
- It needed no new infrastructure: no mTLS, no service mesh, no identity provider.
- The code comment says so plainly: *"SIMPLIFICATION: … a stand-in for a proper service-identity/mTLS scheme."*

## The problem

1. **Every service holding `JWT_SECRET` can mint any identity**, including ADMIN or any customer. One compromised service means a compromised platform.
2. **Receivers can't tell a service from a human admin.** Both carry `role: ADMIN`, so audit logs can't distinguish "support refunded this" from "a service called this".
3. **Over-privilege.** delivery-service needs "set this driver BUSY/AVAILABLE", but it gets everything an admin can do.
4. Rotating `JWT_SECRET` logs out every user and must be coordinated across every service at once.

## The better pattern already in the repo

`auth-service → user-service` profile creation uses **HMAC-signed internal requests** (`shared/src/nest/auth/internal-auth.ts`, [ADR 001](../../adr/001-internal-service-authentication.md)):
- per-caller identity;
- timestamp and nonce (replay protection in Redis);
- body hash;
- `/internal/*` routes blocked at the gateway.

It is narrower and auditable, but needs a secret per caller–receiver pair.

## Options

| Option | Fixes | Cost |
| --- | --- | --- |
| asymmetric JWT (auth-service signs with a private key; services verify with the public key) | services can no longer mint user tokens | services still need their own identity |
| a distinct `SERVICE` role + per-route permissions | audit and over-privilege | role checks in each service |
| HMAC internal routes (existing pattern) | identity, replay, scope | key management per pair |
| mTLS / service mesh identity | strong identity at transport | infrastructure ([Book 19](../19-kubernetes.md)) |
| events instead of calls (Phase 9) | removes many calls entirely | eventual consistency |

## What can still go wrong today

- A leaked `.env`, or a container shell, gives a full admin. [SEC-03](../labs/security-labs.md#sec-03-mint-and-inspect-a-system-token) shows it in three commands.
- With the [self-registered admin](21-self-registered-admin.md) flaw, an attacker doesn't even need the secret.

## What a senior engineer would ask

1. List every call made with a system token and the minimum permission each needs.
2. What is the smallest change that stops services from minting *user* tokens?
3. How would an auditor tell, from logs, who refunded a payment?
4. Plan a `JWT_SECRET` rotation with zero downtime.
