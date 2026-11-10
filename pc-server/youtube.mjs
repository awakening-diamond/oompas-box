// YouTube channels: a playlist (or a YouTube channel's uploads) played by the clock, like a TV channel.
// Videos play in YouTube's own embedded player in the app; nothing is downloaded. The app's player
// reads each video's title and length once ("scanning"), and the schedule is made from those.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { liveFileSync, liveFile } from './live.mjs';

const EPOCH = Date.UTC(2026, 0, 1);
const COLORS = ['#ff4e45', '#ff8a3d', '#ffd23f', '#5ad27a', '#4fb0ff', '#a07bff'];
const hash = s => crypto.createHash('sha1').update(String(s)).digest();

// Same order every time for the same channel and cycle, different each cycle. Each video's place
// comes from its own id, so adding or dropping one video doesn't reorder the others.
function shuffled(arr, seed) {
  return arr.map(v => [hash(`${seed}|${v.id}`).readUInt32LE(0), v]).sort((a, b) => a[0] - b[0]).map(x => x[1]);
}
// A link -> what to play. Playlists: list=…  Channels: /channel/UC… (their uploads playlist is UU…).
// @handles, /c/ and /user/ links need the channel id, which the server looks up once.
export function parseYouTubeLink(raw) {
  const s = String(raw || '').trim();
  if (/^(PL|UU|OL|FL|LL|RD)[\w-]{10,}$/.test(s)) return { list: s };
  if (/^UC[\w-]{22}$/.test(s)) return { list: 'UU' + s.slice(2) };
  if (/^@[\w.-]{2,}$/.test(s)) return { handle: s };
  let u;
  try { u = new URL(/^https?:/i.test(s) ? s : 'https://' + s); } catch { return null; }
  if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(u.hostname)) return null;
  const list = u.searchParams.get('list');
  if (list) return { list };
  const ch = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (ch) return { list: 'UU' + ch[1].slice(2) };
  const h = u.pathname.match(/^\/(@[\w.-]+)/);
  if (h) return { handle: h[1] };
  const cu = u.pathname.match(/^\/(c|user)\/([\w.-]+)/);
  if (cu) return { handle: `${cu[1]}/${cu[2]}` };
  return null;
}

// Channels that come with the app are listed in lineups/youtube.json, which can be updated from
// GitHub without a new release (see live.mjs).
// The built-in channels' video lists, published in the repo (lineups/youtube-videos.json, made daily
// by a GitHub Action from YouTube's API). With it every copy of the app plays the same videos at the
// same times; without it (not published yet) each app reads the list itself.
const validPublished = j => j && typeof j.channels === 'object' && Object.values(j.channels).every(c => typeof c.list === 'string' && Array.isArray(c.videos));
const validBuiltins = j => Array.isArray(j?.channels) && j.channels.every(b => /^[\w-]{2,20}$/.test(b.id) && /^@[\w.-]{2,}$/.test(b.handle) && b.dial >= 1 && b.dial <= 9999);

export class YouTube {
  constructor({ dataDir, cacheDir, log = () => {}, fetchImpl = fetch }) {
    this.cacheDir = cacheDir;
    this.file = path.join(dataDir, 'youtube.json');
    this.log = log;
    this.fetch = fetchImpl;
    this.channels = [];
    try { this.channels = JSON.parse(fs.readFileSync(this.file, 'utf8')).channels || []; } catch {}
    this.cache = new Map();   // channel id -> { cycle, order, total }
    this.builtins = liveFileSync('youtube.json', cacheDir, validBuiltins)?.channels || [];
    this.published = liveFileSync('youtube-videos.json', cacheDir, validPublished)?.channels || {};
    this.ensureBuiltins();
  }

  get builtinDials() { return new Set(this.builtins.map(b => b.dial)); }

  // Checks GitHub for changes to the built-in channels.
  async updateBuiltins(force = false) {
    const j = await liveFile('youtube.json', { cacheDir: this.cacheDir, log: this.log, force, ok: validBuiltins });
    if (j && JSON.stringify(j.channels) !== JSON.stringify(this.builtins)) { this.builtins = j.channels; this.ensureBuiltins(); this.log('YouTube: built-in channels updated'); }
    const pub = await liveFile('youtube-videos.json', { cacheDir: this.cacheDir, log: this.log, force, maxAge: 3600e3, ok: validPublished });
    if (pub && JSON.stringify(pub.channels) !== JSON.stringify(this.published)) { this.published = pub.channels; this.ensureBuiltins(); this.log(`YouTube: shared video lists updated (${pub.updated || ''})`); }
    await this.resolveBuiltins();
  }

