// IPTV for OOMPAS Box: M3U playlists the user adds (their own, or free public lists
// from iptv-org), an optional XMLTV guide, and a small proxy so the TV app can play the
// streams. The channels go on the dial after OOMPAS Box's own (from settings.iptv.dialStart).
import fs from 'node:fs';
import path from 'node:path';
import { liveFile } from './live.mjs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';


// Free channel lists offered in Settings. iptv-org (github.com/iptv-org/iptv) collects
// publicly available, free-to-air streams. Its adult category is not offered.
const IO = 'https://iptv-org.github.io/iptv';
// iptv-org's playlist grouped by language: tells which language each stream is in.
const LANG_INDEX = process.env.IPTV_LANG_INDEX || `${IO}/index.language.m3u`;
export const CATALOG = [
  // Hand-picked lineups that ship with OOMPAS Box (pc-server/lineups/*.json).
  { id: 'oompas-2000s-cable', group: 'OOMPAS picks', name: '2000s Cable (100 channels)', url: 'curated:2000s-cable' },
  ...[['classic', 'Classic TV'], ['animation', 'Animation'], ['movies', 'Movies'], ['series', 'Series'],
      ['comedy', 'Comedy'], ['kids', 'Kids'], ['family', 'Family'], ['documentary', 'Documentary'],
      ['science', 'Science'], ['music', 'Music'], ['news', 'News'], ['weather', 'Weather'],
      ['sports', 'Sports'], ['outdoor', 'Outdoor'], ['travel', 'Travel'], ['cooking', 'Cooking'],
      ['culture', 'Culture'], ['education', 'Education'], ['relax', 'Relax'], ['shop', 'Shopping'],
      ['entertainment', 'Entertainment'], ['general', 'General']]
    .map(([k, n]) => ({ id: 'iptvorg-cat-' + k, group: 'By category', name: n, url: `${IO}/categories/${k}.m3u` })),
  ...[['us', 'United States'], ['ca', 'Canada'], ['gb', 'United Kingdom'], ['au', 'Australia'], ['nz', 'New Zealand'],
      ['ie', 'Ireland'], ['jp', 'Japan'], ['mx', 'Mexico'], ['br', 'Brazil'], ['fr', 'France'], ['de', 'Germany'],
      ['it', 'Italy'], ['es', 'Spain'], ['nl', 'Netherlands'], ['se', 'Sweden'], ['kr', 'South Korea']]
    .map(([k, n]) => ({ id: 'iptvorg-' + k, group: 'By country', name: n, url: `${IO}/countries/${k}.m3u` })),
];

// Networks that iptv-org lists as English but that broadcast in another language.
// Free daily TV guides (XMLTV) for the free streaming services most free channels come from.
// Matched to channels by the service's channel id in the stream link, else by channel name.
const MJH = 'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master';
export const FREE_GUIDES = [
  { id: 'pluto', name: 'Pluto TV', url: `${MJH}/PlutoTV/us.xml.gz`, idFrom: u => (u.match(/(?:jmp2\.uk\/plu-|pluto\.tv\/.*?)([0-9a-f]{24})/i) || [])[1] },
  { id: 'samsung', name: 'Samsung TV Plus', url: `${MJH}/SamsungTVPlus/us.xml.gz`, idFrom: u => (u.match(/jmp2\.uk\/sam-([A-Z0-9]+)/) || [])[1] },
  { id: 'plex', name: 'Plex', url: `${MJH}/Plex/us.xml.gz`, idFrom: u => (u.match(/plex\.tv\/.*?([0-9a-f]{24})/i) || [])[1], suffix: true },
  { id: 'roku', name: 'The Roku Channel', url: `${MJH}/Roku/all.xml.gz` },
];
const GUIDE_URLS = process.env.IPTV_GUIDES ? JSON.parse(process.env.IPTV_GUIDES) : null;   // tests: { id: url }
// "Pluto TV Jewelry Television (US)" and "Jewelry TV" -> "jewelry"
const normName = s => String(s || '').toLowerCase().replace(/\s*[\(\[][^\)\]]*[\)\]]/g, '').replace(/&/g, ' and ')
  .replace(/\btelevision\b/g, 'tv').replace(/^(pluto tv|the)\s+/, '').replace(/[^a-z0-9]/g, '').replace(/(tv|channel|network)$/, '');
