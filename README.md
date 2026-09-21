# Track Board

A live dashboard over a server-side tracking pipeline: events captured at the
edge, leads, postback-settled conversions, and the Conversions API delivery
queue behind them.

Every figure on the page is a row in Postgres. Nothing is seeded, nothing is
simulated, and there is no demo mode — on a quiet day the page shows a quiet
day. Two buttons let a visitor write an event of their own and watch it arrive,
with their own country and device read from the request.

---

## How it works

The four paragraphs between the markers below are the **canonical text**. The
"How it works" modal in `public/index.html` carries the same four, between
matching `modal:start` / `modal:end` comments. Edit the two together.

<!-- modal:start -->
**What this page shows.** Every figure here is a real row in a Postgres
database, written by a tracking endpoint of my own. Nothing is seeded and
nothing is simulated: the traffic is whatever has actually reached the pipeline
in the selected period, which on a portfolio project is modest by definition.

**How an event is captured.** A one-line snippet on a page fires a POST to a
serverless endpoint. The *browser* sends almost nothing — a type, a site name,
the click ids in the address bar. Country, city, device, OS and browser are read
from the request itself at the edge, so an ad blocker that kills a third-party
pixel does not remove the event, and a spoofed client value cannot reach the
database. The visitor's IP is salted and hashed before storage; it is counted,
never kept.

**Why a conversion appears after a lead.** A lead is the visitor's action — a
form sent. A conversion is the advertiser's verdict on it, and it arrives later,
from their server, as a *postback*: a plain HTTP call carrying the click id, a
status and a payout. The click id is what ties the two together, which is why a
conversion can be approved, left pending, reversed, or land with no matching
click at all. Those four outcomes are in the funnel and in the figures below it.

**What delivery means.** Once a conversion is settled it is worth telling the ad
platform about, so it can optimise on it. That is a Conversions API call — server
to server, with the identifiers hashed, a deduplication key so a browser pixel
and this call are not counted twice, and a retry queue for the calls that fail.
*Delivery health* at the foot of the page is that queue's own record: delivered,
failed, skipped, and how long the round trip took.

**And where those calls actually go.** With no Meta credentials attached they go
to an endpoint of ours that answers with the Graph API's own contract, and the
page says so rather than implying otherwise — real delivery to Meta can only be
verified inside the account owner's Events Manager, which a visitor cannot open.
Attaching *META_PIXEL_ID* and *META_ACCESS_TOKEN* changes the destination, not
the code; the block below reads the destination off the delivery rows, so it
will say the other thing on its own the day that is true.
<!-- modal:end -->

### The longer version

The capture endpoint, the postback receiver, the attribution by click id, the
CAPI payload builder and the retry sweeper are **not in this repository**. They
live in the sibling project that owns the pipeline and the database schema. This
project is the read side: one endpoint, one page, and one database function of
its own.

That separation is the point of the repository. The pipeline project explains
itself at length on its own page — every card there carries a paragraph. This one
has the opposite job: show the numbers, and put the prose behind a button.

---

## Data

`/api/stats` is the only endpoint. It takes:

| parameter | values | default |
|---|---|---|
| `period` | `24h` · `7d` · `30d` · `all` | `30d` |
| `site` | a source name, matched against `^[\w.-]{1,64}$` | all sources |
| `prev` | `1` to include the previous period's totals | off |

It makes two RPC calls, or three when `prev=1`:

- **`dashboard_stats(p_site, p_since)`** — owned by the pipeline project.
  Totals, visitors, byType, byCountry, byDevice, byHour, byRef, recent,
  conversions, byAd, capi.
- **`board_detail(p_site, p_since, p_prev_since)`** — owned by *this* project,
  `db/schema.sql`. Three things `dashboard_stats` does not report:
  - a **nested funnel**. See the decision below: four independent event
    counters are not a funnel, and drawing them as one produces a shape that
    widens in the middle.
  - a **continuous** time series split by event type. `byHour` is a flat total,
    capped at 48 rows, and skips hours that had no events — a chart drawn
    straight from it invents a slope across every gap. `board_detail` fills
    every bucket with `generate_series`, so a zero is drawn as a zero, and adds
    per-bucket conversions and revenue so all four KPI tiles can carry a
    sparkline.
  - a **country table with leads, a conversion rate and a direction**.
    `byCountry` gives events per country and nothing else.
- **`dashboard_stats`** again over a window of twice the length, when the page
  asks for deltas — see the decision below.

The database is shared with the pipeline project and belongs to it. This one
only reads, and adds exactly one object: `board_detail`. `npm run db:apply`
applies it; it is `create or replace`, so running it again is how a change
reaches the database.

---

## Decisions

The spec left three open (`SPEC.md` §12). The answers, and two more worth
writing down:

**1 · Deltas against the previous period — a second RPC call, no schema change.**
`dashboard_stats` takes a start but no end, so a shifted window cannot be asked
for. It does not have to be: every figure a delta uses is a count or a sum, so a
window of *twice* the length minus the current one **is** the previous one.
`/api/stats?prev=1` does that subtraction. The page asks for it on load and
whenever the period or source changes, and the 15-second poll leaves it alone —
deltas move slowly and cost a whole extra aggregation.

**2 · Conversion rate per country — a function of this project's own.**
Extending the shared `dashboard_stats` would mean editing the neighbour's
repository for a column only this page shows. `board_detail` is additive: the
neighbour is untouched and cannot be broken by it.

**3 · The demo buttons post to the pipeline's existing `/api/track`.** That
endpoint already answers `Access-Control-Allow-Origin: *` — it has to, because
it is a pixel embedded on other domains. Nothing new to deploy. The events are
sent with `site: "track-board"`, so they are visible as their own source in the
selector rather than mixed into another site's numbers. Override the endpoint
with `data-track-endpoint` on `<body>` if it ever moves.

