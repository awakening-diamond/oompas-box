// OOMPAS Box desktop app (Windows and Mac).
// Starts the OOMPAS server (the same one the MiSTer uses) with a bundled FFmpeg, then shows
// the TV interface (served by the server at /tv/) in a full-window player. Quitting the app
// stops the server and everything it started.
const { app, BrowserWindow, Menu, shell, ipcMain, dialog, powerSaveBlocker, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.OOMPAS_PORT || 8090);
const PACKED = app.isPackaged;
const SERVER_DIR = PACKED ? path.join(process.resourcesPath, 'pc-server')
                          : path.join(__dirname, '..', 'pc-server');
const FFMPEG = (() => {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = PACKED ? path.join(process.resourcesPath, 'ffmpeg', exe)
                         : path.join(__dirname, 'ffmpeg', `${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch}`, exe);
  return fs.existsSync(bundled) ? bundled : (process.env.FFMPEG || 'ffmpeg');
})();
const DATA = app.getPath('userData');
const TOKEN = crypto.randomBytes(16).toString('hex');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ------------------------------------------------------------ updates (GitHub Releases)
// Windows: downloads in the background and installs when you restart the app.
// Mac: the app isn't signed by Apple, so it can't replace itself; it tells you and opens the download page.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch {}
function updateSource() {
  try {
    const y = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const owner = (y.match(/^owner:\s*(\S+)/m) || [])[1], repo = (y.match(/^repo:\s*(\S+)/m) || [])[1];
    return owner && repo && owner !== 'OWNER-NOT-SET' ? { owner, repo } : null;
  } catch { return null; }
}
let updateReady = null, manualCheck = false;
function setupUpdates() {
  const src = PACKED && autoUpdater && updateSource();
  if (!src) return false;
  const isWin = process.platform === 'win32';
  autoUpdater.autoDownload = isWin;
  autoUpdater.autoInstallOnAppQuit = isWin;
  autoUpdater.logger = { info: m => log('update: ' + m), warn: m => log('update: ' + m), error: m => log('update error: ' + m), debug: () => {} };
  autoUpdater.on('update-available', info => {
    if (isWin) { if (manualCheck) dialog.showMessageBox({ title: 'OOMPAS Box', message: `Downloading OOMPAS Box ${info.version}\u2026`, detail: 'You\u2019ll be asked to restart when it\u2019s ready.' }); return; }
    dialog.showMessageBox({ type: 'info', title: 'OOMPAS Box', buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1,
      message: `OOMPAS Box ${info.version} is available (you have ${app.getVersion()}).`,
      detail: 'Download the new version and replace the app in Applications. Your settings and channels stay.' })
      .then(r => { if (r.response === 0) shell.openExternal(`https://github.com/${src.owner}/${src.repo}/releases/latest`); });
  });
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) dialog.showMessageBox({ title: 'OOMPAS Box', message: `You have the latest version (${app.getVersion()}).` });
    manualCheck = false;
  });
  autoUpdater.on('error', e => {
    if (manualCheck) dialog.showMessageBox({ type: 'warning', title: 'OOMPAS Box', message: 'Couldn\u2019t check for updates.', detail: String(e?.message || e).slice(0, 400) });
    manualCheck = false;
  });
  autoUpdater.on('update-downloaded', info => {
    updateReady = info;
    manualCheck = false;
    dialog.showMessageBox({ type: 'info', title: 'OOMPAS Box', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `OOMPAS Box ${info.version} is ready.`, detail: 'Restart to finish updating (or it installs next time you close the app).' })
      .then(async r => {
        if (r.response !== 0) return;
        quitting = true;
        await stopServer();
        autoUpdater.quitAndInstall(false, true);
      });
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 15000);
  setInterval(check, 6 * 3600e3);
  return true;
}
function checkForUpdatesNow() {
  if (!setupUpdates.done) setupUpdates.done = setupUpdates() ? 'on' : 'off';
  if (setupUpdates.done !== 'on') {
    return dialog.showMessageBox({ title: 'OOMPAS Box', message: 'Updates aren\u2019t set up in this copy.',
      detail: PACKED ? 'This build doesn\u2019t know where updates are published yet.' : 'Updates only work in the installed app.' });
  }
  if (updateReady) return autoUpdater.emit('update-downloaded', updateReady);
  manualCheck = true;
  autoUpdater.checkForUpdates().catch(() => {});
}
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win = null, server = null, external = false, quitting = false, blocker = -1;
const LOG = [];
const log = line => { LOG.push(line); if (LOG.length > 800) LOG.splice(0, 200); if (!PACKED) process.stdout.write(line + '\n'); };