// Own copy of a piece of a big string (V8 keeps the whole guide file alive behind substrings).
const own = s => Buffer.from(String(s), 'utf8').toString('utf8');
export function xmltvChannels(xml) {
  const ids = new Set(), names = new Map();
  for (const m of xml.matchAll(/<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    const id = own(m[1]);
    ids.add(id);
    for (const d of m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)) {
      const k = own(normName(d[1].replace(/&amp;/g, '&').replace(/&apos;/g, "'")));
      if (k && !names.has(k)) names.set(k, id);
    }
  }
  return { ids, names };
}

const NOT_ENGLISH = /telemundo|univision|unimas|\blatino\b|latinx|espa[nñ]ol|deportes|telenovela|azteca|estrella tv|mega tv|extrema|\bcine\b|tbn (ukraine|armenia)|omid|payvand|mtv flow|vevo latino/i;
const ADULT = /\b(xxx|adult|porn|erotic|playboy|hustler|brazzers|18\+|hentai|sexy)\b/i;
const RAINBOW = ['#ff5a5a', '#ffa64d', '#ffd84a', '#5ad27a', '#4fb0ff', '#a07bff', '#ff7bd0'];
const sha = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

export function parseM3U(text) {
  const out = { epg: '', channels: [] };
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const head = lines[0] || '';
  const tvg = head.match(/(?:x-tvg-url|url-tvg)="([^"]+)"/i);
  if (tvg) out.epg = tvg[1].split(',')[0].trim();
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXTINF')) {
      const attr = k => (line.match(new RegExp(k + '="([^"]*)"', 'i')) || [])[1] || '';
      const comma = line.lastIndexOf(',');
      // The name is after the last comma that isn't inside quotes.
      let name = '';
      { let q = false, at = -1; for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ',' && !q) at = i; } name = line.slice((at >= 0 ? at : comma) + 1).trim(); }
      cur = { name: name || attr('tvg-name') || 'Channel', tvgId: attr('tvg-id'), tvgName: attr('tvg-name'), tvgCountry: attr('tvg-country'), tvgLanguage: attr('tvg-language'),
              logo: attr('tvg-logo'), group: attr('group-title'), chno: attr('tvg-chno'), ua: attr('http-user-agent'), referrer: attr('http-referrer') };
    } else if (line.startsWith('#EXTVLCOPT')) {
      if (!cur) continue;
      const m = line.match(/http-(user-agent|referrer)=(.*)$/i);
      if (m) cur[m[1].toLowerCase() === 'user-agent' ? 'ua' : 'referrer'] = m[2].trim();
    } else if (line.startsWith('#EXTGRP:')) {
      if (cur && !cur.group) cur.group = line.slice(8).trim();
    } else if (!line.startsWith('#')) {
      if (cur) { cur.url = line; out.channels.push(cur); cur = null; }
    }
  }
  return out;
}

