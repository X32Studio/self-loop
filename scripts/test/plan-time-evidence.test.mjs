// F-0012
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { canonical, parseExactJSON, selectFragment, versionOnly, evaluateTimeEvidence } from '../lib/plan-time-evidence.mjs';
import { snapshot } from '../lib/plan.mjs';
import { loadForecastHistory, projectPlanTime } from '../lib/plan-time.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');

test('exact JSON rejects duplicate decoded keys, nonfinite numbers and invalid Unicode', () => {
  for (const bytes of ['{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}', '1e400', '"\\ud800"', '[1,]', '{"x":1} trailing', Buffer.from([0x22, 0xff, 0x22])]) assert.throws(() => parseExactJSON(bytes));
  assert.equal(canonical(parseExactJSON('{"z":-0,"a":[1e-7,1e+30,"😀"]}')), '{"a":[1e-7,1e+30,"😀"],"z":0}');
  assert.equal(canonical(parseExactJSON('{"__proto__":{"safe":true}}')), '{"__proto__":{"safe":true}}');
});

test('selectors resolve exact pointers and unique headings without fenced decoys', () => {
  assert.equal(selectFragment('{"a/b":{"~x":["ok"]}}', '/a~1b/~0x/0'), 'ok');
  assert.throws(() => selectFragment('{"x":[1]}', '/x/00'));
  assert.throws(() => selectFragment('{"x":1}', '/missing'));
  assert.throws(() => selectFragment('{"x":1}', '/~2x'));
  assert.throws(() => selectFragment('# Scope\na\n# Scope\nb', '# Scope'));
  assert.equal(selectFragment('# Scope\na\n## Nested\nb\n# Next\nc', '# Scope'), 'a\n## Nested\nb');
  assert.equal(selectFragment('```\n# Scope\ndecoy\n```\n# Scope\nreal', '# Scope'), 'real');
});

function fixture(t) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-evidence-synthetic-')));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init'); git('config', 'user.email', 'synthetic@example.invalid'); git('config', 'user.name', 'Synthetic archive recorder');
  const put = (path, bytes) => { mkdirSync(dirname(join(repo,path)), { recursive: true }); writeFileSync(join(repo,path),bytes); };
  const commit = () => { git('add','.'); git('commit','-qm','synthetic archival cut'); return git('rev-parse','HEAD'); };
  put('docs/baseline.md', 'synthetic'); put('owner/answers.jsonl', ''); commit();
  return { repo, git, put, commit };
}

test('query ignores working-tree evidence and never falls back to HEAD or injected trust', t => {
  const f = fixture(t), q = f.git('rev-parse','HEAD');
  const b = JSON.stringify({ schema:'plan-time-binding/v1', type:'release', rootRef:{path:'plans/PL-0001.md'}, claim:{} });
  f.put(`evidence/0012/time-binding/TB-${hash(b)}.json`, b); f.commit();
  const result = evaluateTimeEvidence({ stateAtQ:{records:f.repo,revision:q}, plan:{time:{rootPlan:'PL-0001'}}, bindings:[{trusted:true}] });
  assert.equal(result.releases.length,0); assert.deepEqual(result.findings,[]);
  assert.match(evaluateTimeEvidence({stateAtQ:{records:f.repo,revision:'HEAD'}}).findings.join(' '), /pinned/);
});

test('full reachable history retains deletion and altered bytes', t => {
  const f = fixture(t);
  const b = JSON.stringify({ schema:'plan-time-binding/v1',type:'release',rootRef:{path:'plans/PL-0001.md'},claim:{} });
  const path = `evidence/0012/time-binding/TB-${hash(b)}.json`;
  f.put(path,b); const before = f.commit();
  f.put(path,b+' '); f.commit(); f.git('rm',path); const q=f.commit();
  const result=evaluateTimeEvidence({stateAtQ:{records:f.repo,revision:q},plan:{time:{rootPlan:'PL-0001'}}});
  assert.match(result.findings.join('\n'),/modified binding/); assert.match(result.findings.join('\n'),/deleted binding/);
  assert.equal(result.releases[0].availableAt,null);
  const old=evaluateTimeEvidence({stateAtQ:{records:f.repo,revision:before},plan:{time:{rootPlan:'PL-0001'}}});
  assert.doesNotMatch(old.findings.join('\n'),/modified|deleted/);
});

