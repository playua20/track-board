import { createClient } from '@supabase/supabase-js';

// Read-only. The service_role key stays on the server and never reaches the
// browser; the database itself is owned by ../server-side-tracking and this
// project adds nothing to it but board_geo (db/schema.sql).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const PERIODS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, all: null };

const iso = hoursAgo => new Date(Date.now() - hoursAgo * 3600e3).toISOString();
const num = v => (v == null ? 0 : Number(v) || 0);
const typeCount = (data, type) =>
  num((data?.byType || []).find(t => t.type === type)?.n);

/**
 * The KPI tiles need the period before this one, and dashboard_stats takes a
 * start but no end — a shifted window cannot be asked for. It does not have to
 * be: every figure a delta uses is a count or a sum, so a window of twice the
 * length minus the current one IS the previous one, arithmetically. One extra
 * round trip, no change to the shared function.
 *
 * Only for a bounded period: `all` has nothing before it.
 */
const previous = (wide, now) => ({
  total:       num(wide.total) - num(now.total),
  leads:       typeCount(wide, 'lead') - typeCount(now, 'lead'),
  conversions: num(wide.conversions?.approved) - num(now.conversions?.approved),
  revenue:     +(num(wide.conversions?.revenue) - num(now.conversions?.revenue)).toFixed(2),
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    const period = Object.hasOwn(PERIODS, q.period) ? q.period : '30d';
    const hours = PERIODS[period];
    // The site name arrives from the page's own selector, so it is untrusted:
    // keep it to the shape a site name actually has.
    const site = /^[\w.-]{1,64}$/.test(q.site || '') ? q.site : null;
    // The deltas move slowly and cost a whole extra aggregation, so the 15s
    // poll leaves them alone: the page asks for them on load and whenever the
    // period or the source changes.
    const wantPrev = q.prev === '1' && hours != null;
    const since = hours ? iso(hours) : null;

    const calls = [
      supabase.rpc('dashboard_stats', { p_site: site, p_since: since }),
      supabase.rpc('board_detail', {
        p_site: site,
        p_since: since,
        // Bounded on both sides, so the geography table gets a direction per
        // country without the doubled-window subtraction the KPI tiles need.
        p_prev_since: wantPrev ? iso(hours * 2) : null,
      }),
    ];
    if (wantPrev) {
      calls.push(supabase.rpc('dashboard_stats', { p_site: site, p_since: iso(hours * 2) }));
    }

    const [statsRes, detailRes, wideRes] = await Promise.all(calls);
    if (statsRes.error) throw statsRes.error;

    const data = statsRes.data || {};
    // A failure in the extra aggregations must not take the page down with it:
    // the blocks that depend on them degrade, the rest still renders.
    const detail = detailRes?.error ? {} : (detailRes?.data || {});
    res.status(200).json({
      ...data,
      funnel:    detail.funnel || null,
      // Ours replaces dashboard_stats' byAd — same rows, split by status.
      byAd:      detail.byAd || data.byAd || [],
      capiDest:  detail.capiDest || [],
      capiStale: detail.capiStale ?? 0,
      geo:    detail.geo || [],
      series: detail.series || [],
      bucket: detail.bucket || 'hour',
      prev: wantPrev && !wideRes?.error && wideRes?.data
        ? previous(wideRes.data, data) : null,
      period,
      site,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
