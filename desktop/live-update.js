// Engine updates without reinstalling: the app checks the repo's main branch for a newer
// pc-server/version.json, downloads that commit, unpacks pc-server/ into the app's data folder,
// makes sure it loads, and switches to it (the server restarts and the window reloads, a couple
// of seconds). The installer is only needed when the app around it (Electron, FFmpeg) changes.
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');

const OWNER = 'awakening-diamond', REPO = 'oompas-box', BRANCH = 'main';
const T = process.env.OOMPAS_ENGINE_TEST;   // tests: a local server standing in for GitHub
const URLS = {
  sha: () => T ? `${T}/sha` : `https://api.github.com/repos/${OWNER}/${REPO}/commits/${BRANCH}`,
  version: sha => T ? `${T}/raw/${sha}/pc-server/version.json` : `https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/pc-server/version.json`,
  tarball: sha => T ? `${T}/tar/${sha}` : `https://codeload.github.com/${OWNER}/${REPO}/tar.gz/${sha}`,
};

const cmp = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

class LiveUpdate {
  constructor({ dataDir, bundledDir, shellVersion, log }) {
    this.root = path.join(dataDir, 'engine');
    this.bundledDir = bundledDir;
    this.shellVersion = shellVersion;
    this.log = log;
    this.currentFile = path.join(this.root, 'current.json');
  }

  bundled() { return { dir: this.bundledDir, version: readJson(path.join(this.bundledDir, 'version.json'))?.version || '0.0.0', live: false }; }

  // The engine to run: a downloaded one if it's newer than the bundled one, works with this app,
  // and hasn't failed to start.
  choose() {
    const b = this.bundled();
    const cur = readJson(this.currentFile);
    if (!cur || cur.bad || !cur.dir || !fs.existsSync(path.join(cur.dir, 'server.mjs'))) return b;
    if (cmp(cur.version, b.version) <= 0) return b;
    if (cur.minShell && cmp(this.shellVersion, cur.minShell) < 0) return b;
    return { dir: cur.dir, version: cur.version, sha: cur.sha, live: true };
  }

  markBad() {
    const cur = readJson(this.currentFile);
    if (cur) { cur.bad = true; fs.writeFileSync(this.currentFile, JSON.stringify(cur, null, 1)); this.log(`Engine ${cur.version} didn't start; back to the built-in one.`); }
  }

  async fetch(url, accept) {
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'OOMPAS-Box', ...(accept ? { accept } : {}) } });
      if (!r.ok) throw new Error(`${r.status} from ${new URL(url).hostname}`);
      return Buffer.from(await r.arrayBuffer());
    } finally { clearTimeout(t); }
  }

  // Returns the new engine's version if it switched to one, else null.
  async check(running) {
    const sha = String(await this.fetch(URLS.sha(), 'application/vnd.github.sha')).trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unexpected answer from GitHub');
    const cur = readJson(this.currentFile);
    if (cur?.checkedSha === sha) return null;
    const ver = JSON.parse(await this.fetch(URLS.version(sha)));
    const remember = () => { const c = readJson(this.currentFile) || {}; c.checkedSha = sha; fs.mkdirSync(this.root, { recursive: true }); fs.writeFileSync(this.currentFile, JSON.stringify(c, null, 1)); };
    if (cmp(ver.version, running.version) <= 0 || (cur?.bad && cur.version === ver.version)) { remember(); return null; }
    if (ver.minShell && cmp(this.shellVersion, ver.minShell) < 0) {
      this.log(`Engine ${ver.version} needs OOMPAS Box ${ver.minShell} or newer; waiting for the app update.`);
      remember(); return null;
    }
    this.log(`Downloading engine ${ver.version}…`);
    const tgz = await this.fetch(URLS.tarball(sha));
    const dir = path.join(this.root, `${ver.version}-${sha.slice(0, 7)}`);
    const tmp = dir + '.tmp';
    fs.rmSync(tmp, { recursive: true, force: true });
    const n = untarPcServer(zlib.gunzipSync(tgz), tmp);
    if (!fs.existsSync(path.join(tmp, 'server.mjs'))) throw new Error('the download had no engine in it');
    await this.smokeTest(tmp);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    fs.writeFileSync(this.currentFile, JSON.stringify({ version: ver.version, minShell: ver.minShell || '', sha, dir, checkedSha: sha, at: new Date().toISOString() }, null, 1));
    this.log(`Engine ${ver.version} ready (${n} files).`);
    // Keep just this one and whatever is running now.
    for (const d of fs.readdirSync(this.root)) {
      const p = path.join(this.root, d);
      if (p !== dir && p !== running.dir && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    }
    return ver.version;
  }

  // The new engine must at least load (all its files present, no syntax errors).
  smokeTest(dir) {
    return new Promise((resolve, reject) => {
      const p = spawn(process.execPath, [path.join(dir, 'server.mjs')], {
        cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OOMPAS_SMOKE: '1' },
      });
      let out = '';
      p.stdout.on('data', d => (out += d)); p.stderr.on('data', d => (out += d));
      const t = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('the new engine took too long to load')); }, 30000);
      p.on('exit', code => { clearTimeout(t); code === 0 && /smoke ok/.test(out) ? resolve() : reject(new Error('the new engine didn’t load: ' + out.slice(-400))); });
    });
  }
}

// Unpacks the pc-server/ folder of a GitHub tarball (ustar/pax) into dest. Returns the file count.
function untarPcServer(buf, dest) {
  let off = 0, n = 0, longName = null, paxPath = null;
  const str = (a, b) => buf.toString('utf8', off + a, off + b).replace(/\0.*$/s, '');
  while (off + 512 <= buf.length) {
    if (buf.readUInt32LE(off) === 0 && buf.subarray(off, off + 512).every(x => x === 0)) break;
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 48);
    let name = str(0, 100);
    const prefix = str(345, 500);
    if (prefix) name = prefix + '/' + name;
    const body = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { const m = body.toString('utf8').match(/^\d+ path=(.*)$/m); paxPath = m ? m[1] : null; continue; }
    if (type === 'g') continue;
    if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (longName) { name = longName; longName = null; }
    const parts = name.split('/');
    if (parts[1] !== 'pc-server' || parts.length < 3) continue;
    const rel = parts.slice(2).filter(Boolean);
    if (!rel.length || rel.some(p => p === '..' || p === '.') || /^(oompas-cache|music|node_modules)$/.test(rel[0])) continue;
    const out = path.join(dest, ...rel);
    if (type === '5') { fs.mkdirSync(out, { recursive: true }); continue; }
    if (type !== '0' && type !== '\0' && type !== '7') continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, body);
    n++;
  }
  return n;
}

module.exports = { LiveUpdate, untarPcServer, cmp };
