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

  function flagCell(code) {
    const name = countryName(code);
    if (!name) return `<span class="cell"><span class="flag" aria-hidden="true"></span><span>Unknown</span></span>`;
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
    timer: 0,
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
      conv:   Number(d.conversions?.pending) ? `${int(d.conversions.pending)} pending` : '',
      rev:    cur.conv ? `${cash(cur.rev / cur.conv)} average payout` : '',
    };
    for (const k of Object.keys(notes)) $(`[data-n="${k}"]`).textContent = notes[k];

    // /api/stats reports the previous window under the database's own names.
    const PREV_KEY = { events: 'total', leads: 'leads', conv: 'conversions', rev: 'revenue' };
    for (const k of Object.keys(cur)) delta($(`[data-d="${k}"]`), cur[k], d.prev ? d.prev[PREV_KEY[k]] : null);

    sparks(d);
  }

  function delta(el, now, before) {
    if (before == null) { el.className = 'delta'; el.textContent = ''; return; }
    if (!before && !now) { el.className = 'delta delta--flat'; el.textContent = 'no change'; return; }
    if (!before) {
      el.className = 'delta delta--new';
      el.innerHTML = '<span aria-hidden="true">↑</span><span>new</span>';
      el.title = 'Nothing in the period before this one to compare against';
      return;
    }
    const v = ((now - before) / before) * 100;
    const up = v >= 0;
    el.className = 'delta delta--' + (Math.abs(v) < 0.5 ? 'flat' : up ? 'up' : 'down');
    // The arrow carries the direction; the colour only reinforces it (§10).
    el.innerHTML = `<span aria-hidden="true">${Math.abs(v) < 0.5 ? '→' : up ? '↑' : '↓'}</span>` +
      `<span>${Math.abs(v) >= 1000 ? '999+' : Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%</span>`;
    el.title = `${up ? 'Up' : 'Down'} from ${int(before)} in the period before this one`;
  }

  /* Sparklines are inline SVG rather than four more canvases: they have to sit
     behind the tile's own padding and take the card's gradient. */
  function sparks(d) {
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
      // A flat line of zeroes says nothing the big number does not already say.
      box.innerHTML = rows.length > 1 && vals.some(v => v > 0) ? sparkSvg(vals, k) : '';
    }
  }

  function sparkSvg(vals, key) {
    const W = 100, H = 30, max = Math.max(...vals, 1);
    const pts = vals.map((v, i) => [
      (i / (vals.length - 1)) * W,
      H - (v / max) * (H - 3) - 1.5,
    ]);
    const line = pts.map(([x, y], i) => (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2)).join(' ');
    const area = `${line} L${W} ${H} L0 ${H} Z`;
    const id = 'sg-' + key;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--accent)" stop-opacity=".30"/>
        <stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#${id})"/>
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="1.4"
            stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  /* --- 4.3 funnel ----------------------------------------------------- */

  function funnel(d) {
    const steps = [
      ['Pageviews',   typeN(d, 'pageview')],
      ['Clicks',      typeN(d, 'click')],
      ['Leads',       typeN(d, 'lead')],
      ['Conversions', Number(d.conversions?.approved) || 0],
    ];
    const top = Math.max(steps[0][1], 1);
    const box = $('#funnel');

    // Built once, then only the numbers and the widths move — so the bars can
    // transition instead of being replaced.
    if (!box.childElementCount) {
      box.innerHTML = steps.map(([name], i) => (i ? `<div class="fdrop"></div>` : '') + `
        <div class="fstep" data-i="${i}">
          <div class="fstep__top"><span class="fstep__name">${esc(name)}</span><span class="fstep__n">0</span></div>
          <div class="fstep__bar"><span class="fstep__fill" style="width:0%"></span></div>
          <p class="fstep__of"></p>
        </div>`).join('');
    }

    const stepEls = $$('.fstep', box), dropEls = $$('.fdrop', box);
    steps.forEach(([name, n], i) => {
      tween($('.fstep__n', stepEls[i]), n, int);
      const fill = $('.fstep__fill', stepEls[i]);
      fill.style.width = Math.max(pct(n, top), n ? 2 : 0).toFixed(2) + '%';
      fill.title = `${int(n)} — ${pctTxt(pct(n, top))} of ${esc(steps[0][0]).toLowerCase()}`;
      // Only on the last step: between the others the drop-off line already
      // says what share carried through, and two percentages one line apart
      // read as a contradiction rather than as two facts.
      $('.fstep__of', stepEls[i]).textContent =
        i === steps.length - 1 && top ? `${pctTxt(pct(n, top))} end to end` : '';
    });

    steps.slice(1).forEach(([, n], i) => {
      const before = steps[i][1];
      dropEls[i].innerHTML = drop(before, n);
    });

    $('.card--funnel').setAttribute('aria-label',
      'Funnel: ' + steps.map(([n, v]) => `${n} ${int(v)}`).join(', '));
  }

  /* A funnel assumes each stage is smaller than the one above it, and real data
     does not have to oblige: a lead can be sent without a click before it, and
     a postback can settle against a click from an earlier period. Saying
     "-42.9% lost" in that case is not a rounding wrinkle — it is the block
     telling the reader something false. */
  function drop(before, after) {
    if (!before) return `${ico('chevron')}<span>nothing above to carry through</span>`;
    if (after > before) {
      return `${ico('flag')}<span class="fdrop--up">${int(after - before)} more than the stage above — sent without one, or settled from an earlier period</span>`;
    }
    const kept = pct(after, before);
    return `${ico('chevron')}<span>${pctTxt(kept)} carried through` +
      `<span class="fdrop__lost"> · ${pctTxt(100 - kept)} lost</span></span>`;
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

    const cv = $('#chSeries');
    const datasets = use.map(s => {
      const colour = css(s.varName);
      return {
        label: s.label,
        data: rows.map(r => r[s.key]),
        borderColor: colour,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: colour,
        pointHoverBorderColor: css('--card'),
        pointHoverBorderWidth: 2,
        tension: .34,
        fill: true,
        backgroundColor: ctx => fade(ctx, colour),
      };
    });

    if (!chSeries) {
      chSeries = new Chart(cv, {
        type: 'line',
        data: { labels, datasets },
        options: seriesOptions(full),
        plugins: [crosshair],
      });
    } else {
      chSeries.data.labels = labels;
      chSeries.data.datasets = datasets;
      chSeries.$full = full;
      chSeries.update();
    }
    chSeries.$full = full;
  }

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
      animations: REDUCED ? {} : { y: { from: ctx => (ctx.chart.chartArea ? ctx.chart.chartArea.bottom : undefined) } },
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
      body.innerHTML = `<tr><td colspan="4" class="mut">No events in this period</td></tr>`;
      return;
    }
    const top = Math.max(...rows.map(r => r.events), 1);
    body.innerHTML = rows.map(r => {
      const cr = pct(r.leads, r.events);
      return `<tr>
        <td>${flagCell(r.country)}</td>
        <td class="r">${int(r.events)}${share(r.events, top)}</td>
        <td class="r">${int(r.leads)}</td>
        <td class="r ${r.leads ? '' : 'mut'}">${r.events ? pctTxt(cr) : '—'}</td>
      </tr>`;
    }).join('');
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

    const cfgData = {
      labels: rows.map(r => r.device),
      datasets: [{
        data: rows.map(r => r.n),
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
      chDev.data = cfgData;
      chDev.update();
    }
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

  function money(d) {
    const ads = d.byAd || [];
    $('#adTbl tbody').innerHTML = ads.length
      ? ads.map(r => `<tr>
          <td>${esc(r.campaign)}</td>
          <td class="mut">${esc(r.ad)}</td>
          <td class="r">${int(r.conversions)}</td>
          <td class="r">${cash(r.revenue)}</td>
        </tr>`).join('')
      : `<tr><td colspan="4" class="mut">No conversions in this period</td></tr>`;

    const refs = d.byRef || [];
    const top = Math.max(...refs.map(r => r.n), 1);
    $('#refTbl tbody').innerHTML = refs.length
      ? refs.map(r => `<tr>
          <td>${refCell(r.host)}</td>
          <td class="r">${int(r.n)}${share(r.n, top)}</td>
        </tr>`).join('')
      : `<tr><td colspan="2" class="mut">No events in this period</td></tr>`;
  }

  /* `direct` and `internal` are not hosts, and a reader should not have to work
     out which of the three kinds a row is. */
  const REF_NOTE = {
    direct: 'typed, bookmarked, or an app that strips the referrer',
    internal: 'a move between pages of the same site',
    unknown: 'a referrer that could not be parsed',
  };
  const refCell = host => REF_NOTE[host]
    ? `<span class="cell"><span title="${esc(REF_NOTE[host])}">${esc(host)}</span></span>`
    : `<span class="cell">${esc(host)}</span>`;

  function tableAlt(caption, head, rows) {
    return `<table><caption>${esc(caption)}</caption><thead><tr>` +
      head.map(h => `<th>${esc(h)}</th>`).join('') + '</tr></thead><tbody>' +
      rows.map(r => '<tr>' + r.map(c => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table>';
  }

  /* --- 4.9 delivery health ------------------------------------------------ */

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
    touch();
    // A new period means new deltas, so this one asks for them.
    load({ withPrev: true });
  }));

  $('#site').addEventListener('change', e => {
    S.site = e.target.value || null;
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
   * footer
   * ------------------------------------------------------------------ */

  const MARKS = {
    globe: ICONS.globe,
    github: '<path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C16.9 4.8 18 5.1 18 5.1c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>',
    telegram: '<path d="M11.9 0A12 12 0 1 0 12 24 12 12 0 0 0 11.9 0zm4.9 7.2c.1 0 .3 0 .5.1.1.1.2.2.2.4v.5c-.2 1.9-1 6.5-1.4 8.6-.2.9-.5 1.2-.8 1.2-.7.1-1.2-.5-1.9-.9-1-.7-1.6-1.1-2.7-1.8-1.2-.8-.4-1.2.3-1.9.2-.2 3.2-3 3.3-3.2v-.2c0-.1-.2 0-.2 0-.1 0-1.8 1.1-5.1 3.3-.5.3-.9.5-1.3.5-.4 0-1.3-.3-1.9-.4-.7-.3-1.3-.4-1.3-.8 0-.2.3-.5.9-.7 3.5-1.5 5.8-2.5 7-3 3.3-1.4 4-1.6 4.4-1.7z"/>',
  };
  const SOLID = new Set(['github', 'telegram']);
  $('.foot').innerHTML = [
    ['globe', 'Hire me', 'https://andriijs.netlify.app'],
    ['github', 'GitHub', 'https://github.com/playua20'],
    ['telegram', 'Telegram', 'https://t.me/andriijs'],
  ].map(([i, label, href]) =>
    `<a href="${href}" target="_blank" rel="noopener">` +
    `<svg class="ico${SOLID.has(i) ? ' solid' : ''}" viewBox="0 0 24 24" aria-hidden="true">${MARKS[i]}</svg>` +
    `<span>${label}</span></a>`).join('');

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
