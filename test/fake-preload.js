const { contextBridge, ipcRenderer } = require('electron');
const noop = async () => {};
let dlTick = null;
contextBridge.exposeInMainWorld('api', {
  appVersion: async () => '3.1.0',
  isDev: async () => false,
  devLoadManifest: async () => ({ ok: false, error: 'cancelled' }),
  medalPending: async () => ({ ok: true, pending: 0 }),
  medalRestage: async () => ({ ok: true, moved: 0 }),
  onRestageProgress: () => {},
  diagnostics: async () => ({ ok: true, text: '{}' }),
  login: async () => ({ ok: true, token: 'r:demo', username: 'yourname' }),
  verifyToken: async () => ({ ok: true, username: 'yourname' }),
  signOut: noop,
  scan: async () => ({ ok: true, count: 1334, unresolved: 2, bytesHuman: '15.1 GB',
    minutes: 238, oldest: '2021-05-11T22:10:21Z', newest: '2026-03-08T14:02:23Z',
    games: { 'Rocket League': 1307, 'Lunar Client': 7, 'Splitgate Arena Warfare': 3, Minecraft: 1, Unknown: 16 } }),
  defaultDest: async () => 'C:\\Users\\you\\Videos\\GYG-Clips',
  chooseFolder: async () => null,
  checkDest: async () => ({ exists: true, empty: true, freeBytes: 90e9, warnings: [] }),
  startDownload: async () => ({ ok: true, done: 1332, skipped: 0, failed: 2, bytes: 16.2e9, total: 1334, failureLog: 'x' }),
  pauseDownload: noop, resumeDownload: noop, cancelDownload: noop,
  medalDetect: async () => ({ installed: true, canConfigure: true, running: false, alreadyAdded: false, folders: [] }),
  medalProfiles: async () => ({ ok:true, chosen:'a', profiles:[
    { file:'a', userId:'7654321', clips:0,    active:true,  guest:false, label:'YourName', email:'you@example.com', provider:'google' },
    { file:'b', userId:'1234567', clips:2625, active:false, guest:false, label:'Account 1234567', email:'', provider:'' },
    { file:'c', userId:'guest',     clips:0,    active:false, guest:true,  label:'Guest', email:'', provider:'' },
  ]}),
  medalSelectProfile: async () => ({ ok:true }),
  medalRegister: async () => ({ ok: true, backup: 'medal-1234567.gyg2medal-backup-20260809.db' }),
  medalImport: async () => ({ ok: true, imported: 856, total: 1334, running: true }),
  medalFixDates: async () => ({ ok: true, updated: 1334, unmatched: 0, removed: 0, stillToday: 0, backup: 'medal-1234567.gyg2medal-datefix-20260809.db' }),
  medalSetGames: async () => ({ ok: true, moved: 1315, keptImported: 19, byGame: { 'Rocket League': 1307, 'Lunar Client': 7, Minecraft: 1 }, unmapped: { Unknown: 16, 'Splitgate Arena Warfare': 3 }, backup: 'x.db' }),
  medalCloudSync: async () => ({ ok: true, eligible: 1334, pushed: 1334, failed: 0, notUploaded: 0, skipped: 0, reason: null, backup: 'x.db' }),
  onCloudProgress: () => {},
  medalSetTags: async () => ({ ok: true, tagged: 1334, totalTags: 4760, noTags: 0, backup: 'x.db', top: [{tag:'goal',n:1144},{tag:'training',n:633},{tag:'2v2',n:329},{tag:'ranked',n:265},{tag:'casual',n:144}] }),
  openPath: noop, openExternal: noop, saveManifest: noop,
  onScanProgress: (fn) => { cb.scan = fn; },
  onDownloadProgress: (fn) => { cb.dl = fn; },
  onDownloadLog: (fn) => { cb.log = fn; },
});
// contextIsolation means the preload's `window` is not the page's, so the
// test harness fires renderer callbacks through this bridge instead.
const cb = {};
contextBridge.exposeInMainWorld('harness', {
  scan: (p) => cb.scan && cb.scan(p),
  dl:   (p) => cb.dl && cb.dl(p),
  log:  (m) => cb.log && cb.log(m),
});
