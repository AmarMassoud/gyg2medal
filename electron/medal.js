'use strict';
/**
 * Everything that touches Medal.
 *
 * Medal keeps its desktop data in %APPDATA%\Medal\medal-<userId>.db:
 *   key_values  -- settings, one BLOB per key
 *   contents    -- the local clip library, one row per clip
 *
 * Those BLOBs are **SQLite JSONB** -- SQLite's own binary JSON, not anything
 * bespoke. It is easy to miss: the bytes look proprietary until you notice the
 * tag layout is the JSONB spec (type in the low nibble, payload length in the
 * high nibble, 0xc/0xd length escapes). The giveaway is a trigger on
 * `contents` calling json_extract(metadata, '$.isFavorited') -- SQLite only
 * does that to a BLOB if it is JSONB.
 *
 * So all reading and writing here goes through SQLite's own
 * json()/jsonb()/jsonb_set() rather than hand-rolled encoding. A write touches
 * exactly one JSON path, leaves every other field byte-identical, and the
 * encoding is SQLite's problem rather than ours. JSONB needs SQLite 3.45+;
 * assertJsonb() fails loudly if that ever stops being true.
 *
 * The four things it does, all established by experiment against a live
 * install rather than guessed:
 *
 *  1. REGISTER A FOLDER -- key `ExternalFileSources`. Medal only scans the
 *     TOP LEVEL of the folder it is given; clips inside per-game subfolders
 *     are silently never imported.
 *
 *  2. FIX DATES -- Medal stamps every imported clip's `created_at` with the
 *     moment it scanned the file, ignoring the file's own timestamp. A probe
 *     dated 2021 imported as "today". Without this a five-year library
 *     collapses into a single day.
 *
 *  3. SET GAMES -- imported clips all land in the "Imported" bucket. The
 *     id -> name catalog is read from the user's own install, because those
 *     ids are Medal's server-side identifiers and cannot be invented.
 *     Anything unmatched is deliberately left as Imported.
 *
 *  4. WRITE TAGS -- `metadata.tags` is a plain array of hashtag strings.
 *
 * Safety on every write: never while Medal is running; back up the database
 * and its write-ahead log first; work on a local copy (%APPDATA% can sit on a
 * mount that cannot do SQLite's file locking); fold the WAL in so no stale
 * journal can resurrect old values; read back to verify; restore the backup on
 * any error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const EXTERNAL_KEY = 'ExternalFileSources';
/** Explicit profile choice from the user; overrides any automatic pick. */
let preferredDb = null;
const CATALOG_KEY = 'ICYMIEventSettings';
const PROCESS_NAMES = ['Medal.exe', 'MedalRecorder.exe'];

/** Games GYG names differently, or that really are another game. */
const ALIASES = {
  'lunar client': 'minecraft',
  'badlion client': 'minecraft',
  'feed the beast': 'minecraft',
  'minecraft java edition': 'minecraft',
  'grand theft auto v': 'gta v',
  'counterstrike global offensive': 'counter-strike 2',
  csgo: 'counter-strike 2',
  cs2: 'counter-strike 2',
  'pubg battlegrounds': 'pubg',
  'tom clancys rainbow six siege': 'rainbow six siege',
};

/** Auto-tags not worth carrying over: Medal already groups clips by date. */
const SKIP_TAG_CATEGORIES = new Set([
  'autotag.year', 'autotag.month', 'autotag.week', 'autotag.day',
]);

const loadSqlite = () => require('better-sqlite3');

function assertJsonb(db) {
  const v = db.prepare('select sqlite_version() v').get().v;
  const [maj, min] = v.split('.').map(Number);
  if (maj < 3 || (maj === 3 && min < 45)) {
    throw new Error(`This build's SQLite (${v}) is too old to read Medal's data safely; `
      + '3.45 or newer is required.');
  }
  return v;
}

function appDataDir() {
  // Lets the tests (and anyone poking at a copied profile) point the whole
  // module at a throwaway directory instead of a real install.
  const override = process.env.GYG2MEDAL_MEDAL_DIR;
  if (override) return fs.existsSync(override) ? override : null;
  if (process.platform !== 'win32') {
    const p = path.join(os.homedir(), '.config', 'Medal');
    return fs.existsSync(p) ? p : null;
  }
  const base = process.env.APPDATA;
  if (!base) return null;
  const p = path.join(base, 'Medal');
  return fs.existsSync(p) ? p : null;
}

