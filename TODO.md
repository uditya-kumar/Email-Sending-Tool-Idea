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

## Where this stands

**`server/` is complete** — every file in `BACKEND_PLAN.md` §5 exists, `npm run typecheck` and
`npm run build` are clean, and the compiled output boots and serves. What's verified by actually
running it, versus what still needs a real Gmail account, is marked per phase below.

Verified end to end against the running server: `/healthz`, the open pixel, the signed click redirect
and its five refusal paths, the cron secret, unauthenticated `/api/*` → 401, unknown route → 404 JSON,
CORS, the IST scheduling math (12 cases), the merge-tag renderer, and the crypto round-trip.

**Setup is done** (all by hand, confirmed): public signups disabled, one confirmed user in
`auth.users`, its `settings` row seeded, both `.env` files written, and the Google Cloud project set up
with the Gmail API enabled, 5 scopes, an **In production** consent screen and a Web OAuth client.
The server boots with 15 env vars and answers `/healthz`.

**Phase 3 is done** — login works against the live project.

**A real email has been sent.** Google OAuth consent completed, `mailuditya@gmail.com` connected
with all 5 scopes and an encrypted refresh token, and `POST /api/test-send` delivered a `[TEST]`
email to a real inbox with both merge tags correctly falling back (no lead on the Templates page).
Confirmed in the database afterwards: `sends: 0`, `events: 0` — a test send stays out of the
scheduler, consumes no daily cap and creates no queue row, exactly as intended.

That retires the project's biggest risk: **the send path is proven before anything else is built on
top of it.** Two things it forced, both now done:

- **Templates persist** (`lib/templates.ts`, `lib/use-templates.ts`). Not scope creep —
  `/api/test-send` re-reads the step from Postgres and ignores content in the request body, so a
  test send needs a real `template_steps` UUID, and unsaved editor text would be silently absent
  from the email. Hence `flush()` before every send.
- **Senders are real** (`lib/accounts.ts`, via the `gmail_accounts_public` view). `MOCK_SENDERS` and
  `MOCK_TEMPLATES` are gone; `mock-data.ts` is down to `MOCK_LEADS` and `DEFAULT_SETTINGS`.

What's left:

1. **Phase 4: the remaining CRUD** — `settings` → `leads` (+ CSV import) → per-lead
   `sequence_steps`, then delete `mock-data.ts`. This is the bulk of the remaining work.
2. **Launch / cancel and the attach control** — the two server calls still unwired
   (`BACKEND_PLAN.md` §10). Connect and `SendTestPopover` are done.
3. **Still unproven, and only provable by a real campaign**: that a follow-up lands in the *same
   thread*, and that a reply cancels the pending ones. Needs Phase 4's `sequence_steps` plus a
   launch, since both are scheduler behaviour rather than test-send behaviour.

**Known gap, low priority:** nothing prunes abandoned `oauth_states` rows. A row is burned on a
successful callback and an expired one is refused, so this is unbounded growth rather than a
security hole — but an abandoned consent leaves a row forever. Worth a `delete from oauth_states
where expires_at < now()` in the existing cron tick.

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

## Phase 0 — Server skeleton ✅
*Frontend untouched.*

- [x] **Align the TypeScript version across packages** — both pinned to `6.0.3`.
      `shared/` is compiled by *both*, so a mismatch produces errors that reproduce in one package
      and not the other.
- [x] `server/package.json`: `"type": "module"`; add `nodemailer`, `zod`, `pino`, `pino-pretty`, `cheerio`, `@types/nodemailer`; scripts:
      `dev` = `tsx watch src/index.ts`, `build` = `tsc`, `start` = `node dist/server/src/index.js`,
      **`typecheck` = `tsc --noEmit`**.
      Also needed an `overrides` pin on `google-auth-library@10.5.0`: `googleapis` and its own
      `googleapis-common` request different ranges, npm installs **two** copies, and `OAuth2Client`
      has private fields — so structural matching doesn't apply and passing our client to
      `google.gmail({ auth })` is a type error until the duplicate is collapsed.
