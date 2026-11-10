import dns from 'node:dns/promises';
// OOMPAS Box over Groovy_MiSTer: the PC draws everything, the MiSTer just shows it.
//
// The MiSTer runs the Groovy core (an "analog GPU": it shows whatever frames arrive over
// the network, at a real 15 kHz mode, with almost no delay). This program plays OOMPAS
// channels from the server running on this PC, and sends each frame and its sound to the
// MiSTer over UDP. The guide and banner are just frames too, so they appear instantly.
//
//   node groovy.mjs <MiSTer address> [channel]
//
// Needs server.mjs running on this PC. Controls: the controller on the MiSTer (turn on
// Server > Joysticks: Digital in the Groovy core's menu), or these keys in this window:
//   Up/Down change channel · Right guide · Left info banner · Enter tune · Esc/Q quit
//
// Protocol: https://github.com/psakhis/Groovy_MiSTer (api/groovymister.cpp), UDP 32100
// for video/audio/commands and 32101 for controller input.

import readline from 'node:readline';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MISTER = process.argv[2];
let dial = Number(process.argv[3] || 0);
const SERVER = process.env.OOMPAS_SERVER || `127.0.0.1:${process.env.PORT || 8090}`;
const FFMPEG = process.env.FFMPEG || 'ffmpeg';

// Video modes (GROOVY_MODE=...):
//   640p (default): 640x240 progressive. Twice the sharpness across of 240p, in colour on
//     every TV the 240p mode works on. ~40-60 Mbit/s.
//   480i: 640x480 interlaced, full detail of the tapes; some TVs on composite drop to black
//     and white with it. ~60-100 Mbit/s, gigabit link.
//   480i601: 720x480 interlaced at the broadcast-standard 13.5 MHz timing, for TVs that
//     lose colour on plain 480i.
//   720x480i: 720x480 interlaced, MiSTerCast's 720x480i preset timing.
//   320x480i: 320 wide, 480 lines interlaced: soft and classic across, full detail down.
//   240p: 320x240 progressive, the lightest.
const MODES = {
  '640p':    { w: 640, h: 240, pclock: 12.336, h_: [640, 664, 723, 784], v: [240, 244, 247, 262], interlace: 0 },
  '480i':    { w: 640, h: 480, pclock: 12.336, h_: [640, 662, 720, 784], v: [480, 488, 494, 525], interlace: 1 },   // same as MiSTerCast's 640x480i preset
  '320x480i': { w: 320, h: 480, pclock: 6.7, h_: [320, 336, 367, 426], v: [480, 488, 493, 525], interlace: 1 },   // same as MiSTerCast's preset
  '720x480i': { w: 720, h: 480, pclock: 13.846, h_: [720, 744, 809, 880], v: [480, 488, 494, 525], interlace: 1 },   // same as MiSTerCast's preset
  '480i601': { w: 720, h: 480, pclock: 13.5,   h_: [720, 736, 798, 858], v: [480, 486, 492, 525], interlace: 1 },
  '240p':    { w: 320, h: 240, pclock: 6.7,    h_: [320, 336, 367, 426], v: [240, 244, 247, 262], interlace: 0 },
};
const MODE_NAME = MODES[(process.env.GROOVY_MODE || '').toLowerCase()] ? process.env.GROOVY_MODE.toLowerCase() : '640p';
const MODE = { ...MODES[MODE_NAME] }; MODE.h = MODE.h_;
// A calibration saved by groovy-calibrate.mjs replaces the standard timing for its mode;
// the picture is then drawn at the calibrated (smaller or larger) active size.
let CALIBRATED = false;
try {
  const cal = JSON.parse(fs.readFileSync(new URL('./groovy-calibration.json', import.meta.url), 'utf8'))[MODE_NAME];
  if (cal && cal.h?.length === 4 && cal.v?.length === 4) { Object.assign(MODE, { pclock: cal.pclock, h: cal.h, v: cal.v, interlace: cal.interlace }); CALIBRATED = true; }
} catch {}
const W = MODE.h[0], H = MODE.v[0], FPS = 30000 / 1001;
const FIELDS = MODE.interlace ? 2 : 1;
// Picture smoothing (GROOVY_SMOOTH=off|soft|medium): a light blur that rounds off jagged
// line art and stair-stepped edges, like a soft TV picture. Interlaced modes also get a
// gentle vertical "flicker filter" so thin horizontal lines don't twitter between fields
// (GROOVY_FLICKER=0 turns that off).
const SMOOTH = (process.env.GROOVY_SMOOTH || 'off').toLowerCase();
const SMOOTH_VF = (MODE.interlace && process.env.GROOVY_FLICKER !== '0' ? ',gblur=sigma=0.01:sigmaV=0.6' : '') +
  (SMOOTH === 'soft' ? ',gblur=sigma=0.45' : SMOOTH === 'medium' ? ',gblur=sigma=0.8' : '');                     // blits per video frame
