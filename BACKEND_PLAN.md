# Backend Plan — Cold Email Outreach Tool

End-to-end backend design derived from the actual frontend code (`frontend/src/lib/types.ts`,
`merge-tags.ts`, `sequence.ts`, `mock-data.ts`, compose/settings components).
Single user, one connected personal `@gmail.com`, Hunter-style Google OAuth connect.

---

## 1. What the frontend already implies

| Frontend fact | Backend consequence |
|---|---|
| `Lead` = company, first/last name, email, personalizationLine, `sendTimeIST` "HH:mm", jobTitle, website, verification, status(`draft`/`scheduled`/`sent`) | `leads` table, 1:1 with the type |
| Every lead owns **its own copy** of the sequence (`SequencesByLead`) | `sequence_steps` keyed by `lead_id`, **not** shared with templates |
| `SequenceStep` = `email` (subject, bodyHtml) or `delay` (waitDays), ordered array | `sequence_steps` with `position` + `kind` |
| `EmailTemplate` = name + same step shape | `templates` + `template_steps` (identical columns) |
| Merge tags `{{key:"fallback"}}` resolved by a custom regex in `merge-tags.ts` (not Handlebars, despite the dep) | **Move `merge-tags.ts` into `shared/` and import it in the server.** Preview and real send must use one renderer, or previews lie. |
| `SenderAccount` = email, name, `dailyLimit` | `gmail_accounts` table |
| `SequenceSettings` = trackOpens, trackClicks, `outreachDays`, `followUpDays` (0=Mon…6=Sun) | `settings` single row; day filters gate scheduling |
| Launch is **per recipient** (`launchLead` sets status `scheduled`) | No campaign entity. Launch = create the first `send` row for that lead. |
| `SendTestPopover` sends the step being edited to one address | `POST /api/test-send` — bypasses scheduler, cap, and tracking |
| Settings "Add account" button is unwired | `GET /api/auth/google` redirect starts here |
| **No attachment UI exists** | Frontend gap — needs a file picker on the opening-email step (§10) |

---

## 2. Google OAuth — exactly what Hunter does

### Scopes to request

```
openid
https://www.googleapis.com/auth/userinfo.email      → "See your primary Google Account email address"
https://www.googleapis.com/auth/userinfo.profile    → "See your personal info"
https://www.googleapis.com/auth/gmail.send          → send only (SENSITIVE)
https://www.googleapis.com/auth/gmail.readonly      → reply detection (RESTRICTED)
```

That is the same consent screen as your screenshot ("View your email messages and settings" =
`gmail.readonly`, "Manage drafts and send emails" = `gmail.compose`). Hunter uses `gmail.compose`
because it creates drafts; **you don't need it** — `gmail.send` is enough and is one tier less scary.

`gmail.readonly` is a *restricted* scope. Tighter alternative: `gmail.metadata` (headers only, enough
to see "a message in this thread is From someone else"). Caveat: **`gmail.metadata` forbids the `q`
search parameter**, so all reply detection must go through `threads.get`, never `messages.list?q=`.
Recommendation: use `gmail.readonly` — same verification cost for a self-use app, and it lets you
show the reply text in the UI later.

### The 7-day refresh-token trap (most important gotcha)

| OAuth consent screen state | Effect |
|---|---|
| **Testing** + External | Refresh token **expires after 7 days**. Your scheduler dies every week. |
| **Published (In production)** + unverified | Refresh token is long-lived. Scary "Google hasn't verified this app → Advanced → Go to (unsafe)" screen once, 100-user lifetime cap. |
| Published + verified | Needs brand review + a security assessment for restricted scopes. Not worth it for one user. |

**Do this:** set publishing status to **In production** and never submit for verification. Click
through the unverified warning once. You are user 1 of 100.

Also plan for revocation: refresh tokens die if unused 6 months, if you change your Google password
(Gmail scopes specifically), or if you re-consent more than 100 times. Surface a
`gmail_accounts.status = 'needs_reauth'` state in Settings instead of silently failing.

### Flow

```
GET  /api/auth/google
     → insert oauth_states(state, expires_at)
     → 302 accounts.google.com/o/oauth2/v2/auth?
         access_type=offline & prompt=consent & include_granted_scopes=true
         & state=<opaque> & scope=<above> & redirect_uri=<server>/api/auth/google/callback

GET  /api/auth/google/callback?code&state
     → verify+delete state row
     → oauth2Client.getToken(code)          // refresh_token ONLY comes back with prompt=consent
     → oauth2.userinfo.get()                 // email + name + sub
     → upsert gmail_accounts (refresh_token AES-256-GCM encrypted at rest)
     → 302 back to FRONTEND_URL/settings?connected=1

POST /api/accounts/:id/disconnect
     → oauth2Client.revokeToken(refresh_token) → delete row
```

`prompt=consent` on every connect is deliberate: without it Google omits `refresh_token` on
re-authorization and you get a silently broken account.

---

## 3. Libraries — what actually removes work

