'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { GygClient, AuthError } = require('./gyg');
const { Downloader, estimateBytes, humanBytes } = require('./downloader');
const medal = require('./medal');

const LOGIN_URL = 'https://www.gifyourgame.com/login';
const TOKEN_JS = `(() => { try {
  const u = JSON.parse(localStorage.getItem('Parse/badpanda/currentUser'));
  return u && u.sessionToken ? { token: u.sessionToken, username: u.username || '' } : null;
} catch (e) { return null; } })()`;

/** Dev mode: `npm start -- --dev`, or GYG2MEDAL_DEV=1.
 *  Lets us exercise the Medal steps against an existing folder + saved
 *  manifest, without signing in or re-downloading 15 GB every attempt. */
const DEV = process.argv.includes('--dev') || process.env.GYG2MEDAL_DEV === '1';

let win = null;
let client = null;
let clips = [];
let downloader = null;

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 660,
    minWidth: 780,
    minHeight: 600,
    backgroundColor: '#15161a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

const send = (channel, payload) => { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); };

/* ------------------------------------------------------------------ *
 * Sign in: show GYG's real login page and read the session afterwards.
 *
 * This is the whole reason the app is Electron. GYG accounts are often
 * created through Discord, Google or Steam and have no password at all, so
 * any home-made login form excludes a large share of users. Loading the
 * genuine page means every provider works exactly as it does on the website,
 * and this app never sees anyone's password.
 * ------------------------------------------------------------------ */
ipcMain.handle('login', async () => {
  return new Promise((resolve) => {
    const authSession = session.fromPartition('persist:gyg');
    const login = new BrowserWindow({
      width: 520,
      height: 720,
      parent: win,
      modal: true,
      show: false,
      backgroundColor: '#15161a',
      autoHideMenuBar: true,
      title: 'Sign in to Gif Your Game',
      webPreferences: { session: authSession, contextIsolation: true, nodeIntegration: false },
    });

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (!login.isDestroyed()) login.destroy();
      resolve(value);
    };

    // Social sign-in opens provider pages in new windows; keep them in-flow.
    login.webContents.setWindowOpenHandler(({ url }) => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 520, height: 720, parent: login, modal: true,
        autoHideMenuBar: true, backgroundColor: '#15161a',
      },
    }));

    const poll = setInterval(async () => {
      if (login.isDestroyed()) return finish({ ok: false, error: 'cancelled' });
      try {
        const found = await login.webContents.executeJavaScript(TOKEN_JS, true);
        if (found && found.token) finish({ ok: true, ...found });
      } catch { /* mid-navigation; try again */ }
    }, 700);

    login.once('ready-to-show', () => login.show());
    login.on('closed', () => finish({ ok: false, error: 'cancelled' }));
    login.loadURL(LOGIN_URL);
  });
});

ipcMain.handle('verifyToken', async (_e, token) => {
  try {
    client = await GygClient.fromToken(token);
    return { ok: true, username: client.username };
  } catch (e) {
    return { ok: false, error: e instanceof AuthError ? 'That session is not valid. Try signing in again.' : e.message };
  }
});

ipcMain.handle('signOut', async () => {
  client = null;
  clips = [];
  try { await session.fromPartition('persist:gyg').clearStorageData(); } catch {}
  return { ok: true };
});