const RATE = 48000, CHANNELS = 2, MTU = 1472;
// Colour format. 565 (default, 16-bit) is known to show correct colours.
// GROOVY_RGB=888 sends full 24-bit colour (smoother gradients, ~40-60 Mbit/s, so cable
// only) in blue-green-red byte order; GROOVY_RGB=888rgb sends red-green-blue instead,
// in case reds and blues come out swapped.
const RGB_MODE = (process.env.GROOVY_RGB || '565').toLowerCase();
const RGB565 = !RGB_MODE.startsWith('888');
const SWAP_RB = RGB_MODE === '888';
function toBgr(rgb, out) {
  for (let i = 0; i < rgb.length; i += 3) { out[i] = rgb[i + 2]; out[i + 1] = rgb[i + 1]; out[i + 2] = rgb[i]; }
  return out;
}
// 16-bit colour has only 32 shades of red and blue (64 of green), which turns smooth
// gradients (skies, faces, dark scenes) into visible bands that look like compression.
// An ordered 4x4 dither spreads the in-between shades into a fine pattern instead; on a
// CRT it reads as smooth colour. GROOVY_DITHER=0 turns it off.
const DITHER = process.env.GROOVY_DITHER !== '0';
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map(v => (v + 0.5) / 16 - 0.5);
function toRgb565(rgb, out) {
  const px = rgb.length / 3;
  for (let i = 0; i < px; i++) {
    let r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    if (DITHER) {
      const t = BAYER[((Math.floor(i / W) & 3) << 2) | (i % W & 3)];
      r = Math.min(255, Math.max(0, r + t * 8)); g = Math.min(255, Math.max(0, g + t * 4)); b = Math.min(255, Math.max(0, b + t * 8));
    }
    const v = ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3);
    out[i * 2] = v & 255; out[i * 2 + 1] = v >> 8;
  }
  return out;
}
const CMD = { CLOSE: 1, INIT: 2, SWITCHRES: 3, AUDIO: 4, GET_STATUS: 5, BLIT_FIELD_VSYNC: 7 };
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ------------------------------------------------------------------ LZ4 (block format)
// The Groovy core decompresses LZ4 blocks on the FPGA; this is a plain greedy compressor.
const HASH_BITS = 16, hashTable = new Int32Array(1 << HASH_BITS);
export function lz4Block(src, dst) {
  const n = src.length;
  hashTable.fill(-1);
  let ip = 0, anchor = 0, op = 0;
  const hash = i => (Math.imul(src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24), 2654435761) >>> (32 - HASH_BITS));
  const writeLen = len => { while (len >= 255) { dst[op++] = 255; len -= 255; } dst[op++] = len; };
  const mflimit = n - 12;                 // matches may not start in the last 12 bytes
  while (ip < mflimit) {
    const h = hash(ip), ref = hashTable[h];
    hashTable[h] = ip;
    if (ref < 0 || ip - ref > 65535 || src[ref] !== src[ip] || src[ref + 1] !== src[ip + 1] || src[ref + 2] !== src[ip + 2] || src[ref + 3] !== src[ip + 3]) { ip++; continue; }
    let len = 4;
    const limit = n - 5;                  // the last 5 bytes are always literals
    while (ip + len < limit && src[ref + len] === src[ip + len]) len++;
    const lit = ip - anchor, token = op++;
    dst[token] = (Math.min(lit, 15) << 4) | Math.min(len - 4, 15);
    if (lit >= 15) writeLen(lit - 15);
    src.copy(dst, op, anchor, ip); op += lit;
    dst[op++] = (ip - ref) & 255; dst[op++] = (ip - ref) >> 8;
    if (len - 4 >= 15) writeLen(len - 4 - 15);
    ip += len; anchor = ip;
  }
  const lit = n - anchor;
  dst[op++] = Math.min(lit, 15) << 4;
  if (lit >= 15) writeLen(lit - 15);
  src.copy(dst, op, anchor, n); op += lit;
  return op;
}

