# Free deployment

Life Navigator is designed to run on Cloudflare's Free plans without purchasing a
domain or adding a paid Workers subscription.

## Cost boundary

- Keep the account on **Workers Free**.
- Use the included `<account>.workers.dev` address. A custom domain is optional
  and is not needed by this project.
- Do not select Workers Paid or a paid add-on.
- Free allocations are capped. Once a free limit is reached, affected operations
  fail until the allocation resets; they do not become paid overages on a Free
  account.

Current limits and availability are documented by Cloudflare:

- [Workers and Durable Objects pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [`workers.dev` routing](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)

## Provision the free resources

1. In **Workers & Pages**, configure the included `workers.dev` account subdomain.
   If the dashboard shows a custom-domain purchase flow, leave that flow; a paid
   domain is not required.
2. From `apps/worker`, create the Vectorize index with the embedding model preset:

   ```bash
   npx wrangler vectorize create life-nav-index \
     --preset "@cf/baai/bge-large-en-v1.5"
   ```

3. Run the complete local validation:

   ```bash
   npm ci
   npm run check
   npm audit --audit-level=high
   ```

4. Deploy to the generated `workers.dev` route:

   ```bash
   npx wrangler deploy
   ```

## Protect user data

The API intentionally fails closed until Cloudflare Access is configured.

1. In the Worker's **Domains** settings, enable Cloudflare Access for its
   `workers.dev` route.
2. Configure an Access policy that permits only the intended users.
3. Store the Access team domain and Application Audience tag as Worker secrets:

   ```bash
   npx wrangler secret put TEAM_DOMAIN
   npx wrangler secret put POLICY_AUD
   ```

Never put these values in `wrangler.toml`, `.dev.vars.example`, source code, or
Git history.

## Local development

After the free `workers.dev` subdomain exists, Wrangler can proxy Workers AI while
the rest of the Worker runs locally:

```bash
npm run dev -- \
  --var AUTH_MODE:development \
  --var DEV_USER_ID:local-developer
```

Use a synthetic development identity and never commit `.dev.vars`. Local Workers
AI inference counts against the same free daily allocation as deployed inference.