test('replacement objects cannot add evidence to pinned query', t => {
  const f=fixture(t), q=f.git('rev-parse','HEAD');
  const b=JSON.stringify({schema:'plan-time-binding/v1',type:'release',rootRef:{path:'plans/PL-0001.md'},claim:{}});
  f.put(`evidence/0012/time-binding/TB-${hash(b)}.json`,b); const replacement=f.commit();
  f.git('replace',q,replacement);
  const result=evaluateTimeEvidence({stateAtQ:{records:f.repo,revision:q},plan:{time:{rootPlan:'PL-0001'}}});
  assert.deepEqual(result.releases,[]); assert.deepEqual(result.findings,[]);
});

 test('VERSION receipt equivalence uses original single-parent ancestry and final exact VERSION diff', t => {
  const f=fixture(t);f.put('VERSION','1\n'); const base=f.commit();
  f.put('VERSION','2\n'); const tip=f.commit();
  assert.equal(versionOnly(f.repo,base,tip),true);
  assert.equal(versionOnly(f.repo,tip,base),false);
  f.put('docs/change.md','code changed');const changed=f.commit();
  assert.equal(versionOnly(f.repo,base,changed),false);
  f.git('rm','docs/change.md');const restored=f.commit();
  assert.equal(versionOnly(f.repo,base,restored),true);
  f.put('VERSION','1\n');const sameTree=f.commit();
  assert.equal(versionOnly(f.repo,base,sameTree),false);
});

function scopeFixture(t, change = () => {}, sourceRole = null) {
  const f=fixture(t);
  const criterion='docs/criteria.md', optional='decisions/D-0001.md';
  f.put(criterion,'# Minimum\nReport works.\n');
  f.put(optional,'# Optional\nby: owner\npolish optional\n');
  f.put('loop.json',JSON.stringify({gates:{require:[]}}));
  const authority=f.commit();
  const exactRef=(path,commit)=>({repository:f.repo,commit,path,sha256:hash(execFileSync('git',['-C',f.repo,'show',`${commit}:${path}`]))});
  const criteriaRef=exactRef(criterion,authority), optionalRef=exactRef(optional,authority), policyRef=exactRef('loop.json',authority);
  const plan={id:'PL-0001',scope:'synthetic',phase:'test',packages:[{id:'core',needs:[]},{id:'restart',needs:['core']},{id:'polish',needs:[]}],time:{schema:'plan-time/v2',rootPlan:'PL-0001',baseline:{minimum:{criteriaRefs:[criteriaRef]},promises:[]}}};
  plan.packages=plan.packages.map((p,i)=>({...p,goal:'synthetic goal',interface:'synthetic contract',acceptance:'synthetic criterion',handoff:`R-${String(i+1).padStart(4,'0')}-actor`,role:'actor',authority:['D-0001'],files:[`src/${p.id}.mjs`]}));
  plan.packages.push(
    {id:'cr',needs:['core','restart','polish'],reviews:['core','restart','polish'],goal:'synthetic goal',interface:'synthetic contract',acceptance:'synthetic criterion',handoff:'R-0001-critic-cr',role:'critic',authority:['D-0001'],files:['test/cr.test.mjs']},
    {id:'j',needs:['cr'],goal:'synthetic goal',interface:'synthetic contract',acceptance:'synthetic criterion',handoff:'R-0001-judge',role:'judge',authority:['D-0001'],files:[]},
  );
  f.put('plans/PL-0001.md',JSON.stringify(plan));const basedOn=f.commit(),planRef=exactRef('plans/PL-0001.md',basedOn);
  const claim={criteria:[{ref:criteriaRef,selector:'# Minimum',purpose:'minimum',promiseId:null,packages:['restart']}],releasePackages:['restart'],deferred:[{package:'polish',authorityRef:optionalRef,selector:'# Optional',reason:'preauthorized optional'}],gatePolicyRefs:[policyRef]};
  change(claim);
  const b={schema:'plan-time-binding/v1',type:'scope',rootRef:planRef,planRef,basedOn,claim,supersedes:[]};
  if(sourceRole){
    const native=sourceRole.startsWith('native-'),role=native?sourceRole.slice(7):sourceRole;
    f.put('evidence/0012/source.json',JSON.stringify({author:'synthetic-independent',role,requestId:'synthetic-request',claim}));
    if(native){
      const record=`rounds/0012-${role}.md`;f.put(record,'Synthetic public native report.');
      const h={id:`R-0012-${role}`,round:12,role,step:role,phase:'test',attempt:1,agent:{runner:'synthetic'},product:null,audit:{violations:0},view:basedOn,task:'a'.repeat(64),record,files:['evidence/0012/source.json',record]};
      f.put('metrics/handoffs.jsonl',JSON.stringify(h)+'\n');
    }
    const sourceCut=f.commit();
    b.sourceRef=exactRef('evidence/0012/source.json',sourceCut);b.authorizationRef=optionalRef;
    b.provenanceRefs=[exactRef(native?'metrics/handoffs.jsonl':'evidence/0012/source.json',sourceCut)];
  }
  const bytes=JSON.stringify(b);f.put(`evidence/0012/time-binding/TB-${hash(bytes)}.json`,bytes);const q=f.commit();
  return evaluateTimeEvidence({stateAtQ:{records:f.repo,revision:q},plan});
}

test('scope validates dependency closure independently of missing source authentication', t => {
  const valid=scopeFixture(t);
  assert.doesNotMatch(valid.findings.join('\n'),/criterion|deferral|dependency|optional/);
  const invalid=scopeFixture(t,c=>{c.releasePackages=['core'];c.deferred=[{...c.deferred[0],package:'restart'}];});
  assert.match(invalid.findings.join('\n'),/required criterion not covered/);
  assert.equal(invalid.releaseEvidence.length,0);
});

