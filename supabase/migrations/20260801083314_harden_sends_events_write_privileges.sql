-- sends and events are written exclusively by the scheduler and the tracking
-- endpoints (secret key, bypasses RLS). RLS already denies the browser because
-- only a SELECT policy exists, but leaving the default INSERT/UPDATE/DELETE
-- grants in place means the protection rests on a single mechanism. Revoke the
-- privileges too, so a future accidental "for all" policy can't open a hole.
revoke insert, update, delete, truncate, references, trigger
  on public.sends  from anon, authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.events from anon, authenticated;

-- The browser reads its own rows; that's the whole surface it needs.
grant select on public.sends  to authenticated;
grant select on public.events to authenticated;
