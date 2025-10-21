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

##  setup

### clone & install
```bash
git clone https://github.com/<your-username>/cf_ai_life-navigator.git
cd cf_ai_life-navigator/apps/worker
npm install