/**
 * Which Medal account is signed in right now.
 *
 * store/user.json belongs to the *current* session, so it is the only
 * trustworthy answer to "which library will Medal import into". File
 * timestamps are not: Medal touches every profile database at startup, so the
 * newest file is often a freshly created empty one. Clip counts are not
 * either: the biggest library can belong to an account the user has since
 * signed out of.
 */
function activeProfile(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'store', 'user.json'), 'utf8');
    const u = JSON.parse(raw);
    if (!u || !u.userId) return null;
    return {
      userId: String(u.userId),
      displayName: u.displayName || u.userName || '',
      email: u.email || '',
      provider: (u.connections && u.connections[0] && u.connections[0].provider) || '',
      guest: !!u.guest,
    };
  } catch {
    return null;
  }
}

const userIdOf = (file) => {
  const m = path.basename(file).match(/^medal-(.+)\.db$/);
  return m ? m[1] : '';
};

/** Every Medal profile on this machine, with enough detail to choose between them. */
function listProfiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const active = activeProfile(dir);

  const profiles = names
    .filter((n) => /^medal-.*\.db$/.test(n) && !n.includes('gyg2medal-'))
    .map((n) => path.join(dir, n))
    .map((file) => {
      const userId = userIdOf(file);
      let clips = -1;
      let lastClipAt = null;
      let handle;
      try {
        handle = openRead(file);
        clips = handle.db.prepare('select count(*) c from contents').get().c;
        const r = handle.db.prepare('select max(created_at) m from contents').get();
        lastClipAt = r && r.m ? r.m : null;
      } catch { /* unreadable; leave clips at -1 */ } finally {
        if (handle) handle.close();
      }
      let mtime = 0;
      try { mtime = fs.statSync(file).mtimeMs; } catch { /* ignore */ }
      const isActive = !!active && active.userId === userId;
      return {
        file,
        userId,
        clips,
        lastClipAt,
        mtime,
        guest: userId === 'guest' || (isActive && active.guest),
        active: isActive,
        displayName: isActive ? active.displayName : '',
        email: isActive ? active.email : '',
        provider: isActive ? active.provider : '',
      };
    });

  // Signed-in account first, then real profiles by size, guest last.
  return profiles.sort((a, b) =>
    (b.active - a.active) || (a.guest - b.guest) || (b.clips - a.clips) || (b.mtime - a.mtime));
}

function setPreferredDb(file) { preferredDb = file || null; }
function getPreferredDb() { return preferredDb; }

function findDb(dir) {
  if (preferredDb && fs.existsSync(preferredDb)) return preferredDb;
  const all = listProfiles(dir);
  if (!all.length) return null;
  return all[0].file;          // signed-in account wins; see listProfiles
}

/**
 * Image names currently running, lower-cased.
 *
 * tasklist /FO CSV /NH prints one quoted record per line:
 *   "Medal.exe","9152","Console","1","142,208 K"
 * so the image name is the first quoted field.
 */
function parseTasklist(stdout) {
  const names = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

async function isRunning() {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 10000 });
    // Match image names EXACTLY. A substring test looks reasonable and is
    // badly wrong here: this app ships as GYG2Medal.exe, and
    // "gyg2medal.exe".includes("medal.exe") is true -- so the app detected
    // itself as Medal and every write refused with "Medal is still running".
    const running = parseTasklist(stdout);
    return PROCESS_NAMES.some((n) => running.has(n.toLowerCase()));
  } catch {
    return true;      // if we cannot tell, assume it might be
  }
}

function openLocalCopy(dbPath) {
  const Database = loadSqlite();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gyg2medal-'));
  const local = path.join(tmp, 'medal.db');
  fs.copyFileSync(dbPath, local);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, local + suffix);
  }
  const db = new Database(local);
  assertJsonb(db);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { db, local, tmp };
}

/**
 * Open the database for READING as cheaply as possible.
 *
 * Writes must go through openLocalCopy (see below), but reads happen on a
 * timer while we wait for Medal to import -- and copying a 16 MB database
 * twice every poll is both slow and pointless. Try a read-only handle first
 * and only fall back to copying if the file is locked or on a mount that
 * cannot do SQLite's locking.
 */
