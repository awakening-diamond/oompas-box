// OOMPAS Box: picture calibration for the Groovy core (and MiSTerCast).
//
//   node groovy-calibrate.mjs [MiSTer address] [mode]
//   (or double-click calibrate-groovy.bat)
//
// Shows a test pattern on the TV and lets you move and resize the picture live by
// changing the video timing (the modeline). The numbers on screen are in the same
// order as MiSTerCast's Modeline boxes, so you can type them straight in.
// Enter saves them to groovy-calibration.json, which OOMPAS's Groovy mode then uses
// for that mode automatically.
//
// Keys (on the PC in this window, or a keyboard plugged into the MiSTer):
//   Arrows      move the picture
//   A  D        narrower / wider   (also [ ]  or  , .)
//   W  S        taller / shorter   (also = -  or keypad + -)
//   T           try the adjusted timing for real on the TV (one blink); T again goes back
//   R           back to the standard timing for this mode
//   Enter       save     Esc or Q   quit without saving
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { lz4Block } from './groovy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CAL_FILE = path.join(HERE, 'groovy-calibration.json');

// Standard timings, the same as groovy.mjs (and MiSTerCast's presets where they exist).
export const BASE_MODES = {
  '640p':     { pclock: 12.336, h: [640, 664, 723, 784], v: [240, 244, 247, 262], interlace: 0 },
  '480i':     { pclock: 12.336, h: [640, 662, 720, 784], v: [480, 488, 494, 525], interlace: 1 },
  '720x480i': { pclock: 13.846, h: [720, 744, 809, 880], v: [480, 488, 494, 525], interlace: 1 },
  '320x480i': { pclock: 6.7,    h: [320, 336, 367, 426], v: [480, 488, 493, 525], interlace: 1 },
  '480i601':  { pclock: 13.5,   h: [720, 736, 798, 858], v: [480, 486, 492, 525], interlace: 1 },
  '240p':     { pclock: 6.7,    h: [320, 336, 367, 426], v: [240, 244, 247, 262], interlace: 0 },
};

export function loadCalibration() {
  try { return JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch { return {}; }
}


// Also add the calibration to MiSTerCast as a preset, so it shows up in its Modeline
// Presets list ("[480i OOMPAS calibrated]"). MISTERCAST_DIR is MiSTerCast's folder.
const PRESET_LABEL = { '480i': '640x480i', '720x480i': '720x480i', '320x480i': '320x480i', '240p': '320x240', '640p': '640x240', '480i601': '720x480i 601' };
function saveToMiSTerCast(name, m) {
  const dir = process.env.MISTERCAST_DIR;
  if (!dir) return null;
  const file = path.join(dir, 'modelines.dat');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return `couldn't open ${file}`; }
  const label = `[${PRESET_LABEL[name] || name} OOMPAS calibrated]`;
  const pad = (v, w) => String(v).padEnd(w);
  const line = `${pad(label, 32)} ${pad(m.pclock.toFixed(3), 6)} ${[...m.h, ...m.v].map(v => pad(v, 4)).join(' ')} ${m.interlace ? 1 : 0}`;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter(l => !l.startsWith(label));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.some(l => l.startsWith(';OOMPAS calibrated'))) lines.push('', ';OOMPAS calibrated (written by groovy-calibrate.mjs)');
  lines.push(line);
  fs.writeFileSync(file, lines.join(eol) + eol);
  return null;
}

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);
const CMD = { CLOSE: 1, INIT: 2, SWITCHRES: 3, BLIT_FIELD_VSYNC: 7 };
const MTU = 1472;