// ------------------------------------------------------------------ the link
class Groovy {
  constructor(host) {
    this.host = host;
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', m => this.onAck(m));
    this.inputs = dgram.createSocket('udp4');
    this.frame = 0;
    this.audioOn = false;
    this.acked = 0;
    this.lz = Buffer.alloc(W * H * 3 + 65536);
    this.px565 = Buffer.alloc(W * H * 2);
    this.px888 = Buffer.alloc(W * H * 3);
    this.onJoy = () => {};
    this.onKeys = () => {};
    this.kbdAt = -1;
    this.inputs.on('message', m => {
      if (m.length === 9 || m.length === 17) this.onJoy(m.readUInt16LE(5));   // frame(4) order(1) joy1(2) joy2(2)
      // Keyboard plugged into the MiSTer: frame(4) order(1), then 256 bits, one per
      // SDL scancode, set while the key is held (41 bytes when the mouse is included).
      if (m.length === 37 || m.length === 41) {
        // Skip a packet only if it is slightly older than the last one (UDP reordering).
        // A big jump back means the core's counter restarted: take it, don't go deaf.
        const at = m.readUInt32LE(0) * 256 + m[4];
        if (at < this.kbdAt && this.kbdAt - at < 120 * 256) return;
        this.kbdAt = at;
        this.onKeys(m.subarray(5, 37));
      }
    });
  }
  send(buf) { return new Promise(r => this.sock.send(buf, 32100, this.host, r)); }
  onAck(m) {
    if (m.length !== 13) return;
    this.acked = m.readUInt32LE(0);
    this.audioOn = !!(m[12] & 0x40);
    this.lastAck = Date.now();
  }
  async init() {
    await new Promise(r => this.sock.bind(0, r));
    this.sock.setSendBufferSize(2 * 1024 * 1024);
    // Buttons from the MiSTer: register by sending one byte to 32101. The core only
    // checks for that byte while it handles INIT, so it has to arrive first.
    await new Promise(r => this.inputs.bind(0, r));
    const register = () => this.inputs.send(Buffer.from([0]), 32101, this.host);
    // Keep re-registering every few seconds: harmless to the core, and it keeps the
    // Windows firewall's door open for the button packets coming back (they stop
    // arriving after a while otherwise).
    this.inputsTimer = setInterval(register, 4000);
    for (let tries = 0; tries < 20; tries++) {
      this.lastAck = 0;
      register();
      await new Promise(r => setTimeout(r, 50));
      // compression LZ4, audio 48 kHz (code 3), stereo, RGB565 (2) or RGB888 (0)
      await this.send(Buffer.from([CMD.INIT, 1, 3, CHANNELS, RGB565 ? 2 : 0]));
      await new Promise(r => setTimeout(r, 300));
      if (this.lastAck) break;
      if (tries === 0) log(`Waiting for the Groovy core at ${this.host}... (load Groovy from the MiSTer's Utility menu)`);
    }
    if (!this.lastAck) throw new Error(`no answer from ${this.host}:32100. Is the Groovy core running, and the address right?`);
    const b = Buffer.alloc(26);
    b[0] = CMD.SWITCHRES;
    b.writeDoubleLE(MODE.pclock, 1);
    [...MODE.h, ...MODE.v].forEach((x, i) => b.writeUInt16LE(x, 9 + i * 2));
    b[25] = MODE.interlace;
    await this.send(b);
    log(`Connected to the Groovy core at ${this.host}: ${MODE_NAME}${CALIBRATED ? ' (calibrated)' : ''} ${W}x${H}${MODE.interlace ? 'i' : 'p'}, ${(MODE.pclock * 1e6 / MODE.h[3] / MODE.v[3] * (MODE.interlace ? 2 : 1)).toFixed(2)} Hz${MODE.interlace ? ' fields' : ''}`);
  }
  async blit(rgb, field = 0) {
    if (MODE.interlace) {            // send just this field's lines: 0 = even, 1 = odd
      const row = W * 3, out = this.fieldBuf ||= Buffer.alloc(W * (H >> 1) * 3);
      for (let y = field, o = 0; y < H; y += 2, o += row) rgb.copy(out, o, y * row, y * row + row);
      rgb = out;
    }
    const px = RGB565 ? toRgb565(rgb, this.px565) : SWAP_RB ? toBgr(rgb, this.px888) : rgb;
    const size = lz4Block(px.subarray(0, rgb.length / 3 * (RGB565 ? 2 : 3)), this.lz);
    const head = Buffer.alloc(12);
    head[0] = CMD.BLIT_FIELD_VSYNC;
    head.writeUInt32LE(++this.frame, 1);
    head[5] = field;
    head.writeUInt16LE((MODE.interlace ? MODE.v[3] >> 1 : MODE.v[3]) >> 1, 6);   // vsync line
    head.writeUInt32LE(size, 8);
    await this.send(head);
    // Queue the whole field at once and wait only for the last packet; awaiting each one
    // is too slow for 480i (about 140 packets a field, 60 fields a second). Each packet
    // gets its own copy, since this.lz is reused for the next field.
    let last;
    for (let o = 0; o < size; o += MTU) last = this.send(Buffer.from(this.lz.subarray(o, Math.min(size, o + MTU))));
    await last;
  }
  async audio(pcm) {
    if (!this.audioOn || !pcm.length) return;
    const head = Buffer.alloc(3);
    head[0] = CMD.AUDIO; head.writeUInt16LE(pcm.length, 1);
    await this.send(head);
    let last;
    for (let o = 0; o < pcm.length; o += MTU) last = this.send(pcm.subarray(o, Math.min(pcm.length, o + MTU)));
    await last;
  }
  async close() {
    clearInterval(this.inputsTimer);
    try { await this.send(Buffer.from([CMD.CLOSE])); } catch {}
    this.sock.close(); this.inputs.close();
  }
}

