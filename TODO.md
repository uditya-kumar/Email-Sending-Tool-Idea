# TODO — Backend build order

Design rationale, schema and the `GmailMailer` abstraction: **`BACKEND_PLAN.md`**.
This is the execution order.

**Rule for every phase: it is one commit, it builds, and the app still works.** The frontend keeps
running on `mock-data.ts` until the exact commit that replaces one slice of it — never a big-bang
cutover.

**Locked decisions**
- Scopes: `openid`, `userinfo.email`, `userinfo.profile`, `gmail.send`, `gmail.readonly`
- OAuth consent screen: **published to production, never submitted for verification**
  (in *Testing* mode refresh tokens expire after 7 days and the scheduler dies weekly)
- Target is **fully working locally first**; hosting decided afterwards (EC2 / cheapest always-on)
- No campaign entity — launch is per recipient, matching the frontend
- **TypeScript everywhere, strict**, with generated Supabase types + zod at the trust boundaries
  (see *Type safety* below)

---

## Type safety — the rules

TypeScript alone would not catch what actually breaks this server, because **supabase-js returns
`any` by default**. A typo like `send.thread_id` instead of `send.gmail_thread_id` compiles clean and
silently breaks follow-up threading in production. Two mechanisms close that gap:

**1. Generated DB types (Phase 2).** `Database` is generated from the real schema and passed to
`createClient<Database>`, so every column name, every enum value (`status: 'pending' | 'sent' | …`)
and every insert payload is checked. A schema change that breaks the scheduler then fails at build
time instead of at 3am. Regenerate on **every** `schema.sql` change — treat a stale
`database.types.ts` as a bug.

> ⚠️ **This only works with real Postgres enums.** A `text` column with a
> `check (status in (…))` constraint generates as plain `string`, so `status = 'senting'` would
> compile clean and the row would simply never be claimed by the scheduler — the exact bug the
> generated types exist to prevent. All six status/kind columns are therefore `create type … as
> enum` (`lead_status`, `send_status`, `step_kind`, `event_type`, `account_status`,
> `verification_status`). Consequence to remember: adding a value later means `alter type … add
> value`, which **cannot run inside a transaction block** in older PG and cannot be removed once
> added. Widen a status set deliberately, not casually.

**2. Zod at the boundaries (Phase 0 onwards).** Types are erased at runtime; these three inputs are
genuinely `unknown` and get parsed, not cast:
- `env.ts` — process env, so the server refuses to boot on a missing secret
- Express request bodies — `/api/test-send`, `/launch`, `/cron/tick`
- Gmail API responses — `googleapis` correctly types `response.data.id` as `string | null | undefined`;
  `GmailMailer` throws on missing values rather than passing `undefined` downstream

Everything else is plain TS. Don't zod-parse data that came from your own typed DB client.

**Never `as` your way out.** No `as any`, no non-null `!` on API responses. If a value might be
absent, branch and throw a typed error — the scheduler needs to distinguish "re-auth this account"
from "retry later".

⚠️ **`exactOptionalPropertyTypes: true` changes how you write optional fields.** This is rejected:
```ts
client.setCredentials({ access_token: x ? decrypt(x) : undefined })   // ✗
client.setCredentials({ ...(x && { access_token: decrypt(x) }) })     // ✓
```
It's a good flag — it's why an accidentally-`undefined` `threadId` can't reach the Gmail call — but
every optional field needs conditional-spread form. Know this before Phase 5.

---

## Phase 0 — Server skeleton
*Frontend untouched.*

- [ ] **Align the TypeScript version across packages** — server is `^7.0.2`, frontend is `~6.0.2`.
      `shared/` is compiled by *both*, so a mismatch produces errors that reproduce in one package
      and not the other. Pin both to the same exact version.
- [ ] `server/package.json`: `"type": "module"`; add `nodemailer`, `zod`, `pino`, `pino-pretty`, `cheerio`, `@types/nodemailer`; scripts:
      `dev` = `tsx watch src/index.ts`, `build` = `tsc`, `start` = `node dist/server/src/index.js`,
      **`typecheck` = `tsc --noEmit`**
