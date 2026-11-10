// OOMPAS Box's own channels: an Internet Archive library and a daily scheduler.
//
// Each channel is built from "pools" (archive.org searches). Once a day a schedule is
// made for every channel at once: shuffled with a seed for that day, series played in
// short runs of episodes in order, dayparts respected, ad pods between shows, and no
// tape ever airing on two channels at the same moment. The day's schedule is saved to
// disk, so restarting the server keeps it.

import { createHash } from 'node:crypto';
import fs from 'node:fs';

// Family-safe: adult anime and other explicit tapes are kept out of every channel,
// both in the Internet Archive search and by checking each title, description and tag.
const ADULT_Q = 'NOT subject:(hentai OR ecchi OR erotic OR erotica OR porn OR pornography OR xxx OR nsfw OR "adult animation" OR "adults only" OR "18+" OR nudity OR "sex") ' +
  'AND NOT title:(hentai OR ecchi OR xxx OR porn OR erotic OR erotica OR uncensored OR "18+")';
const ADULT_RE = /\b(hentai|ecchi|erotic\w*|porn\w*|xxx|nsfw|18\+|r-?18|adults?[ -]only|lewd|uncensored|yaoi|futanari|tentacle|loli\w*|shota\w*|nude|nudity|sexy|sexual|explicit)\b/i;
// Well-known adult OVA series that are often uploaded without any tag saying so.
const ADULT_TITLES = /\b(cream lemon|la blue girl|urotsukidoji|overfiend|angel of darkness|bible black|wicked city|twin dolls|venus 5|mezzo forte|night shift nurses|words worth|rei rei|dragon pink|cool devices|adventure kid|kekko kamen|golden boy|kite \(|a kite\b|f3 frantic|ogenki clinic|elven bride|legend of lyon|sakura diaries)/i;
export function isAdult(...fields) {
  return fields.some(f => { if (!f) return false; const t = Array.isArray(f) ? f.join(' ') : String(f); return ADULT_RE.test(t) || ADULT_TITLES.test(t); });
}
import path from 'node:path';

const DAY = 86400000;
export const hash32 = s => createHash('sha1').update(String(s)).digest().readUInt32LE(0);
export function rng(seed) {                                   // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// "00:23:12", "23:12", "1:02:03.5", "1386", "23 min", "1h 5m", "65 minutes" -> seconds
export function parseDuration(v) {
  if (v == null) return 0;
  if (Array.isArray(v)) v = v[0];
  const s = String(v).trim().toLowerCase();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const m = s.match(/^(\d+):(\d{1,2})(?::(\d{1,2}(?:\.\d+)?))?$/);
  if (m) return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : (+m[1]) * 60 + (+m[2]);
  let total = 0, any = false;
  for (const [, n, u] of s.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)\b/g)) {
    any = true;
    total += parseFloat(n) * (u[0] === 'h' ? 3600 : u[0] === 'm' ? 60 : 1);
  }
  return any ? total : 0;
}

