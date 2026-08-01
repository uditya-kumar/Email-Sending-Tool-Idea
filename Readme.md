<div align="center">

<h1>📬 Cold Email Outreach Tool</h1>

<p><b>A single-user cold-outreach tool that sends from your own Gmail.</b><br/>
Per-recipient IST send times, merge tags with fallbacks, follow-ups that stop on reply,<br/>
open &amp; click tracking, and a daily cap with jitter to protect deliverability.</p>

<p>
<img alt="React" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white" />
<img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" />
<img alt="Supabase" src="https://img.shields.io/badge/Supabase-RLS-3FCF8E?logo=supabase&logoColor=white" />
<img alt="Express" src="https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white" />
<img alt="Gmail API" src="https://img.shields.io/badge/Gmail%20API-OAuth2-EA4335?logo=gmail&logoColor=white" />
</p>

</div>

---

## Features

| | Feature | What it does |
|---|---|---|
| 🗂️ | **Leads database** | Editable grid — company, contact, email, personalization line, per-lead IST send time. CSV import with per-row validation and duplicate skipping. |
| ✍️ | **Template + merge tags** | Tiptap rich-text editor. `{{first_name}}`, `{{company}}`, `{{personalization}}` with fallbacks (`{{job_title:"leader"}}`). HTML-escaped. |
| 👁️ | **Live preview & test send** | Preview renders through the *same* renderer the server sends with, so a preview can't lie. Test sends skip the queue, the cap and tracking. |
| ⏰ | **Per-recipient IST scheduling** | Each lead has its own IST minute, converted to UTC and dispatched when due. Allowed-weekday gates for opens and follow-ups. |
| 🔁 | **Follow-up sequence** | Ordered email/wait steps. Step *N+1* is only queued once *N* actually sends. Follow-ups land **in the same Gmail thread**. |
| 🛑 | **Reply detection** | Checked at the top of every tick — a reply cancels every pending follow-up for that lead, even one scheduled minutes away. |
| 📈 | **Open + click tracking** | 1×1 pixel + HMAC-signed click redirects. Opens deduped and proxy-filtered; clicks and replies are the trustworthy signals. |
| 📮 | **Gmail sending + daily cap** | Sends via the Gmail API as you, with a configurable daily limit and random jitter between sends. |

---

## Tech stack

### Frontend

| | Tech | Used for |
|---|---|---|
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/react/react-original.svg" width="18"/> | **React 19 + Vite** | SPA, React Compiler enabled |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/typescript/typescript-original.svg" width="18"/> | **TypeScript** | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/tailwindcss/tailwindcss-original.svg" width="18"/> | **Tailwind v4 + shadcn/ui** | Styling and components |
| <img src="https://avatars.githubusercontent.com/u/72518640?s=48" width="18"/> | **TanStack Table** | Editable leads grid |
| <img src="https://avatars.githubusercontent.com/u/64354658?s=48" width="18"/> | **Tiptap** | Rich-text email editor with merge-tag highlighting |
| 🕒 | **Luxon** | IST ↔ UTC conversion |
| 📄 | **PapaParse** | CSV import / export |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/supabase/supabase-original.svg" width="18"/> | **supabase-js** | Direct DB access, guarded by RLS |

### Backend

| | Tech | Used for |
|---|---|---|
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/express/express-original.svg" width="18"/> | **Express 5 + TypeScript** | Tiny service: send, schedule, track, detect replies |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/google/google-original.svg" width="18"/> | **googleapis + OAuth2** | Gmail send &amp; read (`gmail.send`, `gmail.readonly`) |
| ✉️ | **Nodemailer** | MIME builder only — output goes to Gmail `raw` |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/nodejs/nodejs-original.svg" width="18"/> | **node-cron** | One-minute poll loop over due sends |
| 🛡️ | **Zod** | Parses env, request bodies and Gmail responses |
| 🌿 | **Cheerio** | Link rewriting for click tracking |
| 🪵 | **Pino** | Logging, with every token path redacted |

### Data

| | Tech | Used for |
|---|---|---|
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/postgresql/postgresql-original.svg" width="18"/> | **Supabase Postgres** | 12 tables, real PG enums, **no ORM** |
| 🔐 | **Supabase Auth + RLS** | Single user; `sends`/`events` are read-only to the browser |
| 🗄️ | **Supabase Storage** | Private attachments bucket (4 MB cap, PDF/DOC allowlist) |