- [ ] **Replace `server/tsconfig.json`** — it's currently untouched `tsc --init` scaffold with
      `"types": []` (no `process`, no `Buffer`), a stray `jsx: react-jsx`, library-only
      `declaration`/`declarationMap`, and no `include`/`rootDir`/`outDir`:
  ```jsonc
  {
    "compilerOptions": {
      "module": "nodenext", "moduleResolution": "nodenext",
      "target": "es2023", "lib": ["ES2023"],
      "types": ["node"],
      "rootDir": "..", "outDir": "./dist",   // ".." because shared/ compiles too
      "strict": true,
      "noUncheckedIndexedAccess": true,      // already on — keep
      "exactOptionalPropertyTypes": true,    // already on — see the caveat above
      "noImplicitReturns": true,
      "noFallthroughCasesInSwitch": true,
      "noUnusedLocals": true, "noUnusedParameters": true,
      "verbatimModuleSyntax": true, "isolatedModules": true,
      "sourceMap": true, "skipLibCheck": true,
      "paths": { "@shared/*": ["../shared/*"] }
    },
    "include": ["src", "../shared"]
  }
  ```
- [ ] `server/src/env.ts` — **zod-parsed** `process.env`, exported as one frozen `env` object.
      Required: both Supabase vars, all three Google vars, `TOKEN_ENCRYPTION_KEY` (assert 32 bytes
      after base64-decode), `TRACKING_HMAC_SECRET`, `FRONTEND_URL`. This is the **only** file that
      reads `process.env`.
- [ ] `server/src/db.ts` — supabase-js with `SUPABASE_SECRET_KEY`; **untyped for now**, gets its
      `<Database>` generic in Phase 2 once the schema exists
- [ ] `server/src/crypto.ts` — AES-256-GCM `encrypt`/`decrypt` + HMAC `sign`/`verify`
- [ ] `server/src/index.ts` — Express, `cors({ origin: FRONTEND_URL })`, `/healthz`, pino logger
- [ ] `server/.env.example` (see bottom of this file)
- [ ] **Verify:** `npm run typecheck` clean → `npm run dev` → `curl localhost:8080/healthz` = 200;
      delete a required env var and confirm the server **refuses to boot** with the field name in the error

## Phase 1 — `shared/` extraction
*No behaviour change. First, because the server must import the exact renderer the Preview step uses
— otherwise previews lie about what actually gets sent.*

- [ ] Move to `shared/`: `types.ts`, `merge-tags.ts`, `time.ts`, `sequence.ts`, `leads.ts`
- [ ] `frontend/src/lib/*.ts` become one-line re-exports → **zero component import changes**
- [ ] `@shared/*` alias in `frontend/tsconfig.app.json`, `frontend/vite.config.ts`, `server/tsconfig.json`
- [ ] **Verify:** `cd frontend && npm run build` passes; UI visually identical

## Phase 2 — Database ✅ *applied to project `lqetvxapgotsayqrjkan`*
*No frontend change.*

- [x] `supabase/schema.sql` — all 12 tables per `BACKEND_PLAN.md` §4: `gmail_accounts`, `leads`, `templates`, `template_steps`, `sequence_steps`, `attachments`, `step_attachments`, `template_step_attachments`, `sends`, `events`, `settings`, `oauth_states`
- [x] RLS on every table. Note it is **not** uniform `for all`: `sends` and `events` get a
      SELECT-only `read_own` policy (the scheduler and tracking endpoints own the writes, so the
      browser must not be able to forge a send or fake an open), and their INSERT/UPDATE/DELETE
      *grants* are revoked too so the guarantee doesn't rest on the policy alone.
      `gmail_accounts` + `oauth_states` have **no policies at all** — secret key only.
- [x] `gmail_accounts_public` view exposing only `id, email, display_name, daily_limit, status,
      created_at`. `security_invoker = false` is deliberate: the base table denies `authenticated`
      entirely, so the view runs as owner and filters on `auth.uid()` itself. The Supabase linter
      flags this as an ERROR — it is a false positive **here** and only here.
