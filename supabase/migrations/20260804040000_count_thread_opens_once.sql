-- One read of a thread is one open, however many messages the thread holds.
--
-- The bug: opening a thread makes the mail client fetch the pixel of EVERY
-- message in it. A lead two steps into their sequence therefore recorded two
-- open events per read — 0.05–0.35s apart, one per `send_id` — and
-- `lead_engagement` summed them, so a single read showed as 2 opens. A three-step
-- sequence would have shown 3. Confirmed 2026-08-04 on lead c6fd9e77: 15 open
-- rows across sends ddce56b4 (step 0) and 9f20c024 (step 2) were 10 real reads,
-- six of them sibling pairs inside the same third of a second.
--
-- Why it is fixed here and not in `recordOpen`: that dedupe is keyed on
-- `send_id`, and re-keying it on the lead would still lose the race — the sibling
-- fetches arrive concurrently, so both requests can pass a read-then-insert check
-- before either row is visible to the other. Counting at read time needs no lock
-- and cannot race, and it keeps `events` a faithful log of what was actually
-- fetched. `recordOpen`'s per-send window stays as a cheap row-volume guard.
--
-- The grouping is a gap-based session over the lead's opens: consecutive fetches
-- ≤ 10s apart are one read. Same 10s as `recordOpen`, and deliberately expressed
-- in elapsed time — the earlier `date_trunc('minute')` bucket was wrong precisely
-- because a wall-clock bucket is arbitrary in both directions (see the 2026-08-02
-- note in the view header). Chained on purpose: a client that re-fetches every 9s
-- is one long read, not forty.
create or replace view public.lead_engagement
with (security_invoker = true) as
with
  -- Every open, tagged with whether it opens a new read or continues the one
  -- before it. Partitioned by LEAD, not by send: the whole point is that the
  -- sibling messages of one thread belong to the same read.
  open_fetches as (
    select
      s.lead_id,
      e.created_at,
      e.user_agent,
      case
        when e.created_at
               - lag(e.created_at) over (partition by s.lead_id order by e.created_at)
             <= interval '10 seconds'
        then 0
        else 1
      end as starts_read
    from public.sends s
    join public.events e on e.send_id = s.id
    where e.type = 'open'
  ),
  -- A running sum over that flag numbers the reads: every fetch inside one read
  -- carries the same `read_no`.
  numbered as (
    select
      lead_id,
      created_at,
      user_agent,
      sum(starts_read) over (
        partition by lead_id order by created_at rows unbounded preceding
      ) as read_no
    from open_fetches
  ),
  reads as (
    select
      lead_id,
      read_no,
      max(created_at) as ended_at,
      -- `bool_or`, not a count: this is one read either way, and the question is
      -- only whether a proxy was involved in fetching it.
      bool_or(
        lower(coalesce(user_agent, '')) ~ 'googleimageproxy|yahoomailproxy|ggpht\.com'
      ) as via_proxy
    from numbered
    group by lead_id, read_no
  ),
  opens as (
    select
      lead_id,
      count(*)::int as open_count,
      count(*) filter (where via_proxy)::int as proxy_opens,
      max(ended_at) as last_open_at
    from reads
    group by lead_id
  ),
  -- Clicks and replies keep counting raw rows. A click is a deliberate act, so a
  -- second one is a second click; and the pixel-per-message problem has no
  -- click equivalent, since a link is only in the message it belongs to.
  engagement as (
    select
      s.lead_id,
      count(*) filter (where e.type = 'click')::int as click_count,
      count(distinct case when e.type = 'click' then e.url end)::int as distinct_links,
      count(*) filter (where e.type = 'reply')::int as reply_count,
      max(e.created_at) filter (where e.type = 'click') as last_click_at
    from public.sends s
    -- LEFT, so a lead that was sent to but never engaged still gets a row of
    -- zeroes. An absent row would be indistinguishable from "not sent yet", and
    -- the UI shows those differently (`—` vs `0`).
    left join public.events e on e.send_id = s.id
    group by s.lead_id
  )
select
  g.lead_id,
  -- coalesce because `opens` only has rows for leads that were actually opened,
  -- while `engagement` has one for every lead with a send.
  coalesce(o.open_count, 0)  as open_count,
  coalesce(o.proxy_opens, 0) as proxy_opens,
  g.click_count,
  g.distinct_links,
  g.reply_count,
  o.last_open_at,
  g.last_click_at
from engagement g
left join opens o on o.lead_id = g.lead_id;

revoke all on public.lead_engagement from anon;
grant select on public.lead_engagement to authenticated;
