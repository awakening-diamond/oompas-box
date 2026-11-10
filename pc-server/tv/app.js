// OOMPAS Box TV app. Runs in the desktop app's window, in a browser, or (later) inside
// a TV-box app: everything works with arrow keys, OK and Back, so a remote is enough.
(() => {
'use strict';
const $ = s => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const api = async (p, opt) => { const r = await fetch(p, opt); if (!r.ok) throw new Error((await r.text().catch(() => '')) || 'HTTP ' + r.status); return r.json(); };
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const abs = u => new URL(u, location.href).href;
const hm = ms => { const d = new Date(ms); let h = d.getHours(); const ap = h < 12 ? 'A' : 'P'; h = h % 12 || 12; return `${h}:${String(d.getMinutes()).padStart(2, '0')}${ap}`; };
const hmLower = ms => hm(ms).toLowerCase();
const HALF = 30 * 60000, SPAN = 90 * 60000;
const RES = { high: [960, 720], standard: [640, 480], low: [320, 240] };
const res = () => RES[S.settings?.resolution] || RES.high;

const S = {
  channels: [], byDial: new Map(), settings: null, server: null,
  cur: null, prev: null, player: null, mode: 'tv', volume: 0.8, muted: false, started: false,
};
const video = $('#video'), screen = $('#screen');

// ------------------------------------------------------------ helpers
let toastT;
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
let saveT, pendingSave = {};
function saveSetting(patch, now = false) {
  Object.assign(pendingSave, patch);
  const send = () => { const p = pendingSave; pendingSave = {}; return post('/api/settings', p).then(r => { S.settings = r.settings; return r; }).catch(e => toast('Couldn’t save: ' + e.message)); };
  clearTimeout(saveT);
  if (now) return send();
  saveT = setTimeout(send, 600);
  return Promise.resolve();
}
async function loadState() { S.server = await api('/api/state'); S.settings = S.server.settings; return S.server; }
async function loadChannels() {
  const d = await api('/api/channels');
  S.channels = d.channels;
  S.byDial = new Map(S.channels.map(c => [String(c.dial), c]));
  if (S.cur) S.cur = S.byDial.get(String(S.cur.dial)) || S.cur;
}

// ------------------------------------------------------------ TV static while tuning
const staticCanvas = $('#static'), sctx = staticCanvas.getContext('2d');
let staticRaf = 0;
function staticOn(on) {
  staticCanvas.classList.toggle('on', on);
  cancelAnimationFrame(staticRaf);
  if (!on) return;
  const img = sctx.createImageData(staticCanvas.width, staticCanvas.height), d = img.data;
  const draw = () => {
    for (let i = 0; i < d.length; i += 4) { const v = Math.random() * 255 | 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    sctx.putImageData(img, 0, 0);
    staticRaf = requestAnimationFrame(draw);
  };
  draw();
}
function noSignal(why) {
  staticOn(true);
  const n = $('#nosignal'); n.hidden = false;
  n.querySelector('small').textContent = why ? String(why).slice(0, 160) : '';
}

// ------------------------------------------------------------ playing
let tuneSeq = 0;
function stopPlayer() {
  try { S.player?.destroy(); } catch {}
  S.player = null;
  video.onplaying = video.onerror = video.onended = video.onwaiting = null;
  video.removeAttribute('src');
  try { video.load(); } catch {}
}

async function tune(dial, opts = {}) {
  const c = S.byDial.get(String(dial));
  if (!c) { toast(`No channel ${dial}`); return; }
  if (S.cur && S.cur.dial !== c.dial) S.prev = S.cur.dial;
  S.cur = c;
  const seq = ++tuneSeq;
  stopPlayer();
  $('#nosignal').hidden = true;
  staticOn(true);
  resetTrim();
  if (S.mode === 'guide') placePip();
  if (!opts.quiet && S.settings?.banner !== false && S.mode === 'tv') showBanner(c);
  if (String(S.settings?.lastDial) !== String(c.dial)) saveSetting({ lastDial: c.dial });
  let info;
  try { info = await api(`/api/play?dial=${encodeURIComponent(c.dial)}&w=${res()[0]}&h=${res()[1]}`); }
  catch (e) { if (seq === tuneSeq) noSignal('The OOMPAS server isn’t answering'); return; }
  if (seq === tuneSeq) play(info, seq, false);
}

function play(info, seq, isFallback) {
  let started = false, failed = false;
  const fail = why => {
    if (seq !== tuneSeq || failed) return;
    failed = true;
    clearTimeout(watchdog);
    if (info.fallback && !isFallback) { stopPlayer(); play({ mode: 'ts', url: info.fallback }, seq, true); }
    else noSignal(why);
  };
  const watchdog = setTimeout(() => { if (!started) fail('No picture from this channel'); }, isFallback ? 30000 : 15000);
  video.onplaying = () => { if (seq !== tuneSeq) return; started = true; clearTimeout(watchdog); staticOn(false); $('#nosignal').hidden = true; fitWindow(); };
  video.onended = () => { if (seq === tuneSeq) setTimeout(() => seq === tuneSeq && tune(S.cur.dial, { quiet: true }), 800); };
  const go = () => {
    video.volume = S.volume; video.muted = S.muted;
    const pr = video.play();
    if (pr) pr.catch(e => { if (e && e.name === 'NotAllowedError') showGate(); });
  };

  if (info.mode === 'ts') {
    if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return fail('This browser can’t play live TV');
    const p = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: abs(info.url) },
      { enableWorker: true, enableStashBuffer: true, stashInitialSize: 384 * 1024, liveBufferLatencyChasing: false,
        autoCleanupSourceBuffer: true, autoCleanupMaxBackwardDuration: 60, autoCleanupMinBackwardDuration: 30 });
    p.attachMediaElement(video);
    p.on(mpegts.Events.ERROR, (type, detail) => fail(detail || type));
    p.load();
    S.player = { destroy: () => { try { p.pause(); } catch {} p.unload(); p.detachMediaElement(); p.destroy(); } };
    go();
  } else if (info.mode === 'hls') {
    if (window.Hls && Hls.isSupported()) {
      const h = new Hls({ maxBufferLength: 30, liveSyncDurationCount: 3, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2,
                          startLevel: S.settings?.resolution === 'low' ? 0 : -1 });
      h.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) fail(d.details); });
      // Lower resolution: cap the stream's quality (Standard: up to 480 lines, Low: the smallest one).
      h.on(Hls.Events.MANIFEST_PARSED, (e, d) => {
        const lv = d.levels || [], r = S.settings?.resolution;
        if (!lv.length || r === 'high' || !r) return;
        const order = lv.map((l, i) => ({ i, h: l.height || 0 })).sort((a, b) => a.h - b.h);
        let cap = order[0].i;
        if (r === 'standard') for (const o of order) if (o.h && o.h <= 480) cap = o.i;
        h.autoLevelCapping = cap;
        if (r === 'low') h.currentLevel = cap;
      });
      h.loadSource(abs(info.url));
      h.attachMedia(video);
      S.player = { destroy: () => h.destroy() };
      go();
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = abs(info.url); video.onerror = () => fail('Can’t play this stream'); go();
    } else fail('This browser can’t play HLS');
  } else {
    video.src = abs(info.url); video.onerror = () => fail('Can’t play this stream'); go();
  }
}

function showGate() {
  const g = $('#startgate'); g.hidden = false;
  const start = () => { g.hidden = true; video.play().catch(() => {}); removeEventListener('keydown', start, true); g.removeEventListener('click', start); };
  addEventListener('keydown', start, true); g.addEventListener('click', start);
}

// ------------------------------------------------------------ picture shape
// Modes: fit (whole picture), trim (zoom past black bars inside the picture), fill (fill the
// window, cutting edges), stretch (fill the window, distorted). Z changes it for the channel
// you're on; Settings > Picture shape is the default.
const ZOOMS = ['fit', 'trim', 'fill', 'stretch'];
const ZOOM_NAMES = { fit: 'Fit', trim: 'Trim bars', fill: 'Fill window', stretch: 'Stretch' };
const zoomFor = c => (c && S.settings?.zoomByChannel?.[c.id]) || S.settings?.zoom || 'trim';
const pic = $('#pic');
const T = { box: null, samples: [], timer: 0 };
function resetTrim() { T.box = null; T.samples = []; layout(); }

