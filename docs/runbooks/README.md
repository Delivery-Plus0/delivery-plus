# Runbooks

Operational notes and incident-response guides live here.

## Starter sections

- Service startup and healthchecks
- Kafka topic checks
- PostgreSQL and Redis verification
- Common production incident flow
- Rollback and recovery steps

## Available runbooks

- [Local stack troubleshooting](./local-stack-troubleshooting.md) - Compose validation, healthcheck limitations, migrations, Kafka, and Redis checks
- [Create the first super admin](./bootstrap-admin.md) - one-time staff bootstrap per environment (#202)
- [Verification emails through Amazon SES](./email-ses.md) - domain DKIM/SPF/DMARC, leaving the sandbox, a send-only IAM policy (#203)

## Suggested format

Each runbook should be a focused guide with:

1. Purpose
2. Symptoms and detection
3. Investigation steps
4. Mitigation
5. Recovery verification
6. Ownership and follow-up
