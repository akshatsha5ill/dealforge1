# Security Policy

## Supported versions

Only the `main` branch receives security updates.

## Reporting a vulnerability

Please do not open a public issue for security vulnerabilities.

Email the maintainer via the address listed on the GitHub profile, or open a private security advisory on GitHub. Include:

- Affected route/component and version/commit
- Steps to reproduce or proof of concept
- Impact assessment

You should receive an initial response within 72 hours.

## Handling secrets

- Never commit `.env` files, API keys, or service-account credentials.
- Use `server/.env.example` and `client/.env.example` as placeholders only.
- Webhooks verify HMAC signatures; API keys are hashed and never logged.

## Trust model

- The server is the authority for plans, quotas, and billing. Client-side
  gates (`client/src/services/feature-gate.ts`, the Zustand subscription
  cache, referral bonuses) are UX conveniences only and are bypassable by
  design — every paid feature is re-checked server-side (`verifyAuth`,
  `requirePlan`, `enforceAnalysisLimit`).
- Meeting content is local-first (IndexedDB). The server holds a 24h
  in-memory relay buffer only; BYOK provider calls go directly from the
  browser to the AI provider over HTTPS.