// Finds the picture inside any black bars, from a small copy of the current frame.
const tcan = document.createElement('canvas'), tctx = tcan.getContext('2d', { willReadFrequently: true });
function sampleBars() {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh || video.paused || video.readyState < 2) return;
  const W = 128, H = Math.max(36, Math.round(128 * vh / vw));
  tcan.width = W; tcan.height = H;
  let d;
  try { tctx.drawImage(video, 0, 0, W, H); d = tctx.getImageData(0, 0, W, H).data; } catch { return; }
  const lum = i => (d[i] * 54 + d[i + 1] * 183 + d[i + 2] * 19) >> 8;
  const colHit = new Array(W).fill(0), rowHit = new Array(H).fill(0);
  let sum = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = lum((y * W + x) * 4); sum += l;
    if (l > 34) { colHit[x]++; rowHit[y]++; }
  }
  if (sum / (W * H) < 14) return;                       // a dark scene says nothing about bars
  const cMin = Math.max(1, H * 0.04), rMin = Math.max(1, W * 0.04);
  let x0 = colHit.findIndex(n => n >= cMin), x1 = W - 1 - [...colHit].reverse().findIndex(n => n >= cMin);
  let y0 = rowHit.findIndex(n => n >= rMin), y1 = H - 1 - [...rowHit].reverse().findIndex(n => n >= rMin);
  if (x0 < 0 || y0 < 0) return;
  const b = { x0: x0 / W, x1: (x1 + 1) / W, y0: y0 / H, y1: (y1 + 1) / H };
  if ((b.x1 - b.x0) < 0.35 || (b.y1 - b.y0) < 0.35) return;
  T.samples.push(b); if (T.samples.length > 8) T.samples.shift();
  // Keep the largest picture seen recently, so one odd frame can't over-zoom.
  const u = T.samples.reduce((a, s) => ({ x0: Math.min(a.x0, s.x0), x1: Math.max(a.x1, s.x1), y0: Math.min(a.y0, s.y0), y1: Math.max(a.y1, s.y1) }));
  const snap = v => (v < 0.025 ? 0 : v > 0.975 ? 1 : v);
  const nb = { x0: snap(u.x0), x1: snap(u.x1), y0: snap(u.y0), y1: snap(u.y1) };
  const old = T.box || { x0: 0, x1: 1, y0: 0, y1: 1 };
  if (Math.abs(nb.x0 - old.x0) + Math.abs(nb.x1 - old.x1) + Math.abs(nb.y0 - old.y0) + Math.abs(nb.y1 - old.y1) > 0.03 || !T.box) { T.box = nb; layout(); }
}
setInterval(() => { if (S.mode !== 'settings') sampleBars(); }, 1500);

function layout() {
  const W = screen.clientWidth, H = screen.clientHeight;
  if (!W || !H) return;
  const mode = zoomFor(S.cur);
  const vw = video.videoWidth || 4, vh = video.videoHeight || 3;
  const box = mode !== 'fit' && T.box ? T.box : { x0: 0, x1: 1, y0: 0, y1: 1 };
  const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
  const a = (bw * vw) / (bh * vh);
  let cw, ch;
  if (mode === 'stretch') { cw = W; ch = H; }
  else if ((mode === 'fill') === (a > W / H)) { ch = H; cw = H * a; }
  else { cw = W; ch = W / a; }
  const pw = Math.min(cw, W), ph = Math.min(ch, H);
  Object.assign(pic.style, { left: (W - pw) / 2 + 'px', top: (H - ph) / 2 + 'px', width: pw + 'px', height: ph + 'px' });
  const vW = cw / bw, vH = ch / bh;
  Object.assign(video.style, { width: vW + 'px', height: vH + 'px', left: ((pw - cw) / 2 - box.x0 * vW) + 'px', top: ((ph - ch) / 2 - box.y0 * vH) + 'px' });
}
new ResizeObserver(() => layout()).observe(screen);
video.addEventListener('loadedmetadata', layout);
video.addEventListener('resize', layout);

function cycleZoom() {
  if (!S.cur) return;
  const next = ZOOMS[(ZOOMS.indexOf(zoomFor(S.cur)) + 1) % ZOOMS.length];
  S.settings.zoomByChannel = { ...(S.settings.zoomByChannel || {}), [S.cur.id]: next };
  saveSetting({ zoomByChannel: S.settings.zoomByChannel });
  layout();
  toast(`Picture: ${ZOOM_NAMES[next]} (channel ${S.cur.dial})`, 1800);
}

// ------------------------------------------------------------ window size
// When not full screen, the desktop window can take the picture's own shape and size
// (the stream's resolution x1, x2 or x3), so there are no black bars around it.
const FIXED = ['640x480', '800x600', '960x720', '1024x768', '1280x960'];
// "Follow picture" (x1-x3) resizes with each channel; a fixed size is set once and then kept
// (dragging still works); "Keep my size" never changes it.
function applyWindowSize() {
  const ws = String(S.settings?.windowScale || 'free');
  if (window.oompasApp?.fitWindow && FIXED.includes(ws)) { const [w, h] = ws.split('x').map(Number); window.oompasApp.fitWindow(w, h); }
  else fitWindow();
}
function fitWindow() {
  if (!window.oompasApp?.fitWindow) return;
  const scale = Number(S.settings?.windowScale);
  if (!scale || !S.cur) return;
  const [, rh] = res();
  let aspect = 4 / 3;
  if (S.cur.kind === 'iptv' && video.videoWidth && video.videoHeight) {
    const b = zoomFor(S.cur) !== 'fit' && T.box ? T.box : { x0: 0, x1: 1, y0: 0, y1: 1 };
    aspect = (video.videoWidth * (b.x1 - b.x0)) / (video.videoHeight * (b.y1 - b.y0));
  }
  window.oompasApp.fitWindow(Math.round(rh * aspect * scale), rh * scale);
}
video.addEventListener('resize', fitWindow);

// ------------------------------------------------------------ starred channels ("My channels")
const favSet = () => new Set(S.settings?.favorites || []);
const isFav = c => !!c && favSet().has(c.id);
function toggleFav(c) {
  if (!c) return;
  const f = favSet();
  const on = !f.has(c.id);
  if (on) f.add(c.id); else f.delete(c.id);
  S.settings.favorites = [...f];
  saveSetting({ favorites: S.settings.favorites }, true);
  toast(on ? `\u2605 ${c.dial} ${c.name} added to My channels` : `${c.dial} ${c.name} removed from My channels`, 2200);
  if (S.mode === 'tv' && !$('#banner').hidden && S.cur?.id === c.id) showBanner(c);
  if (S.mode === 'guide') renderGuide();
  if (S.mode === 'browse') renderBrowse();
}
const isoOf = code => (code === 'uk' ? 'gb' : code);
const country = code => {
  if (!code || code === '?') return 'Unknown country';
  code = isoOf(code);
  try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase()) || code.toUpperCase(); } catch { return code.toUpperCase(); }
};
const flag = code => /^[a-z]{2}$/i.test(code || '') ? String.fromCodePoint(...[...isoOf(code).toUpperCase()].map(ch => 0x1F1A5 + ch.charCodeAt(0))) : '';

function step(dir) {
  let list = S.channels;
  if (S.settings?.surf === 'favorites') { const f = favSet(); const fl = list.filter(c => f.has(c.id)); if (fl.length) list = fl; }
  if (!list.length) return;
  let i = list.findIndex(c => S.cur && c.dial === S.cur.dial);
  i = i < 0 ? 0 : (i + dir + list.length) % list.length;
  tune(list[i].dial);
}