// Programmes from an XMLTV file, for the given channel ids, in [from, until).
export function parseXMLTV(xml, wanted, from, until) {
  const toMs = s => {
    const m = String(s).match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*([+-]\d{4})?/);
    if (!m) return NaN;
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (m[7]) { const sign = m[7][0] === '-' ? -1 : 1; t -= sign * (+m[7].slice(1, 3) * 60 + +m[7].slice(3, 5)) * 60000; }
    return t;
  };
  const unesc = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
  const out = new Map();
  const names = new Map();   // display-name -> id, to match playlists without tvg-id
  for (const m of xml.matchAll(/<channel\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/channel>/g)) {
    for (const d of m[2].matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)) names.set(own(unesc(d[1]).trim().toLowerCase()), own(unesc(m[1])));
  }
  const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = m[1];
    const ch = unesc((a.match(/channel="([^"]*)"/) || [])[1] || '');
    if (wanted && !wanted.has(ch)) continue;
    const start = toMs((a.match(/start="([^"]*)"/) || [])[1]);
    const stop = toMs((a.match(/stop="([^"]*)"/) || [])[1]);
    if (!(stop > from && start < until)) continue;
    const title = unesc((m[2].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim();
    const sub = unesc((m[2].match(/<sub-title[^>]*>([\s\S]*?)<\/sub-title>/) || [])[1] || '').trim();
    const desc = unesc((m[2].match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || '').trim();
    if (!out.has(ch)) out.set(own(ch), []);
    out.get(ch).push({ title: own(title || 'On air'), sub: own(sub), desc: own(desc.slice(0, 400)), startMs: start, endMs: stop });
  }
  for (const list of out.values()) list.sort((x, y) => x.startMs - y.startMs);
  return { programmes: out, names };
}

export class Iptv {
  constructor({ cacheDir, log = () => {}, fetchImpl = fetch }) {
    this.dir = path.join(cacheDir, 'iptv');
    fs.mkdirSync(this.dir, { recursive: true });
    this.log = log;
    this.fetch = fetchImpl;
    this.settings = { enabled: false, lists: [], dialStart: 500, hideAdult: true, countries: [], categories: [] };
    this.categories = {};       // category -> channels (within the chosen countries)
    this.languages = {};        // language -> channels (within the chosen countries)
    this.langByUrl = new Map(); this.langById = new Map(); this.langAt = 0;
    this.health = new Map();    // stream url -> { ok, why, at } from "Check which channels play"
    try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(path.join(this.dir, 'health.json'), 'utf8')))) this.health.set(k, v); } catch {}
    this.check = { running: false, done: 0, total: 0, ok: 0, bad: 0, at: 0 };
    this.countries = {};        // country code -> channels, across the lists that are on
    this.lists = new Map();     // list id -> { channels, epgUrl, at, error }
    this.epg = new Map();       // epg url -> { programmes, names, at }
    this.guides = new Map();    // free guide id -> { ids, names, programmes, loaded:Set, at, file }
    this.guideFor = new Map();  // channel id -> { g, key }
    this.guideCount = 0;
    this.guideTimer = null;
    this.channels = [];
    this.busy = null;
  }

  async get(url, binary = false) {
    if (/^file:/i.test(url) || /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('/')) {
      const p = url.replace(/^file:\/\//i, '');
      return binary ? fs.readFileSync(decodeURIComponent(p)) : fs.readFileSync(decodeURIComponent(p), 'utf8');
    }
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await this.fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'OOMPAS-Box/1.0' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      return binary ? buf : buf.toString('utf8');
    } finally { clearTimeout(t); }
  }

  // Applies settings.iptv and (re)loads what's needed. Doesn't wait for downloads.
  configure(s = {}) {
    this.settings = { ...this.settings, ...s, lists: Array.isArray(s.lists) ? s.lists : this.settings.lists };
    this.rebuild();
    this.refresh().catch(e => this.log('IPTV: ' + e.message));
  }

  async refresh(force = false) {
    if (this.busy) return this.busy;
    this.busy = (async () => {
      if (!this.settings.enabled) return;
      for (const l of this.settings.lists.filter(l => l.enabled !== false)) {
        const have = this.lists.get(l.id);
        if (!force && have && !have.error && Date.now() - have.at < 6 * 3600e3 && have.url === l.url) continue;
        const cacheFile = path.join(this.dir, sha(l.url) + '.m3u');
        try {
          if (/^curated:/.test(l.url)) { await this.loadCurated(l, force); this.rebuild(); continue; }
          let text;
          try { text = await this.get(l.url); fs.writeFileSync(cacheFile, text); }
          catch (e) { if (fs.existsSync(cacheFile)) { text = fs.readFileSync(cacheFile, 'utf8'); this.log(`IPTV: ${l.name}: ${e.message}, using the saved copy`); } else throw e; }
          const p = parseM3U(text);
          this.lists.set(l.id, { url: l.url, channels: p.channels, epgUrl: l.epg || p.epg, at: Date.now(), error: null });
          this.log(`IPTV: ${l.name}: ${p.channels.length} channels${(l.epg || p.epg) ? ' (with guide)' : ''}`);
        } catch (e) {
          this.lists.set(l.id, { url: l.url, channels: [], epgUrl: '', at: Date.now(), error: e.message });
          this.log(`IPTV: couldn't load ${l.name}: ${e.message}`);
        }
        this.rebuild();
      }
      await this.loadLanguages(force).catch(e => this.log('IPTV languages: ' + e.message));
      this.rebuild();
      // Guides
      const urls = new Set(this.channels.map(c => c.epgUrl).filter(Boolean));
      for (const u of urls) {
        const have = this.epg.get(u);
        if (!force && have && Date.now() - have.at < 6 * 3600e3) continue;
        try {
          let buf = await this.get(u, true);
          if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
          const from = Date.now() - 3 * 3600e3, until = Date.now() + 30 * 3600e3;
          this.epg.set(u, { ...parseXMLTV(buf.toString('utf8'), null, from, until), at: Date.now() });
          this.log(`IPTV guide loaded (${this.epg.get(u).programmes.size} channels)`);
        } catch (e) {
          this.epg.set(u, { programmes: new Map(), names: new Map(), at: Date.now() - 5 * 3600e3 });   // retry in an hour
          this.log(`IPTV guide failed (${e.message})`);
        }
      }
      if (this.settings.freeGuides !== false) await this.loadFreeGuides(force);
    })().finally(() => { this.busy = null; });
    return this.busy;
  }

  // Downloads each free guide (at most once every 12 hours; kept on disk), notes its channels,
  // then matches and loads the schedules the current channels need.
  async loadFreeGuides(force = false) {
    const dir = path.join(this.dir, 'guides');
    fs.mkdirSync(dir, { recursive: true });
    for (const g of FREE_GUIDES) {
      const url = GUIDE_URLS ? GUIDE_URLS[g.id] : g.url;
      if (!url) continue;
      const file = path.join(dir, g.id + '.xml.gz');
      const have = this.guides.get(g.id);
      const age = fs.existsSync(file) ? Date.now() - fs.statSync(file).mtimeMs : Infinity;
      if (!force && have && age < 12 * 3600e3 && Date.now() - have.at < 6 * 3600e3) continue;
      try {
        if (force || age >= 12 * 3600e3) {
          try { fs.writeFileSync(file, await this.get(url, true)); }
          catch (e) { if (age === Infinity) throw e; this.log(`IPTV: ${g.name} guide: ${e.message}, using the saved copy`); }
        }
        const xml = this.readGuide(file);
        const { ids, names } = xmltvChannels(xml);
        const suffix = g.suffix ? new Map([...ids].map(id => [id.split('-').pop(), id])) : null;
        this.guides.set(g.id, { ids, names, suffix, programmes: new Map(), loaded: new Set(), at: Date.now(), file });
      } catch (e) {
        this.log(`IPTV: couldn't get the ${g.name} guide (${e.message})`);
      }
    }
    this.matchGuides();
    this.loadGuideSchedules();
    this.log(`IPTV: schedules for ${this.guideCount} of ${this.channels.length} channels`);
  }

  readGuide(file) {
    let buf = fs.readFileSync(file);
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf.toString('utf8');
  }

  // Which free guide channel each IPTV channel is: its own playlist guide wins, then the
  // service id in the stream link, then the name.
  matchGuides() {
    this.guideFor = new Map();
    let n = 0;
    for (const c of this.channels) {
      const own = c.epgUrl && this.epg.get(c.epgUrl);
      if (own && (own.programmes.has(c.tvgId) || own.names.get(String(c.tvgName || c.name).toLowerCase()) || own.names.get(String(c.name).toLowerCase()))) { n++; continue; }
      if (this.settings.freeGuides === false) continue;
      let hit = null;
      const u = c.iptv?.url || '';
      for (const g of FREE_GUIDES) {
        const d = this.guides.get(g.id);
        const sid = d && g.idFrom?.(u);
        const key = sid && (d.suffix ? d.suffix.get(sid) : d.ids.has(sid) && sid);
        if (key) { hit = { g: g.id, key }; break; }
      }
      if (!hit) {
        const tries = [c.guideName, c.name, c.tvgName].map(normName).filter(Boolean);
        outer: for (const k of tries) for (const g of FREE_GUIDES) {
          const key = this.guides.get(g.id)?.names.get(k);
          if (key) { hit = { g: g.id, key }; break outer; }
        }
      }
      if (hit) { this.guideFor.set(c.id, hit); n++; }
    }
    this.guideCount = n;
  }

  // Reads the schedules of the matched channels (3 hours back to 30 ahead) from the saved guides.
  loadGuideSchedules() {
    const from = Date.now() - 3 * 3600e3, until = Date.now() + 30 * 3600e3;
    for (const [id, d] of this.guides) {
      const want = new Set([...this.guideFor.values()].filter(h => h.g === id).map(h => h.key));
      const stale = Date.now() - (d.parsedAt || 0) > 6 * 3600e3;
      if (!want.size || (!stale && [...want].every(k => d.loaded.has(k)))) continue;
      try {
        d.programmes = parseXMLTV(this.readGuide(d.file), want, from, until).programmes;
        d.loaded = want; d.parsedAt = Date.now();
      } catch (e) { this.log(`IPTV: guide ${id}: ${e.message}`); }
    }
  }

  // After the channel list changes: match again, and read any newly needed schedules a bit later.
  rematch() {
    if (!this.guides.size) return;
    this.matchGuides();
    clearTimeout(this.guideTimer);
    this.guideTimer = setTimeout(() => this.loadGuideSchedules(), 1500);
  }

  // A hand-picked lineup: fixed channel numbers, stream links looked up fresh in its source list
  // (matched by iptv-org channel id, official free sources first), with the saved link as a fallback.
  async loadCurated(l, force) {
    const name = l.url.slice(8).replace(/[^\w-]/g, '') + '.json';
    const def = await liveFile(name, { cacheDir: this.dir, log: this.log, force, ok: j => Array.isArray(j?.channels) && j.channels.length > 0 && typeof j.source === 'string' });
    if (!def) throw new Error(`no lineup ${name}`);
    const cacheFile = path.join(this.dir, sha(def.source) + '.m3u');
    let src = [];
    try {
      let text;
      const fresh = fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 6 * 3600e3;
      if (fresh && !force) text = fs.readFileSync(cacheFile, 'utf8');
      else { try { text = await this.get(def.source); fs.writeFileSync(cacheFile, text); } catch (e) { if (fs.existsSync(cacheFile)) text = fs.readFileSync(cacheFile, 'utf8'); else throw e; } }
      src = parseM3U(text).channels;
    } catch (e) { this.log(`IPTV: ${def.name}: couldn't refresh links (${e.message}), using the saved ones`); }
    const officialHost = u => { try { const h = new URL(u).hostname; return !/^\d+\.\d+\.\d+\.\d+$/.test(h) && !/aynascope|aynaott|cammonitor|keralive|workers\.dev|bozztv|livestreamcdn|tvsen/.test(u); } catch { return false; } };
    const channels = def.channels.map(c => {
      const cands = src.filter(x => x.tvgId === c.id && officialHost(x.url));
      const hit = cands.find(x => x.name.startsWith(c.match)) || cands[0];
      return { name: c.name, tvgId: c.id, tvgName: hit?.tvgName || c.match, logo: hit?.logo || c.logo, group: c.group,
               url: hit?.url || c.url, ua: hit?.ua || '', referrer: hit?.referrer || '', chno: c.dial, curated: true, guideName: c.guide || '' };
    });
    this.lists.set(l.id, { url: l.url, channels, epgUrl: l.epg || '', at: Date.now(), error: null, curated: true });
    this.log(`IPTV: ${def.name}: ${channels.length} channels`);
  }

  // Language of each iptv-org stream (their playlists don't say it per channel).
  async loadLanguages(force = false) {
    if (!this.settings.lists.some(l => l.enabled !== false && /iptv-org\.github\.io/.test(l.url)) && !process.env.IPTV_LANG_INDEX) return;
    if (!force && this.langByUrl.size && Date.now() - this.langAt < 24 * 3600e3) return;
    const file = path.join(this.dir, 'languages.m3u');
    let text;
    try {
      const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 24 * 3600e3;
      text = fresh && !force ? fs.readFileSync(file, 'utf8') : await this.get(LANG_INDEX);
      if (!fresh || force) fs.writeFileSync(file, text);
    } catch (e) { if (fs.existsSync(file)) text = fs.readFileSync(file, 'utf8'); else throw e; }
    const byUrl = new Map(), byId = new Map();
    for (const c of parseM3U(text).channels) {
      const langs = String(c.group || '').split(/[;|]/).map(x => x.trim()).filter(x => x && !/^undefined$/i.test(x));
      if (!langs.length) continue;
      for (const [map, key] of [[byUrl, c.url], [byId, String(c.tvgId || '').split('@')[0]]]) {
        if (!key) continue;
        const set = map.get(key) || new Set(); langs.forEach(x => set.add(x)); map.set(key, set);
      }
    }
    this.langByUrl = byUrl; this.langById = byId; this.langAt = Date.now();
    this.log(`IPTV: languages known for ${byUrl.size} streams`);
  }

  langsOf(c) {
    if (c.tvgLanguage) return c.tvgLanguage.split(/[;,]/).map(x => x.trim()).filter(Boolean);
    const s = this.langByUrl.get(c.url) || this.langById.get(String(c.tvgId || '').split('@')[0]);
    return s ? [...s] : [];
  }

  // ------------------------------------------------ "Check which channels play"
  async probe(c) {
    const headers = { 'user-agent': c.iptv.ua || 'Mozilla/5.0 (OOMPAS Box)' };
    if (c.iptv.referrer) headers.referer = c.iptv.referrer;
    const get = async (u, range) => {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await this.fetch(u, { headers: range ? { ...headers, range: 'bytes=0-4095' } : headers, signal: ctl.signal, redirect: 'follow' });
        if (!r.ok) return { status: r.status };
        const type = r.headers.get('content-type') || '';
        const playlist = /mpegurl/i.test(type) || /\.m3u8?(\?|$)/i.test(r.url || u);
        if (playlist) return { status: r.status, url: r.url || u, text: await r.text() };
        const reader = r.body?.getReader(); let got = 0;
        if (reader) { const { value } = await reader.read(); got = value?.length || 0; ctl.abort(); }
        return { status: r.status, bytes: got, url: r.url || u, type };
      } finally { clearTimeout(t); }
    };
    const why = st => st === 403 || st === 451 ? 'blocked here (region or access)' : st === 404 || st === 410 ? 'gone' : `HTTP ${st}`;
    try {
      let r = await get(c.iptv.url);
      for (let hop = 0; hop < 3 && r.text != null; hop++) {
        if (!/^#EXTM3U/.test(r.text.trim())) return { ok: false, why: 'not a stream' };
        const lines = r.text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const variants = [];
        lines.forEach((l, i) => { if (l.startsWith('#EXT-X-STREAM-INF')) { const n = lines.slice(i + 1).find(x => !x.startsWith('#')); if (n) variants.push(n); } });
        const next = variants[0] || lines.find(l => !l.startsWith('#'));
        if (!next) return { ok: false, why: 'empty playlist' };
        r = await get(new URL(next, r.url).href, !variants.length);
        if (r.status && r.status >= 400) return { ok: false, why: why(r.status) };
      }
      if (r.status >= 400) return { ok: false, why: why(r.status) };
      return r.bytes > 0 || r.text != null ? { ok: true } : { ok: false, why: 'no data' };
    } catch (e) { return { ok: false, why: e.name === 'AbortError' ? 'no answer' : 'can\u2019t connect' }; }
  }

  // Tests every channel that's currently on the dial (6 at a time). Results are kept a day.
  async checkAll() {
    if (this.check.running) return;
    const list = this.channels.slice();
    this.check = { running: true, done: 0, total: list.length, ok: 0, bad: 0, at: Date.now() };
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const c = list[i++];
        const r = await this.probe(c);
        this.health.set(c.iptv.url, { ...r, at: Date.now() });
        this.check.done++; r.ok ? this.check.ok++ : this.check.bad++;
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    this.check.running = false;
    try { fs.writeFileSync(path.join(this.dir, 'health.json'), JSON.stringify(Object.fromEntries(this.health))); } catch {}
    this.log(`IPTV check: ${this.check.ok} channels play, ${this.check.bad} don't`);
    this.rebuild();
  }

  rebuild() {
    const out = [];
    const counts = {}, catCounts = {}, langCounts = {};
    if (this.settings.enabled) {
      let dial = Number(this.settings.dialStart) || 500;
      const seen = new Set();
      const want = new Set((this.settings.countries || []).map(x => String(x).toLowerCase()));
      const wantCats = new Set((this.settings.categories || []).map(x => String(x).toLowerCase()));
      const wantLangs = new Set((this.settings.languages || []).map(x => String(x).toLowerCase()));
      const lists = this.settings.lists.filter(l => l.enabled !== false)
        .sort((a, b) => (/^curated:/.test(b.url) ? 1 : 0) - (/^curated:/.test(a.url) ? 1 : 0));
      const taken = new Set();
      for (const l of lists) {
        const data = this.lists.get(l.id);
        if (!data) continue;
        for (const c of data.channels) {
          if (!c.url || seen.has(c.url)) continue;
          if (this.settings.hideAdult !== false && (ADULT.test(c.group) || ADULT.test(c.name))) continue;
          if (c.curated) {
            const health = this.health.get(c.url);
            if (this.settings.hideBroken && health && !health.ok && Date.now() - health.at < 3 * 86400e3) continue;
            seen.add(c.url);
            const d = taken.has(c.chno) ? null : c.chno;
            if (d == null) continue;
            taken.add(d);
            out.push({ dial: d, id: 'iptv-' + sha(l.id + '|' + c.tvgId), name: c.name, tags: [], call: callOf(c.name), color: RAINBOW[d % RAINBOW.length],
                       langs: ['English'], health: health ? (health.ok ? 'ok' : 'bad') : '', healthWhy: health?.why || '',
                       kind: 'iptv', logo: c.logo, group: c.group, list: data.curated ? (l.name.replace(/\s*\(.*\)$/, '')) : l.name, listId: l.id, country: 'us',
                       cats: [c.group], epgUrl: data.epgUrl, tvgId: c.tvgId, tvgName: c.tvgName, guideName: c.guideName, iptv: { url: c.url, ua: c.ua, referrer: c.referrer } });
            continue;
          }
          const country = countryOf(c);
          counts[country || '?'] = (counts[country || '?'] || 0) + 1;
          // Countries filter (empty = all). Channels with no country only show with "all".
          if (want.size && !want.has(country)) continue;
          // Languages filter (empty = all). Streams with no known language count as "Unknown".
          const langs = this.langsOf(c);
          const lk = langs.length ? langs : ['Unknown'];
          for (const k of lk) langCounts[k] = (langCounts[k] || 0) + 1;
          if (wantLangs.size && !lk.some(k => wantLangs.has(k.toLowerCase()))) continue;
          if (wantLangs.has('english') && wantLangs.size === 1 && NOT_ENGLISH.test(c.name)) continue;
          // Categories filter (empty = all): a channel shows if it's in any chosen category.
          const cats = catsOf(c);
          for (const k of cats) catCounts[k] = (catCounts[k] || 0) + 1;
          if (wantCats.size && !cats.some(k => wantCats.has(k.toLowerCase()))) continue;
          const health = this.health.get(c.url);
          if (this.settings.hideBroken && health && !health.ok && Date.now() - health.at < 3 * 86400e3) continue;
          seen.add(c.url);
          while (taken.has(dial)) dial++;
          taken.add(dial);
          const id = 'iptv-' + sha(l.id + '|' + c.url);
          const { name, tags } = cleanName(c.name);
          out.push({ dial: dial, id, name, tags, call: callOf(name), color: RAINBOW[dial % RAINBOW.length], langs,
                     health: health ? (health.ok ? 'ok' : 'bad') : '', healthWhy: health?.why || '',
                     kind: 'iptv', logo: c.logo, group: c.group, list: l.name, listId: l.id, country,
                     cats: cats.filter(k => k !== 'Other'),
                     epgUrl: data.epgUrl, tvgId: c.tvgId, tvgName: c.tvgName || c.name,
                     iptv: { url: c.url, ua: c.ua, referrer: c.referrer } });
          dial++;
        }
      }
    }
    this.countries = counts;
    this.categories = catCounts;
    this.languages = langCounts;
    this.channels = out;
    this.byId = new Map(out.map(c => [c.id, c]));
    this.rematch();
  }

  find(id) { return this.byId?.get(id) || null; }

  programs(c, from, until) {
    const g = c.epgUrl && this.epg.get(c.epgUrl);
    if (g) {
      const key = g.programmes.has(c.tvgId) ? c.tvgId
        : g.names.get(String(c.tvgName || c.name).toLowerCase()) || g.names.get(String(c.name).toLowerCase());
      const list = key && g.programmes.get(key);
      if (list?.length) {
        const ps = list.filter(p => p.endMs > from && p.startMs < until);
        if (ps.length) return ps.map(p => ({ key: `${c.id}@${p.startMs}`, title: p.title, sub: p.sub, desc: p.desc, year: '', startMs: p.startMs, endMs: p.endMs }));
      }
    }
    const h = this.guideFor.get(c.id);
    const list = h && this.guides.get(h.g)?.programmes.get(h.key);
    if (list?.length) {
      const ps = list.filter(p => p.endMs > from && p.startMs < until);
      if (ps.length) return ps.map(p => ({ key: `${c.id}@${p.startMs}`, title: p.title, sub: p.sub, desc: p.desc, year: '', startMs: p.startMs, endMs: p.endMs }));
    }
    // No guide: hour-long "live" blocks so the guide grid still has something to show.
    const out = [];
    for (let t = Math.floor(from / 3600e3) * 3600e3; t < until; t += 3600e3)
      out.push({ key: `${c.id}@${t}`, title: c.cats?.length ? `${c.name} · ${c.cats.join(', ')}` : c.name, year: '', startMs: t, endMs: t + 3600e3, live: true });
    return out;
  }

  status() {
    return this.settings.lists.map(l => {
      const d = this.lists.get(l.id);
      return { id: l.id, name: l.name, enabled: l.enabled !== false, channels: this.channels.filter(c => c.listId === l.id).length,
               loaded: !!d && !d.error, error: d?.error || null };
    });
  }
}

