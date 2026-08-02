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

**A real campaign has now run end to end — the whole product in one pass.** A lead addressed to a
genuinely different inbox (`uditya204@gmail.com`, not the connected sender) was launched; its opening
email went out **at its own IST minute**; the follow-up landed **inside the same Gmail thread**,
verified against Gmail's own stored headers rather than the rows we wrote; and a **real human reply
cancelled the remaining follow-up while it was still 28 minutes in the future**. Phases 8, 9 and 10
are now verified by delivery, not by reading the code. See each phase below for the evidence and for
the one real bug this caught (a blank follow-up subject was a permanent failure).

That closes the last thing `BACKEND_PLAN.md` called unprovable without a real campaign.

⚠️ **Testing-only setting in force:** `outreach_days` and `follow_up_days` are both
`{0,1,2,3,4,5,6}` (Mon–Sun) so a timing test can run on any day. **Before production, put both back
to Mon–Thu** (`{0,1,2,3}` for outreach; follow-ups were `{0,1,2,3,4}`). Weekend cold opens are
exactly what that setting exists to prevent. This is a `settings` row change, not code — do it in
the Settings page.

**Phase 11 is now done too.** Opens and clicks are counted per recipient — shown in the Database
table's **Opens / clicks** column — and both endpoints were exercised through a public `cloudflared`
tunnel: opens are counted and deduped, repeats increment, and every tampered, unsigned or replayed
click link is refused. Counts rather than "Opened" badges because one open is nearly meaningless
while a second is a person.

Two things Phase 11 is worth reading for. **ngrok's free tier cannot serve the tracking pixel at all**
and produces a convincing false positive if you test it by hand. And the first *real* inbox open
caught a bug no synthetic test could: dropping `GoogleImageProxy` user agents would have shown **zero
opens for every Gmail recipient forever**, because Gmail proxies images when a human opens the
message too. Proxied opens are now recorded and merely labelled.

What's left:

1. **One real click from the inbox** — clicks are fully verified over the tunnel, but only with
   `curl`. Given what the first real *open* turned up, that gap is worth closing.
2. **Revert the sending days** before going live (see the warning above).

**All six features are now built and verified end to end.** Phase 7 (attachments) was the last
unbuilt one; everything remaining above is a manual confirmation or deploy prep.

The **Templates** page now has an attach control too, and applying a template carries its files onto
the recipient's steps — see Phase 7b.

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
      - `status` is never written from the browser — it's the scheduler's column. Was `patchStatus`
        while the launch route was unwired; now `adoptStatus`, which only ever catches local state up
        to a status `/launch` or `/cancel` has already returned. The rename is the point: the old name
        read like a setter, and a `scheduled` written here with nothing queued behind it would be a lie
        that survives a reload.
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
- [x] `sequence_steps` per lead → `ComposeFlow` (keyed by `lead_id`; every lead owns its own copy).
      `lib/sequences.ts` (queries) + `lib/use-sequences.ts` (store), mirroring the two write schedules
      above. Launch and cancel now call the real routes instead of setting status locally.
      - **Not a delete-then-insert, despite the identical columns.** Two tables point at these rows:
        `sends.step_id` is `on delete set null` and `step_attachments.step_id` cascades. Re-inserting
        with fresh ids would detach a queued send from its step and silently drop every attachment of
        a scheduled email. So writes here **preserve ids**. (`templates.ts` *was* a delete-then-insert;
        Phase 7b made it preserve ids too, for the second of those reasons.)
      - That forced knowing exactly what `sequence_steps_position_key`
        (`unique (lead_id, position) deferrable initially deferred`) actually permits, which I probed
        against the live database: **PostgREST autocommits every statement**, so there is no
        transaction to defer the check to. A *partial* position write raises 23505; a *whole-list*
        write in one statement succeeds, because the deferred check tolerates a transient collision
        within one statement. Hence `saveSequence` = delete-the-gone-rows → upsert the whole list →
        read back, in that order. Deleting first is what frees the positions a renumber moves into.
      - Conflict on the **primary key**, never on `(lead_id, position)`: a deferrable constraint cannot
        back an `ON CONFLICT` clause (42P10). `schema.sql:192` anticipates this.
      - My own SQL probe produced a **false OK** and had to be re-run. Inside a `DO` block everything
        is one transaction, so the deferred constraint isn't checked until commit and the cleanup
        `delete` erased the violation before it could fire. `set constraints all immediate` reproduced
        PostgREST's per-statement behaviour and inverted the conclusion — which is what fixed the
        statement order. A probe that agrees with you is worth re-running.
      - `isPersistedStepId` makes the placeholder-vs-UUID distinction explicit rather than
        conventional, because three paths depend on it: the upsert, the debounced content save (skips
        unsaved steps), and the test-send guard — where a placeholder is *present*, so `!stepId` alone
        would have let it through to a 400 on a uuid parse.
      - **`ContentStep` never passed `stepId`/`leadId` to `SendTestPopover`**, so the compose-flow test
        send had never worked at all. Now wired, with `onBeforeSend={onFlush}`.
      - Launch/cancel adopt the status the **server** returns rather than assuming one: `/cancel`
        answers `sent` — not `draft` — for a lead whose opening email already went out.