// ------------------------------------------------------------------ the channel
// Decodes the server's stream for a channel into frames and sound at real-time speed.
// Picture settings (P): size, position, brightness, contrast, colour. Kept next to this
// file in groovy-settings.json and applied by the server to the stream, guide and banner.
const PIC_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'groovy-settings.json');
const PIC_DEFAULTS = { pw: 100, ph: 100, px: 0, py: 0, br: 0, ct: 100, sat: 100 };
const PIC_ROWS = [['pw', 1, 50, 100], ['ph', 1, 50, 100], ['px', 2, -80, 80], ['py', 2, -60, 60],
                  ['br', 5, -100, 100], ['ct', 5, 0, 300], ['sat', 5, 0, 300], ['reset'], ['done']];
let PIC = { ...PIC_DEFAULTS };
try { PIC = { ...PIC_DEFAULTS, ...JSON.parse(fs.readFileSync(PIC_FILE, 'utf8')) }; } catch {}
const picQuery = () => Object.entries(PIC).filter(([k, v]) => v !== PIC_DEFAULTS[k]).map(([k, v]) => `&${k}=${v}`).join('');

// Every ffmpeg we start, so none outlives this program (closing the window included).
const SOURCES = new Set();
const stopAll = () => { for (const s of SOURCES) s.stop(); };
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => { stopAll(); process.exit(0); });