| Job | Pick | Why |
|---|---|---|
| OAuth + Gmail | **`googleapis`** (already in `server/package.json`) | `google.auth.OAuth2` auto-refreshes access tokens; emits `tokens` event to persist. Use `@googleapis/gmail` + `@googleapis/oauth2` instead if install size matters. |
| **MIME building** | **`nodemailer`** → `require('nodemailer/lib/mail-composer')` | The single biggest saver. Hand-rolling `multipart/mixed` boundaries for HTML + PDF is where people lose a day. `new MailComposer({...}).compile().build()` → Buffer → base64url → `raw`. Handles attachments, `inReplyTo`, `references`, UTF-8, quoted-printable. |
| Merge tags | **`shared/merge-tags.ts`** (move the existing file) | Don't add Handlebars server-side. The existing regex + fallback + HTML-escaping logic is already correct and must not fork. |
| IST → UTC | **`luxon`** (already there) | `DateTime.fromFormat(hhmm,'HH:mm',{zone:'Asia/Kolkata'})` |
| Scheduler | **`node-cron`** (already there) | `* * * * *` poll. No BullMQ/Redis for one user. |
| Env/request validation | **`zod`** | Fail at boot on a missing secret, not at 3am on the first send. |
| Logging | **`pino`** | JSON logs → readable in Render/Railway. |
| HTML link rewriting | **`cheerio`** | Parsing Tiptap HTML with regex to wrap `<a href>` breaks on attributes. 3 lines with cheerio. |
| Token encryption | node `crypto` (AES-256-GCM) | No library needed. |

