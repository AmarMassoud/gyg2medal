'use strict';

const $ = (id) => document.getElementById(id);
const STAGES = { signin: 0, scan: 1, review: 1, download: 2, medal: 3, done: 4 };
const show = (name) => {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $('s-' + name).classList.add('active');
  const at = STAGES[name] ?? 0;
  ['c1', 'c2', 'c3', 'c4'].forEach((id, i) => {
    const el = $(id);
    if (!el) return;
    el.className = 'crumb' + (i < at ? ' done' : i === at ? ' on' : '');
  });
};

const state = { dest: '', clips: 0, perGame: false, imported: 0, lastError: '' };

/* Version in the title bar, so a bug report always carries its build. */
(async () => {
  try {
    const v = window.api.appVersion ? await window.api.appVersion() : '';
    if (v) $('ver').textContent = 'v' + v;
  } catch { /* cosmetic only */ }
})();

/* Anything that escapes a handler used to kill the step mid-await and leave
 * the window frozen with no message. Surface it instead. */
function surface(what, err) {
  state.lastError = `${what}: ${err}`;
  const box = $('m-err');
  if (box) box.textContent = `Something went wrong (${what}): ${err}. Press "Copy diagnostics" and send it over.`;
  const diag = $('btn-diag');
  if (diag) diag.classList.remove('hidden');
}
window.addEventListener('error', (e) => surface('error', e.message));
window.addEventListener('unhandledrejection', (e) =>
  surface('unhandled', (e.reason && e.reason.message) || e.reason));

const human = (n) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i <= 1 ? 0 : 1)} ${u[i]}`;
};
const yearOf = (iso) => (iso || '').slice(0, 4);

/* ----------------------------- sign in ----------------------------- */

$('btn-login').onclick = async () => {
  const btn = $('btn-login');
  btn.disabled = true;
  btn.textContent = 'Waiting for sign-in…';
  $('login-err').textContent = '';

  const res = await window.api.login();
  if (!res.ok) {
    btn.disabled = false;
    btn.textContent = 'Sign in with Gif Your Game';
    if (res.error !== 'cancelled') $('login-err').textContent = res.error;
    return;
  }
  const check = await window.api.verifyToken(res.token);
  if (!check.ok) {
    btn.disabled = false;
    btn.textContent = 'Sign in with Gif Your Game';
    $('login-err').textContent = check.error;
    return;
  }
  $('scan-who').textContent = `Signed in as ${check.username}.`;
  show('scan');
  runScan();
};

/* ------------------------------ scan ------------------------------ */

window.api.onScanProgress((p) => {
  $('scan-stage').textContent = p.stage;
  $('scan-fill').style.width = p.total ? `${(p.done / p.total) * 100}%` : '12%';
});

async function runScan() {
  const res = await window.api.scan();
  if (!res.ok) {
    $('scan-stage').textContent = res.error;
    return;
  }
  state.clips = res.count;

  if (!res.count) {
    $('rev-title').textContent = 'No downloadable clips found';
    $('rev-sub').textContent =
      'This account has no clips with a rendered video on GYG. Clips that were deleted, or that never finished uploading, cannot be recovered.';
    $('rev-games').classList.add('hidden');
    $('btn-download').classList.add('hidden');
    show('review');
    return;
  }

  $('rev-title').textContent = `Found ${res.count.toLocaleString()} clips`;
  $('rev-sub').textContent =
    `About ${res.bytesHuman}, ${res.minutes} minutes of footage, ${yearOf(res.oldest)} to ${yearOf(res.newest)}.`;

  const rows = Object.entries(res.games).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([g, n]) => `<div class="line"><span>${g}</span><span>${n.toLocaleString()}</span></div>`).join('');
  const note = res.unresolved
    ? `<span class="note">${res.unresolved} clip(s) have no working video on GYG's servers and will be skipped.</span>` : '';
  $('rev-games').innerHTML = rows + note;

  state.dest = await window.api.defaultDest();
  $('dest').value = state.dest;
  checkDest();
  show('review');
}

/* ----------------------------- review ----------------------------- */

$('btn-browse').onclick = async () => {
  const picked = await window.api.chooseFolder($('dest').value);
  if (picked) { $('dest').value = picked; checkDest(); }
};
$('dest').oninput = checkDest;
$('per-game').onchange = checkDest;

