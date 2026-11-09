# Scholarship Hunter

AI agent that finds scholarships for Tamil Nadu college students — free stack (Groq + Gemini + Cloudflare).

## Open in VS Code

1. Unzip this folder.
2. VS Code → **File → Open Folder…** → select `scholarship-hunter`.
3. Read `docs/PROJECT_CONTEXT.md` — it has every decision, the architecture, rules and roadmap.

## Start Git (work on a dev branch)

```bash
git init
git add .
git commit -m "Project context and scholarship dataset"
git branch -M main
git checkout -b dev
# create an empty repo on GitHub, then:
git remote add origin https://github.com/<your-username>/scholarship-hunter.git
git push -u origin main
git push -u origin dev
```

## What's here

| Path | What it is |
|---|---|
| `docs/PROJECT_CONTEXT.md` | Full project context from the planning chat |
| `data/scholarships_v2.csv` | 25 schemes, 37 columns (open in Excel / Google Sheets) |
| `data/scholarships.json` | Same data as JSON, used by the app |
| `shared/engine.js` | Rule engine: ✅ / 🟡 / ❌ per scheme + deadline status (used by website **and** Worker) |
| `frontend/` | Website: profile form, results, chat, certificate check, calendar buttons |
| `worker/` | Cloudflare Worker: Groq agent (3 tools) + Gemini certificate check |
| `tests/` | Engine tests (`npm test`) |

## Run locally

1. **Website (works offline, no keys needed):** VS Code → right-click `frontend/index.html` → *Show Preview* (Live Preview)
   → http://127.0.0.1:5500/frontend/index.html. Serve from the project root so `../data` and `../shared` load.
2. **AI chat + certificate check:** copy `worker/.dev.vars.example` → `worker/.dev.vars`, paste your Groq and Gemini keys, then
   ```bash
   npm run dev        # wrangler dev → http://127.0.0.1:8787
   ```
   Reload the website — the banner should say "Online".
3. **Tests:** `npm test`

## Deploy

```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```
Put the printed `*.workers.dev` URL into `frontend/config.js` (PROD_API). Deploy the **project root** to Cloudflare Pages
(open `/frontend/`), then set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your Pages URL and redeploy the Worker.

## Adding or changing a scheme

Edit `data/scholarships.json`, then add / update its rule in `RULES` inside `shared/engine.js`, and add a test.
A scheme without a rule always shows as "Maybe".
