# cf_ai_life-navigator

AI-assisted reflective planning app built on **Cloudflare Workers AI**, **Durable Objects**, and **Vectorize**.  
The app logs reflections, generates mood-aware weekly plans, and responds conversationally.

---

## features

- stores persona + plan in a Durable Object (`SessionDO`)
- uses **Workers AI** (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) for all reasoning
- embeddings stored in **Vectorize Index**
- includes local + deployed UI
- supports mood reflections and plan updates automatically via scheduled tasks

---

## setup

### clone & install
```bash
git clone https://github.com/srihan-kotnana/cf_ai_life-navigator.git
cd cf_ai_life-navigator/apps/worker
npm install
npm run dev
```

The Worker serves both the web app and its `/api/*` routes from the same origin.

### validation

```bash
npm test
npm run typecheck
npm run build
```

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

For local development only:

```bash
cp .dev.vars.example .dev.vars
npm run dev
```

Reflections are isolated by user, limited to 50 records, and retained for at most
90 days when new reflections are recorded. The web app provides data export and
deletion controls. API requests and AI calls are rate-limited per authenticated
user.