async function checkDest() {
  state.dest = $('dest').value;
  state.perGame = $('per-game').checked;
  const res = await window.api.checkDest(state.dest);
  const warnings = res.warnings.slice();
  if (state.perGame) {
    warnings.push("Subfolders are on: Medal only scans the top level of the folder you give it, so it will import nothing. Leave this off unless you just want the files organised on disk.");
  }
  $('dest-warn').textContent = warnings.join('  ');
}

$('btn-signout').onclick = async () => { await window.api.signOut(); location.reload(); };

$('btn-download').onclick = async () => {
  // Register the folder with Medal FIRST. Medal only imports files it sees
  // arrive, so a folder registered after the download would never be scanned.
  const info = await window.api.medalDetect(state.dest);
  if (info && info.installed && info.canConfigure && !info.alreadyAdded && !info.running) {
    await window.api.medalRegister(state.dest);
  }
  $('dl-dest').textContent = state.dest;
  $('dl-log').textContent = '';
  show('download');
  const res = await window.api.startDownload({ dest: state.dest, perGameFolders: state.perGame });
  if (!res.ok) { $('dl-stat').textContent = res.error; return; }
  state.result = res;
  startMedalFlow().catch((e) => surface('medal flow', e.message));
};

/* ---------------------------- download ---------------------------- */

let lastPaint = 0;
window.api.onDownloadProgress((p) => {
  const now = Date.now();
  const finished = p.done + p.skipped + p.failed;
  if (now - lastPaint < 120 && finished < p.total) return;
  lastPaint = now;

  $('dl-fill').style.width = `${(finished / p.total) * 100}%`;
  $('dl-stat').textContent = `${finished.toLocaleString()} of ${p.total.toLocaleString()} clips`;

  const secs = Math.max(0.001, (now - p.startedAt) / 1000);
  const rate = p.bytes / secs;
  let eta = '';
  if (p.done > 3 && rate > 0) {
    const per = p.bytes / p.done;
    const left = ((p.total - finished) * per) / rate;
    eta = ` · about ${Math.floor(left / 60)}m ${Math.round(left % 60)}s left`;
  }
  $('dl-sub').textContent =
    `${human(p.bytes)} downloaded · ${human(rate)}/s${eta}` +
    (p.skipped ? ` · ${p.skipped} already had` : '') +
    (p.failed ? ` · ${p.failed} failed` : '');
});

window.api.onDownloadLog((m) => {
  const el = $('dl-log');
  el.textContent += m + '\n';
  el.scrollTop = el.scrollHeight;
});

$('btn-pause').onclick = () => {
  const b = $('btn-pause');
  if (b.textContent === 'Pause') { window.api.pauseDownload(); b.textContent = 'Resume'; }
  else { window.api.resumeDownload(); b.textContent = 'Pause'; }
};
$('btn-stop').onclick = () => window.api.cancelDownload();

/* ------------------------- Medal, guided ------------------------- *
 * Three steps, and Medal forces the shape of all of them:
 *   1 register the folder  -- Medal reads this at startup, so it must be closed
 *   2 let Medal import     -- it only scans while it is running, and it is the
 *                             thing that generates thumbnails and probes each
 *                             video, which is why we don't insert rows ourselves
 *   3 quit, then fix up    -- dates, games and tags are three writes but ONE
 *                             wait for the user, so they are one step
 *
 * The fix-up is unavoidable rather than sloppy: Medal stamps every imported
 * clip with the moment it scanned the file and drops them all in "Imported",
 * so the corrections can only happen after the import exists.
 * ------------------------------------------------------------------ */

