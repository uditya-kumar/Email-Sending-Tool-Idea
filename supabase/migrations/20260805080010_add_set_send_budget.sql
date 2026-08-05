-- The send budget RPC — the only way the browser may write to `gmail_accounts`.
--
-- Already live in production when this file was written: it was applied straight
-- to the database and recorded in `schema.sql`, but never captured as a migration.
-- That gap is the bug this fixes. `schema.sql` is the source of truth for a
-- rebuild, but a rebuild driven from `migrations/` alone would have come up
-- without this function, and the Settings send-budget dialog would fail at
-- runtime with "function does not exist" — the one place the UI writes a cap.
--
-- Written to be re-runnable against the database that already has it: the body
-- below is byte-identical in behaviour to the deployed definition (verified with
-- `pg_get_functiondef` before committing), so `create or replace` is a no-op
-- there and a create on a fresh one.
--
-- Why a SECURITY DEFINER function rather than a grant: the browser has no UPDATE
-- privilege on `gmail_accounts` at all, and it must not have one — that table
-- holds `refresh_token_enc`, so the frontend reads the `gmail_accounts_public`
-- view and cannot touch the base table. `daily_limit` and `follow_up_share_pct`
-- are the only two fields of it the UI is allowed to change, so they get one
-- narrow, validated entry point instead.
--
-- Both fields in one function because they are edited together and read together
-- by every tick: two RPCs would let a failure between them leave a cap the user
-- never chose paired with a share they did.
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
  -- Range-checked here and not only in the dialog: SECURITY DEFINER runs as the
  -- owner, so this function is the one place a caller can bypass the table
  -- grants. An unvalidated cap would let the browser lift its own daily limit,
  -- which is the whole point of having one.
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

-- `anon` is revoked as well as `public`: this is reachable with the publishable
-- key, so a signed-out caller must not be able to invoke it even though the
-- `auth.uid()` filter would match no rows.
revoke all on function public.set_send_budget(uuid, int, int) from public, anon;
grant execute on function public.set_send_budget(uuid, int, int) to authenticated, service_role;

-- Superseded by set_send_budget. Dropped rather than left in place: it can still
-- write daily_limit without touching the share, which is exactly the half-applied
-- state the combined function exists to prevent.
drop function if exists public.set_daily_limit(uuid, int);
