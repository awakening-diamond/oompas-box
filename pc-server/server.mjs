#!/usr/bin/env node
// OOMPAS Box server: the engine behind the OOMPAS Box app.
//
// OOMPAS Box's own channels (oompas-channels.json) are scheduled here from Internet
// Archive searches; the Guide and Weather channels are drawn live; Spelunkr's channels
// (using Spelunkr's public schedule data and scheduler) sit above them on the dial; IPTV
// playlists can be added on top. Each channel streams as H.264 + AAC in MPEG-TS, which
// the TV interface (tv/, served at /tv/) plays.
//
//   node server.mjs            (default port 8090, this computer only; LISTEN=0.0.0.0 for your network)
//
// Endpoints: /tv/ (the TV interface), /api/* (its data), /tune/<dial>.ts (a channel's stream),
// /iptv/p (IPTV proxy), /quit (used by the desktop app).

import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OompasNet, hash32, rng, parseDuration, shorten } from './oompas.mjs';
import { Worker } from 'node:worker_threads';
import { Iptv, CATALOG, proxy as iptvProxy, proxyUrl } from './iptv.mjs';
import { YouTube, BUILTIN_DIALS } from './youtube.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- settings
const CFG = {
  port: Number(process.env.PORT || 8090),
  ffmpeg: process.env.FFMPEG || 'ffmpeg',
  width: Number(process.env.WIDTH || 320),
  height: Number(process.env.HEIGHT || 240),
  fps: process.env.FPS || '30000/1001',
  denoise: process.env.DENOISE !== '0',
  // Prefer archive.org's small 512Kb copies (SOURCES=small) for a slow internet connection.
  smallSources: (process.env.SOURCES || '').toLowerCase() === 'small',
  sourceKbps: Number(process.env.SOURCE_KBPS || 2500),
  leadSeconds: Number(process.env.LEAD || 8),   // start the next program this early, so a slow archive.org start doesn't freeze the picture
  // Loudness every show, ad and station break is brought to (LUFS). NORMALIZE=0 turns it off.
  loudness: Number(process.env.LOUDNESS || -20),
  normalize: process.env.NORMALIZE !== '0',
  font: process.env.FONT || '',
  liveBase: process.env.LIVE_BASE || 'https://jbuopkuluyfjwgsrigry.supabase.co/storage/v1/object/public/broadcast/',
  snapshotBase: process.env.SNAPSHOT_BASE || 'https://spelunkr.tv/broadcast/',
  audioBase: 'https://audio.spelunkr.tv/bumps/',
  // Testing hooks: serve lineup/manifests from a local folder, and/or replace every video with one file.
  dataDir: process.env.SPELUNKR_DATA_DIR || '',
  mediaOverride: process.env.MEDIA_OVERRIDE || '',
  archiveBase: (process.env.ARCHIVE_BASE || 'https://archive.org').replace(/\/$/, ''),
  // OOMPAS Box's own channels, the tape library cache, and optional music for Guide/Weather.
  oompasFile: process.env.OOMPAS_CHANNELS || path.join(HERE, 'oompas-channels.json'),
  cacheDir: process.env.OOMPAS_CACHE || path.join(HERE, 'oompas-cache'),
  musicDir: process.env.MUSIC_DIR || path.join(HERE, 'music'),
  spelunkr: process.env.SPELUNKR !== '0',
  // Picture framing. BARS=0 stops trimming black bars that are baked into a video.
  // WIDESCREEN: fit = show all of a widescreen picture (bars top and bottom),
  // zoom = trim the sides a little (thinner bars), fill = fill the 4:3 screen.
  listen: process.env.LISTEN || '127.0.0.1',
  bars: process.env.BARS !== '0',
  widescreen: ['fit', 'zoom', 'fill'].includes((process.env.WIDESCREEN || '').toLowerCase()) ? process.env.WIDESCREEN.toLowerCase() : 'fit',
  // Set by the desktop app, so it can shut the server down cleanly.
  appToken: process.env.OOMPAS_APP_TOKEN || '',
};

// Spelunkr's scheduler, extracted from spelunkr.tv's public site by the
// independent spelunkr-guide project (github.com/buddytohelpu/spelunkr-guide).
// Downloaded on first run and pinned by checksum rather than bundled here.
const ENGINE = {
  url: 'https://raw.githubusercontent.com/buddytohelpu/spelunkr-guide/1456f89c94fdba64378d2fcf41316593f48a912c/web/vendor/schedule-engine.js',
  sha256: 'd7487c70460437d89d1e9323455fd320b3f83a69df33aef0ccc46a4d8a022513',
  file: process.env.ENGINE_FILE || path.join(HERE, 'vendor', 'schedule-engine.mjs'),
  maxVersion: 5,
};

// Test hook: pretend the clock started at FAKE_START_MS (ms since epoch).
const SHIFT = process.env.FAKE_START_MS ? Number(process.env.FAKE_START_MS) - Date.now() : 0;
const now = () => Date.now() + SHIFT;