- [x] **Replace `server/tsconfig.json`** — it was untouched `tsc --init` scaffold with
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
- [x] `server/src/env.ts` — **zod-parsed** `process.env`, exported as one frozen `env` object.
      Required: both Supabase vars, all three Google vars, `TOKEN_ENCRYPTION_KEY` (assert 32 bytes
      after base64-decode), `TRACKING_HMAC_SECRET`, `FRONTEND_URL`. This is the **only** file that
      reads `process.env`.
      Gotcha found while wiring `.env.example`: dotenv turns a bare `CRON_SECRET=` into `""`, which
      is *present* as far as zod is concerned — so `.optional()` doesn't apply and `.min(16)` fails.
      A freshly copied template refused to boot on exactly the fields you were right to leave blank.
      Blank values are therefore stripped before parsing.
- [x] `server/src/db.ts` — supabase-js with `SUPABASE_SECRET_KEY`, typed `<Database>` (Phase 2 landed
      first, so it was never untyped). Plus `unwrap` / `unwrapRequired` / `unwrapMany` so no call site
      repeats `if (error) throw` — the ones that forget read a failed query as an empty result, which
      for the scheduler means "nothing due" rather than "the database is down".
- [x] `server/src/crypto.ts` — AES-256-GCM `encrypt`/`decrypt` + HMAC `sign`/`verify` + constant-time
      `secretsMatch`. **Verified:** round-trips, two encrypts of the same input differ (random IV),
      and a tampered ciphertext throws `DecryptionError` rather than returning garbage.
- [x] `server/src/logger.ts` — pino, with `redact` on every token path. Not decoration: this process
      holds a Gmail refresh token and the Supabase secret key, and the easiest way to leak either is
      to log an object that happens to contain one.
- [x] `server/src/index.ts` — Express, `cors({ origin: FRONTEND_URL })`, `/healthz`, pino, graceful
      SIGTERM shutdown, `trust proxy` (so `events.ip` isn't the load balancer's address), and
      `releaseStaleClaims()` at boot to recover rows a crash left mid-claim
- [x] `server/.env.example` (see bottom of this file)
- [x] **Verified:** `npm run typecheck` clean; `npm run build` emits and the compiled output boots;
      `/healthz` = 200; with a required var removed the server **refuses to boot** and names the
      field. Also confirmed `rewriteRelativeImportExtensions` really works — the emitted
      `dist/server/src/data/leads.js` imports `"../../../shared/mappers.js"`, and the full import
      graph resolves under plain `node`.

## Phase 1 — `shared/` extraction ✅
*No behaviour change. First, because the server must import the exact renderer the Preview step uses
— otherwise previews lie about what actually gets sent.*

- [x] Move to `shared/`: `types.ts`, `merge-tags.ts`, `time.ts`, `sequence.ts`, `leads.ts`
- [x] `frontend/src/lib/*.ts` become one-line re-exports → **zero component import changes**
- [x] `@shared/*` alias in `frontend/tsconfig.app.json`, `frontend/tsconfig.json`,
      `frontend/vite.config.ts`. **The server deliberately does *not* use the alias**: `tsc` does not
      rewrite path aliases on emit, so `@shared/x` would type-check and then crash at runtime.
      It uses relative `../../shared/x.ts` specifiers with `rewriteRelativeImportExtensions`.
- [x] `shared/package.json` — needed, not cosmetic: `shared/` sits outside both package roots, so
      `import { DateTime } from "luxon"` inside it resolves to nothing for Vite *and* Node. A local
      manifest with `luxon` + `"type": "module"` fixes both consumers at once.
- [x] Status unions are now **derived from the generated DB enums**
      (`LeadStatus = Enums<"lead_status">`) rather than hand-written, which is what turned the
      four missing `LeadStatus` cases into a compile error in `StatusBadge` instead of a runtime
      crash. Also added: `SchedulerSettings`, `AccountStatus`, `SendStatus`, `EventType`,
      `Lead.repliedAt`, `SenderAccount.status`.