test('optional scope authority uses whole package token and exact selected fragment', t => {
  const result=scopeFixture(t,c=>{c.deferred[0].package='core';c.criteria[0].packages=['polish'];c.releasePackages=['polish'];});
  assert.match(result.findings.join('\n'),/optional package authority absent/);
  const ambiguous=scopeFixture(t,c=>{c.criteria[0].selector='# Missing';});
  assert.match(ambiguous.findings.join('\n'),/missing or ambiguous heading/);
});

test('source roles and exact claim correspondence do not become authorization by themselves', t => {
  const actor=scopeFixture(t,()=>{},'actor');
  assert.match(actor.findings.join('\n'),/missing exact selector|independent source identity missing/);
  const reviewer=scopeFixture(t,()=>{},'reviewer');
  assert.match(reviewer.findings.join('\n'),/missing exact selector/);
  assert.deepEqual(reviewer.releaseEvidence,[]);
});

test('native correspondence reads public handoff identity without sealed acceptance', t => {
  const judge=scopeFixture(t,()=>{},'native-judge');
  assert.match(judge.findings.join('\n'),/missing exact selector/);
  const actor=scopeFixture(t,()=>{},'native-actor');
  assert.match(actor.findings.join('\n'),/missing exact selector|invalid native assignment/);
});