const LOGBUF = [];
const log = (...a) => {
  const line = [new Date().toISOString().slice(11, 19), ...a].join(' ');
  console.log(line);
  LOGBUF.push(line); if (LOGBUF.length > 600) LOGBUF.splice(0, 100);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = buf => createHash('sha256').update(buf).digest('hex');

async function loadEngine() {
  let code = fs.existsSync(ENGINE.file) ? fs.readFileSync(ENGINE.file) : null;
  if (!code || sha256(code) !== ENGINE.sha256) {
    log('Downloading Spelunkr scheduler...');
    const r = await fetch(ENGINE.url);
    if (!r.ok) throw new Error(`Could not download the scheduler (${r.status})`);
    code = Buffer.from(await r.arrayBuffer());
    if (sha256(code) !== ENGINE.sha256) throw new Error('Scheduler checksum mismatch; refusing to run it');
    fs.mkdirSync(path.dirname(ENGINE.file), { recursive: true });
    fs.writeFileSync(ENGINE.file, code);
  }
  return import(pathToFileURL(ENGINE.file).href);
}

// ------------------------------------------------------------- broadcast
const archiveFile = (id, file) =>
  `${CFG.archiveBase}/download/${encodeURIComponent(id)}/${file.split('/').map(encodeURIComponent).join('/')}`;

class Broadcast {
  constructor(engine, oompas = null) {
    this.engine = engine;
    this.oompas = oompas;
    this.assets = new Map();
    this.playlists = new Map();
    this.lineupData = null;
    this.lineupAt = 0;
    this.source = 'live';
  }

  async json(url) {
    if (CFG.dataDir) {
      const rel = url.replace(CFG.liveBase, '').replace(CFG.snapshotBase, '');
      return JSON.parse(fs.readFileSync(path.join(CFG.dataDir, rel), 'utf8'));
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'spelunkr-mister' } });
      if (!r.ok) throw new Error(`${url} returned ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }

  async asset(p, snapshot) {
    if (!/^(manifests|platform|details)\/[A-Za-z0-9_./-]+\.json$/.test(p) || p.includes('..')) throw new Error('Bad asset path ' + p);
    const key = `${snapshot}:${p}`;
    if (!this.assets.has(key)) {
      const pr = this.json((snapshot ? CFG.snapshotBase : CFG.liveBase) + p)
        .catch(e => { if (!snapshot) return this.json(CFG.snapshotBase + p); throw e; })
        .catch(e => { this.assets.delete(key); throw e; });
      this.assets.set(key, pr);
    }
    return this.assets.get(key);
  }

  // Spelunkr's own lineup (raw dial numbers).
  async spelunkrLineup() {
    if (!this.engine) return { channels: [] };
    if (this.lineupData && now() - this.lineupAt < 60000) return this.lineupData;
    let data;
    try { data = await this.json(CFG.liveBase + 'lineup.json'); this.source = 'live'; }
    catch (e) {
      if (this.lineupData) { this.lineupAt = now(); return this.lineupData; }
      log('Live lineup failed (' + e.message + '); using website snapshot');
      data = await this.json(CFG.snapshotBase + 'lineup.json'); this.source = 'snapshot';
    }
    if (!Array.isArray(data.channels)) throw new Error('Lineup is invalid');
    if (data.audioBase) CFG.audioBase = data.audioBase;
    data.channels = data.channels.filter(c => c.dial != null && !c.debugOnly && !c.comingSoon).sort((a, b) => a.dial - b.dial);
    this.lineupData = data;
    this.lineupAt = now();
    return data;
  }

  // The whole dial: OOMPAS Box's channels first, Spelunkr's above them (dial + offset).
  async lineup() {
    let sp = { channels: [] };
    try { sp = await this.spelunkrLineup(); }
    catch (e) {
      if (!this.oompas) throw e;
      if (now() - (this.spWarnAt || 0) > 600000) { log('Spelunkr channels unavailable: ' + e.message); this.spWarnAt = now(); }
    }
    const mode = SETTINGS.oompas || 'off';   // which OOMPAS Box channels are on the dial
    if (this.merged && this.mergedFrom === sp.channels && this.mergedMode === mode) return this.merged;
    const off = Number(this.oompas?.config.spelunkrDialOffset ?? 100);
    const ours = (this.oompas?.channels || []).filter(c => mode === 'all' || (mode === 'guide' && (c.kind === 'guide' || c.kind === 'weather'))).map((c, i) => {
      const m = c.kind === 'mirror'
        ? sp.channels.find(s => String(s.name).trim().toUpperCase() === String(c.mirror || '').trim().toUpperCase()) : null;
      return { dial: Number(c.dial), id: 'oompas-' + c.dial, name: c.name, call: c.call || '', kind: c.kind,
               color: c.color || '#' + RAINBOW[i % 7].slice(2), description: c.description || '', oompas: c, mirrorOf: m?.id || null };
    });
    const mirrored = new Set(ours.map(c => c.mirrorOf).filter(Boolean));
    const taken = new Set(ours.map(c => c.dial));
    const theirs = sp.channels.filter(c => !mirrored.has(c.id))
      .map(c => ({ ...c, dial: Number(c.dial) + (ours.length ? off : 0) }))
      .filter(c => !taken.has(c.dial));
    this.merged = { channels: [...ours, ...theirs].sort((a, b) => a.dial - b.dial) };
    this.mergedFrom = sp.channels;
    this.mergedMode = mode;
    return this.merged;
  }

  async channelByDial(dial) {
    const l = await this.lineup();
    const c = (BUILTIN_DIALS.has(+dial) && this.youtube?.lineupChannels().find(c => String(c.dial) === String(dial)))
      || l.channels.find(c => String(c.dial) === String(dial))
      || this.youtube?.lineupChannels().find(c => String(c.dial) === String(dial))
      || this.iptv?.channels.find(c => String(c.dial) === String(dial));
    if (!c) throw Object.assign(new Error('No channel ' + dial), { status: 404 });
    return this.channel(c.id);
  }

  // A channel ready to play. Spelunkr channels (and mirrors of them) carry a playlist.
  async channel(id) {
    if (String(id).startsWith('yt-')) {
      const c = this.youtube?.lineupChannels().find(x => x.id === id);
      if (!c) throw Object.assign(new Error('No channel ' + id), { status: 404 });
      return c;
    }
    if (String(id).startsWith('iptv-')) {
      const c = this.iptv?.find(id);
      if (!c) throw Object.assign(new Error('No channel ' + id), { status: 404 });
      return c;
    }
    const l = await this.lineup();
    const entry = l.channels.find(c => c.id === id);
    if (!entry) throw Object.assign(new Error('No channel ' + id), { status: 404 });
    if (entry.oompas && !entry.mirrorOf) return entry;
    const sid = entry.mirrorOf || entry.id;
    const raw = await this.spelunkrLineup();
    const c = raw.channels.find(c => c.id === sid);
    if (!c) throw Object.assign(new Error('No channel ' + id), { status: 404 });
    const sig = JSON.stringify(c.versions);
    const cached = this.playlists.get(sid);
    let promise;
    if (cached && cached.sig === sig) promise = cached.promise;
    else {
      const snapshot = this.source === 'snapshot';
      const { hydrateVersion, buildPlaylist } = this.engine;
      promise = Promise.all(c.versions.map(async ptr => {
        const m = await this.asset(ptr.manifest, snapshot);
        if (m.engine > ENGINE.maxVersion) throw new Error(`Channel ${sid} needs a newer scheduler (engine ${m.engine})`);
        const plat = m.platform ? await this.asset(m.platform, snapshot) : null;
        return hydrateVersion(m, plat, ptr);
      })).then(vs => ({ ...c, playlist: buildPlaylist(sid, vs) }))
        .catch(e => { this.playlists.delete(sid); throw e; });
      this.playlists.set(sid, { sig, promise });
      if (this.assets.size > 300) this.assets.delete(this.assets.keys().next().value);
    }
    const ch = await promise;
    return entry.mirrorOf
      ? { ...ch, id: entry.id, dial: entry.dial, name: entry.name, call: entry.call, color: entry.color, description: entry.description }
      : { ...ch, dial: entry.dial };
  }

  async mediaUrl(item) {
    if (CFG.mediaOverride) return CFG.mediaOverride;
    let file = item.file || item.mp4;
    const better = await this.betterSource(item.id, file).catch(() => null);
    if (better) file = better;
    if (!file || !/\.(mp4|m4v|mov)$/i.test(file)) {
      const meta = await this.json(`${CFG.archiveBase}/metadata/${encodeURIComponent(item.id)}`);
      const mp4s = (meta.files || []).filter(f => /\.(mp4|m4v)$/i.test(f.name));
      const order = CFG.smallSources ? ['512Kb MPEG4', 'h.264 IA', 'h.264'] : ['h.264 IA', 'h.264', 'MPEG4', '512Kb MPEG4'];
      file = (order.map(fmt => mp4s.find(f => f.format === fmt)).find(Boolean) || mp4s[0])?.name;
    }
    return file ? archiveFile(item.id, file) : null;
  }

  // archive.org's "512Kb MPEG4" copies are small and soft (blocky, smeared). When a
  // tape has a better copy of the same video (h.264), play that; the PC re-encodes
  // everything anyway, so only the PC's download gets bigger. SOURCES=small turns this off.
  async betterSource(id, file) {
    if (CFG.smallSources || !id || !file || !/512kb/i.test(file)) return null;
    this.sourceCache ||= new Map();
    const key = id + '/' + file;
    if (!this.sourceCache.has(key)) {
      this.sourceCache.set(key, (async () => {
        const meta = await this.json(`${CFG.archiveBase}/metadata/${encodeURIComponent(id)}`);
        const files = meta.files || [];
        const me = files.find(f => f.name === file);
        const sibs = files.filter(f => f.name !== file && /\.(mp4|m4v)$/i.test(f.name) && (!me?.original || f.original === me.original || f.name === me.original));
        // Best copy whose bitrate the PC's internet can keep up with in real time (a slow
        // download is a stuttering channel). SOURCE_KBPS sets the ceiling.
        const secs = l => String(l || '').split(':').reduce((a, x) => a * 60 + Number(x), 0);
        const kbps = f => (Number(f.size) > 0 && secs(f.length) > 0) ? Number(f.size) * 8 / 1000 / secs(f.length) : 0;
        for (const fmt of ['h.264 IA', 'h.264', 'MPEG4']) {
          const f = sibs.find(x => x.format === fmt);
          if (f && (!kbps(f) || kbps(f) <= CFG.sourceKbps)) return f.name;
        }
        return null;
      })().catch(() => null));
      if (this.sourceCache.size > 2000) this.sourceCache.delete(this.sourceCache.keys().next().value);
    }
    return this.sourceCache.get(key);
  }

  title(item) {
    return item.title || (item.type === 'ad' ? 'A word from the past' : item.type === 'up-next' ? 'Up next' : 'Station break');
  }

  // A "plan" is one ffmpeg segment: what to show from time `at` until the
  // current program ends.
  async plan(channel, at) {
    if (channel.kind === 'youtube') throw Object.assign(new Error('YouTube channels play in the OOMPAS Box app'), { status: 400 });
    if (channel.kind === 'iptv') {
      // A live stream: one long segment (it's re-opened every few hours).
      const p = this.iptv.programs(channel, at, at + 1)[0];
      return { key: `${channel.id}@${at}`, type: 'live', title: p?.live ? channel.name : (p?.title || channel.name), year: '',
               startMs: at, endMs: at + 4 * 3600e3, dur: 4 * 3600, color: channel.color,
               kind: 'live', url: channel.iptv.url, ua: channel.iptv.ua, referrer: channel.iptv.referrer };
    }
    if (!channel.playlist) return this.oompasPlan(channel, at);
    const { resolveAt } = this.engine;
    const pos = resolveAt(channel.playlist, at);
    const { item } = pos;
    const off = pos.offsetExact;                       // seconds into this program
    const dur = Math.max(0, (pos.endMs - at) / 1000);  // seconds left
    const base = { key: pos.key, type: item.type, title: this.title(item), year: item.year || '',
                   startMs: pos.startMs, endMs: pos.endMs, dur, color: channel.color };
    if (item.type === 'video') {
      const url = await this.mediaUrl(item);
      if (!url) return { ...base, kind: 'standby' };
      return { ...base, kind: 'media', url, seek: (item.inS || 0) + off };
    }
    if (item.type === 'ad') {
      const url = CFG.mediaOverride || archiveFile(item.slice.tape, item.slice.file);
      return { ...base, kind: 'media', url, seek: (item.slice.inMs || 0) / 1000 + off };
    }
    // Station break / up-next: text cards over music, same timing as the website.
    const cards = [];
    if (item.type === 'up-next') {
      const next = resolveAt(channel.playlist, pos.endMs);
      cards.push({ text: `UP NEXT\n\n${this.title(next.item)}`, start: 0, end: item.durMs });
    } else {
      const groups = [item.channelBump, item.platformBump].filter(Boolean);
      let cur = item.half === 'close' ? 0 : 3500;
      groups.forEach((bump, gi) => {
        for (const s of bump.slides || []) {
          const len = Math.max(2500, 1500 + s.text.length * 55);
          cards.push({ text: s.text, start: cur, end: cur + len });
          cur += len;
        }
        cur += 2000 + (gi === 0 && groups.length > 1 ? 300 : 0);
      });
    }
    const audio = item.channelAudio || item.platformAudio;
    return { ...base, kind: 'card', cards, offset: off,
             audioUrl: audio?.filename ? CFG.audioBase + encodeURIComponent(audio.filename) : '',
             audioSeek: (audio?.startOffset || 0) + off };
  }

  // OOMPAS Box channels: drawn ones (Guide, Weather) and scheduled archive ones.
  async oompasPlan(channel, at) {
    const base = { color: channel.color, year: '' };
    if (channel.kind === 'guide' || channel.kind === 'weather') return genPlan(this, channel, at);
    const e = await this.oompas.at(channel.dial, at);
    if (e === undefined || e === null) {
      const text = e === undefined ? `${channel.name.toUpperCase()}\n\nFINDING TAPES...\n\nThe first start takes a few minutes.` : 'PLEASE STAND BY';
      return { ...base, key: 'wait', type: 'card', kind: 'card', title: 'Please stand by', startMs: at, endMs: at + 15000, dur: 15,
               cards: [{ text, start: 0, end: 15000 }], offset: 0, audioUrl: '' };
    }
    const common = { ...base, key: `${e.id || 'card'}/${e.f || ''}@${e.s}`, type: e.kind, title: e.t || 'Station break', year: e.y || '',
                     block: e.b || '', category: e.c || '', sub: e.sub || '', startMs: e.s, endMs: e.e, dur: Math.max(0, (e.e - at) / 1000) };
    if (e.kind === 'card') {                  // re-checked at least every minute (an off-air card can be long)
      const endMs = Math.min(e.e, at + 60000);
      return { ...common, kind: 'card', endMs, dur: (endMs - at) / 1000, cards: [{ text: e.text, start: 0, end: e.e - e.s }], offset: (at - e.s) / 1000, audioUrl: '' };
    }
    const url = await this.mediaUrl({ id: e.id, file: e.f }).catch(() => null);
    if (!url) return { ...common, kind: 'standby' };
    return { ...common, kind: 'media', url, seek: (at - e.s) / 1000 };
  }
}

// ---------------------------------------------------------------- ffmpeg
// Clear out work folders left by a server that was closed without cleaning up.
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    if (!/^spelunkr-/.test(d)) continue;
    const full = path.join(os.tmpdir(), d);
    if (Date.now() - fs.statSync(full).mtimeMs > 6 * 3600e3) fs.rmSync(full, { recursive: true, force: true });
  }
} catch {}
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'spelunkr-'));
let FONT = 'font.ttf';
// Text style. With the pixel fonts: Jersey 10 at its native sizes, drawn without
// smoothing so letters stay crisp at 240 lines. Otherwise a system font is used.
const UI = { pixel: false, logo: 'font.ttf', body: 10, big: 18, logoSize: 11, cw: 6, caps: 7, line: 12 };
const PIXEL_FONTS = {
  ui:   { url: 'https://raw.githubusercontent.com/google/fonts/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl/jersey10/Jersey10-Regular.ttf',
          sha256: 'db9cbd091617048a145d249daa2b815fe7083be6ab66ac26626e21a4e01c3e82' },
  logo: { url: 'https://raw.githubusercontent.com/google/fonts/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl/pressstart2p/PressStart2P-Regular.ttf',
          sha256: '034c77f1f05ec89421e4a63f0e3a4ca1ecf852cc6d2bf611f126f275728e017d' },
};
// Advance widths of Arial Bold (identical in Liberation Sans Bold, which is metric-
// compatible), so text is wrapped and cut by its real pixel width.
const ARIAL_BOLD = { upem: 2048, chars: " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u2026", w: [569,682,971,1139,1139,1821,1479,487,682,682,797,1196,569,682,569,569,1139,1139,1139,1139,1139,1139,1139,1139,1139,1139,682,682,1196,1196,1196,1251,1997,1479,1479,1479,1479,1366,1251,1593,1479,569,1139,1479,1251,1706,1479,1593,1366,1593,1479,1366,1251,1479,1366,1933,1366,1366,1251,682,569,682,1196,1139,682,1139,1251,1139,1251,1139,682,1251,1251,569,569,1139,569,1821,1251,1251,1251,1251,797,1139,682,1251,1139,1593,1139,1139,1024,797,573,797,1196,2048] };
const AW = new Map([...ARIAL_BOLD.chars].map((c, i) => [c, ARIAL_BOLD.w[i]]));
// Width in pixels of text drawn at font size `size`.
function textPx(t, size = UI.body) {
  if (!UI.metrics) return String(t).length * UI.cw * size / UI.body;
  let u = 0;
  for (const c of String(t)) u += AW.get(c) ?? AW.get('M');
  return u * size / ARIAL_BOLD.upem;
}
function clipPx(t, maxPx, size) {
  t = String(t || '');
  if (textPx(t, size) <= maxPx) return t;
  while (t.length > 1 && textPx(t + '…', size) > maxPx) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}
// Greedy word wrap to maxPx; at most maxLines lines, the last one cut with "…".
function wrapPx(t, maxPx, maxLines = 99, size) {
  const lines = [];
  let cur = '';
  for (const w of String(t || '').split(/\s+/).filter(Boolean)) {
    const next = cur ? cur + ' ' + w : w;
    if (textPx(next, size) <= maxPx) cur = next;
    else { if (cur) lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  let out = lines.map(l => clipPx(l, maxPx, size));
  if (out.length > maxLines) {
    out = out.slice(0, maxLines);
    out[maxLines - 1] = clipPx(lines.slice(maxLines - 1).join(' '), maxPx, size);
  }
  return out;
}


// Pastel accents for the dreamy Guide/Weather look.
const PASTEL = ['0xff9aa2', '0xffc89a', '0xfff1a8', '0xb5ead7', '0x9ad7f0', '0xb8b5ff', '0xe2b6ff'];
// Black with rainbow accents.
const RAINBOW = ['0xff3b30', '0xff9500', '0xffd60a', '0x30d158', '0x0a84ff', '0x5e5ce6', '0xbf5af2'];

// drawtext options for a piece of text: dt(file, size, colour, x, y[, font])
const dt = (file, size, color, x, y, font = FONT) =>
  `drawtext=fontfile=${font}:expansion=none:textfile=${file}:fontsize=${size}:fontcolor=${color}:x=${x}:y=${y}` +
  (UI.pixel ? ':ft_load_flags=monochrome' : '');

// Downloads a font once (pinned to a commit, checked by hash) and copies it into WORK.
async function pinnedFont(f, name) {
  const dir = path.join(HERE, 'fonts'), file = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  let data = fs.existsSync(file) ? fs.readFileSync(file) : null;
  if (!data || sha256(data) !== f.sha256) {
    const r = await fetch(f.url);
    if (!r.ok) throw new Error(`font download returned ${r.status}`);
    data = Buffer.from(await r.arrayBuffer());
    if (sha256(data) !== f.sha256) throw new Error('font checksum mismatch');
    fs.writeFileSync(file, data);
  }
  fs.copyFileSync(file, path.join(WORK, name));
}

const GF = 'https://raw.githubusercontent.com/google/fonts/2fe1e8c6b137fb13041a7cfca6fdcd8a910ea4dc/ofl/';
const FX_FONTS = {
  shrikhand: { url: GF + 'shrikhand/Shrikhand-Regular.ttf', sha256: '8ba32f6d6a96fb8dbc92fc1acfbc4d2123d5348063d89b2c3dd784e7afcb81af' },
  michroma: { url: GF + 'michroma/Michroma-Regular.ttf', sha256: 'b62301163788bc5b7f8fcac0b74b184e34e1827e577b499ecb724da065098f87' },
  zendots: { url: GF + 'zendots/ZenDots-Regular.ttf', sha256: '2f81a9f4c26f302d87a40792e048cd7193c886aa50fa6792a4b4fb6266c25609' },
  majormono: { url: GF + 'majormonodisplay/MajorMonoDisplay-Regular.ttf', sha256: '3f2ee71c2b8464f065bf960a148be81d68fcc13385df87737928f948208dffc6' },
  vt323: { url: GF + 'vt323/VT323-Regular.ttf', sha256: 'cf4de751ada78ceac033dbe16a687742939995b77bc2a052ae17a4957958594d' },
};
const FX = {};   // font key -> file in WORK (missing keys fall back to the plain font)
const fx = k => FX[k] || FONT;

async function setupFonts() {
  if (CFG.font) return;                               // FONT=... chooses your own
  // Text: Arial Bold, drawn with its built-in hinting and no smoothing, which keeps it
  // crisp at 240 lines (the way old Windows drew small text). Look-alikes elsewhere.
  const arial = ['C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf',
                 '/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
                 '/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf', '/usr/share/fonts/TTF/LiberationSans-Bold.ttf']
    .find(p => fs.existsSync(p));
  // Logo: Press Start 2P, downloaded (pinned + checksum) from Google Fonts.
  let logo = null;
  try { await pinnedFont(PIXEL_FONTS.logo, 'logo.ttf'); logo = 'logo.ttf'; }
  catch (e) { log('Logo font unavailable (' + e.message + ')'); }
  // Display fonts for the Guide and Weather channels.
  const missing = [];
  await Promise.all(Object.entries(FX_FONTS).map(async ([k, f]) => {
    try { await pinnedFont(f, `fx_${k}.ttf`); FX[k] = `fx_${k}.ttf`; } catch { missing.push(k); }
  }));
  if (missing.length) log(`Some display fonts unavailable (${missing.join(', ')}); using the plain font there`);
  if (arial) {
    fs.copyFileSync(arial, path.join(WORK, 'ui.ttf'));
    FONT = 'ui.ttf';
    Object.assign(UI, { pixel: true, metrics: /arial|liberation/i.test(arial), logo: logo || 'ui.ttf', body: 10, big: 20, logoSize: logo ? 8 : 10, cw: 5.4, caps: 6.3, line: 10 });
    log(`Text font: ${path.basename(arial)}`);
  } else log('No Arial-style font found; using the default');
}

let BURST = false;
let RECONNECT_MORE = false;

function setupFfmpeg() {
  const v = spawnSync(CFG.ffmpeg, ['-hide_banner', '-version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) {
    throw new Error(`ffmpeg not found (tried "${CFG.ffmpeg}"). Install it and make sure it is on your PATH, ` +
                    'or set FFMPEG=C:\\path\\to\\ffmpeg.exe');
  }
  log((v.stdout.split('\n')[0] || 'ffmpeg').slice(0, 60));
  const h = spawnSync(CFG.ffmpeg, ['-hide_banner', '-h', 'full'], { encoding: 'utf8', maxBuffer: 64 << 20 });
  BURST = /readrate_initial_burst/.test(h.stdout || '');
  RECONNECT_MORE = /reconnect_on_network_error/.test(h.stdout || '');
  if (!BURST) log('Note: this ffmpeg is older than 6.1, so tuning in can\'t pre-load a reserve. Updating ffmpeg makes playback smoother.');
  const f = spawnSync(CFG.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' });
  if (!/drawtext/.test(f.stdout || '')) log('Note: this ffmpeg has no drawtext filter; channel banners and station-break text are disabled.');
  CFG.drawtext = /drawtext/.test(f.stdout || '');
  // The app plays H.264, so this ffmpeg must have x264 (the bundled one does).
  const enc = spawnSync(CFG.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  CFG.x264 = /libx264/.test(enc.stdout || '');
  if (!CFG.x264) throw new Error('This ffmpeg has no x264 (H.264) encoder, which OOMPAS Box needs. Use a full ffmpeg build.');
  fs.writeFileSync(path.join(WORK, 'probe_fg.txt'), 'null');
  const probe = spawnSync(CFG.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=16x16:d=0.1', '-/vf', 'probe_fg.txt', '-f', 'null', '-'],
                          { cwd: WORK, encoding: 'utf8' });
  FILTER_FILE = probe.status === 0 ? 'slash' : 'script';

  // Copy a font into our work folder so filter strings never contain drive letters or spaces.
  const candidates = [CFG.font,
    'C:/Windows/Fonts/consolab.ttf', 'C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/lucon.ttf', 'C:/Windows/Fonts/arialbd.ttf',
    '/System/Library/Fonts/Supplemental/Courier New Bold.ttf', '/System/Library/Fonts/Menlo.ttc', '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].filter(Boolean);
  const found = candidates.find(p => fs.existsSync(p));
  if (found) {
    FONT = UI.logo = 'font' + path.extname(found);
    fs.copyFileSync(found, path.join(WORK, FONT));
  } else if (CFG.drawtext) {
    log('No font found; set FONT=/path/to/font.ttf for banners and station-break text.');
    CFG.drawtext = false;
  }
}

let fileSeq = 0;

// Long filter graphs (the Guide channel's listings can run to hundreds of text items) go
// in a file instead of on the command line, which Windows caps at 32,767 characters.
let FILTER_FILE = 'script';             // 'slash' on ffmpeg 7+ (-/filter_complex file)
function filterOpt(opt, graph, files) {
  if (graph.length < 6000) return ['-' + opt, graph];
  const name = `fg${++fileSeq}.txt`;
  fs.writeFileSync(path.join(WORK, name), graph);
  files.push(name);
  if (FILTER_FILE === 'slash') return ['-/' + opt, name];
  return [opt === 'vf' ? '-filter_script:v' : '-filter_complex_script', name];
}
function textFile(text) {
  const name = `t${++fileSeq}.txt`;
  fs.writeFileSync(path.join(WORK, name), text);
  return name;
}

function wrap(text, width = 24) {
  return String(text).split('\n').map(line => {
    const out = []; let cur = '';
    for (const w of line.split(/\s+/)) {
      if (!w) continue;
      if (cur && (cur + ' ' + w).length > width) { out.push(cur); cur = w; }
      else cur = cur ? cur + ' ' + w : w;
    }
    out.push(cur);
    return out.join('\n');
  }).join('\n');
}

const hex = c => /^#?[0-9a-f]{6}$/i.test(c || '') ? '0x' + c.replace('#', '') : '0x1a1240';


function finalTransform(W, H, OW, OH, pic, padColor = 'black') {
  const p = pic || {};
  let f = '';
  if ((p.br || 0) !== 0 || (p.ct ?? 100) !== 100 || (p.sat ?? 100) !== 100)
    f += `,eq=brightness=${((p.br || 0) / 100).toFixed(3)}:contrast=${((p.ct ?? 100) / 100).toFixed(3)}:saturation=${((p.sat ?? 100) / 100).toFixed(3)}`;
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  const sw = even(OW * (p.pw ?? 100) / 100), sh = even(OH * (p.ph ?? 100) / 100);
  const dx = Math.round((p.px || 0) * OW / W), dy = Math.round((p.py || 0) * OH / H);
  // Exact 2x (or 1x) stretches use nearest-neighbour so pixel text stays sharp.
  const exact = sh === H && (sw === W || sw === 2 * W);
  if (sw !== W || sh !== H) f += `,scale=${sw}:${sh}:flags=${exact ? 'neighbor' : 'bicubic'}`;
  if (sw !== OW || sh !== OH || dx || dy) {
    // Centre on a black canvas with room to slide, then cut the output window out of it.
    const ax = Math.abs(dx), ay = Math.abs(dy);
    const PW = OW + 2 * ax, PH = OH + 2 * ay;
    f += `,pad=${PW}:${PH}:${Math.floor((PW - sw) / 2)}:${Math.floor((PH - sh) / 2)}:${padColor},crop=${OW}:${OH}:${ax - dx}:${ay - dy}`;
  }
  return f + ',setsar=1';
}

// ------------------------------------------------------------ picture framing
// Many archive.org copies have black bars baked in (a 4:3 show inside a 16:9 file, or a
// letterboxed film inside a 4:3 file), so on a 4:3 TV the picture ends up in a small
// box. Before a video plays, a few moments of it are checked with ffmpeg's cropdetect,
// and the bars are trimmed off. DVD-style files with non-square pixels (720x480) are
// also shown at their real shape. Results are kept in oompas-cache/framing.json.
const FRAMING_FILE = path.join(CFG.cacheDir, 'framing.json');
let FRAMING = {};
try { FRAMING = JSON.parse(fs.readFileSync(FRAMING_FILE, 'utf8')); } catch {}
const framingPending = new Map();
let framingSave = null;
const framingKey = url => String(url).replace(/[?#].*$/, '');
function saveFraming() {
  clearTimeout(framingSave);
  framingSave = setTimeout(() => {
    try { fs.mkdirSync(CFG.cacheDir, { recursive: true }); fs.writeFileSync(FRAMING_FILE, JSON.stringify(FRAMING)); } catch {}
  }, 3000);
  framingSave.unref?.();
}

function sampleFrame(url, at) {
  return new Promise(resolve => {
    const a = ['-hide_banner', '-nostdin'];
    if (/^https?:/i.test(url)) a.push('-reconnect', '1', '-rw_timeout', '10000000');
    a.push('-ss', Math.max(0, at).toFixed(2), '-i', url, '-t', '1.5', '-map', '0:v:0', '-an', '-sn',
           '-vf', 'cropdetect=limit=24:round=2:reset=0', '-f', 'null', '-');
    const p = spawn(CFG.ffmpeg, a, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-20000); });
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 15000);
    p.on('error', () => { clearTimeout(t); resolve(null); });
    p.on('close', () => {
      clearTimeout(t);
      const v = err.match(/Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b(?:[^\n]*?\[SAR (\d+):(\d+))?/);
      if (!v) return resolve(null);
      const crops = [...err.matchAll(/crop=(-?\d+):(-?\d+):(-?\d+):(-?\d+)/g)];
      const c = crops.length ? crops[crops.length - 1].slice(1).map(Number) : null;
      resolve({ w: +v[1], h: +v[2], sar: v[3] && +v[4] ? +v[3] / +v[4] : 1, audio: /Stream #[^\n]*Audio:/.test(err),
                crop: c && c[0] > 0 && c[1] > 0 ? { w: c[0], h: c[1], x: c[2], y: c[3] } : null });
    });
  });
}

// Checks a video's framing (once; later calls get the saved answer).
function detectFraming(url, seek = 0, dur = 0) {
  if (!url) return Promise.resolve(null);
  const key = framingKey(url);
  const known = FRAMING[key];
  const stale = known && ((known.failed && Date.now() - known.failed > 10 * 60000) || (known.partial && Date.now() - known.partial > 6 * 3600e3));
  if (known && !stale) return Promise.resolve(known.failed ? null : known);
  if (framingPending.has(key)) return framingPending.get(key);
  const at = dur > 20 ? [0.15, 0.45, 0.75].map(f => seek + dur * f) : [seek + Math.min(1, dur / 3)];
  const job = Promise.all(at.map(t => sampleFrame(url, t))).then(samples => {
    // A sample that decoded no frames (a network hiccup) says nothing; retry later.
    const ok = samples.filter(x => x && x.crop);
    if (!ok.length) { FRAMING[key] = { failed: Date.now() }; return null; }
    const { w, h, sar, audio } = ok[0];
    const crops = ok.map(x => x.crop);
    let crop = null;
    // Keep the largest picture any sample saw (so a dark scene can't over-trim), and
    // with only one usable sample be stricter.
    {
      const x0 = Math.min(...crops.map(c => c.x)), y0 = Math.min(...crops.map(c => c.y));
      const x1 = Math.max(...crops.map(c => c.x + c.w)), y1 = Math.max(...crops.map(c => c.y + c.h));
      const c = { x: x0, y: y0, w: Math.min(w - x0, x1 - x0) & ~1, h: Math.min(h - y0, y1 - y0) & ~1 };
      const big = c.w >= w * (crops.length > 1 ? 0.4 : 0.6) && c.h >= h * (crops.length > 1 ? 0.4 : 0.6);
      const worth = (w - c.w) >= w * 0.04 || (h - c.h) >= h * 0.04;
      if (big && worth) crop = c;
    }
    const r = { w, h, sar, crop, audio };
    if (ok.length < at.length) r.partial = Date.now();   // re-check another time
    FRAMING[key] = r;
    saveFraming();
    const name = decodeURIComponent(key.split('/').pop());
    log(`  framing: ${name} ${w}x${h}${sar !== 1 ? ` (pixel shape ${sar.toFixed(3)})` : ''}` +
        (crop ? ` · black bars trimmed to ${crop.w}x${crop.h}` : ' · no black bars'));
    return r;
  }).catch(() => null).finally(() => framingPending.delete(key));
  framingPending.set(key, job);
  return job;
}
// Waits for detectFraming, but never longer than ms.
const framingWithin = (plan, ms) => plan?.kind === 'media' && plan.url
  ? Promise.race([detectFraming(plan.url, plan.seek, plan.dur), new Promise(r => setTimeout(r, ms))])
  : Promise.resolve();

// The scale/pad part of a video's filter chain, fitting it to the W x H (4:3) canvas.
function mediaFit(url, W, H) {
  const even = v => Math.max(2, Math.round(v / 2) * 2);
  const fr = url ? FRAMING[framingKey(url)] : null;
  const tv = W / H;
  if (!fr || !fr.w) {
    // Not checked yet: at least correct the pixel shape.
    return `scale='trunc(iw*sar/2)*2':ih,setsar=1,scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=area,` +
           `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
  }
  const sar = fr.sar > 0 ? fr.sar : 1;
  const c = CFG.bars && fr.crop ? { ...fr.crop } : { w: fr.w, h: fr.h, x: 0, y: 0 };
  let aspect = c.w * sar / c.h;
  if (aspect > tv * 1.02 && CFG.widescreen !== 'fit') {
    const target = CFG.widescreen === 'fill' ? tv : Math.sqrt(aspect * tv);
    const nw = even(c.h * target / sar);
    c.x += Math.floor((c.w - nw) / 2); c.w = nw;
    aspect = nw * sar / c.h;
  }
  let sw, sh;
  if (aspect >= tv) { sw = W; sh = Math.min(H, even(W / aspect)); } else { sh = H; sw = Math.min(W, even(H * aspect)); }
  const crop = c.w !== fr.w || c.h !== fr.h ? `crop=${c.w}:${c.h}:${c.x}:${c.y},` : '';
  return `${crop}scale=${sw}:${sh}:flags=area,pad=${W}:${H}:${(W - sw) >> 1}:${(H - sh) >> 1}`;
}