function openRead(dbPath) {
  const Database = loadSqlite();
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    assertJsonb(db);
    return { db, close() { try { db.close(); } catch { /* ignore */ } } };
  } catch {
    const handle = openLocalCopy(dbPath);
    return { db: handle.db, close() { closeHandle(handle); } };
  }
}

function closeHandle(handle) {
  try { handle.db.close(); } catch { /* already closed */ }
  fs.rmSync(handle.tmp, { recursive: true, force: true });
}

function installCopy(local, dbPath) {
  fs.copyFileSync(local, dbPath);
  // The journal was folded in already; empty any leftover so it cannot replay
  // stale frames over what we just wrote. Truncate rather than delete -- the
  // file may sit on a mount that forbids unlink.
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.writeFileSync(dbPath + suffix, Buffer.alloc(0));
  }
}

function backup(dbPath, tag) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = dbPath.replace(/\.db$/, `.gyg2medal-${tag}-${stamp}.db`);
  fs.copyFileSync(dbPath, dest);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, dest + suffix);
  }
  return dest;
}

/** Shared preamble for every write: refuse if unsafe, back up, open a copy. */
async function beginWrite(tag) {
  if (process.platform !== 'win32') throw new Error('This step is Windows-only.');
  if (await isRunning()) {
    throw new Error('Medal is still running. Quit it completely first. Right-click its '
      + 'system tray icon and choose Quit.');
  }
  const state = detect();
  if (!state.dbPath) throw new Error(state.reason || "Medal's database was not found.");
  const backupPath = backup(state.dbPath, tag);
  const handle = openLocalCopy(state.dbPath);
  return { state, backupPath, handle };
}

function commitWrite(ctx) {
  ctx.handle.db.pragma('wal_checkpoint(TRUNCATE)');
  ctx.handle.db.close();
  installCopy(ctx.handle.local, ctx.state.dbPath);
  fs.rmSync(ctx.handle.tmp, { recursive: true, force: true });
  return ctx.backupPath;
}

function rollback(ctx) {
  try { ctx.handle.db.close(); } catch { /* already closed */ }
  fs.rmSync(ctx.handle.tmp, { recursive: true, force: true });
  if (ctx.backupPath && ctx.state.dbPath) fs.copyFileSync(ctx.backupPath, ctx.state.dbPath);
}

/* ----------------------------- detect ----------------------------- */

function detect() {
  const state = {
    installed: false, appdata: null, dbPath: null,
    folders: [], catalogSize: 0, canConfigure: false, reason: '',
  };
  const dir = appDataDir();
  if (!dir) { state.reason = "Medal's app data folder was not found."; return state; }
  state.installed = true;
  state.appdata = dir;

  const dbPath = findDb(dir);
  if (!dbPath) { state.reason = "Medal hasn't created its settings database yet."; return state; }
  state.dbPath = dbPath;

  let handle;
  try {
    handle = openRead(dbPath);
    const row = handle.db.prepare('select json(value) j from key_values where key = ?').get(EXTERNAL_KEY);
    if (row && row.j) {
      const existing = JSON.parse(row.j);
      if (existing && Array.isArray(existing.folders)) {
        state.folders = existing.folders.filter((f) => f && typeof f === 'object');
      }
    }
    state.catalogSize = gameCatalog(handle.db).size;
    state.canConfigure = true;
  } catch (e) {
    state.reason = `Medal's settings could not be read (${e.message}).`;
  } finally {
    if (handle) handle.close();
  }
  return state;
}

const norm = (p) => path.resolve(String(p || '')).toLowerCase();
const hasFolder = (state, folder) => state.folders.some((f) => norm(f.value) === norm(folder));

/* --------------------- 1. register the folder --------------------- */

async function addRecorderFolder(folder, label) {
  const target = path.resolve(folder);
  if (!fs.existsSync(target)) throw new Error(`${target} does not exist.`);

  const pre = detect();
  if (!pre.canConfigure) throw new Error(pre.reason || "Medal's settings could not be located.");

  const folders = pre.folders.slice();
  if (!hasFolder(pre, target)) {
    folders.push({
      label: label || path.basename(target),
      value: target,
      enabled: true,
      freeUpSpace: false,
    });
  }

  const ctx = await beginWrite('folder');
  try {
    const { db } = ctx.handle;
    const payload = JSON.stringify({ folders });
    const exists = db.prepare('select 1 from key_values where key = ?').get(EXTERNAL_KEY);
    if (exists) db.prepare('update key_values set value = jsonb(?) where key = ?').run(payload, EXTERNAL_KEY);
    else db.prepare('insert into key_values (key, value) values (?, jsonb(?))').run(EXTERNAL_KEY, payload);

    const check = JSON.parse(db.prepare('select json(value) j from key_values where key = ?')
      .get(EXTERNAL_KEY).j);
    if (!check.folders.some((f) => norm(f.value) === norm(target))) {
      throw new Error('The folder did not persist.');
    }
    return commitWrite(ctx);
  } catch (e) {
    rollback(ctx);
    throw e;
  }
}

