# Shared Package

## Purpose

The shared package is the central contract and utility library for the entire monorepo. It is intended to reduce duplication and ensure cross-service consistency for enums, events, and common logic.

The package is in:

- [shared/package.json](../shared/package.json)
- [shared/src/index.ts](../shared/src/index.ts)
- [shared/src/types/enums.ts](../shared/src/types/enums.ts)

## What it contains

The shared package is structured around common concerns, including:

- enums and domain state transitions
- event topic constants
- reusable errors and utilities
- logging helpers
- NestJS wrappers
- Redis helpers
- Kafka helpers
- S3-compatible media storage with presigned POST generation, upload-size policies, byte verification, and staging-object promotion

This makes it the contract layer that services depend on for common language and behavior.

## Shared domain enums

The domain state model is centralized in the shared types module:

- [shared/src/types/enums.ts](../shared/src/types/enums.ts)

This file includes enums and transition tables for:

- `UserRole`
- `RestaurantStatus`
- `OrderStatus`
- `PaymentStatus`
- `DriverStatus`
- `DeliveryStatus`

It also includes transition validation helpers like `isTransitionAllowed` and the transition maps such as `ORDER_TRANSITIONS` and `DELIVERY_TRANSITIONS`.

These transition rules are not just documentation; they are core guardrails for domain state changes across services.

## Shared Kafka topics

The event bus contract is centralized in:

- [shared/src/events/topics.ts](../shared/src/events/topics.ts)

This file defines the canonical Kafka topic names used by the event-driven architecture:

- `order.events`
- `payment.events`
- `delivery.events`

Because all services reference the same names, the repo avoids topic drift and keeps the event model discoverable in one place.

## Shared package value proposition

The shared package gives the repo a few important traits:

- consistent enum values across services
- shared state-machine validation
- central Kafka topic naming
- common logging and helper behavior
- less chance of one service using a slightly different domain definition than another
- consistent media MIME allowlisting, signed upload constraints, S3 object verification, and public URL derivation

## Important caveat

The shared package is a coordination library, not a full domain model or a replacement for service-local persistence. Each service still owns its own database and its own business rules. The shared package is a common vocabulary and helper layer rather than a single source of truth for all runtime state.

## Source of truth

- Shared package entry: [shared/src/index.ts](../shared/src/index.ts)
- Shared enums: [shared/src/types/enums.ts](../shared/src/types/enums.ts)
- Kafka topics: [shared/src/events/topics.ts](../shared/src/events/topics.ts)
- Service docs index: [docs/services.md](../docs/services.md)