---

## Architecture

The browser talks to Postgres directly. The server exists only for what a browser *cannot* do.

```
frontend/   React + Vite  ──────────────► Supabase (RLS, publishable key)
                │
                └── 4 calls ──►  server/   Express (secret key, service-role)
                                   ├─ Gmail OAuth + sending
                                   ├─ Scheduler (node-cron, 1 min tick)
                                   ├─ Public tracking endpoints
                                   └─ Reply detection
shared/     types, merge-tag renderer, IST math, sequence rules, DB types
supabase/   schema.sql + migrations
```

**Why `shared/`:** the preview and the real send must use one renderer, one IST conversion and one
follow-up rule. Both packages compile it; neither owns a copy.

### API surface

| Method | Route | |
|---|---|---|
| `GET` | `/healthz` | liveness |
| `GET` | `/api/auth/google` · `/google/callback` | OAuth consent + token exchange |
| `GET` `POST` | `/api/accounts` · `/api/accounts/:id/disconnect` | connected senders |
| `POST` | `/api/leads/:id/launch` · `/cancel` | queue / unqueue a lead |
| `GET` | `/api/leads/:id/sends` | per-lead queue state |
| `POST` | `/api/test-send` | real email, no cap, no tracking, no queue row |
| `POST` | `/api/cron/tick` | external scheduler trigger (`CRON_SECRET`) |
| `GET` | `/t/o/:id` · `/t/c/:id` | open pixel · signed click redirect (public) |

---

## Getting started

**Prereqs:** Node 20+, a Supabase project, a Google Cloud project with the Gmail API enabled.

```bash
# 1. Database
#    Run supabase/schema.sql in the Supabase SQL editor.
#    Auth → Providers → Email → disable sign-ups, then add your one user
#    (with Auto Confirm), and re-run the seed insert at the bottom of schema.sql.

# 2. Server
cd server && npm install
cp .env.example .env      # then fill it in — every field is documented inline
npm run dev               # http://localhost:8080

# 3. Frontend
cd frontend && npm install
cp .env.example .env      # VITE_SUPABASE_URL / _PUBLISHABLE_KEY / VITE_SERVER_URL
npm run dev               # http://localhost:5173

# 4. Sign in → Settings → Connect Gmail → click through the unverified-app warning.
```

Then: add a lead → open Compose → write the sequence → **Send test** → **Launch**.

### Scripts

| | |
|---|---|
| `npm run dev` | watch mode (`tsx` / Vite) |
| `npm run build` | `tsc` / `tsc -b && vite build` — **deploy compiled output, never `tsx`** |
| `npm run typecheck` | must be clean in both packages before a live send |
| `npm run db:types` | regenerate `shared/database.types.ts` after any schema change |

---

## Operational notes

- **Secrets never reach the browser.** The Google client secret, the encrypted refresh token and the
  Supabase secret key live only in `server/.env`. The frontend gets the publishable key.
- **OAuth consent must be "In production"** (unverified is fine). In *Testing* mode refresh tokens
  expire after 7 days and the scheduler dies weekly.
- **Keep volume low.** Gmail allows ~500/day, but cold-outreach deliverability degrades long before
  that. Warm up 5 → 10 → 15 per day.
- **`claim_due_sends` uses `FOR UPDATE SKIP LOCKED`**, so two schedulers racing the same minute still
  produce exactly one email.
- **Open tracking is unreliable** — Apple Mail and Gmail's proxy pre-load pixels. Trust clicks and
  replies.
- **Hosting must be always-on, single instance:** the pixel answers instantly and the cron must not
  sleep. If the host sleeps, drop `node-cron` and drive `POST /api/cron/tick` from Supabase `pg_cron`.

---

## Status

Working end to end against a live project and a real inbox: login, CRUD, Gmail connect, test send,
scheduled delivery on its own IST minute, same-thread follow-ups verified against Gmail's own headers,
and a real reply cancelling a pending follow-up.

**Open:** the attachment upload UI, per-lead event display, and exercising tracking through a public
tunnel. See [TODO.md](TODO.md) for the phase-by-phase record and [BACKEND_PLAN.md](BACKEND_PLAN.md)
for the design rationale.