ipcMain.handle('scan', async () => {
  if (!client) return { ok: false, error: 'Not signed in.' };
  try {
    const res = await client.buildClipList({
      onProgress: (p) => send('scan:progress', p),
    });
    clips = res.clips;
    // Cache it so dev mode can replay this scan without signing in again.
    try {
      fs.writeFileSync(path.join(app.getPath('userData'), 'last-scan.json'),
        JSON.stringify({ exportedAt: new Date().toISOString(), count: clips.length, clips }));
    } catch { /* best effort */ }
    const games = {};
    for (const c of clips) games[c.game] = (games[c.game] || 0) + 1;
    return {
      ok: true,
      count: clips.length,
      unresolved: res.failed.length,
      bytes: estimateBytes(clips),
      bytesHuman: humanBytes(estimateBytes(clips)),
      minutes: Math.round(clips.reduce((a, c) => a + c.length, 0) / 60),
      games,
      oldest: clips.length ? clips[0].createdAt : null,
      newest: clips.length ? clips[clips.length - 1].createdAt : null,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('isDev', () => DEV);
ipcMain.handle('appVersion', () => app.getVersion());

/** Where the last scan's manifest is cached, so dev mode always has one. */
const manifestCache = () => path.join(app.getPath('userData'), 'last-scan.json');

ipcMain.handle('devLoadManifest', async (_e, file) => {
  try {
    let chosen = file;
    if (!chosen) {
      const cached = manifestCache();
      if (fs.existsSync(cached)) chosen = cached;
      else {
        const res = await dialog.showOpenDialog(win, {
          title: 'Pick a clip manifest (gyg_manifest.json)',
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (res.canceled) return { ok: false, error: 'cancelled' };
        chosen = res.filePaths[0];
      }
    }
    const parsed = JSON.parse(fs.readFileSync(chosen, 'utf8'));
    clips = Array.isArray(parsed) ? parsed : (parsed.clips || []);
    if (!clips.length) return { ok: false, error: 'That manifest has no clips in it.' };
    const withTags = clips.filter((c) => c.tags && c.tags.length).length;
    return { ok: true, from: chosen, count: clips.length, withTags };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('defaultDest', () => path.join(os.homedir(), 'Videos', 'GYG-Clips'));

ipcMain.handle('chooseFolder', async (_e, current) => {
  const res = await dialog.showOpenDialog(win, {
    defaultPath: current || os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('checkDest', async (_e, dest) => {
  const out = { exists: false, empty: true, freeBytes: null, warnings: [] };
  try {
    out.exists = fs.existsSync(dest);
    if (out.exists) out.empty = fs.readdirSync(dest).length === 0;
    const probe = out.exists ? dest : path.dirname(dest);
    const stat = fs.statfsSync ? fs.statfsSync(probe) : null;
    if (stat) out.freeBytes = stat.bavail * stat.bsize;
  } catch (e) {
    out.warnings.push("That path isn't reachable.");
  }
  const need = estimateBytes(clips);
  if (out.freeBytes !== null && out.freeBytes < need) {
    out.warnings.push(`Only ${humanBytes(out.freeBytes)} free on that drive; about ${humanBytes(need)} is needed.`);
  }
  if (out.exists && !out.empty) {
    out.warnings.push('That folder already has files in it. Medal wants an empty folder when you add it, though a folder from a previous run is fine.');
  }
  return out;
});

ipcMain.handle('startDownload', async (_e, { dest, perGameFolders }) => {
  if (!clips.length) return { ok: false, error: 'Nothing to download.' };
  try {
    fs.mkdirSync(dest, { recursive: true });
  } catch (e) {
    return { ok: false, error: `Can't create that folder: ${e.message}` };
  }
  downloader = new Downloader(clips, dest, {
    perGameFolders,
    onProgress: (p) => send('download:progress', p),
    onLog: (m) => send('download:log', m),
  });
  const result = await downloader.run();
  const log = await downloader.writeFailureLog(dest);
  return { ok: true, ...result, failureLog: log };
});

ipcMain.handle('pauseDownload', () => { if (downloader) downloader.pause(); });
ipcMain.handle('resumeDownload', () => { if (downloader) downloader.resume(); });
ipcMain.handle('cancelDownload', () => { if (downloader) downloader.cancel(); });

/* ---------------------------- Medal ---------------------------- */

ipcMain.handle('medal:detect', async (_e, dest) => {
  const state = medal.detect();
  return {
    installed: state.installed,
    canConfigure: state.canConfigure,
    reason: state.reason,
    folders: state.folders,
    alreadyAdded: dest ? medal.hasFolder(state, dest) : false,
    running: await medal.isRunning(),
  };
});

ipcMain.handle('medal:profiles', async () => {
  const state = medal.detect();
  if (!state.appdata) return { ok: false, error: state.reason || 'Medal was not found.', profiles: [] };
  const profiles = medal.listProfiles(state.appdata).map((p) => ({
    file: p.file,
    userId: p.userId,
    clips: p.clips,
    lastClipAt: p.lastClipAt,
    active: p.active,
    guest: p.guest,
    label: p.displayName || (p.guest ? 'Guest' : `Account ${p.userId}`),
    email: p.email,
    provider: p.provider,
  }));
  const chosen = medal.getPreferredDb() || (profiles[0] && profiles[0].file) || null;
  return { ok: true, profiles, chosen };
});

ipcMain.handle('medal:selectProfile', async (_e, file) => {
  medal.setPreferredDb(file || null);
  return { ok: true, chosen: medal.getPreferredDb() };
});

ipcMain.handle('medal:register', async (_e, dest) => {
  try {
    const backup = await medal.addRecorderFolder(dest, path.basename(dest));
    return { ok: true, backup: path.basename(backup) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('medal:restage', async (_e, dest) => {
  try {
    if (!(await medal.isRunning())) {
      return { ok: false, error: 'Medal needs to be running so it can see the files arrive.' };
    }
    const res = await medal.restageForImport(dest, {
      onProgress: (p) => send('restage:progress', p),
    });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('medal:pending', async (_e, dest) => {
  try { return { ok: true, pending: medal.pendingFiles(dest).length }; }
  catch (e) { return { ok: false, error: String(e.message || e), pending: 0 }; }
});

ipcMain.handle('medal:importProgress', async (_e, dest) => {
  try {
    const { imported, ok, error } = medal.importedCount(dest);
    let running = null;
    try { running = await medal.isRunning(); } catch { running = null; }
    return { ok, imported, error: error || '', total: clips.length, running };
  } catch (e) {
    return { ok: false, imported: 0, error: String(e.message || e), total: clips.length, running: null };
  }
});

/** Everything the app can see about this machine, for pasting into a bug report. */
ipcMain.handle('diagnostics', async (_e, dest) => {
  const out = {
    app: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    dest: dest || null,
    clipsInMemory: clips.length,
  };
  try {
    const st = medal.detect();
    out.medal = {
      installed: st.installed, appdata: st.appdata, dbPath: st.dbPath,
      canConfigure: st.canConfigure, reason: st.reason,
      catalogSize: st.catalogSize,
      folders: st.folders.map((f) => f.value),
      folderAlreadyAdded: dest ? medal.hasFolder(st, dest) : null,
    };
  } catch (e) { out.medal = { error: String(e.message || e) }; }
  try {
    const dir = out.medal && out.medal.appdata;
    out.profiles = dir ? medal.listProfiles(dir).map((d) => ({
      db: path.basename(d.file), userId: d.userId, clips: d.clips,
      active: d.active, guest: d.guest, name: d.displayName || null,
    })) : [];
    out.chosenDb = medal.getPreferredDb() ? path.basename(medal.getPreferredDb()) : '(auto)';
  } catch (e) { out.databases = `error: ${e.message}`; }
  try { out.imported = medal.importedCount(dest); } catch (e) { out.imported = { error: String(e.message || e) }; }
  try { out.medalRunning = await medal.isRunning(); } catch (e) { out.medalRunning = `error: ${e.message}`; }
  try {
    const Database = require('better-sqlite3');
    out.sqlite = new Database(':memory:').prepare('select sqlite_version() v').get().v;
  } catch (e) { out.sqlite = `FAILED TO LOAD: ${String(e.message || e).slice(0, 300)}`; }
  try { out.filesOnDisk = fs.readdirSync(dest).filter((f) => f.endsWith('.mp4')).length; }
  catch (e) { out.filesOnDisk = `error: ${e.message}`; }
  return out;
});

ipcMain.handle('medal:fixDates', async (_e, { dest, dryRun }) => {
  try {
    const res = await medal.fixClipDates(dest, clips, { dryRun: !!dryRun });
    return { ok: true, ...res, backup: res.backup ? path.basename(res.backup) : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('medal:setGames', async (_e, { dest, dryRun }) => {
  try {
    const res = await medal.setGameCategories(dest, clips, { dryRun: !!dryRun });
    return { ok: true, ...res, backup: res.backup ? path.basename(res.backup) : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('medal:setTags', async (_e, { dest, dryRun }) => {
  try {
    const res = await medal.setClipTags(dest, clips, { dryRun: !!dryRun });
    return { ok: true, ...res, backup: res.backup ? path.basename(res.backup) : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('openPath', async (_e, p) => { await shell.openPath(p); });
ipcMain.handle('openExternal', async (_e, url) => { await shell.openExternal(url); });

ipcMain.handle('saveManifest', async (_e, dest) => {
  const file = path.join(dest, 'gyg_manifest.json');
  fs.writeFileSync(file, JSON.stringify({
    source: 'gifyourgame.com',
    user: client ? client.username : '',
    exportedAt: new Date().toISOString(),
    count: clips.length,
    clips,
  }, null, 1), 'utf8');
  return file;
});
