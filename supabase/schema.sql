-- ═══════════════════════════════════════════════════════════════════════════
--  Cold Email Outreach Tool — full schema
--  Single user. Frontend reads/writes directly with the PUBLISHABLE key under
--  RLS; the Express server uses the SECRET key (bypasses RLS entirely).
--
--  Idempotent: safe to re-run. Paste into the Supabase SQL editor and Run.
--  See BACKEND_PLAN.md §4 for the rationale behind each table.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── extensions ─────────────────────────────────────────────────────────────
create extension if not exists pgcrypto with schema extensions;  -- gen_random_uuid()


-- ── enums ───────────────────────────────────────────────────────────────────
--  Real enum types, not CHECK-constrained text, and the difference is load
--  bearing: `supabase gen types` renders a CHECK'd text column as plain
--  `string`, so `status = 'senting'` would compile clean and the row would
--  simply never be claimed by the scheduler. Only true enums become TS literal
--  unions, which is the whole reason we generate types.
--
--  Wrapped in exception blocks because `create type` has no IF NOT EXISTS.
do $$
begin
  create type public.lead_status as enum
    ('draft','scheduled','sending','sent','replied','failed','cancelled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.verification_status as enum
    ('verified','not_verified','invalid');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.send_status as enum
    ('pending','sending','sent','failed','skipped','cancelled');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.event_type as enum ('open','click','reply','bounce');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.step_kind as enum ('email','delay');
exception when duplicate_object then null;
end $$;

do $$
begin
  create type public.account_status as enum ('active','needs_reauth','revoked');
exception when duplicate_object then null;
end $$;


-- ── shared trigger: keep updated_at honest ──────────────────────────────────
-- search_path is pinned: this fires on every write, and that is not a place to
-- leave schema resolution up to the caller.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;


-- ═══════════════════════════════════════════════════════════════════════════
--  1. gmail_accounts — the connected sender (SenderAccount)
--
--  Holds the encrypted OAuth refresh token, so the frontend must NEVER be able
--  to select from this table. Table privileges are revoked below; the browser
--  reads the safe subset through gmail_accounts_public instead.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.gmail_accounts (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null default auth.uid()
                             references auth.users(id) on delete cascade,
  email                    text not null,
  display_name             text,
  google_sub               text not null,

  -- AES-256-GCM ciphertext, decrypted only in the Express server.
  refresh_token_enc        text not null,
  access_token_enc        text,
  access_token_expires_at  timestamptz,

  scopes                   text[] not null default '{}',
  daily_limit              int  not null default 15
                             check (daily_limit > 0 and daily_limit <= 500),

  -- What share of daily_limit is held back for follow-ups, as a percentage.
  --
  -- Without a reserved share the two classes compete on scheduled_at alone, so
  -- which ones go out is decided by whose send_time_ist happens to be earliest
  -- that day — and a growing follow-up backlog can starve new outreach for days,
  -- or the reverse. 60 means "at most 60% of the cap on follow-ups".
  --
  -- A *percentage* rather than a count so it survives a change to daily_limit:
  -- raising the cap 10 → 15 during warm-up keeps the balance the user chose
  -- instead of quietly handing every new slot to one class.
  --
  -- It is only ever a ceiling. `runForAccount` lets either class borrow the
  -- other's unused slots, so 0 pending follow-ups still means a full day of
  -- outreach. 0 and 100 are therefore both meaningful: "only follow-ups when
  -- there's nothing else" and "follow-ups first, always".
  follow_up_share_pct      int  not null default 50
                             check (follow_up_share_pct between 0 and 100),
  status                   public.account_status not null default 'active',

  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- `create table if not exists` above is a no-op on a database that already has
-- the table, so a column added after the first deploy needs saying twice. This
-- is what keeps the file runnable start-to-finish against a live database as
-- well as an empty one.
alter table public.gmail_accounts
  add column if not exists follow_up_share_pct int not null default 50;

do $$
begin
  alter table public.gmail_accounts
    add constraint gmail_accounts_follow_up_share_pct_check
    check (follow_up_share_pct between 0 and 100);
exception
  when duplicate_object then null;   -- already added by the create table above
end $$;

create unique index if not exists gmail_accounts_email_key
  on public.gmail_accounts (user_id, lower(email));

drop trigger if exists gmail_accounts_touch on public.gmail_accounts;
create trigger gmail_accounts_touch before update on public.gmail_accounts
  for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
--  2. leads — one recipient (Lead in shared/types.ts)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.leads (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null default auth.uid()
                         references auth.users(id) on delete cascade,

  company_name         text not null default '',
  first_name           text not null default '',
  last_name            text not null default '',
  email                text not null
                         check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  personalization_line text not null default '',

  -- "HH:mm" 24h in IST. Mirrors isValidIST() in shared/time.ts.
  send_time_ist        text not null default '10:00'
                         check (send_time_ist ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),

  job_title            text,
  website              text,

  verification         public.verification_status not null default 'not_verified',
  status               public.lead_status not null default 'draft',

  -- Set by reply detection. Non-null is what stops every pending follow-up.
  replied_at           timestamptz,

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One row per person: re-importing the same CSV must not duplicate a lead.
create unique index if not exists leads_email_key
  on public.leads (user_id, lower(email));
create index if not exists leads_status_idx on public.leads (user_id, status);

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
--  3. templates + template_steps — reusable sequence blueprints (EmailTemplate)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.templates (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid()
               references auth.users(id) on delete cascade,
  name       text not null default 'Untitled template',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists templates_touch on public.templates;
create trigger templates_touch before update on public.templates
  for each row execute function public.touch_updated_at();

create table if not exists public.template_steps (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id) on delete cascade,
  position    int  not null check (position >= 0),
  kind        public.step_kind not null,
  name        text not null default '',

  -- Email steps: may be empty while being drafted (the frontend creates blank
  -- follow-ups), so emptiness is validated at launch, not here.
  subject     text,
  body_html   text,

  -- Delay steps only.
  wait_days   int check (wait_days >= 0),

  constraint template_steps_shape check (
    (kind = 'delay' and wait_days is not null) or
    (kind = 'email' and wait_days is null)
  ),

  -- DEFERRABLE so reordering steps inside one transaction doesn't trip the
  -- constraint mid-update. Consequence: never ON CONFLICT on (template_id,
  -- position) — upsert on the primary key instead.
  constraint template_steps_position_key
    unique (template_id, position) deferrable initially deferred
);

create index if not exists template_steps_template_idx
  on public.template_steps (template_id, position);


-- ═══════════════════════════════════════════════════════════════════════════
--  4. sequence_steps — each lead's OWN copy of the sequence (SequencesByLead)
--
--  Deliberately not shared with template_steps: per-recipient personalization
--  is the whole point, so applying a template COPIES rows in here.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.sequence_steps (
  id        uuid primary key default gen_random_uuid(),
  lead_id   uuid not null references public.leads(id) on delete cascade,
  position  int  not null check (position >= 0),
  kind      public.step_kind not null,
  name      text not null default '',
  subject   text,
  body_html text,
  wait_days int check (wait_days >= 0),

  constraint sequence_steps_shape check (
    (kind = 'delay' and wait_days is not null) or
    (kind = 'email' and wait_days is null)
  ),
  constraint sequence_steps_position_key
    unique (lead_id, position) deferrable initially deferred
);

create index if not exists sequence_steps_lead_idx
  on public.sequence_steps (lead_id, position);


-- ═══════════════════════════════════════════════════════════════════════════
--  5. attachments — the resume, in Supabase Storage
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.attachments (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid()
                 references auth.users(id) on delete cascade,
  filename     text not null,                 -- as the recipient sees it
  storage_path text not null unique,           -- attachments/<uid>/<uuid>.pdf
  mime_type    text not null,
  -- A backstop, NOT the real limit. 4 MB is not actually safe to send:
  -- messages.send takes the whole MIME base64-encoded, which inflates by 4/3, so
  -- 4 MB becomes ~5.33 MB of `raw` and trips GmailMailer's 5,000,000 ceiling —
  -- after the upload has already succeeded. The enforced limit is
  -- MAX_ATTACHMENT_BYTES in shared/attachments.ts (3.5 MB, applied to a step's
  -- *total*, since Gmail's limit is per message rather than per file).
  size_bytes   int  not null check (size_bytes > 0 and size_bytes <= 4194304),
  created_at   timestamptz not null default now()
);

create table if not exists public.step_attachments (
  step_id       uuid not null references public.sequence_steps(id) on delete cascade,
  attachment_id uuid not null references public.attachments(id)   on delete cascade,
  primary key (step_id, attachment_id)
);

create table if not exists public.template_step_attachments (
  template_step_id uuid not null references public.template_steps(id) on delete cascade,
  attachment_id    uuid not null references public.attachments(id)    on delete cascade,
  primary key (template_step_id, attachment_id)
);


-- ═══════════════════════════════════════════════════════════════════════════
--  6. sends — one row per outbound email. The scheduler's work queue.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.sends (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid()
                        references auth.users(id) on delete cascade,
  lead_id             uuid not null references public.leads(id) on delete cascade,

  -- Nulled rather than cascaded: a sent email stays in the log even if the
  -- step it came from is later deleted.
  step_id             uuid references public.sequence_steps(id) on delete set null,
  gmail_account_id    uuid not null references public.gmail_accounts(id),

  step_position       int     not null,        -- survives step deletion
  is_follow_up        boolean not null default false,

  status              public.send_status not null default 'pending',
  scheduled_at        timestamptz not null,    -- UTC, from send_time_ist
  claimed_at          timestamptz,
  sent_at             timestamptz,

  -- Exactly what went out. Audit trail + proves preview/send parity.
  subject_rendered    text,
  body_html_rendered  text,

  gmail_message_id    text,   -- Gmail's internal id
  gmail_thread_id     text,   -- threading target for the next follow-up
  -- The RFC Message-ID Gmail ASSIGNED (read back via messages.get). Gmail
  -- overwrites whatever Nodemailer generates, so this can only be populated
  -- after the send. Follow-up In-Reply-To/References come from here.
  rfc822_message_id   text,

  -- Public, unguessable id used in the pixel and click URLs. Never expose
  -- sends.id in an email.
  tracking_id         uuid not null default gen_random_uuid(),

  attempt_count       int  not null default 0,
  last_error          text,
  created_at          timestamptz not null default now()
);

-- The scheduler's hot path.
create index if not exists sends_due_idx
  on public.sends (status, scheduled_at) where status = 'pending';
create index if not exists sends_lead_idx on public.sends (lead_id);
create index if not exists sends_account_sent_idx
  on public.sends (gmail_account_id, sent_at) where status = 'sent';
create unique index if not exists sends_tracking_id_key
  on public.sends (tracking_id);

-- Idempotency: a lead can never have two send rows for the same step, so a
-- retried launch or an overlapping tick cannot double-send. NOT deferrable —
-- ON CONFLICT DO NOTHING relies on it.
create unique index if not exists sends_lead_step_key
  on public.sends (lead_id, step_position);


-- ═══════════════════════════════════════════════════════════════════════════
--  7. events — opens, clicks, replies
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.events (
  id         bigint generated by default as identity primary key,
  user_id    uuid not null default auth.uid()
               references auth.users(id) on delete cascade,
  send_id    uuid not null references public.sends(id) on delete cascade,
  type       public.event_type not null,
  url        text,                             -- clicks only
  user_agent text,
  ip         inet,
  created_at timestamptz not null default now()
);

create index if not exists events_send_idx on public.events (send_id, type);
create index if not exists events_recent_idx on public.events (user_id, created_at desc);


-- ═══════════════════════════════════════════════════════════════════════════
--  8. settings — exactly one row (SequenceSettings)
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.settings (
  user_id                uuid primary key default auth.uid()
                           references auth.users(id) on delete cascade,

  track_opens            boolean not null default false,
  track_clicks           boolean not null default false,

  -- 0 = Monday … 6 = Sunday, matching the Weekday type. NOT Luxon's 1-7.
  --
  -- Never empty. Every scheduling function raises `NoAllowedDayError` on an empty
  -- day list rather than inventing a day, and that throw used to escape the tick
  -- entirely: one cleared list stalled the whole send queue, silently, until
  -- somebody read the logs. The Settings picker locks the last enabled day, and this
  -- is the guarantee behind it — the browser writes this table directly under RLS,
  -- so the constraint is the only thing a hand-crafted PATCH has to get past.
  --
  -- `cardinality`, NOT `array_length(x, 1)`: on an empty array array_length returns
  -- NULL rather than 0, making the comparison NULL — which a CHECK constraint
  -- accepts. The first attempt at this used array_length and let the exact write it
  -- existed to block straight through. cardinality('{}') is 0.
  outreach_days          int[] not null default '{0,1,2,3}'
                           check (cardinality(outreach_days) >= 1),
  follow_up_days         int[] not null default '{0,1,2,3,4}'
                           check (cardinality(follow_up_days) >= 1),

  -- Random gap between consecutive sends, for deliverability.
  jitter_min_seconds     int not null default 45  check (jitter_min_seconds >= 0),
  jitter_max_seconds     int not null default 240 check (jitter_max_seconds >= 0),
  -- Past this, a missed send is rescheduled instead of firing late at 2am.
  stale_send_grace_hours int not null default 6   check (stale_send_grace_hours > 0),

  constraint settings_jitter_order check (jitter_max_seconds >= jitter_min_seconds),
  updated_at             timestamptz not null default now()
);

drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();


-- ═══════════════════════════════════════════════════════════════════════════
--  9. oauth_states — CSRF protection for the Google connect flow
--  Server-only. RLS on with no policies = nobody but the secret key.
-- ═══════════════════════════════════════════════════════════════════════════
create table if not exists public.oauth_states (
  state      text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '10 minutes'
);


-- ═══════════════════════════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════
alter table public.gmail_accounts           enable row level security;
alter table public.leads                    enable row level security;
alter table public.templates                enable row level security;
alter table public.template_steps           enable row level security;
alter table public.sequence_steps           enable row level security;
alter table public.attachments              enable row level security;
alter table public.step_attachments         enable row level security;
alter table public.template_step_attachments enable row level security;
alter table public.sends                    enable row level security;
alter table public.events                   enable row level security;
alter table public.settings                 enable row level security;
alter table public.oauth_states             enable row level security;

-- Own-rows policies for the tables the browser both reads and writes.
do $$
declare t text;
begin
  foreach t in array array['leads','templates','attachments']
  loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format($f$
      create policy own_rows on public.%I
        for all to authenticated
        using (user_id = auth.uid())
        with check (user_id = auth.uid())
    $f$, t);
  end loop;
end $$;

-- sends and events are READ-ONLY to the browser: the scheduler and the tracking
-- endpoints own them. The UI shows status and engagement; it must not be able to
-- forge a send row or fake an open.
do $$
declare t text;
begin
  foreach t in array array['sends','events']
  loop
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('drop policy if exists read_own on public.%I', t);
    execute format($f$
      create policy read_own on public.%I
        for select to authenticated
        using (user_id = auth.uid())
    $f$, t);
  end loop;
end $$;

-- settings is keyed by user_id rather than having one.
drop policy if exists own_rows on public.settings;
create policy own_rows on public.settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Child tables inherit ownership through their parent.
drop policy if exists own_rows on public.template_steps;
create policy own_rows on public.template_steps
  for all to authenticated
  using (exists (select 1 from public.templates t
                  where t.id = template_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.templates t
                  where t.id = template_id and t.user_id = auth.uid()));

drop policy if exists own_rows on public.sequence_steps;
create policy own_rows on public.sequence_steps
  for all to authenticated
  using (exists (select 1 from public.leads l
                  where l.id = lead_id and l.user_id = auth.uid()))
  with check (exists (select 1 from public.leads l
                  where l.id = lead_id and l.user_id = auth.uid()));

drop policy if exists own_rows on public.step_attachments;
create policy own_rows on public.step_attachments
  for all to authenticated
  using (exists (select 1 from public.sequence_steps s join public.leads l on l.id = s.lead_id
                  where s.id = step_id and l.user_id = auth.uid()))
  with check (exists (select 1 from public.sequence_steps s join public.leads l on l.id = s.lead_id
                  where s.id = step_id and l.user_id = auth.uid()));

drop policy if exists own_rows on public.template_step_attachments;
create policy own_rows on public.template_step_attachments
  for all to authenticated
  using (exists (select 1 from public.template_steps ts join public.templates t on t.id = ts.template_id
                  where ts.id = template_step_id and t.user_id = auth.uid()))
  with check (exists (select 1 from public.template_steps ts join public.templates t on t.id = ts.template_id
                  where ts.id = template_step_id and t.user_id = auth.uid()));

-- gmail_accounts and oauth_states get NO policies on purpose: only the secret
-- key (which bypasses RLS) may touch them.

-- Belt and braces on sends/events: RLS already denies writes (there is only a
-- SELECT policy), but leaving the default INSERT/UPDATE/DELETE grants in place
-- means that protection rests on a single mechanism. Revoke the privileges too,
-- so a future accidental `for all` policy still can't open a hole.
revoke insert, update, delete, truncate, references, trigger
  on public.sends  from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.events from anon, authenticated;
grant select on public.sends  to authenticated;
grant select on public.events to authenticated;


-- ═══════════════════════════════════════════════════════════════════════════
--  gmail_accounts_public — the only way the browser sees a connected account
--
--  Table privileges are revoked below, so this view is the sole path and it
--  cannot leak refresh_token_enc. It runs with the view owner's rights (not
--  security_invoker) precisely because the base table denies the caller, so it
--  filters on auth.uid() itself.
-- ═══════════════════════════════════════════════════════════════════════════
-- Dropped rather than replaced: `create or replace view` cannot add a column in
-- the middle of the list, and adding follow_up_share_pct after created_at just to
-- appease that would put the two budget fields in different places here and in
-- the table.
drop view if exists public.gmail_accounts_public;
create view public.gmail_accounts_public
with (security_invoker = false) as
  select id, email, display_name, daily_limit, follow_up_share_pct, status, created_at
  from public.gmail_accounts
  where user_id = auth.uid();

revoke all on public.gmail_accounts from anon, authenticated;
revoke all on public.oauth_states  from anon, authenticated;
revoke all on public.gmail_accounts_public from anon;
grant select on public.gmail_accounts_public to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
--  lead_engagement — per-recipient open/click counts for the Database table
--
--  A view rather than counter columns on `leads`, because `events` already
--  stores one row per event: a count is derivable, and a denormalised counter
--  would be a second source of truth that the tracking endpoints could fail to
--  increment. Aggregating in Postgres also beats shipping every event row to
--  the browser to be counted there.
--
--  The counts are per LEAD, not per send: a lead's sequence is several emails
--  in one thread, and "did this person engage" is the question the table
--  answers. One open is often Apple Mail Privacy Protection or a proxy prefetch,
--  while a second read later is a human — so it is the open *count*, not the
--  fact of an open, that the UI leans on.
--
--  `open_count` is a plain row count. Deduplication happens once, in
--  `recordOpen`, which refuses a second open on the same send within 10 seconds;
--  by the time a row exists it has already earned its place. This view used to
--  re-dedupe on `date_trunc('minute', created_at)`, which was wrong twice over:
--  it bucketed on the wall clock rather than elapsed time (two fetches 2s apart
--  either side of :00 counted twice, two fetches 49s apart inside one minute
--  counted once), and it discarded deliberate re-opens — the exact evidence of a
--  human that the count exists to surface. Removed 2026-08-02 after three real
--  re-opens 11–16s apart were each silently collapsed.
--
--  `proxy_opens` counts opens fetched through a provider's image proxy. Note
--  this is NOT a noise count to subtract: Gmail serves every image through
--  GoogleImageProxy, including the fetch a human opening the message causes, so
--  a Gmail recipient's opens are all "proxy" opens and are all real. It exists
--  only so the UI can hedge the *single*-open case, where the ambiguity actually
--  lives (a lone open seconds after delivery is likely a prefetch).
--
--  security_invoker = true (unlike gmail_accounts_public): the browser is
--  allowed to select `events` and `sends` directly, so the caller's own RLS
--  policies already scope this correctly and the view needs no auth.uid()
--  filter of its own. It has no privileges the caller lacks.
-- ═══════════════════════════════════════════════════════════════════════════
create or replace view public.lead_engagement
with (security_invoker = true) as
  select
    s.lead_id,
    -- One row, one open. See the header note on why there is no second dedupe
    -- layer here: `recordOpen`'s 10s window is the only one, and adding a
    -- coarser bucket on top of it threw away real re-opens.
    count(*) filter (where e.type = 'open')::int  as open_count,
    -- Kept in sync with PROXY_AGENT_MARKERS in server/src/data/events.ts.
    count(*) filter (
      where e.type = 'open'
        and lower(coalesce(e.user_agent, '')) ~ 'googleimageproxy|yahoomailproxy|ggpht\.com'
    )::int as proxy_opens,
    count(*) filter (where e.type = 'click')::int as click_count,
    count(distinct case when e.type = 'click' then e.url end)::int as distinct_links,
    count(*) filter (where e.type = 'reply')::int as reply_count,
    max(e.created_at) filter (where e.type = 'open')  as last_open_at,
    max(e.created_at) filter (where e.type = 'click') as last_click_at
  from public.sends s
  -- LEFT, so a lead that was sent to but never engaged still gets a row of
  -- zeroes. An absent row would be indistinguishable from "not sent yet".
  left join public.events e on e.send_id = s.id
  group by s.lead_id;

revoke all on public.lead_engagement from anon;
grant select on public.lead_engagement to authenticated;

-- The send budget — the only gmail_accounts fields the UI edits
-- (SenderLimitDialog). Both in one function because they are edited together and
-- read together by the tick: two RPCs would let a failure between them leave a
-- cap the user never chose paired with a share they did.
create or replace function public.set_send_budget(
  p_account_id       uuid,
  p_limit            int,
  p_follow_up_share  int
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit < 1 or p_limit > 500 then
    raise exception 'daily_limit must be between 1 and 500';
  end if;

  if p_follow_up_share < 0 or p_follow_up_share > 100 then
    raise exception 'follow_up_share_pct must be between 0 and 100';
  end if;

  update public.gmail_accounts
     set daily_limit         = p_limit,
         follow_up_share_pct = p_follow_up_share
   where id = p_account_id
     and user_id = auth.uid();   -- scoped to the caller, not just the id
end;
$$;

revoke all on function public.set_send_budget(uuid, int, int) from public, anon;
grant execute on function public.set_send_budget(uuid, int, int) to authenticated, service_role;

-- Superseded by set_send_budget. Dropped rather than left in place: it can still
-- write daily_limit without touching the share, which is exactly the half-applied
-- state the combined function exists to prevent.
drop function if exists public.set_daily_limit(uuid, int);


-- ═══════════════════════════════════════════════════════════════════════════
--  SCHEDULER RPCs — the parts supabase-js cannot express
-- ═══════════════════════════════════════════════════════════════════════════

-- Atomically claim the due sends for one account.
--
-- FOR UPDATE SKIP LOCKED is what makes the loop safe across restarts and
-- overlapping ticks: two concurrent callers can never claim the same row, so
-- an email cannot be sent twice. Server-only (secret key).
-- p_is_follow_up restricts the claim to one class of email — follow-ups (true),
-- opening emails (false), or either (null). That is what lets `runForAccount`
-- give each class its own share of the daily cap: without it the claim is FIFO on
-- scheduled_at across both, so which emails go out on a capped day is decided by
-- whose send_time_ist happens to be earliest, and a backlog on one side starves
-- the other. Null is kept for a caller that wants the plain oldest-first
-- behaviour.
create or replace function public.claim_due_sends(
  p_account_id   uuid,
  p_limit        int,
  p_is_follow_up boolean default null
)
returns setof public.sends
language sql
security definer
set search_path = public
as $$
  update public.sends s
     set status        = 'sending',
         claimed_at    = now(),
         attempt_count = s.attempt_count + 1
   where s.id in (
     select c.id
       from public.sends c
      where c.gmail_account_id = p_account_id
        and c.status = 'pending'
        and c.scheduled_at <= now()
        and (p_is_follow_up is null or c.is_follow_up = p_is_follow_up)
      order by c.scheduled_at
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning s.*;
$$;

-- The two-argument version, left behind by the signature change above. Postgres
-- treats a new default as a *different* function rather than a replacement, so
-- without this drop both exist and `db.rpc("claim_due_sends", …)` with two
-- arguments resolves to the old one — which ignores p_is_follow_up entirely and
-- would silently undo the split.
drop function if exists public.claim_due_sends(uuid, int);

-- How many emails this account has already sent "today" in IST — the daily cap
-- is a human-facing, IST-day notion, not a UTC-day one.
--
-- p_is_follow_up splits the count the same way it splits the claim, and the tick
-- needs it that way: a class's share is a fraction of the whole day's cap, so
-- deciding how much of it is left means knowing how many of *that class* have
-- already gone out. Counting only the total would let the split drift with every
-- tick — six follow-ups sent this morning would still leave a full follow-up
-- allowance this afternoon.
create or replace function public.sent_today_count(
  p_account_id   uuid,
  p_is_follow_up boolean default null
)
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from public.sends
   where gmail_account_id = p_account_id
     and status = 'sent'
     and (p_is_follow_up is null or is_follow_up = p_is_follow_up)
     and sent_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata')
                       at time zone 'Asia/Kolkata');
$$;

-- Same reason as the claim: a new default argument creates a second function
-- rather than replacing the old one, and a one-argument call would keep resolving
-- to the version that cannot tell the two classes apart.
drop function if exists public.sent_today_count(uuid);

-- Revoking from PUBLIC strips the default EXECUTE for every role, including the
-- secret key's, so service_role has to be granted back explicitly.
revoke all on function public.claim_due_sends(uuid, int, boolean) from public, anon, authenticated;
revoke all on function public.sent_today_count(uuid, boolean)     from public, anon, authenticated;
grant execute on function public.claim_due_sends(uuid, int, boolean) to service_role;
grant execute on function public.sent_today_count(uuid, boolean)     to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
--  STORAGE — private bucket for the resume
-- ═══════════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'attachments', 'attachments', false, 4194304,
  array['application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Objects live at attachments/<user_id>/<uuid>.<ext>, so the first path
-- segment is the ownership check.
drop policy if exists attachments_own_files on storage.objects;
create policy attachments_own_files on storage.objects
  for all to authenticated
  using (bucket_id = 'attachments'
         and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'attachments'
         and (storage.foldername(name))[1] = auth.uid()::text);


-- ═══════════════════════════════════════════════════════════════════════════
--  SEED — one settings row for the signed-in user
--  Run this separately AFTER creating your user in Authentication → Users.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.settings (user_id)
select id from auth.users
on conflict (user_id) do nothing;
