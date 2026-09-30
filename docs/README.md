# Contributor Documentation

This folder is the main human-readable documentation hub for the repository.

## Start here

- [Overview](../README.md) – project summary and quick start
- [Current state](../.project-context/16-current-state.md) – what is implemented, partial, and missing today; toolchain; CI; recent changes
- [Architecture](./architecture.md) – service boundaries and communication model
- [Media and storage](../.project-context/15-media-and-storage.md) – S3-compatible image uploads, key layout, and security rules
- [Deployment](./deployment.md) – Docker, environment variables, and runtime setup
- [Services index](./services.md) – links to all service-level docs
- [ADR index](./adr/README.md) – architecture decision records
- [Runbooks](./runbooks/README.md) – operational playbooks and incident guides

## Service docs

- [API Gateway](./services/api-gateway.md)
- [Auth Service](./services/auth-service.md)
- [User Service](./services/user-service.md)
- [Restaurant Service](./services/restaurant-service.md)
- [Menu Service](./services/menu-service.md)
- [Cart Service](./services/cart-service.md)
- [Order Service](./services/order-service.md)
- [Payment Service](./services/payment-service.md)
- [Delivery Service](./services/delivery-service.md)
- [Driver Service](./services/driver-service.md)
- [Tracking Service](./services/tracking-service.md)
- [Notification Service](./services/notification-service.md)

## Notes

The project is structured as a Node.js 22 + NestJS 10 microservice platform with PostgreSQL 16, Redis 7, Kafka, and S3-compatible object storage backing the domain services. For implementation details, prefer the service pages and the root README; planned roadmap work must not be read as implemented behavior.

AI agents and new contributors should also read [../.project-context/00-INDEX.md](../.project-context/00-INDEX.md), the architecture knowledge base, before changing code.