- [x] Move `newSequenceForLead`, `stepsFromTemplate`, `newTemplate` into `shared/`, then delete `mock-data.ts`.
      `newTemplate` became `newTemplateSteps` (a template's row is created by `createTemplate`, so only
      its steps needed a factory) and `use-templates.ts`'s local `blankSteps` collapsed into it.
      `mock-data.ts` is gone — grepped first; every remaining export was dead.
- [x] `LeadStatus` gains `sending | replied | failed | cancelled` — **already done and never ticked.**
      `LeadStatus = Enums<"lead_status">`, so it tracks the database enum, and `StatusBadge.tsx` maps
      all 7 states under `satisfies Record<LeadStatus, unknown>` — which is what makes a future enum
      value a compile error rather than a blank badge.
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
- [x] **Verify (`sequence_steps` slice):** driven in a real browser against the live project on a fresh
      lead, every claim checked against SQL and the network log. Opening compose seeded 5 rows with real
      UUIDs at positions 0–4; typing a subject and a Tiptap body produced two `PATCH 204`s against the
      *same* ids; deleting the middle email step renumbered `3→1` and `4→2` — both onto positions that
      were occupied before the delete — with **no 23505 and every surviving id unchanged**, which is the
      whole point of the delete-first ordering; Add step appended two rows and left the three existing
      ids alone; test-send from compose delivered `[TEST] Quick idea for Northwind Labs`, i.e. the
      per-lead merge data really resolved; Preview rendered `Hi Priya, I noticed your team's move to
      same-day dispatch`; Launch wrote one `pending` send with the real `step_id` and flipped the lead
      to `scheduled`; Cancel set it `cancelled` and the lead back to `draft`; applying a template
      replaced the list with a fresh UUID (not the template's own step id); deleting the lead cascaded
      `sequence_steps` and `sends` to zero. Hard reload mid-run showed the saved content and did **not**
      reseed. Zero console errors across the whole run.
      - **One real bug, found only by driving it — a `23502` on `id`.** PostgREST derives ONE column
        list for a whole batch and sets that key to **null** in any row that omitted it; the column
        default is never consulted. So omitting `id` for new steps worked for the seed (no row had one)
        and broke the instant a list mixed saved and new steps — which is every Add step after the
        first. Fixed by minting the UUID client-side with `crypto.randomUUID()` so every row in the
        batch carries one. Splitting the write in two would also fix it, at the cost of the single
        statement the deferred `(lead_id, position)` constraint needs to tolerate a reorder.
      - `ContentStep`'s `busy` prop was documented but never threaded through. Now gates Add step,
        Duplicate, Delete, the wait-day steppers and Use template — each sends the whole list computed
        from the positions on screen, so a second click before the read-back races the write in flight.
      - **Still unverified, and needs a second email address (yours is the sender):** anything that
        requires a real delivery on a schedule — Phase 8 timing, Phase 9's same-thread follow-up, Phase
        10's reply-cancels-follow-ups. `reply-watcher.ts` decides a message is a reply by `From` ≠ the
        connected account, so a self-send makes reply detection meaningless by construction.

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

## Phase 7 — Resume attachment ✅

- [x] Attach control on the email step in `ContentStep` → upload to Storage → `attachments` +
      `step_attachments`. `AttachmentBar` sits under the body where a mail client puts it;
      `frontend/src/lib/attachments.ts` owns the write path and orders the three writes
      **object → row → link**, so a failure never leaves a link pointing at a file that isn't
      there (`attachment-store.ts` throws on a missing object, which would be a permanently
      failing send). Each later step unwinds the earlier ones on failure.
- [x] Cap uploads so `raw` never crosses the 5 MB `messages.send` ceiling — **3.5 MB, not 4 MB**.
      The old note here was wrong: base64 inflates by 4/3, so a bucket-legal 4 MB file becomes
      ~5.33 MB of `raw` and fails `MAX_RAW_LENGTH` *after* uploading successfully. The real ceiling
      is 5,000,000 × ¾ ≈ 3.75 MB, and `MAX_ATTACHMENT_BYTES` (`shared/attachments.ts`) sits at
      3.5 MB to leave room for headers and both body parts. Applied to a step's **total**, since
      Gmail's limit is per message. The bucket's 4 MB is now documented as a backstop.
- [x] `server/src/storage/attachment-store.ts` → `fetchForStep()` / `fetchForTemplateStep()` return
      Buffers for MIME. Two methods because the same step id can live in either `step_attachments` or
      `template_step_attachments`, so the caller says which — `test-send` gets that from its own
      step lookup rather than guessing.
- [x] **Verified end to end** (Gmail message `19fbe7042985d27e`): a 117,189-byte PDF attached in
      `ContentStep`, `attachments` row + `step_attachments` link + bucket object all written, and
      `npx tsx src/scripts/inspect-attachments.ts <messageId>` read the message back out of Gmail —
      `application/pdf filename=Uditya_Kumar_Resume.pdf bytes=117189`, downloaded byte-identical and
      starting `%PDF-`. Also verified: a `.txt` is refused client-side with a readable message and no
      upload, removing a file clears the row, the cascaded link **and** the bucket object with no
      orphan, and the private-bucket preview opens through a signed URL.
- [x] Attachments survive a step save. `saveSequence` carries them across its read-back keyed by id
      (`sequence_steps` has no attachment column, so mapping the rows straight through would blank
      every file on screen after an unrelated structural edit).

### Phase 7b — Template attachments ✅

Was listed here as out of scope; asked for and built. Attach a resume to a template once (one per
role), and applying that template to a recipient brings the file along.

- [x] `replaceSteps` in `templates.ts` **preserves step ids** — it was delete-then-insert, and
      `template_step_attachments.template_step_id` cascades, so adding a step or nudging a wait from
      3 days to 4 silently threw away every attached file. Same delete → upsert-on-`id` → read-back
      shape as `saveSequence`, including minting uuids client-side (PostgREST derives one column list
      per batch and writes `null` rather than consulting the column default).
- [x] `reuse` guards `duplicate`: it passes the *source* template's real uuids, so a naive
      id-preserving upsert would **move** the original's rows — and their files — into the copy.
      An id is only kept when it already belongs to *this* template; anything else is re-keyed and
      its files re-linked. Verified by SQL: original kept its step, the copy got a fresh one, both
      pointing at the same `attachments` row.
- [x] `attachments.ts` generalised over a `StepOwner` (`"sequence" | "template"`) rather than
      duplicated. The three link helpers name each table and step column as **literals** — a
      `{table, column}` lookup reads better but can't be typed, since supabase-js derives the row
      shape from the literal table name and a variable one yields a union where neither step column
      exists. The only way through was a cast that would have hidden a real column rename.
- [x] Applying a template **shares** the `attachments` row rather than copying the object — one
      stored resume serves every recipient. So deleting a file is **reference counted across both
      link tables** (`deleteIfUnreferenced`): deleting the row outright would cascade the resume out
      of every other email using it, including queued sends.
- [x] Orphan pruning on every path that deletes a step. Both link tables cascade off their step, so
      `saveSequence` / `deleteSequence` / `replaceSteps` / `deleteTemplate` read the doomed steps'
      files *before* the delete and prune after — otherwise the row and bucket object outlive every
      reference to them, which Apply Template did on every single use.
- [x] **Verified end to end** (Gmail message `19fbe871c0c6750c`): built "AI role" and "Mobile role"
      templates with one resume each, applied "Mobile role" to a lead, and confirmed by SQL that the
      lead's step links the *same* row (`template_links=1, sequence_links=1` — shared, not copied).
      `inspect-attachments.ts` read the delivered message back out of Gmail:
      `application/pdf filename=Resume_Mobile_Role.pdf bytes=563`, downloaded intact, starts `%PDF-`.
      Also verified live: a chip survives adding a step and a page reload; deleting a template step
      whose file nothing else used removed the row *and* the object; deleting the whole "Mobile role"
      template left the file intact (`template_links` 1 → 0) because the lead's queued email still
      needs it, and the chip is still on that email.

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
- [x] **Verified end to end, real delivery on a real schedule.** Lead → `uditya204@gmail.com` (a
      genuinely different inbox from the connected sender, which is what makes reply detection mean
      anything), `send_time_ist = 22:30`, launched at 22:27 IST. `firstSendAt` wrote
      `scheduled_at = 2026-08-01 17:00:00+00` — 22:30 IST **the same day**, where before the day-set
      change this identical launch went to Monday. Claimed at `17:00:02.266`, sent at `17:00:03.614`:
      **~3.6 s after its own minute**, tick + jitter included. `attempt_count: 1`, `last_error: null`,
      lead `draft → scheduled`, `sends: claimed 1, sent 1`.
      - **No double-send, proven by accident and better than the planned test.** A server from an
        earlier session had survived its `TaskStop` (which killed the npm wrapper, not the `tsx`
        child), so **two independent schedulers were polling the same queue** on the same minute. One
        logged `claimed: 1, sent: 1`; the other, ticking at the same second, logged `claimed: 0`. One
        email, one `sends` row. That is `claim_due_sends`' `FOR UPDATE SKIP LOCKED` doing its job
        under genuine process concurrency rather than a simulated restart.
        ⚠️ Operational note: `TaskStop` on `npm run dev` leaves the `tsx` child alive. Kill the
        `tsx`/node PID, or a stale scheduler keeps sending against your database.

## Phase 9 — Follow-ups
*Server done.*

- [x] `enqueueNextStep()` — creates follow-up N+1 **only after N is actually sent**, so delays are
      relative to reality and not-yet-sent steps stay editable. The rule itself lives in
      `shared/sequence.ts` (`nextEmailAfter`), database-free and therefore readable.
- [x] Threading needs all three or it silently breaks: identical `Subject`, `In-Reply-To`/`References`
      from the stored `rfc822_message_id`, and `threadId`. The parent's **stored** subject is reused
      verbatim rather than re-rendered — a lead edited since the opening email would otherwise produce
      a slightly different subject and Gmail would start a new thread.
- [x] **Verified against Gmail's own headers, not just our rows.** Follow-up #1 (subject left blank,
      i.e. the reply-in-thread path the compose UI advertises) went out on the same
      `gmail_thread_id: 19fbe44bd644e533` as the opening email, with a *different*
      `gmail_message_id`. `src/scripts/inspect-thread.ts` read the thread back via `threads.get` and
      showed all three requirements actually on the wire:
      `In-Reply-To` **and** `References` = the parent's real `Message-Id`
      (`<CAHjWFDcR4YDcpsFE1SvJZXE+…@mail.gmail.com>`), and `Subject: Quick idea for Northwind Labs`
      identical on both messages. Worth having as a script: inferring threading from the columns we
      wrote ourselves would have proved nothing about what Gmail did with them.
      - **A real bug, and only a live send could have found it: a blank follow-up subject was a
        permanent failure.** `processSend` rendered *before* resolving threading, so
        `EmailRenderer.render` hit `if (!rawSubject) throw new EmptyStepError` on exactly the step the
        UI tells you to leave blank — and because an empty step is (correctly) not retryable, the
        follow-up went straight to `status: 'failed'`,
        `last_error: "EmptyStepError: This email has no subject."`. It never reached `threadingFor`,
        which was sitting right there ready to supply the parent's subject.
        Fixed by inverting the order: `threadingFor` now returns a `parentSubject` **candidate** and
        runs first; `render` takes an `inheritedSubject` option and falls back to it. The step's own
        subject still wins when it has one — typing a subject into a follow-up means starting a new
        thread, which is the documented consequence. `inheritedSubject` is used **verbatim, never
        through `renderTags`**: it is already-rendered text, and a second pass would re-interpret a
        `{{` that survived into the subject.
        Note the launch-time guard would never have caught this — `assertSendable` only validates the
        **opening** email's subject, which is right, since a blank follow-up subject is legal.