  ensureBuiltins() {
    const BUILTIN_DIALS = this.builtinDials, ids = new Set(this.builtins.map(b => b.id));
    this.channels = this.channels.filter(c => !c.builtin || ids.has(c.id));
    for (const b of this.builtins) {
      let c = this.channels.find(x => x.id === b.id);
      if (!c) { c = { id: b.id, list: '', link: '', videos: [], bad: [], scannedAt: 0, added: Date.now() }; this.channels.unshift(c); }
      if ((c.handle && c.handle.toLowerCase() !== b.handle.toLowerCase()) || (c.resolver || 0) < 2)   // another channel now, or looked up the old way
        Object.assign(c, { list: '', videos: [], bad: [], scannedAt: 0, resolver: 2 });
      Object.assign(c, { name: b.name, dial: b.dial, handle: b.handle, link: `https://www.youtube.com/${b.handle}`, order: 'shuffle', builtin: true,
                         bug: /^[\w.-]+\.(png|webp|svg)$/.test(b.bug || '') ? b.bug : '' });
      const pub = Object.entries(this.published).find(([h]) => h.toLowerCase() === b.handle.toLowerCase())?.[1];
      if (pub?.videos?.length) {
        Object.assign(c, { list: pub.list, published: true, bad: [], scannedAt: Date.now(), scanV: 99,
          videos: pub.videos.filter(v => /^[\w-]{11}$/.test(v.id) && v.dur > 0).map(v => ({ id: v.id, title: String(v.title || '').slice(0, 200), dur: Math.round(v.dur) })) });
      } else if (c.published) Object.assign(c, { published: false, videos: [], scannedAt: 0, scanV: 0 });
    }
    // Anything the user put on a built-in channel's number moves to the next free one from 300.
    const used = new Set(this.channels.map(c => c.dial));
    for (const c of this.channels) if (!c.builtin && BUILTIN_DIALS.has(c.dial)) { let d = 300; while (used.has(d)) d++; used.add(d); c.dial = d; }
    this.save();
  }

  // Built-in channels are known by their @handle; the uploads list is looked up once on each computer.
  async resolveBuiltins() {
    if (this.resolving) return;
    this.resolving = true;
    try {
      for (const handle of new Set(this.channels.filter(x => x.builtin && !x.list).map(x => x.handle))) {
        try {
          const { list } = await this.resolveHandle(handle);
          for (const o of this.channels) if (o.handle === handle && !o.list) o.list = list;
          this.save();
          this.log(`YouTube: found ${handle}`);
        } catch (e) { this.log(`YouTube: couldn’t look up ${handle} yet (${e.message})`); }
      }
    } finally { this.resolving = false; }
  }