// Fitting a live (IPTV) picture of unknown size onto the 4:3 canvas, with the
// Widescreen setting: fit (bars), zoom (trim the sides a little) or fill.
function liveFit(W, H) {
  const sq = `scale='trunc(iw*sar/2)*2':ih,setsar=1`;
  const tv = (W / H).toFixed(5);
  const crop = CFG.widescreen === 'fill' ? `,crop='trunc(min(iw,ih*${tv})/2)*2':ih`
    : CFG.widescreen === 'zoom' ? `,crop='trunc(min(iw,sqrt(iw*ih*${tv}))/2)*2':ih` : '';
  return `${sq}${crop},scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=area,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`;
}

// Evens out loudness between tapes, ads and the (much louder) station-break music:
// EBU R128 loudness normalisation with a true-peak limit, looking ~3 s ahead.
const LEVEL = () => CFG.normalize ? `,loudnorm=I=${CFG.loudness}:TP=-2:LRA=11,aresample=48000` : '';

// Builds the ffmpeg command for one segment. All segments share codecs, PIDs
// and a running timestamp offset so they concatenate into one smooth stream.
function segmentArgs(plan, tsOffset, banner, size) {
  // Everything is composed on a square-pixel 4:3 canvas (H*4/3 x H), then stretched to
  // the requested frame size. A 640x240 frame on a 4:3 CRT has 2:1 wide pixels.
  const OW = size?.w || CFG.width, OH = size?.h || CFG.height;
  const H = OH, W = Math.round(H * 4 / 3 / 2) * 2;
  const dur = plan.dur.toFixed(3);
  const a = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  const files = [];
  let vchain, achain;

  if (plan.kind === 'gen') {
    const gs = genSegment(plan, W, H, banner || plan.burst ? '10' : '0');
    a.push(...gs.inputs); files.push(...gs.files);
    vchain = gs.vchain; achain = gs.achain;
  } else if (plan.kind === 'media') {
    a.push('-re');
    // On tuning in, send 10 s ahead so the player has a reserve to ride out slow patches.
    if (BURST) a.push('-readrate_initial_burst', banner || plan.burst ? '10' : '0');
    if (/^https?:/i.test(plan.url)) {
      a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000');
      if (RECONNECT_MORE) a.push('-reconnect_on_network_error', '1', '-reconnect_on_http_error', '4xx,5xx');
    }
    a.push('-ss', Math.max(0, plan.seek).toFixed(3), '-t', dur, '-i', plan.url);
    a.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=48000:cl=stereo');
    vchain = `[0:v]${mediaFit(plan.url, W, H)},setsar=1,fps=${CFG.fps}` +
             // Tape grain changes every frame and eats bitrate; a light clean-up roughly
             // halves the stream with no visible loss on a CRT.
             (CFG.denoise && size?.denoise ? ',hqdn3d=1.5:1.5:4:4' : '') + ',format=yuv420p';
    // Mix with silence so every segment has an audio track even if the tape has none.
    // (A video with no sound track at all, like some silent films, just gets the silence.)
    const silent = FRAMING[framingKey(plan.url)]?.audio === false;
    achain = silent ? `[1:a]anull[a]`
      : `[0:a]aresample=48000,aformat=channel_layouts=stereo${LEVEL()}[ma];[ma][1:a]amix=inputs=2:duration=longest:normalize=0[a]`;
  } else if (plan.kind === 'live') {
    // IPTV: a live stream, transcoded (used when the app can't play the stream directly).
    if (/^https?:/i.test(plan.url)) a.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-rw_timeout', '20000000');
    if (plan.ua) a.push('-user_agent', plan.ua);
    if (plan.referrer) a.push('-headers', `Referer: ${plan.referrer}\r\n`);
    a.push('-re');   // real time, also for playlists that are really recordings
    if (BURST) a.push('-readrate_initial_burst', banner || plan.burst ? '10' : '0');
    a.push('-thread_queue_size', '1024', '-t', dur, '-i', plan.url);
    a.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=48000:cl=stereo');
    vchain = `[0:v]${liveFit(W, H)},setsar=1,fps=${CFG.fps},format=yuv420p`;
    achain = plan.silent ? `[1:a]anull[a]`
      : `[0:a]aresample=48000:async=1,aformat=channel_layouts=stereo${LEVEL()}[ma];[ma][1:a]amix=inputs=2:duration=longest:normalize=0[a]`;
  } else {
    const color = plan.kind === 'standby' ? '0x000000' : hex(plan.color);
    a.push('-re');
    if (BURST) a.push('-readrate_initial_burst', banner || plan.burst ? '10' : '0');
    a.push('-f', 'lavfi', '-i', `color=c=${color}:s=${W}x${H}:r=${CFG.fps}:d=${dur}`);
    if (plan.kind === 'card' && plan.audioUrl) {
      a.push('-ss', Math.max(0, plan.audioSeek).toFixed(3), '-t', dur, '-i', plan.audioUrl);
      achain = `[1:a]aresample=48000,aformat=channel_layouts=stereo${LEVEL()},apad=whole_dur=${dur}[a]`;
    } else {
      a.push('-f', 'lavfi', '-t', dur, '-i', 'anullsrc=r=48000:cl=stereo');
      achain = `[1:a]anull[a]`;
    }
    vchain = `[0:v]format=yuv420p`;
    if (CFG.drawtext) {
      const cards = plan.kind === 'standby'
        ? [{ text: 'PLEASE STAND BY', start: 0, end: plan.dur * 1000 }]
        : plan.cards.map(c => ({ ...c, start: c.start - plan.offset * 1000, end: c.end - plan.offset * 1000 }));
      for (const c of cards) {
        if (c.end <= 0) continue;
        const big = plan.kind === 'standby';
        const tf = textFile(wrap(c.text, big ? 15 : Math.floor(260 / UI.cw))); files.push(tf);
        vchain += ',' + dt(tf, big ? UI.big : UI.body, 'white', '(w-text_w)/2', '(h-text_h)/2') +
                  `:line_spacing=${UI.pixel ? 3 : 6}:shadowcolor=black@0.6:shadowx=2:shadowy=2:` +
                  `enable='between(t,${(c.start / 1000).toFixed(2)},${(c.end / 1000).toFixed(2)})'`;
      }
    }
  }

  vchain += finalTransform(W, H, OW, OH) + '[v]';
  a.push(...filterOpt('filter_complex', `${vchain};${achain}`, files), '-map', '[v]', '-map', '[a]', '-t', dur);
  a.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-maxrate', '6000k', '-bufsize', '6000k',
         '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-g', '60', '-keyint_min', '30', '-bf', '2');
  a.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  a.push('-f', 'mpegts', '-mpegts_service_id', '1', '-mpegts_pmt_start_pid', '4096', '-mpegts_start_pid', '256',
         '-output_ts_offset', tsOffset.toFixed(3), '-muxdelay', '0', '-muxpreload', '0', 'pipe:1');
  return { args: a, files };
}