function get(urlPath, ms = 1200) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: urlPath, timeout: ms }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function startServer() {
  // Already running? (The OOMPAS Server window, or another copy.)
  const st = await get('/api/state');
  if (st && st.status === 200 && /OOMPAS Box/.test(st.body)) { external = true; log('Using the OOMPAS server that’s already running.'); return; }
  if (st || (await get('/channels.json'))) {
    const r = await dialog.showMessageBox({
      type: 'warning', buttons: ['Try again', 'Quit'], defaultId: 0, cancelId: 1, title: 'OOMPAS Box',
      message: `An older OOMPAS server (or another program) is using port ${PORT}.`,
      detail: 'Close the OOMPAS Server window or start-server.bat, then press Try again.\n\nThis app runs its own, newer server, which your MiSTer can use too.',
    });
    if (r.response === 0) return startServer();
    app.quit();
    throw new Error('port busy');
  }

  for (const d of ['oompas-cache', 'music', 'vendor']) fs.mkdirSync(path.join(DATA, d), { recursive: true });
  const readme = path.join(DATA, 'music', 'PUT-MUSIC-HERE.txt');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, 'Put music files (mp3, flac, ogg, m4a, wav) here for the Guide and Weather channels.\r\n');

  server = spawn(process.execPath, [path.join(SERVER_DIR, 'server.mjs')], {
    cwd: SERVER_DIR, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), FFMPEG,
           APP_DATA: DATA, OOMPAS_CACHE: path.join(DATA, 'oompas-cache'), MUSIC_DIR: path.join(DATA, 'music'),
           ENGINE_FILE: path.join(DATA, 'vendor', 'schedule-engine.mjs'), OOMPAS_APP_TOKEN: TOKEN },
  });
  let ready, failed;
  const done = new Promise((res, rej) => { ready = res; failed = rej; });
  const onData = d => {
    for (const line of String(d).split(/\r?\n/)) {
      if (!line) continue;
      log(line);
      if (line.includes('server ready on port')) ready();
    }
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.on('exit', code => {
    log(`Server stopped (${code}).`);
    server = null;
    failed(new Error(LOG.slice(-6).join('\n')));
    if (!quitting) {
      dialog.showMessageBox({ type: 'error', title: 'OOMPAS Box', message: 'The OOMPAS server stopped.',
        detail: LOG.slice(-8).join('\n'), buttons: ['Restart it', 'Quit'] }).then(r => {
        if (r.response === 0) startServer().then(() => win?.reload()).catch(() => {}); else app.quit();
      });
    }
  });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('The server took too long to start.\n' + LOG.slice(-6).join('\n'))), 90000))]);
}

async function stopServer() {
  if (!server) return;
  const s = server;
  await get(`/quit?token=${TOKEN}`, 1500);
  await new Promise(r => { const t = setTimeout(r, 3000); s.once('exit', () => { clearTimeout(t); r(); }); });
  if (s.exitCode === null) { try { s.kill(); } catch {} }
}

// The window keeps the size (and place) you left it at, between launches.
const BOUNDS_FILE = path.join(DATA, 'window.json');
function savedBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
    const area = screen.getDisplayMatching(b).workArea;
    const onScreen = b.x < area.x + area.width - 60 && b.x + b.width > area.x + 60 && b.y >= area.y - 10 && b.y < area.y + area.height - 60;
    if (b.width >= 320 && b.height >= 240 && onScreen) return b;
  } catch {}
  return null;
}
let boundsT = 0;
function rememberBounds() {
  clearTimeout(boundsT);
  boundsT = setTimeout(() => {
    if (!win || win.isFullScreen() || win.isMinimized()) return;
    try { fs.writeFileSync(BOUNDS_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() })); } catch {}
  }, 500);
}

