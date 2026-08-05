# Contributing

## Local setup

Use Node.js 24 or newer, then install the Worker dependencies:

```bash
cd apps/worker
npm ci
cp .dev.vars.example .dev.vars
```

Run `npm run dev` to start the Worker and its static web app.

## Quality checks

Before committing a change, run:

```bash
npm run check
npm audit --audit-level=high
```

`npm run check` runs formatting verification, linting, strict TypeScript checks,
the Vitest suite, and a Wrangler dry-run build. To apply the standard formatter,
run `npm run format`.

GitHub Actions performs the same validation for pushes and pull requests.

## Repository hygiene

Do not commit `.dev.vars`, Wrangler state, generated bundles, coverage output, or
dependency directories. Keep secrets in Wrangler secrets and use only synthetic
data in tests.
