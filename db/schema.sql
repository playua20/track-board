-- track-board — the ONE database object this project owns.
--
-- The database is shared with ../server-side-tracking and belongs to it: the
-- tables, the retention, the RLS posture and dashboard_stats() are all defined
-- over there and are not touched from here. This file is additive only.
--
-- Why a function of our own rather than more fields on dashboard_stats():
-- two blocks of SPEC.md need figures the shared function does not report, and
-- extending it would mean editing the neighbour's repository for columns only
-- this page shows.
--
--   §4.5  a country table with leads and a conversion rate — byCountry gives
--         events per country and nothing else;
--   §4.4  an area chart split by event type over a CONTINUOUS axis — byHour is
--         a flat total, capped at 48 rows, and skips hours that had no events,
--         so a chart drawn straight from it invents a slope across every gap.
--
-- One extra round trip, and the neighbour stays untouched.
-- Idempotent: `create or replace`. Apply with `npm run db:apply`.

drop function if exists board_geo(text, timestamptz);

create or replace function board_detail(p_site text default null,
                                        p_since timestamptz default null)
returns jsonb
language sql
stable
security invoker
as $$
  with ev as (
    select created_at, type, coalesce(country, '??') as country
    from events
    where (p_site is null or site = p_site)
      and (p_since is null or created_at >= p_since)
  ),
  -- `all` has no start date of its own: it begins at the oldest row there is.
  bounds as (
    select coalesce(p_since, (select min(created_at) from ev), now()) as lo,
           now() as hi
  ),
  -- The bucket follows the span rather than the selected period, so the axis
  -- carries a comparable number of points whatever is asked for — and an `all`
  -- window over a database only days old still gets hourly resolution.
  step as (
    select case when (select hi - lo from bounds) <= interval '10 days'
                then 'hour' else 'day' end as unit,
           case when (select hi - lo from bounds) <= interval '10 days'
                then interval '1 hour' else interval '1 day' end as iv
  ),
  -- Every bucket in the range exists, with or without events. A zero is a fact
  -- about that hour; a missing row would be drawn as a straight line to the
  -- next one that has data.
  axis as (
    select generate_series(
      date_trunc((select unit from step), (select lo from bounds)),
      date_trunc((select unit from step), (select hi from bounds)),
      (select iv from step)) as t
  ),
  agg as (
    select date_trunc((select unit from step), created_at) as t, type, count(*)::int as n
    from ev group by 1, 2
  ),
  -- Per bucket as well, so the Conversions and Revenue tiles can carry a
  -- sparkline like the two beside them. Bucketed by when the POSTBACK landed,
  -- which is when the money was settled — not by when the click happened.
  cvb as (
    select date_trunc((select unit from step), c.created_at) as t,
           count(*) filter (where c.status = 'approved')::int as conv,
           coalesce(sum(c.payout) filter (where c.status = 'approved'), 0)::float8 as revenue
    from conversions c
    where (p_site is null or exists (
             select 1 from events e where e.id = c.event_id and e.site = p_site))
      and (p_since is null or c.created_at >= p_since)
    group by 1
  ),
  -- A conversion is attributed to the country of the click it was matched to,
  -- exactly as dashboard_stats attributes one to that click's site. An orphan
  -- postback has no event to join to and therefore lands in no country — which
  -- is the truth, not a gap.
  cvg as (
    select coalesce(e.country, '??') as country,
           count(*) filter (where c.status = 'approved')::int as conversions
    from conversions c
    join events e on e.id = c.event_id
    where (p_site is null or e.site = p_site)
      and (p_since is null or c.created_at >= p_since)
    group by 1
  ),
  evg as (
    select country,
           count(*)::int                              as events,
           count(*) filter (where type = 'lead')::int as leads
    from ev group by 1
  )
  select jsonb_build_object(
    'bucket', (select unit from step),
    'series', (select coalesce(jsonb_agg(to_jsonb(s) order by s.t), '[]') from (
                 select a.t,
                        coalesce(sum(g.n) filter (where g.type = 'pageview'), 0)::int as pageview,
                        coalesce(sum(g.n) filter (where g.type = 'click'),    0)::int as click,
                        coalesce(sum(g.n) filter (where g.type = 'lead'),     0)::int as lead,
                        -- /api/track accepts one more type: the demo button's
                        -- `test`. It is a real event and is counted in `total`,
                        -- so hiding it here would make the chart disagree with
                        -- the tile above it.
                        coalesce(sum(g.n) filter (where g.type = 'test'),     0)::int as test,
                        coalesce(max(b.conv), 0)       as conv,
                        coalesce(max(b.revenue), 0)    as revenue
                 from axis a
                 left join agg g on g.t = a.t
                 left join cvb b on b.t = a.t
                 group by a.t) s),
    'geo',    (select coalesce(jsonb_agg(to_jsonb(x) order by x.events desc), '[]') from (
                 select evg.country, evg.events, evg.leads,
                        coalesce(cvg.conversions, 0) as conversions
                 from evg left join cvg using (country)
                 -- Twelve, the ceiling dashboard_stats uses for byCountry, so
                 -- the two reports cannot disagree about which countries exist.
                 order by evg.events desc, evg.country limit 12) x)
  );
$$;
