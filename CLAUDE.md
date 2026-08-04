# CLAUDE.md — Cold Email Outreach Tool

## What this is
An **internal, single-user** cold-email / outreach tool. One user (the owner), one connected
Gmail account. **No multi-tenant, no billing, no public signups.** Goal: quick idea → production
**without over-engineering**. Inspired by Hunter.io Campaigns.

## Features (all 6 required — all built)
1. **Leads table** — editable grid. Actual columns: Email, First/Last name, Company, Personalization
   Line, Job Title, Website, Send time (IST), Status, Opens/clicks. CSV import supported.
2. **Email template with merge tags + preview** — rich-text template with attribute/merge tags
   supporting **fallback values**, Hunter-style: `{{key:"fallback"}}` or `{{key}}` — e.g.
   `{{first_name:"there"}}`. Live preview rendered per lead.
3. **Open + click tracking** — 1x1 GIF pixel for opens, signed link-rewrite redirect for clicks.
   Logged as events; read back through the `lead_engagement` view.
4. **Follow-up sequence on no-reply** — ordered steps with `wait_days`; a follow-up only fires if no
   reply has been detected on the thread.
5. **Per-recipient send time in IST** — each lead has its own IST send time; converted to UTC and
   dispatched when due.
6. **Gmail sending + daily cap** — send through the user's own Gmail via Gmail API (OAuth2), with a
   per-account **daily cap** (`gmail_accounts.daily_limit`) split between follow-ups and new outreach
   (`follow_up_share_pct`, see `shared/send-budget.ts`), plus **random jitter** between sends.

## Architecture
- **Frontend talks directly to Supabase** (supabase-js) for ordinary CRUD — leads, templates,
  sequence steps, settings — protected by **RLS**. It does *not* go through Express for those.
- A **tiny Express service** handles ONLY the work that cannot live in the browser:
  1. Gmail sending (holds Google client secret + refresh token)
  2. The scheduler / send loop (node-cron, once a minute; `SCHEDULER_ENABLED`)
  3. Public tracking endpoints — `GET /t/o/:trackingId.gif` (open) and
     `GET /t/c/:trackingId?u=…&s=…` (click, **HMAC-signed**; an unsigned link 400s rather than
     redirecting, because an open redirect on the sending domain is what gets it blocklisted)
  4. Gmail reply detection (before firing follow-ups)
  5. State transitions that must not be client-trusted: `POST /api/leads/:id/launch`, `/cancel`,
     `/resync-schedule`, `POST /api/test-send`, Google OAuth (`/api/auth`), account management
     (`/api/accounts`), and `/api/cron` (manual tick, guarded by `CRON_SECRET`)
- **No ORM.** Supabase (hosted Postgres) is the database; supabase-js is the only data client.

```
frontend/  → React + Vite (Supabase direct for reads/CRUD, Express for the actions above)
server/    → Express (Gmail send, scheduler, tracking, reply detection; supabase-js secret key)
shared/    → code BOTH sides must agree on (see below)
supabase/  → schema.sql (source of truth) + migrations/
```

**`shared/` is load-bearing, not a convenience.** The preview and the real send must use one
renderer, one IST conversion and one set of sequence rules — a second implementation on the server
would let the preview lie about what actually gets sent. Holds: `types.ts`, `merge-tags.ts`,
`time.ts`, `schedule.ts`, `sequence.ts`, `send-budget.ts`, `attachments.ts`, `mappers.ts`,
`settings.ts`, `leads.ts`, and generated `database.types.ts` (`npm run db:types` in `server/`).

## Locked stack

### Frontend
| Concern | Choice |
|---|---|
| Framework/build | React + Vite + TypeScript |
| Styling / UI | Tailwind CSS + shadcn/ui |
| Lead data grid | TanStack Table (editable) |
| Read-only lists | shadcn `<Table>` |
| Rich text template editor | **Tiptap** |
| Merge-tag rendering | **`shared/merge-tags.ts`** — a hand-written parser, *not* Handlebars |
| Date/timezone (IST) | Luxon |
| CSV import | PapaParse (+ Zod for row validation) |
| DB access | supabase-js (direct, RLS-protected) + `lib/api.ts` for server actions |
| Toasts | sonner |

