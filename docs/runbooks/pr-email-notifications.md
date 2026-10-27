# Runbook: pull request emails

Every time a pull request is opened (or reopened, or marked ready for review) and every time one is merged, in any Delivery Plus repository, the team gets a branded email:
- the Delivery Plus logo;
- what happened, the title, author, branch, size and linked issues;
- an excerpt of the description;
- a button to the pull request;
- an About section, and a footer with the repository links.

Drafts, pull requests closed without merging, and bot pull requests (Dependabot) send nothing.

## How it works

| Piece | Where |
| --- | --- |
| The workflow | `.github/workflows/pr-email.yml` in this repository. It runs here on `pull_request_target`, and the app repositories call it as a reusable workflow. |
| The template | `.github/scripts/pr-email/render.mjs`, read from `dev`, with tests in `render.test.mjs` (`node --test .github/scripts/pr-email/render.test.mjs`) |
| Delivery | SMTP through [`dawidd6/action-send-mail`](https://github.com/dawidd6/action-send-mail), pinned to a commit |

**Security:**
- **Why `pull_request_target`:** pull requests from forks must be announced too, so the workflow runs with the repository's secrets.
- **What it never does:** check out or run the pull request's code. It reads only the event data, with read-only permissions.
- **Escaping:** every field a contributor controls (title, description, branch, labels, login) is escaped, links are limited to `https`, and the subject is kept to one line, so nothing can inject markup or email headers.
- **Recipients** are blind-copied and are never written in the repository.

## Set it up (owner, once)

Create these as **organisation secrets** in Delivery-Plus0 → Settings → Secrets and variables → Actions, visible to the backend and the app repositories:

| Secret | Value |
| --- | --- |
| `NOTIFY_SMTP_HOST` | The SMTP server. Amazon SES: `email-smtp.<region>.amazonaws.com`. Gmail: `smtp.gmail.com`. |
| `NOTIFY_SMTP_PORT` | Optional, default `465` (TLS). Use `587` for STARTTLS. |
| `NOTIFY_SMTP_USERNAME`, `NOTIFY_SMTP_PASSWORD` | SMTP credentials. For SES, create SMTP credentials in the SES console; they aren't your AWS keys. For Gmail, an app password. |
| `NOTIFY_EMAIL_FROM` | The sender, e.g. `Delivery Plus <no-reply@your-domain.example>`. With SES it must be on a verified identity (see [email-ses.md](./email-ses.md)). |
| `NOTIFY_EMAIL_TO` | The recipients, comma-separated: developers, contributors who opted in, members and maintainers. |
| `NOTIFY_EMAIL_REPLY_TO` | Optional: where replies go, such as the maintainers' address. |

Until they exist, the workflow renders the email and ends with a notice ("Pull request email not sent"). Nothing fails.

**Check it works:** Actions → **Pull request email** → Run workflow, with a pull request number. The email is sent for that pull request as it is now: merged, or open.

## Add it to a repository

The backend runs it already. Each app repository has `.github/workflows/pr-email.yml`:

```yaml
name: Pull request email
on:
  pull_request_target:
    types: [opened, reopened, ready_for_review, closed]
  workflow_dispatch:
    inputs:
      pr:
        description: 'Pull request number to (re)send the email for'
        required: true
permissions:
  contents: read
  pull-requests: read
jobs:
  email:
    uses: Delivery-Plus0/delivery-plus/.github/workflows/pr-email.yml@dev
    with:
      pr: ${{ inputs.pr || '' }}
    secrets: inherit
```

## Change the email

Edit `render.mjs`, then:
1. Run its tests.
2. Preview a real pull request:

   ```bash
   gh api repos/Delivery-Plus0/delivery-plus/pulls/<n> | jq '{action:"opened",pull_request:.}' > /tmp/event.json
   GITHUB_EVENT_PATH=/tmp/event.json GITHUB_REPOSITORY=Delivery-Plus0/delivery-plus \
     node .github/scripts/pr-email/render.mjs --out /tmp/pr-email
   ```

   Then open `/tmp/pr-email/email.html` in a browser.

The logo and icon are `assets/logo_nest.png` and `assets/icon.png`, loaded from `dev` on GitHub, and the colours are the apps' brand colours. Keep the layout table-based with inline styles: email clients ignore most CSS.
