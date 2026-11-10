// Builds db.json: a MiSTer Downloader database, so update_all keeps the OOMPAS Box
// scripts on the MiSTer up to date. Usage: node tools/make-mister-db.mjs <github-owner> [repo] [branch]
// On the MiSTer, add to /media/fat/downloader.ini:
//   [oompas_box]
//   db_url = https://raw.githubusercontent.com/<owner>/<repo>/<branch>/db.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [owner, repo = 'oompas-box', branch = 'main'] = process.argv.slice(2);
if (!owner) { console.error('usage: node tools/make-mister-db.mjs <github-owner> [repo] [branch]'); process.exit(1); }
const SKIP = /(^|\/)(__pycache__|last_channel|\.DS_Store)(\/|$)|\.pyc$/;
const files = {}, folders = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(path.join(ROOT, 'mister'), full).split(path.sep).join('/');
    if (SKIP.test(rel)) continue;
    if (e.isDirectory()) { folders[rel] = {}; walk(full); continue; }
    const buf = fs.readFileSync(full);
    files[rel] = {
      hash: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length,
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/mister/${rel.split('/').map(encodeURIComponent).join('/')}`,
    };
  }
})(path.join(ROOT, 'mister'));
const db = { db_id: 'oompas_box', timestamp: Math.floor(Date.now() / 1000), files, folders };
fs.writeFileSync(path.join(ROOT, 'db.json'), JSON.stringify(db, null, 1) + '\n');
console.log(`db.json: ${Object.keys(files).length} files, ${Object.keys(folders).length} folders`);
