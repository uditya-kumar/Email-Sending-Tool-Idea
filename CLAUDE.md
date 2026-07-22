# CLAUDE.md — Cold Email Outreach Tool

## What this is
An **internal, single-user** cold-email / outreach tool. One user (the owner), one connected
Gmail account. **No multi-tenant, no billing, no public signups.** Goal: quick idea → production
**without over-engineering**. Inspired by Hunter.io Campaigns.

## Features (all 6 required)
1. **Leads table** — editable grid with columns: Company Name, Contact Person Full Name, Email
   Address, Personalization Line, Sending Time (IST). CSV import supported.
2. **Email template with merge tags + preview** — rich-text template with attribute/merge tags
   (e.g. `{{first_name}}`, `{{company}}`, `{{personalization}}`) supporting **fallback values**.
   Live preview rendered per lead.
3. **Open + click tracking** — 1x1 pixel for opens, link-rewrite redirect for clicks. Logged as events.
4. **Follow-up sequence on no-reply** — ordered steps with delays; a follow-up only fires if no
   reply has been detected on the thread.
5. **Per-recipient send time in IST** — each lead has its own IST send time; converted to UTC and
   dispatched when due.
6. **Gmail sending + daily cap** — send through the user's own Gmail via Gmail API (OAuth2), with a
   configurable **daily send cap** and **random jitter** between sends to protect deliverability.

## Architecture
- **Frontend talks directly to Supabase** (supabase-js) for all CRUD, protected by **RLS**.
- A **tiny Express service** handles ONLY the work that cannot live in the browser:
  1. Gmail sending (holds Google client secret + refresh token)
  2. The scheduler / send loop (node-cron)
  3. Public tracking endpoints (`/t/open/:id`, `/t/click/:id`)
  4. Gmail reply detection (before firing follow-ups)
- **No ORM.** Supabase (hosted Postgres) is the database; supabase-js is the only data client.

```
frontend/  → React + Vite (talks to Supabase directly, RLS)
server/    → Express (Gmail send, scheduler, tracking, reply detection; supabase-js service-role)
supabase/  → schema.sql (tables + RLS policies)
```

## Locked stack

### Frontend
| Concern | Choice |
|---|---|
| Framework/build | React + Vite + TypeScript |
| Styling / UI | Tailwind CSS + shadcn/ui |
| Lead data grid | TanStack Table (editable) |
| Read-only lists | shadcn `<Table>` |
| Rich text template editor | **Tiptap** |
| Merge-tag rendering | Handlebars (`{{tag}}` + fallback) |
| Date/timezone (IST) | Luxon |
| CSV import | PapaParse |
| DB access | supabase-js (direct, RLS-protected) |

### Backend (tiny Express service)
| Concern | Choice |
|---|---|
| Server framework | Express + TypeScript |
| Gmail sending | googleapis + OAuth2 (Gmail API) |
| Scheduler | node-cron (poll DB for due sends) |
| DB access | supabase-js (service-role key, server-side only) |
| Date/timezone | Luxon (IST → UTC) |

### Data / infra
| Concern | Choice |
|---|---|
| Database | Supabase (hosted Postgres) — **no ORM** |
| Auth / row security | Supabase Auth + RLS |
| Gmail auth | Google Cloud OAuth client (Gmail API enabled) |
| Hosting | Express + cron on Railway/Render; frontend static; Supabase managed |

## Planned Supabase tables
- `leads` — company_name, contact_name, email, personalization_line, send_time_ist, ...
- `templates` — subject, body_html (Tiptap output), ...
- `sequence_steps` — template_id, step_order, delay, ...
- `sends` — one row per outbound email: lead_id, template_id, status, send_at (UTC), thread_id, ...
- `events` — send_id, type (open|click|reply), url (for clicks), created_at

## Important constraints & gotchas
- **Secrets never in the frontend.** Google client secret, refresh token, and the Supabase
  **secret key** (`sb_secret_...`) live only in the Express server env. The frontend uses only the
  **publishable key** (`sb_publishable_...`).
- **Supabase key naming**: this project uses the new API keys — publishable key (frontend, replaces
  anon) and secret key (server, replaces service_role). Env vars: `VITE_SUPABASE_PUBLISHABLE_KEY`
  (frontend), `SUPABASE_SECRET_KEY` (server).
- **Open tracking is unreliable** (Apple Mail Privacy Protection pre-loads pixels). Treat **clicks
  and replies** as the trustworthy engagement signals.
- **Gmail limits**: ~500 recipients/day (personal), ~2000 (Workspace). For cold outreach keep volume
  low (20–50/day) with jitter — deliverability degrades long before the hard cap.
- **Follow-ups go in the same thread** (set `threadId` + `References`/`In-Reply-To`) so they look natural.
- Don't over-engineer: node-cron poll loop is intentional over BullMQ+Redis for a single user.