/* ----------------------- 2. import progress ----------------------- */

function importedCount(folder) {
  const dir = appDataDir();
  const dbPath = dir && findDb(dir);
  if (!dbPath) return { imported: 0, ok: false, error: "Medal's database was not found." };

  let handle;
  try {
    handle = openRead(dbPath);
    // Match on the folder name, which is what Medal stores in video_path.
    const row = handle.db.prepare('select count(*) c from contents where video_path like ?')
      .get(`%${path.basename(folder)}%`);
    return { imported: row ? row.c : 0, ok: true, error: '' };
  } catch (e) {
    return { imported: 0, ok: false, error: String(e.message || e).slice(0, 200) };
  } finally {
    if (handle) handle.close();
  }
}

const slugOf = (filePath) => {
  const name = path.basename(filePath);
  if (!name.toLowerCase().endsWith('.mp4')) return null;
  const stem = name.slice(0, -4);
  return stem.includes('_') ? stem.split('_').pop() : null;
};

/** Rows for this folder, paired with the clip each came from. */
function matchRows(db, folder, clips) {
  const bySlug = new Map(clips.map((c) => [c.slug, c]));
  return db.prepare(
    'select rowid, created_at, category_id, video_path from contents where video_path like ?')
    .all(`%${path.basename(folder)}%`)
    .map((row) => ({ row, clip: bySlug.get(slugOf(row.video_path)) || null }));
}

/** Run `body(db, apply)` either read-only or inside a guarded write. */
async function withDb(tag, dryRun, body) {
  if (dryRun) {
    const state = detect();
    if (!state.dbPath) throw new Error(state.reason || "Medal's database was not found.");
    const handle = openLocalCopy(state.dbPath);
    try { return { out: body(handle.db, false), backup: null, db: handle.db }; }
    finally { closeHandle(handle); }
  }
  const ctx = await beginWrite(tag);
  try {
    const out = body(ctx.handle.db, true);
    const extra = typeof out === 'function' ? out(ctx.handle.db) : null;
    commitWrite(ctx);
    return { out, backup: ctx.backupPath, extra };
  } catch (e) {
    rollback(ctx);
    throw e;
  }
}

/* -------------------------- 3. fix dates -------------------------- */

async function fixClipDates(folder, clips, { dryRun = false, pathExists = fs.existsSync } = {}) {
  const result = { seen: 0, updated: 0, unmatched: 0, removed: 0, backup: null, stillToday: null };

  const body = (db, apply) => {
    const setDate = apply ? db.prepare('update contents set created_at = ? where rowid = ?') : null;
    const dropRow = apply ? db.prepare('delete from contents where rowid = ?') : null;
    const work = () => {
      for (const { row, clip } of matchRows(db, folder, clips)) {
        result.seen++;
        if (!pathExists(row.video_path)) {
          result.removed++;
          if (apply) dropRow.run(row.rowid);
          continue;
        }
        if (!clip || !clip.createdAt) { result.unmatched++; continue; }
        const want = Math.floor(new Date(clip.createdAt).getTime() / 1000);
        if (!Number.isFinite(want) || want === row.created_at) continue;
        result.updated++;
        if (apply) setDate.run(want, row.rowid);
      }
      if (apply) {
        const cutoff = Math.floor(Date.now() / 1000) - 3600;
        result.stillToday = db.prepare(
          'select count(*) c from contents where video_path like ? and created_at > ?')
          .get(`%${path.basename(folder)}%`, cutoff).c;
      }
    };
    if (apply) db.transaction(work)(); else work();
  };

  const { backup: b } = await withDb('datefix', dryRun, body);
  result.backup = b;
  return result;
}

/* -------------------------- 4. set games -------------------------- */

const normaliseGame = (s) =>
  String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();