// "AWE Encore (720p) [Geo-blocked]" -> name "AWE Encore", tags ["720p", "Geo-blocked"]
function cleanName(n) {
  const tags = [];
  const name = String(n).replace(/\s*[\(\[]([^\)\]]{1,24})[\)\]]\s*$/g, '').trim();
  let rest = String(n);
  for (;;) {
    const m = rest.match(/\s*[\(\[]([^\)\]]{1,24})[\)\]]\s*$/);
    if (!m || !/^(\d{3,4}[pi]|sd|hd|fhd|4k|uhd|not 24\/7|geo-blocked|backup|.*?only)$/i.test(m[1])) break;
    tags.unshift(m[1]); rest = rest.slice(0, m.index);
  }
  return { name: rest.trim() || name || String(n), tags };
}

// Categories from group-title ("Animation;Kids"). No category: "Other".
function catsOf(c) {
  const list = String(c.group || '').split(/[;|]/).map(x => x.trim()).filter(x => x && !/^(undefined|other)$/i.test(x))
    .map(x => x[0].toUpperCase() + x.slice(1));
  return list.length ? [...new Set(list)] : ['Other'];
}

// Country from the channel id (iptv-org style "CNN.us@SD"), or tvg-country.
function countryOf(c) {
  const m = String(c.tvgId || '').match(/\.([a-z]{2})(?:@[^.]*)?$/i);
  if (m) return m[1].toLowerCase();
  const t = String(c.tvgCountry || '').split(/[;,]/)[0].trim();
  return /^[a-z]{2}$/i.test(t) ? t.toLowerCase() : '';
}