// ------------------------------------------------------------ banner
let bannerT;
function fillProgress(bar, p) {
  const f = p && !p.live ? Math.min(1, Math.max(0, (Date.now() - p.startMs) / (p.endMs - p.startMs))) : 0;
  bar.style.width = (f * 100).toFixed(1) + '%';
}
function showBanner(c = S.cur, ms = 5000) {
  if (!c) return;
  const b = $('#banner');
  b.style.borderLeftColor = c.color || 'var(--lilac)';
  b.querySelector('.b-dial').textContent = c.dial;
  b.querySelector('.b-name').textContent = c.call && c.kind !== 'iptv' ? `${c.name.toUpperCase()}` : c.name;
  const logo = b.querySelector('.b-logo img');
  if (c.logo) { logo.src = c.logo; logo.parentElement.hidden = false; logo.onerror = () => (logo.parentElement.hidden = true); }
  else logo.parentElement.hidden = true;
  b.querySelector('.b-star').hidden = !isFav(c);
  b.querySelector('.b-clock').textContent = hm(Date.now());
  const p = c.now;
  b.querySelector('.b-title').textContent = p ? p.title : (c.kind === 'iptv' ? c.name : 'Off the air');
  b.querySelector('.b-time').textContent = !p ? '' : p.live ? 'LIVE' : `${hm(p.startMs)}-${hm(p.endMs)}`;
  fillProgress(b.querySelector('.b-progress i'), p);
  const kind = [p?.kindLine, c.kind === 'iptv' ? [c.section, c.cats?.join(', '), ...(c.tags || []), c.health === 'bad' ? 'didn\u2019t play in the last check' : ''].filter(Boolean).join(' \u00B7 ') : ''].filter(Boolean).join(' \u00B7 ');
  b.querySelector('.b-kind').textContent = kind;
  b.querySelector('.b-desc').textContent = p?.live ? '' : (p?.sub || p?.desc || c.description || '');
  b.querySelector('.b-next').textContent = c.next && !c.next.live ? `Next: ${c.next.title}  ${hmLower(c.next.startMs)}` : '';
  b.hidden = false;
  clearTimeout(bannerT);
  bannerT = setTimeout(() => (b.hidden = true), ms);
}
const hideBanner = () => { clearTimeout(bannerT); $('#banner').hidden = true; };

// ------------------------------------------------------------ number entry
let digitBuf = '', digitT;
function digit(d) {
  digitBuf = (digitBuf + d).slice(-4);
  const box = $('#digits');
  box.textContent = digitBuf + '-';
  box.hidden = false;
  clearTimeout(digitT);
  const maxLen = String(S.channels.at(-1)?.dial || 99).length;
  if (digitBuf.length >= maxLen) digitT = setTimeout(commitDigits, 350);
  else digitT = setTimeout(commitDigits, 1600);
}
function commitDigits() {
  clearTimeout(digitT);
  const d = digitBuf; digitBuf = '';
  $('#digits').hidden = true;
  if (d) tune(String(Number(d)));
}

// ------------------------------------------------------------ volume
let volT;
function setVolume(v) {
  S.volume = Math.round(Math.min(1, Math.max(0, v)) * 20) / 20;
  S.muted = false;
  video.volume = S.volume; video.muted = false;
  showVolume();
  saveSetting({ volume: S.volume });
}
function showVolume() {
  const box = $('#volume'), bars = box.querySelector('.bars');
  bars.innerHTML = '';
  for (let i = 0; i < 20; i++) { const b = el('i'); if (!S.muted && i < Math.round(S.volume * 20)) b.className = 'on'; bars.append(b); }
  box.querySelector('.vt').textContent = S.muted ? 'MUTE' : 'VOLUME';
  box.hidden = false;
  clearTimeout(volT); volT = setTimeout(() => (box.hidden = true), 1500);
}
function toggleMute() { S.muted = !S.muted; video.muted = S.muted; showVolume(); }