function positiveEvidence(t, { mode='external', at='2026-11-22T11:50:00Z', event=true, mutate=()=>{}, regression=false, conflict=false, forecast=null, patchPlan=()=>{}, patchScope=()=>{} }={}) {
  const f=fixture(t), product=fixture(t);
  product.put('artifact.txt','usable artifact');const sha=product.commit(),tree=product.git('rev-parse',`${sha}^{tree}`);
  const ref=(path,commit=f.git('rev-parse','HEAD'))=>({repository:f.repo,commit,path,sha256:hash(execFileSync('git',['-C',f.repo,'show',`${commit}:${path}`]))});
  const authTokens=[];
  for(const type of ['scope','release','event'])for(let i=0;i<4;i++)authTokens.push(`observer judge req-${type}-${i} R-${String(12+i).padStart(4,'0')}-judge-${type} ${hash(`task-${type}-${i}`)} ${type==='scope'?'scope-assess':type==='release'?'release-assess':'event-attest'}`);
  f.put('decisions/D-0001.md','# Authorization\nby: owner\n'+authTokens.join('\n')+'\n# Optional\npolish optional\n');
  f.put('docs/criteria.md','# Minimum\nA usable report\n');f.put('evidence/0012/artifact.txt','usable artifact');
  f.put('loop.json',JSON.stringify({gates:{require:['actions/linux'],suite:'node --test synthetic.mjs'}}));
  const log='# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n';
  f.put('evidence/0012/suite.log',log);
  f.put('evidence/0012/suite.json',JSON.stringify({repository:product.repo,sha,tree,command:'node --test synthetic.mjs',green:true,exit:0,summary:{tests:2,fail:0,cancelled:0},log:{sha256:hash(log),bytes:Buffer.byteLength(log)}}));
  f.put('evidence/0012/ci.json',JSON.stringify({host:'github.com',repository:'synthetic/product',sha,ci:'success',ok:true,missing:[],conclusions:{'actions/linux':'success'}}));
  const initial=f.commit(),authority=ref('decisions/D-0001.md',initial),criterion=ref('docs/criteria.md',initial),policy=ref('loop.json',initial),artifact=ref('evidence/0012/artifact.txt',initial);
  const plan={id:'PL-0001',scope:'synthetic',phase:'test',packages:[{id:'core',needs:[],goal:'usable',interface:'report',acceptance:'works',handoff:'R-0001-actor',role:'actor',authority:['D-0001'],files:['src/core.mjs']}],time:{schema:'plan-time/v2',rootPlan:'PL-0001',baseline:{minimum:{outcome:'usable report',criteriaRefs:[criterion]},promises:[]}}};
  if(forecast) Object.assign(plan.time.baseline,{previousRoot:null,startedAt:'2026-11-22T09:00:00Z',startRefs:[authority],deadline:{at:'2026-11-22T14:00:00Z',authorityRefs:[authority]},minimum:{...plan.time.baseline.minimum,authorityRefs:[authority]}});
  if(forecast) plan.packages.push(...['restart','polish'].map(id=>({...plan.packages[0],id,needs:id==='restart'?['core']:[],handoff:`R-0002-actor-${id}`,files:[`src/${id}.mjs`]})));
  const actorIds=plan.packages.map(p=>p.id);
  plan.packages.push(
    {id:'cr',needs:actorIds,reviews:actorIds,goal:'usable',interface:'report',acceptance:'works',handoff:'R-0001-critic-cr',role:'critic',authority:['D-0001'],files:['test/cr.test.mjs']},
    {id:'j',needs:['cr'],goal:'usable',interface:'report',acceptance:'works',handoff:'R-0001-judge',role:'judge',authority:['D-0001'],files:[]},
  );
  patchPlan(plan);
  f.put('plans/PL-0001.md',JSON.stringify(plan));const basedOn=f.commit(),planRef=ref('plans/PL-0001.md',basedOn),counts={scope:0,release:0,event:0};
  function bind(type,claim,supersedes=[]) {
    const i=counts[type]++,dir=`evidence/0012/archive-${type}-${i}`;
    const b={schema:'plan-time-binding/v1',type,rootRef:planRef,planRef,basedOn,claim,authorizationRef:authority,authorizationSelector:'# Authorization',supersedes};
    const digest=hash(canonical({type,rootRef:planRef,planRef,basedOn,claim}));
    const source={author:'observer',role:'judge',requestId:`req-${type}-${i}`,endorsesClaim:digest};
    f.put(`${dir}/source.json`,JSON.stringify(source));
    let ledger;
    if(mode==='native') {
      const record=`rounds/${String(12+i).padStart(4,'0')}-judge-${type}.md`;f.put(record,`Synthetic public report endorses ${digest}`);
      const h={id:`R-${String(12+i).padStart(4,'0')}-judge-${type}`,round:12+i,role:'judge',step:`judge-${type}`,phase:'test',attempt:1,agent:{runner:'synthetic'},product:null,audit:{violations:0},view:basedOn,task:hash(`task-${type}-${i}`),record,files:[`${dir}/source.json`,record]};
      ledger=(ledgerRows.push(h),ledgerRows.map(x=>JSON.stringify(x)).join('\n')+'\n');f.put('metrics/handoffs.jsonl',ledger);
    } else {
      const platform=JSON.stringify({taskId:source.requestId,childThreadId:source.author,childRunId:`run-${type}-${i}`,latestTerminalRunId:`run-${type}-${i}`,status:'completed',latestTerminalStatus:'completed',hasPendingChildRuns:false});
      f.put(`${dir}/platform.json`,platform);f.put(`${dir}/archive-hashes.json`,JSON.stringify({'source.json':hash(JSON.stringify(source)),'platform.json':hash(platform)}));
    }
    const sourceCut=f.commit();b.sourceRef=ref(`${dir}/source.json`,sourceCut);b.provenanceRefs=mode==='native'?[ref('metrics/handoffs.jsonl',sourceCut)]:[ref(`${dir}/platform.json`,sourceCut),ref(`${dir}/archive-hashes.json`,sourceCut)];
    mutate(type,b,f);const bytes=JSON.stringify(b),path=`evidence/0012/time-binding/TB-${hash(bytes)}.json`;f.put(path,bytes);const q=f.commit();return ref(path,q);
  }
  const ledgerRows=[];
  const sc={criteria:[{ref:criterion,selector:'# Minimum',purpose:'minimum',promiseId:null,packages:['core']}],releasePackages:['core'],deferred:[],gatePolicyRefs:[policy]};
  let forecastPath;
  if(forecast) {
    sc.criteria[0].packages=['restart'];sc.releasePackages=['restart'];
    sc.deferred=[{package:'polish',authorityRef:authority,selector:'# Optional',reason:'optional'}];
    if(forecast.approved) sc.releasePackages=forecast.approved;
    const asOf='2026-11-22T10:00:00Z';
    const estimate=(lowSeconds,highSeconds)=>({asOf,remaining:{lowSeconds,highSeconds},availableAfter:{lowSeconds:0,highSeconds:0},basisRefs:[authority],assumptions:[],unknowns:[]});
    const o={schema:'plan-forecast/v1',rootRef:planRef,planRef,parents:[],promisesAdded:[],outlook:{asOf,basedOn:forecast.wrongCut?initial:basedOn,observation:{observedAt:asOf,recordedAt:asOf,evidenceRefs:[authority]},inputs:[authority],releasePackages:forecast.packages,reserve:{remaining:{lowSeconds:0,highSeconds:0},covers:[],basisRefs:[authority],assumptions:[]},checkpointAt:'2026-11-22T14:00:00Z',change:{reason:'synthetic forecast',authorityRefs:[authority],deferredPackages:forecast.deferred??[]},outcome:{state:'active',evidenceRefs:[],deliveredAt:null}},estimates:{core:estimate(1800,2400),restart:estimate(1800,2400),polish:estimate(60,120)}};
    const bytes=JSON.stringify(o);forecastPath=`forecasts/FO-${hash(bytes)}.json`;f.put(forecastPath,bytes);f.commit();
  }
  patchScope(sc);
  const scope=bind('scope',sc);
  const rc={scopeRef:scope,candidate:{repository:product.repo,sha,tree,destination:{host:'github.com',repository:'synthetic/product'}},recipient:'owner',channel:'public',gateRefs:[{kind:'ci',ref:ref('evidence/0012/ci.json',initial)},{kind:'suite',ref:ref('evidence/0012/suite.json',initial)}],criteriaResults:[{criterion:{ref:criterion,selector:'# Minimum'},evidenceRefs:[artifact],availability:{artifactSha256:artifact.sha256,recipient:'owner',channel:'public',usable:true},result:'pass'}]};
  const release=bind('release',rc);
  if(event)bind('event',{event:'release-available',subjectRef:release,at,basisRefs:[release]});
  const beforeRegression=f.git('rev-parse','HEAD');
  if(regression===true)bind('release',{...rc,criteriaResults:rc.criteriaResults.map(x=>({...x,result:'fail',availability:{...x.availability,usable:false}}))},[release]);
  if(typeof regression==='string') {
    const [kind,status]=regression.split('-');
    const receipt=JSON.parse(f.git('show',`${initial}:evidence/0012/${kind}.json`));
    if(kind==='ci'){receipt.ok=false;receipt.ci='failure';receipt.conclusions['actions/linux']='failure';}
    else {receipt.green=false;receipt.exit=1;receipt.summary.fail=1;const log='# tests 2\n# pass 1\n# fail 1\n# cancelled 0\n';f.put('evidence/0012/later-suite.log',log);receipt.log={sha256:hash(log),bytes:Buffer.byteLength(log)};}
    if(status==='unknown'){if(kind==='ci')delete receipt.conclusions;else delete receipt.summary;}
    if(status==='mismatch')receipt.sha='e'.repeat(40);
    const path=`evidence/0012/later-${kind}.json`;f.put(path,JSON.stringify(receipt));const cut=f.commit();
    bind('release',{...rc,gateRefs:rc.gateRefs.map(g=>g.kind===kind?{kind,ref:ref(path,cut)}:g)},[release]);
  }
  if(conflict)bind('event',{event:'release-available',subjectRef:release,at:'2026-11-22T12:10:00Z',basisRefs:[release]});
  const args={stateAtQ:{records:f.repo,revision:f.git('rev-parse','HEAD')},plan,now:'2026-11-22T13:00:00Z',clockMode:'simulation'};
  return {f,args,release,beforeRegression,forecastPath,result:evaluateTimeEvidence(args)};
}