- [x] Private `attachments` Storage bucket (4 MB cap, PDF/DOC/DOCX allowlist) + per-user folder policy
- [x] All six status/kind columns are real Postgres **enums**, not CHECK-constrained text — see the
      *Type safety* warning above for why this is load-bearing
- [x] **Generate DB types** → `shared/database.types.ts` (committed, so builds need no Supabase creds)
- [x] Migrations recorded in `supabase/migrations/` so a fresh project rebuilds identically
- [x] **Verified against the live DB**, not assumed:
      every guard rejects bad input (bad enum → `22P02`; malformed email / `send_time_ist` /
      step shape / inverted jitter / >4 MB attachment / `daily_limit` 9999 → `23514`);
      `authenticated` cannot SELECT `gmail_accounts` or INSERT `sends`/`events`;
      a duplicate `(lead_id, step_position)` is rejected → **no double-send**;
      `claim_due_sends` took 1 of 2 rows (skipped the future one), flipped it to `sending`, and a
      second overlapping call claimed 0; `sent_today_count` went 0 → 1 on the IST day boundary
- [ ] Disable public signups in Supabase Auth — **dashboard only, you must do this**
      (Authentication → Providers → Email → *Enable sign ups* off). This is what enforces "single user".
- [ ] Create your one user in the Supabase dashboard (Authentication → Users → Add user), **then**
      re-run the seed at the bottom of `schema.sql` to create your `settings` row —
      `auth.users` is currently empty, so that insert matched nothing
- [ ] Add an npm script `db:types` so regenerating is one command
- [ ] `server/src/db.ts` → `createClient<Database>(…)` *(needs Phase 0 to exist first)*
- [ ] `frontend/src/lib/supabase.ts` → `createClient<Database>(…)` too
- [ ] Derive row types instead of hand-writing them:
      `type SendRow = Database['public']['Tables']['sends']['Row']`
      (this is where `GmailAccountRow` and `SendRow` from `BACKEND_PLAN.md` §6 come from)

## Phase 3 — Auth gate + mappers
*Mock data still behind it.*

- [ ] Login screen — email magic link is enough; `logout()` (`App.tsx:120`) already handles the rest
- [ ] `server/src/auth/requireUser.ts` — verify the Supabase JWT from the `Authorization` header
- [ ] `frontend/src/lib/mappers.ts` — snake_case ↔ camelCase in exactly one place.
      Type each mapper as `(row: LeadRow) => Lead` — **generated** row type on one side, the existing
      `shared/types.ts` interface on the other. That signature is what makes a schema change surface
      as a compile error in the mapper instead of an `undefined` in the UI.
- [ ] `server/src/http/validate.ts` — small `zod` body-validation middleware (parse → typed handler,
      400 with the failing field path). Reused by every route in Phases 6 and 8.
- [ ] **Verify:** sign in → Database page → sign out

## Phase 4 — Real CRUD, one slice per commit
*Smallest surface first so the mapper layer is proven before the big tables.*

- [ ] `settings` → `SequenceSettings` / `SettingsPage`
- [ ] `leads` → `DatabasePage`, `LeadDialog`, CSV import (reuse `lib/csv.ts`).
      **Zod-validate parsed CSV rows** — PapaParse hands back `any`, and an invalid email or a
      malformed `send_time_ist` reaching `leads` becomes a failed send much later. Reuse
      `isValidIST()` from `shared/time.ts` inside the schema; report rejected rows to the user.
- [ ] `templates` + `template_steps` → `TemplatesPage`
- [ ] `sequence_steps` per lead → `ComposeFlow` (keyed by `lead_id`; every lead owns its own copy)
- [ ] Move `newSequenceForLead`, `stepsFromTemplate`, `newTemplate` into `shared/`, then delete `mock-data.ts`
- [ ] `LeadStatus` gains `sending | replied | failed | cancelled` in `shared/types.ts` + `StatusBadge`
- [ ] **Verify:** create a lead → hard reload → it's still there

