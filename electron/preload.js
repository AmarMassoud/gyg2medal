'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * Every call goes through this. If the main process throws, the renderer used
 * to get a rejected promise that nothing caught -- the step function died
 * mid-await and the UI froze on its last message with no error anywhere.
 * Now a failure comes back as data the UI can show.
 */
const call = (channel, ...args) =>
  ipcRenderer.invoke(channel, ...args).catch((e) => ({
    ok: false,
    error: String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*/, ''),
  }));

/**
 * The renderer gets a narrow, explicit surface -- no Node, no fs, no
 * arbitrary IPC. Everything it can do is listed here.
 */
contextBridge.exposeInMainWorld('api', {
  isDev:            ()            => ipcRenderer.invoke('isDev').catch(() => false),
  appVersion:       ()            => ipcRenderer.invoke('appVersion').catch(() => ''),
  devLoadManifest:  (f)           => call('devLoadManifest', f),
  login:            ()            => call('login'),
  verifyToken:      (t)           => call('verifyToken', t),
  signOut:          ()            => call('signOut'),
  scan:             ()            => call('scan'),
  defaultDest:      ()            => call('defaultDest'),
  chooseFolder:     (c)           => call('chooseFolder', c),
  checkDest:        (d)           => call('checkDest', d),
  startDownload:    (o)           => call('startDownload', o),
  pauseDownload:    ()            => call('pauseDownload'),
  resumeDownload:   ()            => call('resumeDownload'),
  cancelDownload:   ()            => call('cancelDownload'),
  medalDetect:      (d)           => call('medal:detect', d),
  medalProfiles:    ()            => call('medal:profiles'),
  medalSelectProfile: (f)         => call('medal:selectProfile', f),
  medalRegister:    (d)           => call('medal:register', d),
  medalImport:      (d)           => call('medal:importProgress', d),
  medalRestage:     (d)           => call('medal:restage', d),
  medalPending:     (d)           => call('medal:pending', d),
  onRestageProgress:(fn)          => ipcRenderer.on('restage:progress', (_e, p) => fn(p)),
  medalFixDates:    (o)           => call('medal:fixDates', o),
  medalSetGames:    (o)           => call('medal:setGames', o),
  medalSetTags:     (o)           => call('medal:setTags', o),
  diagnostics:      (d)           => call('diagnostics', d),
  openPath:         (p)           => call('openPath', p),
  openExternal:     (u)           => call('openExternal', u),
  saveManifest:     (d)           => call('saveManifest', d),

  onScanProgress:     (fn) => ipcRenderer.on('scan:progress', (_e, p) => fn(p)),
  onDownloadProgress: (fn) => ipcRenderer.on('download:progress', (_e, p) => fn(p)),
  onDownloadLog:      (fn) => ipcRenderer.on('download:log', (_e, m) => fn(m)),
});
