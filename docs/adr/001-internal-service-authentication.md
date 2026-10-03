# ADR 001: Internal Service Authentication

- Status: accepted
- Date: 2026-09-20

## Context

The platform uses JWTs for end-user authentication. Cross-service HTTP calls need a separate verifiable service identity; this contract was first applied to profile creation and is also used for restaurant ownership verification.

The repository runs services in Docker Compose and does not currently depend on a service mesh, cloud IAM, or certificate-management platform. The internal trust model therefore needs to be explicit, implementable with environment configuration, and separate from end-user JWT claims.

## Decision

Internal HTTP requests that cross a service ownership boundary will use a dedicated HMAC request-signing contract. This is separate from user JWT authentication.

The implementation contract is:

- Each calling service has a stable service identifier, such as `auth-service`.
- Each caller and receiver share a dedicated secret configured through environment variables. Secrets are never accepted from user input or stored in request bodies.
- The caller sends:
  - `X-Internal-Service`: caller service identifier
  - `X-Internal-Timestamp`: Unix timestamp in seconds
  - `X-Internal-Nonce`: unique request nonce
  - `X-Internal-Signature`: HMAC-SHA256 signature
- The signed canonical input includes the HTTP method, normalized request path, timestamp, nonce, and a SHA-256 hash of the request body.
- The receiver validates the caller identity, timestamp skew, signature, and nonce replay status before executing the internal operation.
- Prefer not routing internal-only endpoints through the public API Gateway. If an internal route is proxied, HMAC validation remains mandatory; gateway routing must not be treated as authentication.
- Invalid, missing, expired, or replayed internal credentials return `401` or `403` without executing the operation.
- User JWTs remain required for user-facing routes. A valid user JWT does not authorize an internal service route by itself.
- Correlation IDs remain observability metadata and are not authentication credentials.

The initial application target is `auth-service` -> `user-service` for `POST /internal/users` (DP-010). The contract also protects `GET /restaurants/:id/ownership/:userId`: restaurant-service accepts only the configured `menu-service` and `order-service` callers. Both callers sign the method and path with the shared secret, timestamp, nonce, and empty-body hash. User-service enforces profile ownership and auth/profile identity mapping on user-facing profile reads and updates.

## Consequences

- Internal callers have an explicit, verifiable identity.
- Request tampering, stale signatures, and basic replay attempts can be rejected.
- The design works with the current Docker Compose environment and does not require a mesh or cloud provider.
- Secrets must be provisioned and rotated per service relationship.
- Redis enforces nonce replay protection with `SET NX` and a 600-second TTL; the guards reject timestamps more than 300 seconds from the current clock.
- Signing and verification must be shared carefully to avoid differences in path normalization, body serialization, or clock handling.
- The contract is implemented for profile creation and restaurant ownership verification. Other cross-service boundaries still need to be classified and protected individually.

## Alternatives considered

### Shared static bearer token

Rejected as the canonical design because a bearer token can be replayed if captured and does not bind credentials to the request contents.

### End-user JWT for internal calls

Rejected because user identity and service identity are different trust domains. It would also make internal authorization depend on a user being present.

### mTLS or service mesh

Deferred because the current repository has no certificate lifecycle, mesh, or deployment platform to operate it. It may be considered for a future deployment environment without changing the trust-boundary principle.
