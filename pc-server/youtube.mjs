// YouTube channels: a playlist (or a YouTube channel's uploads) played by the clock, like a TV channel.
// Videos play in YouTube's own embedded player in the app; nothing is downloaded. The app's player
// reads each video's title and length once ("scanning"), and the schedule is made from those.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EPOCH = Date.UTC(2026, 0, 1);
const COLORS = ['#ff4e45', '#ff8a3d', '#ffd23f', '#5ad27a', '#4fb0ff', '#a07bff'];
const hash = s => crypto.createHash('sha1').update(String(s)).digest();

// Same order every time for the same channel and cycle, different each cycle.
function shuffled(arr, seed) {
  const a = arr.slice(), h = hash(seed);
  let x = h.readUInt32LE(0) || 1;
  const rnd = () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; };
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
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

export class YouTube {
  constructor({ dataDir, log = () => {}, fetchImpl = fetch }) {
    this.file = path.join(dataDir, 'youtube.json');
    this.log = log;
    this.fetch = fetchImpl;
    this.channels = [];
    try { this.channels = JSON.parse(fs.readFileSync(this.file, 'utf8')).channels || []; } catch {}
    this.cache = new Map();   // channel id -> { cycle, order, total }
  }

  save() {
    try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify({ channels: this.channels }, null, 1)); }
    catch (e) { this.log('YouTube: couldn’t save: ' + e.message); }
    this.cache.clear();
  }

  // The channel id for an @handle (or an old /c/ or /user/ link), from the channel's public page.
  async resolveHandle(handle) {
    const r = await this.fetch(`https://www.youtube.com/${handle}`, { headers: { 'accept-language': 'en' } });
    if (!r.ok) throw new Error(`YouTube said ${r.status} for ${handle}`);
    const html = await r.text();
    const id = (html.match(/"(?:externalId|channelId)":"(UC[\w-]{22})"/) || html.match(/youtube\.com\/channel\/(UC[\w-]{22})/) || [])[1];
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
    if (typeof patch.name === 'string' && patch.name.trim()) c.name = patch.name.trim().slice(0, 60);
    if (Number.isFinite(+patch.dial) && +patch.dial >= 1 && +patch.dial <= 9999) c.dial = Math.round(+patch.dial);
    if (['shuffle', 'inorder'].includes(patch.order)) c.order = patch.order;
    this.save();
    return c;
  }

  remove(id) { this.channels = this.channels.filter(c => c.id !== id); this.save(); }

  // From the app's scan: [{ id, title, dur (seconds) }], in playlist order. Videos that won't play
  // in an embedded player come back with bad: true.
  setVideos(id, videos, done = true) {
    const c = this.channels.find(x => x.id === id);
    if (!c) throw Object.assign(new Error('No such YouTube channel'), { status: 404 });
    const clean = (Array.isArray(videos) ? videos : []).slice(0, 5000)
      .filter(v => v && /^[\w-]{11}$/.test(v.id))
      .map(v => ({ id: v.id, title: String(v.title || '').slice(0, 200), dur: Math.max(0, Math.round(+v.dur || 0)), bad: !!v.bad }));
    c.videos = clean.filter(v => !v.bad);
    c.bad = [...new Set([...(c.bad || []).filter(b => !clean.some(v => v.id === b)), ...clean.filter(v => v.bad).map(v => v.id)])];
    if (done) c.scannedAt = Date.now();
    this.save();
    this.log(`YouTube: ${c.name}: ${this.playable(c).length} videos ready${c.bad.length ? `, ${c.bad.length} can’t play outside YouTube` : ''}`);
    return c;
  }

  // A video that turned out not to play (removed, private, embedding off): skip it from now on.
  markBad(id, videoId) {
    const c = this.channels.find(x => x.id === id);
    if (!c || !/^[\w-]{11}$/.test(videoId) || c.bad.includes(videoId)) return;
    c.bad.push(videoId);
    this.save();
  }

  playable(c) { return c.videos.filter(v => v.dur >= 5 && !c.bad.includes(v.id)); }

  // Lineup entries (dials already settled by the server).
  lineupChannels() {
    return this.channels.filter(c => c.dial).map((c, i) => ({
      dial: c.dial, id: 'yt-' + c.id, ytId: c.id, name: c.name, call: c.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase() || 'YT',
      color: COLORS[c.dial % COLORS.length], kind: 'youtube', list: 'YouTube', cats: ['YouTube'], group: 'YouTube',
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
        out.push({ key: `${ch.id}@${h}`, title: c.videos.length ? ch.name : `${ch.name} · getting the video list…`, year: '', startMs: h, endMs: h + 3600e3, live: true });
    }
    return out;
  }

  // What to play at time t: the video and how far into it.
  playAt(ch, t) {
    const c = this.find(ch.ytId || ch.id);
    if (!c) return null;
    const p = this.programs(ch, t, t + 1)[0];
    if (!p || !p.videoId) return { ytId: c.id, list: c.list, scan: !c.scannedAt || Date.now() - c.scannedAt > 7 * 86400e3 };
    return { ytId: c.id, list: c.list, videoId: p.videoId, start: Math.max(0, (t - p.startMs) / 1000), endMs: p.endMs,
             title: p.title, scan: Date.now() - c.scannedAt > 7 * 86400e3 };
  }

  status() {
    return this.channels.map(c => ({ id: c.id, name: c.name, dial: c.dial, link: c.link, list: c.list, order: c.order,
      videos: this.playable(c).length, bad: c.bad.length, hours: Math.round(this.playable(c).reduce((s, v) => s + v.dur, 0) / 360) / 10,
      scannedAt: c.scannedAt }));
  }
}
