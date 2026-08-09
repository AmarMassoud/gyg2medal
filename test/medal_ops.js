const fs=require('fs'),path=require('path'),os=require('os');
Object.defineProperty(process,'platform',{value:'win32'});
process.env.PATH=(process.env.FAKEBIN||'/tmp/fakebin')+':'+process.env.PATH;
const APP=fs.mkdtempSync(path.join(os.tmpdir(),'appdata-')); const MEDAL=path.join(APP,'Medal');
fs.mkdirSync(MEDAL,{recursive:true});
const FIX=process.env.MEDAL_DB||'';
if(!FIX||!fs.existsSync(FIX)){ console.log('SKIP medal_ops: set MEDAL_DB to a copy of a real Medal database'); process.exit(0); }
fs.copyFileSync(FIX, path.join(MEDAL,'medal-1234567.db'));
for(const s of ['-wal','-shm']){const p=FIX+s; if(fs.existsSync(p))fs.copyFileSync(p,path.join(MEDAL,'medal-1234567.db'+s));}
process.env.APPDATA=APP;
const M=require(require('path').join(__dirname,'..','electron','medal'));
const D=require('better-sqlite3');
const clips=JSON.parse(fs.readFileSync(process.env.CLIPS_JSON||path.join(__dirname,'clips.sample.json'),'utf8'));
const F='C:\\Users\\you\\Videos\\GYG-Clips';
const P=()=>true;
let fails=[]; const ok=(n,c)=>{console.log((c?'  PASS ':'  FAIL ')+n); if(!c)fails.push(n);};
const q=(sql,...a)=>{const db=new D(path.join(MEDAL,'medal-1234567.db')); const r=db.prepare(sql).all(...a); db.close(); return r;};

(async()=>{
  console.log('\n== detect ==');
  const st=M.detect();
  ok('reads folders + catalog', st.canConfigure && st.catalogSize===28);
  console.log('   catalog games:',st.catalogSize,'| folders:',st.folders.length);

  console.log('\n== dates ==');
  const d=await M.fixClipDates(F,clips,{pathExists:P});
  ok('no clip left stamped today', d.stillToday===0);
  ok('every row seen', d.seen===1334 && d.unmatched===0);
  console.log('  ',JSON.stringify({updated:d.updated,stillToday:d.stillToday}));

  console.log('\n== games ==');
  const g=await M.setGameCategories(F,clips,{pathExists:P});
  ok('1315 re-filed, 19 kept Imported', g.moved===1315 && g.keptImported===19);
  console.log('   byGame:',JSON.stringify(g.byGame),'| unmapped:',JSON.stringify(g.unmapped));

  console.log('\n== tags ==');
  const t=await M.setClipTags(F,clips,{pathExists:P});
  ok('all 1334 tagged', t.tagged===1334);
  ok('date autotags excluded', !t.top.some(x=>/^\d{4}(-\d+)?$/.test(x.tag)));
  console.log('   hashtags:',t.totalTags,'| top:',t.top.slice(0,8).map(x=>`${x.tag}:${x.n}`).join(' '));

  console.log('\n== verify against SQLite ==');
  const tags=q("select json_extract(metadata,'$.tags') t from contents where video_path like '%GYG-Clips%' limit 3");
  console.log('   sample tags:',tags.map(r=>r.t).join(' | '));
  const cats=q("select category_id,count(*) c from contents where video_path like '%GYG-Clips%' group by category_id order by c desc");
  console.log('   categories:',JSON.stringify(cats));
  ok('metadata still valid JSONB everywhere (flag 8)',
     q("select count(*) c from contents where json_valid(metadata,8)=0")[0].c===0);
  ok('other fields intact (duration present)',
     q("select count(*) c from contents where video_path like '%GYG-Clips%' and json_extract(metadata,'$.clipDuration') is null")[0].c===0);
  ok('non-GYG clips untouched', q("select count(*) c from contents where video_path not like '%GYG-Clips%' or video_path is null")[0].c===1292);
  ok('favourites counter intact', q("select count from content_counts where key='favorites'")[0].count===72);

  console.log('\n== idempotency (re-run everything) ==');
  const d2=await M.fixClipDates(F,clips,{pathExists:P});
  const g2=await M.setGameCategories(F,clips,{pathExists:P});
  ok('dates no-op on re-run', d2.updated===0);
  ok('games no-op on re-run', g2.moved===0 && g2.byGame['Rocket League']===1307);

  console.log('\n== refuses while Medal runs ==');
  const orig=M.isRunning;
  const modPath=require.resolve(require('path').join(__dirname,'..','electron','medal'));
  // simulate by pointing tasklist at something that reports Medal
  fs.writeFileSync('/tmp/fakebin/tasklist','#!/bin/sh\necho \'"Medal.exe","1234"\'\n'); fs.chmodSync('/tmp/fakebin/tasklist',0o755);
  try { await M.setClipTags(F,clips,{pathExists:P}); ok('refuses while running', false); }
  catch(e){ ok('refuses while running', /still running/i.test(e.message)); }
  fs.writeFileSync('/tmp/fakebin/tasklist','#!/bin/sh\necho ""\n'); fs.chmodSync('/tmp/fakebin/tasklist',0o755);

  console.log(`\n${fails.length? fails.length+' FAILED: '+fails.join(', '):'ALL PASSED'}`);
  process.exit(fails.length?1:0);
})();
