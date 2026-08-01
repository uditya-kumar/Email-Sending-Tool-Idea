-- Pin search_path so the function body can't resolve through a caller-supplied
-- schema. It is SECURITY INVOKER, so this is defence in depth rather than a
-- privilege-escalation fix, but a trigger that fires on every write is not
-- where you want ambiguity.
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
