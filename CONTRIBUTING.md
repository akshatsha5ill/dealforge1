# Contributing to DealForge

Thanks for your interest in contributing! This project is maintained as an open-source portfolio project.

## Getting started

1. Fork the repo and create a branch from `main`:
   `git checkout -b feat/short-description`
2. Install dependencies: `npm install`
3. Copy env examples:
   `cp server/.env.example server/.env`
   `cp client/.env.example client/.env`
4. Run dev servers: `npm run dev`

## Checks before opening a PR

- `npm run typecheck --workspace=client`
- `npm run typecheck --workspace=server`
- `npm run lint --workspace=client`
- `npm run test --workspace=client`
- `npm run test --workspace=server`

## Pull requests

- Keep PRs focused and small.
- Update `README.md` or `docs/` when behavior changes.
- Do not commit `.env` files, credentials, or build output (`dist/`).
- The CI workflow (`.github/workflows/ci.yml`) must pass.

## Reporting issues

Use the issue templates for bug reports and feature requests. Include steps to reproduce, expected behavior, and environment details.
