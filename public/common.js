/*!
 * What both pages need, written once.
 *
 * The dashboard and the event log format the same things — a country cell, an
 * event type, a device — and carry the same footer. Copied into each page they
 * would drift: the footer especially, which is a list of links that changes
 * once a year and would then change on one page only.
 *
 * No build step, so this is a global rather than a module: `window.TB`.
 */
(function (w) {
  "use strict";

  /* Every value here comes from a PUBLIC endpoint — anyone can POST an event —
     so nothing reaches the page as raw HTML. */
  const esc = v => String(v ?? '—').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const nf = new Intl.NumberFormat('en-US');
  const int = n => nf.format(Math.round(Number(n) || 0));
  const cash = n => '$' + (Number(n) || 0).toFixed(2);

  const ICONS = {
    chevron: '<path d="m6 9 6 6 6-6"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    smartphone: '<rect width="14" height="20" x="5" y="2" rx="2"/><path d="M12 18h.01"/>',
    tablet: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M12 3a15 15 0 0 0 0 18 15 15 0 0 0 0-18"/><path d="M3 12h18"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V4s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    unlink: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 3.9 8.1"/><path d="m2 2 20 20"/><path d="M8 12h3"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  };
  const ico = (id, cls = 'ico') =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[id] || ICONS.globe}</svg>`;

  const DEVICE_ICON = { desktop: 'monitor', mobile: 'smartphone', tablet: 'tablet' };

  // ISO code → readable name, from the browser's own locale data.
  const NAMES = typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
  const countryName = c => {
    if (!c || c.length !== 2 || c === '??') return null;
    try { return NAMES ? NAMES.of(c) : null; } catch { return null; }
  };

  /* An empty flag box beside the word "Unknown" reads as a broken image. It is
     not missing data — it is a request that never passed through the edge, so
     no country header existed to read. */
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

  // The ordinal ramp of the funnel, so a type means the same colour everywhere.
  const TYPE_COLOUR = { pageview: '--s-view', click: '--s-click', lead: '--s-lead', test: '--s-test' };
  const typeTag = t =>
    `<span class="tag"><span class="tag__dot" style="background:var(${TYPE_COLOUR[t] || '--s-test'})"></span>${esc(t)}</span>`;

  const deviceCell = d =>
    `<span class="cell">${ico(DEVICE_ICON[d] || 'globe', 'ico ico--sm')}<span>${esc(d)}</span></span>`;

  /* One footer, written once, injected into whichever page has the element.
     Duplicated markup across two pages drifts; this cannot. */
  const MARKS = {
    globe: ICONS.globe,
    github: '<path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C16.9 4.8 18 5.1 18 5.1c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"/>',
    telegram: '<path d="M11.9 0A12 12 0 1 0 12 24 12 12 0 0 0 11.9 0zm4.9 7.2c.1 0 .3 0 .5.1.1.1.2.2.2.4v.5c-.2 1.9-1 6.5-1.4 8.6-.2.9-.5 1.2-.8 1.2-.7.1-1.2-.5-1.9-.9-1-.7-1.6-1.1-2.7-1.8-1.2-.8-.4-1.2.3-1.9.2-.2 3.2-3 3.3-3.2v-.2c0-.1-.2 0-.2 0-.1 0-1.8 1.1-5.1 3.3-.5.3-.9.5-1.3.5-.4 0-1.3-.3-1.9-.4-.7-.3-1.3-.4-1.3-.8 0-.2.3-.5.9-.7 3.5-1.5 5.8-2.5 7-3 3.3-1.4 4-1.6 4.4-1.7z"/>',
  };
  const SOLID = new Set(['github', 'telegram']);
  const LINKS = [
    ['globe', 'Hire me', 'https://andriijs.netlify.app'],
    ['github', 'GitHub', 'https://github.com/playua20'],
    ['telegram', 'Telegram', 'https://t.me/andriijs'],
  ];

  function footer() {
    const el = document.querySelector('footer.foot');
    if (!el) return;
    el.innerHTML = LINKS.map(([i, label, href]) =>
      `<a href="${href}" target="_blank" rel="noopener">` +
      `<svg class="ico${SOLID.has(i) ? ' solid' : ''}" viewBox="0 0 24 24" aria-hidden="true">${MARKS[i]}</svg>` +
      `<span>${label}</span></a>`).join('');
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', footer)
    : footer();

  w.TB = { esc, int, cash, ICONS, ico, DEVICE_ICON, countryName, flagCell, typeTag, deviceCell, footer };
})(window);