for(const mode of ['native','external'])test(`${mode} independently authorized exact archive establishes real positive release operands`,t=>{
  const {result}=positiveEvidence(t,{mode});
  assert.equal(result.releaseEvidence.length,1,result.findings.join('\n'));
  assert.equal(result.releases[0].verification,'verified',result.findings.join('\n'));
  assert.equal(result.releases[0].availableAt,'2026-11-22T11:50:00Z',result.findings.join('\n'));
});

test('late and untimed positive releases retain distinct occurrence evidence',t=>{
  const late=positiveEvidence(t,{at:'2026-11-22T12:10:00Z'}).result;
  assert.equal(late.releases[0].availableAt,'2026-11-22T12:10:00Z',late.findings.join('\n'));
  const unknown=positiveEvidence(t,{event:false}).result;
  assert.equal(unknown.releaseEvidence.length,1,unknown.findings.join('\n'));assert.equal(unknown.releases[0].availableAt,null);
});

test('valid but conflicting event assertions cannot choose a convenient delivery time',t=>{
  const {result}=positiveEvidence(t,{conflict:true});
  assert.equal(result.releases[0].availableAt,null);assert.match(result.findings.join('\n'),/evidence-conflict/);
});

test('missing authorization and mismatched external archive never inherit positive status',t=>{
  for(const defect of ['selector','archive']) {
    const {result}=positiveEvidence(t,{mutate:(type,b)=>{if(type==='release'){if(defect==='selector')b.authorizationSelector='# Absent';else b.provenanceRefs=b.provenanceRefs.slice(0,1);}}});
    assert.equal(result.releaseEvidence.length,0);assert.equal(result.releases[0].availableAt,null);
  }
});

test('current unavailable assessment preserves historical delivery without inferring failure time',t=>{
  const {result,args,beforeRegression}=positiveEvidence(t,{regression:true});
  const original=result.releases.find(r=>r.availableAt==='2026-11-22T11:50:00Z');
  assert.ok(original,result.findings.join('\n'));assert.equal(original.currentAvailability,'unavailable');
  const prior=evaluateTimeEvidence({...args,stateAtQ:{...args.stateAtQ,revision:beforeRegression}});
  assert.equal(prior.releases[0].currentAvailability,'verified');
});

test('native listed source endorsement cannot substitute an unendorsed public report',t=>{
  const {result}=positiveEvidence(t,{mode:'native',mutate:(type,b,f)=>{
    if(type!=='scope')return;
    const rows=JSON.parse(f.git('show',`${b.provenanceRefs[0].commit}:metrics/handoffs.jsonl`));
    f.put(rows.record,'Unrelated public report');const cut=f.commit();
    b.provenanceRefs=b.provenanceRefs.map(ref=>({...ref,commit:cut}));
  }});
  assert.deepEqual(result.releaseEvidence,[]);assert.match(result.findings.join('\n'),/native public report does not endorse claim/);
});