// ------------------------------------------------------------------ tiny 5x7 font
const FONT = {
  '0': '0e11131519110e', '1': '040c040404040e', '2': '0e11010204081f', '3': '1f02040201110e',
  '4': '02060a121f0202', '5': '1f101e0101110e', '6': '0608101e11110e', '7': '1f010204080808',
  '8': '0e11110e11110e', '9': '0e11110f01020c', 'A': '0e11111f111111', 'B': '1e11111e11111e',
  'C': '0e11101010110e', 'D': '1c12111111121c', 'E': '1f10101e10101f', 'F': '1f10101e101010',
  'G': '0e11101713110f', 'H': '1111111f111111', 'I': '0e04040404040e', 'J': '0702020202120c',
  'K': '11121418141211', 'L': '1010101010101f', 'M': '111b1515111111', 'N': '11111915131111',
  'O': '0e11111111110e', 'P': '1e11111e101010', 'Q': '0e11111115120d', 'R': '1e11111e141211',
  'S': '0f10100e01011e', 'T': '1f040404040404', 'U': '1111111111110e', 'V': '11111111110a04',
  'W': '11111115151b11', 'X': '11110a040a1111', 'Y': '11110a04040404', 'Z': '1f01020408101f',
  ' ': '00000000000000', '.': '0000000000000c', ':': '000c0c000c0c00', '-': '0000001f000000',
  '=': '00001f001f0000', '[': '0e08080808080e', ']': '0e02020202020e', '/': '01010204081010',
  '+': '0004041f040400', '%': '18190204081303', '(': '02040808080402', ')': '08040202020408',
};

// ------------------------------------------------------------------ the test pattern
function pattern(m, base) {
  const W = m.h[0], H = m.v[0];
  const rgb = Buffer.alloc(W * H * 3);
  // Pixel shape: the standard mode fills a 4:3 picture, and the pixel clock never
  // changes, so each pixel keeps that shape however the picture is resized.
  const pa = (4 / 3) / (base.h[0] / base.v[0]);            // pixel width / height
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) { const i = (y * W + x) * 3; rgb[i] = c[0]; rgb[i + 1] = c[1]; rgb[i + 2] = c[2]; } };
  const rect = (x0, y0, x1, y1, c, t = 1) => {
    for (let k = 0; k < t; k++) {
      for (let x = x0; x <= x1; x++) { put(x, y0 + k, c); put(x, y1 - k, c); }
      for (let y = y0; y <= y1; y++) { put(x0 + k, y, c); put(x1 - k, y, c); }
    }
  };
  const tY = H >= 400 ? 2 : 1;                             // line thickness for interlace
  const tX = Math.max(1, Math.round(tY / pa));
  // grid
  for (let i = 1; i < 16; i++) { const x = Math.round(i * W / 16); for (let y = 0; y < H; y++) for (let k = 0; k < tX; k++) put(x + k, y, [40, 40, 60]); }
  for (let i = 1; i < 12; i++) { const y = Math.round(i * H / 12); for (let x = 0; x < W; x++) for (let k = 0; k < tY; k++) put(x, y + k, [40, 40, 60]); }
  // safe areas: 95% (action safe) and 90% (title safe)
  for (const [f, c] of [[0.95, [90, 90, 90]], [0.90, [60, 110, 160]]]) {
    const dx = Math.round(W * (1 - f) / 2), dy = Math.round(H * (1 - f) / 2);
    rect(dx, dy, W - 1 - dx, H - 1 - dy, c, tY);
  }
  // the edge of the picture: this border should just touch every edge of the glass
  rect(0, 0, W - 1, H - 1, [255, 255, 255], Math.max(tX, tY) * 2);
  // corner arrows, so you can tell an edge that's cut off from one that's just dark
  const cs = Math.round(H / 10);
  for (let i = 0; i < cs; i++) for (let k = 0; k < tY * 2; k++) {
    const ix = Math.round(i / pa);
    put(ix, i + k, [255, 60, 60]); put(W - 1 - ix, i + k, [60, 255, 60]);
    put(ix, H - 1 - i - k, [60, 120, 255]); put(W - 1 - ix, H - 1 - i - k, [255, 220, 60]);
  }
  // centre circle and cross: round when the picture shape is right
  const r = H * 0.38, cx = (W - 1) / 2, cy = (H - 1) / 2;
  for (let a = 0; a < 4000; a++) {
    const t = a / 4000 * Math.PI * 2;
    for (let k = 0; k < tY; k++) put(Math.round(cx + Math.cos(t) * (r - k) / pa), Math.round(cy + Math.sin(t) * (r - k)), [255, 255, 255]);
  }
  for (let x = Math.round(cx - r / pa / 4); x <= cx + r / pa / 4; x++) for (let k = 0; k < tY; k++) put(x, Math.round(cy) + k, [255, 255, 255]);
  for (let y = Math.round(cy - r / 4); y <= cy + r / 4; y++) for (let k = 0; k < tX; k++) put(Math.round(cx) + k, y, [255, 255, 255]);
  return { rgb, W, H, pa, put };
}

