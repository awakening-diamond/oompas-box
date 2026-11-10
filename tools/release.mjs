// Publishes a new OOMPAS Box version to GitHub Releases (run from desktop/: npm run release).
// Needs: gh (logged in), wine (Windows installer), rcodesign (ad-hoc Mac signature, optional).
// 1. bump "version" in desktop/package.json   2. npm run release
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESK = path.join(ROOT, 'desktop');
const run = (cmd, opts = {}) => { console.log('> ' + cmd); return execSync(cmd, { stdio: 'inherit', cwd: DESK, ...opts }); };
const pkgFile = path.join(DESK, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const owner = process.env.OOMPAS_OWNER || execSync('gh api user -q .login', { encoding: 'utf8' }).trim();
const repo = pkg.build.publish[0].repo;
pkg.build.publish[0].owner = owner;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
const v = pkg.version, tag = 'v' + v;

fs.rmSync(path.join(DESK, 'dist'), { recursive: true, force: true });
run('npx electron-builder --win nsis --x64 --publish never');
run('npx electron-builder --mac zip --x64 --arm64 --publish never');

// Ad-hoc sign the Mac apps (Apple Silicon won't run unsigned code), re-zip, and fix latest-mac.yml.
const dist = path.join(DESK, 'dist');
const rcs = process.env.RCODESIGN || 'rcodesign';
const sha512 = f => crypto.createHash('sha512').update(fs.readFileSync(f)).digest('base64');
let macYml = fs.readFileSync(path.join(dist, 'latest-mac.yml'), 'utf8');
for (const [dir, arch] of [['mac', 'x64'], ['mac-arm64', 'arm64']]) {
  const app = path.join(dist, dir, `${pkg.productName}.app`);
  try { execSync(`${rcs} sign "${app}"`, { stdio: 'ignore' }); } catch { console.warn('rcodesign not available: Mac build left unsigned'); }
  const zip = `OOMPAS-Box-${v}-mac-${arch}.zip`;
  fs.rmSync(path.join(dist, zip), { force: true });
  execSync(`zip -qry "../${zip}" "${pkg.productName}.app"`, { cwd: path.join(dist, dir) });
  const size = fs.statSync(path.join(dist, zip)).size, hash = sha512(path.join(dist, zip));
  macYml = macYml.replace(new RegExp(`(url: ${zip.replace(/\./g, '\\.')}\\n\\s+sha512: )\\S+(\\n\\s+size: )\\d+`), `$1${hash}$2${size}`);
  if (arch === 'x64') macYml = macYml.replace(/^sha512: \S+/m, `sha512: ${hash}`);
}
fs.writeFileSync(path.join(dist, 'latest-mac.yml'), macYml);

try { run('git add -A && git commit -m "OOMPAS Box ' + v + '" && git push', { cwd: ROOT }); } catch { console.warn('git push skipped'); }

const assets = [`OOMPAS-Box-Setup-${v}.exe`, `OOMPAS-Box-Setup-${v}.exe.blockmap`, 'latest.yml',
  `OOMPAS-Box-${v}-mac-x64.zip`, `OOMPAS-Box-${v}-mac-arm64.zip`, 'latest-mac.yml']
  .map(f => `"${path.join(dist, f)}"`).join(' ');
run(`gh release create ${tag} ${assets} --repo ${owner}/${repo} --title "OOMPAS Box ${v}" --notes-file "${path.join(ROOT, 'CHANGES.md')}"`);
console.log(`Released ${tag}: https://github.com/${owner}/${repo}/releases/tag/${tag}`);