for(const kind of ['ci','suite'])test(`${kind} later gate regression preserves historical positive and separates unknown/mismatch`,t=>{
  for(const status of ['red','unknown','mismatch']){
    const {result}=positiveEvidence(t,{regression:`${kind}-${status}`});
    const original=result.releases.find(r=>r.availableAt==='2026-11-22T11:50:00Z');
    assert.ok(original,`${kind}/${status}: ${result.findings.join('\n')}`);
    assert.equal(original.currentAvailability,status==='red'?'unavailable':'unverified');
  }
});

for (const scenario of [
  {name:'matching closure',packages:['restart'],verified:true},
  {name:'explicit dependency in reverse order',packages:['restart','core'],verified:true},
  {name:'explicit dependency in forward order',packages:['core','restart'],verified:true},
  {name:'authorized optional omission',packages:['restart'],deferred:['polish'],verified:true},
  {name:'smaller required closure',packages:['core'],problem:/omits approved release closure package: restart/},
  {name:'different closure',packages:['polish'],problem:/omits approved release closure/},
  {name:'larger unapproved closure',packages:['restart','polish'],problem:/includes unapproved release closure/},
  {name:'required deferral',packages:['core'],deferred:['restart'],problem:/defers release closure package/},
  {name:'unknown deferral',packages:['restart'],deferred:['foreign'],problem:/deferral lacks scope authorization/},
  {name:'wrong cut',packages:['restart'],wrongCut:true,problem:/scope evidence unavailable/},
]) test(`forecast Scope correspondence: ${scenario.name}`,t=>{
  const {f,args,result,forecastPath}=positiveEvidence(t,{forecast:scenario});
  const scope=result.scopeByObservation[forecastPath];
  assert.equal(scope.verification,scenario.verified?'verified':'unverified',JSON.stringify(scope));
  if(scenario.problem)assert.match(scope.findings.join('\n'),scenario.problem);
  assert.equal(result.releases[0].verification,'verified');
  assert.equal(result.releases[0].availableAt,'2026-11-22T11:50:00Z');
  const state=snapshot(f.repo,args.stateAtQ.revision),history=loadForecastHistory(f.repo,state.revision,args.plan.id);
  if(!scenario.wrongCut)assert.deepEqual(history.errors,[]);
  const view=projectPlanTime(state,args.plan,{now:args.now,clockMode:'simulation',forecastHistory:history});
  assert.equal(view.forecast.releaseEta.evidenceStatus,scenario.verified?'verified':'unverified');
  assert.equal(view.forecast.releaseEta.latestAt,scenario.verified?'2026-11-22T11:20:00.000Z':null);
  if(scenario.name==='smaller required closure')assert.equal(view.forecast.latestAt,'2026-11-22T10:40:00.000Z');
  assert.equal(view.progress.releaseEvidence.length,1);
});