> **Note:** `handlebars` is still in `frontend/package.json` but is imported nowhere. Merge tags are
> rendered by `shared/merge-tags.ts` so that preview and send cannot diverge — Handlebars couldn't
> live in `shared/` without the server taking the dependency too. Safe to uninstall.

### Backend (tiny Express service)
| Concern | Choice |
|---|---|
| Server framework | Express 5 + TypeScript |
| Gmail sending | googleapis + OAuth2 (Gmail API); **nodemailer builds the MIME**, it does not send |
| Scheduler | node-cron (poll DB for due sends, once a minute) |
| DB access | supabase-js (secret key, server-side only) |
| Date/timezone | Luxon (IST → UTC) |
| HTML rewriting | cheerio (inject pixel + rewrite links in Tiptap output) |
| Logging | pino |
| Validation | Zod (env + request schemas) |
| Tests | `node:test` via tsx — `npm test` in `server/` |

### Data / infra
| Concern | Choice |
|---|---|
| Database | Supabase (hosted Postgres) — **no ORM** |
| Auth / row security | Supabase Auth + RLS |
| Gmail auth | Google Cloud OAuth client (Gmail API enabled) |
| Hosting | **Frontend on Vercel** (`frontend/vercel.json`); **Express + cron on EC2**; Supabase managed |
| Public hostnames | `api.udityakumar.dev` (API) and `track.udityakumar.dev` (pixel/links) — one Caddy, one `localhost:8080`, two site blocks, Let's Encrypt certs |
| Local tunnel for tracking | **cloudflared** — ngrok's free interstitial blocks Gmail's image proxy |

## Supabase schema (built — 12 tables, 2 views)
`supabase/schema.sql` is the re-runnable source of truth; `supabase/migrations/` holds the applied
deltas. Keep both in step — a migration applied without updating `schema.sql` silently breaks a
rebuild from scratch.

- `leads` — company_name, first_name, last_name, email, personalization_line, send_time_ist,
  job_title, website, verification, status, replied_at
- `templates` — just `name` + timestamps; the content lives in `template_steps`
- `template_steps` — template_id, position, kind, name, subject, body_html, wait_days
- `sequence_steps` — **per-lead**, keyed on `lead_id` (not `template_id`): position, kind, name,
  subject, body_html, wait_days. A template is *copied* onto a lead, so editing a template never
  rewrites a sequence already in flight.
- `sends` — one row per outbound email: lead_id, step_id, step_position, is_follow_up, status,
  scheduled_at, claimed_at, sent_at, subject/body rendered, gmail_message_id, gmail_thread_id,
  rfc822_message_id, tracking_id, attempt_count, last_error
- `events` — send_id, type (open|click|reply), url, user_agent, ip, created_at
- `gmail_accounts` — encrypted refresh/access tokens, daily_limit, follow_up_share_pct, status
  (plus the `gmail_accounts_public` view, which omits the token columns)
- `settings` — track_opens, track_clicks, outreach_days, follow_up_days, jitter min/max,
  stale_send_grace_hours. **PK is `user_id`**, one row per user.
- `attachments`, `step_attachments`, `template_step_attachments` — files + their join tables
- `oauth_states` — short-lived CSRF states for the Google OAuth handshake

**`lead_engagement` (view)** — the only correct way to read open/click counts. `open_count` counts
**thread reads, not pixel fetches**: opening a thread makes the client fetch the pixel of *every*
message in it, so a raw `count(*)` scaled with sequence length. The view groups a lead's opens into
reads on a 10-second gap. Never "simplify" that away, and never widen the per-send guard in
`recordOpen` expecting it to replace it (the sibling fetches are concurrent — a read-then-insert
check races).

## Important constraints & gotchas
- **Secrets never in the frontend.** Google client secret, refresh token, and the Supabase
  **secret key** (`sb_secret_...`) live only in the Express server env. The frontend uses only the
  **publishable key** (`sb_publishable_...`).
