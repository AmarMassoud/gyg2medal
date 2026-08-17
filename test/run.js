(async () => {
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decode, encode, verifyRoundtrip, CodecError } = require('../electron/medalcodec');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name); } };

/* Byte-exactness against a real install. fixtures.json is captured from a
 * live Medal database, so it is not in the repo. See test/README.md for how
 * to make your own; without it this section is skipped and the rest still
 * runs, including a check of the codec against SQLite's own encoder. */
console.log('\n== codec vs real Medal data ==');
const fxPath = path.join(__dirname, 'fixtures.json');
if (!fs.existsSync(fxPath)) {
  console.log('  SKIP no test/fixtures.json (see test/README.md)');
} else {
const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'));
let exact = 0, total = 0, unreadable = 0;
for (const [key, hex] of Object.entries(fx.settings)) {
  const buf = Buffer.from(hex, 'hex');
  total++;
  try {
    const v = decode(buf);
    if (encode(v).equals(buf)) exact++;
    else console.log('    differs:', key, JSON.stringify(v).slice(0, 60));
  } catch (e) { unreadable++; console.log('    unreadable:', key, e.message); }
}
ok(`all ${total} settings re-encode byte-exactly`, exact === total && unreadable === 0);

let mExact = 0, mTotal = 0;
for (const hex of fx.metadata) {
  const buf = Buffer.from(hex, 'hex');
  mTotal++;
  try { if (encode(decode(buf)).equals(buf)) mExact++; } catch { /* counted below */ }
}
ok(`all ${mTotal} clip-metadata blobs re-encode byte-exactly`, mExact === mTotal);
}

/* SQLite is the authority on JSONB, so use it as the oracle. This runs
 * everywhere and needs nobody's private data. */
console.log('\n== codec vs SQLite\'s own jsonb() ==');
{
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  const jsonb = (v) => db.prepare('select hex(jsonb(?)) h').get(JSON.stringify(v)).h.toLowerCase();
  const samples = [
    { folders: [{ label: 'GYG-Clips', value: 'C:\\Users\\you\\Videos\\GYG-Clips', enabled: true, freeUpSpace: false }] },
    { tags: ['goal', '2v2', 'ranked', 'mannfield'] },
    { a: [1, { b: false }], c: null, d: 30.254667, e: 'Vidéos Ömer' },
  ];
  let agree = 0;
  for (const v of samples) {
    if (encode(v).toString('hex') === jsonb(v)) agree++;
    else console.log('    differs:', JSON.stringify(v).slice(0, 60));
  }
  ok(`all ${samples.length} samples encode identically to SQLite`, agree === samples.length);
  db.close();
}

console.log('\n== ExternalFileSources shape ==');
const folders = { folders: [{ label: 'GYG-Clips', value: 'C:\\Users\\you\\Videos\\GYG-Clips', enabled: true, freeUpSpace: false }] };
ok('survives a round trip unchanged', JSON.stringify(verifyRoundtrip(folders) && decode(encode(folders))) === JSON.stringify(folders));

console.log('\n== edge cases ==');
ok('null',    decode(encode(null)) === null);
ok('true',    decode(encode(true)) === true);
ok('false',   decode(encode(false)) === false);
ok('int',     decode(encode(1280)) === 1280);
ok('float',   Math.abs(decode(encode(30.254667)) - 30.254667) < 1e-9);
ok('empty string', decode(encode('')) === '');
ok('unicode', decode(encode('Vidéos Ömer عمار')) === 'Vidéos Ömer عمار');
ok('long string (2-byte length)', decode(encode('x'.repeat(900))).length === 900);
ok('nested', JSON.stringify(decode(encode({ a: [1, { b: false }], c: null }))) === JSON.stringify({ a: [1, { b: false }], c: null }));
ok('rejects trailing bytes', (() => { try { decode(Buffer.from('97475947', 'hex')); return false; } catch (e) { return e instanceof CodecError; } })());
ok('rejects truncated', (() => { try { decode(Buffer.from('c840736872', 'hex')); return false; } catch (e) { return e instanceof CodecError; } })());



/* ---- process detection: the GYG2Medal.exe substring trap ---- */
{
  const { parseTasklist } = require('../electron/medal');
  const PROCESS_NAMES = ['Medal.exe', 'MedalRecorder.exe'];
  const check = (out) => {
    const running = parseTasklist(out);
    return PROCESS_NAMES.some((n) => running.has(n.toLowerCase()));
  };
  const ourAppOnly = '"GYG2Medal.exe","9152","Console","1","142,208 K"\r\n"chrome.exe","221","Console","1","90,000 K"\r\n';
  const medalToo   = ourAppOnly + '"Medal.exe","4410","Console","1","310,000 K"\r\n';
  const helperOnly = '"MedalRecorder.exe","77","Console","1","10,000 K"\r\n';

  console.log('\n== Medal process detection ==');
  const t = (name, cond) => ok(name, cond);
  t('our own GYG2Medal.exe is NOT mistaken for Medal', check(ourAppOnly) === false);
  t('real Medal.exe is detected', check(medalToo) === true);
  t('MedalRecorder.exe is detected', check(helperOnly) === true);
  t('empty list means not running', check('') === false);
  t('case-insensitive', check('"MEDAL.EXE","1","Console","1","1 K"\r\n') === true);
}

