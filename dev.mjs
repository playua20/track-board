/**
 * Local dev server — `npm run dev`.
 *
 *   node --env-file=.env.local dev.mjs [port]
 *
 * Serves public/ and runs the api/ handlers, so the page can be opened locally
 * instead of only on the deployment. Nothing here is deployed; Vercel serves
 * public/ statically and api/ as functions on its own.
 *
 * Port 3100, not 3000: ../server-side-tracking's dev server takes 3000, and the
 * two are routinely open at the same time.
 *
 * Two things differ from production, both on purpose:
 *  - the edge geo headers (x-vercel-ip-country, -city) do not exist here, so an
 *    event sent from a local page has no country;
 *  - .env.local points at the REAL Supabase project, so the numbers on screen
 *    are the live ones.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.argv.find(a => /^\d+$/.test(a)) || process.env.PORT || 3100);
const OPEN = !process.argv.includes('--no-open');

const openBrowser = (url) => {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref(); } catch { /* not fatal */ }
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The body as the Vercel Node runtime hands it over: parsed for JSON, raw otherwise. */
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return resolve(undefined);
    const type = String(req.headers['content-type'] || '');
    if (type.includes('application/json')) {
      try { return resolve(JSON.parse(raw)); } catch { return resolve(raw); }
    }
    resolve(raw);
  });
});

const serveStatic = async (url, res) => {
  /* `/events` → events.html, matching the deployment — which only does that
     because vercel.json sets `cleanUrls`. Vercel does NOT do it by default:
     without that file `/events` is a 404 in production while this server
     happily serves it, and the difference is invisible until something is
     live. It cost exactly that once. */
  const clean = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const candidates = clean === '' ? ['index.html'] : [clean, clean + '.html', join(clean, 'index.html')];
  for (const c of candidates) {
    const file = join(PUBLIC, c);
    if (!file.startsWith(PUBLIC)) break;                    // no climbing out of public/
    try {
      if (!(await stat(file)).isFile()) continue;
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        // Never cache in dev, or an edited stylesheet does not show on reload.
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      return res.end(await readFile(file));
    } catch { /* try the next candidate */ }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
};

const serveApi = async (url, req, res) => {
  const name = url.pathname.replace(/^\/api\//, '');
  if (!/^[a-z0-9-]+$/i.test(name)) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'no such endpoint' }));
  }
  const file = join(ROOT, 'api', name + '.js');
  let handler;
  try {
    // A fresh query string per mtime, so an edited handler is picked up without
    // restarting the server.
    const { mtimeMs } = await stat(file);
    ({ default: handler } = await import(pathToFileURL(file).href + '?t=' + mtimeMs));
  } catch {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'no such endpoint' }));
  }

  req.query = Object.fromEntries(url.searchParams);
  req.body = await readBody(req);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.hasHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  try {
    await handler(req, res);
  } catch (e) {
    console.error(`  ${name}:`, e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    if (!res.writableEnded) res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
  }
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const started = Date.now();
  res.on('finish', () => console.log(`  ${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`));
  if (url.pathname.startsWith('/api/')) return serveApi(url, req, res);
  await serveStatic(url, res);
}).listen(PORT, () => {
  console.log(`\n  board      http://localhost:${PORT}/`);
  console.log(`  or         http://127.0.0.1:${PORT}/`);
  console.log(process.env.SUPABASE_URL
    ? `  database   ${process.env.SUPABASE_URL} (live, read-only)`
    : `  database   NOT configured — run through: node --env-file=.env.local dev.mjs`);
  console.log(OPEN ? '  (opening the browser — pass --no-open to stop that)\n' : '');
  if (OPEN) openBrowser(`http://localhost:${PORT}/`);
});
