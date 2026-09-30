# Contributing

## Before you start

Read [.project-context/00-INDEX.md](.project-context/00-INDEX.md) first to understand
the overall architecture, then read the relevant [docs/services/<name>.md](docs/services/)
page for the service you're about to change. If you're touching shared enums, event
topics, or cross-service contracts, also check [.project-context/09-shared-package.md](.project-context/09-shared-package.md) and [.project-context/05-event-driven-design.md](.project-context/05-event-driven-design.md) before making changes.

## Workflow

1. Fork the repository and clone your fork.
2. Create a focused branch, for example `feat/menu-cache` or `fix/order-status`.
3. Copy `.env.example` to `.env` for local-only configuration.
4. Install Node.js 22 (22.15 or newer; CI and the Docker images use Node 22) and run `npm ci`.
5. Start dependencies and services with `docker compose up --build -d`.
6. Verify the stack is healthy: `curl http://localhost:3000/health` should return a successful response before you start developing.
7. Make a small, tested change and update documentation when contracts change.

## Checks

Run the repository checks before opening a pull request:

```bash
npm run lint
npm test
npm run build
docker compose config --quiet
```

Run one service directly with `npm run test --workspace=@food-delivery/order-service` or `npm run build --workspace=@food-delivery/order-service`. Coverage is available with `npm run test --workspace=@food-delivery/order-service -- --coverage`.

## Pull Requests

Use the pull request template. Describe the user-visible or operational impact, related issue, tests performed, API or event contract changes, and documentation changes. Keep unrelated refactors out of the change. Pull requests must pass CI, avoid committed secrets and generated output, and receive review from the relevant owners.

Use clear imperative commit subjects, such as `fix: validate payment ownership`. Squash noisy fix-up commits when appropriate.

PRs that change a service's public contract (REST routes, DTOs, or Kafka event payloads) should also update the matching file(s) in docs/services/ and, if the change affects cross-service dependencies or the event topology, the relevant .project-context/ file (03-service-map.md and/or 05-event-driven-design.md).
