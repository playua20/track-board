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
-- Postgres identifies a function by its argument types, so adding a parameter
-- with `create or replace` leaves an OVERLOAD behind rather than replacing
-- anything — and PostgREST then has two candidates to choose between. Drop the
-- old arity explicitly.
drop function if exists board_detail(text, timestamptz);
drop function if exists board_detail(text, timestamptz, timestamptz);

create or replace function board_detail(p_site text default null,
                                        p_since timestamptz default null,
                                        p_prev_since timestamptz default null,
                                        -- How many ads and sources to name before folding the
                                        -- rest into one row. The page raises it when a reader
                                        -- asks to see the tail, and it is clamped here as well
                                        -- as at the endpoint: "show me everything" on an account
                                        -- with a thousand ads is not a thing to hand a browser.
                                        p_top int default 9)
returns jsonb
language sql
stable
security invoker
as $$
  with cap as (
    -- Clamped here and not only at the endpoint: the function is reachable
    -- through PostgREST, so the bound has to live where the query does.
    select least(greatest(coalesce(p_top, 9), 3), 60) as top
  ),
  ev as (
    -- ref_host is here for refg below; adding a column to this CTE is cheaper
    -- than a second pass over the same filtered set.
    select created_at, type, ref_host, coalesce(country, '??') as country
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
  /* Per-ad and per-source totals, RANKED rather than truncated.
     A bare `limit 10` bounds the table's height and silently drops whatever
     does not fit — so with eleven ads the column would stop summing to the
     Revenue tile and nothing would say why. Ranking lets the tail be folded
     into one row instead of vanishing: the height stays bounded and the
     arithmetic still closes. */
  adg as (
    select c.sub1 as campaign, c.sub3 as ad, c.matched,
           count(*) filter (where c.status = 'approved')::int as approved,
           count(*) filter (where c.status = 'pending')::int  as pending,
           count(*) filter (where c.status = 'rejected')::int as rejected,
           coalesce(sum(c.payout) filter (where c.status = 'approved'), 0)::float8 as revenue
    from conversions c
    where (p_site is null or exists (
             select 1 from events e where e.id = c.event_id and e.site = p_site))
      and (p_since is null or c.created_at >= p_since)
    -- matched is part of the key: an unmatched postback has no campaign to
    -- name and must not be folded in with a matched click that merely arrived
    -- without ad macros.
    group by 1, 2, 3
  ),
  adr as (
    select *, row_number() over (order by revenue desc, approved desc) as rank from adg
  ),
  refg as (
    select coalesce(ref_host, 'direct') as host, count(*)::int as n
    from ev group by 1
  ),
  refr as (
    select *, row_number() over (order by n desc, host) as rank from refg
  ),
  evg as (
    select country,
           count(*)::int                              as events,
           count(*) filter (where type = 'lead')::int as leads
    from ev group by 1
  ),
  -- The same countries over the window immediately before this one, so the
  -- geography table can carry a direction per row (SPEC §7). This function
  -- owns both bounds, so unlike the KPI deltas there is no subtraction trick
  -- to play — the window is simply asked for.
  /* The funnel, and the reason it is computed here rather than read off byType.
     A funnel is only a funnel when each stage is a SUBSET of the one above it.
     Four independent event counters are not: a lead can be sent without a click
     before it (the demo button does exactly that), and a postback can settle
     against a click from an earlier period — so the "funnel" widens in the
     middle and the block tells the reader something false.

     So each stage is defined as "this event got at least this far", and the
     `or` down the chain is what makes every stage a superset of the next. The
     pyramid cannot bulge on any data, ever — it is arithmetic, not luck. */
  cvm as (
    -- One row per event that carries an approved conversion. Grouped rather
    -- than joined straight, so an event settled twice cannot count twice.
    select event_id from conversions
    where status = 'approved' and event_id is not null
      and (p_since is null or created_at >= p_since)
    group by event_id
  ),
  fev as (
    select e.type, (m.event_id is not null) as conv
    from events e
    left join cvm m on m.event_id = e.id
    where (p_site is null or e.site = p_site)
      and (p_since is null or e.created_at >= p_since)
  ),
  -- Same conversion set dashboard_stats uses for its capi figures, so the
  -- destination reported beside those figures is the destination they came
  -- from and not a near-miss.
  cvp as (
    select c.id from conversions c
    where (p_site is null or exists (
             select 1 from events e where e.id = c.event_id and e.site = p_site))
      and (p_since is null or c.created_at >= p_since)
  ),
  evp as (
    select coalesce(country, '??') as country, count(*)::int as events_prev
    from events
    where (p_site is null or site = p_site)
      and p_prev_since is not null and p_since is not null
      and created_at >= p_prev_since and created_at < p_since
    group by 1
  )
  select jsonb_build_object(
    'funnel', (select jsonb_build_object(
                 'events',    count(*),
                 -- `or conv` on the two middle stages is load-bearing: a
                 -- conversion attributed to a CLICK would otherwise be counted
                 -- below a stage it never passed through.
                 'engaged',   count(*) filter (where type in ('click', 'lead') or conv),
                 'leads',     count(*) filter (where type = 'lead' or conv),
                 'converted', count(*) filter (where conv))
               from fev),
    /* WHERE the Conversions API calls actually went. Read from the rows rather
       than written into the page, because it is a deployment fact that can
       change: with no META_PIXEL_ID and META_ACCESS_TOKEN attached the
       pipeline delivers to its own stand-in, which speaks the Graph API
       contract; attach them and the same code delivers to Meta. A page that
       hardcoded either answer would be lying the day the other became true. */
    'capiDest', (select coalesce(jsonb_agg(distinct d.destination), '[]')
                 from capi_deliveries d
                 where (p_since is null or d.created_at >= p_since)
                   and (p_site is null or exists (select 1 from cvp where cvp.id = d.conversion_id))),
    /* Calls that went out for a conversion the network has since taken back.
       Delivery fires when a postback settles a conversion as approved; a later
       postback with the same txid can reverse it, and by then the platform has
       already been told. It is why `delivered` can exceed the approved count,
       and without it the two figures look like a contradiction.

       ⚠ Only ORIGINAL deliveries count here. The compensating call is itself a
       delivered row belonging to a conversion that is no longer approved, so
       counting it too would report every correction as a fresh problem — the
       fix would inflate the number it fixes. */
    'capiReversed', (select count(*)::int
                     from capi_deliveries d
                     join conversions cv on cv.id = d.conversion_id
                     where d.status = 'delivered' and d.event_id not like '%-refund'
                       and cv.status <> 'approved'
                       and (p_since is null or d.created_at >= p_since)
                       and (p_site is null or exists (select 1 from cvp where cvp.id = d.conversion_id))),
    /* …and how many of those have had their correction accepted. The gap
       between the two is the only number that represents an actual problem:
       a signal the platform still believes and we have not withdrawn. */
    'capiCompensated', (select count(*)::int
                        from capi_deliveries d
                        join conversions cv on cv.id = d.conversion_id
                        where d.status = 'delivered' and d.event_id not like '%-refund'
                          and cv.status <> 'approved'
                          and exists (select 1 from capi_deliveries r
                                      where r.event_id = d.event_id || '-refund'
                                        and r.status = 'delivered')
                          and (p_since is null or d.created_at >= p_since)
                          and (p_site is null or exists (select 1 from cvp where cvp.id = d.conversion_id))),
    /* Per-ad totals BY STATUS, replacing dashboard_stats' byAd.
       That one counts conversions of every status in one column while summing
       revenue from approved ones only — so an ad with an approved $18.00, a
       rejected $9.00 and an approved $7.50 reads "3 conversions · $25.50", and
       a lone pending one reads "1 conversion · $0.00". Both are true and
       together they are misleading: two columns side by side on different
       bases, with nothing saying so. */
    -- The named ads plus, when there are more, one row carrying the rest.
    'byAd', (select coalesce(jsonb_agg(to_jsonb(x) order by x.rank), '[]') from (
               select rank, campaign, ad, matched, approved, pending, rejected, revenue,
                      false as folded, 0 as folded_n
               from adr where rank <= (select top from cap)
               union all
               select (select top from cap) + 1, null, null, null,
                      sum(approved)::int, sum(pending)::int, sum(rejected)::int,
                      sum(revenue)::float8, true, count(*)::int
               from adr where rank > (select top from cap)
               having count(*) > 0) x),
    -- Same shape for the sources, which also add up to the event total. Two
    -- fewer named, because the block gives them a narrower column.
    'byRef', (select coalesce(jsonb_agg(to_jsonb(x) order by x.rank), '[]') from (
                select rank, host, n, false as folded, 0 as folded_n
                from refr where rank <= (select top from cap) - 2
                union all
                select (select top from cap) - 1, null, sum(n)::int, true, count(*)::int
                from refr where rank > (select top from cap) - 2
                having count(*) > 0) x),
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
                        coalesce(cvg.conversions, 0) as conversions,
                        -- null, not 0, when no previous window was asked for:
                        -- "we did not look" and "there was nothing" are
                        -- different rows and must not draw the same chip.
                        case when p_prev_since is null then null
                             else coalesce(evp.events_prev, 0) end as events_prev
                 from evg
                 left join cvg using (country)
                 left join evp using (country)
                 -- Twelve, the ceiling dashboard_stats uses for byCountry, so
                 -- the two reports cannot disagree about which countries exist.
                 order by evg.events desc, evg.country limit 12) x)
  );
$$;