## Phase 10 — Reply detection
*Server done.*

- [x] `server/src/email/reply-watcher.ts` — `threads.get` metadata; any message whose `From` ≠ the
      account is a reply
- [x] Runs at the **top** of the tick, before sending — otherwise a reply from 40 seconds ago still
      gets a follow-up
- [x] Sets `leads.replied_at` + `status='replied'`, inserts an `events` row, cancels that lead's
      pending `sends`. `processSend` re-checks `repliedAt` after the claim too, for a reply that
      arrived in the window between claiming and sending.
- [x] **Verified with a real human reply.** `uditya204@gmail.com` replied to the live thread at
      `17:13:11+00`; the **next** tick (`17:14:02`) caught it and did all four things in one pass:
      `Cancelled pending sends count: 1` → `Reply detected; follow-ups cancelled from:
      "uditya204@gmail.com"` → `repliesDetected: 1`. Database after: `leads.replied_at = 17:13:11+00`
      (**the reply's own timestamp, not the detection time**), `status: sending → replied`, one
      `events` row `type: 'reply'` attributed to the send at position 2, and
      `sends: sent@0, sent@2, cancelled@4`.
      Two things this actually proves, which a self-send could not have:
      - The `from` in the log is the **other** address. `reply-watcher` identifies a reply as
        `From` ≠ the connected account, so replying from the sender itself would have been
        indistinguishable from our own outbound mail — the check would have been vacuous.
      - `cancelled@4` was scheduled for `17:41:50`, ~28 minutes in the *future*. It was killed while
        genuinely pending, not merely after its moment had passed, which is the only version of this
        behaviour that matters in production.

### Phase 9b — Send times in the compose rail ✅

- [x] Every email step in the sequence sidebar now carries a line saying when it went out or when it
      is due: "Sent today, 9:35 AM", "Sends 7 Aug", "Sends ≈ 11 Aug", "Won't send".
      `StepTimingBadge` renders it; `projectSequenceSchedule` in `shared/schedule.ts` works it out.
      (The relative "in 3 days" form these were first written with is gone — see Phase 9d.)
- [x] **The whole design turns on one fact: follow-ups are queued lazily.** `enqueueNextStep` inserts
      the `sends` row for step N+1 only once N has actually gone out, so at most *one* unsent step has
      a real `scheduled_at` and everything past it has no row at all. The `StepTiming` union therefore
      separates certainty rather than just state:
      - `sent` / `sending` / `scheduled` — read straight from the row, **never recomputed**, so the
        rail cannot contradict the scheduler.
      - `projected` — chained arithmetic for steps with no row yet. Muted, prefixed `≈`, and its
        tooltip names all three things that can move it (the previous email sending late, a changed
        wait, changed weekdays in Settings).
      - `stopped` / `blocked` — a replied lead, or a step sitting behind a failed/cancelled send.
        `enqueueNextStep` only runs after a *successful* send, so a confident time there would be a
        lie; the chain breaks instead of guessing.
- [x] **The arithmetic moved to `shared/schedule.ts` rather than being reimplemented.** The scheduler
      decides when an email really goes out and the sidebar claims when it will; those two answers have
      to agree, so they are literally the same functions. `server/src/scheduler/schedule.ts` is now a
      re-export plus the send loop's own pacing (`jitterMs`, `sleep`), which has no business in a
      projection.
- [x] "It updates when you change the wait" needed no machinery **for projected steps**:
      `projectSequenceSchedule` is a pure function of the current `steps` array, so it runs during
      render and every following projection re-derives on the same render as the number changing.
      **Verified in the browser** — 3 → 5 days moved Follow-up #3 from "Sends ≈ in 6 days" to
      "Sends ≈ 10 Aug 2026", and the tooltip to "Estimated Mon 10 Aug, 9:35 AM IST".
      A step that already has a **queued row** was a different matter, and needed a server round trip
      — see Phase 9c.
- [x] `useSends` reads the queue **directly under RLS** — no server route. `sends` is SELECT-only to
      the browser (its INSERT/UPDATE grants are revoked), which is precisely what makes a row here
      trustworthy: the scheduler is the only writer. Only the five timing columns are selected; the
      table also holds the rendered bodies, and shipping an entire email per row to render one line of
      text would be absurd.
      - The rows are stored **tagged with the lead they were read for** and read back only on a match.
        Rows pair to steps by `position`, so the previous recipient's queue against this one's steps
        would show someone else's send time under this lead's follow-up. Clearing that in an effect was
        the first attempt: it is both a cascading render (`react-hooks/set-state-in-effect`) and one
        frame too late. Deriving makes the wrong pairing unrepresentable.
- [x] Two smaller judgements worth keeping:
      - The badge **wraps rather than truncates**. The rail narrows further the moment it gains a
        scrollbar — exactly when a fixed-width label starts losing its last characters — and "Sent
        today, 9:3…" is worse than a slightly taller card when the time *is* the point.
        `formatISTClock` joins "AM" to the digits with a non-breaking space so the wrap can only land
        somewhere sensible.
      - "Missing content" is suppressed once a step has sent. Whatever was in it then is what the
        recipient received; warning about blank fields now would imply something is still fixable.
- [x] `timings` is optional on `SequenceSidebar` because the Templates page reuses the rail, and a
      template has no recipient and no queue — there is genuinely no answer to "when does this send",
      so the badges are absent there rather than faked.

### Phase 9c — A wait change now moves the send that's already queued ✅

Reported as "I updated the wait from 3 to 5 but the card still says 3 days". The badge was right; the
**queue** was stale. Two separate fixes.

- [x] **The bug: a queued send is a snapshot, and nothing revisited it.** `enqueueNextStep` computes
      `scheduled_at` from the wait that was in force the moment the previous email went out. Editing
      that wait afterwards wrote `sequence_steps` and left the `sends` row where it was — so the rail
      went on reporting the old date, *correctly*, because that row is what the scheduler would have
      fired. Confirmed in SQL before writing anything: step position 3 held `wait_days = 5` while the
      pending row at position 4 still sat in the old 3-day slot.
- [x] `POST /api/leads/:id/resync-schedule` recomputes each pending row from
      `followUpSendAt(<parent's real sent_at>, <current wait>, sendTimeIST, followUpDays)` — the same
      rule and the same function the tick uses — and moves it only if the answer differs. A **route**
      and not a frontend write because `sends` is SELECT-only to the browser; the scheduler being its
      only writer is exactly what makes a row there trustworthy, and that property was worth keeping.
- [x] `sendQueue.rescheduleIfPending` filters on `status = 'pending'` rather than updating by id.
      `claim_due_sends` flips `pending` → `sending` atomically, so a plain update could land on a row
      being sent *right now* and reset it to pending — the same email twice. If the claim wins the
      race this matches zero rows and does nothing. Only `scheduled_at` is written; rewriting `status`
      here would be the very thing the filter exists to prevent.
- [x] Rows that are `sending`, `sent`, `cancelled`, `failed` or `skipped` are never touched. Also
      skipped: the **opening** email (its time comes from `firstSendAt` at launch and no wait bears on
      it, so recomputing would just shove the user's own launch time around), and any row whose
      position no longer matches what the sequence says comes next — the "step was deleted or
      renumbered" case, which the tick already fails loudly and which guessing a time would paper over.
- [x] Called after **every** structural edit, not just a changed wait: adding or deleting a step
      renumbers positions, which decides which step a queued row is even for. Awaited *after* the save,
      since the server re-reads `sequence_steps` to decide the new time.
- [x] Changing the **send time** goes through the same path, and needed `leadsStore.flush()` first:
      `setSendTime` is optimistic and debounced by 600 ms, so a resync fired alongside it would have
      read the *old* time, computed the time the row already had, and moved nothing — the same bug one
      level down. `onFlushSendTime` was added to `ComposeFlow` for exactly this.
- [x] Failures are logged, not toasted. The user's edit is already saved, and the rail keeps showing
      the queued time — which is still the truth, since a send that wasn't moved really is going out
      then. Blaming their wait change for a network blip would be worse than a beat of staleness.
- [x] **Verified end to end in the browser, against the database.** 5 → 6 days moved the pending row
      from `2026-08-05 04:05Z` to `2026-08-08 04:05Z` and the rail from "Sends 5 Aug" to "Sends 8 Aug";
      6 → 5 moved it back to `2026-08-07 04:05Z` / "Sends 7 Aug". Network panel confirmed the ordering:
      `POST sequence_steps` → `resync-schedule` 200 → re-read of `sends`. On the replied lead (one
      `cancelled` row, two `sent`) a wait change left every row untouched, as intended.

### Phase 9d — Dates instead of day counts in the rail ✅

- [x] "Sends in 3 days" → **"Sends 7 Aug"**, per *"instead of showing 3 days I want a date like 5 Aug"*.
      Beyond being what was asked for, the day count was quietly unreliable: the scheduler skips days
      the settings exclude, so a 3-day wait does not reliably land 3 days out, and it forced arithmetic
      against a today the reader has to remember and can't check. A date is what goes in a calendar.
- [x] The clock time is kept only within a day either side ("today, 9:35 AM" / "tomorrow, 9:35 AM"),
      where the minute is the interesting part and the label is short enough to afford it.
- [x] `formatISTDay` now suppresses the year when it is the current one — "7 Aug", but "21 Jul 2025".
      Always printing it made every ordinary near-future date four characters longer in a 16 rem rail;
      never printing it is wrong in a tool that keeps history. The comparison is IST-zoned, so
      `2026-12-31T18:35Z` correctly reads "1 Jan 2027" — verified along with the other four branches.
- [x] `relativeISTDays` deleted rather than left as an unused export; the badge was its only caller.
- [x] Re-measured after the change: longest label 111 px against 129 px available, all on one line —
      and the new date form is 69 px, well clear even once the rail gains a scrollbar. The tooltip
      still carries the weekday and exact minute ("Queued for Fri 7 Aug, 9:35 AM IST"), so shortening
      the label lost nothing.

### Phase 9e — The rail now shows the reply, and a wait change lands instantly ✅

Asked for as two things: *"in the replied, it should show the emails with sent at… then after the
message the person replied it shows tag replied in the vertical line and rest of the below emails of
replied tag show won't send replied"* and *"i want optimistic updates like when i update wait day more
or less, the date in below cards should change immediately, it should sync behind the scenes"*.

- [x] **The timing rule moved into `shared/schedule.ts` as `desiredFollowUpTime`.** Phase 9c fixed the
      *queue* but left the *display* reading a pending row's `scheduled_at` verbatim — a snapshot taken
      when the previous email went out — so the date under a card only moved once the resync round trip
      came back. The rail now recomputes it, and the resync route calls the same function to write it.
      One definition, so what is on screen and what is in the queue cannot disagree; the route's own
      ~50-line `desiredTimeFor` was deleted rather than left as a second copy of the rule.
- [x] It returns `null` — meaning "the row's own time is the best answer there is" — for the opening
      email, for a row that isn't `pending`, and for a row the sequence has renumbered under.
- [x] Because `projectSequenceSchedule` re-derives from `steps` on every render, the dates below a wait
      card change on the **same frame** as the number in it. The resync behind it then moves the row to
      the date already on screen, rather than the screen waiting on the row.
- [x] `changeDelay` deliberately does **not** set `busy`. Add and delete rebuild the whole list and
      renumber positions, so locking the rail against a second click protects something real; a wait is
      one number on one step and can't collide. Locking it made the +/- buttons dead for a full round
      trip — precisely the control a user nudges several times in a row.
- [x] **`StoppedCause` on the `stopped` timing**, so the badge reads **"Won't send — replied"**. Matched
      on `cause`, not on the prose `reason`: "Won't send" alone is the state without the reason, and on a
      replied lead every remaining card showed it, which read as several things having gone wrong rather
      than one good thing having happened.
- [x] A `pending` row on a replied lead now reports `stopped/replied` rather than a date. The scheduler
      cancels it on the next reply check, but until that runs the row still says `pending` — and
      announcing a send date for an email that will never go out is the one mistake the whole hedging
      scheme exists to prevent. A `cancelled` row on a replied lead attributes the cause to the reply,
      since that is how `markRepliedAndCancel` ends a sequence.
- [x] `replyAfterStepId` on the new `SequenceSchedule` return, drawn as a **"Replied" tag on the
      connector** below the last email that had actually gone out. A reply isn't a property of any one
      step — it arrives *between* two — and that is the honest place for the line: the steps above it
      earned it, everything below it is what it called off. Success-coloured, because it is the outcome
      the tool exists to produce.
- [x] Caught by the verification script before the browser ever saw it: `replyAfterStepId` was being set
      on every `sent` step regardless of whether a reply existed, which would have drawn a false marker
      on any lead with a delivered email. Now gated on `repliedAt`.
- [x] **Verified in the browser.** Three consecutive `+` clicks all registered (5 → 8 days) with the card
      below following each one — 7 Aug → 8 → 9 → 10 — and `resync-schedule` answering
      `moved: [{stepPosition: 4, from: "2026-08-09T04:05Z", to: "2026-08-10T04:05Z"}]`, matching the date
      on screen. On the replied lead: "Opening email / Sent yesterday, 10:30 PM" → wait → "Follow-up #1 /
      Sent yesterday, 10:40 PM" → **"↩ Replied"** → wait → "Follow-up #2 / Won't send — replied".
- [x] That replied lead's `sequence_steps` had been mangled by earlier testing — 2 rows left, against
      `sends` at positions 0, 2 and 4 — so neither delivered email had a card to render under. Repaired
      in SQL to the 5-step shape the sends were made from. Worth remembering that rows are matched to
      steps by **position** (`sends.step_id` is `on delete set null`), so a truncated step list silently
      loses history rather than erroring.

## Phase 11 — Tracking
*Done and verified through a public tunnel, and now from a real inbox — including a real click.*

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
- [x] ~~Filter `GoogleImageProxy` user agents~~ → **label them, never drop them.** Dedupe opens per
      `send_id` (10 s window). Clicks are deliberately *not* deduped: a second click is a real second
      click. `recordOpen` never throws, because the alternative is a broken-image icon in a cold email.

      > ⚠️ **This was a real bug, caught by the first genuine inbox open (2026-08-02).** The owner
      > opened a message twice and the UI kept showing the old count; both fetches had reached the
      > server and both were discarded as "proxy prefetch". The premise was wrong: **Gmail serves
      > every image through GoogleImageProxy, including the fetch a human opening the message
      > causes.** Filtering that user agent therefore means *Gmail recipients show zero opens
      > forever* — i.e. most of the list, silently.
      >
      > The log is unambiguous. Delivered 04:23:05 → **no** pixel request at delivery, so Gmail did
      > not prefetch at all; then exactly one request per open (04:32:54, 04:33:44). A 1:1 match with
      > human action.
      >
      > The proxy marker now only annotates: `lead_engagement.proxy_opens` counts proxied opens so the
      > UI can hedge the *single*-open case, which is where the ambiguity actually lives (a lone open
      > seconds after delivery may be Apple Mail Privacy Protection). It is **not** a noise count to
      > subtract. The real signal remains what it always was: **two or more opens**.
      >
      > Why the tunnel test missed it: every check used either a browser UA (recorded) or a
      > Gmail-proxy UA where "no event" was *asserted to be correct*. The test encoded the bug.
- [x] Surface events per lead in the UI — an **Opens / clicks** column on the Database table, fed by
      the `lead_engagement` view (`useEngagement` → `EngagementCell`).

      **Counts, not booleans**, and that is the whole point: one open is roughly "delivered", because
      Apple Mail Privacy Protection fetches the pixel before anybody has looked at the message. A
      second open is a person coming back to it. So the cell colours on `opens >= 2` and the tooltip
      says which of the two you're looking at.

      A **view**, not counter columns on `leads`: `events` already holds one row per open/click/reply,
      so a counter would be a second source of truth that the tracking endpoints could fail to
      increment. `security_invoker = true` (unlike `gmail_accounts_public`) — the browser is granted
      SELECT on `sends`/`events` and their `read_own` policies already scope the rows.

      Two subtleties worth keeping:
      - `open_count` is a **plain row count**. Dedupe happens in exactly one place, `recordOpen`'s
        10 s window; by the time a row exists it has earned its place. This originally had a *second*
        layer — `count(distinct (send_id, date_trunc('minute', created_at)))` — which was removed
        2026-08-02, see the ⚠️ below.
      - `distinct_links` sits beside `click_count` for the same reason: three clicks on one link is a
        weaker signal than one click on three.

      > ⚠️ **The per-minute open bucket was wrong and is gone.** Reported by the owner: opening an
      > email twice moved the count by one. Every fetch *was* recorded — the view collapsed pairs that
      > shared a wall-clock minute. Bucketing on the clock rather than on elapsed time is arbitrary in
      > both directions: fetches at 04:45:59 and 04:46:01 (2 s apart) counted as **two** opens, while
      > 04:45:10 and 04:45:59 (49 s apart) counted as **one**. Worse, it discarded deliberate re-opens
      > — the single clearest proof of a human, and the whole reason the count exists. Three real
      > re-opens 11–16 s apart were each silently swallowed. `total_opens` went with it: with the 10 s
      > window as the only dedupe, it was equal to `open_count` by construction, and a column
      > guaranteed to duplicate another invites false conclusions from the difference.
      >
      > Lesson: a dedupe rule has to be expressed in the units of the thing it models. "Two loads
      > close together are one read" is about *elapsed time between them*, never about which minute
      > they landed in.

      A lead with **no row at all** renders `—`, not `0`. "0 opens" is a claim about an email that
      went out; making it about a draft would be a lie. The view left-joins `events` onto `sends`, so
      anyone who has been emailed has a row even when every count is zero.

      Also un-gated the Settings **Tracking** section here — it still read "Coming soon" with both
      switches disabled, which made the feature unreachable through the UI.
- [x] **Verified through a public tunnel** (`cloudflared tunnel --url http://localhost:8080`, with
      `TRACKING_BASE_URL` pointed at it and the server restarted — `env.ts` reads it once at boot):
      - A Gmail-image-proxy User-Agent → 42-byte `image/gif`, and an `events` row with the proxy user
        agent stored. (This assertion was **inverted** when first written — see the warning above.)
      - A browser User-Agent → GIF **and** an open row. An immediate repeat → GIF, no second row
        (the 10 s dedupe). Two hits 12 s apart inside one clock minute → both recorded, but at the
        time the view reported `open_count` 3 against 4 rows. That discrepancy was read as the
        feature working; it was the minute-bucket bug (⚠️ above) showing itself, and the real
        re-opens it was eating went unnoticed for another three hours.
      - 3 clicks across 2 links → `click_count` 3, `distinct_links` 2; the repeat click on the *same*
        link was counted, since clicks are never deduped.
      - Tampered URL, missing `s`, and a signature replayed onto another tracking id → 400 with no
        redirect, all three over the public tunnel rather than only against localhost.
      - The counts then appeared in the UI as `3 / 3` with both tooltips reading correctly, and
        `last_open_at` converted to IST properly (04:20:15 UTC → "2 Aug, 9:50 AM IST").

      > ⚠️ **Use cloudflared, not ngrok.** ngrok's free tier answers any browser-like User-Agent —
      > which is exactly what Gmail's image proxy sends — with an HTML interstitial
      > (`Ngrok-Error-Code: ERR_NGROK_6024`) instead of forwarding. The pixel then never reaches the
      > server and **no event is ever recorded**, so the tunnel silently breaks the one thing it was
      > set up to test. That decision happens at ngrok's *edge*, before traffic policy runs: a policy
      > file injecting `ngrok-skip-browser-warning` was confirmed to be applied to forwarded requests
      > and *still* not defeat the interstitial. Passing the header by hand with `curl` works, which
      > makes it an easy false positive to chase. `trycloudflare.com` needs no account and no header.
- [x] **Verified from the real inbox** — and this is the check that mattered. The owner opened
      "Following up on Pixel Works" (send `fb276fc2`, thread `19fc0a58ffe6298b`) twice; both pixel
      fetches reached the server 1:1 with the opens, which is what exposed the proxy-filter bug above.
      Nothing before this step could have caught it, because every synthetic test either used a
      browser UA or asserted the wrong expectation for a proxy UA.

      Still worth doing once more after the fix: a fresh send, opened twice, to watch the count go
      `1 → 2` live. **The tunnel URL changes every time `cloudflared` restarts** and is baked into the
      delivered HTML, so a restart means re-sending, not just re-pointing `TRACKING_BASE_URL`.
- [x] **A real click from a mail client, confirmed.** The synthetic tunnel checks above were all
      `curl`; these were not. Events 17, 18, 25 and 28 carry an Android Chrome User-Agent from the
      owner's own IP (`14.194.135.206`) across both links — the signed redirect works from a phone's
      inbox, which is the signal that matters most. Found while investigating the open-count bug, not
      by looking for it.

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
