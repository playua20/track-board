/*!
 * Track Board — fetch, render, refresh.
 *
 * One stats call feeds every block. Chart.js draws the two real charts; the
 * funnel, the sparklines and the tables are plain DOM, because they need to
 * animate against the layout rather than inside a canvas.
 *
 * Nothing here trusts the payload: every value that reaches the page goes
 * through esc() first — /api/stats reports rows written by a public endpoint.
 */
(function () {
  "use strict";

  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  /* ------------------------------------------------------------------ *
   * formatting
   * ------------------------------------------------------------------ */

  const esc = v => String(v ?? '—').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const nf  = new Intl.NumberFormat('en-US');
  const int = n => nf.format(Math.round(Number(n) || 0));
  const cash = n => '$' + (Number(n) || 0).toFixed(2);
  const pct = (a, b) => (b > 0 ? (a / b) * 100 : 0);
  const pctTxt = v => (v === 0 ? '0' : v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';

  const NAMES = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const countryName = c => {
    if (!c || c.length !== 2 || c === '??') return null;
    try { return NAMES ? NAMES.of(c) : null; } catch { return null; }
  };

  /* An empty flag box next to the word "Unknown" reads as a broken image. It is
     not missing data — it is a request that never passed through the edge, so
     no country header existed to read. Say that, and draw a globe. */
  const NO_COUNTRY = 'No country header on the request — it did not pass through the edge (a locally sent event, for instance)';

  function flagCell(code) {
    const name = countryName(code);
    if (!name) {
      return `<span class="cell">${ico('globe', 'ico ico--sm')}` +
        `<span class="mut hint" title="${NO_COUNTRY}">Unknown</span></span>`;
    }
    return `<span class="cell">` +
      `<img class="flag" src="https://flagcdn.com/w40/${esc(code.toLowerCase())}.png" alt="" loading="lazy" width="18" height="13">` +
      `<span>${esc(name)}</span></span>`;
  }

  const timeOf = iso => {
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const ICONS = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    tablet: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M12 3a15 15 0 0 0 0 18 15 15 0 0 0 0-18"/><path d="M3 12h18"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 3.9 8.1"/><path d="m2 2 20 20"/><path d="M8 12h3"/>',
  };
  const ico = (id, cls = 'ico') =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ICONS.globe}</svg>`;

  const DEVICE_ICON = { desktop: 'monitor', mobile: 'smartphone', tablet: 'tablet' };

  /* ------------------------------------------------------------------ *
   * number tween — a live figure should arrive, not blink
   * ------------------------------------------------------------------ */

  const ease = t => 1 - Math.pow(1 - t, 3);

  function tween(el, to, fmt, dur = 620) {
    const from = Number(el.dataset.v);
    if (REDUCED || !isFinite(from) || from === to) {
      el.dataset.v = to; el.textContent = fmt(to); return;
    }
    cancelAnimationFrame(Number(el.dataset.raf));
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = fmt(from + (to - from) * ease(k));
      if (k < 1) el.dataset.raf = requestAnimationFrame(step);
      else { el.dataset.v = to; el.textContent = fmt(to); }
    };
    el.dataset.raf = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ *
   * state
   * ------------------------------------------------------------------ */

  const PERIOD_LABEL = { '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days', all: 'all time' };
  const POLL_MS = 15000;
  // A portfolio link left open in a forgotten tab would otherwise poll for
  // hours. Ten minutes without a click is where a reader stopped reading.
  const IDLE_MS = 10 * 60 * 1000;
  const TRACK_URL = document.body.dataset.trackEndpoint
    || 'https://server-side-pixel.vercel.app/api/track';

  const S = {
    period: '30d',
    site: null,
    data: null,          // last good payload
    first: true,
    // True only when the next render answers a DIFFERENT question — the first
    // one, or a change of period or source. The charts read it to decide
    // whether they may play their entrance; a poll must never replay it.
    reveal: true,
    timer: 0,
    // How many ads and sources the monetisation tables name before folding.
    // Raised when a reader opens the folded row; reset whenever the period or
    // the source changes, because that is a different question.
    top: 9,
    lastTouch: Date.now(),
    seen: new Set(),     // keys of rows already in the tail, so only new ones flash
  };

  /* ------------------------------------------------------------------ *
   * fetch
   * ------------------------------------------------------------------ */

  async function load({ withPrev = false, quiet = false } = {}) {
    const q = new URLSearchParams({ period: S.period });
    if (S.site) q.set('site', S.site);
    if (withPrev) q.set('prev', '1');
    if (S.top > 9) q.set('top', String(S.top));

    if (!S.first && !quiet) $('#board').classList.add('is-stale');

    try {
      const r = await fetch('/api/stats?' + q, { headers: { accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);

      // A poll does not ask for the deltas, so keep the ones already on screen.
      if (!withPrev && S.data && j.prev == null) j.prev = S.data.prev;

      S.data = j;
      render(j);
      ok();
    } catch (e) {
      // The rest of the page keeps the last good data rather than disappearing.
      fail(e.message || 'request failed');
    } finally {
      S.first = false;
      $('#board').classList.remove('is-stale');
      $('#board').classList.remove('is-loading');
    }
  }

  function ok() {
    $('#err').hidden = true;
    const live = $('#live');
    live.classList.remove('is-bad');
    $('#liveTxt').textContent = 'Live · updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function fail(msg) {
    $('#live').classList.add('is-bad');
    $('#liveTxt').textContent = S.data ? 'Showing the last good data' : 'No data';
    $('#errTxt').textContent = msg;
    $('#err').hidden = false;
  }

  /* ------------------------------------------------------------------ *
   * render
   * ------------------------------------------------------------------ */

  const typeN = (d, t) => Number((d.byType || []).find(x => x.type === t)?.n) || 0;

  function render(d) {
    sites(d);
    kpis(d);
    funnel(d);
    series(d);
    geo(d);
    devices(d);
    tail(d);
    money(d);
    health(d);
    emptiness(d);
    S.reveal = false;          // consumed — the next render is a poll until told otherwise
  }

  function emptiness(d) {
    let n = $('#emptyNote');
    const empty = !Number(d.total);
    if (empty && !n) {
      n = document.createElement('p');
      n.id = 'emptyNote';
      n.className = 'note';
      $('.card--funnel').after(n);
    }
    if (n) {
      n.hidden = !empty;
      n.textContent = empty ? `No events in ${PERIOD_LABEL[d.period] || 'this period'}. The blocks below are showing zeroes, not a failure.` : '';
    }
  }

  /* --- source selector ------------------------------------------------ */

  function sites(d) {
    const list = d.sites || [];
    const wrap = $('#siteWrap'), sel = $('#site');
    if (list.length < 2) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const want = ['', ...list].join('|');
    if (sel.dataset.sig === want) { sel.value = S.site || ''; return; }
    sel.dataset.sig = want;
    sel.innerHTML = `<option value="">All sources</option>` +
      list.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    sel.value = S.site || '';
  }

  /* --- 4.2 KPI tiles -------------------------------------------------- */

  function kpis(d) {
    const cur = {
      events: Number(d.total) || 0,
      leads:  typeN(d, 'lead'),
      conv:   Number(d.conversions?.approved) || 0,
      rev:    Number(d.conversions?.revenue) || 0,
    };
    const fmt = { events: int, leads: int, conv: int, rev: cash };

    for (const k of Object.keys(cur)) tween($(`[data-k="${k}"]`), cur[k], fmt[k]);

    const views = typeN(d, 'pageview');
    const notes = {
      events: `${int(d.visitors)} visitor${Number(d.visitors) === 1 ? '' : 's'}`,
      // Against pageviews, not clicks: a lead can be sent without a click
      // preceding it, and a rate over the smaller number reads as >100%.
      leads:  views ? `${pctTxt(pct(cur.leads, views))} of pageviews` : '',
      // `orphans` is in the payload and was on screen nowhere. It belongs
      // beside the count it is not part of: an unmatched postback is money the
      // network reported that no ad can be credited with.
      conv:   [
        Number(d.conversions?.pending) ? `${int(d.conversions.pending)} pending` : '',
        Number(d.conversions?.orphans) ? `${int(d.conversions.orphans)} unmatched` : '',
      ].filter(Boolean).join(' · '),
      rev:    cur.conv ? `${cash(cur.rev / cur.conv)} average payout` : '',
    };
    for (const k of Object.keys(notes)) $(`[data-n="${k}"]`).textContent = notes[k];

    // /api/stats reports the previous window under the database's own names.
    const PREV_KEY = { events: 'total', leads: 'leads', conv: 'conversions', rev: 'revenue' };
    const dirs = {};
    for (const k of Object.keys(cur)) {
      dirs[k] = delta($(`[data-d="${k}"]`), cur[k], d.prev ? d.prev[PREV_KEY[k]] : null);
    }

    sparks(d, dirs);
  }

  /** Renders the chip and returns the direction, which also colours the spark. */
  function delta(el, now, before) {
    if (before == null) { el.className = 'delta'; el.textContent = ''; return 'flat'; }
    if (!before && !now) { el.className = 'delta delta--flat'; el.textContent = 'no change'; return 'flat'; }
    if (!before) {
      el.className = 'delta delta--new';
      el.innerHTML = '<span aria-hidden="true">↑</span><span>new</span>';
      el.title = 'Nothing in the period before this one to compare against';
      return 'new';
    }
    const v = ((now - before) / before) * 100;
    const dir = Math.abs(v) < 0.5 ? 'flat' : v > 0 ? 'up' : 'down';
    el.className = 'delta delta--' + dir;
    // The arrow carries the direction; the colour only reinforces it (§10).
    el.innerHTML = `<span aria-hidden="true">${dir === 'flat' ? '→' : dir === 'up' ? '↑' : '↓'}</span>` +
      `<span>${Math.abs(v) >= 1000 ? '999+' : Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%</span>`;
    el.title = `${dir === 'down' ? 'Down' : 'Up'} from ${int(before)} in the period before this one`;
    return dir;
  }

  /* Sparklines are inline SVG rather than four more canvases: they need the
     card's own gradient behind them, a marker on the last point, and a colour
     that comes from the tile's own direction. */
  const SPARK_COLOUR = { up: '--up', down: '--down', flat: '--accent' };

  /* Which way the line itself is going — the mean of its last third against the
     mean of the rest. Used when there is no previous period to compare with,
     which on a young database is most of the time: four identical blue lines
     say nothing, and the colour of a sparkline is the cheapest thing on the
     page that carries real information. */
  function trend(vals) {
    /* The axis ends at now, so the FINAL bucket is always partial — at 17:49
       it holds eleven minutes measured against full hours. Judging a trend
       with it in means every metric drifts toward "falling" as each hour
       begins. It is real data and stays on the line; it just does not get a
       vote on the direction. */
    const v = vals.length > 4 ? vals.slice(0, -1) : vals;
    if (v.length < 4) return 'flat';
    const cut = Math.max(1, Math.round(v.length / 3));
    const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    const before = mean(v.slice(0, -cut));
    const after = mean(v.slice(-cut));
    if (!before && !after) return 'flat';
    if (!before) return 'up';
    const change = (after - before) / before;
    return Math.abs(change) < 0.08 ? 'flat' : change > 0 ? 'up' : 'down';
  }

  function sparks(d, dirs) {
    const rows = d.series || [];
    const pick = {
      events: r => r.pageview + r.click + r.lead + r.test,
      leads:  r => r.lead,
      conv:   r => r.conv,
      rev:    r => r.revenue,
    };
    for (const [k, f] of Object.entries(pick)) {
      const box = $(`[data-spark="${k}"]`);
      const vals = rows.map(r => Number(f(r)) || 0);
      // The tile's own direction when there is a previous period to compare
      // against, so the chip and the line agree; otherwise the line's own.
      const fromChip = dirs[k] === 'up' || dirs[k] === 'down';
      const dir = fromChip ? dirs[k] : trend(vals);
      // A flat line of zeroes says nothing the big number does not already say.
      const html = rows.length > 1 && vals.some(v => v > 0)
        ? sparkSvg(vals, k, SPARK_COLOUR[dir] || '--accent', why(dir, fromChip, d.period)) : '';
      // Unchanged numbers must not rebuild the node: a poll should leave the
      // page alone where nothing has moved.
      if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
    }
  }

  /* The colour of a sparkline is a claim, and until now nothing on the page
     said what it claimed — the same metric is green over 30 days and red over
     24 hours, which is correct (different window, different question) and
     looks like a fault until it is spelled out. */
  const WORD = { up: 'Rising', down: 'Falling', flat: 'Flat', new: 'Flat' };
  const why = (dir, fromChip, period) => fromChip
    ? `${WORD[dir]} against the period before this one`
    : `${WORD[dir]} within ${PERIOD_LABEL[period] || 'this period'}; no earlier period to compare against`;

  function sparkSvg(vals, key, colourVar, label) {
    const W = 100, H = 34, PAD = 3;
    const max = Math.max(...vals, 1);
    const x = i => (i / (vals.length - 1)) * W;
    const y = v => H - (v / max) * (H - PAD * 2) - PAD;
    const pts = vals.map((v, i) => [x(i), y(v)]);

    // A gentle Catmull-Rom-ish smoothing: a sparkline of hourly counts is
    // spiky enough to read as noise when drawn as raw segments.
    let line = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const [px, py] = pts[i - 1], [cx, cy] = pts[i];
      const mx = (px + cx) / 2;
      line += ` C${mx.toFixed(2)} ${py.toFixed(2)} ${mx.toFixed(2)} ${cy.toFixed(2)} ${cx.toFixed(2)} ${cy.toFixed(2)}`;
    }
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const id = 'sg-' + key;
    const [, ey] = pts[pts.length - 1];
    const c = `var(${colourVar})`;

    // The paths stretch to the box (`preserveAspectRatio="none"`), which would
    // squash a circle drawn inside the same SVG into an ellipse. The marker is
    // therefore an HTML element placed over it, in percentages.
    return `<span class="spark" style="--sc:${c}" title="${esc(label)}">
      <span class="vh">${esc(label)}</span>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${c}" stop-opacity=".38"/>
            <stop offset="1" stop-color="${c}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#${id})"/>
        <path d="${line}" fill="none" stroke="${c}" stroke-width="2.4" stroke-opacity=".3"
              stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"
              style="filter:blur(3px)"/>
        <path d="${line}" fill="none" stroke="${c}" stroke-width="1.7"
              stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
      </svg>
      <span class="spark__dot" style="top:${((ey / H) * 100).toFixed(2)}%"></span>
    </span>`;
  }

  /* --- 4.3 funnel ----------------------------------------------------- */

  /* Each stage is "an event that got at least this far", which is what makes
     the shape a funnel rather than four counters side by side. board_detail
     guarantees the nesting; see db/schema.sql. */
  const STAGES = [
    ['Events',      'events',    'everything the endpoint recorded'],
    ['Engaged',     'engaged',   'a click, or a lead sent without one'],
    ['Leads',       'leads',     'a form actually submitted'],
    ['Conversions', 'converted', 'approved by the network'],
  ];

  function funnel(d) {
    const f = d.funnel || {};
    const steps = STAGES.map(([label, key]) => [label, Number(f[key]) || 0]);
    const top = Math.max(steps[0][1], 1);
    const box = $('#funnel');

    const sig = JSON.stringify(steps);
    if (box.dataset.sig === sig) return;      // a poll that changed nothing
    box.dataset.sig = sig;

    const BAND = 25, RAMP = ['--s-view', '--s-click', '--s-lead', '--s-conv'];
    /* The half-width of a stage, in the funnel's own 0–100 space.
     *
     * SQUARE ROOT, not the raw share, and this is the decision that makes the
     * block readable. Real funnel numbers fall off a cliff — 109 → 21 → 14 → 4
     * here, and an order of magnitude per step in any account with real
     * traffic. Drawn at linear width that is one wide band and three threads:
     * the shape carries no information because every stage below the first is
     * visually zero. A square-root scale turns the same numbers into
     * 100 → 44 → 36 → 19, which is the gentle symmetric taper a funnel is
     * supposed to be, and keeps the ORDER and the relative sizes intact.
     *
     * Nothing is hidden by it: the exact count and the exact share are printed
     * beside every stage, and the drop-off is stated between them. The width
     * is the silhouette; the figures are the data. */
    const half = n => (n > 0 ? Math.max(Math.sqrt(n / top) * 100, 3) : 0) / 2;

    // ONE continuous shape. Bands drawn as separate SVGs with the drop-off
    // notes between them read as four disconnected trapezoids; the reference's
    // funnel — and every tracker's — is a single silhouette, so the notes move
    // out to the side and the bands share their edges.
    const bands = steps.map(([, n], i) => {
      const a = half(n);
      // The bottom edge is the NEXT stage's width: the taper is the join
      // between two true widths, not a drawn shape. The last band closes on
      // its own width rather than inventing a point.
      const b = i + 1 < steps.length ? half(steps[i + 1][1]) : a;
      const y = i * BAND, c = `var(${RAMP[i]})`;
      return `<defs><linearGradient id="fg-${i}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${c}" stop-opacity="1"/>
          <stop offset="1" stop-color="${c}" stop-opacity=".62"/>
        </linearGradient></defs>
        <polygon points="${(50 - a).toFixed(2)},${y} ${(50 + a).toFixed(2)},${y} ${(50 + b).toFixed(2)},${y + BAND} ${(50 - b).toFixed(2)},${y + BAND}"
                 fill="url(#fg-${i})" style="--fi:${i}">
          <title>${esc(steps[i][0])}: ${int(n)} — ${pctTxt(pct(n, top))} of ${esc(steps[0][0]).toLowerCase()}</title>
        </polygon>
        ${i ? `<line x1="${(50 - a).toFixed(2)}" y1="${y}" x2="${(50 + a).toFixed(2)}" y2="${y}"
               stroke="var(--card-lo)" stroke-width=".6" vector-effect="non-scaling-stroke"/>` : ''}`;
    }).join('');

    box.innerHTML =
      `<div class="funnel__art">
         <svg viewBox="0 0 100 ${BAND * steps.length}" preserveAspectRatio="none" aria-hidden="true">${bands}</svg>
       </div>` +
      steps.map(([name, n], i) => `
        <p class="fname" style="grid-row:${i + 1}">${esc(name)}<b>${esc(STAGES[i][2])}</b></p>
        <p class="fval" style="grid-row:${i + 1}">
          <span class="fval__n">${int(n)}</span>
          <span class="fval__p">${pctTxt(pct(n, top))} of all</span>
          ${i ? `<span class="fval__d">${drop(steps[i - 1][1], n)}</span>` : ''}
        </p>`).join('');

    box.classList.toggle('is-reveal', !!S.reveal);

    $('.card--funnel').setAttribute('aria-label',
      'Funnel: ' + steps.map(([n, v]) => `${n} ${int(v)}`).join(', '));
  }

  /* A funnel assumes each stage is smaller than the one above it, and real data
     does not have to oblige: a lead can be sent without a click before it, and
     a postback can settle against a click from an earlier period. Saying
     "-42.9% lost" in that case is not a rounding wrinkle — it is the block
     telling the reader something false. */
  function drop(before, after) {
    if (!before) return '';
    // board_detail guarantees each stage is a subset of the one above, so this
    // branch should be unreachable. It stays as a tripwire: if it ever renders,
    // the function's nesting has been broken and the page says so rather than
    // drawing a funnel that silently widens.
    if (after > before) {
      return `<span class="fdrop fdrop--up" title="Each stage should be a subset of the one above it">` +
        `⚠ ${int(after - before)} more than the stage above</span>`;
    }
    return `<span class="fdrop"><span aria-hidden="true">↓</span> ${pctTxt(100 - pct(after, before))} lost</span>`;
  }

  /* --- 4.4 events over time ------------------------------------------- */

  const SERIES = [
    { key: 'pageview', label: 'Pageviews', varName: '--s-view' },
    { key: 'click',    label: 'Clicks',    varName: '--s-click' },
    { key: 'lead',     label: 'Leads',     varName: '--s-lead' },
    { key: 'test',     label: 'Test',      varName: '--s-test' },
  ];

  let chSeries = null;

  function bucketLabel(iso, bucket) {
    const d = new Date(iso);
    return bucket === 'day'
      ? d.toLocaleDateString([], { day: 'numeric', month: 'short' })
      : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function series(d) {
    const rows = d.series || [];
    const labels = rows.map(r => bucketLabel(r.t, d.bucket));
    // A day bucket has no hour to show: rendering UTC midnight in the reader's
    // own zone puts "03:00" on a row that means a whole day.
    const full = rows.map(r => new Date(r.t).toLocaleString([], d.bucket === 'day'
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));
    // A series that is all zeroes in this period is noise in the legend.
    const live = SERIES.filter(s => rows.some(r => r[s.key] > 0));
    const use = live.length ? live : SERIES.slice(0, 1);

    $('#seriesSub').textContent = rows.length
      ? `${d.bucket === 'day' ? 'Daily' : 'Hourly'} totals across ${PERIOD_LABEL[d.period]}, stacked by event type`
      : 'No events in this period';

    $('#seriesLegend').innerHTML = use.map(s => {
      const n = rows.reduce((a, r) => a + r[s.key], 0);
      return `<span class="lg"><span class="lg__sw" style="background:var(${s.varName})"></span>` +
        `<span>${esc(s.label)}</span><span class="lg__n">${int(n)}</span></span>`;
    }).join('');

    $('#seriesTable').innerHTML = tableAlt(
      'Events over time',
      ['Time', ...use.map(s => s.label)],
      rows.map((r, i) => [full[i], ...use.map(s => int(r[s.key]))]));

    const values = use.map(s => rows.map(r => r[s.key]));
    /* Three different things can happen on a render, and only the first two are
       allowed to move anything on screen:
         · the period or the source changed  → the full reveal;
         · a poll brought new numbers        → the points glide to them;
         · a poll brought the same numbers   → the chart is not touched at all.
       Rebuilding the dataset array unconditionally, as this did, made every
       poll look like the third case and behave like the first: Chart.js saw
       fresh datasets and replayed the grow-from-the-baseline entrance every
       fifteen seconds. */
    const sig = JSON.stringify([labels, use.map(s => s.key), values]);
    if (chSeries && chSeries.$sig === sig) { chSeries.$full = full; return; }

    const dataset = (s, i) => {
      const colour = css(s.varName);
      return {
        label: s.label,
        data: values[i],
        borderColor: colour,
        /* 3, not 2. The canvas is rendered at the full device pixel ratio —
           measured at 1×, 1.25×, 1.5× and 2×, all sharp — so the stepping on a
           diagonal was never rasterisation. It was the stroke: two pixels on a
           dark ground shows its own staircase, three reads as a line. Round
           joins and caps for the same reason, at the tight turns. */
        borderWidth: 3,
        borderJoinStyle: 'round',
        borderCapStyle: 'round',
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: colour,
        pointHoverBorderColor: css('--card'),
        pointHoverBorderWidth: 2,
        tension: .34,
        fill: true,
        backgroundColor: ctx => fade(ctx, colour),
      };
    };

    if (!chSeries) {
      chSeries = new Chart($('#chSeries'), {
        type: 'line',
        data: { labels, datasets: use.map(dataset) },
        options: seriesOptions(full),
        plugins: [crosshair],
      });
    } else if (S.reveal || chSeries.data.datasets.length !== use.length) {
      // A new period, a new source, or a type that has just appeared: the
      // chart is answering a different question, so it may introduce itself.
      chSeries.options.animations = revealFrom();
      chSeries.data.labels = labels;
      chSeries.data.datasets = use.map(dataset);
      chSeries.update();
    } else {
      // Same question, newer numbers. Mutate in place and let Chart.js
      // interpolate: the points move, the entrance does not replay.
      chSeries.options.animations = {};
      chSeries.data.labels = labels;
      use.forEach((s, i) => { chSeries.data.datasets[i].data = values[i]; });
      chSeries.update();
    }
    chSeries.$sig = sig;
    chSeries.$full = full;
  }

  /* The entrance: every point starts on the baseline and rises to its value. */
  const revealFrom = () => (REDUCED ? {} : {
    y: { from: ctx => (ctx.chart.chartArea ? ctx.chart.chartArea.bottom : undefined) },
  });

  /* A gradient needs the chart area, which does not exist on the first call —
     Chart.js re-resolves a scriptable option once it does. */
  function fade(ctx, colour) {
    const a = ctx.chart.chartArea;
    if (!a) return colour + '22';
    const g = ctx.chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    g.addColorStop(0, hexA(colour, .34));
    g.addColorStop(1, hexA(colour, .02));
    return g;
  }

  const hexA = (hex, a) => {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  };

  function seriesOptions(full) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: REDUCED ? false : { duration: 620, easing: 'easeOutCubic' },
      animations: revealFrom(),
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 6, right: 2, left: 0 } },
      scales: {
        x: {
          stacked: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: css('--ink-3'), maxRotation: 0, autoSkipPadding: 22,
            font: { size: 11, family: css('--sans') },
          },
        },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: css('--grid'), drawTicks: false },   // solid hairlines, never dashed
          border: { display: false },
          ticks: {
            color: css('--ink-3'), maxTicksLimit: 5, padding: 8,
            font: { size: 11, family: css('--sans') },
            callback: v => (v >= 1000 ? v / 1000 + 'k' : v),
          },
        },
      },
      plugins: {
        legend: { display: false },                            // our own, above the plot
        tooltip: { enabled: false, external: htmlTooltip(full) },
      },
    };
  }

  /* --- a crosshair and an HTML tooltip, so the chart reads like a product - */

  const crosshair = {
    id: 'crosshair',
    afterDatasetsDraw(c) {
      const act = c.tooltip?.getActiveElements?.() || [];
      if (!act.length) return;
      const x = act[0].element.x, { top, bottom } = c.chartArea;
      const g = c.ctx;
      g.save();
      g.beginPath();
      g.moveTo(x, top); g.lineTo(x, bottom);
      g.lineWidth = 1;
      g.strokeStyle = css('--ink-3');
      g.globalAlpha = .45;
      g.stroke();
      g.restore();
    },
  };

  function htmlTooltip(full) {
    return ctx => {
      const { chart, tooltip } = ctx;
      let el = chart.canvas.parentNode.querySelector('.tip');
      if (!el) {
        el = document.createElement('div');
        el.className = 'tip';
        chart.canvas.parentNode.appendChild(el);
      }
      if (!tooltip.opacity) { el.style.opacity = 0; return; }

      const i = tooltip.dataPoints[0].dataIndex;
      const total = tooltip.dataPoints.reduce((a, p) => a + p.parsed.y, 0);
      el.innerHTML =
        `<p class="tip__h">${esc((chart.$full || full)[i])}</p>` +
        tooltip.dataPoints.map(p =>
          `<p class="tip__r"><span class="tip__sw" style="background:${p.dataset.borderColor}"></span>` +
          `<span class="tip__l">${esc(p.dataset.label)}</span>` +
          `<span class="tip__v">${int(p.parsed.y)}</span></p>`).join('') +
        `<p class="tip__t"><span class="tip__l">Total</span><span class="tip__v">${int(total)}</span></p>`;

      const a = chart.chartArea;
      const w = el.offsetWidth;
      const x = Math.min(Math.max(tooltip.caretX - w / 2, a.left), a.right - w);
      el.style.opacity = 1;
      el.style.transform = `translate(${x}px, ${Math.max(a.top, tooltip.caretY - el.offsetHeight - 14)}px)`;
    };
  }

  /* A track plus a fill, never a bare fill: at one event out of ninety-eight a
     lone 1%-wide rule reads as a speck of dirt under the number rather than as
     the smallest bar in the column. */
  const share = (n, top) =>
    `<span class="share"><span class="share__f" style="width:${Math.max(pct(n, top), n ? 3 : 0).toFixed(1)}%"></span></span>`;

  /* --- 4.5 geography --------------------------------------------------- */

  function geo(d) {
    const rows = d.geo || [];
    const body = $('#geoTbl tbody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5" class="mut">No events in this period</td></tr>`;
      return;
    }
    const top = Math.max(...rows.map(r => r.events), 1);
    body.innerHTML = rows.map(r => {
      const cr = pct(r.leads, r.events);
      return `<tr>
        <td>${flagCell(r.country)}</td>
        <td class="r">${int(r.events)}${share(r.events, top)}</td>
        <td class="r">${rowDelta(r.events, r.events_prev)}</td>
        <td class="r">${int(r.leads)}</td>
        <td class="r ${r.leads ? '' : 'mut'}">${r.events ? pctTxt(cr) : '—'}</td>
      </tr>`;
    }).join('');
  }

  /* SPEC §7 asks the country table for "flags and coloured deltas". The arrow
     carries the direction and the colour reinforces it — never colour alone.
     `null` means no previous window was asked for, which is not the same as a
     previous window that was empty, and must not draw the same cell. */
  function rowDelta(now, before) {
    if (before == null) return '<span class="mut">—</span>';
    if (!before) return now ? '<span class="gd gd--new">new</span>' : '<span class="mut">—</span>';
    const v = ((now - before) / before) * 100;
    const dir = Math.abs(v) < 0.5 ? 'flat' : v > 0 ? 'up' : 'down';
    const arrow = dir === 'flat' ? '→' : dir === 'up' ? '↑' : '↓';
    const txt = Math.abs(v) >= 1000 ? '999+' : Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0);
    return `<span class="gd gd--${dir}" title="${int(before)} in the period before this one">` +
      `<span aria-hidden="true">${arrow}</span>${txt}%</span>`;
  }

  /* --- 4.6 devices ----------------------------------------------------- */

  let chDev = null;

  function devices(d) {
    const rows = (d.byDevice || []).filter(r => r.n > 0);
    const total = rows.reduce((a, r) => a + r.n, 0);
    const colours = [css('--c-1'), css('--c-2'), css('--c-3'), css('--s-test')];

    $('#devLegend').innerHTML = rows.length
      ? rows.map((r, i) => `<span class="lg">
          <span class="lg__sw" style="background:${colours[i % colours.length]}"></span>
          ${ico(DEVICE_ICON[r.device] || 'globe', 'ico ico--sm')}
          <span>${esc(r.device)}</span>
          <span class="lg__n">${int(r.n)}</span>
          <span class="lg__pc">${pctTxt(pct(r.n, total))}</span></span>`).join('')
      : `<p class="mut">No events in this period</p>`;

    $('#devTable').innerHTML = tableAlt('Devices', ['Device', 'Events', 'Share'],
      rows.map(r => [r.device, int(r.n), pctTxt(pct(r.n, total))]));

    const labels = rows.map(r => r.device);
    const values = rows.map(r => r.n);
    // Same three cases as the area chart: the sweep is an entrance, not a
    // heartbeat. Replacing `data` wholesale replayed it on every poll.
    const sig = JSON.stringify([labels, values]);
    if (chDev && chDev.$sig === sig) { chDev.$total = total; return; }

    const cfgData = {
      labels,
      datasets: [{
        data: values,
        backgroundColor: rows.map((_, i) => colours[i % colours.length]),
        borderWidth: 0,
        spacing: 2,                 // the 2px surface gap, not a drawn border
        borderRadius: 3,
        hoverOffset: 7,
      }],
    };

    if (!chDev) {
      chDev = new Chart($('#chDev'), {
        type: 'doughnut',
        data: cfgData,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '68%',
          animation: REDUCED ? false : { animateRotate: true, duration: 700, easing: 'easeOutCubic' },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: css('--card-2'),
              borderColor: css('--line'), borderWidth: 1,
              titleColor: css('--ink'), bodyColor: css('--ink-2'),
              padding: 10, displayColors: true, boxPadding: 4,
              callbacks: { label: c => ` ${int(c.parsed)} · ${pctTxt(pct(c.parsed, total))}` },
            },
          },
        },
        plugins: [donutCentre],
      });
    } else {
      // The arcs may grow or shrink into their new share; the ring only sweeps
      // out again when the question changed.
      if (!REDUCED) chDev.options.animation.animateRotate = !!S.reveal;
      chDev.data = cfgData;
      chDev.update();
    }
    chDev.$sig = sig;
    chDev.$total = total;
  }

  /* The hole is wasted unless it answers the question the donut raises. */
  const donutCentre = {
    id: 'donutCentre',
    afterDraw(c) {
      const { ctx, chartArea: a } = c;
      if (!a) return;
      const act = c.getActiveElements();
      const total = c.$total || 0;
      const n = act.length ? c.data.datasets[0].data[act[0].index] : total;
      const lab = act.length ? c.data.labels[act[0].index] : 'events';
      const x = (a.left + a.right) / 2, y = (a.top + a.bottom) / 2;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = css('--ink');
      ctx.font = `640 21px ${css('--sans')}`;
      ctx.fillText(int(n), x, y + 2);
      ctx.fillStyle = css('--ink-3');
      ctx.font = `500 11px ${css('--sans')}`;
      ctx.fillText(String(lab), x, y + 18);
      ctx.restore();
    },
  };

  /* --- 4.7 live tail ---------------------------------------------------- */

  function tail(d) {
    const rows = (d.recent || []).slice(0, 10);
    const body = $('#tailTbl tbody');
    if (!rows.length) {
      body.innerHTML = `<tr><td colspan="5" class="mut">No events in this period</td></tr>`;
      return;
    }
    const first = !S.seen.size;
    body.innerHTML = rows.map(r => {
      const key = `${r.created_at}|${r.type}|${r.country}|${r.browser}`;
      const fresh = !first && !S.seen.has(key);
      S.seen.add(key);
      return `<tr class="${fresh ? 'is-new' : ''}">
        <td class="mut">${esc(timeOf(r.created_at))}</td>
        <td>${typeTag(r.type)}</td>
        <td>${flagCell(r.country)}</td>
        <td><span class="cell">${ico(DEVICE_ICON[r.device] || 'globe', 'ico ico--sm')}<span>${esc(r.device)}</span></span></td>
        <td class="mut">${esc(r.browser)}</td>
      </tr>`;
    }).join('');

    if (S.seen.size > 400) S.seen = new Set(rows.map(r => `${r.created_at}|${r.type}|${r.country}|${r.browser}`));
    requestAnimationFrame(() => $$('.is-new', body).forEach(tr =>
      setTimeout(() => tr.classList.remove('is-new'), 1400)));
  }

  const TYPE_COLOUR = { pageview: '--s-view', click: '--s-click', lead: '--s-lead', test: '--s-test' };
  const typeTag = t =>
    `<span class="tag"><span class="tag__dot" style="background:var(${TYPE_COLOUR[t] || '--s-test'})"></span>${esc(t)}</span>`;

  /* --- 4.8 monetisation -------------------------------------------------- */

  /* A row saying "5 more ads" with no way to see them is a dead end — the same
     shape as a figure that does not explain itself. It is a real button, so it
     is keyboard reachable and announces its state; opening it asks the server
     for a longer list rather than hiding rows the page never had. */
  const foldBtn = (n, what) =>
    `<button type="button" class="fold" data-open-fold aria-expanded="false">` +
    `${ico('chevron', 'ico ico--sm fold__i')}` +
    `<span>Show ${int(n)} more ${esc(what)}${n === 1 ? '' : 's'}</span></button>`;

  /* Bounded on purpose. "Everything" on an account with a thousand ads is not
     a thing to hand a browser, and an unbounded table is what the fold exists
     to prevent; the server clamps this again. */
  const FOLD_TOP = 40;

  function money(d) {
    const ads = d.byAd || [];
    $('#adTbl tbody').innerHTML = ads.length
      ? ads.map(r => {
          /* A postback carries the ad macros of the click it was matched to.
             When it matched nothing — a click id this tracker has never seen —
             there is no campaign and no ad to name. Two blank cells read as
             missing data; this is the opposite, a case the pipeline handles on
             purpose, so the row says what it is, in the row: a title attribute
             is where an explanation goes to be unread.

             Not "No click" either: the network DID report one, and a reader who
             takes this for organic traffic has it backwards — organic traffic
             produces no postback at all. What is missing is OUR record. */
          /* The folded tail: everything past the ninth ad, in one row, so the
             column still sums to the Revenue tile however many ads exist. */
          if (r.folded) {
            return `<tr class="is-folded">
              <td colspan="2">${foldBtn(r.folded_n, 'ad')}</td>
              <td class="r">${int(r.approved)}${pendRej(r)}</td>
              <td class="r">${cash(r.revenue)}</td>
            </tr>`;
          }
          const orphan = r.matched === false;
          return `<tr${orphan ? ' class="is-orphan"' : ''}>
            <td${orphan ? ' colspan="2"' : ''}>${
              orphan
                ? '<span class="cell">' + ico('unlink', 'ico ico--sm') +
                  /* The payout is the network's, not ours to withhold: it was
                     approved and it is owed. Only the CREDIT is missing. Drop
                     the row and the Revenue tile would report less than the
                     network actually settled, and this table would stop
                     summing to it — the same silent discrepancy twice fixed
                     elsewhere on this page. */
                  /* The trade's own word, and the one already on the
                     Conversions tile ("1 unmatched") and in the column the
                     database keeps it in (conversions.matched) — so the page,
                     the figure above it and the schema all say the same thing.
                     Not "unmatched / unknown": those are two names for one
                     state, and a slash in a table cell reads as a boundary
                     between two categories rather than as a synonym. The term
                     carries nothing on its own, which is what the line under
                     it is for. */
                  '<span class="orph"><b>Unmatched</b>' +
                  '<i>the network reported a click this tracker never recorded — ' +
                  'the payout still counts, there is just no ad to credit it to</i></span></span>'
                : esc(r.campaign || '—')}</td>
            ${orphan ? '' : `<td class="mut">${esc(r.ad || '—')}</td>`}
            <td class="r">${int(r.approved)}${pendRej(r)}</td>
            <td class="r">${cash(r.revenue)}</td>
          </tr>`;
        }).join('')
      : `<tr><td colspan="4" class="mut">No conversions in this period</td></tr>`;

    // Only offered once something is actually unfolded, and only while there
    // is nothing left to unfold — otherwise both controls would be on screen.
    $('#foldLess').hidden = !(S.top > 9 && !ads.some(r => r.folded));

    const refs = d.byRef || [];
    const top = Math.max(...refs.map(r => r.n), 1);
    $('#refTbl tbody').innerHTML = refs.length
      ? refs.map(r => `<tr${r.folded ? ' class="is-folded"' : ''}>
          <td>${r.folded ? foldBtn(r.folded_n, 'source') : refCell(r.host)}</td>
          <td class="r">${int(r.n)}${share(r.n, top)}</td>
        </tr>`).join('')
      : `<tr><td colspan="2" class="mut">No events in this period</td></tr>`;
  }

  /* The count in the Conv. column is APPROVED conversions — the ones the money
     column is summed from, so the two columns finally agree. Anything the
     network has not settled as approved is named underneath rather than folded
     silently into the same number. */
  function pendRej(r) {
    const bits = [];
    if (r.pending)  bits.push(`<span class="pr pr--pend">+${int(r.pending)} pending</span>`);
    if (r.rejected) bits.push(`<span class="pr pr--rej">+${int(r.rejected)} rejected</span>`);
    return bits.length ? `<span class="prs">${bits.join('')}</span>` : '';
  }

  /* `direct` and `internal` are not hosts, and a reader should not have to work
     out which of the three kinds a row is. */
  const REF_NOTE = {
    direct: 'typed, bookmarked, or an app that strips the referrer',
    internal: 'a move between pages of the same site',
    unknown: 'a referrer that could not be parsed',
  };
  const refCell = host => REF_NOTE[host]
    ? `<span class="cell"><span class="hint" title="${esc(REF_NOTE[host])}">${esc(host)}</span></span>`
    : `<span class="cell">${esc(host)}</span>`;

  function tableAlt(caption, head, rows) {
    return `<table><caption>${esc(caption)}</caption><thead><tr>` +
      head.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table>';
  }

  /* --- 4.9 delivery health ------------------------------------------------ */

  /* Where the calls went, taken from the delivery rows themselves. The
     pipeline sends to Meta when META_PIXEL_ID and META_ACCESS_TOKEN are
     attached and to its own stand-in otherwise, and a page that stated either
     one in fixed text would become false the day the other was true. */
  const DEST = {
    meta: ['Meta Conversions API', 'Delivered to Meta’s Conversions API endpoint'],
    sink: ['a stand-in endpoint', 'No Meta credentials are attached, so the requests go to an endpoint of ours that answers with the Graph API’s own contract. Attaching META_PIXEL_ID and META_ACCESS_TOKEN changes the destination, not the code — real CAPI can only be verified inside the account owner’s Events Manager, which a visitor cannot open.'],
  };

  /* "Reversed" is the trade's word for the advertiser retracting a conversion
     it had already confirmed, and it is not obvious from outside the trade. */
  const REVERSAL = 'The advertiser retracted a conversion it had already confirmed — a second postback with the same txid, arriving with status=rejected. In lead generation this is usually an order the call centre could not confirm; elsewhere a failed payment, a refund inside the return window, or a fraud check.';

  function health(d) {
    const c = d.capi || {};
    const items = [
      ['delivered', c.delivered, '--up'],
      ['failed',    c.failed,    '--down'],
      ['skipped',   c.skipped,   '--ink-3'],
    ];
    $('#health').innerHTML = items.map(([l, n, v]) =>
      `<span class="hs"><span class="hs__dot" style="background:var(${v})"></span>` +
      `<span class="hs__n">${int(n)}</span><span class="hs__l">${esc(l)}</span></span>`).join('') +
      `<span class="hs"><span class="hs__n">${int(c.avg_ms)}<span class="hs__l"> ms</span></span>` +
      `<span class="hs__l">average round trip</span></span>`;

    const dests = d.capiDest || [];
    const note = $('#healthDest');
    const lines = [];

    if (dests.length) {
      lines.push(dests.map(k => {
        const [label, why] = DEST[k] || [esc(k), ''];
        return `Sent to <span class="hint" title="${esc(why)}">${label}</span>`;
      }).join(' · '));
    }

    /* Why `delivered` can be larger than the Conversions tile, said where the
       two numbers sit rather than left for the reader to reconcile: a call
       goes out when a postback settles a conversion as approved, and a later
       postback with the same txid can reverse it — by which time the platform
       has already been told, and the call cannot be un-sent. A pending
       conversion, on the other hand, triggers no call at all. */
    const reversed = Number(d.capiReversed) || 0;
    const fixed = Number(d.capiCompensated) || 0;
    const open = Math.max(reversed - fixed, 0);
    const approved = Number(d.conversions?.approved) || 0;
    const delivered = Number(d.capi?.delivered) || 0;

    /* One sentence, because it is one thought. Split in two, the second half
       lost its subject — "a compensating call was sent and accepted" reads as
       a claim about nothing until the reader works out that it refers to the
       figure in the sentence before it. And the arithmetic has to close: the
       corrections are themselves among the delivered calls, so 6 approved plus
       1 reversed plus 1 that took it back is the 8 at the top of the card. */
    if (reversed > 0) {
      const them = reversed === 1 ? 'it' : 'them';
      /* "Deliveries", never "calls". In lead generation a call is a thing a
         call centre makes to a person — the REVERSAL note below is about
         exactly that — so the same word for an HTTP request to the platform
         reads, to the one reader who knows this trade, as somebody phoning a
         lead. It also matches the card's own title and its three counters. */
      let line = `${int(delivered)} deliver${delivered === 1 ? 'y' : 'ies'} for ` +
        `${int(approved)} conversion${approved === 1 ? '' : 's'} approved now: ` +
        `<b>${int(reversed)}</b> went out before the network ` +
        `<span class="hint" title="${esc(REVERSAL)}">reversed</span> ${them}`;
      if (fixed > 0) {
        line += `, and <b>${int(fixed)}</b> more took ${fixed === 1 ? 'it' : 'them'} back`;
      }
      lines.push(line + '.');

      // The only figure here that is a problem: a signal the platform still
      // believes and we have not withdrawn. Silence when there is none.
      if (open > 0) {
        lines.push(`<span class="bad">⚠ ${int(open)} of them not taken back yet — the platform is still ` +
          `optimising on ${open === 1 ? 'a conversion' : 'conversions'} that no longer ` +
          `${open === 1 ? 'exists' : 'exist'}. The retry sweeper picks ${open === 1 ? 'it' : 'them'} up.</span>`);
      }
    }

    note.hidden = !lines.length;
    note.innerHTML = lines.map(l => `<span class="note__l">${l}</span>`).join('');
  }

  /* ------------------------------------------------------------------ *
   * controls — one filter row, scoping every block below it
   * ------------------------------------------------------------------ */

  function touch() { S.lastTouch = Date.now(); if (!S.timer) start(); }

  $$('.seg__b').forEach(b => b.addEventListener('click', () => {
    if (b.classList.contains('is-on')) return;
    $$('.seg__b').forEach(o => { o.classList.remove('is-on'); o.removeAttribute('aria-pressed'); });
    b.classList.add('is-on');
    b.setAttribute('aria-pressed', 'true');
    S.period = b.dataset.period;
    S.reveal = true;
    S.top = 9;
    touch();
    // A new period means new deltas, so this one asks for them.
    load({ withPrev: true });
  }));

  $('#site').addEventListener('change', e => {
    S.site = e.target.value || null;
    S.reveal = true;
    S.top = 9;
    touch();
    load({ withPrev: true });
  });

  $('#retry').addEventListener('click', () => { touch(); load({ withPrev: true }); });

  /* ------------------------------------------------------------------ *
   * the two demo buttons (§3)
   *
   * They POST to the tracking endpoint that already exists and already
   * accepts anonymous cross-origin POSTs — that is what a pixel is. Country
   * and device come from the request at the edge, so there is nothing to
   * send but a type and a source name.
   * ------------------------------------------------------------------ */

  async function sendDemo(btn, type) {
    const label = $('.demo__l', btn);
    const was = label.textContent;
    btn.disabled = true;
    label.textContent = 'Sending…';
    try {
      const r = await fetch(TRACK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, site: 'track-board' }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 429) label.textContent = 'Slow down a moment';
      else if (!r.ok || j.ok === false) label.textContent = 'Refused';
      else {
        label.textContent = 'Sent — watch the table';
        // The row is written before the response returns; one refresh is enough.
        setTimeout(() => load({ quiet: true }), 700);
      }
    } catch {
      label.textContent = 'Could not reach the endpoint';
    }
    setTimeout(() => { label.textContent = was; btn.disabled = false; }, 2600);
    touch();
  }

  $$('[data-demo]').forEach(b =>
    b.addEventListener('click', () => sendDemo(b, b.dataset.demo)));

  /* Opening or closing the tail. Delegated, because the button is rebuilt on
     every render of the block. */
  $('.card--money').addEventListener('click', e => {
    const b = e.target.closest('[data-open-fold]');
    if (!b) return;
    b.setAttribute('aria-expanded', 'true');
    b.disabled = true;
    S.top = FOLD_TOP;
    touch();
    load({ quiet: true });
  });

  $('#foldLessBtn').addEventListener('click', () => {
    S.top = 9;
    touch();
    load({ quiet: true });
  });

  /* ------------------------------------------------------------------ *
   * modal (§5) — Esc, outside click, focus trapped, focus returned
   * ------------------------------------------------------------------ */

  const modal = $('#howModal'), howBtn = $('#howBtn');
  const FOCUSABLE = 'button, [href], select, input, [tabindex]:not([tabindex="-1"])';

  function openModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    howBtn.setAttribute('aria-expanded', 'true');
    ($(FOCUSABLE, modal) || modal).focus();
    document.addEventListener('keydown', trap, true);
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
    howBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', trap, true);
    howBtn.focus();
  }

  function trap(e) {
    if (e.key === 'Escape') { e.preventDefault(); return closeModal(); }
    if (e.key !== 'Tab') return;
    const f = $$(FOCUSABLE, modal).filter(el => el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  howBtn.addEventListener('click', () => (modal.hidden ? openModal() : closeModal()));
  $$('[data-close]', modal).forEach(el => el.addEventListener('click', closeModal));

  /* ------------------------------------------------------------------ *
   * the left rail
   *
   * Every entry is a real destination on this page — there is nothing here
   * that does not go somewhere, which is the whole reason a rail was allowed
   * onto a single-page dashboard at all. It lights up to follow the reader.
   * ------------------------------------------------------------------ */

  /* ONE ENTRY PER GRID ROW, not one per block.
     From 1100px the blocks sit in pairs on a row — funnel beside the time
     chart, geography beside devices, monetisation beside delivery health — and
     a pair is on screen together. Eight entries over five rows meant two of
     them were "here" at once, which is not what an active nav item means: a
     reader sees two highlights and reads a bug. The granularity of the rail
     has to be the granularity the layout can actually distinguish. */
  const RAIL = [
    ['sec-kpis',   'Headline',             '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'],
    ['sec-funnel', 'Funnel & trend',       '<path d="M3 4h18l-7 8v8l-4-2v-6z"/>'],
    ['sec-geo',    'Geography & devices',  '<circle cx="12" cy="12" r="9"/><path d="M12 3a15 15 0 0 0 0 18 15 15 0 0 0 0-18"/><path d="M3 12h18"/>'],
    ['sec-tail',   'Live events',          '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.4" fill="currentColor"/>'],
    ['sec-money',  'Revenue & delivery',   '<path d="M12 2v20"/><path d="M17 6.5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'],
  ];

  /* Every block, including the ones the rail does not link to directly: the
     spy needs all of them to work out which ROW is being read. */
  const SECTIONS = ['sec-kpis', 'sec-funnel', 'sec-series', 'sec-geo', 'sec-dev',
                    'sec-tail', 'sec-money', 'sec-health'];

  $('#rail').innerHTML = RAIL.map(([id, label, path]) =>
    `<li><a class="rail__b" href="#${id}" data-label="${label}" aria-label="${label}">` +
    `<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg></a></li>`).join('');

  /* The rule is "the last section whose top has passed under the header", and
     it has to be exactly that.

     The first version asked an IntersectionObserver for every section on
     screen and lit the one with the smallest boundingClientRect.top. That is
     backwards: a section already scrolled halfway off the top has a large
     NEGATIVE top, so it beat the section the reader had actually jumped to —
     click Geography, watch Funnel light up. */
  (function railFollow() {
    const links = new Map($$('.rail__b').map(a => [a.getAttribute('href').slice(1), a]));
    const secs = SECTIONS.map(id => document.getElementById(id)).filter(Boolean);
    if (!secs.length) return;

    let pinned = null, pinnedUntil = 0;
    const setOn = ids => links.forEach((a, k) => a.classList.toggle('is-on', ids.has(k)));

    /* From ≥1100px the blocks sit in PAIRS on one grid row — funnel beside the
       time chart, geography beside devices, monetisation beside delivery
       health — and a pair shares one top. A spy that must name ONE section per
       scroll position can therefore never reach the other half of each pair:
       picking the last that passed hides the left three, picking the first
       hides the right three. Measured both ways; each left three items dead.

       So the active unit is the ROW. The rail carries one entry per row (see
       RAIL above), so resolving a row lights exactly one icon — a reader never
       sees two "you are here" marks. Rows are grouped by measuring in one
       frame, never cached: heights change as data lands and the whole layout
       changes at the breakpoints. */
    const rowOf = (rects, top) => new Set(
      rects.filter(r => Math.abs(r.top - top) < 8).map(r => r.id));

    function measure() {
      return secs.map(s => ({ id: s.id, top: s.getBoundingClientRect().top }));
    }

    function pick() {
      // A click is an intention. Hold it lit while the smooth scroll is still
      // travelling, or the spy lights every row on the way past.
      if (pinned && performance.now() < pinnedUntil) return setOn(pinned);
      pinned = null;

      // The reading line, just under the sticky header — whose height changes
      // when it collapses, so it is measured rather than assumed.
      const line = ($('.top')?.getBoundingClientRect().height || 96) + 26;
      const rects = measure();
      const passed = rects.filter(r => r.top - line <= 0);

      let top;
      if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
        // The last row is usually too short to ever cross the line on its own.
        top = Math.max(...rects.map(r => r.top));
      } else if (passed.length) {
        top = Math.max(...passed.map(r => r.top));   // the lowest row already read
      } else {
        top = Math.min(...rects.map(r => r.top));    // still above the first one
      }
      setOn(rowOf(rects, top));
    }

    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; pick(); });
    };
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });

    links.forEach((a, id) => a.addEventListener('click', () => {
      // Pin the whole row, not just the icon clicked: otherwise a second icon
      // joins it the moment the pin expires, which reads as a glitch.
      const rects = measure();
      pinned = rowOf(rects, rects.find(r => r.id === id).top);
      pinnedUntil = performance.now() + 1000;
      setOn(pinned);
    }));

    pick();
  })();

  /* The footer is rendered by common.js, which both pages load — a list of
     links copied into two files drifts, and this one changes once a year. */

  /* ------------------------------------------------------------------ *
   * refresh (§9)
   *
   * Poll while the tab is visible, stop when it is not, refresh at once on
   * return. And stop after ten idle minutes: a portfolio link left open in a
   * forgotten tab would otherwise call a serverless function four times a
   * minute for as long as the browser is open.
   * ------------------------------------------------------------------ */

  function start() {
    stop();
    S.timer = setInterval(() => {
      if (document.hidden) return;
      if (Date.now() - S.lastTouch > IDLE_MS) {
        stop();
        $('#live').classList.add('is-paused');
        $('#liveTxt').textContent = 'Paused while idle — click anywhere to resume';
        return;
      }
      load({ quiet: true });
    }, POLL_MS);
  }

  function stop() { clearInterval(S.timer); S.timer = 0; }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { stop(); return; }
    touch();
    load({ quiet: true });
  });

  ['pointerdown', 'keydown', 'focus'].forEach(ev =>
    window.addEventListener(ev, () => {
      const wasIdle = !S.timer;
      touch();
      if (wasIdle) { $('#live').classList.remove('is-paused'); load({ quiet: true }); }
    }, { passive: true }));

  /* ------------------------------------------------------------------ *
   * this page's own pixel
   *
   * A visit here becomes a real event, with the visitor's real country read
   * at the edge, and it shows up on BOTH dashboards — one row in the shared
   * database, read by each. Which is the point: somebody opening this link
   * can watch their own arrival appear in the table below.
   *
   * Injected rather than written as a <script> tag so it can be skipped on
   * localhost: development traffic has no business in the live figures, and
   * the page is served locally far more often than it is visited.
   * ------------------------------------------------------------------ */
  (function pixel() {
    if (/^(localhost|127\.|0\.0\.0\.0|\[?::1)/i.test(location.hostname)) return;
    const s = document.createElement('script');
    s.src = new URL('/t.js', TRACK_URL).href;
    s.defer = true;
    s.setAttribute('data-site', 'track-board');
    document.head.appendChild(s);
  })();

  /* ------------------------------------------------------------------ *
   * boot
   * ------------------------------------------------------------------ */

  /* A 1px sentinel above the header, watched instead of a scroll listener:
     the class flips on the compositor's schedule rather than on every frame. */
  (function scrollState() {
    const s = document.createElement('div');
    s.setAttribute('aria-hidden', 'true');
    s.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px';
    document.body.prepend(s);
    new IntersectionObserver(([e]) =>
      document.body.classList.toggle('is-scrolled', !e.isIntersecting)).observe(s);
  })();

  $('#board').classList.add('is-loading');
  load({ withPrev: true });
  start();
})();
