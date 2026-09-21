import { createClient } from '@supabase/supabase-js';

// Read-only, like /api/stats. The service key stays on the server.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;
const COLUMNS = 'id,created_at,type,site,country,city,device,os,browser';

/**
 * Keyset ("cursor") pagination, not offset.
 *
 * `offset` is wrong for a table that is still being written to: an event
 * arriving between two page requests shifts every later row, so page 2 repeats
 * a row page 1 already showed and skips another entirely. It also gets slower
 * with depth, because the database walks and discards everything it skips. A
 * cursor names the last row seen — "older than this exact event" — which is
 * stable under inserts and a plain index seek.
 *
 * created_at alone is not unique, so the cursor is the pair (created_at, id)
 * and the comparison is lexicographic over both.
 */
const cursorOf = row => `${row.created_at}|${row.id}`;

function parseCursor(raw) {
  if (!raw) return null;
  const at = String(raw).lastIndexOf('|');
  if (at < 1) return null;
  const ts = raw.slice(0, at);
  const id = Number(raw.slice(at + 1));
  // Both halves are interpolated into a PostgREST filter, so both are checked
  // against an exact shape rather than merely being non-empty.
  if (!Number.isInteger(id) || id < 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:[+-]\d{2}:\d{2}|Z)$/.test(ts)) return null;
  if (Number.isNaN(Date.parse(ts))) return null;
  return { ts, id };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const q = req.query || {};
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(q.limit) || DEFAULT_LIMIT));
    const type = /^[a-z][a-z0-9_-]{0,31}$/.test(q.type || '') ? q.type : null;
    const country = /^[A-Z]{2}$/.test(q.country || '') ? q.country : null;
    const site = /^[\w.-]{1,64}$/.test(q.site || '') ? q.site : null;
    const cursor = parseCursor(q.before);

    // One row more than asked for: its presence is what tells us there is a
    // next page, without paying for a second count query.
    let rows = supabase.from('events').select(COLUMNS)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    if (type) rows = rows.eq('type', type);
    if (country) rows = rows.eq('country', country);
    if (site) rows = rows.eq('site', site);
    if (cursor) {
      rows = rows.or(`created_at.lt.${cursor.ts},and(created_at.eq.${cursor.ts},id.lt.${cursor.id})`);
    }

    // The filter lists and the total only change when the filters do, so they
    // ride along with the first page and not with every "load more".
    const firstPage = !cursor;
    const extras = firstPage ? [
      supabase.from('stats_by_type').select('*'),
      supabase.from('stats_by_country').select('*'),
      (() => {
        // 'estimated' is exact on a small table and falls back to the planner's
        // figure on a large one. An exact count(*) walks every matching row,
        // which is free at ten thousand and a visible pause at ten million —
        // for a caption reading "50 of N" nobody needs that precision.
        let c = supabase.from('events').select('*', { count: 'estimated', head: true });
        if (type) c = c.eq('type', type);
        if (country) c = c.eq('country', country);
        if (site) c = c.eq('site', site);
        return c;
      })(),
      supabase.from('stats_sites').select('site').order('site'),
    ] : [];

    const [page, types, countries, total, sites] = await Promise.all([rows, ...extras]);
    if (page.error) throw page.error;

    const hasMore = page.data.length > limit;
    const data = hasMore ? page.data.slice(0, limit) : page.data;

    return res.status(200).json({
      rows: data,
      next: hasMore ? cursorOf(data[data.length - 1]) : null,
      ...(firstPage ? {
        total: total?.count ?? null,
        types: (types?.data || []).map(t => t.type),
        countries: (countries?.data || []).map(c => c.country).filter(c => /^[A-Z]{2}$/.test(c)),
        sites: (sites?.data || []).map(s => s.site),
      } : {}),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