  save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ channels: this.channels }, null, 1)); }
    catch (e) { this.log('YouTube: couldn’t save: ' + e.message); }
    this.cache.clear();
  }

  // The newest videos of a playlist (up to 15), from YouTube's public feed: a fallback for when the
  // embedded player won't list a channel's uploads.
  async feed(list) {
    if (!/^[\w-]{10,}$/.test(list)) throw new Error('bad list');
    const r = await this.fetch(`https://www.youtube.com/feeds/videos.xml?playlist_id=${list}`);
    if (!r.ok) throw new Error(`YouTube said ${r.status}`);
    const xml = await r.text();
    return [...xml.matchAll(/<entry>[\s\S]*?<yt:videoId>([\w-]{11})<\/yt:videoId>[\s\S]*?<title>([^<]*)<\/title>/g)]
      .map(m => ({ id: m[1], title: m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') }));
  }

  // The channel id for an @handle (or an old /c/ or /user/ link), from the channel's public page.
  async resolveHandle(handle) {
    const fake = process.env.YT_HANDLES && JSON.parse(process.env.YT_HANDLES)[handle];   // tests
    if (fake) return { list: fake, name: '' };
    const r = await this.fetch(`https://www.youtube.com/${handle}`, { headers: { 'accept-language': 'en', cookie: 'SOCS=CAI; CONSENT=YES+1' } });
    if (!r.ok) throw new Error(`YouTube said ${r.status} for ${handle}`);
    const html = await r.text();
    // The page names other channels too (recommendations), so go by the ones that are about this page.
    const id = [/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/, /"externalId":"(UC[\w-]{22})"/,
                /<meta itemprop="(?:channelId|identifier)" content="(UC[\w-]{22})"/, /"browseId":"(UC[\w-]{22})"/]
      .map(re => (html.match(re) || [])[1]).find(Boolean);
    if (!id) throw new Error(`Couldn’t find the channel ${handle}`);
    const name = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '';
    return { list: 'UU' + id.slice(2), name: name.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') };
  }

  async add({ link, name, dial, order }) {
    const p = parseYouTubeLink(link);
    if (!p) throw Object.assign(new Error('That doesn’t look like a YouTube playlist or channel link'), { status: 400 });
    let list = p.list, found = '';
    if (p.handle) ({ list, name: found } = await this.resolveHandle(p.handle));
    if (this.channels.some(c => c.list === list)) throw Object.assign(new Error('That one is already a channel'), { status: 400 });
    const id = 'yt' + hash(list).toString('hex').slice(0, 10);
    const c = { id, list, link: String(link).trim().slice(0, 500), name: String(name || found || 'YouTube').slice(0, 60),
                dial: Number(dial) || 0, order: order === 'inorder' ? 'inorder' : 'shuffle', videos: [], bad: [], scannedAt: 0, added: Date.now() };
    this.channels.push(c);
    this.save();
    this.log(`YouTube: added ${c.name} (${list})`);
    return c;
  }

  update(id, patch = {}) {
    const c = this.channels.find(x => x.id === id);
    if (!c) throw Object.assign(new Error('No such YouTube channel'), { status: 404 });
    if (c.builtin) throw Object.assign(new Error('That channel comes with OOMPAS Box'), { status: 400 });
    if (this.builtinDials.has(+patch.dial)) throw Object.assign(new Error(`Channel ${patch.dial} is taken`), { status: 400 });
    if (typeof patch.name === 'string' && patch.name.trim()) c.name = patch.name.trim().slice(0, 60);
    if (Number.isFinite(+patch.dial) && +patch.dial >= 1 && +patch.dial <= 9999) c.dial = Math.round(+patch.dial);
    if (['shuffle', 'inorder'].includes(patch.order)) c.order = patch.order;
    this.save();
    return c;
  }

  remove(id) { this.channels = this.channels.filter(c => c.id !== id || c.builtin); this.save(); }

  // From the app's scan: [{ id, title, dur (seconds) }], in playlist order. Videos that won't play
  // in an embedded player come back with bad: true.
  setVideos(id, videos, done = true, scanV = 1) {
    const first = this.channels.find(x => x.id === id);
    if (!first) throw Object.assign(new Error('No such YouTube channel'), { status: 404 });
    if (first.published) return first;
    const clean = (Array.isArray(videos) ? videos : []).slice(0, 5000)
      .filter(v => v && /^[\w-]{11}$/.test(v.id))
      .map(v => ({ id: v.id, title: String(v.title || '').slice(0, 200), dur: Math.max(0, Math.round(+v.dur || 0)), bad: !!v.bad }));
    for (const c of this.channels.filter(x => x.id === id || (first.list && x.list === first.list))) {
      c.videos = clean.filter(v => !v.bad);
      c.bad = [...new Set([...(c.bad || []).filter(b => !clean.some(v => v.id === b)), ...clean.filter(v => v.bad).map(v => v.id)])];
      if (done) { c.scannedAt = Date.now(); c.scanV = scanV; }
    }
    this.save();
    if (done) this.log(`YouTube: ${first.name}: ${this.playable(first).length} videos ready${first.bad.length ? `, ${first.bad.length} can’t play outside YouTube` : ''}`);
    return first;
  }

  // A video that turned out not to play (removed, private, embedding off): skip it from now on.
  markBad(id, videoId) {
    const c = this.channels.find(x => x.id === id);
    if (!c || !/^[\w-]{11}$/.test(videoId) || c.bad.includes(videoId)) return;
    for (const o of this.channels) if (!o.published && (o === c || (c.list && o.list === c.list)) && !o.bad.includes(videoId)) o.bad.push(videoId);
    this.save();
  }

  // The player found a video's real length differs from the list's.
  setLength(id, videoId, dur) {
    const c = this.channels.find(x => x.id === id);
    if (!c || !(dur > 0)) return;
    let changed = false;
    for (const o of this.channels) if (!o.published && (o === c || (c.list && o.list === c.list)))
      for (const v of o.videos) if (v.id === videoId && Math.abs(v.dur - dur) > 3) { v.dur = Math.round(dur); changed = true; }
    if (changed) { this.save(); this.log(`YouTube: corrected the length of ${videoId}`); }
  }

  playable(c) { return c.videos.filter(v => v.dur >= 5 && !c.bad.includes(v.id)); }

  // Lineup entries (dials already settled by the server).
  lineupChannels() {
    return this.channels.filter(c => c.dial).map(c => ({
      dial: c.dial, id: 'yt-' + c.id, ytId: c.id, name: c.name, call: c.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase() || 'YT',
      color: COLORS[c.dial % COLORS.length], kind: 'youtube', bug: c.bug ? `/tv/bugs/${c.bug}` : '', list: 'YouTube', cats: ['YouTube'], group: 'YouTube',
      description: this.playable(c).length ? `${this.playable(c).length} videos from YouTube` : 'Not scanned yet',
    }));
  }

  find(id) { return this.channels.find(c => c.id === id || 'yt-' + c.id === id) || null; }

  // The cycle containing time t: the order of videos and when the cycle started.
  cycleAt(c, t) {
    const vids = this.playable(c);
    if (!vids.length) return null;
    const total = vids.reduce((s, v) => s + v.dur, 0) * 1000;
    const k = Math.floor((t - EPOCH) / total);
    const key = `${c.id}|${k}|${vids.length}|${total}|${c.order}`;
    let hit = this.cache.get(c.id);
    if (!hit || hit.key !== key) {
      hit = { key, start: EPOCH + k * total, total, order: c.order === 'inorder' ? vids : shuffled(vids, `${c.id}|${k}`) };
      this.cache.set(c.id, hit);
    }
    return hit;
  }

  // Shows in [from, until).
  programs(ch, from, until) {
    const c = this.find(ch.ytId || ch.id);
    const out = [];
    if (!c) return out;
    let t = from, guard = 0;
    while (t < until && guard++ < 500) {
      const cy = this.cycleAt(c, t);
      if (!cy) break;
      let s = cy.start;
      for (const v of cy.order) {
        const e = s + v.dur * 1000;
        if (e > t && s < until) out.push({ key: `${ch.id}@${s}`, title: v.title || 'YouTube video', sub: '', year: '', startMs: s, endMs: e, videoId: v.id });
        s = e;
        if (s >= until) break;
      }
      t = cy.start + cy.total;
    }
    if (!out.length) {
      for (let h = Math.floor(from / 3600e3) * 3600e3; h < until; h += 3600e3)
        out.push({ key: `${ch.id}@${h}`, title: c.videos.length ? ch.name : `${c.handle || ch.name} · getting the video list…`, year: '', startMs: h, endMs: h + 3600e3, live: true });
    }
    return out;
  }

  // What to play at time t: the video and how far into it.
  playAt(ch, t) {
    const c = this.find(ch.ytId || ch.id);
    if (!c) return null;
    if (!c.list && !c.published) { this.resolveBuiltins(); return { ytId: c.id, list: '', finding: c.handle || c.name }; }
    const p = this.programs(ch, t, t + 1)[0];
    if (!p || !p.videoId) return { ytId: c.id, list: c.list, scan: !c.scannedAt || Date.now() - c.scannedAt > 7 * 86400e3 };
    return { ytId: c.id, list: c.list, published: !!c.published, videoId: p.videoId, start: Math.max(0, (t - p.startMs) / 1000), endMs: p.endMs, dur: (p.endMs - p.startMs) / 1000,
             title: p.title, scan: Date.now() - c.scannedAt > 7 * 86400e3 };
  }

  status() {
    return this.channels.slice().sort((a, b) => a.dial - b.dial).map(c => ({ id: c.id, name: c.name, dial: c.dial, link: c.link, list: c.list, order: c.order, builtin: !!c.builtin,
      videos: this.playable(c).length, bad: c.bad.length, hours: Math.round(this.playable(c).reduce((s, v) => s + v.dur, 0) / 360) / 10,
      scannedAt: c.scannedAt, scanV: c.scanV || 0, published: !!c.published }));
  }
}
