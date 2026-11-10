// Paulstretch (Paul Nasca's extreme time-stretch), run in a worker thread so the
// server keeps streaming while it works. Each window of the input is analysed with
// an FFT, its phases are scrambled, and the windows are overlapped back together
// far more slowly than they were read, which smears the music into slow washes.
//
// Message in:  { input: Float32Array (mono), sr, stretch, winSec, seed, chunkSec }
// Messages out: { type: 'chunk', data: Float32Array } ... then { type: 'done', samples }

import { parentPort } from 'node:worker_threads';

function makeFft(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  return (re, im, inverse) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const wr = cos[k], wi = inverse ? sin[k] : -sin[k];
          const a = i + j, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  };
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

parentPort.on('message', ({ input, sr, stretch, winSec = 0.75, seed = 1, chunkSec = 10 }) => {
  const N = 2 ** Math.max(8, Math.round(Math.log2(winSec * sr))), half = N / 2;
  const fft = makeFft(N), R = rng(seed);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) { const x = 2 * i / (N - 1) - 1; win[i] = Math.pow(1 - x * x, 1.25); }
  const re = new Float64Array(N), im = new Float64Array(N), tail = new Float64Array(half);
  const hopIn = half / stretch;
  const chunkLen = Math.max(half, Math.floor(chunkSec * sr / half) * half);
  let chunk = new Float32Array(chunkLen), fill = 0, total = 0;
  const gain = 0.5;

  for (let pos = 0; pos + N < input.length; pos += hopIn) {
    const p = Math.floor(pos);
    for (let i = 0; i < N; i++) { re[i] = input[p + i] * win[i]; im[i] = 0; }
    fft(re, im, false);
    // Keep each frequency's strength, scramble its phase (mirrored so the result is real).
    for (let k = 0; k <= half; k++) {
      const mag = Math.hypot(re[k], im[k]);
      if (k === 0 || k === half) { re[k] = mag; im[k] = 0; continue; }
      const ph = R() * 2 * Math.PI;
      re[k] = mag * Math.cos(ph); im[k] = mag * Math.sin(ph);
      re[N - k] = re[k]; im[N - k] = -im[k];
    }
    fft(re, im, true);
    for (let i = 0; i < half; i++) {
      chunk[fill++] = (tail[i] + re[i] * win[i]) * gain;
      tail[i] = re[half + i] * win[half + i];
    }
    if (fill >= chunkLen) {
      parentPort.postMessage({ type: 'chunk', data: chunk }, [chunk.buffer]);
      total += fill; chunk = new Float32Array(chunkLen); fill = 0;
    }
  }
  if (fill) { const last = chunk.slice(0, fill); parentPort.postMessage({ type: 'chunk', data: last }, [last.buffer]); total += fill; }
  parentPort.postMessage({ type: 'done', samples: total });
});