- [x] `shared/sequence.ts` gains `nextEmailAfter()` + `firstEmailStep()` — the whole follow-up
      scheduling rule, kept database-free so it's testable in isolation
- [x] **Verify:** `cd frontend && npm run build` passes (`tsc -b` clean + vite build)

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
- [x] Disable public signups in Supabase Auth — **dashboard only, you must do this**
      (Authentication → Providers → Email → *Enable sign ups* off). This is what enforces "single user".
- [x] Create your one user in the Supabase dashboard (Authentication → Users → Add user), **then**
      re-run the seed at the bottom of `schema.sql` to create your `settings` row —
      `auth.users` is currently empty, so that insert matched nothing.
      *Done: 1 user, 1 `settings` row.*
- [x] Add an npm script `db:types` so regenerating is one command → `server/scripts/gen-db-types.mjs`.
      Reads the project ref out of `SUPABASE_URL` so it isn't duplicated anywhere, writes to
      `shared/`, and refuses to overwrite a working types file if the CLI output doesn't contain
      `export type Database` (it exits 0 while printing diagnostics in some failure modes, and
      clobbering the file would break both packages' builds at once)
- [x] `server/src/db.ts` → `createClient<Database>(…)`
- [x] `frontend/src/lib/supabase.ts` → `createClient<Database>(…)` too
- [x] Derive row types instead of hand-writing them — `db.ts` exports `GmailAccountRow`, `LeadRow`,
      `SendRow`, `SequenceStepRow`, `TemplateStepRow`, `SettingsRow`, `AttachmentRow`, `EventRow`
      via `Tables<"…">`, plus `SendInsert` / `SendUpdate` / `EventInsert` / `GmailAccountUpdate`

## Phase 3 — Auth gate + mappers
*Mock data still behind it.*

- [x] Login screen — **email + password**, not the magic link this originally called for. Supabase's
      built-in mailer is capped at a couple of messages an hour on the free tier and only delivers to
      project-team addresses, which is enough to lock yourself out mid-afternoon. With signups disabled
      and the account created by hand in the dashboard, a password gives up nothing.
      - `frontend/src/lib/auth.ts` — `useAuth()` (`getSession` + `onAuthStateChange`), `signIn`,
        `signOut`. The `loading` state is what stops the login form flashing on every reload, since
        restoring the persisted session is async. `signIn` returns a message instead of throwing, and
        rewrites Supabase's deliberately-vague "Invalid login credentials" to also name the likeliest
        cause here: a dashboard user created without **Auto Confirm User**.
      - `frontend/src/components/auth/LoginPage.tsx` — no sign-up and no password reset, both of which
        would need the mailer that doesn't work. A real `<form>` so Enter submits and password managers
        fill it.
      - `App.tsx` splits into `App` (auth gate) + `Workspace`, so every hook below the gate can assume a
        session exists rather than null-checking one threaded through the tree. Unmounting on sign-out
        is also what discards all in-memory state.
- [x] `frontend/src/lib/supabase.ts` — `createClient<Database>`. Without the generic every
      `.from("leads")` returns `any`, and a column typo becomes a blank field in a *sent email* rather
      than a compile error; this one line is what makes `shared/mappers.ts` check against the real
      schema. Now **throws at module load** when env vars are missing instead of exporting `null` — a
      null client renders an empty database and silently drops writes, which is indistinguishable from
      "you have no leads". Also exports `accessToken()` for the four calls to our own server, read
      fresh from `getSession()` each time because these expire hourly.
- [x] **Frontend strictness raised to match `server/tsconfig.json`** — `strict`,
      `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitReturns`,
      `noImplicitOverride`. `strict` had been **off entirely**, and `shared/` is compiled by both
      projects: the looser side was silently accepting what the stricter side rejects. Found it while
      about to write code where every Supabase call returns `data: T | null`.
      Cost 10 small edits: optional props widened to `?: T | undefined` (with
      `exactOptionalPropertyTypes`, `?: T` refuses the explicit `undefined` a React caller passes),
      `MERGE_ATTRIBUTES` retyped as a non-empty tuple so `[0]` is known to exist, and one real
      index guard in `duplicateTemplate`.
- [x] `server/src/auth/requireUser.ts` — verify the Supabase JWT from the `Authorization` header
- [x] `shared/mappers.ts` — snake_case ↔ camelCase in exactly one place. Landed in `shared/` rather
      than `frontend/src/lib/` because the **server** needs the identical conversion: the renderer
      takes a domain `Lead`, so a server-side second implementation would be the same class of drift
      the shared renderer exists to prevent. Typed `(row: LeadRow) => Lead`, generated row type on
      one side and `shared/types.ts` on the other.
- [x] `server/src/http/` — `errors.ts` (one class per HTTP outcome), `schemas.ts` (the reusable zod
      pieces), `handler.ts` (`route()` + the terminal `errorMiddleware`). Went further than a
      body-validation middleware: `route<TBody, TParams, TQuery>(schemas, handler)` hands the handler
      an already-parsed, **typed** body/params/query, which is what removes every `as` and every
      `req.body.foo!` from the route files. `errorMiddleware` is the single place a status code is
      decided, so no route wraps a send in a try/catch to get the right one.
- [x] **Verify:** driven in a real browser against the live project — the login screen renders with no
      console errors, submit stays disabled while empty, a wrong password round-trips to Supabase Auth
      and surfaces inline in an `aria-live` region, and the form re-enables for a retry. That failing
      request is itself the proof that `frontend/.env` and the publishable key are correct.
      Still unverified: the signed-in path (needs the password, which is yours) — sign in → Database →
      sign out.

## Phase 4 — Real CRUD, one slice per commit
*Smallest surface first so the mapper layer is proven before the big tables.*

- [x] `settings` → `SequenceSettings` / `SettingsPage`. `lib/settings.ts` (queries + `useSettings`).
      Saved on an explicit button rather than debounced — these values gate every future send.
      - The write is an UPDATE of the four columns `sequenceSettingsToRow` projects, **not** an
        upsert of `AllSettings`: `jitter_*` and `stale_send_grace_hours` are the scheduler's, and
        writing them back from a page that doesn't edit them would reset a hand-tuned value on every
        weekday toggle. Verified by hand-setting two of them and confirming they survived a save.
      - Needs an explicit `.eq("user_id", …)` even though RLS scopes it to that one row: PostgREST
        rejects a filter-less UPDATE with `21000` *before* RLS is consulted. Found the hard way — the
        first version reported success over a database that hadn't changed.
- [x] `leads` → `DatabasePage`, `LeadDialog`, CSV import. `lib/use-leads.ts` (queries + `useLeads`);
      `MOCK_LEADS` deleted.
      - **Zod-validates every parsed CSV row.** `parseLeadsCsv` now returns accepted rows *plus*
        per-row rejections (line number + reason) instead of `Lead[]`, and only fails outright if the
        file can't be read — "row 14's email is missing an @" beats "your CSV is broken". `email` and
        `send_time_ist` are checked against the columns' own CHECK constraints, so a parse success
        can't 23514; the other fields default to `''` in Postgres, so a blank cell is not an error.
      - One definition of a valid address, in `shared/leads.ts` (`LEAD_EMAIL_PATTERN`). It had been
        hand-copied into three places at three different strengths — the server's zod schema, the
        lead dialog, and the importer — and the dialog's was the loosest.
      - Duplicates are filtered client-side before the insert. `(user_id, lower(email))` is unique,
        and the bulk insert is one statement, so a single re-imported address would otherwise reject
        the whole file. Every entry point lowercases, so case can't smuggle one past.
      - **Two real bugs found by driving it, not by reading it.** `normalizeKey` stripped only
        `[\s_-]`, so the `Send Time (IST)` header — the one `leadsToCsv` itself writes — normalized
        to `sendtime(ist)`, matched nothing, and silently gave *every* imported lead the 10:00
        default. And `created_at` defaults to `now()`, the **statement** timestamp, so all rows of a
        bulk insert share it to the microsecond and `order("created_at")` alone let the table
        reshuffle between reloads; `email` is now the tiebreaker.
      - `status` is still local-only (`patchStatus`). It's the scheduler's column and the launch
        route isn't wired up, so writing `scheduled` here would claim a send nobody queued.
- [x] `templates` + `template_steps` → `TemplatesPage`. Landed **out of order**, with Phase 6, because
      test-send renders the stored row: without persistence there is no UUID to send and nothing to
      render. `lib/templates.ts` (queries) + `lib/use-templates.ts` (store).
      - Two write schedules, not one. **Structural** edits (add/delete/reorder) go through
        `replaceSteps` immediately, because Postgres assigns the ids the editor then needs;
        **content** edits are debounced 800 ms and flushed by `flush()` before a send, on `pagehide`,
        and on unmount.
      - `replaceSteps` is delete-then-insert, not a diff: a reorder transiently violates the
        `(template_id, position)` unique constraint, and a template has single digits of steps.
        Ids are *not* preserved, so the saved list is returned and adopted rather than assumed.
      - `TemplatesPage` **derives** the effective selection from the current list instead of syncing
        it with an effect — templates arrive async and `setSteps` invalidates every step id, so both
        cases resolve for free rather than each needing a corrective effect that renders one wrong
        frame first.
- [ ] `sequence_steps` per lead → `ComposeFlow` (keyed by `lead_id`; every lead owns its own copy)
- [ ] Move `newSequenceForLead`, `stepsFromTemplate`, `newTemplate` into `shared/`, then delete `mock-data.ts`
- [ ] `LeadStatus` gains `sending | replied | failed | cancelled` in `shared/types.ts` + `StatusBadge`
- [x] **Verify:** driven in a real browser against the live project, every claim checked against SQL and
      the network log rather than what the UI drew — dialog create (lowercased, real UUID), an invalid
      address rejected client-side with the dialog held open so the typing survives, a duplicate
      rendered as "varun@thumpn.com is already in your database." rather than Postgres's constraint
      name, CSV import (3 inserted / 1 in-file duplicate skipped / 2 rejected with the right line
      numbers), inline send-time `PATCH 204`, an edit through the dialog, a cleared website stored as
      `null` and not `''`, delete, **hard reload with everything still there and the order stable**,
      compose-flow send time persisting, and an Export → re-import round-trip with zero rejects.
      - Two of those steps only tested anything after a fix: the chrome-devtools `fill` tool sets a
        DOM value without firing React's `onChange` for `<input type="time">` and for clearing a text
        input, so neither produced a request. Real `press_key` gestures were needed. Worth knowing —
        a green browser check that issued no network call is not a check.

## Phase 5 — Google OAuth connect
*Server done; the Google Cloud project and the frontend button are still open.*

- [x] Google Cloud: new project → enable **Gmail API** → consent screen with the 5 scopes → **Publish → In production** (do *not* submit for verification) → Web OAuth client with redirect `http://localhost:8080/api/auth/google/callback`
- [x] `server/src/auth/google.ts`
  - `GET /api/auth/google` — insert `oauth_states` row, redirect with `access_type=offline&prompt=consent&state=…`.
    Authenticated by `?token=` rather than a header: this is a **browser navigation**, which carries none.
  - `GET /api/auth/google/callback` — verify+delete state, exchange code, `oauth2.userinfo.get()`,
    store `gmail_accounts` with the refresh token **encrypted**, redirect to `FRONTEND_URL/settings?connected=1`.
    Always ends in a redirect, never JSON — the browser is showing whatever this returns.
  - `POST /api/accounts/:id/disconnect` — `revokeToken` then delete, in that order
  - The `state` is **HMAC-signed and carries the user id**, because `oauth_states` has no `user_id`
    column and the callback has no session to read one from. The nonce row is still written, so the
    state is single-use rather than replayable forever.
  - Not an `.upsert()`: `gmail_accounts` uniqueness is an **expression index** on
    `(user_id, lower(email))`, which PostgREST's `on_conflict` cannot name (42P10). Manual
    find-then-update-or-insert with `.ilike()` instead.
  - No refresh token in the response → `ConflictError(…, "no_refresh_token")`, since without one the
    account can never send again and storing it would look like success.
- [x] `server/src/email/accounts.ts` — `mailerFor(account)`, `replyWatcherFor`, `oauthClientFor`,
      `markNeedsReauth`, `forgetAccount`; per-account cached `OAuth2Client` whose `tokens` event
      persists refreshed access/refresh tokens
- [x] Wire the Connect button → `${VITE_SERVER_URL}/api/auth/google?token=…` (`lib/api.ts`
      `googleConsentUrl()`). A **full navigation**, not a `fetch`: the server answers with a 302 to
      Google's consent screen, and a fetch would follow that redirect in the background where the
      user can't interact with it. Hidden once an account is connected, since both the test-send and
      launch paths refuse with `ambiguous_account` rather than guessing between several.
- [x] Handle the return — `lib/oauth-return.ts`. The callback redirects to `/settings?connected=1`,
      but **this app has no router** (the current page is a `useState<AppView>`), so the query string
      is read once at module load, turned into an initial view + a toast, and stripped from the URL so
      a reload doesn't re-announce the connect. Module scope rather than an effect: reading it
      *consumes* it, and StrictMode double-invokes effects.
- [x] Read real accounts from the `gmail_accounts_public` **view** (`lib/accounts.ts`), never the
      `gmail_accounts` table — that holds `refresh_token_enc` and has no RLS policy at all. The daily
      cap goes through the `set_daily_limit` function since the browser has no UPDATE on it.
- [x] Wire disconnect → `POST /api/accounts/:id/disconnect`
- [x] Render `status='needs_reauth'` as a Reconnect prompt — otherwise a revoked token stays
      invisible until a scheduled send fails hours later
- [x] **Verified:** Connect → consent (through the unverified-app warning) → `mailuditya@gmail.com`
      shows in Settings with `daily_limit` 15, `status` active, all 5 scopes and an encrypted refresh
      token stored.

## Phase 6 — First real email
*Server done; needs a connected Gmail (Phase 5) to actually deliver.*

- [x] `server/src/email/gmail-mailer.ts` — `GmailMailer` per `BACKEND_PLAN.md` §6
  - `readMessageId()` after every send — **Gmail always overwrites the `Message-ID`**, so Nodemailer's value must never be persisted
  - `GmailAuthError` / `GmailRateLimitError` / `GmailMessageError` so the scheduler can branch
  - **No `!` and no `as` on Gmail responses.** `googleapis` types `data.id` / `data.threadId` as
    `string | null | undefined` and that's accurate — branch and throw, so a missing id can never
    reach the `sends` row as `undefined`. This is the third zod/validation boundary.
  - `nodemailer` streamTransport (`buffer: true`, `newline: "windows"`) used purely as a MIME builder
    → `base64url` → Gmail `raw`, with the 5 MB ceiling checked before the call
- [x] `server/src/tracking/tracking-links.ts` — HMAC-signed pixel + click URLs. The signature covers
      `trackingId` **and** the URL together, so a signature lifted from one email can't be replayed to
      redirect a different one.
- [x] `server/src/render/email-renderer.ts` — `renderTags` from `shared/merge-tags.ts`, pixel +
      `cheerio` link rewrite, both gated on `settings`; hand-rolled `htmlToText` so link URLs survive
      into the plain-text part.
      **Verified:** tags resolve, `{{job_title:"leader"}}` falls back, values are HTML-escaped
      (`Acme & Co` → `Acme &amp; Co`), a tag with neither value nor fallback renders its label,
      `mailto:` is left alone by the rewriter, and `<p></p>` throws `EmptyStepError`.
- [x] `POST /api/test-send { stepId, to, leadId? }` — no cap, no tracking, no `sends` row.
      Every id is re-resolved server-side with an explicit ownership filter rather than trusted from
      the body; this endpoint sends real mail from a browser-supplied payload, so it's the one that
      most needs parsing rather than casting. Subject is prefixed `[TEST] `.
      With no `leadId` (the Templates page) it renders against an all-empty placeholder lead, so tags
      fall through to their own fallbacks — which is exactly what the Preview step shows.
- [x] Wire `SendTestPopover` — was a fake `toast.success`, now calls `sendTest()` and reports the real
      `{ to, from, subject }` back. Takes `onBeforeSend`, awaited before the request, because the server
      renders the **stored** row: without the flush a test send silently emails the last debounced save
      instead of what's on screen. Also guards on `stepId` being a real UUID — a client-invented id
      (`t1-s1`) can never resolve server-side, so it fails fast with a readable message rather than a 404.
- [x] **Verified end to end:** `[TEST] Test send from the outreach tool — your team` delivered from
      `mailuditya@gmail.com`, HTML body intact. The scheduler ticked three times during and after with
      `claimed: 0, sent: 0` and the database shows `sends: 0` / `events: 0` — proof that the
      no-cap/no-tracking/no-`sends`-row design of test-send actually holds and can't disturb a campaign.

## Phase 7 — Resume attachment
*The frontend has no attach UI at all today — this phase adds it.*

- [ ] Attach control on the email step in `ContentStep` → upload to Storage → `attachments` + `step_attachments`
- [ ] Cap uploads at ~4 MB so `raw` never crosses the 5 MB `messages.send` ceiling
      *(the bucket already enforces this; the UI needs to fail politely rather than on a 413)*
- [x] `server/src/storage/attachment-store.ts` → `fetchForStep()` / `fetchForTemplateStep()` return
      Buffers for MIME. Two methods because the same step id can live in either `step_attachments` or
      `template_step_attachments`, so the caller says which — `test-send` gets that from its own
      step lookup rather than guessing.
- [ ] **Verify:** test-send arrives with the PDF attached and openable

## Phase 8 — Scheduler (opening email only)
*Server done; the end-to-end timing test needs a connected Gmail and real leads.*

- [x] `server/src/scheduler/schedule.ts` — `firstSendAt()`, `nextAllowedDay()`, `followUpSendAt()`,
      `rescheduleStaleAt()`, `isStale()`, `daysFor()`, `isAllowedDay()`, `jitterMs()`.
      Deliberately DB-free with an injectable `now`, so it's testable without waiting for a Tuesday.
      ⚠️ `Weekday` is 0=Mon…6=Sun but Luxon is 1=Mon…7=Sun; the `-1` is load-bearing and centralised
      in `toWeekday()`. Run with `TZ=UTC`.
      **Verified against a known Monday (2026-08-03):** 08:00 → today 09:30; 10:00 → tomorrow;
      Thursday-after-slot → skips Fri/Sat/Sun to Monday; `waitDays: 0` → next day, *not* the same
      minute; `followUpDays` allows a Friday that `outreachDays` pushes to Monday; 00:30 IST maps to
      19:00 UTC the previous day; empty day set → `NoAllowedDayError`; `"25:99"` → `InvalidSendTimeError`.
- [x] `server/src/scheduler/send-queue.ts` — the **only** writer to `sends`. `claimDue()` via the
      `claim_due_sends` RPC (`FOR UPDATE SKIP LOCKED`), `sentToday`, `markSent`, `markFailed` with
      `[2, 10, 60]`-minute backoff, `markPermanentlyFailed`, `cancel`, `reschedule`, `enqueue`,
      `cancelPendingFor`, `lastSentFor`, `findByTrackingId`, `releaseStaleClaims`.
      `markFailed` always returns a row to `pending` — leaving it `sending` would mean no future claim
      ever matches it again. `enqueue` upserts with `ignoreDuplicates` on `(lead_id, step_position)`,
      which is what makes a double-clicked Launch harmless.
- [x] `POST /api/leads/:id/launch` + `POST /api/leads/:id/cancel` (`server/src/routes/leads.ts`) —
      replaces `launchLead()`'s local state; returns the real computed `scheduled_at` for the toast.
      Launch validates everything that would otherwise fail silently three days later: already
      replied, already launched, no sequence, no email step, empty subject, empty body, no/ambiguous
      account. Cancel only returns the lead to `draft` if nothing has actually gone out yet.
      Plus `GET /api/leads/:id/sends` for the per-lead queue state.
- [x] `server/src/scheduler/tick.ts` — tokens → **replies** → daily cap → claim → weekday gate →
      stale-send grace → render → send → record → enqueue next → jitter. Replies are checked *before*
      sending, or a reply from 40 seconds ago still gets a follow-up. An in-process `running` flag
      stops `node-cron` stacking ticks that a jittered run outlives.
- [x] Drive it with `node-cron` `* * * * *` (timezone pinned to UTC) **and** expose
      `POST /api/cron/tick` behind `CRON_SECRET` — same function, so the deferred hosting choice is a
      config change rather than a rewrite. `CRON_SECRET` being optional means the route **fails
      closed**: unset → 403, never an open trigger. Comparison is constant-time.
      **Verified:** wrong secret → 403, correct secret reaches `runTick`, `Authorization: Bearer` and
      `X-Cron-Secret` both accepted, no secret → 403.
- [ ] **Verify:** set a lead's IST time ~2 min out, watch it send and flip to `sent`; kill and restart the server mid-run and confirm no double-send

## Phase 9 — Follow-ups
*Server done.*

- [x] `enqueueNextStep()` — creates follow-up N+1 **only after N is actually sent**, so delays are
      relative to reality and not-yet-sent steps stay editable. The rule itself lives in
      `shared/sequence.ts` (`nextEmailAfter`), database-free and therefore readable.
- [x] Threading needs all three or it silently breaks: identical `Subject`, `In-Reply-To`/`References`
      from the stored `rfc822_message_id`, and `threadId`. The parent's **stored** subject is reused
      verbatim rather than re-rendered — a lead edited since the opening email would otherwise produce
      a slightly different subject and Gmail would start a new thread.
- [ ] **Verify:** shrink a wait to 1 day (or minutes temporarily) — follow-up #1 appears **inside the same Gmail thread**

## Phase 10 — Reply detection
*Server done.*

- [x] `server/src/email/reply-watcher.ts` — `threads.get` metadata; any message whose `From` ≠ the
      account is a reply
- [x] Runs at the **top** of the tick, before sending — otherwise a reply from 40 seconds ago still
      gets a follow-up
- [x] Sets `leads.replied_at` + `status='replied'`, inserts an `events` row, cancels that lead's
      pending `sends`. `processSend` re-checks `repliedAt` after the claim too, for a reply that
      arrived in the window between claiming and sending.
- [ ] **Verify:** reply from another account → pending follow-ups become `cancelled`

## Phase 11 — Tracking
*Server done; the tunnel test is still open.*

- [x] `GET /t/o/:trackingId.gif` — 1×1 pixel (42-byte GIF89a), public, no auth. Mounted **before**
      the CORS middleware: an image fetched by a mail client sends no `Origin`, and must not be gated
      on one. Writes the response first and records second, so a slow database can't delay the image.
- [x] `GET /t/c/:trackingId?u=…&s=…` — HMAC-verified redirect (unsigned = open redirect for spammers).
      **Verified:** a correctly signed link 302s to its destination; one flipped character in the
      signature → 400; the same signature replayed onto a *different* tracking id → 400; a
      correctly-signed `javascript:` URL → 400, not a redirect (the protocol is re-checked after
      decoding, since a stored bad URL would have been signed just as happily); a non-UUID id → 400
      rather than a 22P02 out of Postgres.
- [x] Enable via the existing `trackOpens` / `trackClicks` toggles — `emailRenderer` gates both.
- [x] Filter `GoogleImageProxy` user agents, dedupe opens per `send_id` (10 s window) — opens are
      noise, clicks and replies are signal. Clicks are deliberately *not* deduped: a second click is a
      real second click. `recordOpen` never throws, because the alternative is a broken-image icon in
      a cold email.
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