/** name -> categoryId, read from this machine's own Medal catalog. */
function gameCatalog(db) {
  const map = new Map();
  let row;
  try { row = db.prepare('select json(value) j from key_values where key = ?').get(CATALOG_KEY); }
  catch { return map; }
  if (!row || !row.j) return map;
  let parsed;
  try { parsed = JSON.parse(row.j); } catch { return map; }
  for (const [id, entry] of Object.entries(parsed || {})) {
    const name = entry && (entry.GameName || entry.gameName || entry.name);
    if (name) map.set(normaliseGame(name), id);
  }
  return map;
}

function categoryFor(gameName, catalog) {
  const n = normaliseGame(gameName);
  if (!n || n === 'unknown') return null;
  if (catalog.has(n)) return catalog.get(n);
  const alias = ALIASES[n];
  if (alias && catalog.has(normaliseGame(alias))) return catalog.get(normaliseGame(alias));
  const hits = [...catalog.keys()].filter((k) => k.startsWith(n) || n.startsWith(k));
  return hits.length === 1 ? catalog.get(hits[0]) : null;
}

async function setGameCategories(folder, clips, { dryRun = false, pathExists = fs.existsSync } = {}) {
  const result = { moved: 0, keptImported: 0, byGame: {}, unmapped: {}, backup: null, catalogSize: 0 };

  const body = (db, apply) => {
    const catalog = gameCatalog(db);
    result.catalogSize = catalog.size;
    const stmt = apply ? db.prepare('update contents set category_id = ? where rowid = ?') : null;
    const work = () => {
      for (const { row, clip } of matchRows(db, folder, clips)) {
        if (!pathExists(row.video_path) || !clip) continue;
        const target = categoryFor(clip.game, catalog);
        if (!target) {
          result.keptImported++;
          result.unmapped[clip.game] = (result.unmapped[clip.game] || 0) + 1;
          continue;
        }
        result.byGame[clip.game] = (result.byGame[clip.game] || 0) + 1;
        if (target === row.category_id) continue;
        result.moved++;
        if (apply) stmt.run(target, row.rowid);
      }
    };
    if (apply) db.transaction(work)(); else work();
  };

  const { backup: b } = await withDb('games', dryRun, body);
  result.backup = b;
  return result;
}

/* -------------------------- 5. set tags --------------------------- */

/** GYG tag objects -> the hashtag strings worth keeping. */
function tagsForClip(clip) {
  const raw = Array.isArray(clip && clip.tags) ? clip.tags : [];
  return [...new Set(
    raw.filter((t) => t && t.slug && !SKIP_TAG_CATEGORIES.has(t.category)).map((t) => t.slug),
  )];
}

async function setClipTags(folder, clips, { dryRun = false, pathExists = fs.existsSync } = {}) {
  const result = { tagged: 0, totalTags: 0, noTags: 0, backup: null, top: [] };
  const counts = {};

  const body = (db, apply) => {
    // jsonb_set touches exactly this one path; every other field in the blob
    // stays byte-identical and SQLite guarantees the encoding is valid.
    const stmt = apply
      ? db.prepare("update contents set metadata = jsonb_set(metadata, '$.tags', jsonb(?)) where rowid = ?")
      : null;
    const work = () => {
      for (const { row, clip } of matchRows(db, folder, clips)) {
        if (!pathExists(row.video_path) || !clip) continue;
        const tags = tagsForClip(clip);
        if (!tags.length) { result.noTags++; continue; }
        result.tagged++;
        result.totalTags += tags.length;
        for (const t of tags) counts[t] = (counts[t] || 0) + 1;
        if (apply) stmt.run(JSON.stringify(tags), row.rowid);
      }
    };
    if (apply) db.transaction(work)(); else work();
  };

  const { backup: b } = await withDb('tags', dryRun, body);
  result.backup = b;
  result.top = Object.entries(counts).sort((a, b2) => b2[1] - a[1]).slice(0, 12)
    .map(([tag, n]) => ({ tag, n }));
  return result;
}

/* ------------------------- making Medal see files ------------------------- *
 * Medal watches a registered folder for files ARRIVING. It never enumerates
 * what is already sitting there -- proven by adding a folder holding 1,335
 * clips (through Medal's own UI, so this is not a config problem) and getting
 * zero imports, then moving a single file out and back in and watching it
 * import within a minute.
 *
 * So for any folder that already has clips in it, we make them arrive: move
 * each file into a staging subfolder and straight back. It is a rename within
 * the same folder, so nothing is copied and nothing can be lost, and the
 * staging subfolder is invisible to Medal anyway (it only scans the top level).
 * ------------------------------------------------------------------------- */

