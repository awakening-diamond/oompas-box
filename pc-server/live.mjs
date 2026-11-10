// "Live" files: built-in channel lists that can be fixed without a new app release.
// The app ships with a copy in lineups/; it also checks the same file on GitHub (main branch)
// every few hours and uses whichever is newer (by its "updated" date).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINEUPS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lineups');
const BASE = process.env.OOMPAS_LIVE || 'https://raw.githubusercontent.com/awakening-diamond/oompas-box/main/pc-server/lineups';
const safe = n => String(n).replace(/[^\w.-]/g, '');
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const newer = (a, b) => (!b || (a && String(a.updated || '') >= String(b.updated || '')) ? a : b);

// Right now, without the network: the newer of the saved copy and the bundled one.
export function liveFileSync(name, cacheDir, ok = () => true) {
  const bundled = read(path.join(LINEUPS, safe(name)));
  const saved = cacheDir ? read(path.join(cacheDir, 'live', safe(name))) : null;
  return newer(saved && ok(saved) ? saved : null, bundled);
}

// Checks GitHub (at most every maxAge), saves what it gets, and returns the newest good copy.
export async function liveFile(name, { cacheDir, log = () => {}, force = false, maxAge = 6 * 3600e3, ok = () => true } = {}) {
  const file = cacheDir && path.join(cacheDir, 'live', safe(name));
  const age = file && fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : Infinity;
  if (BASE !== 'off' && (force || age > maxAge)) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${BASE}/${safe(name)}`, { signal: ctl.signal, headers: { 'user-agent': 'OOMPAS-Box', 'cache-control': 'no-cache' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = JSON.parse(await r.text());
      if (!ok(j)) throw new Error('not a valid list');
      if (file) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(j)); }
    } catch (e) {
      log(`Live update for ${name}: ${e.message}`);
      if (file && fs.existsSync(file)) fs.utimesSync(file, new Date(), new Date());   // don't retry right away
    } finally { clearTimeout(t); }
  }
  return liveFileSync(name, cacheDir, ok);
}