## Phase 5 — Google OAuth connect
- [ ] Google Cloud: new project → enable **Gmail API** → consent screen with the 5 scopes → **Publish → In production** (do *not* submit for verification) → Web OAuth client with redirect `http://localhost:8080/api/auth/google/callback`
- [ ] `server/src/auth/google.ts`
  - `GET /api/auth/google` — insert `oauth_states` row, redirect with `access_type=offline&prompt=consent&state=…`
  - `GET /api/auth/google/callback` — verify+delete state, exchange code, `oauth2.userinfo.get()`, upsert `gmail_accounts` with the refresh token **encrypted**, redirect to `FRONTEND_URL/settings?connected=1`
  - `POST /api/accounts/:id/disconnect` — `revokeToken` then delete
- [ ] `server/src/email/index.ts` — `mailerFor(account)` + `forgetAccount(id)`; per-account cached `OAuth2Client` whose `tokens` event persists refreshed access/refresh tokens
- [ ] Wire the "Add account" button (`SettingsPage.tsx:251`) → `${VITE_SERVER_URL}/api/auth/google`
- [ ] Render `status='needs_reauth'` as a Reconnect badge
- [ ] **Verify:** click Connect → consent (click through the unverified-app warning once) → your Gmail shows in Settings with `daily_limit` 15

## Phase 6 — First real email
- [ ] `server/src/email/gmail-mailer.ts` — `GmailMailer` per `BACKEND_PLAN.md` §6
  - `readMessageId()` after every send — **Gmail always overwrites the `Message-ID`**, so Nodemailer's value must never be persisted
  - `GmailAuthError` / `GmailRateLimitError` so the scheduler can branch
  - **No `!` and no `as` on Gmail responses.** `googleapis` types `data.id` / `data.threadId` as
    `string | null | undefined` and that's accurate — branch and throw, so a missing id can never
    reach the `sends` row as `undefined`. This is the third zod/validation boundary.
- [ ] `server/src/tracking/tracking-links.ts` — HMAC-signed pixel + click URLs
- [ ] `server/src/render/email-renderer.ts` — `renderTags` from `@shared/merge-tags`, pixel + `cheerio` link rewrite, both gated on `settings`
- [ ] `POST /api/test-send { stepId, to }` — no cap, no tracking, no scheduler.
      Body via the Phase 3 zod middleware (`stepId` uuid, `to` email) — this endpoint sends real mail
      from a browser-supplied payload, so it's the one that most needs parsing rather than casting.
- [ ] Wire `SendTestPopover.tsx:41`
- [ ] **Verify:** a merge-tagged HTML email with resolved fallbacks lands in your own inbox

## Phase 7 — Resume attachment
*The frontend has no attach UI at all today — this phase adds it.*

- [ ] Attach control on the email step in `ContentStep` → upload to Storage → `attachments` + `step_attachments`
- [ ] Cap uploads at ~4 MB so `raw` never crosses the 5 MB `messages.send` ceiling
- [ ] `server/src/storage/attachment-store.ts` → `fetchForStep()` returns Buffers for MIME
- [ ] **Verify:** test-send arrives with the PDF attached and openable

## Phase 8 — Scheduler (opening email only)
- [ ] `server/src/scheduler/schedule.ts` — `firstSendAt()`, `nextAllowedDay()`
      ⚠️ `Weekday` is 0=Mon…6=Sun but Luxon is 1=Mon…7=Sun; the `-1` is load-bearing. Run with `TZ=UTC`.
- [ ] `server/src/scheduler/send-queue.ts` — `claimDue()` via `FOR UPDATE SKIP LOCKED`, `markSent`, `markFailed`, `reschedule`, `cancelPendingFor`
- [ ] `POST /api/leads/:id/launch` + `POST /api/leads/:id/cancel` — replaces `launchLead()`'s local state; returns the real computed `scheduled_at` for the toast
- [ ] `server/src/scheduler/tick.ts` — refresh tokens → daily cap → claim → weekday gate → stale-send grace → render → send → record → jitter
- [ ] Drive it with `node-cron` `* * * * *` **and** expose `POST /api/cron/tick` behind `CRON_SECRET` (same function — makes the deferred hosting choice a config change, not a rewrite)
- [ ] **Verify:** set a lead's IST time ~2 min out, watch it send and flip to `sent`; kill and restart the server mid-run and confirm no double-send