// Starts one segment. Output is buffered until `attach` is called, so the
// next program can spin up a few seconds early without gaps.
function startSegment(plan, tsOffset, banner, size) {
  const { args, files } = segmentArgs(plan, tsOffset, banner, size);
  const proc = spawn(CFG.ffmpeg, args, { cwd: WORK, windowsHide: true });
  const seg = { plan, proc, args, bytes: 0, chunks: [], sink: null, err: '', startedAt: now() };
  proc.stdout.on('data', d => {
    seg.bytes += d.length;
    if (seg.sink) { if (!seg.sink.write(d)) { proc.stdout.pause(); seg.sink.once('drain', () => proc.stdout.resume()); } }
    else seg.chunks.push(d);
  });
  proc.stderr.on('data', d => { seg.err = (seg.err + d).slice(-2000); });
  seg.done = new Promise(res => proc.on('close', code => {
    for (const f of files) fs.rm(path.join(WORK, f), { force: true }, () => {});
    res(code);
  }));
  seg.attach = sink => { seg.sink = sink; for (const c of seg.chunks) sink.write(c); seg.chunks = []; };
  // Destroy the output pipe too: if the viewer had stopped reading, it is paused, and a
  // paused pipe never closes, so 'close' (seg.done) would never fire and the stream would
  // hang around as a phantom viewer ("2 streams to 1 TV").
  seg.kill = () => { try { proc.stdout.destroy(); proc.stderr.destroy(); } catch {} try { proc.kill('SIGKILL'); } catch {} };
  return seg;
}


// ------------------------------------------------------------ TV guide
// Cable-style guide frames, drawn by ffmpeg.

const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };

// Program colours, cable-guide style: shows in blue, movies in purple (faded, to suit the look).
const KIND = { show: '0x2c5d94', movie: '0x6b4f9e', showSel: '0x3c74b3', movieSel: '0x8564bb' };
const isMovie = p => !!p && (p.category === 'Movie' || (!p.category && !p.isBlock && !(p.eps?.length > 1) && p.endMs - p.startMs >= 75 * 60000));
const kindColour = (p, sel) => isMovie(p) ? (sel ? KIND.movieSel : KIND.movie) : (sel ? KIND.showSel : KIND.show);

// "Afternoon Action · Anime · 1985" and "Now: Robotech · Ep 5 – Booby Trap" for a listing.
const kindLine = p => [p?.isBlock ? '' : p?.block, p?.category, p?.year].filter(Boolean).join(' \u00b7 ');
// The synopsis of what's on now (of the current episode or tape, inside a run or block).
function aboutLine(p, at) {
  if (!p) return '';
  const ep = p.eps?.find(e => e.startMs <= at && e.endMs > at) || p.eps?.[0];
  return (ep && ep.desc) || p.desc || '';
}
function nowLine(p, at) {
  if (!p) return '';
  const many = p.eps?.length > 1;
  const ep = (many && (p.eps.find(e => e.startMs <= at && e.endMs > at) || p.eps.find(e => e.startMs > at))) || p.eps?.[0];
  if (!ep) return p.sub || '';
  if (p.isBlock) return `Now: ${ep.title}`;
  if (p.series) {
    const what = [ep.num != null ? `Ep ${ep.num}` : '', ep.sub].filter(Boolean).join(' \u2013 ') || ep.title;
    return many ? `Now: ${what} (${p.eps.indexOf(ep) + 1} of ${p.eps.length})` : what;
  }
  return p.sub || '';
}

// Every show in [from, until); station breaks are folded into the show before them.
async function programsBetween(bc, channel, from, until) {
  if (channel.kind === 'iptv') return bc.iptv ? bc.iptv.programs(channel, from, until) : [];
  if (channel.kind === 'youtube') return bc.youtube ? bc.youtube.programs(channel, from, until) : [];
  if (!channel.playlist) {
    if (channel.kind === 'guide' || channel.kind === 'weather') {
      const step = channel.kind === 'guide' ? 1800000 : 3600000, out = [];
      for (let t = Math.floor(from / step) * step; t < until; t += step)
        out.push({ key: `${channel.kind}@${t}`, title: channel.kind === 'guide' ? 'Listings & previews' : 'Your local forecast', year: '', startMs: t, endMs: t + step });
      return out;
    }
    return bc.oompas ? bc.oompas.programsBetween(channel.dial, from, until) : [];
  }
  const { resolveAt } = bc.engine;
  const out = [];
  let cursor = from;
  for (let i = 0; cursor < until && i < 600; i++) {
    const pos = resolveAt(channel.playlist, cursor);
    if (pos.endMs <= cursor) break;
    const last = out[out.length - 1];
    if (pos.item.type === 'video') {
      if (!last || last.key !== pos.key)
        out.push({ key: pos.key, title: bc.title(pos.item), year: pos.item.year || '', startMs: pos.startMs, endMs: pos.endMs });
    } else if (last) last.endMs = pos.endMs;
    else out.push({ key: 'break', title: 'Station break', startMs: pos.startMs, endMs: pos.endMs });
    cursor = pos.endMs;
  }
  return out;
}

