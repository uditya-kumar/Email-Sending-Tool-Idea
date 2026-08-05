-- One lead, one sending mailbox — enforced in the database.
--
-- With several Gmail accounts connected, new leads are distributed between them
-- (`assign-account.ts`). A *follow-up*, though, is threaded onto the conversation
-- the opening email started: it carries that message's `threadId`,
-- `In-Reply-To`/`References` and subject. All of those are per-mailbox. Sending a
-- follow-up from a different account cannot silently degrade to "a new thread" —
-- it produces a recipient who is being emailed by two strangers inside one
-- conversation, which is both confusing and the exact shape of a spoofing attempt.
--
-- The application already assigns correctly: the launch route pins the account
-- onto the opening `sends` row and `enqueueNextStep` copies it from the parent.
-- This trigger exists because that is an *invariant*, and an invariant that lives
-- only in application code is one release away from being violated by a caller
-- that forgets. There is no query the scheduler could run afterwards to detect the
-- mistake — by then the email has been delivered.
--
-- Deliberately a trigger and not a constraint: the rule spans rows of the same
-- table (every send for a lead must agree), which no CHECK can express and which
-- would otherwise need a denormalised `leads.gmail_account_id` column kept in step
-- by hand.
create or replace function public.enforce_lead_account_affinity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  pinned uuid;
begin
  -- The account any earlier send for this lead already uses. `id <> new.id`
  -- matters on UPDATE, where the row being written is itself in the table.
  select s.gmail_account_id
    into pinned
    from public.sends s
   where s.lead_id = new.lead_id
     and s.id <> new.id
   limit 1;

  if pinned is not null and pinned <> new.gmail_account_id then
    raise exception
      'lead % already sends from Gmail account %; a send from % would put two '
      'different senders in one thread',
      new.lead_id, pinned, new.gmail_account_id
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

-- `update of gmail_account_id` rather than a bare `update`: every tick writes to
-- these rows (status, claimed_at, sent_at, the rendered body), and re-running this
-- lookup on each of those would add a query per send for a column that never
-- changes.
drop trigger if exists sends_lead_account_affinity on public.sends;
create trigger sends_lead_account_affinity
  before insert or update of gmail_account_id on public.sends
  for each row execute function public.enforce_lead_account_affinity();