/* ---- database selection: newest != right ---- */
{
  const fsx = require('fs'), osx = require('os'), pathx = require('path');
  const Database = require('better-sqlite3');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'dbs-'));
  const mk = (name, rows, ageOffsetSec) => {
    const f = pathx.join(dir, name);
    const db = new Database(f);
    db.exec('create table contents(video_path TEXT)');
    const st = db.prepare('insert into contents values (?)');
    for (let i = 0; i < rows; i++) st.run(`C:\\GYG-Clips\\c${i}.mp4`);
    db.close();
    const t = Date.now() / 1000 + ageOffsetSec;
    fsx.utimesSync(f, t, t);
    return f;
  };
  mk('medal-111.db', 2626, 0);          // the real library, older
  mk('medal-222.db', 0, 600);           // empty profile, touched later
  mk('medal-guest.db', 0, 900);         // guest, touched latest

  const { listProfiles } = require('../electron/medal');
  const ranked = listProfiles(dir).map((d) => pathx.basename(d.file));
  console.log('\n== Medal profile selection ==');
  ok('with no signed-in account, the library with clips ranks first', ranked[0] === 'medal-111.db');
  ok('an empty newer profile does not win', ranked[0] !== 'medal-222.db');
  ok('guest database does not win', ranked[0] !== 'medal-guest.db');
  ok('all databases are listed', ranked.length === 3);
}


/* ---- cloud sync: never push one account's clips with another's key ---- */
{
  const fsx = require('fs'), osx = require('os'), pathx = require('path');
  const Database = require('better-sqlite3');
  const dir = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'medalcloud-'));
  fsx.mkdirSync(pathx.join(dir, 'Medal', 'store'), { recursive: true });
  const medalDir = pathx.join(dir, 'Medal');

  const mk = (name) => {
    const db = new Database(pathx.join(medalDir, name));
    db.exec('create table contents(created_at INTEGER, category_id TEXT, video_path TEXT, metadata BLOB, remote_content_id TEXT, local_content_id TEXT)');
    db.exec('create table key_values(key TEXT PRIMARY KEY, value BLOB)');
    db.prepare('insert into contents values (?,?,?,jsonb(?),?,?)')
      .run(1622532985, 'bvOYu0GmuA', 'C:\\GYG-Clips\\a_Slug1.mp4', '{"tags":[]}', 'remote1', 'local1');
    db.close();
  };
  mk('medal-111.db');
  fsx.writeFileSync(pathx.join(medalDir, 'store', 'user.json'),
    JSON.stringify({ userId: '999', key: 'not-a-real-key', displayName: 'Someone' }));

  const oldDir = process.env.GYG2MEDAL_MEDAL_DIR;
  process.env.GYG2MEDAL_MEDAL_DIR = medalDir;
  delete require.cache[require.resolve('../electron/medal')];
  const m2 = require('../electron/medal');
  m2.setPreferredDb(pathx.join(medalDir, 'medal-111.db'));

  console.log('\n== Medal cloud sync guards ==');
  const clips = [{ slug: 'Slug1', game: 'Rocket League', tags: [{ slug: 'goal', category: 'autotag.type' }] }];

  const mismatch = await m2.syncToMedalCloud('GYG-Clips', clips);
  ok('refuses to push when signed in as a different account',
     mismatch.pushed === 0 && /signed in as 999/.test(mismatch.reason || ''));

  fsx.writeFileSync(pathx.join(medalDir, 'store', 'user.json'), JSON.stringify({ guest: true }));
  const guest = await m2.syncToMedalCloud('GYG-Clips', clips);
  ok('does nothing when Medal is not signed in',
     guest.pushed === 0 && /not signed in/.test(guest.reason || ''));

  if (oldDir) process.env.GYG2MEDAL_MEDAL_DIR = oldDir; else delete process.env.GYG2MEDAL_MEDAL_DIR;
  m2.setPreferredDb(null);
}

console.log(`\n${fail === 0 ? 'ALL PASSED' : fail + ' FAILED'}  (${pass} passed)`);
process.exit(fail ? 1 : 0);
})();