const stepEl = (n) => $('st-' + n);
function setStep(name, status, detail) {
  const li = stepEl(name);
  li.classList.remove('on', 'ok', 'todo');
  li.classList.add(status);
  if (detail !== undefined) $(`st-${name}-x`).textContent = detail;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startMedalFlow() {
  show('medal');
  ['register', 'import', 'finish'].forEach((s) => setStep(s, 'todo', ''));
  $('m-err').textContent = '';

  const r = state.result;
  $('m-sub').textContent =
    `${r.done.toLocaleString()} downloaded${r.skipped ? `, ${r.skipped} already had` : ''}` +
    `${r.failed ? `, ${r.failed} failed` : ''}. Now into Medal.`;

  const info = await window.api.medalDetect(state.dest);

  if (!info.installed) {
    setStep('register', 'todo', 'Medal is not installed on this PC.');
    $('m-action').textContent = 'Finish';
    $('m-action').onclick = finish;
    return;
  }
  if (state.perGame) {
    $('m-err').textContent =
      'You chose per-game subfolders, so Medal will not see these clips. It only scans the top level. Move the files into the folder root, then run this app again.';
  }

  await chooseProfile();
  await stepRegister(await window.api.medalDetect(state.dest));
}

/* Which Medal account are we operating on?
 *
 * Medal keeps a separate library per account, and guessing is unsafe: file
 * timestamps favour freshly created empty profiles, and clip counts favour
 * accounts the user may have signed out of. So show what is actually there,
 * default to the one Medal is signed into, and let the user override. */
async function chooseProfile() {
  const res = await window.api.medalProfiles();
  if (!res || !res.ok || !res.profiles.length) return;

  const describe = (p) => {
    const bits = [];
    if (p.clips >= 0) bits.push(`${p.clips.toLocaleString()} clip${p.clips === 1 ? '' : 's'}`);
    if (p.email) bits.push(p.email);
    if (p.active) bits.push('signed in now');
    return `${p.label}${bits.length ? ' - ' + bits.join(' \u00b7 ') : ''}`;
  };

  const sel = $('m-profile-pick');
  sel.innerHTML = res.profiles
    .map((p, i) => `<option value="${i}">${describe(p)}</option>`).join('');
  state.profiles = res.profiles;

  const active = res.profiles.findIndex((p) => p.active);
  sel.selectedIndex = active >= 0 ? active : 0;
  await window.api.medalSelectProfile(res.profiles[sel.selectedIndex].file);

  sel.onchange = async () => {
    const p = state.profiles[sel.selectedIndex];
    await window.api.medalSelectProfile(p.file);
    $('m-profile-note').textContent =
      `Using ${p.label}. Clips will be imported into, and corrected in, this account's library.`;
  };

  // Only worth showing when there is a real decision to make.
  if (res.profiles.filter((p) => !p.guest).length > 1) {
    $('m-profile').classList.remove('hidden');
    const p = res.profiles[sel.selectedIndex];
    $('m-profile-note').textContent = p.active
      ? 'This is the account Medal is signed into. Change it if your clips belong somewhere else.'
      : `Using ${p.label}.`;
  }
}

/* step 1 -- register the folder (needs Medal closed) */
async function stepRegister(info) {
  setStep('register', 'on', 'Checking Medal…');

  if (info.alreadyAdded) {
    setStep('register', 'ok', 'Folder was already registered with Medal.');
    return stepImport();
  }
  if (info.running) {
    setStep('register', 'on', 'Medal is running. Quit it (tray icon → Quit), then press Continue.');
    $('m-action').textContent = 'Continue';
    $('m-action').onclick = async () => {
      const again = await window.api.medalDetect(state.dest);
      if (again.running) {
        $('m-err').textContent = 'Medal is still running. Right-click its icon in the system tray and choose Quit.';
        return;
      }
      $('m-err').textContent = '';
      stepRegister(again);
    };
    return;
  }

  const res = await window.api.medalRegister(state.dest);
  if (!res.ok) {
    setStep('register', 'on', res.error);
    $('m-action').textContent = 'Try again';
    $('m-action').onclick = async () => stepRegister(await window.api.medalDetect(state.dest));
    return;
  }
  setStep('register', 'ok', `Added to Medal. Settings backed up as ${res.backup}`);
  stepImport();
}

/* step 2 -- Medal only scans while it is running.
 *
 * This waits on a number it does not control, so it must never be a trap:
 * the count can legitimately stop short (a file Medal dislikes, or clips that
 * were already imported by an earlier run), and if the database cannot be
 * read the count stays at zero forever. So it also stops when the number
 * holds still, and it always says what it can actually see.
 */
async function stepImport() {
  setStep('import', 'on', 'Start Medal and leave it open.');
  $('m-bar').classList.remove('hidden');
  $('m-action').textContent = 'Skip waiting';
  $('m-action').disabled = false;
  $('m-action').onclick = () => stepFinish();

  // Wait for Medal to be running -- nothing can import until it is.
  for (;;) {
    const p = await window.api.medalImport(state.dest);
    if (!p || p.ok === false) {
      setStep('import', 'on', `Can't read Medal's library: ${(p && p.error) || 'no response'}.`);
      return;
    }
    state.imported = p.imported;
    if (p.imported >= state.clips) {
      setStep('import', 'ok', `All ${p.imported.toLocaleString()} clips are in Medal.`);
      $('m-bar').classList.add('hidden');
      return stepFinish();
    }
    if (p.running) break;
    setStep('import', 'on',
      `Waiting for Medal to start… ${p.imported.toLocaleString()} of ${state.clips.toLocaleString()} imported so far.`);
    await sleep(2500);
  }

  // Medal only notices files ARRIVING, so present the ones it hasn't taken.
  const pend = await window.api.medalPending(state.dest);
  if (pend.ok && pend.pending > 0) {
    setStep('import', 'on', `Handing ${pend.pending.toLocaleString()} clips to Medal…`);
    window.api.onRestageProgress((r) => {
      setStep('import', 'on',
        `Handing clips to Medal… ${r.done.toLocaleString()} of ${r.total.toLocaleString()}`);
      $('m-fill').style.width = `${Math.min(100, (r.done / Math.max(1, r.total)) * 100)}%`;
    });
    const res = await window.api.medalRestage(state.dest);
    if (!res.ok) {
      setStep('import', 'on', `${res.error} Press Skip waiting once Medal has imported them.`);
      return;
    }
  }

  // Now watch Medal chew through them.
  let last = -1;
  let stable = 0;
  for (;;) {
    const p = await window.api.medalImport(state.dest);
    if (!p || p.ok === false) {
      setStep('import', 'on', `Can't read Medal's library: ${(p && p.error) || 'no response'}.`);
      return;
    }
    state.imported = p.imported;
    $('m-fill').style.width = `${Math.min(100, (p.imported / Math.max(1, state.clips)) * 100)}%`;

    if (p.imported >= state.clips) {
      setStep('import', 'ok', `All ${p.imported.toLocaleString()} clips imported.`);
      $('m-bar').classList.add('hidden');
      return stepFinish();
    }
    stable = p.imported === last ? stable + 1 : 0;
    last = p.imported;
    if (stable >= 12 && p.imported > 0) {
      setStep('import', 'ok',
        `${p.imported.toLocaleString()} of ${state.clips.toLocaleString()} imported and the count has settled, so carrying on.`);
      $('m-bar').classList.add('hidden');
      return stepFinish();
    }
    setStep('import', 'on',
      `Medal is importing… ${p.imported.toLocaleString()} of ${state.clips.toLocaleString()}`
      + ' (it makes a thumbnail for each, so this takes a few minutes)');
    await sleep(3000);
  }
}

/* step 3 -- one wait, three writes */
async function stepFinish() {
  $('m-bar').classList.add('hidden');
  setStep('finish', 'on',
    'Quit Medal completely. Right-click its system tray icon and choose Quit. '
    + "Then press the button and I'll set the dates, games and tags in one go.");
  $('m-action').textContent = "I've quit Medal";
  $('m-action').disabled = false;
  $('m-action').onclick = runFixUps;
}

async function runFixUps() {
  const info = await window.api.medalDetect(state.dest);
  if (info.running) {
    $('m-err').textContent =
      'Medal is still running. Closing the window is not enough, it hides in the system tray. '
      + 'Right-click it there and choose Quit, or end "Medal" in Task Manager.';
    return;
  }
  $('m-err').textContent = '';
  $('m-action').disabled = true;

  const fail = (msg) => {
    setStep('finish', 'on', msg);
    $('m-action').disabled = false;
    $('m-action').textContent = 'Try again';
    $('m-action').onclick = runFixUps;
  };

  setStep('finish', 'on', 'Setting the dates…');
  const dates = await window.api.medalFixDates({ dest: state.dest });
  if (!dates.ok) return fail(dates.error);
  state.dateResult = dates;

  setStep('finish', 'on', 'Filing clips under their game…');
  const games = await window.api.medalSetGames({ dest: state.dest });
  if (!games.ok) return fail(games.error);
  state.gameResult = games;

  setStep('finish', 'on', 'Writing your tags…');
  const tags = await window.api.medalSetTags({ dest: state.dest });
  if (!tags.ok) return fail(tags.error);
  state.tagResult = tags;

  const named = Object.entries(games.byGame).sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `${n.toLocaleString()} ${g}`).join(', ');
  setStep('finish', 'ok',
    `${dates.updated.toLocaleString()} dates corrected · ${named || 'nothing to re-file'}`
    + `${games.keptImported ? ` (${games.keptImported} stayed Imported)` : ''}`
    + ` · ${tags.totalTags.toLocaleString()} hashtags`);
  finish();
}