**Rejected:** Nylas / Unipile / Aurinko (unified email APIs — they *do* solve OAuth, threading and
reply detection in one SDK, but they're $99+/mo or per-account priced; wrong for one Gmail).
Instantly/Smartlead APIs (they *are* the product you're building). Handlebars server-side (forks
your renderer). BullMQ + Redis (one user, ≤50 emails/day).

---

## 4. Database schema (Supabase / Postgres)

`supabase/schema.sql`. All timestamps `timestamptz` in UTC. Every table gets
`user_id uuid not null default auth.uid() references auth.users`, RLS `using (auth.uid() = user_id)`.
Disable public signups in Supabase Auth so "single user" is enforced at the door.

```sql
-- ── connected sender ────────────────────────────────────────────────
create table gmail_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  email text not null unique,
  display_name text,
  google_sub text not null,
  refresh_token_enc text not null,      -- AES-256-GCM, server-only
  access_token_enc text,                -- cache; refreshed on demand
  access_token_expires_at timestamptz,
  scopes text[] not null,
  daily_limit int not null default 15,  -- SenderAccount.dailyLimit
  status text not null default 'active' -- active | needs_reauth | revoked
    check (status in ('active','needs_reauth','revoked')),
  created_at timestamptz not null default now()
);
alter table gmail_accounts enable row level security;
-- frontend may SELECT (email, display_name, daily_limit, status) via a VIEW only.
-- Never expose *_enc columns to the publishable key.

-- ── leads (mirrors Lead) ────────────────────────────────────────────
create table leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  company_name text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  email text not null,
  personalization_line text not null default '',
  send_time_ist text not null default '10:00',   -- "HH:mm" IST
  job_title text,
  website text,
  verification text not null default 'not_verified'
    check (verification in ('verified','not_verified','invalid')),
  status text not null default 'draft'
    check (status in ('draft','scheduled','sending','sent','replied','failed','cancelled')),
  replied_at timestamptz,               -- set by reply detection → kills follow-ups
  created_at timestamptz not null default now(),
  unique (user_id, email)
);

-- ── templates (EmailTemplate + SequenceStep) ────────────────────────
create table templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  name text not null default 'Untitled template',
  created_at timestamptz not null default now()
);

create table template_steps (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references templates(id) on delete cascade,
  position int not null,
  kind text not null check (kind in ('email','delay')),
  name text not null,
  subject text,
  body_html text,
  wait_days int,
  unique (template_id, position)
);

-- ── per-lead sequence (SequencesByLead) ─────────────────────────────
create table sequence_steps (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references leads(id) on delete cascade,
  position int not null,
  kind text not null check (kind in ('email','delay')),
  name text not null,
  subject text,
  body_html text,
  wait_days int,
  unique (lead_id, position)
);

-- ── attachments (resume) ────────────────────────────────────────────
create table attachments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  filename text not null,               -- "Uditya-Kumar-Resume.pdf"
  storage_path text not null,           -- Supabase Storage: attachments/<uid>/<uuid>.pdf
  mime_type text not null,
  size_bytes int not null,
  created_at timestamptz not null default now()
);

-- which steps carry which files (resume → opening email only)
create table step_attachments (
  step_id uuid not null references sequence_steps(id) on delete cascade,
  attachment_id uuid not null references attachments(id) on delete cascade,
  primary key (step_id, attachment_id)
);
create table template_step_attachments (
  template_step_id uuid not null references template_steps(id) on delete cascade,
  attachment_id uuid not null references attachments(id) on delete cascade,
  primary key (template_step_id, attachment_id)
);

-- ── sends: one row per outbound email. The scheduler's work queue. ──
create table sends (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  lead_id uuid not null references leads(id) on delete cascade,
  step_id uuid references sequence_steps(id) on delete set null,
  gmail_account_id uuid not null references gmail_accounts(id),
  step_position int not null,           -- survives step deletion
  is_follow_up boolean not null default false,

  status text not null default 'pending'
    check (status in ('pending','sending','sent','failed','skipped','cancelled')),
  scheduled_at timestamptz not null,    -- UTC, computed from send_time_ist
  claimed_at timestamptz,
  sent_at timestamptz,

  subject_rendered text,                -- exactly what went out (audit + preview parity)
  body_html_rendered text,

  gmail_message_id text,                -- Gmail's internal id
  gmail_thread_id text,                 -- threading for follow-ups
  rfc822_message_id text,               -- <...@mail.gmail.com> → References/In-Reply-To

  tracking_id uuid not null default gen_random_uuid(),   -- public, in pixel/link URLs
  attempt_count int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index on sends (status, scheduled_at);
create index on sends (tracking_id);
create unique index on sends (lead_id, step_position);  -- idempotency: never two rows per step

-- ── events ──────────────────────────────────────────────────────────
create table events (
  id bigserial primary key,
  send_id uuid not null references sends(id) on delete cascade,
  type text not null check (type in ('open','click','reply','bounce')),
  url text,                             -- for clicks
  user_agent text,
  ip inet,
  created_at timestamptz not null default now()
);
create index on events (send_id, type);

-- ── settings: exactly one row (SequenceSettings) ────────────────────
create table settings (
  user_id uuid primary key default auth.uid(),
  track_opens boolean not null default false,
  track_clicks boolean not null default false,
  outreach_days int[] not null default '{0,1,2,3}',    -- 0=Mon … 6=Sun
  follow_up_days int[] not null default '{0,1,2,3,4}',
  jitter_min_seconds int not null default 45,
  jitter_max_seconds int not null default 240,
  stale_send_grace_hours int not null default 6
);

-- ── OAuth CSRF state ────────────────────────────────────────────────
create table oauth_states (
  state text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);
```

**Storage:** one private bucket `attachments`. Frontend uploads with the publishable key +
storage RLS; the server downloads with the secret key when building MIME.

---

## 5. Server layout

```
server/
  src/
    index.ts              express app, CORS(FRONTEND_URL), /healthz
    env.ts                zod-validated env
    db.ts                 supabase client (SUPABASE_SECRET_KEY)
    crypto.ts             encrypt/decrypt tokens, HMAC tracking URLs
    auth/
      requireUser.ts      verify Supabase JWT from Authorization header
      google.ts           /api/auth/google + /callback + disconnect
      tokens.ts           getAuthedClient(accountId) → auto-refresh + persist
    gmail/
      send.ts             MailComposer → base64url → messages.send
      replies.ts          threads.get → detect inbound message
    render/
      renderEmail.ts      merge tags → tracking pixel → link rewrite
    scheduler/
      tick.ts             the whole loop (§8)
      schedule.ts         IST/weekday/next-slot math
    routes/
      launch.ts           POST /api/leads/:id/launch, /cancel
      testSend.ts         POST /api/test-send
      tracking.ts         GET /t/o/:id.gif, GET /t/c/:id
  shared/ (symlink or path alias to ../shared)
```

`shared/` at repo root holds `merge-tags.ts`, `sequence.ts`, `time.ts`, `types.ts` — imported by
both `frontend` and `server` via a tsconfig path alias. **This is the single most important
structural decision**: it's what guarantees the Preview step and the real email are byte-identical.

### API surface (small on purpose — CRUD stays in the browser via Supabase + RLS)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/google` | start OAuth |
| GET | `/api/auth/google/callback` | finish OAuth |
| POST | `/api/accounts/:id/disconnect` | revoke + delete |
| POST | `/api/leads/:id/launch` | validate + create first `send` row |
| POST | `/api/leads/:id/cancel` | cancel pending sends → lead back to `draft` |
| POST | `/api/test-send` | send one step to one address, no cap/tracking |
| POST | `/api/attachments/:id/verify` | optional: size/MIME sanity check |
| GET | `/t/o/:trackingId.gif` | open pixel — **public, no auth** |
| GET | `/t/c/:trackingId` | click redirect — **public, no auth** |
| POST | `/api/cron/tick` | manual/external trigger of the send loop (§9) |
| GET | `/healthz` | uptime ping |

Everything under `/api/` except OAuth + tracking requires the Supabase JWT.

---

## 6. Code style — Resend-like service abstractions

Every external dependency (Gmail, Storage, tracking) is wrapped in one class with a narrow typed
input/output, so the scheduler and routes read as business logic. Conventions:

1. **One class per external system**, constructor takes credentials, methods take a single typed
   input object. No positional args beyond the constructor.
2. **Explicit `Input`/`Result` interfaces** with doc comments on anything ambiguous — especially
   where two different kinds of ID exist (Gmail message id vs RFC `Message-ID`).
3. **Throw typed errors**, never return `null` for failure. The scheduler branches on error class.
4. **Validate at the boundary** and throw with the field name.
5. **ESM with `.js` import specifiers** (`"type": "module"` in `server/package.json` — it's currently
   `commonjs`, change it), `tsx` in dev, `tsc` for build.
6. **No env reads outside `env.ts`.** One zod-validated object, imported everywhere.

### `server/src/email/gmail-mailer.ts`

```ts
import nodemailer from "nodemailer";
import { google, type gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;

  /**
   * Gmail thread ID returned by a previous Gmail API send.
   * Required when adding a follow-up to an existing Gmail thread.
   * Gmail also requires the subject to match the parent message exactly,
   * otherwise it starts a new thread regardless of this value.
   */
  threadId?: string;

  /**
   * RFC Message-ID of the message being replied to, such as
   * "<CAB...@mail.gmail.com>". This is not the Gmail API message ID.
   * Read it from SendEmailResult.rfcMessageId of the parent send.
   */
  inReplyTo?: string;

  /**
   * Every RFC Message-ID earlier in the conversation, oldest first.
   */
  references?: string[];

  attachments?: Array<{
    filename: string;
    content: Buffer;
    contentType?: string;
  }>;
}

export interface SendEmailResult {
  /**
   * Gmail's internal message identifier. Use it for Gmail API calls.
   */
  gmailMessageId: string;

  /**
   * Gmail's conversation/thread identifier. Pass it as threadId on follow-ups.
   */
  threadId: string;

  /**
   * The RFC Message-ID Gmail assigned to the sent message, read back from the
   * Gmail API after sending.
   *
   * Gmail always overwrites the Message-ID that Nodemailer generates, so the
   * value Nodemailer reports is discarded and must never be persisted — a
   * follow-up referencing it would be shown as a detached message by any client
   * that threads on headers rather than Gmail's threadId.
   */
  rfcMessageId: string;
}

/** The connected account needs to be re-authorized before it can send again. */
export class GmailAuthError extends Error {}

/** Gmail is throttling or the daily quota is exhausted; back off and retry. */
export class GmailRateLimitError extends Error {}

export class GmailMailer {
  private readonly gmail: gmail_v1.Gmail;
  private readonly mimeBuilder = nodemailer.createTransport({
    /*
     * Stream transport does not deliver through SMTP.
     * It only generates the complete MIME message.
     */
    streamTransport: true,
    buffer: true,
  });

  constructor(
    private readonly fromAddress: string,
    private readonly fromName: string,
    private readonly oauthClient: OAuth2Client,
  ) {
    this.gmail = google.gmail({ version: "v1", auth: oauthClient });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!input.text && !input.html) {
      throw new Error("An email must contain text or HTML content.");
    }

    const headers: Record<string, string> = {};

    if (input.inReplyTo) {
      headers["In-Reply-To"] = input.inReplyTo;
    }

    if (input.references?.length) {
      headers.References = input.references.join(" ");
    }

    const generated = await this.mimeBuilder.sendMail({
      from: { name: this.fromName, address: this.fromAddress },
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      replyTo: input.replyTo,
      headers,
      attachments: input.attachments,
      newline: "windows", // CRLF, per RFC 5322
    });

    if (!Buffer.isBuffer(generated.message)) {
      throw new Error("Nodemailer did not generate a buffered MIME message.");
    }

    const raw = generated.message.toString("base64url");

    if (raw.length > 5_000_000) {
      // Beyond 5 MB the JSON endpoint rejects the request and the upload
      // endpoint is required. Attachment size is capped on upload so this
      // should be unreachable.
      throw new Error("MIME message exceeds the 5 MB limit of messages.send.");
    }

    const sent = await this.call(() =>
      this.gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      }),
    );

    const gmailMessageId = sent.data.id;
    const threadId = sent.data.threadId;

    if (!gmailMessageId || !threadId) {
      throw new Error("Gmail did not return a message ID and thread ID.");
    }

    return {
      gmailMessageId,
      threadId,
      rfcMessageId: await this.readMessageId(gmailMessageId),
    };
  }

  /**
   * Fetch the Message-ID header Gmail assigned to a message it just sent.
   * Follow-up threading depends on this value, so a missing header is fatal
   * rather than something to paper over with an empty string.
   */
  private async readMessageId(gmailMessageId: string): Promise<string> {
    const message = await this.call(() =>
      this.gmail.users.messages.get({
        userId: "me",
        id: gmailMessageId,
        format: "metadata",
        metadataHeaders: ["Message-ID"],
      }),
    );

    const header = message.data.payload?.headers?.find(
      (h) => h.name?.toLowerCase() === "message-id",
    );

    if (!header?.value) {
      throw new Error(
        `Gmail returned no Message-ID header for message ${gmailMessageId}.`,
      );
    }

    return header.value;
  }

  /**
   * Translate Google's error shapes into the two cases the scheduler acts on:
   * stop using this account, or retry it later.
   */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: any) {
      const status = error?.response?.status ?? error?.code;
      const reason = error?.response?.data?.error;

      if (status === 401 || reason === "invalid_grant") {
        throw new GmailAuthError(`Gmail authorization failed: ${error.message}`);
      }

      if (status === 429 || status === 403) {
        throw new GmailRateLimitError(`Gmail throttled the request: ${error.message}`);
      }

      throw error;
    }
  }
}
```

### `server/src/email/index.ts` — per-account factory

The refresh token arrives from the OAuth connect flow (§2) and lives encrypted in
`gmail_accounts`, so the mailer is built per account rather than from env. The OAuth client is
cached per account because `google-auth-library` refreshes the access token itself and emits
`tokens`, which is where the refreshed value gets persisted.

```ts
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { GmailMailer } from "./gmail-mailer.js";
import { env } from "../env.js";
import { decrypt, encrypt } from "../crypto.js";
import { db } from "../db.js";

const clients = new Map<string, OAuth2Client>();

function oauthClientFor(account: GmailAccountRow): OAuth2Client {
  const cached = clients.get(account.id);
  if (cached) return cached;

  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  client.setCredentials({
    refresh_token: decrypt(account.refresh_token_enc),
    access_token: account.access_token_enc ? decrypt(account.access_token_enc) : undefined,
    expiry_date: account.access_token_expires_at
      ? Date.parse(account.access_token_expires_at)
      : undefined,
  });

  /*
   * Persist refreshed access tokens so a restart does not force a new refresh
   * round trip, and capture a rotated refresh token if Google ever issues one.
   */
  client.on("tokens", async (tokens) => {
    await db
      .from("gmail_accounts")
      .update({
        ...(tokens.access_token
          ? {
              access_token_enc: encrypt(tokens.access_token),
              access_token_expires_at: tokens.expiry_date
                ? new Date(tokens.expiry_date).toISOString()
                : null,
            }
          : {}),
        ...(tokens.refresh_token
          ? { refresh_token_enc: encrypt(tokens.refresh_token) }
          : {}),
      })
      .eq("id", account.id);
  });

  clients.set(account.id, client);
  return client;
}

/** A mailer bound to one connected Gmail account. */
export function mailerFor(account: GmailAccountRow): GmailMailer {
  return new GmailMailer(
    account.email,
    account.display_name ?? account.email,
    oauthClientFor(account),
  );
}

/** Drop cached credentials after a disconnect or a re-authorization. */
export function forgetAccount(accountId: string): void {
  clients.delete(accountId);
}
```

Call site stays as clean as Resend:

```ts
const mailer = mailerFor(account);

const sent = await mailer.send({
  to: lead.email,
  subject,
  html,
  text,
  attachments,
  ...(parent && {
    threadId: parent.gmail_thread_id,
    inReplyTo: parent.rfc822_message_id,
    references: [parent.rfc822_message_id],
  }),
});

await db.from("sends").update({
  status: "sent",
  sent_at: new Date().toISOString(),
  gmail_message_id: sent.gmailMessageId,
  gmail_thread_id: sent.threadId,
  rfc822_message_id: sent.rfcMessageId,
}).eq("id", send.id);
```

### The other wrappers, same shape

Signatures only — each is one class in one file, mirroring `GmailMailer`.

```ts
// email/reply-watcher.ts — reply detection (§8 step 2)
class ReplyWatcher {
  constructor(oauthClient: OAuth2Client, private selfAddress: string) {}
  /** True when the thread contains a message from anyone but the sender. */
  hasInboundReply(threadId: string): Promise<{ replied: boolean; at?: Date }>
}

// render/email-renderer.ts — merge tags + tracking, shared with the frontend preview
class EmailRenderer {
  constructor(private tracking: TrackingLinks, private settings: Settings) {}
  render(step: SequenceStep, lead: Lead, trackingId: string):
    { subject: string; html: string; text: string }
}

// tracking/tracking-links.ts — HMAC-signed pixel + click URLs
class TrackingLinks {
  pixelUrl(trackingId: string): string
  wrap(url: string, trackingId: string): string
  /** Throws on a bad signature so the redirect can never be hijacked. */
  unwrap(encoded: string, signature: string): string
}

// storage/attachment-store.ts — Supabase Storage → Buffer for MIME
class AttachmentStore {
  fetchForStep(stepId: string): Promise<SendEmailInput["attachments"]>
}

// scheduler/send-queue.ts — the only place that touches `sends`
class SendQueue {
  claimDue(accountId: string, limit: number): Promise<SendRow[]>   // FOR UPDATE SKIP LOCKED
  markSent(sendId: string, result: SendEmailResult): Promise<void>
  markFailed(sendId: string, error: Error): Promise<void>          // backoff / needs_reauth
  reschedule(sendId: string, at: Date): Promise<void>
  enqueueNextStep(send: SendRow): Promise<void>
  cancelPendingFor(leadId: string): Promise<void>
}
```

With those in place `tick.ts` is readable end to end — claim, render, send, record, enqueue next —
and every Gmail quirk stays behind `GmailMailer`.

---

## 7. Rendering one email

```ts
// server/src/render/renderEmail.ts
import { renderTags } from '@shared/merge-tags'

function renderEmail(step, lead, send, settings) {
  const subject = renderTags(step.subject ?? '', lead)                 // plain text
  let html      = renderTags(step.body_html ?? '', lead, { html: true }) // escaped + <br>

  if (settings.track_clicks) html = rewriteLinks(html, send.tracking_id) // cheerio
  if (settings.track_opens)  html += `<img src="${BASE}/t/o/${send.tracking_id}.gif"
                                       width="1" height="1" alt="" style="display:block">`
  const text = htmlToText(html)   // multipart/alternative — plain-text part lifts deliverability
  return { subject, html, text }
}
```

Link rewrite: `https://x.com/a` → `${BASE}/t/c/${tracking_id}?u=<base64url(url)>&s=<hmac>`.
The HMAC stops your redirect becoming an open redirect for spammers.

Then MIME + send:

```ts
const mail = new MailComposer({
  from: `"${account.display_name}" <${account.email}>`,
  to: lead.email,
  subject,                     // follow-ups: EXACTLY the parent subject, or Gmail breaks the thread
  html, text,
  attachments: files.map(f => ({ filename: f.filename, content: f.buffer, contentType: f.mime_type })),
  inReplyTo:  parent?.rfc822_message_id,   // follow-ups only
  references: parent?.rfc822_message_id,
})
const raw = (await mail.compile().build()).toString('base64url')

const res = await gmail.users.messages.send({
  userId: 'me',
  requestBody: { raw, threadId: parent?.gmail_thread_id },   // threadId only on follow-ups
})

// Gmail ALWAYS overwrites a custom Message-ID → you must read the real one back
const meta = await gmail.users.messages.get({
  userId: 'me', id: res.data.id, format: 'metadata', metadataHeaders: ['Message-ID'],
})
```

Store `res.data.id`, `res.data.threadId`, and the `Message-ID` header on the `sends` row. Skipping
that last `get` is the #1 reason follow-ups land as detached emails.

**Threading needs all three:** matching `Subject` + `In-Reply-To`/`References` headers + `threadId`.
Two out of three silently breaks it for some clients.

---

## 8. The scheduler tick (`* * * * *`)

```
1. TOKENS      for each active account: refresh access token if <5 min left.
               on invalid_grant → status='needs_reauth', log, skip account.

2. REPLIES     for each lead with status='sending' and replied_at is null:
                 threads.get(threadId, format='metadata', metadataHeaders=['From','Date'])
                 if any message From != account.email:
                    leads.replied_at = now, status='replied'
                    insert events(type='reply')
                    UPDATE sends SET status='cancelled' WHERE lead_id=$1 AND status='pending'
               ← runs BEFORE sending, so a reply that arrived 30s ago still stops the follow-up.

3. CAP         sent_today = count(sends where sent_at::date = today in IST)
               budget = account.daily_limit - sent_today ; if 0 → stop.

4. CLAIM       UPDATE sends SET status='sending', claimed_at=now(), attempt_count=attempt_count+1
               WHERE id IN (
                 SELECT id FROM sends WHERE status='pending' AND scheduled_at <= now()
                 ORDER BY scheduled_at LIMIT $budget FOR UPDATE SKIP LOCKED
               ) RETURNING *;
               ← atomic claim. Guarantees no double-send across restarts/overlapping ticks.

5. WEEKDAY     is_follow_up ? follow_up_days : outreach_days must contain IST weekday(now).
               If not → status='pending', scheduled_at = next allowed day at lead.send_time_ist.

6. STALE       now - scheduled_at > stale_send_grace_hours (missed ticks / redeploy / cold start)
                 → reschedule to the next allowed day at lead.send_time_ist rather than blasting
                   a 3-day-late 2am email.

7. SEND        render (§7) → MailComposer → messages.send → read Message-ID back
               status='sent', sent_at, gmail ids persisted.
               On failure: status='pending' + last_error, exponential backoff via scheduled_at
               (2m, 10m, 1h); after 5 attempts status='failed'.
               429 / rateLimitExceeded → back off the whole tick.

8. NEXT STEP   walk sequence_steps forward from step_position:
                 next delay step  → wait_days
                 next email step  → insert sends(
                     status='pending', is_follow_up=true,
                     scheduled_at = nextAllowedDay(sent_at + wait_days) at lead.send_time_ist)
               no further email step → leads.status='sent'
               ← LAZY creation: follow-up N+1 is only created once N is actually sent, so delays are
                 relative to reality, and editing a not-yet-sent step still takes effect.

9. JITTER      await sleep(random(jitter_min, jitter_max)) between sends inside a tick.
               With daily_limit 15 and ≤4 min jitter, a tick never runs long enough to overlap
               the next one meaningfully — but the atomic claim in step 4 makes overlap harmless.
```

### Scheduling math (`schedule.ts`, Luxon)

```ts
// Launch: earliest IST slot that is (a) in the future, (b) an allowed outreach day.
function firstSendAt(sendTimeIst: string, outreachDays: number[]): DateTime {
  let d = DateTime.now().setZone('Asia/Kolkata')
  const [h, m] = sendTimeIst.split(':').map(Number)
  let slot = d.set({ hour: h, minute: m, second: 0, millisecond: 0 })
  if (slot <= d) slot = slot.plus({ days: 1 })
  while (!outreachDays.includes(slot.weekday - 1)) slot = slot.plus({ days: 1 }) // Luxon 1=Mon
  return slot.toUTC()
}
```

Note `outreachDays` is 0=Mon…6=Sun (your `Weekday` type) while Luxon is 1=Mon…7=Sun — the `-1`
is load-bearing. Run the server with `TZ=UTC` and never use the host clock's local time.

---

## 9. Deployment — making sure emails actually go out on time

**Build and run this locally first** (see `TODO.md`); the host is chosen only after a real send,
follow-up and reply-detection cycle works on localhost. Two design rules keep that choice cheap and
late:

1. The tick is driven by a plain function exposed **both** as `node-cron` and as
   `POST /api/cron/tick` (guarded by `CRON_SECRET`). Moving between an always-on host and a sleeping
   free tier is then a config change, not a rewrite.
2. The loop is **catch-up + idempotent** — it claims every `pending` row with `scheduled_at <= now()`
   rather than "this minute". A laptop that was closed for two days catches up correctly on the next
   tick, and the stale-send grace window (§8 step 6) stops it delivering a 3-day-late 2am email.

### Local development

```
Frontend  → vite dev, localhost:5173
Database  → Supabase free project (cloud, even in dev — RLS behaves identically)
Server    → tsx watch, localhost:8080
Tracking  → cloudflared tunnel (Gmail's image proxy cannot reach localhost)
```

Google OAuth works fine against `http://localhost:8080/api/auth/google/callback` — add it as a second
authorized redirect URI alongside the production one.

### When you do deploy

```
Frontend  → Vercel / Cloudflare Pages (static, free)
Database  → Supabase free tier
Server    → ONE always-on Express instance (web service, not a cron-only job)
```

The Express service should be **always-on and single-instance**:

- Always-on because the **tracking pixel and click redirect must answer instantly** — a cold-starting
  free service returns nothing to the recipient's mail client and you lose the event permanently.
- Single-instance because the scheduler is in-process. The `FOR UPDATE SKIP LOCKED` claim makes a
  second instance *safe*, but don't enable autoscaling; there's no reason to.

| Option | Cost | Notes |
|---|---|---|
| **AWS EC2 `t4g.nano`** + systemd | ~$3/mo, or **$0 for 12 months** on the free tier (`t2.micro`/`t3.micro`, 750 h/mo — enough for exactly one always-on instance) | Cheapest if you want zero platform magic. You own nginx/TLS, deploys, and log rotation. Free tier expires 12 months after account creation. |
| **Fly.io** `shared-cpu-1x` 256 MB | ~$2–3/mo | Cheapest managed always-on. Set `min_machines_running = 1` or it suspends and the cron stops. |
| **Oracle Cloud Always Free** ARM VM | $0, indefinitely | 4 OCPU / 24 GB ARM, genuinely free forever. Capacity in a given region is often unavailable, and accounts get reclaimed. |
| Railway Hobby | $5/mo (incl. $5 usage) | Zero-config deploys. Keep **Serverless / App Sleeping OFF** or the scheduler dies after 10 min of no outbound traffic. |
| Render Starter | ~$7/mo | Simplest correct option; no spin-down, `node-cron` runs in-process. |
| Render **Free** web service | $0 | Spins down after 15 min idle with a ~1 min cold start, and 750 free instance-hours vs ~730 h in a month leaves no margin if pinged 24/7. Ticks are missed while asleep. |

**$0-with-a-sleeping-host pattern:** deploy free and have **Supabase `pg_cron` + `pg_net`** POST
`/api/cron/tick` every minute — that both wakes the service and drives the loop, so drop `node-cron`.
Guard it with the `CRON_SECRET` header. Accept two costs: the first tick after idle is ~1 min late,
and open pixels fired during a cold start are lost permanently. cron-job.org works the same way.

Given you want cheap: **EC2 free tier for the first 12 months, then `t4g.nano` or Fly.io.** A single
always-on VM is the right shape here — one process, one cron, no scaling, no queue.

Whichever you pick, the scheduler needs the box's clock to be right — `TZ=UTC` in the environment and
NTP/`chrony` running on a self-managed VM. All IST math is Luxon's, never the host's local time.

### Env vars (server only)

```
PORT, NODE_ENV, TZ=UTC
SUPABASE_URL, SUPABASE_SECRET_KEY            # sb_secret_... NEVER in frontend
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI=https://<server>/api/auth/google/callback
TOKEN_ENCRYPTION_KEY                          # 32 bytes base64, AES-256-GCM
TRACKING_BASE_URL=https://<server>            # or a CNAME'd custom domain
TRACKING_HMAC_SECRET
FRONTEND_URL                                  # CORS origin + OAuth success redirect
CRON_SECRET                                   # only for the external-trigger variant
```

Frontend keeps only `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SERVER_URL`.

### Google Cloud setup checklist

1. New project → enable **Gmail API**.
2. OAuth consent screen: External, add scopes from §2, fill app name/support email.
3. **Publish → In production.** Do *not* submit for verification.
4. Credentials → OAuth client ID → Web application → Authorized redirect URI = your
   `GOOGLE_REDIRECT_URI` (add a `http://localhost:8080/...` one for dev).

---

## 10. Frontend changes this backend requires

1. **Attachments (missing entirely).** Add an attach control to the email step in `ContentStep`:
   upload to Supabase Storage → insert `attachments` → link via `step_attachments`. Show the chip
   only on the opening email if that's your intent; the schema allows it on any step.
2. **Replace mock data with Supabase queries.** `MOCK_LEADS`/`MOCK_TEMPLATES`/`MOCK_SENDERS` →
   `supabase.from(...)`. Map snake_case ↔ camelCase in one place (`lib/mappers.ts`).
3. **Wire Settings "Add account"** → `window.location = ${VITE_SERVER_URL}/api/auth/google`.
   Render `status='needs_reauth'` as a "Reconnect" badge.
4. **Launch/cancel hit the server**, not local state: `POST /api/leads/:id/launch` returns the
   computed `scheduled_at` so the toast can show the real UTC-resolved time.
5. **`SendTestPopover`** → `POST /api/test-send { stepId, to }`.
6. **`LeadStatus` gains `replied`, `failed`, `cancelled`** in `types.ts` + `StatusBadge`.
7. **Move `merge-tags.ts`, `time.ts`, `sequence.ts`, `types.ts` to `shared/`** and re-export from
   `frontend/src/lib` so no component imports change.
8. Supabase Auth login screen (email magic link is enough) — `logout()` already handles the rest.

---

## 11. Build order

| # | Milestone | Done when |
|---|---|---|
| 1 | `supabase/schema.sql` + RLS + Storage bucket applied | Tables visible, publishable key can't read `*_enc` |
| 2 | `shared/` extraction + tsconfig path aliases | Frontend still builds unchanged |
| 3 | Frontend CRUD on real Supabase (leads, templates, sequences, settings) | Mock data deleted |
| 4 | Google OAuth connect/disconnect + Settings wiring | Your Gmail shows in Settings after consent |
| 5 | `send.ts` + `renderEmail.ts` + `POST /api/test-send` | A merge-tagged HTML email with the resume PDF lands in your own inbox |
| 6 | `POST /launch` + `tick.ts` steps 3–7 | One lead sends at its IST time, respects the cap |
| 7 | Follow-ups: step 8 + threading (`threadId` + `References` + same subject) | Follow-up #1 appears in the same Gmail thread |
| 8 | Reply detection: step 2 | Replying from another account cancels pending follow-ups |
| 9 | Tracking endpoints + pixel/link injection + events UI | Open and click rows appear in `events` |
| 10 | Deploy: server always-on, frontend static, redirect URI updated | End-to-end send from production at the scheduled minute |

---

## 12. Gotchas worth pinning

- **Gmail overwrites your `Message-ID`.** Always `messages.get(format=metadata)` after sending to
  capture the real one. Without it, threading is broken.
- **`raw` over 5 MB** must go to `/upload/gmail/v1/...?uploadType=multipart` (35 MB hard ceiling).
  A resume PDF is fine; a deck may not be. Validate `size_bytes` on upload (cap at ~4 MB) so you
  never hit this path.
- **Open tracking is noise.** Apple Mail Privacy Protection and Gmail's image proxy prefetch pixels.
  Dedupe by `send_id` within a few seconds, ignore `GoogleImageProxy` user agents, and treat only
  **clicks and replies** as real signal. `trackOpens` defaults to `false` in your settings — keep it.
- **Your own opens pollute data.** The pixel fires in your Sent copy too. Skip events whose IP is
  yours, or just accept the noise.
- **Tracking domain.** Links pointing at `*.onrender.com` slightly hurt deliverability. CNAME a
  subdomain (`t.yourdomain.com`) once it matters.
- **Deliverability > cap.** 15/day (your current `dailyLimit`) is right. Warm up 5 → 10 → 15 over
  two weeks. Gmail's hard limit is ~500/day but reputation degrades far earlier. Keep bodies
  text-like, one link max in the opening email, and no image beyond the pixel.
- **Reply detection must run before sending in the same tick**, or you send a follow-up to someone
  who replied 40 seconds ago.
- **Never expose `refresh_token_enc`.** Serve `gmail_accounts` to the frontend through a view
  exposing only `email, display_name, daily_limit, status`.
- **Supabase free projects pause after 7 days of inactivity.** A daily cron tick keeps it awake.
- **`gmail.metadata` + `q` is a 403.** If you switch to the tighter scope, all reply detection must
  use `threads.get`, never `messages.list?q=`.