// ------------------------------------------------------------ guide
const G = { filter: 'all', row: 0, top: 0, t0: 0, at: 0, onFilters: false, cache: new Map(), fetching: null };
const ROWS = 6;
function filters() {
  const out = [{ id: 'all', name: 'All channels' }];
  if (favSet().size) out.push({ id: 'fav', name: '\u2605 My channels' });
  const seen = new Set();
  for (const c of S.channels) {
    const id = c.kind === 'iptv' ? 'iptv:' + c.section : c.kind;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: c.kind === 'iptv' ? c.section : c.section });
  }
  return out;
}
function guideList() {
  if (G.filter === 'all') return S.channels;
  if (G.filter === 'fav') { const f = favSet(); return S.channels.filter(c => f.has(c.id)); }
  return S.channels.filter(c => (c.kind === 'iptv' ? 'iptv:' + c.section : c.kind) === G.filter);
}
function placePip() {
  if (S.mode !== 'guide') { screen.style.cssText = ''; return; }
  const r = $('.g-pip').getBoundingClientRect();
  Object.assign(screen.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
async function openGuide() {
  closeAll();
  S.mode = 'guide';
  hideBanner();
  document.body.classList.add('guide-open');
  $('#guide').hidden = false;
  G.t0 = Math.floor(Date.now() / HALF) * HALF;
  G.at = Date.now();
  G.onFilters = false;
  let list = guideList();
  if (S.cur && !list.some(c => c.dial === S.cur.dial)) { G.filter = 'all'; list = guideList(); }
  G.row = Math.max(0, list.findIndex(c => S.cur && c.dial === S.cur.dial));
  G.top = Math.max(0, Math.min(G.row - 2, list.length - ROWS));
  requestAnimationFrame(placePip);
  renderGuide();
  loadChannels().then(renderGuide).catch(() => {});
}
function closeGuide() {
  S.mode = 'tv';
  $('#guide').hidden = true;
  document.body.classList.remove('guide-open');
  screen.style.cssText = '';
}
function progsFor(c) {
  const e = G.cache.get(c.dial);
  if (e && e.from <= G.t0 && e.until >= G.t0 + SPAN) return e.progs;
  // Meanwhile, what we know from the channel list
  return [c.now, c.next].filter(Boolean);
}
function fetchGuide(list) {
  const need = list.filter(c => { const e = G.cache.get(c.dial); return !(e && e.from <= G.t0 && e.until >= G.t0 + SPAN); });
  if (!need.length) return;
  const from = G.t0, until = G.t0 + 3 * 3600e3;
  const key = need.map(c => c.dial).join(',') + '@' + from;
  if (G.fetching === key) return;
  G.fetching = key;
  api(`/api/guide?dials=${need.map(c => encodeURIComponent(c.dial)).join(',')}&from=${from}&until=${until}`).then(d => {
    for (const c of need) G.cache.set(c.dial, { from, until, progs: d[c.dial] || [] });
    if (G.fetching === key) G.fetching = null;
    if (S.mode === 'guide') renderGuide();
  }).catch(() => { G.fetching = null; });
}
function selectedProg(c) {
  const ps = progsFor(c);
  return ps.find(p => p.startMs <= G.at && p.endMs > G.at) || null;
}
function renderGuide() {
  if (S.mode !== 'guide') return;
  const list = guideList();
  $('.g-clock').textContent = hm(Date.now());
  // filters
  const fl = $('.g-filters'); fl.innerHTML = ''; fl.classList.toggle('focus', G.onFilters);
  for (const f of filters()) { const s = el('span', f.id === G.filter ? 'on' : '', f.name); s.onclick = () => { G.filter = f.id; G.row = 0; G.top = 0; renderGuide(); }; fl.append(s); }
  // time header
  const th = $('.g-times'); th.innerHTML = '';
  th.append(el('span', '', new Date(G.t0).toDateString() === new Date().toDateString() ? 'TODAY' : new Date(G.t0).toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()));
  for (let i = 0; i < 3; i++) th.append(el('span', '', hm(G.t0 + i * HALF)));
  // rows
  const rows = $('.g-rows'); rows.innerHTML = '';
  if (!list.length) { rows.append(el('div', 'g-empty', 'No channels here yet.')); return; }
  G.row = Math.min(G.row, list.length - 1);
  if (G.row < G.top) G.top = G.row;
  if (G.row >= G.top + ROWS) G.top = G.row - ROWS + 1;
  const vis = list.slice(G.top, G.top + ROWS);
  fetchGuide(vis);
  const pastel = ['#ffb3b3', '#ffcfa3', '#fff0a3', '#bff0c8', '#b3dcff', '#d5c6ff', '#ffc6ea'];
  vis.forEach((c, i) => {
    const r = el('div', 'g-row');
    const tab = el('div', 'g-tab');
    tab.style.background = pastel[(G.top + i) % 7];
    tab.style.borderLeftColor = c.color || 'transparent';
    tab.append(el('b', '', c.dial));
    if (isFav(c)) tab.append(el('span', 'star', '\u2605'));
    if (c.kind === 'iptv' && c.logo) { const im = el('img'); im.src = c.logo; im.alt = ''; im.onerror = () => { im.replaceWith(el('small', '', c.name)); }; tab.append(im); }
    else tab.append(el('small', '', c.kind === 'iptv' ? c.name : (c.call || c.name)));
    tab.onclick = () => { G.row = G.top + i; G.onFilters = false; renderGuide(); };
    tab.ondblclick = () => { tune(c.dial); closeGuide(); };
    const progs = el('div', 'g-progs');
    const rowSel = G.top + i === G.row && !G.onFilters;
    for (const p of progsFor(c)) {
      if (p.endMs <= G.t0 || p.startMs >= G.t0 + SPAN) continue;
      const a = Math.max(p.startMs, G.t0), b = Math.min(p.endMs, G.t0 + SPAN);
      const cell = el('div', 'g-prog' + (p.live ? ' live' : '') + (p.endMs - p.startMs >= 75 * 60000 && !p.live ? ' movie' : '') +
                             (p.startMs < G.t0 ? ' cont' : '') + (rowSel && p.startMs <= G.at && p.endMs > G.at ? ' sel' : ''), p.title);
      cell.style.left = ((a - G.t0) / SPAN * 100) + '%';
      cell.style.width = ((b - a) / SPAN * 100) + '%';
      cell.onclick = () => { G.row = G.top + i; G.at = Math.max(p.startMs, Date.now()); G.onFilters = false; renderGuide(); };
      cell.ondblclick = () => { tune(c.dial); closeGuide(); };
      progs.append(cell);
    }
    r.append(tab, progs);
    rows.append(r);
  });
  // info panel
  const c = list[G.row];
  const p = selectedProg(c);
  $('.gi-chan').textContent = `${c.dial}  ${c.name}`;
  $('.gi-time').textContent = p ? (p.live ? 'LIVE' : `${hm(p.startMs)}-${hm(p.endMs)}`) : '';
  $('.gi-title').textContent = p ? p.title : 'Nothing listed';
  const isNow = p && c.now && p.startMs === c.now.startMs;
  $('.gi-sub').textContent = isNow ? (c.now.sub || c.now.desc || '') : (p?.sub || '');
  fillProgress($('.gi-bar i'), p && p.startMs <= Date.now() ? p : null);
  const ps = progsFor(c), nx = p ? ps.find(q => q.startMs >= p.endMs) : null;
  $('.gi-next').textContent = nx && !nx.live ? `Next: ${nx.title}` : '';
}
function guideKey(k) {
  const list = guideList();
  if (G.onFilters) {
    const fs = filters(), i = fs.findIndex(f => f.id === G.filter);
    if (k === 'left' || k === 'right') { G.filter = fs[(i + (k === 'left' ? -1 : 1) + fs.length) % fs.length].id; G.row = 0; G.top = 0; }
    else if (k === 'down' || k === 'ok') G.onFilters = false;
    else if (k === 'back') return closeGuide();
    return renderGuide();
  }
  const c = list[G.row];
  switch (k) {
    case 'up': if (G.row === 0) G.onFilters = true; else G.row--; break;
    case 'down': G.row = Math.min(list.length - 1, G.row + 1); break;
    case 'pageup': G.row = Math.max(0, G.row - ROWS); break;
    case 'pagedown': G.row = Math.min(list.length - 1, G.row + ROWS); break;
    case 'right': {
      const p = c && selectedProg(c);
      G.at = p ? p.endMs : G.at + HALF;
      while (G.at >= G.t0 + SPAN) G.t0 += HALF;
      break;
    }
    case 'left': {
      const p = c && selectedProg(c);
      const target = (p ? p.startMs : G.at) - 1;
      if (target < Date.now()) { G.at = Date.now(); G.t0 = Math.floor(Date.now() / HALF) * HALF; break; }
      G.at = target;
      while (G.at < G.t0) G.t0 -= HALF;
      break;
    }
    case 'ok': if (c) { tune(c.dial); closeGuide(); } return;
    case 'back': case 'guide': return closeGuide();
    case 'settings': closeGuide(); return openSettings();
    case 'star': return toggleFav(c);
    case 'browse': closeGuide(); return openBrowse();
  }
  renderGuide();
}

// ------------------------------------------------------------ channel browser
const B = { cat: 0, row: 0, ctop: 0, rtop: 0, focus: 'cats', cats: [] };
const BR_ROWS = 9, BR_CATS = 11;
function browseCats() {
  const f = favSet(), ch = S.channels, out = [];
  const add = (id, name, test) => { const n = ch.filter(test).length; if (n || id === 'fav') out.push({ id, name, test, n }); };
  add('fav', '\u2605 My channels', c => f.has(c.id));
  add('all', 'All channels', () => true);
  add('oompas', 'OOMPAS Box', c => c.kind === 'oompas');
  add('spelunkr', 'Spelunkr', c => c.kind === 'spelunkr');
  const iptv = ch.filter(c => c.kind === 'iptv');
  if (iptv.length) {
    const lists = [...new Set(iptv.map(c => c.section))];
    for (const name of lists) add('list:' + name, `\u25B8 ${name}`, c => c.kind === 'iptv' && c.section === name);
    add('iptv', 'IPTV \u00B7 all', c => c.kind === 'iptv');
    const cats = new Map();
    for (const c of iptv) for (const k of (c.cats?.length ? c.cats : ['Other'])) cats.set(k, (cats.get(k) || 0) + 1);
    for (const [k] of [...cats].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
      add('cat:' + k, k, c => c.kind === 'iptv' && (c.cats?.length ? c.cats.includes(k) : k === 'Other'));
    const countries = new Map();
    for (const c of iptv) countries.set(c.country || '?', (countries.get(c.country || '?') || 0) + 1);
    if (countries.size > 1)
      for (const [k] of [...countries].sort((a, b) => b[1] - a[1]))
        add('cty:' + k, `${flag(k)} ${country(k)}`.trim(), c => c.kind === 'iptv' && (c.country || '?') === k);
  }
  return out;
}
function openBrowse(catId) {
  closeAll();
  S.mode = 'browse';
  hideBanner();
  $('#browse').hidden = false;
  B.cats = browseCats();
  let ci = B.cats.findIndex(x => x.id === (catId || B.lastCat));
  if (ci < 0) ci = B.cats.findIndex(x => x.id === (S.cur?.kind === 'iptv' ? 'iptv' : favSet().size ? 'fav' : 'all'));
  B.cat = Math.max(0, ci);
  const list = browseList();
  const ri = list.findIndex(c => S.cur && c.dial === S.cur.dial);
  B.row = Math.max(0, ri);
  B.focus = list.length ? 'list' : 'cats';
  B.rtop = Math.max(0, B.row - 3); B.ctop = Math.max(0, B.cat - BR_CATS + 1);
  renderBrowse();
}
function closeBrowse() { S.mode = 'tv'; $('#browse').hidden = true; }
const browseList = () => { const c = B.cats[B.cat]; return c ? S.channels.filter(c.test) : []; };
function renderBrowse() {
  if (S.mode !== 'browse') return;
  B.cats = browseCats();
  B.cat = Math.min(B.cat, B.cats.length - 1);
  B.lastCat = B.cats[B.cat]?.id;
  const cbox = $('.br-cats'), lbox = $('.br-list');
  cbox.classList.toggle('focus', B.focus === 'cats');
  cbox.innerHTML = ''; lbox.innerHTML = '';
  if (B.cat < B.ctop) B.ctop = B.cat;
  if (B.cat >= B.ctop + BR_CATS) B.ctop = B.cat - BR_CATS + 1;
  B.cats.slice(B.ctop, B.ctop + BR_CATS).forEach((c, i) => {
    const idx = B.ctop + i;
    const row = el('div', 'br-cat' + (idx === B.cat ? ' sel' : ''), c.name);
    row.append(el('span', 'n', c.n));
    row.onclick = () => { B.cat = idx; B.row = 0; B.rtop = 0; B.focus = 'cats'; renderBrowse(); };
    cbox.append(row);
  });
  const list = browseList();
  if (!list.length) {
    lbox.append(el('div', 'br-empty', B.cats[B.cat]?.id === 'fav'
      ? 'No starred channels yet. Hold OK (or press *) on a channel to star it.' : 'No channels here.'));
    return;
  }
  B.row = Math.min(B.row, list.length - 1);
  if (B.row < B.rtop) B.rtop = B.row;
  if (B.row >= B.rtop + BR_ROWS) B.rtop = B.row - BR_ROWS + 1;
  const f = favSet();
  list.slice(B.rtop, B.rtop + BR_ROWS).forEach((c, i) => {
    const idx = B.rtop + i;
    const row = el('div', 'br-row' + (idx === B.row && B.focus === 'list' ? ' sel' : '') + (S.cur?.dial === c.dial ? ' cur' : '') + (c.health === 'bad' ? ' bad' : ''));
    const st = el('span', 'st' + (f.has(c.id) ? ' on' : ''), f.has(c.id) ? '\u2605' : '\u2606');
    st.onclick = e => { e.stopPropagation(); toggleFav(c); };
    const lg = el('span', 'lg');
    if (c.logo) { const im = el('img'); im.src = c.logo; im.alt = ''; im.onerror = () => im.remove(); lg.append(im); }
    const nm = el('div', 'nm', c.name);
    const what = c.now && !c.now.live ? c.now.title : [c.cats?.join(', '), c.kind === 'iptv' && c.country ? country(c.country) : ''].filter(Boolean).join(' \u00B7 ') || c.section;
    const extra = [c.health === 'bad' ? `\u2715 didn\u2019t play (${c.healthWhy || 'no picture'})` : '', ...(c.tags || [])].filter(Boolean).join(' \u00B7 ');
    nm.append(el('small', '', [extra, what].filter(Boolean).join(' \u00B7 ')));
    row.append(st, el('span', 'dl', c.dial), lg, nm);
    row.onclick = () => { B.row = idx; B.focus = 'list'; renderBrowse(); };
    row.ondblclick = () => { tune(c.dial); closeBrowse(); };
    lbox.append(row);
  });
}
function browseKey(k) {
  const list = browseList();
  if (k === 'back' || k === 'browse') { if (B.focus === 'list' && k === 'back') { B.focus = 'cats'; return renderBrowse(); } return closeBrowse(); }
  if (k === 'guide') { closeBrowse(); return openGuide(); }
  if (k === 'settings') { closeBrowse(); return openSettings(); }
  if (B.focus === 'cats') {
    if (k === 'up') B.cat = Math.max(0, B.cat - 1);
    else if (k === 'down') B.cat = Math.min(B.cats.length - 1, B.cat + 1);
    else if (k === 'pageup') B.cat = Math.max(0, B.cat - BR_CATS);
    else if (k === 'pagedown') B.cat = Math.min(B.cats.length - 1, B.cat + BR_CATS);
    else if ((k === 'right' || k === 'ok') && list.length) { B.focus = 'list'; }
    if (k === 'up' || k === 'down' || k === 'pageup' || k === 'pagedown') { B.row = 0; B.rtop = 0; }
    return renderBrowse();
  }
  const c = list[B.row];
  switch (k) {
    case 'up': B.row = Math.max(0, B.row - 1); break;
    case 'down': B.row = Math.min(list.length - 1, B.row + 1); break;
    case 'pageup': B.row = Math.max(0, B.row - BR_ROWS); break;
    case 'pagedown': B.row = Math.min(list.length - 1, B.row + BR_ROWS); break;
    case 'left': B.focus = 'cats'; break;
    case 'ok': if (c) { tune(c.dial); closeBrowse(); } return;
    case 'star': return toggleFav(c);
  }
  renderBrowse();
}

// ------------------------------------------------------------ settings
const P = { stack: [], sel: 0, data: {}, confirm: null, logTimer: 0 };
function openSettings(page = 'main') {
  closeAll();
  S.mode = 'settings';
  hideBanner();
  $('#settings').hidden = false;
  P.stack = [{ page, sel: 0 }];
  P.sel = 0;
  loadState().then(renderSettings).catch(() => renderSettings());
  renderSettings();
}
function closeSettings() { S.mode = 'tv'; $('#settings').hidden = true; clearInterval(P.logTimer); }
function goPage(page, extra = {}) { $('.s-list').style.top = '0px'; P.stack.at(-1).sel = P.sel; P.stack.push({ page, sel: 0, ...extra }); P.sel = 0; P.confirm = null; renderSettings(); }
function backPage() {
  clearInterval(P.logTimer);
  if (P.stack.length <= 1) return closeSettings();
  P.stack.pop(); P.sel = P.stack.at(-1).sel || 0; P.confirm = null; $('.s-list').style.top = '0px'; renderSettings();
}
const onOff = v => (v ? 'On' : 'Off');
const iptvSet = () => S.settings.iptv;
async function setIptv(patch, reload = false) {
  const next = { ...iptvSet(), ...patch };
  S.settings.iptv = next;
  renderSettings();
  await saveSetting({ iptv: next }, true);
  if (reload === true) await reloadIptv();
  else if (reload === 'light') { await loadChannels().catch(() => {}); await loadState().catch(() => {}); renderSettings(); }
}
async function reloadIptv() {
  toast('Loading playlists…', 60000);
  try {
    const r = await post('/api/iptv/refresh');
    await loadChannels(); await loadState();
    const bad = r.iptv.filter(l => l.enabled && l.error);
    toast(`${r.iptvChannels} IPTV channels` + (bad.length ? ` · couldn’t load: ${bad.map(b => b.name).join(', ')}` : ''), 5000);
  } catch (e) { toast('Couldn’t load playlists: ' + e.message); }
  renderSettings();
}
function pageRows() {
  const st = S.settings, srv = S.server || {}, cur = P.stack.at(-1);
  const R = [];
  const sec = t => R.push({ type: 'sec', label: t });
  if (cur.page === 'main') {
    sec('Picture');
    R.push({ type: 'choice', label: 'Widescreen videos', sub: 'How widescreen shows fit the 4:3 channels', values: ['fit', 'zoom', 'fill'],
             names: { fit: 'Fit', zoom: 'Zoom', fill: 'Fill' }, get: () => st.widescreen, set: v => { st.widescreen = v; saveSetting({ widescreen: v }); toast('Applies from the next show (or re-tune)'); } });
    R.push({ type: 'choice', label: 'Picture shape', sub: 'Trim bars zooms past black bars inside a picture. Z changes it per channel', values: ZOOMS,
             names: ZOOM_NAMES, get: () => st.zoom || 'trim', set: v => { st.zoom = v; saveSetting({ zoom: v }); layout(); } });
    if (Object.keys(st.zoomByChannel || {}).length)
      R.push({ type: 'btn', label: 'Forget per-channel picture shapes', val: `${Object.keys(st.zoomByChannel).length}`, act: () => { st.zoomByChannel = {}; saveSetting({ zoomByChannel: {} }); layout(); toast('Every channel uses the default shape again'); renderSettings(); } });
    R.push({ type: 'choice', label: 'Stream resolution', sub: 'Lower uses less CPU and network, and Low has a soft vintage look', values: ['high', 'standard', 'low'],
             names: { high: 'High 960\u00D7720', standard: 'Standard 640\u00D7480', low: 'Low 320\u00D7240' }, get: () => st.resolution || 'high',
             set: v => { st.resolution = v; saveSetting({ resolution: v }, true).then(() => { if (S.cur) tune(S.cur.dial, { quiet: true }); }); } });
    if (window.oompasApp?.fitWindow)
      R.push({ type: 'choice', label: 'Window size', sub: 'A size here (or View \u2192 Window Size) is kept until you change it. \u201CFollow picture\u201D resizes with each channel', values: ['free', ...FIXED, '1', '2', '3'],
               names: { free: 'Keep my size', 1: 'Follow picture \u00D71', 2: 'Follow picture \u00D72', 3: 'Follow picture \u00D73', ...Object.fromEntries(FIXED.map(f => [f, f.replace('x', '\u00D7')])) }, get: () => String(st.windowScale || 'free'),
               set: v => { st.windowScale = v; saveSetting({ windowScale: v }); applyWindowSize(); } });
    R.push({ type: 'toggle', label: 'Trim black bars', sub: 'Removes bars baked into old videos', get: () => st.bars !== false, set: v => { st.bars = v; saveSetting({ bars: v }); } });
    R.push({ type: 'toggle', label: 'CRT look', sub: 'Scanlines and a softer picture in this app', get: () => st.crt !== false, set: v => { st.crt = v; screen.classList.toggle('crt', v); saveSetting({ crt: v }); } });
    R.push({ type: 'toggle', label: 'Channel banner', sub: 'Show what’s on when you change channel', get: () => st.banner !== false, set: v => { st.banner = v; saveSetting({ banner: v }); } });
    sec('Channels');
    R.push({ type: 'choice', label: 'OOMPAS Box channels', sub: 'The Internet Archive channels, and the Guide & Weather channels. Spelunkr\u2019s channels always stay', values: ['off', 'guide', 'all'],
             names: { off: 'Off', guide: 'Guide & Weather', all: 'All' }, get: () => st.oompas || 'off',
             set: v => { st.oompas = v; saveSetting({ oompas: v }, true).then(() => loadChannels()).then(() => renderSettings()).catch(() => {}); } });
    R.push({ type: 'btn', label: 'Channel list\u2026', sub: 'Browse by category, country or My channels (or press C)', val: '\u25B8', act: () => { closeSettings(); openBrowse(); } });
    R.push({ type: 'choice', label: 'Channel up/down goes through', sub: 'Star channels with a long press on OK (or *)', values: ['all', 'favorites'],
             names: { all: 'All channels', favorites: 'My channels' }, get: () => st.surf || 'all', set: v => { st.surf = v; saveSetting({ surf: v }); } });
    R.push({ type: 'info', label: 'My channels', val: `${(st.favorites || []).length} starred` });
    sec('IPTV');
    R.push({ type: 'toggle', label: 'IPTV channels', sub: srv.iptvChannels ? `${srv.iptvChannels} channels from your playlists` : 'Live channels from M3U playlists', get: () => !!iptvSet().enabled, set: v => setIptv({ enabled: v }, true) });
    R.push({ type: 'btn', label: 'Free channel lists…', sub: 'Public free channels (iptv-org), by category or country', val: `${iptvSet().lists.filter(l => l.builtin).length} on`, act: () => goPage('catalog') });
    R.push({ type: 'btn', label: 'Add your own playlist…', sub: 'An M3U link or file from your provider', val: '+', act: () => goPage('add') });
    for (const l of iptvSet().lists) {
      const s = (srv.iptv || []).find(x => x.id === l.id);
      R.push({ type: 'btn', label: l.name, sub: l.builtin ? 'Free list' : l.url, val: l.enabled === false ? 'Off' : s?.error ? 'Error' : s ? `${s.channels} ch` : '…', act: () => goPage('list', { id: l.id }) });
    }
    const cs = iptvSet().countries || [];
    R.push({ type: 'btn', label: 'Countries\u2026', sub: 'Only show channels from the countries you pick', val: cs.length ? cs.map(x => x.toUpperCase()).slice(0, 4).join(' ') + (cs.length > 4 ? ' \u2026' : '') : 'All', act: () => goPage('countries') });
    const ls = iptvSet().languages || [];
    R.push({ type: 'btn', label: 'Languages\u2026', sub: 'Only show channels in the languages you pick', val: ls.length ? ls.slice(0, 3).join(', ') + (ls.length > 3 ? ' \u2026' : '') : 'All', act: () => goPage('languages') });
    const ks = iptvSet().categories || [];
    R.push({ type: 'btn', label: 'Categories\u2026', sub: 'Only show channels in the categories you pick (and in your countries)', val: ks.length ? ks.slice(0, 3).join(', ') + (ks.length > 3 ? ' \u2026' : '') : 'All', act: () => goPage('categories') });
    const ck = srv.iptvCheck;
    R.push({ type: 'btn', label: 'Check which channels play', sub: 'Tests every IPTV channel from this PC (takes a minute or two)',
             val: ck?.running ? `Checking ${ck.done}/${ck.total}` : ck?.at ? `${ck.ok} play \u00B7 ${ck.bad} don\u2019t` : '\u25B8', act: startCheck });
    R.push({ type: 'toggle', label: 'Hide channels that don\u2019t play', sub: 'Uses the last check (re-check now and then: streams come and go)', get: () => !!iptvSet().hideBroken, set: v => setIptv({ hideBroken: v }, 'light') });
    R.push({ type: 'toggle', label: 'Free TV guides', sub: srv.iptvGuides ? `Schedules for ${srv.iptvGuides} channels (Pluto, Samsung, Plex, Roku guides)` : 'Show what\u2019s on, from the free Pluto, Samsung, Plex and Roku guides', get: () => iptvSet().freeGuides !== false, set: v => setIptv({ freeGuides: v }, true) });
    R.push({ type: 'choice', label: 'IPTV starts at channel', values: [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], get: () => iptvSet().dialStart, set: v => setIptv({ dialStart: v }, 'light') });
    R.push({ type: 'toggle', label: 'Hide adult channels', get: () => iptvSet().hideAdult !== false, set: v => setIptv({ hideAdult: v }, 'light') });
    R.push({ type: 'btn', label: 'Reload playlists', val: '↻', act: reloadIptv });
    R.push({ type: 'btn', label: 'Server log', sub: 'What the OOMPAS engine is doing (for troubleshooting)', val: '▸', act: () => goPage('log') });
    sec('App');
    R.push({ type: 'btn', label: 'Full screen', sub: 'Or press F', val: '⛶', act: toggleFullscreen });
    R.push({ type: 'info', label: 'Keys', sub: '↑↓ channels · 0-9 number · G guide \u00B7 C channel list \u00B7 OK info \u00B7 hold OK or * star \u00B7 ←→ volume · Z picture shape · M mute · Back last channel · S settings', val: '' });
  } else if (cur.page === 'catalog') {
    sec('Free channel lists (iptv-org)');
    R.push({ type: 'info', label: 'Public, free-to-air streams collected by the iptv-org project', sub: 'Channels come and go; some may not play', val: '' });
    let group = '';
    for (const item of srv.catalog || []) {
      if (item.group !== group) { group = item.group; sec(group); }
      R.push({ type: 'toggle', label: item.name, get: () => iptvSet().lists.some(l => l.id === item.id), set: v => {
        const lists = iptvSet().lists.filter(l => l.id !== item.id);
        if (v) lists.push({ id: item.id, name: `${item.name} (iptv-org)`, url: item.url, epg: '', enabled: true, builtin: true });
        setIptv({ lists, enabled: v ? true : iptvSet().enabled }, true);
      } });
    }
  } else if (cur.page === 'countries') {
    sec('Countries');
    const counts = srv.iptvCountries || {};
    const codes = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    R.push({ type: 'toggle', label: 'All countries', sub: 'Turn this off by picking countries below', get: () => !(iptvSet().countries || []).length, set: v => { if (v) setIptv({ countries: [] }, 'light'); } });
    if (!codes.length) R.push({ type: 'info', label: 'Turn on a channel list first', val: '' });
    for (const code of codes) {
      R.push({ type: 'toggle', label: `${flag(code)} ${country(code)}`.trim(), sub: `${counts[code]} channel${counts[code] === 1 ? "" : "s"}`, get: () => (iptvSet().countries || []).includes(code), set: v => {
        const now = new Set(iptvSet().countries || []);
        if (v) now.add(code); else now.delete(code);
        setIptv({ countries: [...now] }, 'light');
      } });
    }
  } else if (cur.page === 'languages') {
    sec('Languages');
    const counts = srv.iptvLanguages || {};
    const names = Object.keys(counts).sort((a, b) => (a === 'Unknown') - (b === 'Unknown') || counts[b] - counts[a] || a.localeCompare(b));
    const cs = iptvSet().countries || [];
    R.push({ type: 'info', label: cs.length ? `Channels from ${cs.map(x => country(x)).join(', ')}` : 'Channels from all countries',
             sub: 'From iptv-org\u2019s language data. Pick several: a channel shows if it\u2019s in any of them', val: '' });
    R.push({ type: 'toggle', label: 'All languages', get: () => !(iptvSet().languages || []).length, set: v => { if (v) setIptv({ languages: [] }, 'light'); } });
    if (!names.length) R.push({ type: 'info', label: 'Turn on a channel list first', val: '' });
    const lower = () => new Set((iptvSet().languages || []).map(x => x.toLowerCase()));
    for (const name of names) {
      R.push({ type: 'toggle', label: name, sub: `${counts[name]} channel${counts[name] === 1 ? '' : 's'}`, get: () => lower().has(name.toLowerCase()), set: v => {
        const now = (iptvSet().languages || []).filter(x => x.toLowerCase() !== name.toLowerCase());
        if (v) now.push(name);
        setIptv({ languages: now }, 'light');
      } });
    }
  } else if (cur.page === 'categories') {
    sec('Categories');
    const counts = srv.iptvCategories || {};
    const names = Object.keys(counts).sort((a, b) => (a === 'Other') - (b === 'Other') || counts[b] - counts[a] || a.localeCompare(b));
    const cs = iptvSet().countries || [];
    R.push({ type: 'info', label: cs.length ? `Channels from ${cs.map(x => country(x)).join(', ')}` : 'Channels from all countries',
             sub: 'Pick several: a channel shows if it\u2019s in any of them', val: '' });
    R.push({ type: 'toggle', label: 'All categories', get: () => !(iptvSet().categories || []).length, set: v => { if (v) setIptv({ categories: [] }, 'light'); } });
    if (!names.length) R.push({ type: 'info', label: 'Turn on a channel list first', val: '' });
    const lower = () => new Set((iptvSet().categories || []).map(x => x.toLowerCase()));
    for (const name of names) {
      R.push({ type: 'toggle', label: name, sub: `${counts[name]} channel${counts[name] === 1 ? '' : 's'}`, get: () => lower().has(name.toLowerCase()), set: v => {
        const now = (iptvSet().categories || []).filter(x => x.toLowerCase() !== name.toLowerCase());
        if (v) now.push(name);
        setIptv({ categories: now }, 'light');
      } });
    }
  } else if (cur.page === 'add') {
    sec('Add a playlist');
    P.data.name ??= ''; P.data.url ??= ''; P.data.epg ??= '';
    R.push({ type: 'input', label: 'Name', key: 'name', ph: 'My channels' });
    R.push({ type: 'input', label: 'M3U link', key: 'url', ph: 'https://…/playlist.m3u  or a file path' });
    R.push({ type: 'input', label: 'Guide link (optional)', key: 'epg', ph: 'XMLTV https://…/guide.xml(.gz)' });
    R.push({ type: 'btn', label: 'Add playlist', val: '✓', act: async () => {
      const url = P.data.url.trim();
      if (!url) return toast('Type the playlist’s link first');
      const lists = [...iptvSet().lists, { id: 'my-' + Date.now().toString(36), name: P.data.name.trim() || 'My playlist', url, epg: P.data.epg.trim(), enabled: true }];
      P.data = {};
      backPage();
      await setIptv({ lists, enabled: true }, true);
    } });
    R.push({ type: 'btn', label: 'Cancel', val: '', act: () => { P.data = {}; backPage(); } });
  } else if (cur.page === 'list') {
    const l = iptvSet().lists.find(x => x.id === cur.id);
    if (!l) { setTimeout(backPage); return R; }
    const s = (srv.iptv || []).find(x => x.id === l.id);
    sec(l.name);
    R.push({ type: 'info', label: l.builtin ? 'Free list' : 'Link', sub: l.url, val: s ? (s.error ? 'Error: ' + s.error : `${s.channels} channels`) : '' });
    R.push({ type: 'toggle', label: 'Use this playlist', get: () => l.enabled !== false, set: v => { l.enabled = v; setIptv({ lists: [...iptvSet().lists] }, true); } });
    if (!l.builtin) {
      P.data.epg ??= l.epg || '';
      R.push({ type: 'input', label: 'Guide link (optional)', key: 'epg', ph: 'XMLTV link' });
      R.push({ type: 'btn', label: 'Save guide link', val: '✓', act: () => { l.epg = P.data.epg.trim(); P.data = {}; setIptv({ lists: [...iptvSet().lists] }, true); } });
    }
    R.push({ type: 'btn', label: P.confirm === l.id ? 'Press OK again to remove' : 'Remove playlist', val: '✕', act: () => {
      if (P.confirm !== l.id) { P.confirm = l.id; return renderSettings(); }
      P.confirm = null; P.data = {};
      backPage();
      setIptv({ lists: iptvSet().lists.filter(x => x.id !== l.id) }, true);
    } });
  } else if (cur.page === 'log') {
    sec('Server log');
    R.push({ type: 'log' });
  }
  return R;
}
let checkPoll = 0;
async function startCheck() {
  try { await post('/api/iptv/check'); } catch (e) { return toast('Couldn\u2019t start the check: ' + e.message); }
  toast('Checking IPTV channels\u2026 you can keep watching', 3000);
  clearInterval(checkPoll);
  checkPoll = setInterval(async () => {
    try {
      await loadState();
      if (S.mode === 'settings') renderSettings();
      if (!S.server.iptvCheck?.running) {
        clearInterval(checkPoll);
        await loadChannels();
        const ck = S.server.iptvCheck;
        toast(`Channel check done: ${ck.ok} play, ${ck.bad} don\u2019t` + (ck.bad && !iptvSet().hideBroken ? ' (Settings: Hide channels that don\u2019t play)' : ''), 6000);
        if (S.mode === 'settings') renderSettings();
        if (S.mode === 'browse') renderBrowse();
      }
    } catch {}
  }, 1500);
}
function selectable(r) { return r.type !== 'sec' && r.type !== 'info' && r.type !== 'log'; }
let rowsCache = [];
function renderSettings() {
  if (S.mode !== 'settings' || !S.settings) return;
  const list = $('.s-list');
  const rows = rowsCache = pageRows();
  const sel = rows.map((r, i) => (selectable(r) ? i : -1)).filter(i => i >= 0);
  if (sel.length && !sel.includes(P.sel)) P.sel = sel.find(i => i >= P.sel) ?? sel.at(-1);
  list.innerHTML = '';
  let selEl = null;
  rows.forEach((r, i) => {
    if (r.type === 'sec') { list.append(el('div', 's-sec', r.label)); return; }
    if (r.type === 'log') {
      const box = el('div', 's-log', '…'); list.append(box);
      const load = () => api('/api/log').then(d => { box.textContent = d.lines.slice(-60).join('\n'); }).catch(() => {});
      load(); clearInterval(P.logTimer); P.logTimer = setInterval(load, 2000);
      return;
    }
    const row = el('div', 's-row' + (r.type === 'btn' ? ' btn' : '') + (r.type === 'info' ? ' info' : '') + (i === P.sel ? ' sel' : ''));
    const lab = el('div', 'lab', r.label); if (r.sub) lab.append(el('small', '', r.sub));
    row.append(lab);
    if (r.type === 'input') {
      const inp = el('input'); inp.value = P.data[r.key] ?? ''; inp.placeholder = r.ph || ''; inp.spellcheck = false;
      inp.oninput = () => { P.data[r.key] = inp.value; };
      inp.onfocus = () => { if (P.sel !== i) { P.sel = i; markSel(); } };
      row.append(inp);
      if (i === P.sel) setTimeout(() => inp.focus(), 0);
    } else {
      let val = r.val;
      if (r.type === 'toggle') val = onOff(r.get());
      if (r.type === 'choice') { const v = r.get(); val = r.names?.[v] ?? String(v); }
      if (val !== undefined && val !== '') row.append(el('div', 'val', val));
    }
    row.onclick = () => { if (!selectable(r)) return; P.sel = i; settingsKey('ok'); };
    if (i === P.sel) selEl = row;
    list.append(row);
  });
  if (!rows.some(r => r.type === 'input' && rows.indexOf(r) === P.sel) && document.activeElement?.tagName === 'INPUT') document.activeElement.blur();
  scrollSettings(selEl);
}
function markSel() { renderSettings(); }
function scrollSettings(selEl) {
  const body = $('.s-body'), list = $('.s-list');
  if (!selEl) { list.style.top = '0px'; return; }
  const bh = body.clientHeight, y = selEl.offsetTop, h = selEl.offsetHeight;
  let top = -parseFloat(list.style.top || '0');
  if (y - top > bh - h * 2) top = y - bh + h * 2;
  if (y - top < h) top = Math.max(0, y - h * 1.5);
  list.style.top = -top + 'px';
}
function settingsKey(k) {
  const rows = rowsCache, r = rows[P.sel];
  const sel = rows.map((x, i) => (selectable(x) ? i : -1)).filter(i => i >= 0);
  const pos = sel.indexOf(P.sel);
  if (k === 'up' || k === 'down') {
    if (!sel.length) return;
    P.sel = sel[Math.min(sel.length - 1, Math.max(0, pos + (k === 'up' ? -1 : 1)))];
    if (P.stack.at(-1).page === 'log') { const lg = $('.s-log'); if (lg) lg.scrollTop += k === 'up' ? -60 : 60; }
    P.confirm = null;
    return renderSettings();
  }
  if (k === 'back' || k === 'settings') return backPage();
  if (!r) return;
  if (r.type === 'toggle' && (k === 'left' || k === 'right' || k === 'ok')) { r.set(!r.get()); return renderSettings(); }
  if (r.type === 'choice' && (k === 'left' || k === 'right' || k === 'ok')) {
    const i = r.values.indexOf(r.get());
    r.set(r.values[(Math.max(0, i) + (k === 'left' ? -1 : 1) + r.values.length) % r.values.length]);
    return renderSettings();
  }
  if (r.type === 'btn' && k === 'ok') return r.act();
  if (r.type === 'input' && k === 'ok') {   // OK in a box moves on to the next row
    if (pos < sel.length - 1) P.sel = sel[pos + 1];
    return renderSettings();
  }
}

// ------------------------------------------------------------ keys and mouse
function closeAll() { if (S.mode === 'guide') closeGuide(); if (S.mode === 'settings') closeSettings(); if (S.mode === 'browse') closeBrowse(); }
function toggleFullscreen() {
  if (window.oompasApp?.toggleFullscreen) return window.oompasApp.toggleFullscreen();
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
}
const KEYMAP = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'ok', ' ': 'ok', Select: 'ok',
  Escape: 'back', Backspace: 'back', GoBack: 'back', BrowserBack: 'back',
  PageUp: 'pageup', PageDown: 'pagedown', ChannelUp: 'chup', ChannelDown: 'chdown',
  g: 'guide', G: 'guide', Guide: 'guide', F1: 'guide', s: 'settings', S: 'settings', ContextMenu: 'settings', Settings: 'settings',
  i: 'info', I: 'info', Info: 'info', m: 'mute', M: 'mute', AudioVolumeMute: 'mute',
  z: 'zoom', Z: 'zoom', ColorF1Green: 'zoom', c: 'browse', C: 'browse', l: 'browse', L: 'browse', '*': 'star', y: 'star', Y: 'star', ColorF2Yellow: 'star', ColorF0Red: 'browse',
  f: 'fullscreen', F: 'fullscreen', F11: 'fullscreen', '+': 'volup', '=': 'volup', '-': 'voldown', _: 'voldown',
};
// Holding OK stars a channel (TV remotes have no * key). A short press is a normal OK.
let okTimer = 0, okHeld = false;
const LONG_OK = ['tv', 'guide', 'browse'];
addEventListener('keyup', e => {
  if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Select') && okTimer) {
    clearTimeout(okTimer); okTimer = 0;
    if (!okHeld) dispatchKey('ok');
    okHeld = false;
  }
});
addEventListener('keydown', e => {
  if (!S.started) return;
  const inInput = e.target?.tagName === 'INPUT';
  let k = KEYMAP[e.key];
  if (k === 'ok' && !inInput && LONG_OK.includes(S.mode) && !digitBuf) {
    e.preventDefault();
    if (e.repeat || okTimer) return;
    okHeld = false;
    okTimer = setTimeout(() => { okHeld = true; dispatchKey('star'); }, 650);
    return;
  }
  if (inInput) {
    // In a text box, only these leave it; the rest is typing.
    if (!['up', 'down', 'ok'].includes(k) && e.key !== 'Escape') return;
    if (e.key === 'Escape') k = 'back';
  }
  if (/^[0-9]$/.test(e.key) && !inInput) {
    e.preventDefault();
    if (S.mode === 'tv' || S.mode === 'guide') { if (S.mode === 'guide') closeGuide(); digit(e.key); }
    return;
  }
  if (!k) return;
  e.preventDefault();
  if (k === 'fullscreen' && !inInput) return toggleFullscreen();
  dispatchKey(k);
});
function dispatchKey(k) {
  if (S.mode === 'browse') return browseKey(k);
  if (S.mode === 'guide') return guideKey(k === 'chup' ? 'pageup' : k === 'chdown' ? 'pagedown' : k);
  if (S.mode === 'settings') return settingsKey(k);
  // watching TV
  switch (k) {
    case 'up': case 'chup': case 'pageup': return step(1);
    case 'down': case 'chdown': case 'pagedown': return step(-1);
    case 'left': case 'voldown': return setVolume(S.volume - 0.05);
    case 'right': case 'volup': return setVolume(S.volume + 0.05);
    case 'ok': case 'info':
      if (digitBuf) return commitDigits();
      return $('#banner').hidden ? showBanner(S.cur, 8000) : hideBanner();
    case 'back':
      if (!$('#banner').hidden) return hideBanner();
      if (S.prev) return tune(S.prev);
      return;
    case 'guide': return openGuide();
    case 'settings': return openSettings();
    case 'browse': return openBrowse();
    case 'zoom': return cycleZoom();
    case 'star': return toggleFav(S.cur);
    case 'mute': return toggleMute();
  }
}
let mouseT;
addEventListener('mousemove', () => {
  document.body.classList.remove('mouse-hidden');
  if (S.mode === 'tv') $('#mousebar').hidden = false;
  clearTimeout(mouseT);
  mouseT = setTimeout(() => { document.body.classList.add('mouse-hidden'); $('#mousebar').hidden = true; }, 2500);
});
$('#mousebar').addEventListener('click', e => {
  const a = e.target.closest('button')?.dataset.act;
  if (a === 'up') step(1); if (a === 'down') step(-1);
  if (a === 'guide') openGuide(); if (a === 'settings') openSettings(); if (a === 'browse') openBrowse(); if (a === 'fullscreen') toggleFullscreen(); if (a === 'zoom') cycleZoom();
});
screen.addEventListener('click', () => { if (S.mode === 'tv') showBanner(S.cur, 6000); });
screen.addEventListener('dblclick', toggleFullscreen);
addEventListener('wheel', e => {
  if (S.mode === 'tv') setVolume(S.volume + (e.deltaY < 0 ? 0.05 : -0.05));
  else if (S.mode === 'guide') guideKey(e.deltaY < 0 ? 'up' : 'down');
  else if (S.mode === 'browse') browseKey(e.deltaY < 0 ? 'up' : 'down');
}, { passive: true });
addEventListener('resize', () => { if (S.mode === 'guide') placePip(); });

// ------------------------------------------------------------ start
async function start() {
  staticOn(true);
  for (let i = 0; ; i++) {
    try { await loadState(); await loadChannels(); break; }
    catch { if (i === 0) noSignal('Waiting for the OOMPAS server…'); await new Promise(r => setTimeout(r, 1500)); }
  }
  $('#nosignal').hidden = true;
  S.started = true;
  S.volume = typeof S.settings.volume === 'number' ? S.settings.volume : 0.8;
  screen.classList.toggle('crt', S.settings.crt !== false);
  const first = S.byDial.get(String(S.settings.lastDial)) || S.channels[0];
  if (first) tune(first.dial);
  else noSignal('No channels yet');
  setInterval(() => loadChannels().then(() => { if (S.mode === 'guide') renderGuide(); }).catch(() => {}), 60000);
  setInterval(() => { if (S.mode === 'guide') $('.g-clock').textContent = hm(Date.now()); }, 15000);
}
start();
})();