function finish() {
  const r = state.result || {};
  const d = state.dateResult;
  $('done-sub').textContent = d
    ? 'Your clips are in Medal: dated, filed under their game, and tagged. Start Medal and take a look.'
    : 'Your clips are downloaded.';
  const lines = [
    ['Clips downloaded', (r.done || 0).toLocaleString()],
    ['Already had', (r.skipped || 0).toLocaleString()],
    ['Failed', (r.failed || 0).toLocaleString()],
  ];
  if (d) {
    lines.push(['Imported into Medal', state.imported.toLocaleString()]);
    lines.push(['Dates corrected', d.updated.toLocaleString()]);
  }
  if (state.gameResult) lines.push(['Filed under their game', state.gameResult.moved.toLocaleString()]);
  if (state.tagResult) lines.push(['Hashtags written', state.tagResult.totalTags.toLocaleString()]);
  let html = lines.map(([k, v]) => `<div class="line"><span>${k}</span><span>${v}</span></div>`).join('');
  if (d && d.backup) {
    html += `<span class="note">Medal's settings were backed up first as ${d.backup}. To undo, close Medal and swap that file back over the original.</span>`;
  }
  if (r.failureLog) {
    html += `<span class="note">Failed clips are listed in failed_clips.csv. Re-running the app retries them.</span>`;
  }
  $('done-card').innerHTML = html;
  show('done');
}

