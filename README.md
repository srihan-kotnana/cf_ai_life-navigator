# cf_ai_life-navigator

AI-assisted reflective planning app built on **Cloudflare Workers AI**, **Durable Objects**, and **Vectorize**.  
The app logs reflections, generates mood-aware weekly plans, and responds conversationally.

---

## features

- stores persona + plan in a Durable Object (`SessionDO`)
- uses **Workers AI** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) for all reasoning
- embeddings stored in **Vectorize Index**
- includes local + deployed UI
- presents plans as a responsive, keyboard-accessible weekly workspace
- supports mood reflections and per-user plan refreshes via Durable Object alarms

---

## setup

### clone & install
```bash
git clone https://github.com/srihan-kotnana/cf_ai_life-navigator.git
cd cf_ai_life-navigator/apps/worker
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

The Worker serves both the web app and its `/api/*` routes from the same origin.

### validation

```bash
npm run check
```

`npm run check` verifies formatting, lint rules, TypeScript types, tests, and a
dry-run Worker build. The same command runs for every push and pull request in
GitHub Actions. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the development
workflow.

## free deployment

This project can run entirely within Cloudflare's Free plans. A custom domain is
not required: Cloudflare includes a free `workers.dev` subdomain for Workers
accounts. Do not purchase a domain or select Workers Paid during setup.

Follow [`DEPLOYMENT.md`](DEPLOYMENT.md) for the free-only provisioning and release
checklist. Free usage is capped by Cloudflare; when an allocation is exhausted,
requests fail instead of creating paid overage while the account remains on the
Free plan.

## authentication and privacy

Production API routes fail closed unless protected by Cloudflare Access. Configure
an Access application for the deployed Worker, then set its team domain and
Application Audience (AUD) tag:

```bash
cd apps/worker
wrangler secret put TEAM_DOMAIN
wrangler secret put POLICY_AUD
```

`TEAM_DOMAIN` must look like `https://your-team.cloudflareaccess.com`. The Worker
validates the `Cf-Access-Jwt-Assertion` signature, issuer, and audience before
deriving a non-reversible per-user storage identifier.

The setup step creates an ignored local-only development identity from
`.dev.vars.example`. Never use development authentication in a deployed Worker.
To recreate it:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Reflection text is stored in the user's Durable Object and its embedding is kept
in that user's Vectorize namespace. Plans retrieve only matching records from that
namespace. Reflections are limited to 50 records and retained for at most 90 days;
a per-user Durable Object alarm refreshes plans and applies retention daily. The
web app provides data export and deletion controls. API requests and AI calls are
rate-limited per authenticated user.
