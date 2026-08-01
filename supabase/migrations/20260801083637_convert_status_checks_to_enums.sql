-- ═══════════════════════════════════════════════════════════════════════════
--  CHECK constraints → real Postgres enums
--
--  Why: `supabase gen types` renders a CHECK-constrained text column as plain
--  `string`, so `status = 'senting'` compiles clean and the row is simply never
--  claimed by the scheduler — exactly the class of bug generated types were
--  supposed to eliminate. Only true enum types become TS literal unions.
--  Every table is empty, so this conversion is free now and never again.
-- ═══════════════════════════════════════════════════════════════════════════

create type public.lead_status as enum
  ('draft','scheduled','sending','sent','replied','failed','cancelled');
create type public.verification_status as enum
  ('verified','not_verified','invalid');
create type public.send_status as enum
  ('pending','sending','sent','failed','skipped','cancelled');
create type public.event_type as enum
  ('open','click','reply','bounce');
create type public.step_kind as enum ('email','delay');
create type public.account_status as enum ('active','needs_reauth','revoked');

-- ── drop everything that hard-codes the old text values ────────────────────

-- The view reads gmail_accounts.status, so it blocks the ALTER.
drop view if exists public.gmail_accounts_public;

-- Partial index predicates embed 'pending'::text / 'sent'::text.
drop index if exists public.sends_due_idx;
drop index if exists public.sends_account_sent_idx;

-- SQL functions whose bodies compare status to a text literal.
drop function if exists public.claim_due_sends(uuid, int);
drop function if exists public.sent_today_count(uuid);

alter table public.leads          drop constraint if exists leads_status_check;
alter table public.leads          drop constraint if exists leads_verification_check;
alter table public.sends          drop constraint if exists sends_status_check;
alter table public.events         drop constraint if exists events_type_check;
alter table public.gmail_accounts drop constraint if exists gmail_accounts_status_check;
alter table public.sequence_steps drop constraint if exists sequence_steps_kind_check;
alter table public.template_steps drop constraint if exists template_steps_kind_check;
-- These reference kind = 'delay'::text, so they must be rebuilt against the enum.
alter table public.sequence_steps drop constraint if exists sequence_steps_shape;
alter table public.template_steps drop constraint if exists template_steps_shape;

-- ── convert the columns ────────────────────────────────────────────────────
-- Defaults are dropped first: Postgres refuses to cast an existing default
-- expression to a new type automatically.

alter table public.leads alter column status drop default;
alter table public.leads
  alter column status type public.lead_status using status::public.lead_status;
alter table public.leads alter column status set default 'draft';

alter table public.leads alter column verification drop default;
alter table public.leads
  alter column verification type public.verification_status
    using verification::public.verification_status;
alter table public.leads alter column verification set default 'not_verified';

alter table public.sends alter column status drop default;
alter table public.sends
  alter column status type public.send_status using status::public.send_status;
alter table public.sends alter column status set default 'pending';

alter table public.events
  alter column type type public.event_type using type::public.event_type;

alter table public.gmail_accounts alter column status drop default;
alter table public.gmail_accounts
  alter column status type public.account_status using status::public.account_status;
alter table public.gmail_accounts alter column status set default 'active';

alter table public.sequence_steps
  alter column kind type public.step_kind using kind::public.step_kind;
alter table public.template_steps
  alter column kind type public.step_kind using kind::public.step_kind;

-- ── rebuild the shape constraints against the enum ─────────────────────────
alter table public.sequence_steps add constraint sequence_steps_shape check (
  (kind = 'delay' and wait_days is not null) or
  (kind = 'email' and wait_days is null)
);
alter table public.template_steps add constraint template_steps_shape check (
  (kind = 'delay' and wait_days is not null) or
  (kind = 'email' and wait_days is null)
);

-- ── rebuild the scheduler's indexes ────────────────────────────────────────
create index sends_due_idx
  on public.sends (status, scheduled_at) where status = 'pending';
create index sends_account_sent_idx
  on public.sends (gmail_account_id, sent_at) where status = 'sent';

-- ── rebuild the view + its privileges ──────────────────────────────────────
create view public.gmail_accounts_public
with (security_invoker = false) as
  select id, email, display_name, daily_limit, status, created_at
  from public.gmail_accounts
  where user_id = auth.uid();

revoke all on public.gmail_accounts_public from anon;
grant select on public.gmail_accounts_public to authenticated;

-- ── rebuild the scheduler RPCs ─────────────────────────────────────────────
create function public.claim_due_sends(p_account_id uuid, p_limit int)
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
      order by c.scheduled_at
      limit greatest(p_limit, 0)
      for update skip locked
   )
  returning s.*;
$$;

create function public.sent_today_count(p_account_id uuid)
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
     and sent_at >= (date_trunc('day', now() at time zone 'Asia/Kolkata')
                       at time zone 'Asia/Kolkata');
$$;

revoke all on function public.claim_due_sends(uuid, int) from public, anon, authenticated;
revoke all on function public.sent_today_count(uuid)     from public, anon, authenticated;
grant execute on function public.claim_due_sends(uuid, int) to service_role;
grant execute on function public.sent_today_count(uuid)     to service_role;
