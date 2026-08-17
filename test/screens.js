const { app, BrowserWindow } = require('electron');
const path = require('path'), fs = require('fs');
const OUT = path.join(__dirname, 'shots');

const shot = async (win, name) => {
  await new Promise(r => setTimeout(r, 420));
  const img = await win.capturePage();
  fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  console.log('shot:', name);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 860, height: 660, show: false, backgroundColor: '#15161a',
    webPreferences: { preload: path.join(__dirname, 'fake-preload.js'), contextIsolation: true },
  });
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const js = (code) => win.webContents.executeJavaScript(code, true);
  // Offscreen windows do not drive CSS animations, so the entry fade would be
  // frozen half-way through in every capture. Turn transitions off for shots.
  await win.webContents.insertCSS('*{animation:none !important;transition:none !important}');

  await shot(win, '1-signin');

  await js(`show('scan'); $('scan-who').textContent='Signed in as yourname.';
            harness.scan({stage:'Looking up clips… 940 of 1336', done:940, total:1336});`);
  await shot(win, '2-scan');

  await js(`runScan()`); await new Promise(r=>setTimeout(r,300));
  await shot(win, '3-review');

  await js(`$('per-game').checked=true; checkDest();`);
  await shot(win, '4-review-warning');

  await js(`state.dest='C:\\\\Users\\\\you\\\\Videos\\\\GYG-Clips'; $('dl-dest').textContent=state.dest; show('download');
    harness.dl({done:421,skipped:12,failed:2,bytes:5.1e9,total:1334,startedAt:Date.now()-540000});
    harness.log('FAILED  ChalkyBriskZidane  (HTTP 404)');
    harness.log('FAILED  WovenPastelYuna  (size mismatch: got 0, expected 8123441)');`);
  await shot(win, '5-downloading');

  await js(`state.clips=1334; state.result={done:1334,skipped:0,failed:0}; state.perGame=false;
            state.dest='C:\\Users\\you\\Videos\\GYG-Clips-2';
            show('medal'); $('m-sub').textContent='1,334 downloaded. Now into Medal.';
            chooseProfile().then(()=>{
              setStep('register','ok','Added to Medal. Settings backed up first.');
              setStep('import','on','Medal is importing... 856 of 1,334');
              $('m-bar').classList.remove('hidden'); $('m-fill').style.width='64%';
              $('m-action').textContent='Skip waiting';});`);
  await new Promise(r=>setTimeout(r,600));
  await shot(win, '6-medal-importing');

  await js(`setStep('import','ok','All 1,334 clips imported.'); $('m-bar').classList.add('hidden');
            setStep('finish','on',"Quit Medal completely - right-click its system tray icon and choose Quit. Then press the button and I will set the dates, games and tags in one go.");
            $('m-action').textContent="I have quit Medal";`);
  await shot(win, '7-medal-quit');

  await js(`$('m-err').textContent=''; setStep('import','ok','All 1,334 clips imported.');
            $('m-bar').classList.add('hidden');
            setStep('finish','ok','1,334 dates corrected \u00b7 1,307 Rocket League, 7 Lunar Client, 1 Minecraft (19 stayed Imported) \u00b7 4,760 hashtags \u00b7 1,334 saved to your Medal account');`);
  await shot(win, '8-medal-dates');

  await js(`state.imported=1334; state.dateResult={updated:1334,backup:'medal-1234567.gyg2medal-datefix-20260809.db'};
            state.gameResult={moved:1315}; state.tagResult={totalTags:4760}; state.cloudResult={pushed:1334,failed:0,reason:null};
            state.result.failureLog='x'; finish();`);
  await shot(win, '9-done');

  app.quit();
}).catch(e => { console.error(e); app.exit(1); });
