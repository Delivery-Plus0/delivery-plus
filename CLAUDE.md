# Delivery Plus backend: instructions for Claude Code

The backend monorepo: an API gateway plus 11 NestJS services and `shared/`, with Postgres, Redis, Kafka and S3-compatible storage. The default branch is **`dev`**. This repository is **public**: never commit secrets, real customer data, or `.env` files.

## Start of every session

1. Read `docs/roadmap/production.md`. It gives the milestone order, the rules for every issue, and the open owner decisions.
2. Find the current milestone: the lowest-numbered open "Production N" milestone.
   ```bash
   gh api repos/Delivery-Plus0/delivery-plus/milestones --jq '.[] | select(.title|startswith("Production")) | "\(.title)  open=\(.open_issues)"'
   gh issue list --milestone "Production 1 · Accounts & sessions" --state open   # the milestone found above
   ```
3. Read `.project-context/00-INDEX.md` and follow its reading order (01 → 16 → 02 → 03 → the topic file).

## When asked to "start the milestone" or "work on the next issue"

1. List the milestone's open issues. Pick one whose **Depends on** issues are all closed. Backend issues come before app issues.
2. Read the issue and all its comments. If it says **decision** and nothing in the comments records one, **stop and ask**.
3. Branch from up-to-date `dev`: `git switch dev && git pull && git switch -c feat/<short-name>`.
4. Implement it with tests. Follow the patterns already in the code:
   - compare-and-set status writes;
   - the transactional outbox for events;
   - durable consumer idempotency;
   - HMAC for internal routes (ADR 001);
   - the `shared/` helpers.
5. Run `npm run verify`. For service behavior, also run the E2E stack: `npm run e2e:start`, then `npm run e2e` (see `docs/e2e.md`).
6. Update docs in the same PR: OpenAPI (`npm run openapi:generate`), `docs/services/*.md`, `.project-context/16-current-state.md`, and `docs/business/*.md` when a rule changes.
7. Open a PR to `dev` with `Closes #N` and the PR template filled in. Wait for every required check to pass. Only a merged PR with green CI counts as done. Merge and squash-message rules: `docs/roadmap/production.md` → "Done".
8. After a merge, tick the issue's acceptance criteria. When the last issue of a milestone closes, close the milestone and update the workspace `planning.md` if you have access to it.

## Commits

- Commit as the repository owner's configured git identity.
- **Don't add `Co-Authored-By` lines for Claude or any AI tool**, and don't add generated-by footers to commits or PRs.
- Use Conventional Commit subjects: `fix(payment-service): …`, `feat(auth): …`.

## Never

- Merge with red CI, or skip hooks or tests.
- Change a business rule in `docs/business/` without the owner's decision.
- Store raw tokens, OTP codes, document URLs or phone numbers in logs.
- Weaken an existing guard (roles, ownership, HMAC, compare-and-set) to make a test pass.