const callOf = name => {
  const w = String(name).replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^A-Za-z0-9 ]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return 'IPTV';
  if (w.length === 1) return w[0].slice(0, 4).toUpperCase();
  return w.map(x => x[0]).join('').slice(0, 4).toUpperCase();
};

// ------------------------------------------------------------ proxy
// The TV app plays IPTV through the server, so streams work even without CORS headers,
// and the headers some playlists need (user agent, referrer) are added.
const PROXY_KEYS = new Map();   // short key -> { ua, referrer }
export function proxyUrl(u, opts = {}) {
  const hk = opts.ua || opts.referrer ? sha((opts.ua || '') + '|' + (opts.referrer || '')) : '';
  if (hk) PROXY_KEYS.set(hk, { ua: opts.ua, referrer: opts.referrer });
  return `/iptv/p?u=${encodeURIComponent(Buffer.from(u).toString('base64url'))}${hk ? '&k=' + hk : ''}`;
}

const isPlaylist = (u, type) => /mpegurl/i.test(type || '') || /\.m3u8?(\?|$)/i.test(u);

export async function proxy(req, res, url) {
  const target = Buffer.from(url.searchParams.get('u') || '', 'base64url').toString();
  if (!/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('bad url'); }
  const k = url.searchParams.get('k');
  const opts = (k && PROXY_KEYS.get(k)) || {};
  const headers = { 'user-agent': opts.ua || 'Mozilla/5.0 (OOMPAS Box)' };
  if (opts.referrer) headers.referer = opts.referrer;
  if (req.headers.range) headers.range = req.headers.range;
  const ctl = new AbortController();
  req.on('close', () => ctl.abort());
  const r = await fetch(target, { headers, signal: ctl.signal, redirect: 'follow' });
  const type = r.headers.get('content-type') || '';
  if (r.ok && isPlaylist(r.url || target, type)) {
    const base = r.url || target;
    const text = await r.text();
    const rew = u => { try { return proxyUrl(new URL(u, base).href, opts); } catch { return u; } };
    const body = text.split(/\r?\n/).map(line => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${rew(u)}"`);
      return rew(t);
    }).join('\n');
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(body);
  }
  const h = { 'content-type': type || 'application/octet-stream', 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  for (const x of ['content-length', 'content-range', 'accept-ranges']) if (r.headers.get(x)) h[x] = r.headers.get(x);
  res.writeHead(r.status, h);
  if (!r.body) return res.end();
  const reader = r.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise(ok => res.once('drain', ok));
    }
  } catch {} finally { res.end(); }
}
