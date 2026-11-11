SCHOLARSHIP HUNTER APP

AI agent that finds scholarships for Tamil Nadu college students — free stack (Groq + Gemini + Cloudflare).

## Open in VS Code

1. VS Code → **File → Open Folder…** → select `D:\EDSEEK` (the project root).
2. Read `docs/PROJECT_CONTEXT.md` — it has every decision, the architecture, rules and roadmap.

## Git (work on the `dev` branch)

Git is already set up: `main` = deployed version, `dev` = work in progress.

```bash
# create an empty repo on GitHub (no README), then:
git remote add origin https://github.com/<your-username>/edseek.git
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

## How we work (branches & pull requests)

| Branch | Used for |
|---|---|
| `main` | The live, deployed version. Never edit directly. |
| `dev` | Finished work waiting to go live. |
| feature branch (e.g. `rush`) | One change at a time. Opened as a pull request into `dev`. |

1. Start from the latest `dev`: `git checkout dev` → `git pull`
2. Make a branch: `git checkout -b <branch-name>`
3. Change files → `git add .` → `git commit -m "what changed"` → `git push -u origin <branch-name>`
4. On GitHub: open a **Pull Request** into `dev`. The admin reviews and approves.
5. Merge the pull request, then delete the branch.
6. When `dev` is tested, open a pull request from `dev` into `main` to go live.

## Adding or changing a scheme

Edit `data/scholarships.json`, then add / update its rule in `RULES` inside `shared/engine.js`, and add a test.
A scheme without a rule always shows as "Maybe".