- **Supabase key naming**: this project uses the new API keys — publishable key (frontend, replaces
  anon) and secret key (server, replaces service_role). Env vars: `VITE_SUPABASE_PUBLISHABLE_KEY`
  (frontend), `SUPABASE_SECRET_KEY` (server).
- **Open tracking is unreliable** (Apple Mail Privacy Protection pre-loads pixels). Treat **clicks
  and replies** as the trustworthy engagement signals.
- **Never filter `GoogleImageProxy` out of open tracking.** Gmail proxies *real* opens through it
  too, so treating it as a bot zeroes out every Gmail recipient. Trust repeat opens, not the UA.
- **Dedupe opens on elapsed time, never a clock bucket.** A `date_trunc('minute')` bucket is
  arbitrary in both directions — fetches 2s apart either side of `:00` counted twice, 49s apart
  inside one minute counted once.
- **The tracking domain must be one we own.** `TRACKING_BASE_URL` is
  `https://track.udityakumar.dev`, not a free dynamic-DNS host. This was migrated off
  `duckdns.org` for three reasons, all of which bite: it's a shared parent domain heavily abused
  for phishing (Spamhaus DBL wildcards list at the *main-domain* level, so subdomains inherit),
  a `@gmail.com` From with links on an unrelated domain is the exact shape of phishing, and
  network DNS filters block it outright — FortiGuard resolves it to a block page with a
  self-signed cert, which surfaces as `ERR_CERT_AUTHORITY_INVALID` on API calls and as an
  unreachable link for the recipient. Never "simplify" this back to a free host.
- **Changing `TRACKING_BASE_URL` is one-way** once mail is out: sent messages carry the old origin
  in their pixel and links forever. Migrating requires keeping a Caddy site block for the old
  hostname pointed at the same backend, or past recipients' clicks 404.
- **Gmail limits**: ~500 recipients/day (personal), ~2000 (Workspace). For cold outreach keep volume
  low (20–50/day) with jitter — deliverability degrades long before the hard cap.
- **Follow-ups go in the same thread** (set `threadId` + `References`/`In-Reply-To`) so they look natural.
- **Attachments cap at 3.5 MB** (`MAX_ATTACHMENT_BYTES` in `shared/attachments.ts`) — base64 inflates
  by ~33%, so `GmailMailer`'s 5,000,000-char `MAX_RAW_LENGTH` puts the true ceiling near 3.75 MB.
  Validate against the shared constant, never against the raw bucket size.
- **PostgREST needs a WHERE clause**: an unfiltered `.update()`/`.delete()` 400s with `21000` before
  RLS even runs. Bites `settings`, whose PK is `user_id` rather than `id`.
- **Sends match steps by position.** `sends.step_id` is nulled when a step is deleted, so a shortened
  `sequence_steps` list can silently hide already-delivered emails — hence `step_position`.
- **Queued sends are snapshots**: `scheduled_at` is frozen at enqueue time. Follow-ups queue one at a
  time, so only one unsent step has a real `scheduled_at`; everything later is a *projection* and
  should be shown as one.
- **Deleting a lead is destructive and unrecoverable.** `sends` cascades from `leads` and `events`
  cascades from `sends`, so removing a lead destroys its entire send history and every open/click
  ever recorded. There is no soft-delete.
- **`POST /api/test-send` re-reads the step row** and ignores request-body content, so the UI must
  flush pending edits before calling it.
- Don't over-engineer: node-cron poll loop is intentional over BullMQ+Redis for a single user.

## Local dev gotchas
- **Stopping `npm run dev` may not stop the server.** It kills the wrapper, not the `tsx` child — a
  stale scheduler keeps running and **keeps sending real email**. Verify with
  `netstat -ano | grep ":<port>"` and `taskkill //F //PID <pid>`.
- **Sending days are widened for testing.** `outreach_days` / `follow_up_days` are currently Mon–Sun
  on purpose. **Restore Mon–Thu before production.**
- `frontend` has no `typecheck` script — use `npm run build` (`tsc -b && vite build`). `server` does.
- `npx eslint src` in `frontend` reports **7 pre-existing problems** (6 errors, 1 warning) in files
  like `ui/tabs.tsx`. That's the baseline, not something you introduced.
