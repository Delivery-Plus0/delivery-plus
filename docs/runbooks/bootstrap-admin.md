# Runbook: create the first super admin

Use this once per environment, when it has no staff yet. Staff accounts can't be self-registered, and later staff are invited by an admin (#216).

## What it does

- Creates one account with role `ADMIN`, its email marked verified, status `ACTIVE`, and **every** staff permission (`support.read`, `support.act`, `ops.read`, `ops.act`, `finance.read`, `finance.act`, `onboarding.review`, `users.manage`, `staff.manage`, `audit.read`).
- Runs only when **no** `ADMIN` account exists.
  - Everything happens in one database transaction under an advisory lock, so two runs at the same moment still create only one admin.
  - A second run is refused (exit code 1).
- Refuses passwords shorter than 12 characters, and an email that already belongs to an account.
- Never prints or logs the password. Only its bcrypt hash is stored.
- Doesn't create a user-service profile: staff sign in to the admin console, which doesn't need one.

## Before you start

- The auth-service database is migrated. auth-service runs its migrations when it starts, so start it once first.
- You have a dedicated staff email address (not one that already has a customer, owner or driver account).
- You have a long, unique password from your password manager.

## Run it

**Inside the running auth-service container** (production, staging):

```bash
docker compose -f docker-compose.base.yml -f docker-compose.prod.yml exec \
  -e BOOTSTRAP_ADMIN_EMAIL=ops@your-domain.example \
  auth-service node dist/bootstrap/cli.js
```

- The container already has `DATABASE_URL`.
- With a terminal attached and no `BOOTSTRAP_ADMIN_PASSWORD`, it asks for the password and doesn't echo it.
- Prefer the prompt: an environment variable can end up in shell history or process listings.

**From a workstation** with network access to the database (for example through an SSH tunnel):

```bash
DATABASE_URL=postgres://user:password@localhost:5432/auth_service \
BOOTSTRAP_ADMIN_EMAIL=ops@your-domain.example \
npm run bootstrap:admin
```

**Expected output:**
- Success: `Created the first super admin ops@your-domain.example (<id>) with 10 permissions.`, exit code 0.
- An admin already exists: `Refused: Staff already exist: …`, exit code 1, and nothing is changed.

## After

1. Sign in to the admin console with the new account and change nothing else until it works.
2. Store the credentials in the team password manager.
3. Invite the other staff from the console with only the permissions they need (#216). Don't share the super admin.

## Test and development stacks

The test and dev compose overlays set `TEST_ADMIN_EMAIL` and `TEST_ADMIN_PASSWORD` on auth-service.
- At startup, auth-service creates that admin through the same code, unless an admin already exists.
- The seeds and `npm run e2e` use it.
- auth-service refuses to start with `TEST_ADMIN_*` in production: there, use this runbook.
