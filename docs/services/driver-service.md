# Driver Service

## Purpose
Tracks driver profiles, availability, and status transitions for delivery operations.

## Main REST endpoints
From `services/driver-service/src/controllers/drivers.controller.ts`:

- `POST /drivers/register` – register a driver profile for the authenticated driver
- `GET /drivers/me` – fetch the current driver profile
- `POST /drivers/me/online` – go online (OFFLINE → AVAILABLE); not while BUSY
- `POST /drivers/me/offline` – go offline (AVAILABLE → OFFLINE); not while BUSY
- `POST /drivers/me/status` – same rules as the two routes above (ADMIN may use it for any valid transition)
- `GET /drivers/available` – list available drivers
- `GET /drivers/:id` – fetch a driver by ID
- `PATCH /drivers/:id/status` – admin/system status update

## Dependencies
- Persists driver data in PostgreSQL
- Used by `delivery-service` to assign drivers and by `tracking-service` to resolve current driver information

## Events published/consumed
None. Driver availability is changed synchronously by `delivery-service` (BUSY on assignment, AVAILABLE on completion or cancellation). The service used to also release drivers from `delivery.completed`/`delivery.cancelled`; that consumer was removed because a late event could free a driver who is already on the next delivery.

## Required env vars
From `services/driver-service/src/config/app-config.ts`:

- `DATABASE_URL`
- `JWT_SECRET`
- `PORT` (default: `3009`)
- `NODE_ENV` (default: `development`)

## Availability lifecycle

Statuses and allowed transitions (`DRIVER_TRANSITIONS` in `shared/src/types/enums.ts`):

```text
OFFLINE   → AVAILABLE, SUSPENDED
AVAILABLE → OFFLINE, BUSY, SUSPENDED
BUSY      → AVAILABLE, SUSPENDED
SUSPENDED → OFFLINE
```

Who may make each transition (`src/common/driver-transition-rules.ts`):

| Transition | Who | Route |
| --- | --- | --- |
| OFFLINE → AVAILABLE, AVAILABLE → OFFLINE | the driver (or ADMIN) | `me/online`, `me/offline`, `me/status` |
| AVAILABLE → BUSY (claim for a delivery) | ADMIN only: delivery-service with its system token | `PATCH /drivers/:id/status` |
| BUSY → AVAILABLE (release after complete/cancel) | ADMIN only: delivery-service with its system token | `PATCH /drivers/:id/status` |
| → SUSPENDED, SUSPENDED → OFFLINE | ADMIN only | either |

Every change goes through one path in `DriversService`, in this order:

1. **Repeated request:** asking for the current status is a no-op returning the driver (200) when that status is AVAILABLE or OFFLINE, so going online twice or releasing a driver twice is retry-safe. **BUSY is never a no-op:** claiming a BUSY driver is always a conflict.
2. **Transition exists?** Otherwise `409 InvalidStateTransition`.
3. **Role allowed?** Otherwise `403`. A driver who is BUSY gets *"Driver is on an active delivery; availability is restored when the delivery completes or is cancelled"*. Drivers cannot free themselves for a second delivery.
4. **Compare-and-set write** (`UPDATE … WHERE id = $1 AND status = <status read>`). If another writer changed the status in between, the loser gets `409`. Two assignments racing for one driver: exactly one claims them. A driver going offline while being claimed: exactly one of the two wins.

### Assignment failure and recovery

- **Lost claim:** delivery-service's `claimAvailableDriver` gets `409`, then tries the next available driver (up to 3), then answers `409 No available drivers to assign`.
- **Claim succeeded but recording the assignment failed:** delivery-service releases the claimed driver (`giveBackClaimedDriver`).
- **Complete/cancel:** delivery-service releases the driver first, idempotently. A repeated release is a no-op, and a driver who is no longer BUSY counts as released. It never releases a driver who is already on another active delivery.
- **Not covered here:** a driver left BUSY with no active delivery (for example, a crash between claim and assignment) needs reconciliation, which is not implemented. ADMIN can repair it with `PATCH /drivers/:id/status`.