class Source {
  constructor(dial) {
    this.frames = []; this.audio = []; this.audioBytes = 0; this.vbuf = Buffer.alloc(0);
    SOURCES.add(this);
    const url = `http://${SERVER}/tune/${dial}.ts?w=${W}&h=${H}&viewer=groovy&quality=high&nobanner=1${picQuery()}`;
    this.proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-re', '-i', url,
      '-map', '0:v', '-vf', `scale=${W}:${H},fps=${FPS.toFixed(4)}${SMOOTH_VF}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
      '-map', '0:a', '-ar', String(RATE), '-ac', String(CHANNELS), '-f', 's16le', 'pipe:3'],
      { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    const fsize = W * H * 3;
    this.proc.stdout.on('data', d => {
      this.vbuf = this.vbuf.length ? Buffer.concat([this.vbuf, d]) : d;
      while (this.vbuf.length >= fsize) { this.frames.push(Buffer.from(this.vbuf.subarray(0, fsize))); this.vbuf = this.vbuf.subarray(fsize); }
      if (this.frames.length > 8) this.proc.stdout.pause();     // let the server's pacing hold the rest
    });
    this.proc.stdio[3].on('data', d => { this.audio.push(d); this.audioBytes += d.length; });
    this.proc.stderr.on('data', d => log('ffmpeg: ' + String(d).trim()));
  }
  nextFrame() { const f = this.frames.shift(); if (this.frames.length < 4) this.proc.stdout.resume(); return f; }
  takeAudio(bytes) {
    bytes = Math.min(bytes, this.audioBytes) & ~3;
    const out = Buffer.alloc(bytes);
    let o = 0;
    while (o < bytes) {
      const c = this.audio[0], n = Math.min(c.length, bytes - o);
      c.copy(out, o, 0, n); o += n;
      if (n === c.length) this.audio.shift(); else this.audio[0] = c.subarray(n);
    }
    this.audioBytes -= bytes;
    return out;
  }
  stop() { try { this.proc.kill('SIGKILL'); } catch {} SOURCES.delete(this); }
}

// ------------------------------------------------------------------ the TV
async function fetchBuf(path) {
  const r = await fetch(`http://${SERVER}${path}`);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const rgbaToRgb = rgba => { const out = Buffer.alloc(W * H * 3); for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { out[j] = rgba[i]; out[j + 1] = rgba[i + 1]; out[j + 2] = rgba[i + 2]; } return out; };
function blend(rgb, rgba) {          // lay a banner (transparent RGBA) over a frame
  const out = Buffer.from(rgb);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    const a = rgba[i + 3];
    if (!a) continue;
    out[j] = (rgba[i] * a + out[j] * (255 - a)) / 255;
    out[j + 1] = (rgba[i + 1] * a + out[j + 1] * (255 - a)) / 255;
    out[j + 2] = (rgba[i + 2] * a + out[j + 2] * (255 - a)) / 255;
  }
  return out;
}

// The guide's picture box, live: the current channel scaled into it every frame.
// Same place as in server.mjs (designed on 320x240), scaled to this mode.
const PIP = { x: 196 * W / 320, y: 6 * H / 240, w: 112 * W / 320, h: 84 * H / 240 };
function withPip(guideRgb, video) {
  const out = Buffer.from(guideRgb);
  if (!video) return out;
  for (let y = 0; y < PIP.h; y++) {
    const sy = Math.floor(y * H / PIP.h);
    for (let x = 0; x < PIP.w; x++) {
      const si = (sy * W + Math.floor(x * W / PIP.w)) * 3, di = ((PIP.y + y) * W + PIP.x + x) * 3;
      out[di] = video[si]; out[di + 1] = video[si + 1]; out[di + 2] = video[si + 2];
    }
  }
  return out;
}

async function main() {
  if (!MISTER) { console.log('Usage: node groovy.mjs <MiSTer address> [channel]'); process.exit(1); }
  let chans;
  try {
    const r = await fetch(`http://${SERVER}/channels.json`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    chans = (await r.json()).channels;
  } catch (e) {
    const why = e.cause?.code || e.message;
    throw new Error(`can't reach the OOMPAS server at http://${SERVER} (${why}).\n` +
      `  Is server.mjs running? Start it with start-server.bat and leave that window open.\n` +
      `  If it runs on another port or PC:  set OOMPAS_SERVER=address:port  before starting this.\n` +
      `  Check: open http://${SERVER}/channels.json in a browser on this PC.`);
  }
  const dials = chans.map(c => Number(c.dial));
  if (!dials.includes(dial)) dial = dials[0];
  // A name (MiSTer.mshome.net on a shared cable) is looked up once, not on every packet.
  let host = MISTER;
  try { host = (await dns.lookup(MISTER, { family: 4 })).address; } catch { throw new Error(`can't find ${MISTER}. Check the MiSTer is on, or give its number address.`); }
  if (host !== MISTER) log(`${MISTER} is ${host}`);
  const g = new Groovy(host);
  await g.init();

  let src = null, last = null, banner = null, bannerUntil = 0, guide = null, settings = null, previous = null, digits = '', digitsTimer = null;
  const tune = d => {
    if (d !== dial) previous = dial;
    dial = d;
    if (src) src.stop();
    src = new Source(dial);
    log(`Channel ${dial} ${chans.find(c => Number(c.dial) === dial)?.name || ''}`);
    showBanner(1500);
  };
  const showBanner = delay => setTimeout(async () => {
    try { banner = await fetchBuf(`/banner.rgba?dial=${dial}&w=${W}&h=${H}${picQuery()}`); bannerUntil = Date.now() + 6000; } catch (e) { log('banner: ' + e.message); }
  }, delay);
  const drawGuide = async () => {
    const sel = guide.index >= dials.length ? 'settings' : dials[guide.index];
    try { guide.frame = rgbaToRgb(await fetchBuf(`/guide.rgba?sel=${sel}&w=${W}&h=${H}${guide.info ? '&info=1' : ''}${picQuery()}`)); } catch (e) { log('guide: ' + e.message); }
  };
  const step = n => { const i = dials.indexOf(dial); tune(dials[(i + n + dials.length) % dials.length]); };

  const drawSettings = async () => {
    try { settings.frame = rgbaToRgb(await fetchBuf(`/settings.rgba?sel=${settings.index}&w=${W}&h=${H}${picQuery()}`)); } catch (e) { log('settings: ' + e.message); }
  };
  const closeSettings = () => {
    settings = null;
    try { fs.writeFileSync(PIC_FILE, JSON.stringify(PIC, null, 1)); } catch (e) { log('settings: could not save (' + e.message + ')'); }
    log('Picture settings saved' + (picQuery() ? ': ' + picQuery().slice(1).replace(/&/g, ' ') : ' (defaults)'));
    tune(dial);                                   // restart the stream with the new picture
  };
  const press = async key => {
    if (settings) {
      const row = PIC_ROWS[settings.index];
      if (key === 'up') settings.index = (settings.index - 1 + PIC_ROWS.length) % PIC_ROWS.length;
      else if (key === 'down') settings.index = (settings.index + 1) % PIC_ROWS.length;
      else if ((key === 'left' || key === 'right') && row.length === 4) {
        const [k, stepBy, lo, hi] = row;
        PIC[k] = Math.max(lo, Math.min(hi, PIC[k] + (key === 'right' ? stepBy : -stepBy)));
      }
      else if ((key === 'enter' || key === 'right') && row[0] === 'reset') PIC = { ...PIC_DEFAULTS };
      else if (((key === 'enter' || key === 'right') && row[0] === 'done') || key === 'back' || key === 'settings') return closeSettings();
      else return;
      return drawSettings();
    }
    if (key === 'settings') { guide = null; settings = { index: 0 }; log('Picture settings open'); return drawSettings(); }
    if (guide) {
      if (key === 'up') { guide.index = (guide.index - 1 + dials.length) % dials.length; guide.info = false; await drawGuide(); }
      else if (key === 'down') { guide.index = (guide.index + 1) % dials.length; guide.info = false; await drawGuide(); }
      else if (key === 'left') { guide.info = !guide.info; await drawGuide(); }
      else if (key === 'right' || key === 'enter') { const d = dials[guide.index]; guide = null; if (d === undefined) return press('settings'); if (d !== dial) tune(d); }
      else if (key === 'back') guide = null;
      return;
    }
    if (key === 'up') step(1);
    else if (key === 'down') step(-1);
    else if (key === 'right') { guide = { index: dials.indexOf(dial), info: false }; await drawGuide(); }
    else if (key === 'left') showBanner(0);
    else if (key === 'back' && previous != null && dials.includes(previous)) tune(previous);
    else if (/^\d$/.test(key)) {            // type a channel number; it tunes after a pause
      digits = (digits + key).slice(-3);
      clearTimeout(digitsTimer);
      digitsTimer = setTimeout(() => { const d = Number(digits); digits = ''; if (dials.includes(d)) tune(d); else log(`No channel ${d}`); }, 1500);
    }
    else if (key === 'enter' && digits) { clearTimeout(digitsTimer); const d = Number(digits); digits = ''; if (dials.includes(d)) tune(d); }
  };

  // Controller on the MiSTer (Groovy core: Server > Joysticks: Digital).
  let prevJoy = 0;
  g.onJoy = j => {
    const down = j & ~prevJoy; prevJoy = j;
    const p = k => press(k).catch(e => log('pad: ' + e.message));
    if (down & 8) p('up'); if (down & 4) p('down'); if (down & 1) p('right'); if (down & 2) p('left');
    if (down & 16) p('enter'); if (down & 32) p('back');
  };
  // Keyboard on the MiSTer (Groovy core menu: turn its keyboard/PS2 input on). SDL scancodes.
  const SDL = { 82: 'up', 75: 'up', 87: 'up', 81: 'down', 78: 'down', 86: 'down', 80: 'left',
                79: 'right', 10: 'right', 43: 'right', 40: 'enter', 88: 'enter', 42: 'back',
                19: 'settings', 30: '1', 31: '2', 32: '3', 33: '4', 34: '5', 35: '6', 36: '7', 37: '8', 38: '9', 39: '0' };
  let prevKeys = Buffer.alloc(32);
  g.onKeys = bits => {
    for (const [code, key] of Object.entries(SDL)) {
      const i = Number(code), now = bits[i >> 3] >> (i & 7) & 1, was = prevKeys[i >> 3] >> (i & 7) & 1;
      if (now && !was) press(key).catch(e => log('kbd: ' + e.message));
    }
    prevKeys = Buffer.from(bits);
  };
  let sawInput = false;
  setTimeout(() => { if (!sawInput) log('No buttons from the MiSTer yet. In the Groovy core menu, turn on joystick and keyboard input (Server settings).'); }, 15000).unref();
  const _j = g.onJoy, _k = g.onKeys;
  g.onJoy = j => { sawInput = true; _j(j); }; g.onKeys = b => { sawInput = true; _k(b); };

  // Keyboard in this window. readline puts split escape sequences back together
  // (Windows consoles can deliver an arrow key in pieces), so a bare Esc never
  // gets mistaken for one. Quit with q or Ctrl+C.
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true); process.stdin.resume();
    const KEYS = { up: 'up', down: 'down', left: 'left', right: 'right', return: 'enter', enter: 'enter', backspace: 'back', p: 'settings', pageup: 'up', pagedown: 'down', tab: 'right', g: 'right' };
    process.stdin.on('keypress', async (str, key = {}) => {
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) { if (src) src.stop(); await g.close(); process.exit(0); }
      const k = KEYS[key.name] || (/^\d$/.test(str || '') ? str : null);
      if (k) press(k).catch(e => log('key: ' + e.message));
    });
  }

  tune(dial);
  // One tick per video frame: send the picture (or the guide), then that frame's sound.
  // Interlaced: two ticks per frame, the even lines then the odd lines of the same frame.
  let t0 = performance.now(), n = 0, audioDebt = 0, stats = { sent: 0, bytes: 0, at: Date.now() };
  const perFrame = RATE / FPS / FIELDS;
  let pic = null, fresh = false;
  for (;;) {
    const field = n % FIELDS;
    if (field === 0) {
      const f = src.nextFrame();
      if (f) last = f;
      pic = settings ? settings.frame : guide ? (guide.frame && withPip(guide.frame, last)) : last;
      if (pic && !guide && !settings && banner && Date.now() < bannerUntil) pic = blend(pic, banner);
      fresh = !!(f || guide || banner || settings);
    }
    // An interlaced picture must be refreshed every field; progressive only on change.
    if (pic && (fresh || MODE.interlace)) { await g.blit(pic, field); stats.sent += 1 / FIELDS; }
    if (banner && Date.now() >= bannerUntil) banner = null;
    audioDebt += perFrame;
    const samples = Math.floor(audioDebt); audioDebt -= samples;
    await g.audio(src.takeAudio(samples * CHANNELS * 2));
    if (Date.now() - stats.at > 10000) {
      log(`${(stats.sent / ((Date.now() - stats.at) / 1000)).toFixed(1)} frames/s sent, audio ${g.audioOn ? 'on' : 'off (turn on Audio in the Groovy core menu)'}`);
      stats = { sent: 0, at: Date.now() };
    }
    n++;
    const wait = t0 + n * 1000 / FPS / FIELDS - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    else if (wait < -500) { t0 = performance.now(); n = 0; }   // fell behind: catch up
  }
}

process.on('unhandledRejection', e => log('error (kept running): ' + (e?.stack || e)));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('groovy.mjs')) {
  main().catch(e => { console.error('Groovy: ' + e.message); process.exit(1); });
}