function text(p, str, cx, y, color = [255, 255, 255]) {
  const sy = p.H >= 400 ? 2 : 1, sx = Math.max(1, Math.round(sy / p.pa));
  const cw = 6 * sx, w = str.length * cw;
  let x = Math.round(cx - w / 2);
  // dark box behind the text
  for (let yy = y - sy * 2; yy < y + 9 * sy; yy++) for (let xx = x - sx * 3; xx < x + w + sx * 2; xx++) p.put(xx, yy, [0, 0, 0]);
  for (const ch of str.toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      const bits = parseInt(g.substr(row * 2, 2), 16);
      for (let col = 0; col < 5; col++) if (bits & (16 >> col))
        for (let a = 0; a < sy; a++) for (let b = 0; b < sx; b++) p.put(x + col * sx + b, y + row * sy + a, color);
    }
    x += cw;
  }
}

export function render(m, base, name, note) {
  const p = pattern(m, base);
  const lh = (p.H >= 400 ? 2 : 1) * 11;
  let y = Math.round(p.H * 0.56);
  const [ha, hb, he, ht] = m.h, [va, vb, ve, vt] = m.v;
  text(p, `${name.toUpperCase()}  ${(ha / base.h[0] * 100).toFixed(1)}% X ${(va / base.v[0] * 100).toFixed(1)}%`, p.W / 2, y); y += lh;
  text(p, `PCLOCK ${m.pclock}`, p.W / 2, y, [255, 230, 120]); y += lh;
  text(p, `H ${ha} ${hb} ${he} ${ht}`, p.W / 2, y, [255, 230, 120]); y += lh;
  text(p, `V ${va} ${vb} ${ve} ${vt}${m.interlace ? ' I' : ''}`, p.W / 2, y, [255, 230, 120]); y += lh;
  if (note) text(p, note, p.W / 2, y, [120, 255, 140]);
  else { text(p, 'ARROWS MOVE  A D WIDTH', p.W / 2, y, [160, 200, 255]); y += lh; text(p, 'W S HEIGHT  ENTER SAVE', p.W / 2, y, [160, 200, 255]); }
  return p;
}

// ------------------------------------------------------------------ adjusting the modeline
// Moving: shift the sync pulse (begin/end together); a later pulse moves the picture left/up.
// Resizing: change the active size and split the difference between both porches so the
// picture stays centred. Pixel clock and totals never change, so it stays a TV signal.
export function adjust(m, what) {
  const n = { ...m, h: [...m.h], v: [...m.v] };
  const vs = n.interlace ? 2 : 1;
  const ok = x => {
    const [ha, hb, he, ht] = x.h, [va, vb, ve, vt] = x.v;
    return ha >= 160 && hb - ha >= 4 && ht - he >= 8 && va >= 120 && vb - va >= 1 && vt - ve >= 4 && ha <= 720 && va <= 576;
  };
  switch (what) {
    case 'left':  n.h[1] += 2; n.h[2] += 2; break;
    case 'right': n.h[1] -= 2; n.h[2] -= 2; break;
    case 'up':    n.v[1] += vs; n.v[2] += vs; break;
    case 'down':  n.v[1] -= vs; n.v[2] -= vs; break;
    case 'narrower': n.h[0] -= 8; n.h[1] -= 4; n.h[2] -= 4; break;
    case 'wider':    n.h[0] += 8; n.h[1] += 4; n.h[2] += 4; break;
    case 'shorter':  n.v[0] -= 2 * vs; n.v[1] -= vs; n.v[2] -= vs; break;
    case 'taller':   n.v[0] += 2 * vs; n.v[1] += vs; n.v[2] += vs; break;
  }
  return ok(n) ? n : m;
}

