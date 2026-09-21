/*!
 * The event log — every row the endpoint has recorded, newest first.
 *
 * The dashboard answers "what is happening"; this page answers "show me the
 * rows". It pages with a cursor rather than an offset (see api/events.js for
 * why), so a page boundary stays correct while events keep arriving.
 */
(function () {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const { esc, int, flagCell, typeTag, deviceCell } = window.TB;

  const PAGE = 50;
  const S = { cursor: null, loading: false, shown: 0, total: null };

  const filters = () => ({
    type: $('#fType').value || '',
    country: $('#fCountry').value || '',
    site: $('#fSite').value || '',
  });

  const fmtTime = iso => {
    const d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString([], {
      day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  };

  /* ------------------------------------------------------------------ */

  async function load({ more = false } = {}) {
    if (S.loading) return;
    S.loading = true;
    $('#moreTxt').textContent = 'Loading…';

    const q = new URLSearchParams({ limit: String(PAGE) });
    const f = filters();
    for (const k of ['type', 'country', 'site']) if (f[k]) q.set(k, f[k]);
    if (more && S.cursor) q.set('before', S.cursor);

    try {
      const r = await fetch('/api/events?' + q, { headers: { accept: 'application/json' } });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);

      if (!more) {
        $('#logTbl tbody').innerHTML = '';
        S.shown = 0;
        // The lists and the count ride along with the first page only.
        if (Array.isArray(j.types)) fill('#fType', j.types, 'All types');
        if (Array.isArray(j.countries)) fill('#fCountry', j.countries, 'All countries');
        if (Array.isArray(j.sites)) fill('#fSite', j.sites, 'All sources');
        S.total = j.total;
      }

      append(j.rows || []);
      S.cursor = j.next || null;
      S.shown += (j.rows || []).length;

      $('#more').hidden = !S.cursor;
      $('#end').hidden = Boolean(S.cursor);
      if (!S.cursor) {
        $('#end').textContent = S.shown
          ? 'That is every event in the retention window.'
          : 'No events match these filters.';
      }
      caption();
      ok();
    } catch (e) {
      fail(e.message || 'request failed');
    } finally {
      S.loading = false;
      $('#moreTxt').textContent = 'Load more';
    }
  }

  function append(rows) {
    if (!rows.length && !S.shown) {
      $('#logTbl tbody').innerHTML =
        `<tr><td colspan="8" class="mut">No events match these filters.</td></tr>`;
      return;
    }
    const html = rows.map(r => `<tr>
      <td class="mut">${esc(fmtTime(r.created_at))}</td>
      <td>${typeTag(r.type)}</td>
      <td>${flagCell(r.country)}</td>
      <td class="mut">${esc(r.city)}</td>
      <td>${deviceCell(r.device)}</td>
      <td class="mut">${esc(r.os)}</td>
      <td class="mut">${esc(r.browser)}</td>
      <td class="mut">${esc(r.site)}</td>
    </tr>`).join('');
    $('#logTbl tbody').insertAdjacentHTML('beforeend', html);
  }

  /* A select is rebuilt only when its options actually change, so reopening it
     after a filter does not lose the reader's place. */
  function fill(sel, values, allLabel) {
    const el = $(sel);
    const sig = values.join('|');
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const keep = el.value;
    el.innerHTML = `<option value="">${esc(allLabel)}</option>` +
      values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (values.includes(keep)) el.value = keep;
  }

  function caption() {
    const f = filters();
    const on = [f.type, f.country && f.country, f.site].filter(Boolean);
    const scope = on.length ? ` matching ${on.map(esc).join(' · ')}` : '';
    const of = S.total != null && S.total > S.shown ? ` of about ${int(S.total)}` : '';
    $('#logSub').innerHTML =
      `<b>${int(S.shown)}</b>${of} event${S.shown === 1 ? '' : 's'}${scope}. ` +
      `Country, city, device, OS and browser are read from the request at the edge — never sent by the page.`;
  }

  const ok = () => {
    $('#err').hidden = true;
    $('#live').classList.remove('is-bad');
    $('#liveTxt').textContent = 'Live · loaded ' +
      new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const fail = msg => {
    $('#live').classList.add('is-bad');
    $('#liveTxt').textContent = S.shown ? 'Showing what loaded' : 'No data';
    $('#errTxt').textContent = msg;
    $('#err').hidden = false;
  };

  /* ------------------------------------------------------------------ */

  // A filter change restarts the paging: the cursor belonged to the old query.
  for (const id of ['#fType', '#fCountry', '#fSite']) {
    $(id).addEventListener('change', () => { S.cursor = null; load(); });
  }
  $('#more').addEventListener('click', () => load({ more: true }));
  $('#retry').addEventListener('click', () => load({ more: Boolean(S.shown) }));

  load();
})();
