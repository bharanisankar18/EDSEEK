# Scholarship Hunter — Project Context

Everything decided so far, so you (or any coding assistant in VS Code) can continue without the original chat.
Last updated: 9 Nov 2026.

## 1. What we are building

An AI agent that helps Indian college students — starting with **Tamil Nadu students after Class 12 / in college** —
find scholarships they qualify for, check their documents, and never miss a deadline.

**Why it is different from Buddy4Study / NSP:** it does not just list schemes. It
1. asks the student a few questions and builds a profile,
2. decides ✅ Eligible / 🟡 Maybe / ❌ Not eligible for each scheme with a reason,
3. checks uploaded certificates (expired income certificate, name mismatch, missing seal),
4. adds deadlines to the student's calendar,
5. covers Tamil Nadu state schemes that big platforms cover poorly.

## 2. Decisions made

| Topic | Decision |
|---|---|
| Scope (v1) | Tamil Nadu students after Class 12 + all-India central/private schemes they can apply to |
| Interface order | **Website first**, then WhatsApp, then other apps |
| Automation tools | Tried n8n (no access) and Make.com (free plan can't build via MCP, AI provider limits). **Not using them for v1** |
| AI provider | **Not Claude / Claude API.** Use **free** providers: **Groq (Llama 3.3 70B)** for the chat agent, **Google Gemini Flash** (free tier) for document image checks |
| Backend | **Cloudflare Workers** (free, 100k requests/day) — holds API keys, runs the agent + tools |
| Hosting | Cloudflare Pages or GitHub Pages (free) |
| Data | `data/scholarships.json` (25 schemes) — later Google Sheets / Supabase |
| Eligibility | **Rule-based JavaScript engine** decides eligibility; the LLM only explains. The LLM must never invent a scheme, amount or deadline |
| Offline mode | App must still work with no API key: profile form + rule engine |
| Git | Work on a `dev` branch and push that; keep `main` for the deployed version |
| Dev environment | VS Code + Node.js LTS + Git + Wrangler; extensions: Live Preview, Thunder Client/REST Client, Prettier, ESLint |

## 3. Architecture

```
Student (browser: index.html)
   │  chat message / certificate photo
   ▼
Cloudflare Worker  (env: GROQ_API_KEY, GEMINI_API_KEY)
   ├── Groq · Llama 3.3 70B  (OpenAI-compatible, tool calling)
   │      tools: set_profile(fields)        → update student profile
   │             find_scholarships()        → rule engine over scholarships.json
   │             scholarship_details(id)    → full row (documents, links, notes)
   └── Gemini Flash (vision) → certificate check
   ▼
Reply + cards (✅ / 🟡 / ❌, amount, deadline status, documents, official link, "Add to calendar")
```

Local dev: `wrangler dev` → http://localhost:8787 ; website via Live Preview → http://127.0.0.1:5500.
Keys go in `worker/.dev.vars` (never commit it).

## 4. Student profile fields (inputs to the rule engine)

state (TN / other) · level (UG / PG / Diploma / ITI) · year of study (1–5) · course
(Engineering CSE/IT, Engineering core = Civil/Mech/EEE/ECE/Chemical, Engineering other, Medicine, Law, MBA,
Arts & Science, Other) · gender · community (SC, ST, SCC, BC, MBC, DNC, OC/General) · family income (₹ lakh/yr) ·
Class 12 % · above 80th percentile of board (yes/no) · studied Class 6–12 in TN Government school ·
first graduate · admission quota (Government counselling / 7.5% govt-school / Management) ·
college type (Government / Aided / Self-financing) · hostel (college hostel) · disability ≥40% ·
hardship (orphan / parent lost / parent critically ill) · Tamil-medium course.

Unknown values → "Maybe" (never assume).

## 5. Key eligibility rules (summary — full detail in the dataset)

| id | Core rule |
|---|---|
| tn-first-graduate | TN, Engineering via TNEA counselling, first graduate in family (one child per family) |
| tn-75-govt-school-quota | TN Govt school Class 6–12, admitted under 7.5% quota — full fees paid |
| tn-cm-prf-be | TN, B.E/B.Tech, economically weaker — income limit not published (always "Maybe") |
| tn-pg-assistantship | TN, M.E/M.Tech non-GATE, Government Engineering College |
| tn-postmatric-scst | TN, SC/ST/SCC, income ≤ ₹2.5 L |
| tn-postmatric-bc-mbc-dnc | TN, BC/MBC/DNC, income ≤ ₹2 L (some sources ₹2.5 L → Maybe between 2–2.5) |
| tn-pudhumai-penn | TN girl, Govt school Class 6–12, UG/Diploma/ITI — ₹1,000/month, no income limit |
| tn-tamil-pudhalvan | TN boy, Govt / Govt-aided Tamil-medium school Class 6–12 — ₹1,000/month |
| tn-hes-scst-hostellers | TN, SC/ST/SCC, income ≤ ₹2.5 L, staying in college hostel |
| tn-differently-abled | TN, disability ≥ 40% |
| tn-evr-nagammai | TN girl, Arts & Science, Govt/Aided college, very low income (₹24k official / ₹50k aggregator — conflict) |
| tn-tamil-medium-stipend | TN, Tamil-medium Arts & Science classes |
| in-csss | Above 80th percentile in Class 12, income ≤ ₹4.5 L, regular degree, no other scholarship |
| in-aicte-pragati | Girl, AICTE technical course, 1st year (or lateral 2nd), income ≤ ₹8 L |
| in-aicte-saksham | Disability ≥ 40%, AICTE technical, 1st year/lateral, income ≤ ₹8 L |
| in-aicte-swanath | Orphan / COVID loss / martyr's ward / parent critically ill, AICTE technical, income ≤ ₹8 L |
| in-aicte-yashasvi | Core engineering branches only (not CSE/IT), 1st year/lateral, income ≤ ₹8 L (verify) |
| pvt-ongc-merit | 1st year Engg/MBBS/MBA/MSc Geo, ≥60%, SC/ST < ₹4.5 L, OBC/Gen-EWS < ₹2 L, age ≤ 30 |
| pvt-ffe | 1st year BE/MBBS/LLB, 12th ≥ 70%, income ≤ ₹3 L (one source ₹4 L) |
| pvt-sitaram-jindal | Class 11 to PG, income ≤ ₹4 L salaried / ≤ ₹2.5 L others, rolling |
| pvt-reliance-ug | 1st year UG any stream, 12th ≥ 60%, income < ₹15 L, aptitude test |
| pvt-kotak-kanya | Girl, 1st year professional UG, 12th ≥ 75%, income < ₹6 L — ₹1.5 L/yr |
| pvt-lic-gjf | 1st year UG/Diploma/ITI, ≥60%, income ≤ ₹4.5 L (one source ₹2.5 L) |
| pvt-tata-pankh | 11–12/UG/Diploma/ITI, ≥60%, income ≤ ₹4 L (some say ₹2.5 L) |
| pvt-hdfc-ecss | Family facing a crisis — need-based (always "Maybe") |

Status is computed from `deadline_iso` vs today: Open / Closed for this cycle / Rolling / At admission.

## 6. Data notes and things to verify

- Dataset: `data/scholarships_v2.csv` and `data/scholarships.json` (37 fields per scheme, incl. `agent_summary`).
- Rows whose `notes` say **VERIFY** or **CONFLICT** must be confirmed on the official site before a demo.
- Official links still missing: ONGC, FFE, HDFC ECSS, TN differently-abled scholarship.
- Most deadlines come from aggregator sites, not official notices.
- NSP / AICTE schemes closed 31 Oct 2026 for 2026-27; they reopen around June — use as a "remind me" demo.

## 7. Agent instructions (system prompt for the LLM)

```
You are Scholarship Hunter, an assistant that helps Indian college students (starting with Tamil Nadu)
find scholarships they qualify for.
1. Build the student's profile first: state, course and year, gender, community, family income,
   Class 12 %, government school (Class 6-12), first graduate, quota, college type, hostel, disability,
   hardship. Ask at most 2 questions at a time. Save answers with set_profile. If unknown, continue.
2. ALWAYS call find_scholarships to decide eligibility. Never invent a scholarship, amount, deadline or rule.
3. Show open + eligible first. For each: name, amount, one-line reason, deadline status, documents,
   official link. Say "Maybe" items need which detail.
4. If notes say VERIFY or CONFLICT, tell the student to confirm on the official site.
5. Short, friendly, phone-sized replies. Reply in Tamil if the student writes in Tamil.
```

## 8. Roadmap

1. **v1 website** — index.html + Worker (Groq agent + rule engine + Gemini doc check) + JSON data. Offline mode.
2. **Deploy** — Cloudflare Pages + Worker, share link, test with 10–20 PSG iTech students.
3. **WhatsApp** — Meta WhatsApp Cloud API (free test number, up to 5 recipients) → same Worker.
4. **Reminders** — scheduled job (Cloudflare Cron Trigger or self-hosted n8n via Docker) → WhatsApp/email.
5. **Scale data** — more states, college/alumni scholarships, scraping + verification workflow.

## 9. Free accounts needed

- Groq API key — console.groq.com (free tier, no card)
- Gemini API key — aistudio.google.com (free tier; prompts may be used by Google to improve models)
- Cloudflare account (Workers + Pages) and/or GitHub account
