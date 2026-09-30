# Project Context Index

This folder is a lightweight, machine-readable knowledge base for AI agents and contributors. The goal is to answer: “What is this project, what does each service do, and where should I look before I edit anything?”

## Required reading order for AI agents

Any AI agent working on an issue in this repo should read this folder first: 01, then 16 (current state), then 02 and 03, then the specific service/topic file relevant to the issue, before writing any code.

Suggested sequence:

1. [01-project-overview.md](./01-project-overview.md)
2. [16-current-state.md](./16-current-state.md) – what is implemented, partial, and missing today; toolchain; CI; recent changes
3. [02-system-architecture.md](./02-system-architecture.md)
4. [03-service-map.md](./03-service-map.md)
5. Jump to the relevant service doc in [../docs/services.md](../docs/services.md)
6. Then read the specific topic file that matches the issue, such as [05-event-driven-design.md](./05-event-driven-design.md), [06-api-gateway.md](./06-api-gateway.md), [08-docker-and-infra.md](./08-docker-and-infra.md), or [15-media-and-storage.md](./15-media-and-storage.md)

## Folder map

- [01-project-overview.md](./01-project-overview.md) – business domain, actors, core entities
- [02-system-architecture.md](./02-system-architecture.md) – high-level architecture and runtime patterns
- [03-service-map.md](./03-service-map.md) – service catalog and cross-dependencies
- [04-database-design.md](./04-database-design.md) – per-service persistence and schema notes
- [05-event-driven-design.md](./05-event-driven-design.md) – Kafka topics and event flows
- [06-api-gateway.md](./06-api-gateway.md) – routing and auth flow through the gateway
- [07-auth-and-security.md](./07-auth-and-security.md) – JWT, roles, and inter-service trust patterns
- [08-docker-and-infra.md](./08-docker-and-infra.md) – Docker Compose and infrastructure behavior
- [09-shared-package.md](./09-shared-package.md) – internal shared library overview
- [10-conventions-and-patterns.md](./10-conventions-and-patterns.md) – repo conventions and structure
- [11-testing-strategy.md](./11-testing-strategy.md) – local testing and validation flow
- [12-environment-and-setup.md](./12-environment-and-setup.md) – environment variables and local run steps
- [13-known-issues-and-gotchas.md](./13-known-issues-and-gotchas.md) – caveats and technical debt
- [14-glossary.md](./14-glossary.md) – domain terms and abbreviations
- [15-media-and-storage.md](./15-media-and-storage.md) – S3-compatible media uploads, ownership, object keys, and security rules
- [16-current-state.md](./16-current-state.md) – status snapshot: capabilities, toolchain, CI workflows, recent changes, planned work

## Relationship to the docs folder

This folder stays broad and high-level. Detailed service-level contract docs live in [../docs/services.md](../docs/services.md) and the per-service pages under [../docs/services](../docs/services).

The repository has a local roadmap under [../issues/README.md](../issues/README.md), but `.gitignore` excludes `issues/` and the directory is not part of the tracked application tree. GitHub is the authoritative remote issue state; local issue files are working metadata only. This folder remains the architecture source of truth.

## Scope

This folder is descriptive only. It is not a coding standard, a task runner, or a behavior policy document.