## Phase 9 — Follow-ups
- [ ] `enqueueNextStep()` — create follow-up N+1 **only after N is actually sent**, so delays are relative to reality and not-yet-sent steps stay editable
- [ ] Threading needs all three or it silently breaks: identical `Subject`, `In-Reply-To`/`References` from the stored `rfc822_message_id`, and `threadId`
- [ ] **Verify:** shrink a wait to 1 day (or minutes temporarily) — follow-up #1 appears **inside the same Gmail thread**

## Phase 10 — Reply detection
- [ ] `server/src/email/reply-watcher.ts` — `threads.get` metadata; any message whose `From` ≠ the account is a reply
- [ ] Runs at the **top** of the tick, before sending — otherwise a reply from 40 seconds ago still gets a follow-up
- [ ] Sets `leads.replied_at` + `status='replied'`, inserts an `events` row, cancels that lead's pending `sends`
- [ ] **Verify:** reply from another account → pending follow-ups become `cancelled`

## Phase 11 — Tracking
- [ ] `GET /t/o/:trackingId.gif` — 1×1 pixel, public, no auth
- [ ] `GET /t/c/:trackingId?u=…&s=…` — HMAC-verified redirect (unsigned = open redirect for spammers)
- [ ] Enable via the existing `trackOpens` / `trackClicks` toggles
- [ ] Filter `GoogleImageProxy` user agents, dedupe opens per `send_id` — opens are noise, clicks and replies are signal
- [ ] Surface events per lead in the UI
- [ ] **Verify:** `cloudflared tunnel --url http://localhost:8080` (Gmail can't fetch a pixel from `localhost`), point `TRACKING_BASE_URL` at it, click a link → an `events` row appears

## Phase 12 — Deploy
*Decide only once Phases 0–11 work locally.*

- [ ] Pick the host. Requirement: **always-on, single instance** (the tracking pixel must answer instantly and the cron must not sleep). EC2 t4g.nano + systemd, Fly.io `min_machines_running=1`, Render Starter, or Railway Hobby with **Serverless off**.
- [ ] If you land on a free tier that sleeps: drop `node-cron` and drive `POST /api/cron/tick` from Supabase `pg_cron` + `pg_net` every minute. Accept a ~1 min late first tick and lost cold-start opens.
- [ ] Frontend static (Vercel / Cloudflare Pages); add the production OAuth redirect URI; `TRACKING_BASE_URL` on a CNAME'd subdomain rather than `*.onrender.com`
- [ ] **Build from compiled output, never `tsx` in production** — `npm run build` then
      `node dist/…`, so a type error can't ship as a running process
- [ ] Regenerate `shared/database.types.ts` against the production project and confirm
      `npm run typecheck` is clean in both packages before the first live send
- [ ] Warm up: 5 → 10 → 15 sends/day over two weeks

---

## `server/.env.example`

```
PORT=8080
NODE_ENV=development
TZ=UTC

SUPABASE_URL=
SUPABASE_SECRET_KEY=              # sb_secret_... — NEVER in the frontend

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8080/api/auth/google/callback

TOKEN_ENCRYPTION_KEY=             # 32 random bytes, base64
TRACKING_HMAC_SECRET=
TRACKING_BASE_URL=http://localhost:8080   # a tunnel URL while testing tracking

FRONTEND_URL=http://localhost:5173
CRON_SECRET=
```

Frontend only ever gets `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SERVER_URL`.

## Reuse, don't rewrite

`shared/merge-tags.ts` (`renderTags`, `tagRegex`, fallback + HTML-escape logic — already correct;
the server imports it rather than reimplementing), `shared/sequence.ts` (`appendFollowUp`,
`duplicateEmailStep`, `removeEmailStep`, `setDelayDays`, `patchStep`, `describeSequence`),
`shared/time.ts` (`istTimeToUtcIso`, `formatIST`, `isValidIST`), `shared/leads.ts` (`fullName`),
`frontend/src/lib/csv.ts`.
