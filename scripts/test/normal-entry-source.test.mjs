import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { readNormalEntry } from '../lib/normal-entry-source.mjs';
import { parseRows } from '../trajectory.mjs';
import { firings } from '../lib/diagnosis.mjs';
const digest = x => createHash('sha256').update(x).digest('hex');
const manifestPath = 'evidence/normal-entry/manifest.json';
function fixture(t) {
  const records = realpathSync(mkdtempSync(join(process.env.NORMAL_ENTRY_TEST_TMP ?? tmpdir(), 'normal-source-')));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  const git = (...a) => cp.execFileSync('git', ['-C', records, ...a], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  const write = (p, s) => { mkdirSync(dirname(join(records,p)), { recursive: true }); writeFileSync(join(records,p),s); };
  git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.invalid');
  const commit = () => { git('add','.'); git('commit','-qm','fixture'); return git('rev-parse','HEAD'); };
  const text = JSON.stringify({ id: 'W-001', text: 'hello 世界' });
  write('owner/words.jsonl',text+'\n');
  const baseline = commit(), repo = `git-root:${baseline}`;
  const source = { repo, revision: baseline, path: 'owner/words.jsonl', selector: { type: 'word', id: 'W-001' },
    entryRange: [0,Buffer.byteLength(text)], clauseRange: [text.indexOf('hello'),text.indexOf('hello')+5], blobSha256: digest(text+'\n'), clauseSha256: digest('hello') };
  const row = { kind: 'owner_word', entryId: 'word-1', clauseId: 'c1', path: source.path, operation: 'upsert', source, predecessor: null };
  const manifest = { schema: 'normal-entry-manifest/v1', repo, baseline, phase: 'v1', inventory: [row], dispositions: [] };
  const publish = () => { write(manifestPath,JSON.stringify(manifest)); return commit(); };
  const blockers = { open: ['test:a'], shelved: ['test:b'] };
  const read = (revision = git('rev-parse','HEAD')) => readNormalEntry({ records, revision, phase: 'v1', cadence: { due: false, stateIdentity: 'a'.repeat(64) }, blockers });
  return { records,git,write,commit,source,row,manifest,publish,read,blockers,baseline };
}
test('committed-only fixed baseline and unrelated cuts preserve exact versions', t => {
  const f=fixture(t); const m=f.publish(), a=f.read();
  assert.equal(a.events.length,1); assert.equal(a.events[0].validation,'valid'); assert.equal(a.previousCut,f.baseline); assert.equal(a.blockers,f.blockers);
  f.write(manifestPath,'garbage'); assert.deepEqual(f.read(m),a);
  f.write(manifestPath,JSON.stringify(f.manifest)); f.write('unrelated','x'); const u=f.commit();
  assert.equal(f.read(u).events[0].version,a.events[0].version); assert.deepEqual(f.read(u),f.read(u));
});
test('history preserves revisions, tombstones, re-add and duplicate occurrences', t => {
  const f=fixture(t); f.publish(); const original=f.read().events[0];
  f.manifest.inventory=[{...f.row,operation:'delete',source:null,predecessor:original.version}]; f.publish();
  const deleted=f.read(); assert.equal(deleted.events.length,2); assert.equal(deleted.events[0].current,false);
  f.manifest.inventory=[{...f.row,predecessor:deleted.events[1].version}]; f.publish();
  const added=f.read(); assert.equal(added.events.length,3); assert.notEqual(added.events[2].version,original.version);
  f.manifest.inventory.push({...f.manifest.inventory[0]}); f.publish();
  const duplicate=f.read(); assert.equal(new Set(duplicate.events.map(e=>e.version)).size,3); assert.equal(duplicate.accountingInput.inputOccurrences,5);
  assert(duplicate.events.filter(e=>e.current).every(e=>e.validation==='valid'));
});
test('current source mutation and omission never erase historical obligations; repair restores', t => {
  const f=fixture(t); f.publish(); f.write('owner/words.jsonl','changed\n'); f.commit();
  assert.equal(f.read().events[0].reason,'stale_inventory');
  f.write('owner/words.jsonl',JSON.stringify({id:'W-001',text:'hello 世界'})+'\n'); f.manifest.inventory=[]; f.publish();
  assert.equal(f.read().events[0].reason,'inventory_omission');
  f.manifest.inventory=[f.row]; f.publish();
  const repaired=f.read(); assert(repaired.events.every(e=>e.validation==='valid')); assert(!repaired.diagnostics.some(d=>d.code==='inventory_omission'));
});
test('malformed local collections and invalid rows preserve valid siblings', t => {
  const f=fixture(t); f.manifest.inventory.push(null,{...f.row,clauseId:'bad',source:{...f.source,clauseRange:[0,99999]}}); f.manifest.dispositions={}; f.publish();
  const a=f.read(); assert.equal(a.events.find(e=>e.validation==='valid').source.clauseSha256,f.source.clauseSha256);
  assert.equal(a.accountingInput.invalidOccurrences,2); assert(a.diagnostics.some(d=>d.code==='bad_span'));
});
test('private, external, and malformed selector targets rejected before content calls', t => {
  for (const transform of [s=>({...s,path:'sealed/private.json'}),s=>({...s,repo:'git-root:'+'b'.repeat(40)}),s=>({...s,selector:{type:'word',id:'W-001',extra:true}})]) {
    const f=fixture(t), source=transform(f.source);
    f.manifest.inventory=[{...f.row,source}]; f.publish();
    const original=cp.execFileSync, calls=[];
    mock.method(cp,'execFileSync',(...args)=>{calls.push(args[1]); return original(...args);}); syncBuiltinESMExports();
    try { const a=f.read(); assert.equal(a.events[0].validation,'invalid'); assert.equal(calls.filter(a=>a.includes('blob')).length,1); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  }
});
test('private rejection across successive snapshots', t => {
  const f=fixture(t);
  for (const source of [{...f.source,path:'sealed/private.json'}, {...f.source,repo:'git-root:'+'b'.repeat(40)}, {...f.source,selector:{type:'word',id:'W-001',extra:true}}]) {
    f.manifest.inventory=[{...f.row,source}]; f.publish();
    const original=cp.execFileSync, calls=[];
    mock.method(cp,'execFileSync',(...args)=>{calls.push(args[1]); return original(...args);}); syncBuiltinESMExports();
    try {
      const a=f.read(); assert.equal(a.events.at(-1).validation,'invalid');
      assert(!calls.some(a=>a.includes('blob') && a.at(-1)===f.git('rev-parse',f.baseline+':owner/words.jsonl')));
    } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  }
});
test('symlink leaf and ancestor are checked without reading their blob', t => {
  for (const ancestor of [false,true]) {
    const f=fixture(t);
    rmSync(join(f.records,ancestor?'owner':'owner/words.jsonl'),{recursive:true});
    symlinkSync('/nonexistent/private',join(f.records,ancestor?'owner':'owner/words.jsonl'));
    const rev=f.commit(); f.row.source={...f.source,revision:rev}; f.publish();
    const original=cp.execFileSync,calls=[];
    mock.method(cp,'execFileSync',(...args)=>{calls.push(args[1]);return original(...args);});syncBuiltinESMExports();
    try { const got=f.read(); assert.equal(got.events[0].reason,'symlink'); assert.equal(calls.filter(a=>a.includes('blob')).length,1); }
    finally { mock.restoreAll();syncBuiltinESMExports(); }
  }
});
test('baseline reset and unavailable cut cannot give a valid cut', t => {
  const f=fixture(t),m=f.publish(); f.manifest.baseline=m; f.publish();
  assert.equal(f.read().cutStatus,'invalid'); assert.equal(f.read('e'.repeat(40)).cutStatus,'unavailable');
});
test('duplicate JSON keys and invalid UTF-8 manifests rejected', t => {
  const f=fixture(t); f.write(manifestPath,'{"schema":"x","schema":"y"}'); f.commit();
  assert(f.read().diagnostics.length); f.write(manifestPath,Buffer.from([0xff])); f.commit(); assert(f.read().diagnostics.length);
});
test('exact public disposition validates ordered links; snapshot removal withdraws it', t => {
  const f=fixture(t); f.publish(); const event=f.read().events[0];
  const path='evidence/normal-entry/public-ruling.json', raw='{"claim":"public"}\n';
  f.write(path,raw); const revision=f.commit();
  const pointer={repo:f.source.repo,revision,path,selector:{type:'document'},entryRange:[0,Buffer.byteLength(raw)],clauseRange:[0,Buffer.byteLength(raw)],blobSha256:digest(raw),clauseSha256:digest(raw)};
  const d={id:'d1',version:event.version,source:f.source,outcome:'NO_CHANGE',rationale:pointer,ruling:pointer,consumer:pointer,decision:'withhold',task:null,reason:'Release after independent review'};
  f.manifest.dispositions=[d]; f.publish();
  let a=f.read(); assert.equal(a.dispositions[0].validation,'valid'); assert.equal(new Set(a.events.map(e=>JSON.stringify({...e,provenance:[]}))).size,1);
  f.manifest.dispositions=[]; f.publish(); assert.equal(f.read().dispositions.length,0);
  f.manifest.dispositions=[{...d,consumer:{...pointer,path:'evidence/0001/private.json'}}]; f.publish();
  a=f.read(); assert.equal(a.dispositions[0].validation,'invalid'); assert.equal(a.dispositions[0].version,event.version);
});
test('answer selectors enforce whole-line occurrence and UTF-8 byte boundaries', t => {
  const f=fixture(t), text=JSON.stringify({batch:'B-0003',time:'2026-11-21T23:37:57Z',answer:'2，我同意。'}), raw=text+'\r\n'+text+'\n';
  f.write('owner/answers.jsonl',raw); const revision=f.commit();
  const start=Buffer.byteLength(text+'\r\n'), clause=start+Buffer.byteLength(text.slice(0,text.indexOf('2，')));
  const source={repo:f.source.repo,revision,path:'owner/answers.jsonl',selector:{type:'answer',batch:'B-0003',time:'2026-11-21T23:37:57Z',occurrence:1,lineSha256:digest(text)},entryRange:[start,start+Buffer.byteLength(text)],clauseRange:[clause,clause+Buffer.byteLength('2，我同意。')],blobSha256:digest(raw),clauseSha256:digest('2，我同意。')};
  f.manifest.inventory=[{...f.row,kind:'answer_clause',path:source.path,source}];f.publish();assert.equal(f.read().events[0].validation,'valid');
  f.manifest.inventory[0].source={...source,clauseRange:[clause+2,source.clauseRange[1]]};
  f.manifest.inventory[0].predecessor=f.read().events[0].version;f.publish();assert.equal(f.read().events.at(-1).reason,'bad_span');
});
test('completed reducer consumes adapter history without duplicate versions and preserves blockers', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  const f=fixture(t); f.publish();
  f.manifest.inventory.push({...f.row}); f.publish();
  let p=normalOpportunities(f.read()); assert.equal(p.state,'pending'); assert.equal(p.items.length,1); assert.equal(p.items[0].reason,'absent');
  assert.equal(p.accounting.inputOccurrences,3); assert.equal(p.accounting.duplicateOccurrences,2); assert.equal(p.blockers,f.blockers);
  f.manifest.inventory=[{...f.row,operation:'delete',source:null,predecessor:p.items[0].version}];f.publish();
  p=normalOpportunities(f.read());assert.equal(p.items.length,2);assert.equal(p.items[1].reason,'deletion_review');assert.equal(p.state,'pending');
});
test('ordinary next and start forward committed opportunities alongside existing work', async t => {
  const {loopProduct,ownerStore,ROOMY,isolatedEnv,selfLoop,git}=await import('./helpers.mjs');
  const root=realpathSync(mkdtempSync(join(process.env.NORMAL_ENTRY_TEST_TMP??tmpdir(),'normal-entry-integration-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const p=loopProduct({dir:join(root,'loop'),activity:'2026-11-22T00:00:00Z'});
  const write=(path,raw)=>{mkdirSync(dirname(join(p.records,path)),{recursive:true});writeFileSync(join(p.records,path),raw);};
  const baseline=git(p.records,'rev-parse','HEAD'), repo=`git-root:${baseline}`;
  const raw=JSON.stringify({id:'W-001',text:'hello'})+'\n';write('owner/words.jsonl',raw);git(p.records,'add','.');git(p.records,'commit','-qm','source');
  const source={repo,revision:git(p.records,'rev-parse','HEAD'),path:'owner/words.jsonl',selector:{type:'word',id:'W-001'},entryRange:[0,Buffer.byteLength(raw)-1],clauseRange:[0,1],blobSha256:digest(raw),clauseSha256:digest('{')};
  write(manifestPath,JSON.stringify({schema:'normal-entry-manifest/v1',repo,baseline,phase:'v1',inventory:[{kind:'owner_word',entryId:'word-1',clauseId:'c1',path:source.path,operation:'upsert',source,predecessor:null}],dispositions:[]}));
  git(p.records,'add','.');git(p.records,'commit','-qm','manifest');
  mkdirSync(join(root,'store'));
  const store=ownerStore([{name:'fixture',records:p.records}],{dir:join(root,'store'),bound:ROOMY});
  const env=isolatedEnv({SELF_LOOP_OWNER_STORE:store});
  const next=selfLoop(['next','--config',join(p.records,'loop.json')],{env,cwd:p.product});
  assert.equal(next.status,0,next.stderr);assert.match(next.stdout,/Normal opportunities: pending/);assert.match(next.stdout,/pending\/absent/);assert.match(next.stdout,/building features without a recorded running call/);
  write(manifestPath,'uncommitted bad bytes');
  const start=selfLoop(['start','--json'],{env,cwd:p.product});assert.equal(start.status,0,start.stderr);
  const report=JSON.parse(start.stdout);assert.equal(report.session.error,null);const section=text=>text.slice(text.indexOf("Normal opportunities:"),text.indexOf("\n\n-",text.indexOf("Normal opportunities:")));
  assert.equal(section(report.session.next),section(next.stdout));
  assert.match(report.session.next,/building features without a recorded running call/);
});
test('reordering physical JSONL rows revises moved clauses but preserves a separate unchanged blob', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  const f=fixture(t), original=JSON.stringify({id:'W-001',text:'hello 世界'}), other=JSON.stringify({id:'W-002',text:'other'});
  f.write('owner/words.jsonl',original+'\n'+other+'\n');f.write('decisions/D-0001.md','Trial\n');let revision=f.commit();
  const word={...f.source,revision,blobSha256:digest(original+'\n'+other+'\n')};
  const trial={repo:f.source.repo,revision,path:'decisions/D-0001.md',selector:{type:'document'},entryRange:[0,6],clauseRange:[0,5],blobSha256:digest('Trial\n'),clauseSha256:digest('Trial')};
  f.manifest.inventory=[{...f.row,source:word},{...f.row,kind:'trial',entryId:'trial-1',path:trial.path,source:trial}];f.publish();
  const before=normalOpportunities(f.read()), prior=before.items.find(e=>e.source.path===word.path), control=before.items.find(e=>e.source.path===trial.path);
  f.write(word.path,other+'\n'+original+'\n');revision=f.commit();
  const delta=Buffer.byteLength(other+'\n');
  f.manifest.inventory[0]={...f.row,predecessor:prior.version,source:{...word,revision,entryRange:word.entryRange.map(n=>n+delta),clauseRange:word.clauseRange.map(n=>n+delta),blobSha256:digest(other+'\n'+original+'\n')}};f.publish();
  const after=normalOpportunities(f.read());assert.equal(after.state,'pending');assert.equal(after.items.length,3);
  assert.equal(after.items.find(e=>e.source.path===trial.path).version,control.version);
  assert.equal(after.items.find(e=>e.current&&e.source.path===word.path).predecessor,prior.version);
});
test('missing baseline after a valid publication retains obligations as unknown', t => {
  const f=fixture(t);f.publish();f.manifest.baseline='d'.repeat(40);f.publish();
  const a=f.read();assert.equal(a.cutStatus,'invalid');assert.equal(a.events.length,1);assert.equal(a.events[0].validation,'unknown');assert.equal(a.events[0].reason,'bad_cut');
});
test('unrelated-root merge is unsupported without any content read', t => {
  const f=fixture(t);f.publish();
  const tree=f.git('rev-parse',f.baseline+'^{tree}'), side=f.git('commit-tree',tree,'-m','unrelated root'), head=f.git('rev-parse','HEAD');
  const merge=f.git('commit-tree',tree,'-p',head,'-p',side,'-m','merge unrelated');
  const original=cp.execFileSync,calls=[];mock.method(cp,'execFileSync',(...args)=>{calls.push(args[1]);return original(...args);});syncBuiltinESMExports();
  try { const a=f.read(merge);assert.equal(a.cutStatus,'invalid');assert(a.diagnostics.some(d=>d.code==='unsupported_repo'));assert(!calls.some(a=>a.includes('blob'))); }
  finally { mock.restoreAll();syncBuiltinESMExports(); }
});
test('missing public evidence stays unavailable rather than reconciled', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  const f=fixture(t);f.publish();const event=f.read().events[0];
  const missing={...f.source,path:'evidence/normal-entry/public-missing.json',selector:{type:'document'}};
  f.manifest.dispositions=[{id:'missing',version:event.version,source:f.source,outcome:'CHANGE',rationale:missing,ruling:missing,consumer:missing,decision:'withhold',task:null,reason:'Release when evidence is published'}];f.publish();
  const input=f.read();assert.equal(input.dispositions[0].validation,'unavailable');
  const p=normalOpportunities(input);assert.equal(p.items[0].status,'pending');assert.equal(p.items[0].reason,'unavailable_disposition');
});

function exactDisposition(f) {
  f.publish();
  const event=f.read().events[0], path='evidence/normal-entry/public-repair.json', raw='{"claim":"repair"}\n';
  f.write(path,raw); const revision=f.commit();
  const pointer={repo:f.source.repo,revision,path,selector:{type:'document'},entryRange:[0,Buffer.byteLength(raw)],clauseRange:[0,Buffer.byteLength(raw)],blobSha256:digest(raw),clauseSha256:digest(raw)};
  const d={id:'repair',version:event.version,source:f.source,outcome:'NO_CHANGE',rationale:pointer,ruling:pointer,consumer:pointer,decision:'withhold',task:null,reason:'Await independent release review'};
  f.manifest.dispositions=[d]; f.publish();
  return d;
}

test('snapshot repair: actual next/start recover the same version after a consumer digest correction', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  const {loopProduct,ownerStore,ROOMY,isolatedEnv,selfLoop}=await import('./helpers.mjs');
  const f=fixture(t), d=exactDisposition(f);
  const root=realpathSync(mkdtempSync(join(tmpdir(),'normal-repair-product-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const p=loopProduct({dir:root});
  f.write('loop.json',readFileSync(join(p.records,'loop.json')));
  f.write('blueprint/F-0001.md','# F-0001 Feature\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n');
  f.write('purpose/P-0001.md','# Purpose\n');
  f.write('metrics/blueprint.jsonl',JSON.stringify({feature:'F-0001',phase:'v1',status:'building',time:'2026-11-22T00:00:00Z',by:'lead',note:'Work started',evidence:{}})+'\n');
  f.commit();
  const store=ownerStore([{name:'repair',records:f.records}],{bound:ROOMY});
  t.after(()=>rmSync(store,{recursive:true,force:true}));
  const env=isolatedEnv({SELF_LOOP_OWNER_STORE:store});
  t.after(()=>rmSync(env.HOME,{recursive:true,force:true}));
  const check=state=>{
    const next=selfLoop(['next','--config',join(f.records,'loop.json')],{env,cwd:p.product});
    assert.equal(next.status,0,next.stderr); assert.match(next.stdout,new RegExp(`Normal opportunities: ${state}`));
    assert.match(next.stdout,/building features without a recorded running call/);
    const start=selfLoop(['start','--json'],{env,cwd:p.product});
    assert.equal(start.status,0,start.stderr); const report=JSON.parse(start.stdout);assert.equal(report.session.error,null);
    const section=text=>text.slice(text.indexOf('Normal opportunities:'),text.indexOf('\n\n-',text.indexOf('Normal opportunities:')));
    assert.equal(section(report.session.next),section(next.stdout));
    assert.match(report.session.next,/building features without a recorded running call/);
  };
  check('accounted');
  f.manifest.dispositions=[{...d,consumer:{...d.consumer,clauseSha256:'0'.repeat(64)}}];f.publish();
  let projection=normalOpportunities(f.read());assert.equal(projection.state,'unknown');assert.equal(projection.items[0].status,'pending');
  assert.equal(projection.blockers,f.blockers);check('unknown');
  f.manifest.dispositions=[d];f.publish();projection=normalOpportunities(f.read());
  assert.equal(projection.items.length,1);assert.equal(projection.items[0].version,d.version);assert.equal(projection.items[0].reason,'exact_link');
  assert.equal(projection.state,'accounted');assert.equal(projection.blockers,f.blockers);check('accounted');
  f.write(manifestPath,'{"inventory":');f.commit();projection=normalOpportunities(f.read());
  assert.equal(projection.state,'unknown');assert.equal(projection.items[0].status,'unknown');assert.equal(projection.items[0].version,d.version);check('unknown');
  f.publish();assert.equal(normalOpportunities(f.read()).state,'accounted');check('accounted');
});

test('snapshot repair: removed unkeyed rows and repaired collections retire errors but retain occurrence counts', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  for (const bad of ['unkeyed','dispositions','inventory']) {
    const f=fixture(t),d=exactDisposition(f);
    if(bad==='unkeyed') f.manifest.inventory.push(null);
    else f.manifest[bad]={};
    f.publish();const broken=f.read();assert.equal(normalOpportunities(broken).state,'unknown');
    f.manifest.inventory=[f.row];f.manifest.dispositions=[d];f.publish();const fixed=f.read(),p=normalOpportunities(fixed);
    assert.equal(p.state,'accounted',bad);assert.equal(p.items[0].version,d.version);assert.equal(p.items[0].reason,'exact_link');
    assert.equal(fixed.accountingInput.invalidOccurrences,bad==='unkeyed'?1:0);
    assert(fixed.accountingInput.inputOccurrences>=broken.accountingInput.inputOccurrences);
    assert.equal(p.blockers,f.blockers);assert.equal(p.diagnostics.length,0);
    if(bad==='unkeyed') assert.equal(p.accounting.invalidOccurrences,1);
  }
});

test('snapshot repair: unresolved keyed invalid history and omission survive later complete snapshots', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  for(const invalid of [true,false]) {
    const f=fixture(t),d=exactDisposition(f);
    f.manifest.inventory=invalid?[f.row,{...f.row,clauseId:'unresolved',source:{...f.source,clauseSha256:'0'.repeat(64)}}]:[];
    f.publish();const first=f.read(),unresolved=first.events.at(-1).version;
    f.manifest.inventory=invalid?[f.row]:[];
    f.manifest.dispositions=[{...d,id:'new-snapshot'}];f.publish();
    const facts=f.read(),p=normalOpportunities(facts);
    assert.equal(p.state,'unknown');assert(p.items.some(e=>e.version===unresolved&&e.status==='unknown'));
    assert(facts.diagnostics.some(e=>e.code==='inventory_omission'));assert.equal(p.blockers,f.blockers);
    if(invalid) assert.equal(facts.accountingInput.invalidOccurrences,1);
  }
});

test('snapshot repair: withdrawing malformed dispositions restores pending without forgetting provenance', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  const f=fixture(t),d=exactDisposition(f);
  f.manifest.dispositions=[{...d,decision:'invalid-a'},{...d,decision:'invalid-b'}];const bad=f.publish();
  let p=normalOpportunities(f.read());assert.equal(p.state,'unknown');assert.equal(p.items[0].status,'pending');
  assert.equal(p.items[0].reason,'invalid_disposition');
  f.manifest.dispositions=[];f.publish();p=normalOpportunities(f.read());
  assert.equal(p.state,'pending');assert.equal(p.items[0].reason,'absent');assert.equal(p.items[0].version,d.version);
  assert(p.items[0].provenance.some(e=>e.revision===bad));assert.equal(p.diagnostics.length,0);
});

test('snapshot repair: a new valid successor cannot erase an invalid historical version', async t => {
  const {normalOpportunities}=await import('../lib/normal-entry.mjs');
  const f=fixture(t);f.row.source={...f.source,clauseSha256:'0'.repeat(64)};const bad=f.publish();
  const invalid=f.read().events[0];assert.equal(invalid.validation,'invalid');
  f.manifest.inventory=[{...f.row,source:f.source,predecessor:invalid.version}];f.publish();
  const facts=f.read(),p=normalOpportunities(facts);
  assert.equal(p.state,'unknown');assert.equal(p.items.length,2);
  const prior=p.items.find(e=>e.version===invalid.version),current=p.items.find(e=>e.current);
  assert.equal(prior.current,false);assert.equal(prior.status,'unknown');assert.equal(prior.reason,'bad_digest');
  assert(prior.provenance.some(e=>e.revision===bad));assert.equal(current.status,'pending');assert.equal(current.predecessor,invalid.version);
  assert(facts.diagnostics.some(e=>e.code==='bad_digest'));assert.equal(p.blockers,f.blockers);
});

const detectorRevision='32c9634ed2457e47e1e12f4a3d4e59a337a3472a';
function alarmFixture(t, origin='trajectory') {
  const f=fixture(t), path=origin==='trajectory'?'metrics/trajectory.jsonl':'metrics/alarms.jsonl';
  const data=origin==='trajectory'?{time:'2026-11-22T00:00:00Z',round:1,phase:'v1',area:'-',role:'judge',verdict:'CONTINUE',commit:f.baseline,ci:'failure'}:{type:'stall',key:'stall:v1:2026-11-21T00:00:00Z',time:'2026-11-22T00:00:00Z',phase:'v1',since:'2026-11-21T00:00:00Z'};
  const line=JSON.stringify(data), key=origin==='trajectory'?'ci-not-green:v1:1':data.key;
  f.write(path,line+'\n');const publication=f.commit();
  if(origin==='trajectory') {
    const actual=firings(parseRows(f.git('show',publication+':'+path)));
    assert.deepEqual(actual.map(a=>({key:a.key,row:a.row})),[{key,row:0}], 'fixture must publish exactly the expected canonical firing');
  }
  const entryId='alarm-'+digest(JSON.stringify([f.source.repo,'v1',origin,key,publication,digest(line)]));
  const source={repo:f.source.repo,revision:publication,path,selector:{type:'alarm',origin,key,lineSha256:digest(line),occurrence:0,detectorRevision},entryRange:[0,Buffer.byteLength(line)],clauseRange:[0,Buffer.byteLength(line)],blobSha256:digest(line+'\n'),clauseSha256:digest(line)};
  const alarm={kind:'alarm',entryId,clauseId:'alarm',path,operation:'upsert',source,predecessor:null};
  f.manifest.schema='normal-entry-manifest/v2';f.manifest.inventory=[f.row,alarm];
  return {...f,alarm,line,path,key,origin,publication};
}
async function contextRead(f, keys=[]) {
  const {buildAlarmContext}=await import('../lib/normal-entry-source.mjs');
  const revision=f.git('rev-parse','HEAD');
  let list=[];if(f.origin==='trajectory') list=firings(parseRows(f.git('show',revision+':'+f.path)));
  const alarmContext=buildAlarmContext({records:f.records,revision,phase:'v1',detectorRevision,trajectory:{validation:'valid',firings:list,undiagnosedKeys:keys},stall:{validation:'valid',currentKey:f.origin==='stall'?f.key:null}});
  return readNormalEntry({records:f.records,revision,phase:'v1',alarmContext,cadence:{due:false,stateIdentity:'a'.repeat(64)},blockers:f.blockers});
}
test('AE migration rejects v1 before importing rows and recovers identical v2 tree entry',async t=>{
  const f=alarmFixture(t);f.publish();const first=await contextRead(f,[f.key]);
  assert.equal(first.schema,'normal-entry-facts/v2');assert.equal(first.alarmStates[0].occurrenceId,f.alarm.entryId);
  assert.equal(first.alarmStates[0].diagnosis,'required');
  f.manifest.schema='normal-entry-manifest/v1';f.manifest.inventory=[{...f.row,entryId:'rejected'}];f.publish();
  const bad=f.read();assert.equal(bad.schema,'normal-entry-facts/v2');assert.equal(bad.accountingInput.inputOccurrences,first.accountingInput.inputOccurrences);
  assert(bad.events.every(e=>e.reason==='unsupported_downgrade'));assert(bad.diagnostics.some(d=>d.code==='unsupported_downgrade'&&d.provenance[0].selector==='/schema'));
  f.manifest.schema='normal-entry-manifest/v2';f.manifest.inventory=[f.row,f.alarm];f.publish();
  const fixed=await contextRead(f,[]);assert(!fixed.diagnostics.some(d=>d.code==='unsupported_downgrade'));
  assert.equal(fixed.alarmStates[0].version,first.alarmStates[0].version);assert.equal(fixed.alarmStates[0].diagnosis,'covered');
});
test('AE malformed v2 arrays do not activate or withdraw',t=>{
  const f=fixture(t);const d=exactDisposition(f);const before=f.read();
  f.manifest.schema='normal-entry-manifest/v2';f.manifest.dispositions={};f.publish();
  const bad=f.read();assert.equal(bad.schema,'normal-entry-facts/v1');assert(!Object.hasOwn(bad,'alarmStates'));assert.equal(bad.accountingInput.inputOccurrences,before.accountingInput.inputOccurrences);assert.equal(bad.dispositions[0].version,d.version);
  f.manifest.schema='normal-entry-manifest/v1';f.manifest.dispositions=[d];f.publish();assert.equal(f.read().events[0].validation,'valid');
});
test('AE invalid keyed alarm has null identity and cannot borrow predecessor proof',t=>{
  const f=alarmFixture(t);f.manifest.inventory=[{...f.alarm,entryId:'bad',source:null}];f.publish();const got=f.read();
  assert.equal(got.alarmStates.length,1);assert.equal(got.alarmStates[0].occurrenceId,null);assert.equal(got.alarmStates[0].identityBasis,'unverified');assert.equal(got.alarmStates[0].reason,'bad_pointer');
});
test('AE duplicate trajectory is ambiguous; removing duplicate begins new publication episode',async t=>{
  const f=alarmFixture(t);f.publish();const first=await contextRead(f,[f.key]);
  f.write(f.path,f.line+'\n'+f.line+'\n');const dup=f.commit();
  let got=await contextRead(f,[f.key]);assert.equal(got.alarmStates[0].reason,'stale_inventory');assert.equal(got.alarmStates[0].occurrenceId,f.alarm.entryId);
  const previous=first.events.find(e=>JSON.parse(e.logicalKey)[1]==='alarm');
  f.alarm={...f.alarm,predecessor:previous.version,source:{...f.alarm.source,revision:dup,blobSha256:digest(f.line+'\n'+f.line+'\n')}};f.manifest.inventory=[f.alarm];f.publish();
  got=f.read();assert(got.alarmStates.some(s=>s.reason==='alarm_identity_ambiguous'&&s.occurrenceId===null));
  f.write(f.path,f.line+'\n');const restored=f.commit();
  const entryId='alarm-'+digest(JSON.stringify([f.source.repo,'v1','trajectory',f.key,restored,digest(f.line)]));
  assert.notEqual(entryId,f.alarm.entryId);
  f.manifest.inventory.push({...f.alarm,entryId,predecessor:null,source:{...f.alarm.source,revision:restored,blobSha256:digest(f.line+'\n')}});f.publish();
  got=await contextRead(f,[f.key]);assert(got.alarmStates.some(s=>s.occurrenceId===entryId&&s.applicability==='active'));
});
test('AE stall duplicate bytes preserve occurrence but conflicts break the episode',async t=>{
  const f=alarmFixture(t,'stall');f.publish();let got=await contextRead(f);const prior=got.events.find(e=>JSON.parse(e.logicalKey)[1]==='alarm');
  f.write(f.path,f.line+'\n'+f.line+'\n');const revision=f.commit();
  f.alarm={...f.alarm,predecessor:prior.version,source:{...f.alarm.source,revision,blobSha256:digest(f.line+'\n'+f.line+'\n')}};f.manifest.inventory=[f.alarm];f.publish();
  got=await contextRead(f);assert(got.alarmStates.every(s=>s.occurrenceId===f.alarm.entryId));assert.equal(got.alarmStates.find(s=>s.version!==prior.version).applicability,'active');
  const conflict=JSON.stringify({...JSON.parse(f.line),time:'2026-11-23T00:00:00Z'});f.write(f.path,f.line+'\n'+conflict+'\n');const c=f.commit();
  const matches=got.events.filter(e=>e.current&&e.logicalKey===prior.logicalKey);
  assert.equal(matches.length,1);const [current]=matches;
  assert.equal(current.validation,'valid');assert.notEqual(current.version,prior.version);
  assert.equal(got.alarmStates.find(s=>s.version===current.version).occurrenceId,f.alarm.entryId);
  f.manifest.inventory=[{...f.alarm,predecessor:current.version,source:{...f.alarm.source,revision:c,blobSha256:digest(f.line+'\n'+conflict+'\n')}}];f.publish();
  assert(f.read().alarmStates.some(s=>s.occurrenceId===null&&s.reason==='alarm_identity_ambiguous'));
});
test('AE tombstone remains bound after physical removal without context',t=>{
  const f=alarmFixture(t);f.publish();const first=f.read(),e=first.events.find(e=>JSON.parse(e.logicalKey)[1]==='alarm');
  rmSync(join(f.records,f.path));f.commit();f.manifest.inventory=[{...f.alarm,operation:'delete',source:null,predecessor:e.version}];f.publish();
  const got=f.read(),s=got.alarmStates.find(s=>s.version!==e.version);
  assert.equal(s.identityBasis,'predecessor');assert.equal(s.occurrenceId,f.alarm.entryId);assert.equal(s.applicability,'inactive');assert.equal(s.diagnosis,'not_applicable');
});
test('AE unsupported evaluator is refused before any alarm blob read',t=>{
  const f=alarmFixture(t);f.alarm.source.selector.detectorRevision='a'.repeat(40);f.publish();
  const original=cp.execFileSync,calls=[];mock.method(cp,'execFileSync',(...args)=>{calls.push(args[1]);return original(...args);});syncBuiltinESMExports();
  try {const got=f.read();assert.equal(got.alarmStates[0].occurrenceId,null);assert.equal(got.alarmStates[0].reason,'unsupported_detector');}
  finally {mock.restoreAll();syncBuiltinESMExports();}
});