function createWindow() {
  const sb = savedBounds();
  win = new BrowserWindow({
    width: sb?.width || 1280, height: sb?.height || 960, ...(sb ? { x: sb.x, y: sb.y } : {}),
    minWidth: 320, minHeight: 240, backgroundColor: '#000000', title: 'OOMPAS Box',
    autoHideMenuBar: true, show: false,
    icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
  win.once('ready-to-show', () => { if (sb?.maximized) win.maximize(); win.show(); });
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, rememberBounds);
  win.on('closed', () => { win = null; });

  // Links that leave the TV interface open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://127.0.0.1:${PORT}/`) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  blocker = powerSaveBlocker.start('prevent-display-sleep');
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'Open Data Folder', click: () => shell.openPath(DATA) },
      { label: 'Open Music Folder', click: () => shell.openPath(path.join(DATA, 'music')) },
      { label: 'Open in Browser', click: () => shell.openExternal(`http://localhost:${PORT}/tv/`) },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ] },
    { label: 'View', submenu: [
      { role: 'togglefullscreen', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
      { label: 'Window Size', submenu: [
        ...[[320, 240], [640, 480], [800, 600], [960, 720], [1024, 768], [1280, 960], [1440, 1080]].map(([w, h], i) => ({
          label: `${w} \u00D7 ${h}` + (w === 320 ? '  (MiSTer size)' : ''), accelerator: i ? `CmdOrCtrl+${i}` : undefined,
          click: () => setPictureSize(w, h) })),
        { type: 'separator' },
        { label: 'Widescreen 854 \u00D7 480', click: () => setPictureSize(854, 480) },
        { label: 'Widescreen 1280 \u00D7 720', click: () => setPictureSize(1280, 720) },
      ] },
      { role: 'reload' },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'toggleDevTools' },
    ] },
    { label: 'Help', submenu: [
      { label: 'Check for Updates\u2026', click: () => checkForUpdatesNow() },
      { label: 'Server Log', click: () => showLog() },
      { label: 'About OOMPAS Box', click: () => dialog.showMessageBox({ title: 'OOMPAS Box', message: `OOMPAS Box ${app.getVersion()}`,
        detail: `Server: http://localhost:${PORT}/  (your MiSTer finds it by itself)\nData: ${DATA}\nFFmpeg: ${FFMPEG}\n\nVideo from the Internet Archive. Spelunkr channels from spelunkr.tv. Free IPTV lists from iptv-org.` }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showLog() {
  const w = new BrowserWindow({ width: 900, height: 600, title: 'OOMPAS Box – server log', autoHideMenuBar: true, backgroundColor: '#0b2f37' });
  const html = `<body style="margin:0;background:#0b2f37;color:#cfe;font:13px/1.35 Consolas,Menlo,monospace">
    <pre id=l style="padding:10px;white-space:pre-wrap"></pre><script>
    const l=document.getElementById('l');
    async function f(){try{const d=await (await fetch('http://127.0.0.1:${PORT}/api/log')).json();const atEnd=innerHeight+scrollY>=document.body.scrollHeight-20;
      l.textContent=d.lines.join('\\n');if(atEnd)scrollTo(0,document.body.scrollHeight);}catch{}}
    f();setInterval(f,2000);</script></body>`;
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

ipcMain.on('fullscreen', () => { if (win) win.setFullScreen(!win.isFullScreen()); });

// Window takes the picture's size (Settings > Window size). Shrinks to fit the screen, keeps its centre.
let fitSize = null;
function applyFit() {
  if (!win || !fitSize || win.isFullScreen() || win.isMaximized()) return;
  let [w, h] = fitSize;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  const chrome = [b.width - win.getContentBounds().width, b.height - win.getContentBounds().height];
  const k = Math.min(1, (area.width - chrome[0]) / w, (area.height - chrome[1]) / h);
  w = Math.round(w * k); h = Math.round(h * k);
  const cw = win.getContentBounds();
  if (Math.abs(cw.width - w) < 2 && Math.abs(cw.height - h) < 2) return;
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const W = w + chrome[0], H = h + chrome[1];
  const x = Math.round(Math.min(Math.max(area.x, cx - W / 2), area.x + area.width - W));
  const y = Math.round(Math.min(Math.max(area.y, cy - H / 2), area.y + area.height - H));
  win.setBounds({ x, y, width: W, height: H });
}
// Sets the picture area to w x h once (Window Size menu, or Settings). Dragging still works,
// and the window then stays the size you dragged it to.
function setPictureSize(w, h) {
  if (!win || win.isFullScreen()) return;
  if (win.isMaximized()) win.unmaximize();
  fitSize = [w, h];
  applyFit();
  fitSize = null;
}
ipcMain.on('fit-window', (e, w, h) => {
  if (!win || !w) return;
  if (!(w >= 160 && h >= 120 && w <= 8000 && h <= 8000)) return;
  setPictureSize(w, h);
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  buildMenu();
  createWindow();
  setupUpdates.done = setupUpdates() ? 'on' : 'off';
  try {
    await startServer();
    win?.loadURL(`http://127.0.0.1:${PORT}/tv/`);
  } catch (e) {
    if (e.message === 'port busy') return;
    await dialog.showMessageBox({ type: 'error', title: 'OOMPAS Box', message: 'The OOMPAS server couldn’t start.', detail: String(e.message).slice(0, 1500) });
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', e => {
  if (quitting) return;
  quitting = true;
  if (blocker >= 0) powerSaveBlocker.stop(blocker);
  if (server && !external) {
    e.preventDefault();
    stopServer().finally(() => app.quit());
  }
});
