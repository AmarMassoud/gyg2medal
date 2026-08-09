const { contextBridge, ipcRenderer } = require('electron');
const cb={};
contextBridge.exposeInMainWorld('api', {
  medalDetect: async () => ({ installed:true, canConfigure:true, running:false, alreadyAdded:true, folders:[] }),
  // simulate the exact failure we could not see: the library read blows up
  medalImport: async () => ({ ok:false, imported:0, error:"better_sqlite3.node could not be loaded", total:1334, running:false }),
  diagnostics: async () => ({ ok:true }),
  onScanProgress:(f)=>{cb.a=f}, onDownloadProgress:(f)=>{cb.b=f}, onDownloadLog:(f)=>{cb.c=f},
  login:async()=>({}), verifyToken:async()=>({}), signOut:async()=>({}), scan:async()=>({}),
  defaultDest:async()=>'', chooseFolder:async()=>null, checkDest:async()=>({warnings:[]}),
  startDownload:async()=>({}), pauseDownload:async()=>{}, resumeDownload:async()=>{}, cancelDownload:async()=>{},
  medalRegister:async()=>({ok:true}), medalFixDates:async()=>({ok:true}), medalSetGames:async()=>({ok:true}),
  medalSetTags:async()=>({ok:true}), openPath:async()=>{}, openExternal:async()=>{}, saveManifest:async()=>{},
});