// ------------------------------------------------------------------ main
async function main() {
  const host0 = process.argv[2] || process.env.MISTER || 'MiSTer.mshome.net';
  const name = (process.argv[3] || process.env.GROOVY_MODE || '480i').toLowerCase();
  const base = BASE_MODES[name];
  if (!base) throw new Error(`unknown mode "${name}". Modes: ${Object.keys(BASE_MODES).join(', ')}`);
  let host = host0;
  try { host = (await dns.lookup(host0, { family: 4 })).address; } catch { throw new Error(`can't find ${host0}`); }
  const cal = loadCalibration();
  let m = cal[name] ? { ...cal[name] } : { ...base, h: [...base.h], v: [...base.v] };
  let note = '', saved = false;

  const sock = dgram.createSocket('udp4'), inputs = dgram.createSocket('udp4');
  let acked = false;
  sock.on('message', msg => { if (msg.length === 13) acked = true; });
  const send = b => new Promise(r => sock.send(b, 32100, host, r));
  await new Promise(r => sock.bind(0, r)); sock.setSendBufferSize(2 * 1024 * 1024);
  await new Promise(r => inputs.bind(0, r));
  const register = () => inputs.send(Buffer.from([0]), 32101, host);
  const keepAlive = setInterval(register, 4000);
  // Connect the way OOMPAS does at start-up (INIT, then SWITCHRES, then frames from 0).
  // A timing change mid-stream lost sync on some Groovy builds, so every change
  // reconnects this same, known-good way: a short blink on the TV each press.
  const connect = async (first) => {
    acked = false;
    for (let i = 0; i < 20 && !acked; i++) {
      register(); await new Promise(r => setTimeout(r, 50));
      await send(Buffer.from([CMD.INIT, 1, 3, 2, 2]));             // LZ4, 48 kHz, stereo, RGB565
      await new Promise(r => setTimeout(r, first ? 300 : 120));
      if (!acked && i === 0 && first) log(`Waiting for the Groovy core at ${host}... (Utility > Groovy on the MiSTer; close MiSTerCast first)`);
    }
    if (!acked) throw new Error(`no answer from ${host}:32100`);
  };
  await connect(true);
  log(`Calibrating ${name} on ${host}. Keys: arrows move, A/D (or [ ] , .) width, W/S (or - =) height, R reset, T try real timing, Enter save, Esc quit.`);

  // The TV normally stays on the standard timing while you adjust: the picture is moved
  // and resized in software (like OOMPAS's P menu), so every keypress is instant and the
  // TV never re-syncs. The pattern is drawn exactly where the adjusted timing would put
  // it, so what you see is what you get. Enter saves the matching timing; T switches the
  // TV to the real adjusted timing to check it (one short blink), and T again goes back.
  let live = null, realView = false, frame = 0, phase = 0, pic = null;
  const same = (x, y) => x && y && x.pclock === y.pclock && x.interlace === y.interlace && x.h.every((v, i) => v === y.h[i]) && x.v.every((v, i) => v === y.v[i]);
  const switchTo = async t => {
    if (same(live, t)) return;
    if (live) {                                        // a timing change: reconnect cleanly
      await send(Buffer.from([CMD.CLOSE]));
      await new Promise(r => setTimeout(r, 150));
      await connect(false);
      frame = 0; phase = 0;
    }
    const b = Buffer.alloc(26);
    b[0] = CMD.SWITCHRES; b.writeDoubleLE(t.pclock, 1);
    [...t.h, ...t.v].forEach((x, i) => b.writeUInt16LE(x, 9 + i * 2));
    b[25] = t.interlace;
    await send(b);
    await new Promise(r => setTimeout(r, 30));
    live = { ...t, h: [...t.h], v: [...t.v] };
  };
  const preview = () => {
    // Where the adjusted picture lands inside the standard one: the active area starts
    // (total - syncEnd) after the sync pulse, so the offset is the change in sync end.
    const inner = render(m, base, name, note || 'PREVIEW  T TRY IT FOR REAL');
    const W = base.h[0], H = base.v[0], out = Buffer.alloc(W * H * 3);
    const x0 = base.h[2] - m.h[2], y0 = base.v[2] - m.v[2];
    for (let y = 0; y < inner.H; y++) {
      const ty = y + y0; if (ty < 0 || ty >= H) continue;
      const sx0 = Math.max(0, -x0), sx1 = Math.min(inner.W, W - x0);
      if (sx1 > sx0) inner.rgb.copy(out, (ty * W + x0 + sx0) * 3, (y * inner.W + sx0) * 3, (y * inner.W + sx1) * 3);
    }
    return { rgb: out, W, H };
  };
  const redraw = async () => {
    if (realView) { pic = render(m, base, name, note || 'REAL TIMING  T BACK TO PREVIEW'); await switchTo(m); }
    else { pic = preview(); await switchTo(base); }
    console.log(`  MiSTerCast: Pclock ${m.pclock}  Hactive ${m.h[0]}  Hbegin ${m.h[1]}  Hend ${m.h[2]}  Htotal ${m.h[3]}  Vactive ${m.v[0]}  Vbegin ${m.v[1]}  Vend ${m.v[2]}  Vtotal ${m.v[3]}  Interlace ${m.interlace ? 'on' : 'off'}`);
  };
  const lz = Buffer.alloc(720 * 576 * 3 + 65536), px = Buffer.alloc(720 * 576 * 2);
  const blit = async field => {
    const { rgb, W, H } = pic;
    let src = rgb, lines = H;
    if (live.interlace) {
      lines = H >> 1; src = Buffer.alloc(W * lines * 3);
      for (let y = field, o = 0; y < H; y += 2, o += W * 3) rgb.copy(src, o, y * W * 3, (y + 1) * W * 3);
    }
    const n = W * lines;
    for (let i = 0; i < n; i++) { const v = ((src[i * 3] & 0xf8) << 8) | ((src[i * 3 + 1] & 0xfc) << 3) | (src[i * 3 + 2] >> 3); px[i * 2] = v & 255; px[i * 2 + 1] = v >> 8; }
    const size = lz4Block(px.subarray(0, n * 2), lz);
    const head = Buffer.alloc(12);
    head[0] = CMD.BLIT_FIELD_VSYNC; head.writeUInt32LE(++frame, 1); head[5] = field;
    head.writeUInt16LE((live.interlace ? live.v[3] >> 1 : live.v[3]) >> 1, 6); head.writeUInt32LE(size, 8);
    await send(head);
    let last; for (let o = 0; o < size; o += MTU) last = send(Buffer.from(lz.subarray(o, Math.min(size, o + MTU)))); await last;
  };

  let busy = Promise.resolve();
  const act = what => { busy = busy.then(async () => {
    if (what === 'quit') { clearInterval(keepAlive); await send(Buffer.from([CMD.CLOSE])); log(saved ? 'Done.' : 'Quit without saving.'); process.exit(0); }
    if (what === 'save') {
      const all = loadCalibration(); all[name] = m;
      fs.writeFileSync(CAL_FILE, JSON.stringify(all, null, 1)); saved = true;
      note = 'SAVED - TYPE INTO MISTERCAST';
      log(`Saved ${name} to ${path.basename(CAL_FILE)}; OOMPAS's Groovy mode uses it from now on.`);
      if (process.env.MISTERCAST_DIR) {
        const err = saveToMiSTerCast(name, m);
        if (err) log(`MiSTerCast: ${err}`);
        else { log(`Added it to MiSTerCast's presets as "${PRESET_LABEL[name] || name} OOMPAS calibrated" (restart MiSTerCast to see it).`); note = 'SAVED - ALSO IN MISTERCAST PRESETS'; }
      }
    } else if (what === 'try') { realView = !realView; note = '';
    } else if (what === 'reset') { m = { ...base, h: [...base.h], v: [...base.v] }; note = 'STANDARD TIMING'; }
    else { m = adjust(m, what); note = ''; }
    await redraw();
  }).catch(e => log('error: ' + e.message)); };

  // Keys on the PC
  if (process.stdin.isTTY) {
    readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on('keypress', (s, k = {}) => {
      if (k.ctrl && k.name === 'c') return act('quit');
      const map = { up: 'up', down: 'down', left: 'left', right: 'right', return: 'save', enter: 'save', escape: 'quit', q: 'quit', r: 'reset', t: 'try' };
      const ch = { '[': 'narrower', ']': 'wider', '{': 'narrower', '}': 'wider', ',': 'narrower', '.': 'wider', '<': 'narrower', '>': 'wider',
        a: 'narrower', d: 'wider', A: 'narrower', D: 'wider', w: 'taller', s: 'shorter', W: 'taller', S: 'shorter',
        '-': 'shorter', '=': 'taller', '+': 'taller', '_': 'shorter' };
      const a = map[k.name] || ch[s];
      if (a) act(a);
    });
  }
  // Keys on the MiSTer (SDL scancodes)
  const SDL = { 82: 'up', 81: 'down', 80: 'left', 79: 'right', 47: 'narrower', 48: 'wider', 45: 'shorter', 46: 'taller',
                54: 'narrower', 55: 'wider', 4: 'narrower', 7: 'wider', 26: 'taller', 22: 'shorter', 86: 'shorter', 87: 'taller', 21: 'reset', 23: 'try', 40: 'save', 88: 'save', 41: 'quit', 20: 'quit' };
  let prev = Buffer.alloc(32);
  inputs.on('message', msg => {
    if (msg.length === 37 || msg.length === 41) {
      const bits = msg.subarray(5, 37);
      for (const [c, a] of Object.entries(SDL)) { const i = +c; if ((bits[i >> 3] >> (i & 7) & 1) && !(prev[i >> 3] >> (i & 7) & 1)) act(a); }
      prev = Buffer.from(bits);
    } else if (msg.length === 9 || msg.length === 17) {        // controller: d-pad moves
      const j = msg.readUInt16LE(5);
      if (j & 8) act('up'); if (j & 4) act('down'); if (j & 2) act('left'); if (j & 1) act('right');
    }
  });

  await redraw();
  // Keep sending the pattern (both fields when interlaced) so the picture stays up.
  const fps = (m.pclock * 1e6) / (m.h[3] * m.v[3]) * (m.interlace ? 2 : 1);
  for (let n = 0; ; n++) {
    const t = Date.now();
    // Blits and timing changes share one queue: a SWITCHRES must never land in the
    // middle of a frame's packets, or the core reads it as picture data and loses sync.
    busy = busy.then(() => blit(live.interlace ? (phase++) & 1 : 0)).catch(e => log('error: ' + e.message));
    await busy;
    const wait = 1000 / fps - (Date.now() - t);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('groovy-calibrate.mjs')) {
  main().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
}