test('AC-26: CodeCommit plan-time CI evidence accepts matching host/repository/account and refuses host, repository, or account drift', t => {
  function codecommitEvidence({
    candidateDest = { host: 'git-codecommit.us-east-1.amazonaws.com', repository: 'MyRepo', account: '123456789012' },
    ciPatch = {},
  } = {}) {
    const f = fixture(t), product = fixture(t);
    product.put('artifact.txt', 'usable artifact');
    const sha = product.commit(), tree = product.git('rev-parse', `${sha}^{tree}`);
    const ref = (path, commit = f.git('rev-parse', 'HEAD')) => ({ repository: f.repo, commit, path, sha256: hash(execFileSync('git', ['-C', f.repo, 'show', `${commit}:${path}`])) });
    const authTokens = [];
    for (const type of ['scope', 'release', 'event']) authTokens.push(`observer judge req-${type}-0 ${type === 'scope' ? 'scope-assess' : type === 'release' ? 'release-assess' : 'event-attest'}`);
    f.put('decisions/D-0001.md', '# Authorization\nby: owner\n' + authTokens.join('\n') + '\n');
    f.put('docs/criteria.md', '# Minimum\nA usable report\n');
    f.put('evidence/0012/artifact.txt', 'usable artifact');
    f.put('loop.json', JSON.stringify({ gates: { require: ['codebuild/verify'], suite: 'node --test synthetic.mjs' } }));
    const log = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n';
    f.put('evidence/0012/suite.log', log);
    f.put('evidence/0012/suite.json', JSON.stringify({ repository: product.repo, sha, tree, command: 'node --test synthetic.mjs', green: true, exit: 0, summary: { tests: 2, fail: 0, cancelled: 0 }, log: { sha256: hash(log), bytes: Buffer.byteLength(log) } }));
    const liveReceipt = {
      forge: 'codecommit',
      host: 'git-codecommit.us-east-1.amazonaws.com',
      region: 'us-east-1',
      account: '123456789012',
      repository: 'MyRepo',
      sha,
      ci: 'success',
      ok: true,
      missing: [],
      conclusions: { 'codebuild/verify': 'success' },
      runs: { 'codebuild/verify': { id: 7, build_id: 'verify:00000000-0000-0000-0000-000000000007', status: 'completed', conclusion: 'success', started_at: '2026-11-22T11:00:00.000Z' } },
      source: 'live',
      ...ciPatch,
    };
    f.put('evidence/0012/ci.json', JSON.stringify(liveReceipt));
    const initial = f.commit(), authority = ref('decisions/D-0001.md', initial), criterion = ref('docs/criteria.md', initial), policy = ref('loop.json', initial), artifact = ref('evidence/0012/artifact.txt', initial);
    const plan = {
      id: 'PL-0001',
      scope: 'synthetic',
      phase: 'test',
      packages: [
        { id: 'core', needs: [], goal: 'usable', interface: 'report', acceptance: 'works', handoff: 'R-0001-actor', role: 'actor', authority: ['D-0001'], files: ['src/core.mjs'] },
        { id: 'cr', needs: ['core'], reviews: ['core'], goal: 'usable', interface: 'report', acceptance: 'works', handoff: 'R-0001-critic-cr', role: 'critic', authority: ['D-0001'], files: ['test/cr.test.mjs'] },
        { id: 'j', needs: ['cr'], goal: 'usable', interface: 'report', acceptance: 'works', handoff: 'R-0001-judge', role: 'judge', authority: ['D-0001'], files: [] },
      ],
      time: { schema: 'plan-time/v2', rootPlan: 'PL-0001', baseline: { minimum: { outcome: 'usable report', criteriaRefs: [criterion] }, promises: [] } },
    };
    f.put('plans/PL-0001.md', JSON.stringify(plan));
    const basedOn = f.commit(), planRef = ref('plans/PL-0001.md', basedOn);
    function bind(type, claim) {
      const dir = `evidence/0012/archive-${type}-0`;
      const b = { schema: 'plan-time-binding/v1', type, rootRef: planRef, planRef, basedOn, claim, authorizationRef: authority, authorizationSelector: '# Authorization', supersedes: [] };
      const digest = hash(canonical({ type, rootRef: planRef, planRef, basedOn, claim }));
      const source = { author: 'observer', role: 'judge', requestId: `req-${type}-0`, endorsesClaim: digest };
      const platform = JSON.stringify({ taskId: source.requestId, childThreadId: source.author, childRunId: `run-${type}-0`, latestTerminalRunId: `run-${type}-0`, status: 'completed', latestTerminalStatus: 'completed', hasPendingChildRuns: false });
      f.put(`${dir}/source.json`, JSON.stringify(source));
      f.put(`${dir}/platform.json`, platform);
      f.put(`${dir}/archive-hashes.json`, JSON.stringify({ 'source.json': hash(JSON.stringify(source)), 'platform.json': hash(platform) }));
      const sourceCut = f.commit();
      b.sourceRef = ref(`${dir}/source.json`, sourceCut);
      b.provenanceRefs = [ref(`${dir}/platform.json`, sourceCut), ref(`${dir}/archive-hashes.json`, sourceCut)];
      const bytes = JSON.stringify(b), path = `evidence/0012/time-binding/TB-${hash(bytes)}.json`;
      f.put(path, bytes);
      return ref(path, f.commit());
    }
    const scope = bind('scope', { criteria: [{ ref: criterion, selector: '# Minimum', purpose: 'minimum', promiseId: null, packages: ['core'] }], releasePackages: ['core'], deferred: [], gatePolicyRefs: [policy] });
    const release = bind('release', {
      scopeRef: scope,
      candidate: { repository: product.repo, sha, tree, destination: candidateDest },
      recipient: 'owner',
      channel: 'public',
      gateRefs: [{ kind: 'ci', ref: ref('evidence/0012/ci.json', initial) }, { kind: 'suite', ref: ref('evidence/0012/suite.json', initial) }],
      criteriaResults: [{ criterion: { ref: criterion, selector: '# Minimum' }, evidenceRefs: [artifact], availability: { artifactSha256: artifact.sha256, recipient: 'owner', channel: 'public', usable: true }, result: 'pass' }],
    });
    bind('event', { event: 'release-available', subjectRef: release, at: '2026-11-22T11:50:00Z', basisRefs: [release] });
    return evaluateTimeEvidence({ stateAtQ: { records: f.repo, revision: f.git('rev-parse', 'HEAD') }, plan, now: '2026-11-22T13:00:00Z', clockMode: 'simulation' });
  }

  const ok = codecommitEvidence();
  assert.equal(ok.releaseEvidence.length, 1, ok.findings.join('\n'));
  assert.equal(ok.releases[0].verification, 'verified', ok.findings.join('\n'));

  const accountDrift = codecommitEvidence({ ciPatch: { account: '999999999999' } });
  assert.equal(accountDrift.releaseEvidence.length, 0);
  assert.match(accountDrift.findings.join('\n'), /account mismatch/);

  const missingReceiptAccount = codecommitEvidence({ ciPatch: { account: null } });
  assert.equal(missingReceiptAccount.releaseEvidence.length, 0);
  assert.match(missingReceiptAccount.findings.join('\n'), /account mismatch/);

  const missingCandidateAccount = codecommitEvidence({ candidateDest: { host: 'git-codecommit.us-east-1.amazonaws.com', repository: 'MyRepo' } });
  assert.equal(missingCandidateAccount.releaseEvidence.length, 0);
  assert.match(missingCandidateAccount.findings.join('\n'), /invalid candidate destination account/);

  const badCandidateAccount = codecommitEvidence({ candidateDest: { host: 'git-codecommit.us-east-1.amazonaws.com', repository: 'MyRepo', account: '12345' } });
  assert.equal(badCandidateAccount.releaseEvidence.length, 0);
  assert.match(badCandidateAccount.findings.join('\n'), /invalid candidate destination account/);

  const hostDrift = codecommitEvidence({ ciPatch: { host: 'git-codecommit.eu-west-1.amazonaws.com' } });
  assert.equal(hostDrift.releaseEvidence.length, 0);
  assert.match(hostDrift.findings.join('\n'), /candidate\/destination\/verdict mismatch/);

  const repoDrift = codecommitEvidence({ ciPatch: { repository: 'myrepo' } });
  assert.equal(repoDrift.releaseEvidence.length, 0);
  assert.match(repoDrift.findings.join('\n'), /candidate\/destination\/verdict mismatch/);
});