**4 · The buttons live in the *Live events* card, not in a section of their own.**
§4's inventory has no block for them and says nothing else goes on the page, but
§3 requires them. The card whose table they write into is where they belong: you
press, and your row appears two lines below.

**5 · The funnel counts nested stages, not four separate event types.** §4.3 of
the spec sources the four stages from `byType` and `conversions.approved`. Those
are four independent counters, and on real data they do not nest: a lead can be
sent with no click before it (the demo button does exactly that), and a postback
can settle against a click from an earlier period. Drawn as a funnel, the shape
*widens* in the middle — which is the block telling the reader something false.

Each stage is therefore "an event that got **at least** this far":

| stage | counts |
|---|---|
| Events | everything the endpoint recorded |
| Engaged | a click, or a lead sent without one, or anything that converted |
| Leads | a form submitted, or anything that converted |
| Conversions | approved by the network |

Every stage is a superset of the next by construction, so the pyramid cannot
bulge on any data — it is arithmetic, not luck.

**6 · The funnel's width uses a square-root scale, and the figures do not.**
Real funnel numbers fall off a cliff: 109 → 21 → 14 → 4 here, and an order of
magnitude per step in any account with real traffic. At linear width that is one
wide band and three threads — the silhouette carries no information because
every stage below the first is visually zero. A square-root scale renders the
same numbers as 100 → 44 → 36 → 19, which is the gentle symmetric taper a funnel
is supposed to be, with the order and the relative sizes intact. The exact count,
the exact share of the first stage and the drop-off are printed beside every
band: **the width is the silhouette, the figures are the data.**

**7 · The left rail is navigation, not a mock admin panel — one entry per grid
row.** Every entry jumps to a block on this page and lights up when that block
is in view; there is no dead link in it. It exists because a rail is the
silhouette that makes a page read as a dashboard rather than as an article, and
it was only allowed on a single-page dashboard on condition that every icon goes
somewhere real. Below 1100px it is not rendered at all and the layout is the
single column of §6.

Its granularity is the layout's, not the block list's. From 1100px the blocks
sit in pairs on a row — funnel beside the time chart, geography beside devices,
monetisation beside delivery health — and a pair is on screen together, so one
entry per *block* meant two icons were "here" at once. Two active items in a nav
read as a fault, whatever the reasoning behind them. Five rows, five entries,
exactly one active at every scroll position.

**8 · Polling stops after ten idle minutes.** §9 asks for a 15-second poll while
the tab is visible. That alone would have a forgotten tab calling a serverless
function four times a minute for as long as the browser is open — the sibling
project already had to remove a 5-second timer for exactly that reason. Ten
minutes without a click, and the poll stops with the reason on screen; any click,
key or tab return resumes it and refreshes at once.

---

## Visual language

Dark, calm, and measured rather than chosen by eye.

**Categorical — the devices donut.** `#4c8dff` · `#cf7a2e` · `#d55181`. All
pairs clear the colour-vision and normal-vision separation floors against the
card surface `#151b23`, and all three clear 3:1 against it.

**Ordinal — the funnel stages and the stacked series.** One hue, four steps:
`#3a74d4` → `#4c8dff` → `#74a5ff` → `#a8c6ff`. Monotone in lightness with visible
gaps, and the darkest step clears 3:1 against the card — so the funnel and the
area chart speak the same colour language, in the same stage order.

**Direction, never decoration.** Green `#3fb950` and red `#f85149` mean up and
down, approved and failed, and nothing else. Every one of them is paired with an
arrow or a word, so colour never carries the meaning alone.

**Measured, not estimated.** Text tokens `#e8edf5` / `#9aa9bd` / `#7d8b9f` clear
4.5:1 on both surfaces; the delta chips clear 4.5:1 against their own 10% tint;
white on the accent is 3.2:1 and is therefore **not** used — the accent button's
label is `#08111f` at 5.9:1. Gridlines and hairline borders are deliberately
below that floor: they are separators, not content.

**One deliberate deviation.** Large standalone numbers normally take proportional
figures. The KPI values here are `tabular-nums` because they are replaced every
fifteen seconds, and proportional digits make a live figure twitch sideways on
each refresh.

---

## Running it

```bash
npm install
cp .env.local.example .env.local     # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
npm run db:apply                     # applies db/schema.sql — board_detail
npm run dev                          # http://localhost:3100
```

Port 3100, not 3000: the sibling project's dev server takes 3000 and the two are
routinely open together.

`dev.mjs` serves `public/` and runs the `api/` handlers behind a shim of the
three things they need — `req.query`, a parsed `req.body`, and
`res.status().json()`. Handlers are re-imported per mtime, so an edit needs no
restart. Locally there are no edge geo headers, so an event sent from a local
page has no country.

## Deploying

Vercel, Node serverless functions, no build step — `public/` is served
statically and `api/` as functions.

| variable | where |
|---|---|
| `SUPABASE_URL` | Vercel project, Production |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel project, Production — **never** reaches the browser |
| `SUPABASE_DB_PASSWORD` | local only, for `db:apply` |

The keep-alive cron is **not** duplicated here: the sibling project's already
keeps the shared database awake.

## What is deliberately not here

No canonical tag, no Open Graph block, no JSON-LD, no `robots.txt`, no
`sitemap.xml`. The production domain is set at deploy time and is not written
into the source. No login, no multi-tenant, no settings, no build step.

## Stack

Vercel (Node) · Supabase (Postgres) · Chart.js 4 from a CDN · no framework, no
bundler, no runtime dependency beyond `@supabase/supabase-js` on the server.