// "Robotech - Episode 05 - Booby Trap" -> "robotech"; "Speed Racer 12" -> "speed racer"
export function seriesKey(title) {
  const t = String(title || '').toLowerCase();
  const m = t.search(/\b(episode|episodio|ep\.?\s*\d|chapter|part\s*\d|vol\.?\s*\d|volume|s\d+\s*e\d+|season)|#|\d/);
  const head = (m > 0 ? t.slice(0, m) : m === 0 ? '' : t).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return head.length >= 3 ? head : '';
}

const VIDEO = /\.(mp4|m4v|mov|mpe?g|avi|mkv|ogv|webm|wmv|flv|vob|m2ts|ts)$/i;
const PLAYABLE = /\.(mp4|m4v)$/i;
const naturalSort = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const cleanFileTitle = f => f.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

// Playable files of an item from its archive.org metadata: [{ file, dur, title }].
export function videosFromMetadata(meta) {
  const files = meta?.files || [];
  const byName = new Map(files.map(f => [f.name, f]));
  const originals = files.filter(f => f.source === 'original' && VIDEO.test(f.name) && !/\.(ia|thumbs)\b/i.test(f.name));
  const out = [];
  const pref = ['512Kb MPEG4', 'h.264 IA', 'h.264', 'MPEG4', 'h.264 HD'];
  for (const o of originals) {
    const derived = files.filter(f => f.original === o.name && PLAYABLE.test(f.name));
    derived.sort((a, b) => (pref.indexOf(a.format) + 99 * (pref.indexOf(a.format) < 0)) - (pref.indexOf(b.format) + 99 * (pref.indexOf(b.format) < 0)));
    const play = derived[0] || (PLAYABLE.test(o.name) ? o : null);
    if (!play) continue;
    const dur = parseDuration(play.length) || parseDuration(o.length);
    if (dur > 0) out.push({ file: play.name, dur, title: o.title || cleanFileTitle(o.name) });
  }
  if (!out.length) {   // no originals marked: fall back to any mp4 with a length
    for (const f of files) if (PLAYABLE.test(f.name) && parseDuration(f.length) > 0 && !byName.get(f.original))
      out.push({ file: f.name, dur: parseDuration(f.length), title: f.title || cleanFileTitle(f.name) });
  }
  out.sort((a, b) => naturalSort(a.file, b.file));
  return out;
}


// ------------------------------------------------------------- tidy titles
// archive.org titles are written by uploaders: "ROBOTECH_episode_05_[VHS Rip] 480p",
// "Detour (1945) - Full Movie HD". These make them read like a TV listing.
const JUNK = /\b(?:vhs[ -]?rip|vhs|dvd[ -]?rip|dvd|tv[ -]?rip|web[ -]?rip|web[ -]?dl|bluray|blu-ray|hdtv|hd|hq|sd|full[ -](?:movie|film|episode|length|show)|public domain|pd|\d{3,4}p|\d{3,4}x\d{3,4}|x26[45]|h\.?26[45]|xvid|divx|aac|mp3|avi|mp4|m4v|mkv|remaster(?:ed)?|restored|upscaled?|uncut|unedited|complete|official|archive\.org|internet archive|colou?r(?:ized)?|b&w|black (?:and|&) white|english|eng|dubbed|subbed|sub|dub|raw)\b/i;
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
const titleCase = t => t.toLowerCase().replace(/[a-z0-9']+/g, (w, i) => (i && SMALL.has(w)) ? w : w[0].toUpperCase() + w.slice(1));
export function shorten(t, n) {
  t = String(t || '').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1), sp = cut.lastIndexOf(' ');
  return (sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s:,;·\-–]+$/, '') + '…';
}
export function cleanTitle(raw) {
  let t = String(raw || '').replace(/\.(mp4|m4v|mov|mpe?g|avi|mkv|ogv|webm|wmv|flv|vob)$/i, '');
  if (!/\s/.test(t)) t = t.replace(/[._]+/g, ' ');             // "the_lone_ranger.e05"
  t = t.replace(/_+/g, ' ');
  let year = '';
  t = t.replace(/[\[(]\s*((?:19|20)\d\d)\s*[\])]/, (_, y) => { year = y; return ' '; });
  t = t.replace(/[\[({][^\])}]*[\])}]/g, m => (JUNK.test(m) || !/[a-z0-9]/i.test(m)) ? ' ' : m);
  for (let i = 0; i < 6 && JUNK.test(t); i++) t = t.replace(JUNK, ' ');
  t = t.replace(/\s*[-–|:,]\s*(?=[-–|:,])/g, '').replace(/^[\s\-–|:,.]+|[\s\-–|:,.]+$/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!year) { const m = t.match(/\s[-–]?\s*((?:19|20)\d\d)$/); if (m) { year = m[1]; t = t.slice(0, m.index).trim(); } }
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters && (letters === letters.toUpperCase() && letters.length > 3 || letters === letters.toLowerCase())) t = titleCase(t);
  return { title: t || String(raw || '').trim(), year };
}
// "Robotech Episode 05 - Booby Trap" -> { series: 'Robotech', episode: 5, rest: 'Booby Trap' }
export function parseEpisode(t, allowBareNumber = false) {
  const pats = [
    /^(.*?)[\s:,\-–]*(?:season|series)\s*(\d{1,2})[\s,:\-–]*(?:episode|ep\.?)\s*(\d{1,4})\b[\s:,\-–]*(.*)$/i,
    /^(.*?)[\s:,\-–]*s(\d{1,2})\s*e(\d{1,4})\b[\s:,\-–]*(.*)$/i,
    /^(.*?)[\s:,\-–]*(\d{1,2})x(\d{2,3})\b[\s:,\-–]*(.*)$/i,
  ];
  for (const re of pats) { const m = t.match(re); if (m && m[1].trim()) return { series: m[1].trim(), season: +m[2], episode: +m[3], rest: m[4].trim() }; }
  let m = t.match(/^(.*?)[\s:,\-–]*(?:episode|episodio|ep\.?|e(?=\d)|#|no\.|chapter|part|pt\.?)\s*(\d{1,4})\b[\s:,\-–]*(.*)$/i);
  if (m && m[1].trim()) return { series: m[1].trim(), episode: +m[2], rest: m[3].trim() };
  if (allowBareNumber && (m = t.match(/^(.*?\D)\s+(\d{1,3})(?:\s*[-–:]\s*(.*))?$/)) && m[1].trim().length >= 3)
    return { series: m[1].trim(), episode: +m[2], rest: (m[3] || '').trim() };
  return null;
}
// How a tape is listed: { title, series, episode, sub, year }.
export function describe(it, inSeriesPool = false, knownSeries = null) {
  const raw = String(it.title || '');
  const split = it.series ? raw.indexOf(': ') : -1;
  const head = cleanTitle(split > 0 ? raw.slice(0, split) : raw);
  let series = '', episode = null, sub = '';
  if (split > 0) {                                     // one of several videos in an item
    series = head.title;
    const file = cleanTitle(raw.slice(split + 2)).title;
    const p = parseEpisode(file, true);
    if (p) { episode = p.episode; sub = p.rest; }
    else if (file.toLowerCase() !== series.toLowerCase()) sub = file;
    if (sub && sub.toLowerCase().startsWith(series.toLowerCase())) sub = sub.slice(series.length).replace(/^[\s:,\-–]+/, '');
  } else {
    const p = parseEpisode(head.title, inSeriesPool);
    if (p) { series = p.series; episode = p.episode; sub = p.rest; }
    else if (knownSeries) {                            // "Popeye - Little Swee'Pea", when Popeye recurs in this pool
      const pre = seriesPrefix(head.title);
      if (pre && knownSeries.has(pre.toLowerCase())) { series = pre; sub = head.title.slice(pre.length).replace(/^[\s:\-–|]+/, ''); }
    }
  }
  const caps = x => { const l = x.replace(/[^A-Za-z]/g, ''); return l.length > 4 && l === l.toUpperCase() ? titleCase(x) : x; };
  series = caps(series); sub = caps(sub.replace(/^["'“‘]+|["'”’]+$/g, ''));
  const title = series && episode != null ? `${shorten(series, 30)} · Ep ${episode}`
              : series && sub ? `${shorten(series, 26)}: ${sub}` : head.title;
  return { title: shorten(title, 44), series: shorten(series, 34), episode, sub: shorten(sub, 40), year: String(it.year || head.year || '').slice(0, 4) };
}
// A one-line synopsis from an item's description: tags, links and uploader boilerplate removed.
const BOILER = /^(?:this (?:film|video|movie|program|tape|item) (?:is|was) (?:in the )?public domain|public domain|uploaded by|digitized by|source:|from the collection|courtesy of|thanks to|ripped|transferred|encoded|original(?:ly)? uploaded|https?:)/i;
export function summarize(d) {
  if (Array.isArray(d)) d = d.join(' ');
  const t = String(d || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&lsquo;/g, "'").replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const sentence of t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)) {
    const x = sentence.trim();
    if (x.length < 15 || BOILER.test(x) || /^[\W\d]+$/.test(x)) continue;
    return shorten(x, 150);
  }
  return '';
}

// The part of a title before " - ", ": " or " | ", if it's a plausible series name.
export function seriesPrefix(t) {
  const m = String(t || '').match(/^(.{3,40}?)\s*(?:\s[-–|]\s|:\s)/);
  return m && /[a-z]/i.test(m[1]) ? m[1].trim() : '';
}

// Parts of the day, for naming blocks.
export function daypart(ms) { const h = new Date(ms).getHours(); return h >= 6 && h < 12 ? 'morning' : h >= 12 && h < 18 ? 'afternoon' : h >= 18 && h < 23 ? 'prime' : 'late'; }
const DAYPART_NAMES = { morning: 'Morning', afternoon: 'Afternoon', prime: 'Prime Time', late: 'Late Night' };

// How a pool's programs are listed in the guide: 'block' (under the block's name; magazine-style
// channels such as public access or music videos), 'title' (each film by name) or 'series'
// (series by name, anything else by its title). Set "list" on a pool, or it follows the label.
const BLOCK_LABELS = new Set(['public access', 'music video', 'infomercial', 'how-to', 'documentary', 'nature film', 'video games', 'animation', 'commercial', 'short']);
function listMode(spec) {
  if (spec.list) return spec.list;
  const l = String(spec.label || '').toLowerCase();
  return BLOCK_LABELS.has(l) ? 'block' : l === 'movie' || l === 'ova' ? 'title' : 'series';
}

const hhmm = s => { const [h, m] = String(s).split(':').map(Number); return ((h || 0) * 60 + (m || 0)) * 60000; };

export class OompasNet {
  constructor({ dir, config, archiveBase = 'https://archive.org', fetchJson, log = () => {}, now = () => Date.now() }) {
    this.dir = dir;
    this.config = config;
    this.archiveBase = archiveBase.replace(/\/$/, '');
    this.fetchJson = fetchJson;
    this.log = log;
    this.now = now;
    this.lib = { items: {}, pools: {} };
    this.days = new Map();        // dayKey -> Promise<schedule>
    this.resolved = new Map();    // dayKey -> schedule, once built
    this.ready = false;
    this.loading = null;
    this.metaQueue = [];
    this.metaActive = 0;
    this.cfgHash = createHash('sha1').update('schedule-v4' + JSON.stringify(config)).digest('hex').slice(0, 10);
    fs.mkdirSync(dir, { recursive: true });
    const lib = path.join(dir, 'library.json');
    try { if (fs.existsSync(lib)) this.lib = JSON.parse(fs.readFileSync(lib, 'utf8')); } catch (e) { log('OOMPAS library cache unreadable; starting fresh'); }
    this.lib.items ||= {}; this.lib.pools ||= {};
    this.byId = new Map();
    for (const [k, it] of Object.entries(this.lib.items)) this.index(k, it);
  }
  index(k, it) { if (!this.byId.has(it.id)) this.byId.set(it.id, []); this.byId.get(it.id).push(k); }
  addItem(k, it) { if (!this.lib.items[k]) this.index(k, it); this.lib.items[k] = it; }

  get channels() { return this.config.channels || []; }
  get complete() { return [...this.poolSpecs().keys()].every(sig => this.lib.pools[sig]); }
  archiveChannels() { return this.channels.filter(c => c.kind === 'archive' || c.kind === 'mirror'); }

  // ------------------------------------------------------------------ library
  poolSpecs() {
    const specs = new Map();
    const add = spec => { const sig = this.poolSig(spec); if (!specs.has(sig)) specs.set(sig, spec); return sig; };
    if (this.config.adPool) add(this.config.adPool);
    for (const c of this.archiveChannels()) for (const p of Object.values(c.pools || {})) add(p);
    return specs;
  }
  poolSig(spec) { return hash32(JSON.stringify(['v3', spec.q, spec.rows || 300, !!spec.episodes])).toString(16); }

  saveLib() {
    const file = path.join(this.dir, 'library.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(this.lib));
    fs.renameSync(file + '.tmp', file);
  }

  metadata(id) {
    this.metaCache ||= new Map();
    if (!this.metaCache.has(id)) {
      const pr = new Promise((resolve, reject) => { this.metaQueue.push({ id, resolve, reject }); this.pumpMeta(); });
      pr.catch(() => this.metaCache.delete(id));
      this.metaCache.set(id, pr);
    }
    return this.metaCache.get(id);
  }
  pumpMeta() {
    while (this.metaActive < 6 && this.metaQueue.length) {
      const job = this.metaQueue.shift();
      this.metaActive++;
      this.fetchJson(`${this.archiveBase}/metadata/${encodeURIComponent(job.id)}`)
        .then(job.resolve, job.reject)
        .finally(() => { this.metaActive--; this.pumpMeta(); });
    }
  }

  async loadPool(sig, spec) {
    const rows = spec.rows || 300;
    const q = `(${spec.q}) AND mediatype:(movies) AND ${ADULT_Q}`;
    const url = `${this.archiveBase}/advancedsearch.php?q=${encodeURIComponent(q)}` +
      ['identifier', 'title', 'year', 'runtime', 'date', 'description', 'subject'].map(f => `&fl[]=${f}`).join('') +
      `&sort[]=${encodeURIComponent('downloads desc')}&rows=${rows}&page=1&output=json`;
    const data = await this.fetchJson(url);
    const docs = data?.response?.docs || [];
    const keys = [];
    const needMeta = [];
    for (const d of docs) {
      const id = d.identifier;
      if (!id) continue;
      if (isAdult(d.title, d.description, d.subject, id)) continue;
      const desc = summarize(d.description);
      const known = this.byId.get(id);
      if (known?.length) {
        for (const k of known) if (desc && !this.lib.items[k].desc) this.lib.items[k].desc = desc;
        keys.push(...known); continue;
      }
      const dur = parseDuration(d.runtime);
      const year = String(d.year || d.date || '').slice(0, 4);
      const title = Array.isArray(d.title) ? d.title[0] : d.title || id;
      if (dur > 0 && !spec.episodes) { this.addItem(id, { id, title, year, dur, desc }); keys.push(id); }
      else needMeta.push({ id, title, year, desc });
    }
    // Look inside items with no runtime (and every item, for episode pools). Capped so a
    // first start doesn't take forever; later refreshes fill in more.
    const cap = spec.episodes ? 50 : 60;
    await Promise.all(needMeta.slice(0, cap).map(async ({ id, title, year, desc }) => {
      try {
        const vids = videosFromMetadata(await this.metadata(id));
        if (!vids.length) { this.addItem(id, { id, title, year, dur: 0 }); keys.push(id); return; }
        if (vids.length === 1) { this.addItem(id, { id, file: vids[0].file, title, year, dur: vids[0].dur, desc }); keys.push(id); return; }
        for (const v of vids.slice(0, 300)) {
          if (isAdult(v.title, v.file)) continue;
          const k = `${id}/${v.file}`;
          this.addItem(k, { id, file: v.file, title: `${title}: ${v.title}`.slice(0, 160), year, dur: v.dur, series: id, desc });
          keys.push(k);
        }
      } catch { /* skip this item */ }
    }));
    this.lib.pools[sig] = { at: this.now(), keys: [...new Set(keys)] };
  }

  // Loads every pool (from the cache if fresh). Resolves when all have been tried.
  load() {
    if (this.loading) return this.loading;
    const specs = this.poolSpecs();
    const stale = [...specs].filter(([sig]) => !this.lib.pools[sig] || this.now() - this.lib.pools[sig].at > 7 * DAY);
    if (!stale.length) { this.ready = true; return (this.loading = Promise.resolve()); }
    const missing = stale.filter(([sig]) => !this.lib.pools[sig]).length;
    this.log(`OOMPAS: looking up ${stale.length} Internet Archive searches${missing ? ' (first run takes a few minutes)' : ''}...`);
    let done = 0;
    this.loading = Promise.all(stale.map(([sig, spec]) => this.loadPool(sig, spec)
      .catch(e => this.log(`OOMPAS: search failed (${e.message}): ${spec.q.slice(0, 60)}`))
      .finally(() => { if (++done % 8 === 0 || done === stale.length) { this.saveLib(); this.log(`OOMPAS: ${done}/${stale.length} searches done`); } })))
      .then(() => { this.ready = true; this.saveLib(); this.metaCache = null; });
    // Pools that were only stale (not missing) are usable right away.
    if (!missing) this.ready = true;
    return this.loading;
  }

  poolItems(spec) {
    if (!spec) return [];
    const p = this.lib.pools[this.poolSig(spec)];
    if (!p) return [];
    const lo = (spec.minMin ?? 1) * 60, hi = (spec.maxMin ?? 180) * 60;
    return p.keys.map(k => this.lib.items[k] && { key: k, ...this.lib.items[k] }).filter(it => it && it.dur >= lo && it.dur <= hi);
  }

  status() {
    return this.channels.map(c => ({
      dial: c.dial, name: c.name, kind: c.kind,
      tapes: c.pools ? Object.fromEntries(Object.entries(c.pools).map(([n, s]) => [n, this.poolItems(s).length])) : null,
    }));
  }

  // ---------------------------------------------------------------- schedules
  dayStart(t) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
  dayKey(start) { const d = new Date(start); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

  // Schedule for the day containing t: { start, end, channels: { dial: [entries] } }.
  day(t) {
    const start = this.dayStart(t), key = this.dayKey(start);
    if (this.days.has(key)) return this.days.get(key);
    const file = path.join(this.dir, `schedule-${key}.json`);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    let pr;
    if (saved && saved.cfg === this.cfgHash && saved.start === start) pr = Promise.resolve(saved);
    else pr = this.load().then(() => {
      const s = this.build(start, key);
      const complete = [...this.poolSpecs().keys()].every(sig => this.lib.pools[sig]);
      if (complete) { try { fs.writeFileSync(file, JSON.stringify(s)); } catch {} }
      else {
        this.log('OOMPAS: some searches failed; trying again in 10 minutes');
        setTimeout(() => { this.days.delete(key); this.resolved.delete(key); this.loading = null; }, 10 * 60000).unref?.();
      }
      this.cleanOld();
      return s;
    });
    pr = pr.then(sch => { this.resolved.set(key, sch); return sch; }, e => { this.days.delete(key); throw e; });
    this.days.set(key, pr);
    for (const k of this.days.keys()) if (this.days.size > 3 && k !== key) { this.days.delete(k); this.resolved.delete(k); }
    return pr;
  }
  cleanOld() {
    try {
      const keep = new Set([0, 1, 2].map(i => `schedule-${this.dayKey(this.dayStart(this.now()) - i * DAY)}.json`));
      for (const f of fs.readdirSync(this.dir)) if (/^schedule-.*\.json$/.test(f) && !keep.has(f) && !f.includes(this.dayKey(this.dayStart(this.now()) + DAY)))
        fs.rmSync(path.join(this.dir, f), { force: true });
    } catch {}
  }

  build(start, key) {
    const end = start + DAY;
    const dayNo = Math.round(start / DAY);
    const R = rng(hash32(`${key}:${this.cfgHash}`));
    const pick = arr => arr[Math.floor(R() * arr.length)];
    const busy = new Map();                                     // tape -> [[s, e]]
    const free = (k, s, e) => !(busy.get(k) || []).some(([a, b]) => a < e && s < b);
    const take = (k, s, e) => { if (!busy.has(k)) busy.set(k, []); busy.get(k).push([s, e]); };
    const ads = this.poolItems(this.config.adPool);

    const chans = this.archiveChannels().map(c => {
      const pools = Object.fromEntries(Object.entries(c.pools || {}).map(([n, s]) => {
        const items = this.poolItems(s);
        const groups = new Map();
        if ((s.runs || 1) > 1) {
          for (const it of items) {
            const g = it.series || describe(it, true).series.toLowerCase() || seriesKey(it.title);
            if (!g) continue;
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(it);
          }
          for (const [g, list] of groups) { if (list.length < 2) groups.delete(g); else list.sort((a, b) => naturalSort(a.title + a.key, b.title + b.key)); }
        }
        // Names that recur before " - " / ": " in this pool are series ("Popeye - ...", "Bonanza: ...").
        const counts = new Map();
        for (const it of items) { const pre = seriesPrefix(cleanTitle(it.title).title).toLowerCase(); if (pre) counts.set(pre, (counts.get(pre) || 0) + 1); }
        const known = new Set([...counts].filter(([, c]) => c >= 3).map(([p]) => p));
        return [n, { spec: s, items, groups: [...groups.entries()], known, list: listMode(s) }];
      }));
      return { c, pools, cur: start, out: [], used: new Set(), seriesPos: new Map(), lastSeries: '' };
    });

    const poolAt = (ch, t) => {
      const ms = t - start;
      for (const b of ch.c.blocks || []) {
        const f = hhmm(b.from), to = hhmm(b.to);
        const inside = f <= to ? ms >= f && ms < to : ms >= f || ms < to;
        if (inside && ch.pools[b.pool]?.items.length) return ch.pools[b.pool];
      }
      return ch.pools.main?.items.length ? ch.pools.main : Object.values(ch.pools).find(p => p.items.length) || null;
    };
    // The block a program belongs to: the pool's name for that part of the day.
    const blockName = (ch, pool, t) => {
      const n = pool.spec.name, dp = daypart(t);
      if (typeof n === 'string') return n;
      if (n && n[dp]) return n[dp];
      return `${DAYPART_NAMES[dp]} on ${ch.c.name}`;
    };
    const category = (pool, it, d, kind, isRun) => kind === 'ad' ? 'Commercial' : pool.spec.label ||
      (isRun || d.episode != null ? 'Series' : it.dur >= 3600 ? 'Movie' : it.dur < 600 ? 'Short' : 'Program');

    const push = (ch, e) => { ch.out.push(e); ch.cur = e.e; };
    const card = (ch, text, ms) => push(ch, { s: ch.cur, e: Math.min(end, ch.cur + ms), kind: 'card', text });
    const video = (ch, it, kind = 'video', tag = {}) => {
      const s = ch.cur, e = Math.min(end, s + Math.round(it.dur * 1000));
      take(it.key, s, e);
      const d = tag.d || describe(it);
      push(ch, { s, e, kind, id: it.id, f: it.file || '', t: d.title, y: d.year || '', sub: d.sub || '', ser: d.series || '', ds: it.desc || '', lm: tag.list || '',
                 ep: d.episode, b: tag.block || '', c: tag.cat || (kind === 'ad' ? 'Commercial' : ''), r: tag.run || '' });
    };

    // A run of episodes from one series, continuing where the series left off.
    const chooseRun = (ch, pool) => {
      const runs = pool.spec.runs || 1;
      if (runs < 2 || !pool.groups.length || R() < 0.15) return null;
      for (let tries = 0; tries < 12; tries++) {
        const [g, list] = pick(pool.groups);
        if (g === ch.lastSeries && pool.groups.length > 1) continue;
        const gk = `${ch.c.dial}:${g}`;
        let pos = ch.seriesPos.get(gk);
        if (pos == null) pos = (hash32(gk) + dayNo * runs) % list.length;
        const eps = [];
        let t = ch.cur;
        for (let i = 0; i < runs; i++) {
          const it = list[(pos + i) % list.length];
          const e = t + it.dur * 1000;
          if (!free(it.key, t, e)) break;
          eps.push(it); t = e + 5000;
        }
        if (!eps.length) continue;
        ch.seriesPos.set(gk, (pos + eps.length) % list.length);
        ch.lastSeries = g;
        return eps;
      }
      return null;
    };
    const chooseOne = (ch, pool, maxDur) => {
      let fallback = null;
      for (let tries = 0; tries < 40; tries++) {
        const it = pick(pool.items);
        if (maxDur && it.dur * 1000 > maxDur) continue;
        if (!free(it.key, ch.cur, ch.cur + it.dur * 1000)) continue;
        if (!ch.used.has(it.key)) return it;
        fallback ||= it;
      }
      return fallback;
    };
    const adPod = ch => {
      if (!ads.length) return;
      let total = 0, target = 60000 + R() * 75000;
      for (let n = 0; n < 4 && total < target; n++) {
        const it = ads[Math.floor(R() * ads.length)];
        const ms = it.dur * 1000;
        if (total + ms > target + 20000 || !free(it.key, ch.cur, ch.cur + ms)) continue;
        video(ch, it, 'ad'); total += ms;
      }
    };

    // Fill all channels together, always extending whichever is furthest behind, so the
    // "never on two channels at once" check sees everything that overlaps.
    for (let guard = 0; guard < 20000; guard++) {
      let ch = null;
      for (const x of chans) if (x.cur < end && (!ch || x.cur < ch.cur)) ch = x;
      if (!ch) break;
      const pool = poolAt(ch, ch.cur);
      if (!pool) { card(ch, `${ch.c.name.toUpperCase()}\n\nOFF THE AIR\n\nThe tapes are still being found.`, end - ch.cur); continue; }
      const left = end - ch.cur;
      const first = !ch.out.length;
      let eps = chooseRun(ch, pool);
      if (!eps) {
        const it = chooseOne(ch, pool, left < 20 * 60000 ? left : 0) || (left >= 20 * 60000 ? null : chooseOne(ch, pool, 0));
        if (!it) { card(ch, `${ch.c.name.toUpperCase()}\n\nWE'LL BE RIGHT BACK`, Math.min(left, 60000)); continue; }
        eps = [it];
      }
      const isRun = eps.length > 1, block = blockName(ch, pool, ch.cur), run = isRun ? `${ch.c.dial}@${ch.cur}` : '';
      eps.forEach((it, i) => {
        if (ch.cur >= end) return;
        const d = describe(it, (pool.spec.runs || 1) > 1, pool.known);
        if (isRun && !d.series) d.series = shorten(cleanTitle(it.title).title, 34);
        if ((!first || i) && it.dur >= 180) {
          const bumpers = ch.c.bumpers;
          const text = bumpers?.length && R() < 0.5 ? `${pick(bumpers)}\n\nNEXT: ${d.title}` : `UP NEXT\n\n${d.title}`;
          card(ch, text, 5000);
        }
        if (ch.cur < end) { video(ch, it, 'video', { d, block, cat: category(pool, it, d, 'video', isRun), run, list: pool.list }); ch.used.add(it.key); }
      });
      if (ch.c.ads && ch.cur < end && eps.reduce((a, it) => a + it.dur, 0) >= 8 * 60) adPod(ch);
    }

    const channels = {};
    for (const ch of chans) channels[ch.c.dial] = ch.out;
    this.log(`OOMPAS: schedule for ${key} built (${chans.length} channels)`);
    return { cfg: this.cfgHash, start, end, channels };
  }

  // The day's schedule if it's ready; otherwise starts building it and returns null.
  dayIfReady(t) {
    const key = this.dayKey(this.dayStart(t));
    if (this.resolved.has(key)) return this.resolved.get(key);
    this.day(t).catch(e => this.log('OOMPAS: schedule failed: ' + e.message));
    return null;
  }

  // Entry on air at time t on a channel: null if nothing, undefined if not ready yet.
  async at(dial, t, wait = false) {
    const d = wait ? await this.day(t) : this.dayIfReady(t);
    this.dayIfReady(t + 2 * 3600000);              // have tomorrow ready before midnight
    if (!d) return undefined;
    const list = d.channels[dial] || [];
    let lo = 0, hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, e = list[mid];
      if (t < e.s) hi = mid - 1; else if (t >= e.e) lo = mid + 1; else return e;
    }
    return null;
  }

  // Shows (not cards/ads) between from and until; breaks fold into the show before them.
  async programsBetween(dial, from, until, wait = false) {
    const out = [];
    for (let day = this.dayStart(from); day < until; day += DAY) {
      const d = wait ? await this.day(day) : this.dayIfReady(day);
      if (!d) break;
      for (const e of d.channels[dial] || []) {
        if (e.e <= from || e.s >= until) continue;
        const last = out[out.length - 1];
        if (e.kind === 'video') {
          if (last && last.key === `${e.id}/${e.f}@${e.s}`) continue;
          const ep = { title: e.t, sub: e.sub || '', num: e.ep ?? null, desc: e.ds || '', startMs: e.s, endMs: e.e };
          if (e.r && last && last.run === e.r) {          // the next episode of a run: one listing
            last.eps.push(ep); last.endMs = e.e;
            continue;
          }
          // Series are listed by name; which episode is on goes in the guide's top panel.
          out.push({ key: `${e.id}/${e.f}@${e.s}`, title: e.lm === 'title' ? e.t : (e.ser || e.t), year: e.y, list: e.lm || '', desc: e.ds || '', startMs: e.s, endMs: e.e, block: e.b || '', category: e.c || '',
                     run: e.r || '', series: e.ser || '', eps: [ep] });
        } else if (last) last.endMs = e.e;
        else out.push({ key: 'break', title: e.kind === 'ad' ? 'Commercial break' : 'Station break', startMs: e.s, endMs: e.e });
      }
    }
    // A stretch of short pieces in one block (music videos, infomercials, cartoons) is one
    // listing under the block's name, instead of a row of tiny cells.
    const merged = [];
    for (const p of out) {
      const last = merged[merged.length - 1];
      const short = x => x.block && (x.list === 'block' || (!(x.eps?.length > 1) && x.endMs - x.startMs < 15 * 60000));
      if (last && last.block && last.block === p.block && (last.isBlock || short(last)) && short(p)) {
        if (!last.isBlock) Object.assign(last, { isBlock: true, title: last.block, year: '', sub: '', series: '', desc: '' });
        last.eps.push(...(p.eps || [])); last.endMs = p.endMs;
        continue;
      }
      if (p.list === 'block' && p.block && !p.isBlock) Object.assign(p, { isBlock: true, title: p.block, year: '', sub: '', series: '', desc: '' });
      merged.push(p);
    }
    return merged;
  }
}