/* ------------------- 6. make it survive a restart ------------------- *
 * Everything above writes to Medal's local database, and on its own that is
 * not enough.
 *
 * Medal uploads every imported clip to its own servers as a private draft
 * (each row gets a `remote_content_id` and `metadata.remoteContent`), and from
 * then on the server is the authority. On a schedule the client walks the
 * library, refetches each clip and writes the server's values back over the
 * local row, stamping `metadata.remoteSyncedAt`. Anything set only locally is
 * quietly undone, which is why the games and tags came back as "Imported" with
 * no hashtags after a restart. Capture dates survive because Medal never sends
 * `created_at` to the server, so nothing overwrites them.
 *
 * The fix is to make the same change Medal's own UI makes: POST the clip to
 * `/content/<contentId>` with the new categoryId and tags, exactly as the
 * desktop client does (its own key map is
 * `{category_id: "categoryId", ...}`). Then zero `remoteSyncedAt` so the next
 * sync pulls the corrected values down instead of the stale ones.
 *
 * Auth is the `userId` and `key` Medal already stored in store/user.json for
 * the signed-in account. Nothing new is asked of the user, and the request is
 * byte for byte what Medal sends. Clips that have not been uploaded yet are
 * left alone: for those the local row IS the source, and Medal builds the
 * server record from it when the upload happens.
 * ------------------------------------------------------------------- */

const API = 'https://api-v2.medal.tv';
const CLOUD_CONCURRENCY = 8;

/** The signed-in account's API credentials, or null. Never logged. */
function cloudAuth(dir) {
  try {
    const u = JSON.parse(fs.readFileSync(path.join(dir, 'store', 'user.json'), 'utf8'));
    if (!u || !u.userId || !u.key || u.guest) return null;
    return { userId: String(u.userId), key: String(u.key) };
  } catch {
    return null;
  }
}