$('btn-open').onclick = () => window.api.openPath(state.dest);
$('btn-close').onclick = () => window.close();


/* ---------------------------- diagnostics ---------------------------- *
 * One button that copies everything the app can see. Beats five rounds of
 * "what does it say now?".
 * -------------------------------------------------------------------- */
$('btn-diag').onclick = async () => {
  const d = await window.api.diagnostics(state.dest);
  const report = JSON.stringify({
    ...d,
    ui: {
      clipsExpected: state.clips,
      importedSeen: state.imported,
      perGameFolders: state.perGame,
      lastError: state.lastError || null,
    },
  }, null, 2);
  try {
    await navigator.clipboard.writeText(report);
  } catch {
    // "Document is not focused" -- fall back to a plain textarea copy.
    const ta = document.createElement('textarea');
    ta.value = report;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
  $('btn-diag').textContent = 'Copied, paste it to me';
  setTimeout(() => { $('btn-diag').textContent = 'Copy diagnostics'; }, 4000);
};


/* ------------------------------ dev mode ------------------------------ *
 * Iterating on the Medal steps meant a fresh sign-in, a 1,300-clip scan and
 * a 15 GB download every single time. This replays a saved manifest against
 * a folder that already exists, so the interesting part is reachable in
 * about two seconds. Hidden unless --dev / GYG2MEDAL_DEV=1.
 * --------------------------------------------------------------------- */
(async () => {
  if (!(await window.api.isDev())) return;
  $('dev-bar').classList.remove('hidden');

  const start = async (pickManifest) => {
    const note = $('dev-note');
    note.textContent = 'Loading manifest…';
    const man = await window.api.devLoadManifest(pickManifest ? undefined : null);
    if (!man.ok) {
      note.textContent = man.error === 'cancelled' ? '' : `Manifest failed: ${man.error}`;
      return;
    }
    const folder = await window.api.chooseFolder(await window.api.defaultDest());
    if (!folder) { note.textContent = 'Pick the folder your clips are already in.'; return; }

    state.clips = man.count;
    state.dest = folder;
    state.perGame = false;
    state.result = { done: man.count, skipped: 0, failed: 0, bytes: 0, total: man.count };
    note.textContent = `${man.count.toLocaleString()} clips loaded (${man.withTags.toLocaleString()} with tags) from ${man.from}`;
    startMedalFlow().catch((e) => surface('medal flow', e.message));
  };

  $('dev-run').onclick = () => start(false);
  $('dev-pick').onclick = () => start(true);
})();
