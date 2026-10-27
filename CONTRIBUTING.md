# Contributing

## Before you start

Read [.project-context/00-INDEX.md](.project-context/00-INDEX.md) first to understand
the overall architecture, then read the relevant [docs/services/<name>.md](docs/services/)
page for the service you're about to change. If you're touching shared enums, event
topics, or cross-service contracts, also check [.project-context/09-shared-package.md](.project-context/09-shared-package.md) and [.project-context/05-event-driven-design.md](.project-context/05-event-driven-design.md) before making changes.

Work is planned in GitHub milestones ("Production 0" to "Production 9"). The order, the rules for every issue and the open owner decisions are in [docs/roadmap/production.md](docs/roadmap/production.md).

## Workflow

1. **Pick an issue** from the lowest open milestone whose **Depends on** issues are all closed. Comment on it to claim it, and wait to be assigned so two people don't build the same thing. If it says **decision** and no comment records one, ask before you start.
2. **Fork** the repository and clone your fork.
3. **Branch from `dev`**, one branch per issue, for example `feat/menu-cache` or `fix/order-status`.
4. **Install** Node.js 22 (22.15 or newer; CI and the Docker images use Node 22) and run `npm ci`.
5. **Start the development stack:** `docker compose -f docker-compose.base.yml -f docker-compose.dev.yml up -d --build --wait --wait-timeout 300`. It needs no `.env`. Copy `.env.example` to `.env` only to override a local default, and never commit it. The root `docker-compose.yml` is a production-like layout that refuses to start without real secrets.
6. **Check the stack is healthy:** `curl http://localhost:3000/health` should succeed before you start developing. `npm run seed` then creates sample accounts (see the README).
7. **Make a small, tested change:** one test per acceptance criterion. Update the documentation in the same pull request when behaviour or contracts change.

## Checks

Run the repository checks before opening a pull request:

```bash
npm run verify    # lint, unit tests and build of every workspace
docker compose -f docker-compose.base.yml -f docker-compose.dev.yml config --quiet
docker compose -f docker-compose.base.yml -f docker-compose.test.yml config --quiet
```

For a change in service behaviour, also run the isolated E2E stack (`npm run e2e:start`, then `npm run e2e`; see [docs/e2e.md](docs/e2e.md)).

Run one service directly with `npm run test --workspace=@food-delivery/order-service` or `npm run build --workspace=@food-delivery/order-service`. Coverage is available with `npm run test --workspace=@food-delivery/order-service -- --coverage`.

## Pull Requests

Use the pull request template. Describe the user-visible or operational impact, related issue, tests performed, API or event contract changes, and documentation changes. Keep unrelated refactors out of the change. Pull requests must pass CI, avoid committed secrets and generated output, and receive review from the relevant owners.

Open the pull request against `dev`, with `Closes #N` in the description, and keep it to one issue. Put an unrelated fix, even a small one, in its own pull request.

The pull request title becomes the commit subject on `dev`, so use a Conventional title, such as `fix(payment-service): validate payment ownership` or `feat(auth): …`. Use clear imperative commit subjects too.

Reply to every review comment, push the fixes, then re-request a review. A pull request is done only when it is merged with every check green.

PRs that change a service's public contract (REST routes, DTOs, or Kafka event payloads) should also update the matching file(s) in docs/services/ and, if the change affects cross-service dependencies or the event topology, the relevant .project-context/ file (03-service-map.md and/or 05-event-driven-design.md).