async function postContent(contentId, body, auth) {
  const res = await fetch(`${API}/content/${contentId}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-authentication': `${auth.userId},${auth.key}`,
    },
    body: JSON.stringify(body),
  });
  return res.status;
}

/**
 * Push the game and tags for every already-uploaded clip to Medal's servers,
 * then mark those rows stale so the client pulls the new values down.
 */
async function syncToMedalCloud(folder, clips, { onProgress = () => {}, dryRun = false } = {}) {
  const result = {
    eligible: 0, pushed: 0, failed: 0, notUploaded: 0, skipped: 0,
    reason: null, backup: null,
  };

  const dir = appDataDir();
  if (!dir) { result.reason = 'Medal is not installed here.'; return result; }

  const auth = cloudAuth(dir);
  if (!auth) {
    result.reason = 'Medal is not signed in, so there is nothing to sync. '
      + 'The local changes still apply.';
    return result;
  }

  const state = detect();
  if (!state.dbPath) { result.reason = state.reason || "Medal's database was not found."; return result; }

  // Never send one account's changes with another account's key.
  if (userIdOf(state.dbPath) !== auth.userId) {
    result.reason = `The chosen library belongs to account ${userIdOf(state.dbPath)} `
      + `but Medal is signed in as ${auth.userId}. Sign into that account in Medal `
      + 'and run this again to make the change permanent.';
    return result;
  }

  // Work out what each uploaded clip should look like.
  const jobs = [];
  {
    const handle = openRead(state.dbPath);
    try {
      const catalog = gameCatalog(handle.db);
      const bySlug = new Map(clips.map((c) => [c.slug, c]));
      const rows = handle.db.prepare(
        'select rowid, category_id, video_path, remote_content_id from contents where video_path like ?')
        .all(`%${path.basename(folder)}%`);
      for (const row of rows) {
        const clip = bySlug.get(slugOf(row.video_path));
        if (!clip) continue;
        if (!row.remote_content_id) { result.notUploaded++; continue; }
        const body = {};
        const category = categoryFor(clip.game, catalog);
        if (category) body.categoryId = category;
        const tags = tagsForClip(clip);
        if (tags.length) body.tags = tags;
        if (!Object.keys(body).length) { result.skipped++; continue; }
        jobs.push({ rowid: row.rowid, contentId: row.remote_content_id, body });
      }
    } finally {
      closeHandle(handle);
    }
  }

  result.eligible = jobs.length;
  if (dryRun || !jobs.length) return result;

  // Push, with a retry for the transient 5xx and rate limits.
  const done = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      let ok = false;
      for (let attempt = 0; attempt < 4 && !ok; attempt++) {
        let status = 0;
        try { status = await postContent(job.contentId, job.body, auth); } catch { status = 0; }
        if (status === 200) { ok = true; break; }
        if (status && status !== 429 && status < 500) break;   // a real rejection
        await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      }
      if (ok) { result.pushed++; done.push(job.rowid); } else { result.failed++; }
      onProgress({ done: result.pushed + result.failed, total: jobs.length });
    }
  };
  await Promise.all(Array.from({ length: CLOUD_CONCURRENCY }, worker));

  // Only invalidate rows the server actually accepted. Zeroing a row we failed
  // to push would invite Medal to pull the old values straight back.
  if (done.length) {
    const { backup: b } = await withDb('cloudsync', false, (db, apply) => {
      if (!apply) return;
      const stmt = db.prepare(
        "update contents set metadata = jsonb_set(metadata, '$.remoteSyncedAt', 0) where rowid = ?");
      db.transaction(() => { for (const id of done) stmt.run(id); })();
    });
    result.backup = b;
  }
  return result;
}

const STAGING = '.gyg2medal-restage';

/** Files in `folder` that Medal has NOT imported yet. */
function pendingFiles(folder) {
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(folder)
      .filter((n) => n.toLowerCase().endsWith('.mp4'))
      .map((n) => path.join(folder, n));
  } catch { return []; }

  const known = new Set();
  const dir = appDataDir();
  const dbPath = dir && findDb(dir);
  if (dbPath) {
    let handle;
    try {
      handle = openRead(dbPath);
      for (const r of handle.db.prepare(
        'select video_path from contents where video_path like ?')
        .all(`%${path.basename(folder)}%`)) {
        if (r.video_path) known.add(path.basename(r.video_path).toLowerCase());
      }
    } catch { /* treat as none known */ } finally {
      if (handle) handle.close();
    }
  }
  return onDisk.filter((f) => !known.has(path.basename(f).toLowerCase()));
}

/**
 * Re-present un-imported files so Medal's watcher picks them up.
 * Medal must be RUNNING for this to do anything.
 */
async function restageForImport(folder, { onProgress = () => {}, batch = 40, pauseMs = 900,
                                          shouldStop = () => false } = {}) {
  const files = pendingFiles(folder);
  const staging = path.join(folder, STAGING);
  const result = { total: files.length, moved: 0, failed: 0 };
  if (!files.length) return result;

  fs.mkdirSync(staging, { recursive: true });

  for (let i = 0; i < files.length; i += batch) {
    if (shouldStop()) break;
    const slice = files.slice(i, i + batch);
    const parked = [];

    for (const src of slice) {
      const tmp = path.join(staging, path.basename(src));
      try { fs.renameSync(src, tmp); parked.push([tmp, src]); }
      catch { result.failed++; }
    }
    // Give the watcher a beat to settle before they reappear.
    await new Promise((r) => setTimeout(r, 150));
    for (const [tmp, dest] of parked) {
      try { fs.renameSync(tmp, dest); result.moved++; }
      catch { result.failed++; }
    }
    onProgress({ ...result, done: Math.min(i + batch, files.length) });
    await new Promise((r) => setTimeout(r, pauseMs));
  }

  // Never leave files parked, even if we bailed out early.
  try {
    for (const n of fs.readdirSync(staging)) {
      try { fs.renameSync(path.join(staging, n), path.join(folder, n)); } catch { /* leave it */ }
    }
    fs.rmdirSync(staging);
  } catch { /* fine */ }

  return result;
}

module.exports = {
  detect, isRunning, listProfiles, restageForImport, pendingFiles, activeProfile, setPreferredDb, getPreferredDb, parseTasklist, hasFolder, addRecorderFolder, importedCount,
  fixClipDates, setGameCategories, setClipTags, syncToMedalCloud, cloudAuth,
  gameCatalog, categoryFor, normaliseGame, tagsForClip,
  EXTERNAL_KEY, CATALOG_KEY, SKIP_TAG_CATEGORIES,
};