// OOMPAS BOX guide: classic cable listings layout, black with rainbow accents.
// Top left: what's on the highlighted channel. Top right: a picture of the channel
// you're watching. Below: two-line grid rows. Designed on a 320x240 canvas.
const fmtShort = ms => { const d = new Date(ms); const h = d.getHours() % 12 || 12;
                         return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'a' : 'p'}`; };
// Cable-style call sign, 3-4 letters: "COMPUTER CHRONICLES" -> "CMCH",
// "LATE NIGHT LOUNGE" -> "LNL", "CARTOONS" -> "CRTN".
const squash = w => (w[0] + w.slice(1).replace(/[AEIOU]/g, '')).replace(/(.)\1+/g, '$1');
function callSign(name) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !['THE', 'A', 'AN', 'OF', 'AND'].includes(w));
  if (!words.length) return '';
  if (words.length >= 3) return words.slice(0, 4).map(w => w[0]).join('');
  if (words.length === 2) return squash(words[0]).slice(0, 2) + squash(words[1]).slice(0, 2);
  return squash(words[0]).slice(0, 4);
}

// Shared drawing helpers for one ffmpeg frame on a 240-line layout scaled by k.
function painter(k) {
  const px = v => Math.round(v * k);
  const files = [], parts = [];
  const P = {
    px, files, parts,
    text(t, x, y, size, color) {             // size: 'body' | 'big' | 'logo'
      const f = textFile(t); files.push(f);
      const font = size === 'logo' ? UI.logo : FONT;
      const fs_ = Math.round((size === 'logo' ? UI.logoSize : size === 'big' ? UI.big : UI.body) * k);
      parts.push(dt(f, fs_, color, typeof x === 'number' ? px(x) : x, typeof y === 'number' ? px(y) : y, font));
    },
    box(x, y, w, h, color, t = 'fill') {
      if (w > 0 && h > 0) parts.push(`drawbox=x=${px(x)}:y=${px(y)}:w=${px(w)}:h=${px(h)}:color=${color}:t=${t}`);
    },
    fit: w => Math.max(1, Math.floor(w / UI.cw)),
    clipW: (t, w) => clipPx(t, w),
    wrapW: (t, w, n) => wrapPx(t, w, n),
    lines(arr, x, y, color) { arr.forEach((ln, i) => { if (ln) P.text(ln, x, y + i * UI.line, 'body', color); }); },
    rainbow(x, y, w, h) {                    // horizontal bar in seven bands
      RAINBOW.forEach((c, i) => P.box(x + Math.round(i * w / 7), y, Math.round((i + 1) * w / 7) - Math.round(i * w / 7), h, c));
    },
    logo(t, x, y) {                          // one colour per letter
      const step = UI.logo === 'logo.ttf' ? 8 : 7;
      [...t].forEach((ch, i) => { if (ch !== ' ') P.text(ch, x + i * step, y, 'logo', RAINBOW[i % 7]); });
    },
  };
  return P;
}

// RGBA bytes -> PNG (for previewing the banner in a browser).
function renderFrame(p, W, H, bg, outW, outH, format, pic, canvasOnly, image) {
  const clear = bg === 'transparent';
  const tail = canvasOnly ? '' : finalTransform(W, H, outW, outH, pic, clear ? 'black@0' : 'black');
  const out = format === 'png' ? ['-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'] : ['-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
  // bg: a colour, or { file } for a picture to draw on.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin',
                ...(typeof bg === 'object' ? ['-i', bg.file] : ['-f', 'lavfi', '-i', clear ? `color=c=black@0:s=${W}x${H}:d=1,format=rgba` : `color=c=${bg}:s=${W}x${H}:d=1`])];
  if (typeof bg === 'object') p.parts.unshift(`scale=${W}:${H}:flags=bicubic,format=rgb24`);
  if (!p.parts.length) p.parts.push('null');
  if (image) {
    args.push('-i', image.file, ...filterOpt('filter_complex',
      `[0:v]${p.parts.join(',')}[bg];[1:v]scale=${image.w}:${image.h}:flags=area,setsar=1[im];[bg][im]overlay=${image.x}:${image.y}${tail}[o]`, p.files),
      '-map', '[o]', '-frames:v', '1', ...out);
  } else args.push(...filterOpt('vf', p.parts.join(',') + tail, p.files), '-frames:v', '1', ...out);
  return new Promise((resolve, reject) => {
    const proc = spawn(CFG.ffmpeg, args, { cwd: WORK, windowsHide: true });
    const chunks = []; let err = '';
    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      for (const f of p.files) fs.rm(path.join(WORK, f), { force: true }, () => {});
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('render failed: ' + err.trim().split('\n').pop()));
    });
  });
}

// ------------------------------------------------- Guide & Weather channels
// Drawn live on the PC: drifting clouds (and rain) on a pastel sky, a slow colour
// drift, tape softness, display fonts, and a music bed. The Guide scrolls listings
// for every channel; Weather loops pages of made-up forecasts, refreshed on the 8s.

const GEN = { ok: false, chroma: false, tracks: [] };

function ff(args) {
  const r = spawnSync(CFG.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd: WORK, encoding: 'utf8' });
  if (r.status !== 0) throw new Error((r.stderr || '').trim().split('\n').pop() || 'ffmpeg failed');
}

// The scene behind Guide and Weather: a cloud ceiling drifting toward you out of a
// horizon that sits a little off-centre and a little tilted, over a pale pool-tile floor
// that slides toward you too, with haze where they meet. Pastel blues and teals, faded.
// The perspective is precomputed as lookup maps for ffmpeg's remap filter.
const SCENES = {
  guide:   { hy: 106, cx: 84, tilt: 1.4 },     // vanishing point left of centre, behind the listings header
  weather: { hy: 201, cx: 206, tilt: -1.0 },   // low and right, under the forecast panel
};
function writePgm(file, w, h, f) {
  const buf = Buffer.alloc(w * h * 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(f(x, y)))), (y * w + x) * 2);
  fs.writeFileSync(path.join(WORK, file), Buffer.concat([Buffer.from(`P5\n${w} ${h}\n65535\n`), buf]));
}
function makeScene(name, sc) {
  const W = 320, H = 240, S = 512, F = 320, OUT = 65535, tan = Math.tan(sc.tilt * Math.PI / 180);
  const yh = x => sc.hy + (x - sc.cx) * tan, mod = (a, n) => ((a % n) + n) % n;
  const sky = (x, y, ax) => { const d = yh(x) - y; if (d < 0.8) return OUT; const z = 60 * F / d;
                               return ax ? mod(S / 2 + 97 + (x - sc.cx) * z / F, S) : mod(z, S); };
  const floor = (x, y, ax) => { const d = y - yh(x); if (d < 0.8) return OUT; const z = 40 * F / d;
                                 return ax ? mod(S / 2 + 31 + (x - sc.cx) * z / F, S) : mod(-z, S); };
  writePgm(`gen_${name}_sx.pgm`, W, H, (x, y) => sky(x, y, 1));
  writePgm(`gen_${name}_sy.pgm`, W, H, (x, y) => sky(x, y, 0));
  writePgm(`gen_${name}_fx.pgm`, W, H, (x, y) => floor(x, y, 1));
  writePgm(`gen_${name}_fy.pgm`, W, H, (x, y) => floor(x, y, 0));
  const HY = `(${sc.hy}+(X-${sc.cx})*${tan.toFixed(5)})`;
  // Sky: soft blue overhead fading to near-white at the horizon.
  ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1,format=rgb24,geq=` +
      `r='if(lt(Y,${HY}),236-(236-122)*pow(1-Y/${HY},1.4),222)':g='if(lt(Y,${HY}),247-(247-180)*pow(1-Y/${HY},1.4),238)':` +
      `b='if(lt(Y,${HY}),248-(248-214)*pow(1-Y/${HY},1.4),236)'`, '-frames:v', '1', `gen_${name}_sky.png`]);
  // Haze along the horizon, brightest at the vanishing point.
  ff(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:d=1,format=rgba,geq=r=246:g=252:b=251:` +
      `a='min(255,235*exp(-abs(Y-${HY})/if(lt(Y,${HY}),22,11))+150*exp(-hypot((X-${sc.cx})/3,Y-${HY})/26))'`, '-frames:v', '1', `gen_${name}_haze.png`]);
}
// Filter graph for a scene at W x H, time offset O (seconds). Inputs are numbered from i0.
function sceneGraph(name, W, H, i0, fps, O) {
  const inputs = [`gen_${name}_sky.png`, 'gen_ctile.png', `gen_${name}_sx.pgm`, `gen_${name}_sy.pgm`,
                  'gen_ftile.png', `gen_${name}_fx.pgm`, `gen_${name}_fy.pgm`, `gen_${name}_haze.png`];
  const n = i => i0 + i, sc = (W !== 320 || H !== 240) ? `,scale=${W}:${H}` : '';
  const graph =
    `[${n(0)}:v]scale=${W}:${H},setsar=1,format=rgb24[sbg];` +
    `[${n(1)}:v]crop=512:512:0:'512-mod((t+${O})*22,512)',format=rgba[scs];[scs][${n(2)}:v][${n(3)}:v]remap=fill=black@0,format=rgba${sc}[scl];` +
    `[${n(4)}:v]crop=512:512:0:'mod((t+${O})*30,512)',format=rgba[sfs];[sfs][${n(5)}:v][${n(6)}:v]remap=fill=black@0,format=rgba${sc}[sfl];` +
    `[${n(7)}:v]scale=${W}:${H},format=rgba[shz];` +
    `[sbg][sfl]overlay[ss0];[ss0][scl]overlay[ss1];[ss1][shz]overlay,setsar=1[ss2];`;
  return { inputs, graph, out: 'ss2' };
}

function setupGen() {
  try {
    const filters = spawnSync(CFG.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout || '';
    GEN.chroma = /\bchromashift\b/.test(filters);
    // Textures, pre-tiled 2x2 so they can scroll without seams: soft white clouds, pool tiles.
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=16x16,format=gray,noise=alls=100:allf=u:all_seed=3,scale=256:256:flags=bicubic',
        '-f', 'lavfi', '-i', 'color=c=gray:s=48x48,format=gray,noise=alls=100:allf=u:all_seed=4,scale=256:256:flags=bicubic',
        '-filter_complex', "[0][1]blend=all_expr='A*0.7+B*0.3',lutyuv=y='clip((val-112)*2.4,0,235)',split[a][b];[b]hflip[bh];[a][bh]hstack,split[c][d];[d]vflip[dv];[c][dv]vstack," +
        'split[e][f];[e][f]hstack,split[g][h];[g][h]vstack[m];color=c=white:s=1024x1024:d=1,format=rgba[w];[w][m]alphamerge', '-frames:v', '1', 'gen_ctile.png']);
    ff(['-f', 'lavfi', '-i', "color=c=black:s=512x512:d=1,format=rgb24,geq=" +
        "r='if(lt(mod(X,32),2)+lt(mod(Y,32),2),150,if(eq(mod(floor(Y/32),8),3),118,226)*(0.95+0.05*abs(mod(sin(floor(X/32)*12.9898+floor(Y/32)*78.233)*43758.5453,1))))':" +
        "g='if(lt(mod(X,32),2)+lt(mod(Y,32),2),205,if(eq(mod(floor(Y/32),8),3),196,240)*(0.95+0.05*abs(mod(sin(floor(X/32)*12.9898+floor(Y/32)*78.233)*43758.5453,1))))':" +
        "b='if(lt(mod(X,32),2)+lt(mod(Y,32),2),205,if(eq(mod(floor(Y/32),8),3),200,238)*(0.95+0.05*abs(mod(sin(floor(X/32)*12.9898+floor(Y/32)*78.233)*43758.5453,1))))'," +
        'format=rgba,split[a][b];[a][b]hstack,split[c][d];[c][d]vstack', '-frames:v', '1', 'gen_ftile.png']);
    for (const [name, sc] of Object.entries(SCENES)) makeScene(name, sc);
    // Rain: sparse streaks in a strip twice the height, scrolled downward.
    ff(['-f', 'lavfi', '-i', 'color=c=black:s=320x240,format=gray,noise=alls=100:allf=u:all_seed=5',
        '-filter_complex', "[0:v]lutyuv=y='if(gt(val,248),255,0)',gblur=sigma=0.4:sigmaV=8,lutyuv=y='clip(val*16,0,190)',split[a][b];[a][b]vstack[m];" +
        'color=c=0xe6f0ff:s=320x480:d=1,format=rgba[w];[w][m]alphamerge', '-frames:v', '1', 'gen_rain.png']);
    // Radar: rings on a dark disc; and a sweep line with a fading wedge.
    ff(['-f', 'lavfi', '-i', "color=c=black:s=130x130:d=1,format=rgba,geq=" +
        "r='if(lt(abs(mod(hypot(X-65,Y-65),21)-10),0.8)+lt(abs(X-65),0.6)+lt(abs(Y-65),0.6),159,20)':" +
        "g='if(lt(abs(mod(hypot(X-65,Y-65),21)-10),0.8)+lt(abs(X-65),0.6)+lt(abs(Y-65),0.6),246,12)':" +
        "b='if(lt(abs(mod(hypot(X-65,Y-65),21)-10),0.8)+lt(abs(X-65),0.6)+lt(abs(Y-65),0.6),255,51)':" +
        "a='if(lt(hypot(X-65,Y-65),64),190,0)'", '-frames:v', '1', 'gen_radar.png']);
    ff(['-f', 'lavfi', '-i', "color=c=black:s=130x130:d=1,format=rgba,geq=r=160:g=255:b=255:" +
        "a='if(lt(hypot(X-65,Y-65),63),if(lt(abs(Y-65),1)*gt(X,65),230,if(between(atan2(Y-65,X-65),0,0.7),110*(1-atan2(Y-65,X-65)/0.7),0)),0)'",
        '-frames:v', '1', 'gen_sweep.png']);
    // Stills of each scene (the browser guide's background, and the guide's picture box).
    for (const name of Object.keys(SCENES)) {
      const sg = sceneGraph(name, 320, 240, 0, '7.3', 0);
      ff([...sg.inputs.flatMap(f => ['-i', f]), '-filter_complex', sg.graph + `[${sg.out}]null`, '-frames:v', '1', `gen_still_${name}.png`]);
    }
    fs.copyFileSync(path.join(WORK, 'gen_still_guide.png'), path.join(WORK, 'gen_guidebg.png'));
    if (process.env.GUIDE_BG) fs.copyFileSync(process.env.GUIDE_BG, path.join(WORK, 'gen_guidebg.png'));
    GEN.ok = true;
  } catch (e) { log('Guide/Weather art could not be made (' + e.message + '); those channels will show a plain card'); }
  // Your own music for the Guide and Weather channels: drop files into pc-server/music.
  try {
    for (const f of fs.readdirSync(CFG.musicDir).filter(f => /\.(mp3|wav|flac|ogg|m4a|aac|opus)$/i.test(f)).sort()) {
      const file = path.join(CFG.musicDir, f);
      const r = spawnSync(CFG.ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
      const m = (r.stderr || '').match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
      const dur = m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0;
      if (dur > 5) GEN.tracks.push({ file, dur });
    }
    if (GEN.tracks.length) log(`Guide/Weather music: ${GEN.tracks.length} tracks from ${CFG.musicDir}`);
  } catch {}
}

// A soft, slow chord pad for when there's no music folder: four seventh chords, each
// swelling in and out over eight seconds, with echo. Two different progressions.
const PADS = {
  guide: [[174.61, 220, 261.63, 329.63], [164.81, 196, 246.94, 293.66], [146.83, 174.61, 220, 261.63], [130.81, 164.81, 196, 246.94]],
  weather: [[138.59, 174.61, 207.65, 261.63], [130.81, 155.56, 196, 233.08], [116.54, 138.59, 174.61, 207.65], [103.83, 130.81, 155.56, 196]],
};
function padExpr(chords, off) {
  const T = `(t+${off.toFixed(2)})`;
  const f = v => `if(eq(ld(0),0),${chords[0][v]},if(eq(ld(0),1),${chords[1][v]},if(eq(ld(0),2),${chords[2][v]},${chords[3][v]})))`;
  return `st(0,mod(floor(${T}/8),4));st(1,sin(PI*mod(${T},8)/8));ld(1)*ld(1)*0.12*(` +
    `sin(2*PI*${f(0)}*${T})+sin(2*PI*${f(1)}*${T}*1.003)+sin(2*PI*${f(2)}*${T})+0.7*sin(2*PI*${f(3)}*${T}*0.997))`;
}

const TOWNS = ['Lower Halcyon', 'Mallgrove', 'Port Vellum', 'East Sunder', 'Glasswater', 'New Dawning', 'Fernhollow', 'Quiet Basin',
  'Pastel Springs', 'Hollow Pines', 'Little Static', 'Nowhere Junction', 'Lakeview Plaza', 'Saint Lumen', 'Velvet Ridge', 'Echo Falls'];
const CONDS = [['pink drizzle, softly', 'drizzle', 1], ['mostly cloudy, humming', 'cloudy', 0], ['lavender haze', 'haze', 0],
  ['light rain on glass', 'rain', 1], ['fog over the mall', 'fog', 0], ['clear, for now', 'clear-ish', 0], ['rain, then the same rain', 'rain', 1],
  ['overcast and very still', 'still', 0], ['warm static', 'static', 0], ['showers somewhere else', 'elsewhere', 0], ['a fine mist of nothing', 'mist', 1]];
const WINDS = ['W 3, then nothing', 'calm, mostly', 'SE 2 and drifting', 'from the parking lot', 'N 4, remembering', 'none to speak of'];
const TICKER = ['The mall will reopen', 'Please remain where you are', 'Tomorrow will be very similar', 'No echoes detected in your area',
  'The fountain is running again', 'Visibility improving somewhere', 'Thank you for watching the weather', 'It is still raining in Mallgrove',
  'Your area remains your area', 'The forecast has been the same since you arrived'];

// Made-up weather for a 10-minute slot, steady within the hour.
function weatherFor(startMs) {
  const hourMs = Math.floor(startMs / 3600000) * 3600000;
  const R = rng(hash32('wx' + hourMs));
  const pick = a => a[Math.floor(R() * a.length)];
  const h = new Date(startMs).getHours();
  const base = 57 + 9 * Math.sin(2 * Math.PI * (h - 9) / 24);
  const temp = d => Math.round(base + d + R() * 6 - 3);
  const cond = pick(CONDS);
  const town = TOWNS[hash32('town' + startMs) % TOWNS.length];
  const others = TOWNS.filter(t => t !== town).sort(() => R() - 0.5).slice(0, 6);
  const hi = temp(6), lo = temp(-9);
  return {
    town, temp: temp(0), cond: cond[0], rain: !!cond[2],
    stats: [`Humidity    ${80 + Math.floor(R() * 19)}%`, `Wind        ${pick(WINDS)}`, `Pressure    ${(29.6 + R() * 0.6).toFixed(2)} and settling`, `Visibility  mostly`],
    region: others.map(t => ({ town: t, temp: temp(R() * 8 - 4), cond: pick(CONDS)[1] })),
    days: [{ name: 'TONIGHT', hi: lo, lo: lo - 3, cond: pick(CONDS)[0] }, { name: 'TOMORROW', hi, lo, cond: 'the same' },
           { name: 'LATER', hi: hi - 1, lo: lo + 1, cond: pick(CONDS)[0] }],
    almanac: [`Sunrise     6:${String(10 + Math.floor(R() * 49)).padStart(2, '0')} am`, `Sunset      5:${String(Math.floor(R() * 59)).padStart(2, '0')} pm`,
              'Moon        waning, mostly', `Pollen      ${pick(['soft', 'low', 'faint', 'drifting'])}`, `UV index    ${pick(['dreaming', '0', 'unclear', 'gentle'])}`,
              `Tides       ${pick(['receding politely', 'holding', 'somewhere'])}`],
    ticker: [...TICKER].sort(() => R() - 0.5).slice(0, 5).join('   •   ') + '   •   ',
  };
}

const ADS = ['mallgrove fountain court · open late, forever', 'port vellum video · rewinding is free', 'glasswater waterbeds · sleep somewhere else',
  'halcyon plaza food court · now seating no one', 'east sunder skate · couples skate all night', 'little static tv & radio · we fix what you remember',
  'fernhollow travel · tickets to the same place', 'quiet basin motor inn · color tv in every room', 'velvet ridge cinema · every seat faces the screen'];

// Listings strip for the Guide channel: every channel, three half-hour columns.
const guideCache = new Map();
function guideAssets(bc, startMs, self) {
  const key = String(startMs);
  if (guideCache.has(key)) return guideCache.get(key);
  const pr = (async () => {
    const chans = (await bc.lineup()).channels.filter(c => c.id !== self.id);
    const until = startMs + 3 * 1800000;
    const progs = await Promise.all(chans.map(async c => {
      try { return await programsBetween(bc, await bc.channel(c.id), startMs, until); } catch { return []; }
    }));
    const P = painter(1);
    const L = UI.line, rowH = 2 * L + 2, cw = 46, gx0 = cw + 2, gw = 318 - gx0;
    const xOf = ms => gx0 + Math.round((Math.max(startMs, Math.min(until, ms)) - startMs) / (until - startMs) * gw);
    const rows = [];
    chans.forEach((c, i) => { rows.push({ c, i, progs: progs[i] }); if (i % 6 === 5) rows.push({ ad: ADS[(Math.floor(startMs / 1800000) + i) % ADS.length] }); });
    rows.forEach((r, n) => {
      const y = n * (rowH + 1);
      if (r.ad) {
        P.box(0, y, 320, rowH, '0x0e3f4a');
        const f = textFile(r.ad); P.files.push(f);
        P.parts.push(dt(f, 10, '0xffd3e0', '(w-text_w)/2', y + 6, fx('majormono')));
        return;
      }
      P.box(0, y, 320, rowH, n % 2 ? '0x1b6a78' : '0x145866');
      P.box(0, y, cw, rowH, PASTEL[r.i % 7]);
      const cc = `${cw / 2}-text_w/2`;
      P.text(String(r.c.dial), cc, y + 1, 'body', '0x0e4a57');
      P.text(r.c.call || callSign(r.c.name), cc, y + 1 + L, 'body', '0x0e4a57');
      for (const pg of r.progs) {
        const x0 = xOf(pg.startMs), x1 = xOf(pg.endMs), w = x1 - x0 - 1;
        if (w < 3) continue;
        P.box(x0, y, w, rowH, kindColour(pg, false));
        P.box(x0, y, 1, rowH, '0x3d8a96');
        if (w < 28) continue;            // too narrow to label (a run of short music videos, say)
        const lines = wrapPx(pg.title, w - 6, 2);
        const yy = lines.length === 1 ? y + Math.floor((rowH - L) / 2) : y + 1;
        lines.forEach((ln, j) => P.text(ln, x0 + 3, yy + j * L, 'body', 'white'));
      }
    });
    const H = Math.max(1, rows.length) * (rowH + 1);
    const png = await renderFrame(P, 320, H, '0x0e4a57', 320, H, 'png', null, true);
    const file = `gen_list_${key}.png`;
    fs.writeFileSync(path.join(WORK, file), png);
    // Promos: one upcoming show per channel, soonest first.
    const promos = [];
    chans.forEach((c, i) => {
      const next = progs[i].find(p => p.startMs > startMs && p.startMs < until) || (c.oompas && progs[i][0]);
      if (next && next.title) promos.push({ at: next.startMs, dial: c.dial, call: c.call || callSign(c.name), title: next.title,
                                            desc: [next.block, next.category].filter(Boolean).join(' \u00b7 ') || c.description || '' });
    });
    promos.sort((a, b) => a.at - b.at || a.dial - b.dial);
    return { file, h: H, promos: promos.slice(0, 10), times: [0, 1, 2].map(i => startMs + i * 1800000) };
  })();
  guideCache.set(key, pr);
  pr.catch(() => guideCache.delete(key));
  for (const k of guideCache.keys()) if (guideCache.size > 3 && k !== key) {
    guideCache.get(k).then(g => fs.rm(path.join(WORK, g.file), { force: true }, () => {})).catch(() => {});
    guideCache.delete(k);
  }
  return pr;
}

async function genPlan(bc, channel, at) {
  const kind = channel.kind, slot = kind === 'guide' ? 1800000 : 600000, shift = kind === 'weather' ? 8 * 60000 : 0;
  const startMs = Math.floor((at - shift) / slot) * slot + shift, endMs = startMs + slot;
  const plan = { key: `${kind}@${startMs}`, type: 'gen', kind: 'gen', gen: kind, color: channel.color, year: '',
                 title: kind === 'guide' ? 'Listings & previews' : 'Your local forecast',
                 startMs, endMs, dur: (endMs - at) / 1000, offset: (at - startMs) / 1000 };
  if (!GEN.ok || !CFG.drawtext) return { ...plan, kind: 'card', cards: [{ text: `${channel.name.toUpperCase()}\n\n${plan.title}`, start: 0, end: slot }], audioUrl: '' };
  if (kind === 'guide') plan.guide = await guideAssets(bc, startMs, channel);
  else plan.wx = weatherFor(startMs);
  return plan;
}

// ffmpeg inputs and filters for one Guide/Weather segment on a W x H canvas.
function genSegment(plan, W, H, burst) {
  const k = H / 240, K = v => Math.round(v * k), O = plan.offset.toFixed(3);
  const a = [], files = [];
  const input = (...args) => { a.push('-re'); if (BURST) a.push('-readrate_initial_burst', burst); a.push(...args); };
  let n = 0;
  const img = f => { input('-framerate', CFG.fps, '-loop', '1', '-i', f); return n++; };
  const sc = k !== 1 ? `scale=iw*${k}:ih*${k}:flags=bicubic,` : '';
  const T = (txt, font, size, color, x, y, extra = '') => {
    const f = textFile(txt); files.push(f);
    return `drawtext=fontfile=${font}:expansion=none:textfile=${f}:fontsize=${K(size)}:fontcolor=${color}:` +
           `x=${typeof x === 'number' ? K(x) : x}:y=${typeof y === 'number' ? K(y) : y}${extra}`;
  };
  const clock = (font, size, color, x, y) => {
    const f = textFile('%{localtime:%I\\:%M %p}'); files.push(f);
    return `drawtext=fontfile=${font}:expansion=normal:textfile=${f}:fontsize=${K(size)}:fontcolor=${color}:x=${x}:y=${K(y)}`;
  };
  const clip = (t, n) => { t = String(t || ''); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
  const glow = ':shadowcolor=0x0b3640@0.7:shadowx=2:shadowy=2';

  const scene = sceneGraph(plan.gen, W, H, 0, CFG.fps, O);
  scene.inputs.forEach(f => img(f));
  let g = scene.graph;
  let cur = scene.out;
  const rain = plan.gen === 'weather' && plan.wx.rain;
  if (rain) {
    const iR = img('gen_rain.png');
    g += `[${iR}:v]${sc}crop=${W}:${H}:x=0:y='${H}-mod((t+${O})*${K(170)},${H})'[grn];[${cur}][grn]overlay[gs2];`; cur = 'gs2';
  }
  const d = [];   // drawing on top, in order

  if (plan.gen === 'guide') {
    const G = plan.guide, Y0 = 114, VH = 240 - Y0, copies = Math.max(2, Math.ceil(VH / G.h) + 1);
    const iL = img(G.file);
    const labels = Array.from({ length: copies }, (_, i) => `[gl${i}]`).join('');
    g += `[${iL}:v]${k !== 1 ? `scale=iw*${k}:ih*${k}:flags=neighbor,` : ''}format=rgba,colorchannelmixer=aa=0.9,split=${copies}${labels};` +
         `${labels}vstack=inputs=${copies},crop=${W}:${K(VH)}:0:'mod((t+${O})*${K(11)},${K(G.h)})'[glist];[${cur}][glist]overlay=0:${K(Y0)}[gs3];`;
    cur = 'gs3';
    d.push(T('OOMPAS BOX', fx('shrikhand'), 22, '0xffffff', 12, 5, glow));
    d.push(T('THE GUIDE', fx('vt323'), 16, '0x0e4a57', 14, 38));
    d.push(clock(fx('vt323'), 20, '0x0e4a57', `w-text_w-${K(12)}`, 8));
    // Promo panel: one upcoming show at a time.
    d.push(`drawbox=x=${K(118)}:y=${K(34)}:w=${K(190)}:h=${K(68)}:color=0x0e4a57@0.55:t=fill`, `drawbox=x=${K(118)}:y=${K(34)}:w=${K(190)}:h=${K(2)}:color=0xc6f4ef:t=fill`);
    const promos = G.promos.length ? G.promos : [{ at: plan.startMs, dial: '', call: '', title: 'Stay tuned', desc: 'Everything is on, somewhere.' }];
    const per = 8, cyc = promos.length * per;
    promos.forEach((p, i) => {
      const en = `:enable='gte(mod(t+${O},${cyc}),${i * per})*lt(mod(t+${O},${cyc}),${(i + 1) * per})'`;
      d.push(T(`${fmtShort(p.at).toUpperCase()}   ${p.dial} ${p.call}`, fx('vt323'), 15, '0xa8f0ec', 124, 39, en));
      wrapPx(p.title, 176, 2).forEach((ln, j) => d.push(T(ln, FONT, 10, 'white', 124, 56 + j * 11, en + (UI.pixel ? ':ft_load_flags=monochrome' : ''))));
      if (p.desc) d.push(T(clip(p.desc.toLowerCase(), 30), fx('majormono'), 8, '0xd9f3f5', 124, 82, en));
    });
    // Column header above the scrolling grid.
    d.push(`drawbox=x=0:y=${K(102)}:w=${W}:h=${K(12)}:color=0x0b3640@0.85:t=fill`);
    PASTEL.forEach((c, i) => d.push(`drawbox=x=${K(Math.round(i * 320 / 7))}:y=${K(112)}:w=${K(Math.round((i + 1) * 320 / 7) - Math.round(i * 320 / 7))}:h=${K(2)}:color=${c}:t=fill`));
    d.push(T(new Date(plan.startMs).getHours() >= 17 ? 'TONIGHT' : 'TODAY', fx('vt323'), 14, '0xc6f4ef', 6, 102));
    const gx0 = 48, gw = 318 - gx0;
    G.times.forEach((t, i) => d.push(T(fmtShort(t).toUpperCase(), fx('vt323'), 14, 'white', gx0 + Math.round(i * gw / 3) + 3, 102)));
  } else {
    const wx = plan.wx, PAGE = 10, NP = 6, CYC = PAGE * NP;
    const en = i => `:enable='gte(mod(t+${O},${CYC}),${i * PAGE})*lt(mod(t+${O},${CYC}),${(i + 1) * PAGE})'`;
    const iRd = img('gen_radar.png'), iSw = img('gen_sweep.png');
    g += `[${iRd}:v]${sc}format=rgba[grd];[${iSw}:v]${sc}format=rgba,rotate=a='(t+${O})*1.3':c=none:ow=iw:oh=ih[gsw];` +
         `[${cur}][grd]overlay=${K(95)}:${K(62)}${en(3)}[gw1];[gw1][gsw]overlay=${K(95)}:${K(62)}${en(3)}[gw2];`;
    cur = 'gw2';
    d.push(T('the oompas weather', fx('shrikhand'), 18, '0xffffff', '(w-text_w)/2', 8, glow));
    d.push(`drawbox=x=${K(16)}:y=${K(40)}:w=${K(288)}:h=${K(158)}:color=0x0e4a57@0.55:t=fill`, `drawbox=x=${K(16)}:y=${K(40)}:w=${K(288)}:h=${K(2)}:color=0xc6f4ef:t=fill`);
    d.push(clock(fx('vt323'), 15, '0xfff3b0', `w-text_w-${K(24)}`, 44));
    const head = (txt, i) => d.push(T(txt, fx('vt323'), 16, '0xa8f0ec', 26, 46, en(i)));
    // 0: current conditions
    head('YOUR LOCAL FORECAST', 0);
    d.push(T(wx.town.toUpperCase(), fx('michroma'), 12, 'white', 26, 66, en(0)));
    d.push(T(`${wx.temp}°`, fx('zendots'), 40, '0xfff3b0', 26, 86, en(0) + ':shadowcolor=0x0b3640:shadowx=3:shadowy=3'));
    wrap(wx.cond, 16).split('\n').slice(0, 3).forEach((ln, j) => d.push(T(ln, fx('majormono'), 11, 'white', 130, 92 + j * 14, en(0))));
    wx.stats.forEach((ln, j) => d.push(T(ln, fx('vt323'), 14, '0xe4f4f6', 26, 140 + j * 13, en(0))));
    // 1: around the region
    head('AROUND THE REGION', 1);
    wx.region.forEach((r, j) => {
      const y = 68 + j * 21;
      d.push(T(r.town.toUpperCase(), fx('michroma'), 9, 'white', 26, y + 3, en(1)));
      d.push(T(`${r.temp}°`, fx('zendots'), 14, '0xfff3b0', 192, y, en(1)));
      d.push(T(r.cond, fx('vt323'), 14, '0xa8f0ec', 236, y + 1, en(1)));
    });
    // 2: the days ahead
    head('THE DAYS AHEAD', 2);
    wx.days.forEach((dd, j) => {
      const x = 26 + j * 94;
      d.push(T(dd.name, fx('vt323'), 16, '0xc6f4ef', x, 70, en(2)));
      d.push(T(`${dd.hi}°`, fx('zendots'), 22, '0xfff3b0', x, 90, en(2)));
      d.push(T(`low ${dd.lo}°`, fx('vt323'), 14, '0xe4f4f6', x, 120, en(2)));
      wrap(dd.cond, 12).split('\n').slice(0, 3).forEach((ln, i) => d.push(T(ln, fx('majormono'), 9, 'white', x, 140 + i * 12, en(2))));
    });
    // 3: radar
    head('RADAR · YOUR AREA', 3);
    d.push(T('no echoes detected', fx('vt323'), 14, '0xe4f4f6', '(w-text_w)/2', 196 - 16, en(3)));
    // 4: almanac
    head('ALMANAC', 4);
    wx.almanac.forEach((ln, j) => d.push(T(ln, fx('vt323'), 15, '0xe4f4f6', 40, 72 + j * 18, en(4))));
    // 5: your area
    d.push(T('YOUR AREA', fx('zendots'), 30, '0xffffff', '(w-text_w)/2', 82, en(5) + glow));
    d.push(T('tomorrow: the same', fx('majormono'), 12, '0xa8f0ec', '(w-text_w)/2', 128, en(5)));
    d.push(T('stay where you are', fx('vt323'), 16, '0xfff3b0', '(w-text_w)/2', 152, en(5)));
    // Crawl along the bottom.
    d.push(`drawbox=x=0:y=${K(206)}:w=${W}:h=${K(20)}:color=0x0b3640@0.6:t=fill`);
    d.push(T(wx.ticker.repeat(2), fx('vt323'), 15, '0xffffff', `w-mod((t+${O})*${K(40)}\\,w+text_w)`, 208));
  }

  // Slow colour drift, a faint rolling band, tape softness, chroma bleed and grain.
  const hueBase = plan.gen === 'weather' ? -6 : 0;
  let tail = `[${cur}]hue=h='${hueBase}+sin((t+${O})/40)*8',eq=contrast=0.92:brightness=0.02:saturation=0.88`;
  if (d.length) tail += ',' + d.join(',');
  tail += `,drawbox=x=0:y='mod((t+${O})*${K(35)},${K(420)})-${K(90)}':w=${W}:h=${K(10)}:color=white@0.06:t=fill` +
          `,gblur=sigma=${(0.5 * k).toFixed(2)}` + (GEN.chroma ? `,chromashift=cbh=${K(2)}:crh=-${K(2)}` : '') +
          `,noise=alls=6:all_seed=7,fps=${CFG.fps},format=yuv420p`;

  // Sound: your music folder if there is one, otherwise the chord pad.
  let ach;
  if (GEN.tracks.length) {
    const tr = GEN.tracks[Math.floor(Math.random() * GEN.tracks.length)];
    // Each half-hour (Guide) or ten minutes (Weather) starts the track at a new random spot,
    // kept for that stretch so re-tuning picks up where it is.
    if (!GEN.starts) GEN.starts = new Map();
    const sk = plan.gen + plan.startMs;
    if (!GEN.starts.has(sk)) { GEN.starts.set(sk, { tr, at: Math.random() * tr.dur }); if (GEN.starts.size > 20) GEN.starts.delete(GEN.starts.keys().next().value); }
    const st = GEN.starts.get(sk);
    input('-stream_loop', '-1', '-ss', ((st.at + plan.offset) % st.tr.dur).toFixed(2), '-i', st.tr.file);
    ach = `[${n}:a]aresample=48000,aformat=channel_layouts=stereo${LEVEL()}[a]`;
  } else {
    input('-f', 'lavfi', '-i', `aevalsrc=exprs='${padExpr(PADS[plan.gen], plan.offset)}':s=48000:c=stereo`);
    ach = `[${n}:a]lowpass=f=1400,aecho=0.8:0.6:180|420:0.35|0.25,aresample=48000,aformat=channel_layouts=stereo${LEVEL()}[a]`;
  }
  return { inputs: a, vchain: g + tail, achain: ach, files };
}


// ------------------------------------------------------ stretched tapes
// Music for Guide and Weather made from old in-store tapes on the Internet Archive:
// a few minutes of each tape is paulstretched (slowed many times over into slow washes),
// given a long soft reverb and a little tape wobble, and saved. Done once per tape, in
// the background, one tape at a time; the results are reused on every start.
function writeIr(file, sr) {
  const len = Math.round(3.8 * sr), pre = Math.round(0.03 * sr), data = Buffer.alloc(44 + len * 4);
  let s1 = 1, s2 = 7, lpL = 0, lpR = 0;
  const lcg = s => (Math.imul(s, 1103515245) + 12345) >>> 0;
  for (let i = 0; i < len; i++) {
    s1 = lcg(s1); s2 = lcg(s2 ^ 0x5bd1e995);
    const t = Math.max(0, i - pre) / sr, env = i < pre ? 0 : Math.exp(-t / 1.1), a = 0.25 + 0.7 * Math.exp(-t / 0.8);
    lpL += a * ((s1 / 2 ** 32) * 2 - 1 - lpL); lpR += a * ((s2 / 2 ** 32) * 2 - 1 - lpR);
    data.writeInt16LE(Math.round(lpL * env * 20000), 44 + i * 4); data.writeInt16LE(Math.round(lpR * env * 20000), 46 + i * 4);
  }
  data.write('RIFF', 0); data.writeUInt32LE(36 + len * 4, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20);
  data.writeUInt16LE(2, 22); data.writeUInt32LE(sr, 24); data.writeUInt32LE(sr * 4, 28); data.writeUInt16LE(4, 32); data.writeUInt16LE(16, 34);
  data.write('data', 36); data.writeUInt32LE(len * 4, 40);
  fs.writeFileSync(file, data);
}

const lowPriority = proc => { try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} };

async function stretchTape(url, start, spec, out, seed) {
  const SR = 22050, dir = path.dirname(out), ir = path.join(dir, 'reverb.wav');
  if (!fs.existsSync(ir)) writeIr(ir, SR);
  // 1. A few minutes of the tape, as mono samples.
  const pcm = await new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-reconnect', '1', '-reconnect_streamed', '1', '-rw_timeout', '30000000',
                  '-ss', String(start), '-t', String(Math.round(spec.excerptMin * 60)), '-i', url, '-ac', '1', '-ar', String(SR), '-f', 'f32le', 'pipe:1'];
    const p = spawn(CFG.ffmpeg, args, { windowsHide: true }); lowPriority(p);
    const chunks = []; let err = '';
    p.stdout.on('data', d => chunks.push(d)); p.stderr.on('data', d => { err += d; });
    p.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(err.trim().split('\n').pop() || 'download failed')));
  });
  if (pcm.length < SR * 4 * 20) throw new Error('tape too short');
  const input = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 4)));
  // 2. Stretch in a worker, feeding an encoder that adds reverb and wobble.
  const tmp = out + '.part.m4a';
  const enc = spawn(CFG.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', 'pipe:0', '-i', ir,
    '-filter_complex', `[0:a]pan=stereo|c0=c0|c1=c0,highpass=f=50,lowpass=f=6500,vibrato=f=0.35:d=0.08,asplit[d][w];[w][1:a]afir=dry=1:wet=1[r];` +
                       `[d][r]amix=inputs=2:weights='0.55 1':normalize=0,aresample=44100,loudnorm=I=-20:TP=-2`,
    '-c:a', 'aac', '-b:a', '96k', tmp], { windowsHide: true });
  lowPriority(enc);
  let encErr = '';
  enc.stderr.on('data', d => { encErr += d; });
  const encDone = new Promise(r => enc.on('close', r));
  const worker = new Worker(new URL('./paulstretch.mjs', import.meta.url));
  const samples = await new Promise((resolve, reject) => {
    let queue = Promise.resolve();
    worker.on('message', m => {
      if (m.type === 'chunk') queue = queue.then(() => new Promise(r => enc.stdin.write(Buffer.from(m.data.buffer)) ? r() : enc.stdin.once('drain', r)));
      else queue.then(() => { enc.stdin.end(); resolve(m.samples); });
    });
    worker.on('error', reject);
    worker.postMessage({ input, sr: SR, stretch: spec.stretch, winSec: spec.windowSec || 0.75, seed }, [input.buffer]);
  }).finally(() => worker.terminate());
  if ((await encDone) !== 0) throw new Error(encErr.trim().split('\n').pop() || 'encode failed');
  fs.renameSync(tmp, out);
  return samples / SR;
}

async function setupTapeMusic(oompas) {
  const spec = { excerptMin: 3, stretch: 10, tapes: 8, ...(oompas?.config.music || {}) };
  if (!oompas?.config.music || !spec.q || !GEN.ok) return;
  const dir = path.join(CFG.cacheDir, 'music'), indexFile = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });
  let index = [];
  try { index = JSON.parse(fs.readFileSync(indexFile, 'utf8')).filter(t => fs.existsSync(path.join(dir, t.file))); } catch {}
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.part.m4a')) fs.rmSync(path.join(dir, f), { force: true });   // an interrupted stretch
  for (const t of index) GEN.tracks.push({ file: path.join(dir, t.file), dur: t.dur });
  if (index.length) log(`Guide/Weather music: ${index.length} stretched tapes`);
  if (index.length >= spec.tapes) return;
  const q = `(${spec.q}) AND mediatype:(audio)`;
  const res = await oompas.fetchJson(`${CFG.archiveBase}/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&rows=300&page=1&output=json`);
  const ids = (res?.response?.docs || []).map(d => d.identifier).filter(Boolean)
    .filter(id => !index.some(t => t.id === id)).sort((a, b) => hash32('m' + a) - hash32('m' + b));
  if (!ids.length) { log('Guide/Weather music: no tapes found for ' + spec.q); return; }
  log(`Guide/Weather music: stretching ${Math.min(ids.length, spec.tapes - index.length)} tapes in the background (a minute or two each)...`);
  for (const id of ids) {
    if (index.length >= spec.tapes) break;
    try {
      const meta = await oompas.fetchJson(`${CFG.archiveBase}/metadata/${encodeURIComponent(id)}`);
      const mp3s = (meta.files || []).filter(f => /\.mp3$/i.test(f.name) && parseDuration(f.length) > 240);
      if (!mp3s.length) continue;
      // A random side of the tape, and a random spot on it (skipping the lead-in and the end).
      const f = mp3s[Math.floor(Math.random() * mp3s.length)], len = parseDuration(f.length);
      const span = Math.max(1, len - spec.excerptMin * 60 - 60);
      const start = Math.round(Math.min(30 + Math.random() * span, Math.max(0, len - spec.excerptMin * 60)));
      const file = `${id.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60)}-${spec.stretch}x.m4a`;
      const t0 = Date.now();
      const dur = await stretchTape(archiveFile(id, f.name), start, spec, path.join(dir, file), hash32(id));
      index.push({ id, file, dur, src: f.name, start });
      fs.writeFileSync(indexFile, JSON.stringify(index, null, 1));
      GEN.tracks.push({ file: path.join(dir, file), dur });
      log(`Guide/Weather music: ${id} from ${Math.floor(start / 60)}:${String(start % 60).padStart(2, '0')} done (${Math.round(dur / 60)} min, took ${Math.round((Date.now() - t0) / 1000)} s)`);
    } catch (e) { log(`Guide/Weather music: skipped ${id} (${e.message})`); }
  }
}

// ----------------------------------------------------------- live stream
let viewers = 0;
// Open streams, so the log can say who is watching and stale duplicates can be closed.
const STREAMS = new Set();
const clientOf = req => String(req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
function watchingSummary() {
  const open = [...STREAMS].filter(s => !s.gone);         // closing ones are on their way out
  const tvs = new Set(open.map(s => s.addr)).size;
  if (open.length === tvs) return `${tvs} watching`;
  const who = open.map(s => s.viewer ? `${s.viewer}@${s.addr}` : s.addr);
  return `${open.length} streams to ${tvs} ${tvs === 1 ? 'TV' : 'TVs'} (${who.join(', ')})`;
}
// A player sometimes opens a new connection without letting go of the old one. If an
// older stream to the same address has stopped reading for 10 s while a newer one is
// open, it's abandoned: close it so the PC isn't encoding a channel nobody sees.
setInterval(() => {
  for (const st of STREAMS) {
    st.stalledSince = st.res.writableNeedDrain ? (st.stalledSince || Date.now()) : 0;
    const newer = [...STREAMS].some(o => o !== st && o.addr === st.addr && o.startedAt > st.startedAt);
    if (newer && st.stalledSince && Date.now() - st.stalledSince > 10000) {
      log(`  closing an abandoned stream (${st.dial}) from ${st.addr}`);
      st.close();
    }
  }
}, 5000).unref();

async function streamChannel(bc, dial, req, res, size, opts = {}) {
  let closed = false;
  const live = new Set();
  let wake = () => {};
  const onClose = () => { closed = true; for (const s of live) s.kill(); wake(); };
  req.on('close', onClose);
  res.on('error', onClose);

  let channel = await bc.channelByDial(dial);
  res.writeHead(200, { 'content-type': 'video/mp2t', 'cache-control': 'no-store', connection: 'close' });
  // A HEAD request (some players check a link first) gets the headers and nothing else.
  if (req.method === 'HEAD') return res.end();
  const me = { addr: clientOf(req), viewer: opts.viewer || '', dial, res, startedAt: Date.now(), stalledSince: 0,
               close: () => { me.gone = true; onClose(); try { res.destroy(); } catch {} } };
  // One TV plays one channel. When a TV opens a new stream, any older stream to the
  // same address is left over (a re-tune, or a player that didn't hang up), and over
  // Wi-Fi the two fight for bandwidth and both stutter. Close the old one now.
  // On this PC itself only streams that name the same viewer (the app) replace each other.
  const local = /^(127\.|::1$|localhost)/.test(me.addr);
  if (!local || me.viewer) {
    for (const o of STREAMS) if (o.addr === me.addr && o.viewer === me.viewer) { log(`  closing the earlier stream (${o.dial}) to ${me.viewer || o.addr}`); o.close(); }
  }
  STREAMS.add(me);
  viewers++;
  const what = '';
  log(`+ ${me.addr} tuned to ${channel.dial} ${channel.name}${what} — ${watchingSummary()}`);

  let tsOffset = 1.0;
  let at = now();
  let failures = 0;
  let next = null;

  try {
    let banner = { first: true };   // the first segment after tuning in pre-loads a reserve
    while (!closed) {
      let seg = next; next = null;
      if (!seg) {
        let plan = await bc.plan(channel, at);
        if (plan.dur < 0.25) { at = plan.endMs; continue; }
        await framingWithin(plan, 4000);   // trim baked-in black bars (quick; remembered after)
        if (closed) break;
        seg = startSegment(plan, tsOffset, banner, size);
      }
      banner = null;
      live.add(seg);
      seg.attach(res);
      const plan = seg.plan;
      // Which copy of the tape is playing, and at what quality, so a soft picture can be traced.
      const src = plan.kind === 'media' && plan.url ? ` · ${decodeURIComponent(String(plan.url).split('/').pop())}` : '';
      log(`  ${channel.dial} ${plan.kind === 'media' || plan.kind === 'live' ? '▶' : '■'} ${plan.title} [${Math.round(plan.dur)}s]${src}`);

      // Arrange to start the following program a little before this one ends.
      // Timed from the schedule (not from when this segment began: on tune-in it is sent
      // ahead of real time), and the follow-on timestamp is fixed now, not when it fires.
      const leadMs = Math.min(CFG.leadSeconds * 1000, plan.dur * 500);
      const startNextIn = Math.max(0, plan.endMs - leadMs - now());
      const nextOffset = tsOffset + plan.dur;
      let timer;
      const startAt = now() + startNextIn;
      const prepNext = new Promise(resolve => {
        // Look the next program up ~20 s early, so its framing can be checked in time.
        timer = setTimeout(async () => {
          if (closed) return resolve(null);
          try {
            channel = await bc.channelByDial(dial).catch(() => channel); // pick up live lineup updates
            const p = await bc.plan(channel, plan.endMs);
            if (p.dur < 0.25) return resolve(null);
            await framingWithin(p, Math.max(1000, startAt - now()));
            const wait = startAt - now();
            if (wait > 0) await new Promise(r => { timer = setTimeout(r, wait); });
            resolve(closed ? null : startSegment(p, nextOffset, null, size));
          } catch (e) { log('  next program lookup failed: ' + e.message); resolve(null); }
        }, Math.max(0, startNextIn - 20000));
      });

      const code = await seg.done;
      live.delete(seg);
      if (closed) { clearTimeout(timer); prepNext.then(s => s && s.kill()); break; }

      const tooShort = seg.bytes < 50000 && plan.dur > 5;
      if (code !== 0 || tooShort) {
        clearTimeout(timer); prepNext.then(s => s && s.kill());
        log(`  ! ${plan.title}: ffmpeg ${code}${seg.err ? ' — ' + seg.err.trim().split('\n').pop() : ''}`);
        if (process.env.DEBUG_ARGS) log("    args: " + JSON.stringify(seg.args));
        failures++;
        // Fill the rest of the broken program with a stand-by card, retrying every minute.
        const t = now();
        const left = Math.max(1, Math.min(60, (plan.endMs - t) / 1000));
        // Keep timestamps moving forward past whatever the failed segment managed to send.
        tsOffset += Math.min(plan.dur, (t - seg.startedAt) / 1000) + 1;
        next = startSegment({ ...plan, kind: 'standby', title: 'Please stand by', dur: left, endMs: t + left * 1000 }, tsOffset, null, size);
        if (failures > 20) throw new Error('Too many failures');
        continue;
      }
      failures = 0;
      tsOffset += plan.dur;
      at = plan.endMs;
      // Wait for the follow-on program, but stop waiting the moment the viewer leaves:
      // otherwise a closed stream lingers (counted as watching) until the next program.
      next = await Promise.race([prepNext, new Promise(r => { wake = () => r(null); })]);
      wake = () => {};
      if (closed) { clearTimeout(timer); prepNext.then(s => s && s.kill()); if (next) next.kill(); next = null; break; }
    }
  } catch (e) {
    log(`  stream error on ${dial}: ${e.message}`);
  } finally {
    for (const s of live) s.kill();
    if (next) next.kill();
    viewers--;
    STREAMS.delete(me);
    log(`- ${me.addr} left ${dial} after ${Math.round((Date.now() - me.startedAt) / 1000)} s — ${watchingSummary()}`);
    try { res.end(); } catch {}
  }
}

// ------------------------------------------------------------ HTTP server
// ------------------------------------------------------------ app settings + API
// Settings changed in the TV app are kept in settings.json (in the app's data folder,
// or oompas-cache), so the desktop app and a future TV-box app share them.
const APP_DATA = process.env.APP_DATA || CFG.cacheDir;
const SETTINGS_FILE = path.join(APP_DATA, 'settings.json');
const SETTINGS = {
  widescreen: CFG.widescreen, bars: CFG.bars, crt: true, banner: true, volume: 0.8, lastDial: null,
  iptv: { enabled: false, dialStart: 500, hideAdult: true, hideBroken: false, freeGuides: true, countries: [], languages: [], categories: [], lists: [] },
  oompas: 'off',        // OOMPAS Box's own channels: off, guide (Guide & Weather only) or all
  favorites: [],        // starred channel ids: "My channels"
  zoom: 'trim',         // picture shape in the app: fit, trim (zoom past black bars), fill, stretch
  zoomByChannel: {},
  resolution: 'high',   // app streams: high 960x720, standard 640x480, low 320x240
  windowScale: 'free',  // desktop window when not full screen: free, or the picture's size x1/x2/x3
  surf: 'all',          // channel up/down: 'all' or 'favorites'
};
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  Object.assign(SETTINGS, saved, { iptv: { ...SETTINGS.iptv, ...(saved.iptv || {}) } });
} catch {}
let settingsSave = null;
function saveSettings() {
  clearTimeout(settingsSave);
  settingsSave = setTimeout(() => {
    try { fs.mkdirSync(APP_DATA, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(SETTINGS, null, 1)); }
    catch (e) { log('Couldn\'t save settings: ' + e.message); }
  }, 300);
}
function applySettings(bc) {
  if (['fit', 'zoom', 'fill'].includes(SETTINGS.widescreen)) CFG.widescreen = SETTINGS.widescreen;
  CFG.bars = SETTINGS.bars !== false;
  bc?.iptv?.configure(SETTINGS.iptv);
}
// Only accept a list of known setting names, with sane values.
function mergeSettings(patch) {
  const p = patch || {};
  if (['fit', 'zoom', 'fill'].includes(p.widescreen)) SETTINGS.widescreen = p.widescreen;
  for (const k of ['bars', 'crt', 'banner']) if (typeof p[k] === 'boolean') SETTINGS[k] = p[k];
  if (typeof p.volume === 'number') SETTINGS.volume = Math.min(1, Math.max(0, p.volume));
  if (p.lastDial != null) SETTINGS.lastDial = String(p.lastDial).slice(0, 8);
  if (Array.isArray(p.favorites)) SETTINGS.favorites = [...new Set(p.favorites.map(x => String(x).slice(0, 80)))].slice(0, 2000);
  if (['all', 'favorites'].includes(p.surf)) SETTINGS.surf = p.surf;
  if (['off', 'guide', 'all'].includes(p.oompas)) SETTINGS.oompas = p.oompas;
  if (['high', 'standard', 'low'].includes(p.resolution)) SETTINGS.resolution = p.resolution;
  const ZOOMS = ['fit', 'trim', 'fill', 'stretch'];
  if (ZOOMS.includes(p.zoom)) SETTINGS.zoom = p.zoom;
  if (p.zoomByChannel && typeof p.zoomByChannel === 'object')
    SETTINGS.zoomByChannel = Object.fromEntries(Object.entries(p.zoomByChannel).filter(([k, v]) => ZOOMS.includes(v)).slice(0, 2000).map(([k, v]) => [String(k).slice(0, 80), v]));
  if (['free', '1', '2', '3', '640x480', '800x600', '960x720', '1024x768', '1280x960'].includes(String(p.windowScale))) SETTINGS.windowScale = String(p.windowScale);
  if (p.iptv && typeof p.iptv === 'object') {
    const i = p.iptv, cur = SETTINGS.iptv;
    for (const k of ['enabled', 'hideAdult', 'hideBroken', 'freeGuides']) if (typeof i[k] === 'boolean') cur[k] = i[k];
    if (Array.isArray(i.languages)) cur.languages = i.languages.map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, 100);
    if (Array.isArray(i.categories)) cur.categories = i.categories.map(x => String(x).slice(0, 60)).filter(Boolean).slice(0, 200);
    if (Array.isArray(i.countries)) cur.countries = i.countries.map(x => String(x).toLowerCase()).filter(x => /^[a-z?]{1,2}$/.test(x)).slice(0, 250);
    if (Number.isFinite(+i.dialStart) && +i.dialStart >= 1 && +i.dialStart <= 9000) cur.dialStart = Math.round(+i.dialStart);
    if (Array.isArray(i.lists)) {
      cur.lists = i.lists.slice(0, 50).filter(l => l && typeof l.url === 'string' && l.url.trim()).map(l => ({
        id: String(l.id || 'list-' + createHash('sha1').update(l.url).digest('hex').slice(0, 10)).slice(0, 60),
        name: String(l.name || 'Playlist').slice(0, 80), url: l.url.trim().slice(0, 2000),
        epg: typeof l.epg === 'string' ? l.epg.trim().slice(0, 2000) : '', enabled: l.enabled !== false,
        builtin: !!l.builtin,
      }));
    }
  }
}

const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|fe80:|fc|fd|localhost)/i;
function readJson(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > limit) { reject(Object.assign(new Error('Too big'), { status: 413 })); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(Object.assign(new Error('Bad JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
}
const sendJson = (res, v, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(v)); };

function sectionOf(c) {
  if (c.kind === 'iptv') return { kind: 'iptv', section: c.list || 'IPTV' };
  if (c.kind === 'youtube') return { kind: 'youtube', section: 'YouTube' };
  if (c.oompas) return { kind: 'oompas', section: 'OOMPAS Box' };
  return { kind: 'spelunkr', section: 'Spelunkr' };
}

// Every channel the app can show: OOMPAS Box and Spelunkr, then IPTV.
// Everything on the dial: our channels first, then YouTube, then IPTV (each skips a dial already taken).
async function allChannels(bc) {
  const base = (await bc.lineup()).channels.filter(c => !BUILTIN_DIALS.has(c.dial));   // the built-in YouTube dials always win
  const dials = new Set([...base.map(c => c.dial), ...BUILTIN_DIALS]);
  const yt = (bc.youtube?.lineupChannels() || []).filter(c => BUILTIN_DIALS.has(c.dial) || (!dials.has(c.dial) && dials.add(c.dial)));
  return [...base, ...yt, ...(bc.iptv?.channels || []).filter(c => !dials.has(c.dial))].sort((a, b) => a.dial - b.dial);
}
const ready = (bc, c) => (c.kind === 'iptv' || c.kind === 'youtube' ? c : bc.channel(c.id));

async function appChannels(bc) {
  const all = await allChannels(bc);
  const at = now();
  return Promise.all(all.map(async c => {
    let progs = [];
    try { progs = (await programsBetween(bc, await ready(bc, c), at, at + 8 * 3600e3)).slice(0, 2); } catch {}
    const pr = p => p ? { title: p.title, sub: p.sub || (p.eps ? nowLine(p, now()) : '') || '', desc: p.desc || p.description || '', kindLine: kindLine(p), movie: isMovie(p), startMs: p.startMs, endMs: p.endMs, live: !!p.live } : null;
    return { dial: c.dial, id: c.id, name: c.name, call: c.call || callSign(c.name), color: c.color,
             ...sectionOf(c), logo: c.logo || '', group: c.group || '', cats: c.cats || [], country: c.country || '', description: c.description || '',
             langs: c.langs || [], tags: c.tags || [], health: c.health || '', healthWhy: c.healthWhy || '',
             now: pr(progs[0]), next: pr(progs[1]) };
  }));
}

// Short videos make slivers in the guide grid: group them into blocks of 15 minutes or more.
function foldShort(ps) {
  const out = [];
  for (const p of ps) {
    const last = out.at(-1);
    if (last && last.endMs - last.startMs < 15 * 60000 && !p.live) { last.endMs = p.endMs; last.n++; last.title = `${last.first} + ${last.n} more`; }
    else out.push({ ...p, first: p.title, n: 0 });
  }
  return out;
}

async function appGuide(bc, dials, from, until) {
  const want = new Set(dials.map(String));
  const all = (await allChannels(bc)).filter(c => want.has(String(c.dial)));
  const out = {};
  await Promise.all(all.map(async c => {
    try {
      let ps = await programsBetween(bc, await ready(bc, c), from, until);
      if (c.kind === 'youtube') ps = foldShort(ps);
      out[c.dial] = ps
        .map(p => ({ title: p.title, sub: p.sub || '', startMs: p.startMs, endMs: p.endMs, live: !!p.live }));
    } catch { out[c.dial] = []; }
  }));
  return out;
}

function playInfo(bc, c, q) {
  const w = Math.min(1440, Math.max(320, Number(q.get('w')) || 960)) & ~1;
  const h = Math.min(1080, Math.max(240, Number(q.get('h')) || 720)) & ~1;
  const tune = `/tune/${c.dial}.ts?w=${w}&h=${h}`;
  if (c.kind === 'youtube') return { mode: 'youtube', ...(bc.youtube.playAt(c, now()) || {}) };
  if (c.kind !== 'iptv') return { mode: 'ts', url: tune, aspect: '4:3' };
  const u = c.iptv.url;
  const opts = { ua: c.iptv.ua, referrer: c.iptv.referrer };
  if (!/^https?:/i.test(u)) return { mode: 'ts', url: tune, aspect: '4:3' };
  if (/\.ts(\?|$)/i.test(u)) return { mode: 'ts', url: proxyUrl(u, opts), fallback: tune, aspect: 'auto' };
  if (/\.(mp4|m4v|webm)(\?|$)/i.test(u)) return { mode: 'file', url: proxyUrl(u, opts), fallback: tune, aspect: 'auto' };
  return { mode: 'hls', url: proxyUrl(u, opts), fallback: tune, aspect: 'auto' };
}

const TV_DIR = path.join(HERE, 'tv');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
               '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.ttf': 'font/ttf' };
function serveTv(res, rel) {
  const file = path.normalize(path.join(TV_DIR, rel || 'index.html'));
  if (!file.startsWith(TV_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

async function handleApp(bc, req, res, url) {
  const p = url.pathname;
  const addr = clientOf(req);
  if (p === '/tv') { res.writeHead(302, { location: '/tv/' }); res.end(); return true; }
  if (p.startsWith('/tv/')) { serveTv(res, decodeURIComponent(p.slice(4))); return true; }
  if (p === '/iptv/p') {
    if (!PRIVATE.test(addr)) { res.writeHead(403); res.end(); return true; }
    await iptvProxy(req, res, url).catch(e => { if (!res.headersSent) { res.writeHead(502); res.end(e.message); } else res.end(); });
    return true;
  }
  if (!p.startsWith('/api/')) return false;
  if (p === '/api/state') {
    sendJson(res, { name: 'OOMPAS Box', port: CFG.port, settings: SETTINGS,
                    iptv: bc.iptv?.status() || [], iptvChannels: bc.iptv?.channels.length || 0, iptvCountries: bc.iptv?.countries || {}, iptvCategories: bc.iptv?.categories || {}, iptvLanguages: bc.iptv?.languages || {}, iptvCheck: bc.iptv?.check || null, iptvGuides: bc.iptv?.guideCount || 0,
                    youtube: bc.youtube?.status() || [],
                    catalog: CATALOG, watching: [...STREAMS].map(s => ({ addr: s.addr, viewer: s.viewer, dial: s.dial })),
                    x264: !!CFG.x264, oompasReady: !!bc.oompas?.complete });
    return true;
  }
  if (p === '/api/channels') { sendJson(res, { at: now(), channels: await appChannels(bc) }); return true; }
  if (p === '/api/guide') {
    const from = Number(url.searchParams.get('from')) || now();
    const until = Math.min(from + 12 * 3600e3, Number(url.searchParams.get('until')) || from + 3 * 3600e3);
    sendJson(res, await appGuide(bc, (url.searchParams.get('dials') || '').split(',').filter(Boolean).slice(0, 60), from, until));
    return true;
  }
  if (p === '/api/play') {
    const c = await bc.channelByDial(url.searchParams.get('dial'));
    sendJson(res, { dial: c.dial, ...playInfo(bc, c, url.searchParams) });
    return true;
  }
  if (p === '/api/log') { sendJson(res, { lines: LOGBUF.slice(-300) }); return true; }
  if (p === '/api/settings' && req.method === 'POST') {
    if (!PRIVATE.test(addr)) { sendJson(res, { error: 'Only from your own network' }, 403); return true; }
    const before = JSON.stringify(SETTINGS.iptv);
    mergeSettings(await readJson(req));
    saveSettings();
    CFG.widescreen = SETTINGS.widescreen; CFG.bars = SETTINGS.bars !== false;
    if (JSON.stringify(SETTINGS.iptv) !== before) bc.iptv?.configure(SETTINGS.iptv);
    sendJson(res, { ok: true, settings: SETTINGS });
    return true;
  }
  if (p.startsWith('/api/youtube/') && req.method === 'POST') {
    if (!PRIVATE.test(addr)) { sendJson(res, { error: 'Only from your own network' }, 403); return true; }
    const yt = bc.youtube, b = await readJson(req, 4e6), act = p.slice(13);
    try {
      if (act === 'add') {
        let dial = Math.round(+b.dial) || 0;
        const taken = new Set((await allChannels(bc)).filter(c => c.kind !== 'iptv').map(c => c.dial));
        if (!dial) { dial = 300; while (taken.has(dial)) dial++; }
        else if (taken.has(dial)) throw Object.assign(new Error(`Channel ${dial} is taken`), { status: 400 });
        const c = await yt.add({ link: b.link, name: b.name, dial, order: b.order });
        sendJson(res, { ok: true, channel: { id: c.id, list: c.list, dial: c.dial, name: c.name }, youtube: yt.status() });
      } else if (act === 'update') {
        if (b.dial != null) {
          const taken = new Set((await allChannels(bc)).filter(c => c.kind !== 'iptv' && c.id !== 'yt-' + b.id).map(c => c.dial));
          if (taken.has(+b.dial)) throw Object.assign(new Error(`Channel ${b.dial} is taken`), { status: 400 });
        }
        yt.update(b.id, b); sendJson(res, { ok: true, youtube: yt.status() });
      } else if (act === 'remove') { yt.remove(b.id); sendJson(res, { ok: true, youtube: yt.status() }); }
      else if (act === 'videos') { yt.setVideos(b.id, b.videos, b.done !== false); sendJson(res, { ok: true, youtube: yt.status() }); }
      else if (act === 'bad') { yt.markBad(b.id, b.videoId); sendJson(res, { ok: true }); }
      else sendJson(res, { error: 'not found' }, 404);
    } catch (e) { sendJson(res, { error: e.message }, e.status || 500); }
    return true;
  }
  if (p === '/api/iptv/check' && req.method === 'POST') {
    if (!PRIVATE.test(addr)) { sendJson(res, { error: 'Only from your own network' }, 403); return true; }
    bc.iptv?.checkAll().catch(e => log('IPTV check: ' + e.message));
    sendJson(res, { ok: true, check: bc.iptv?.check || null });
    return true;
  }
  if (p === '/api/iptv/refresh' && req.method === 'POST') {
    if (!PRIVATE.test(addr)) { sendJson(res, { error: 'Only from your own network' }, 403); return true; }
    await bc.iptv?.refresh(true);
    sendJson(res, { ok: true, iptv: bc.iptv?.status() || [], iptvChannels: bc.iptv?.channels.length || 0 });
    return true;
  }
  sendJson(res, { error: 'not found' }, 404);
  return true;
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

async function main() {
  if (typeof fetch !== 'function' || Number(process.versions.node.split('.')[0]) < 18) {
    throw new Error(`Node.js 18 or newer is required (you have ${process.version}). Get the LTS from nodejs.org`);
  }
  setupFfmpeg();
  if (CFG.drawtext) await setupFonts();
  setupGen();

  // OOMPAS Box's own channels.
  let oompas = null;
  try {
    const config = JSON.parse(fs.readFileSync(CFG.oompasFile, 'utf8'));
    const fetchJson = async url => {
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'oompas-box (personal retro TV app)' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } finally { clearTimeout(t); }
    };
    oompas = new OompasNet({ dir: CFG.cacheDir, config, archiveBase: CFG.archiveBase, fetchJson, log, now });
    log(`OOMPAS channels: ${oompas.channels.length} (${path.basename(CFG.oompasFile)})`);
  } catch (e) { log(`OOMPAS channels not loaded (${e.message}); only Spelunkr channels will play`); }

  // Spelunkr's channels (optional when OOMPAS channels are there).
  let engine = null;
  if (CFG.spelunkr) {
    try { engine = await loadEngine(); }
    catch (e) { if (!oompas) throw e; log(`Spelunkr channels unavailable (${e.message})`); }
  }
  const bc = new Broadcast(engine, oompas);
  bc.iptv = new Iptv({ cacheDir: CFG.cacheDir, log });
  bc.youtube = new YouTube({ dataDir: APP_DATA, log });
  bc.youtube.resolveBuiltins();
  setInterval(() => bc.youtube.resolveBuiltins(), 30 * 60e3).unref();
  applySettings(bc);
  setInterval(() => bc.iptv.refresh().catch(() => {}), 3600e3).unref();
  const l = await bc.lineup();
  log(`Dial: ${l.channels.length} channels${engine ? ` (Spelunkr data: ${bc.source})` : ''}`);
  if (oompas) {
    oompas.day(now()).then(() => {
      setupTapeMusic(oompas).catch(e => log('Guide/Weather music: ' + e.message));
      const thin = oompas.status().filter(c => c.tapes && Object.values(c.tapes).every(v => v < 5)).map(c => c.dial);
      log('OOMPAS: schedule ready' + (thin.length ? `; few or no tapes found for channel ${thin.join(', ')} (edit their searches in oompas-channels.json)` : ''));
    }).catch(e => log('OOMPAS: ' + e.message));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      let m;
      if (await handleApp(bc, req, res, url)) return;
      if ((m = url.pathname.match(/^\/tune\/(\d+)(?:\.ts)?$/))) {
        // H.264 + AAC in MPEG-TS for the app's player, at ?w=..&h=.. (the Stream resolution setting).
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, (Number(v) || 0) & ~1));
        const size = { w: clamp(url.searchParams.get('w') || 960, 320, 1440), h: clamp(url.searchParams.get('h') || 720, 240, 1080), app: true };
        return await streamChannel(bc, m[1], req, res, size, { viewer: 'app' });
      }
      // The OOMPAS Server app's Stop button (only from this PC, with the app's token).
      if (url.pathname === '/quit') {
        const local = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
        if (!CFG.appToken || !local || url.searchParams.get('token') !== CFG.appToken) { res.writeHead(403); return res.end('no'); }
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('bye');
        log('Stopping (from the OOMPAS Server app).');
        for (const st of [...STREAMS]) st.close();
        setTimeout(() => process.exit(0), 300);
        return;
      }
      if (url.pathname === '/oompas.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ready: !!bc.oompas?.complete, channels: bc.oompas?.status() || [] }, null, 1));
      }
      if (url.pathname === '/') { res.writeHead(302, { location: '/tv/' }); return res.end(); }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      log('request failed: ' + e.message);
      if (!res.headersSent) { res.writeHead(e.status || 500, { 'content-type': 'text/plain' }); res.end(e.message); }
      else res.end();
    }
  });

  // Only this computer can reach it (no firewall prompt). LISTEN=0.0.0.0 opens it to your network,
  // e.g. to watch from another screen's browser.
  server.listen(CFG.port, CFG.listen, () => {
    log(`OOMPAS Box server ready on port ${CFG.port}`);
    log(`  watch in a browser: http://localhost:${CFG.port}/tv/`);
  });
}

process.on('exit', () => { try { fs.rmSync(WORK, { recursive: true, force: true }); } catch {} });
process.on('SIGINT', () => process.exit(0));
main().catch(e => { console.error('\nERROR: ' + e.message); process.exit(1); });