test('PLB-15: scope and forecast verification resolve same-plan handoff aliases identically while rejecting missing refs, alias duplicates, and cycles', t => {
  const runView = opts => {
    const { f, args, result, forecastPath } = positiveEvidence(t, opts);
    const state = snapshot(f.repo, args.stateAtQ.revision);
    const history = loadForecastHistory(f.repo, state.revision, args.plan.id);
    const view = projectPlanTime(state, args.plan, { now: args.now, clockMode: 'simulation', forecastHistory: history });
    return { result, scope: result.scopeByObservation[forecastPath], view };
  };
  const pkgRun = runView({ forecast: { packages: ['restart'], deferred: ['polish'] } });
  const handoffPlan = plan => {
    plan.packages.find(p => p.id === 'restart').needs = ['R-0001-actor'];
    plan.packages.find(p => p.id === 'cr').needs = ['R-0001-actor', 'R-0002-actor-restart', 'R-0002-actor-polish'];
    plan.packages.find(p => p.id === 'j').needs = ['R-0001-critic-cr'];
  };
  const handoffRun = runView({
    forecast: { packages: ['R-0002-actor-restart'], deferred: ['R-0002-actor-polish'] },
    patchPlan: handoffPlan,
    patchScope: sc => {
      sc.criteria[0].packages = ['R-0002-actor-restart'];
      sc.releasePackages = ['R-0002-actor-restart'];
      sc.deferred[0].package = 'R-0002-actor-polish';
    },
  });
  assert.equal(pkgRun.scope.verification, 'verified', JSON.stringify(pkgRun.scope));
  assert.equal(handoffRun.scope.verification, 'verified', JSON.stringify(handoffRun.scope));
  assert.deepEqual(handoffRun.scope.releasePackages, pkgRun.scope.releasePackages);
  assert.deepEqual(handoffRun.scope.findings, []);
  assert.deepEqual(handoffRun.result.findings, []);
  assert.deepEqual(handoffRun.view.forecast.releaseEta, pkgRun.view.forecast.releaseEta);
  assert.equal(handoffRun.view.forecast.releaseEta.evidenceStatus, 'verified');

  const externalNeedRun = runView({
    forecast: { packages: ['R-0002-actor-restart'], deferred: ['R-0002-actor-polish'] },
    patchPlan: plan => { handoffPlan(plan); plan.packages.find(p => p.id === 'restart').needs.push('D-0001'); },
  });
  assert.equal(externalNeedRun.scope.verification, 'verified', JSON.stringify(externalNeedRun.scope));
  assert.deepEqual(externalNeedRun.result.findings, []);

  const missingRef = runView({ forecast: { packages: ['ghost-pkg'] }, patchPlan: handoffPlan });
  assert.equal(missingRef.scope.verification, 'unverified');
  assert.match(missingRef.scope.findings.join('\n'), /missing dependency or cycle/);
  assert.equal(missingRef.view.forecast.releaseEta.evidenceStatus, 'unverified');

  const dupAlias = runView({ forecast: { packages: ['restart', 'R-0002-actor-restart'] }, patchPlan: handoffPlan });
  assert.equal(dupAlias.scope.verification, 'unverified');
  assert.match(dupAlias.scope.findings.join('\n'), /invalid package list/);

  const cyclic = runView({
    forecast: { packages: ['restart'] },
    patchPlan: plan => {
      plan.packages.find(p => p.id === 'core').needs = ['R-0002-actor-restart'];
      plan.packages.find(p => p.id === 'restart').needs = ['R-0001-actor'];
    },
  });
  assert.equal(cyclic.scope.verification, 'unverified');
  assert.equal(cyclic.view.forecast.releaseEta.evidenceStatus, 'unverified');
  assert.match(cyclic.result.findings.join('\n'), /invalid execution plan\/contract/);
});
