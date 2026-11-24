// D-0060
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, api, project, h, json, digest } from './fixture.mjs';
import { loadPlan } from '../../scripts/lib/plan.mjs';
import { measurePlan } from '../../scripts/lib/plan-measures.mjs';
const eta = (p, low, high) => {assert.equal(p.forecast.earliestAt,low === null ? null : h(low));assert.equal(p.forecast.latestAt,high === null ? null : h(high));};
const screened = p => {assert.equal(p.forecast.latestAt,null);assert.ok(p.findings.length || p.forecast.unknowns.length || p.forecast.staleReasons.length,'invalid input must explain uncertainty');};

function syntheticHandoffEvent(f, id, hour) {
  const author = 'SyntheticIndependentObserver', requestId = 'synthetic-completion-observation';
  const role = 'time-observer', selector = '# Synthetic archival root';
  f.put('decisions/D-0002.md', `${selector}\nby: owner\nSynthetic trusted archive for acceptance only; no physical clock or production event proof.\n${author} ${role} ${requestId} event-attest PL-0001 handoff-completed ${id}\n`);
  f.commit('Synthetic independent event assignment', hour);
  const authorizationRef = f.ref('decisions/D-0002.md');
  const basedOn = f.git('rev-parse', 'HEAD'), planRef = f.ref('plans/PL-0001.md');
  const subjectRef = f.ref(`rounds/0001-actor-${id}.md`);
  const claim = { event: 'handoff-completed', subjectRef, at: h(hour), basisRefs: [subjectRef] };
  const context = { rootRef: planRef, planRef, basedOn };
  const source = json({ author, role, requestId, ...context, claim });
  const platform = json({ status: 'completed', latestTerminalStatus: 'completed', hasPendingChildRuns: false,
    taskId: requestId, childThreadId: author, childRunId: 'synthetic-run', latestTerminalRunId: 'synthetic-run' });
  const archive = 'evidence/0012/synthetic-completion';
  f.put(`${archive}/source.json`, source);
  f.put(`${archive}/platform.json`, platform);
  f.put(`${archive}/archive-hashes.json`, json({ 'source.json': digest(source), 'platform.json': digest(platform) }));
  f.commit('Synthetic independent completion archive', hour);
  const binding = json({ schema: 'plan-time-binding/v1', type: 'event', ...context, claim,
    sourceRef: f.ref(`${archive}/source.json`), authorizationRef, authorizationSelector: selector,
    provenanceRefs: [f.ref(`${archive}/platform.json`), f.ref(`${archive}/archive-hashes.json`)], supersedes: [] });
  const path = `evidence/0012/time-binding/TB-${digest(binding)}.json`;
  f.put(path, binding);
  f.commit('Synthetic authorized completion event before forecast', hour);
  return f.ref(path);
}

test('budget: 24h, half, due-now, signed overrun, clock anomaly and unspecified deadline',async t=>{
  const f=fixture(t); f.publish(f.observation());
  for(const n of [0,12,24,25,26]){const p=await project(f,n);assert.equal(p.elapsedSeconds,n*3600);assert.equal(p.remainingSeconds,(24-n)*3600);assert.equal(p.deadline,h(24));}
  const back=await project(f,-1,{clockMode:'live'});assert.equal(back.elapsedSeconds,null);assert.equal(back.remainingSeconds,null);assert.match(JSON.stringify(back.findings),/clock|anomal/i);
  const u=fixture(t,{deadline:null});u.publish(u.observation());assert.equal((await project(u,30)).remainingSeconds,null);
});

test('historical: frozen h0 operands survive h6 completion and process restart',async t=>{
  const f=fixture(t),first=f.publish(f.observation());eta(await project(f,0),7,9);
  f.done('a',6);const before=await project(f,6);eta(before,7,9);assert.equal(before.forecast.stale,true);assert.ok(before.progress.completedHandoffs.length);
  syntheticHandoffEvent(f,'a',6);
  const second=f.observation({asOf:6,parents:[first],checkpoint:12});f.publish(second);eta(await project(f,6),8,9);
  const c=f.cli('plan.mjs',['measure','--records',f.records,'--plan','PL-0001','--now',h(6),'--json']);assert.equal(c.status,0,c.stderr);eta(JSON.parse(c.stdout).time,8,9);
  const again=f.cli('plan.mjs',['measure','--records',f.records,'--plan','PL-0001','--now',h(6),'--json']);assert.deepEqual(JSON.parse(again.stdout),JSON.parse(c.stdout));
});

for(const serial of [false,true])test(`graph: ${serial?'serialized':'parallel'} fork join plus uncovered reserve`,async t=>{
  const f=fixture(t,{packages:[{id:'a',needs:[]},{id:'b',needs:serial?['a']:[]},{id:'join',needs:['a','b']}]});
  f.publish(f.observation({estimates:{a:f.estimate(6,8),b:f.estimate(7,9),join:f.estimate(2,3)},reserve:[3,6]}));eta(await project(f,0),serial?18:12,serial?26:18);
});

test('half-budget: reserve included in remaining usable forecast',async t=>{
  const f=fixture(t,{packages:[{id:'a',needs:[]}]});f.publish(f.observation({asOf:12,checkpoint:18,estimates:{a:f.estimate(10,14,12)},reserve:[3,6]}));const p=await project(f,12);eta(p,25,32);assert.equal(p.remainingSeconds,43200);
});

test('freshness: age alone, checkpoint equality, strict expiry and unrelated commit',async t=>{
  const f=fixture(t);f.publish(f.observation({checkpoint:6}));
  for(const n of [1,6])assert.equal((await project(f,n)).forecast.stale,false);
  assert.equal((await project(f,6+1/3600)).forecast.stale,true);
  f.put('README.md','unrelated prose\n');f.commit('Unrelated',2);assert.equal((await project(f,2)).forecast.stale,false);
  const g=fixture(t);g.publish(g.observation({checkpoint:12}));assert.equal((await project(g,9)).forecast.stale,false);assert.equal((await project(g,9+1/3600)).forecast.stale,true);
});

test('unknown: blocked release leaves unrelated ready work, query causes no writes',async t=>{
  const f=fixture(t,{packages:[{id:'independent',needs:[]},{id:'external',needs:[],hold:'external approval',release:'unbounded external response'}]});
  f.publish(f.observation({estimates:{external:f.estimate(1,null)}}));const head=f.git('rev-parse','HEAD'),tree=f.git('status','--porcelain');const ready=f.canonical();assert.ok(ready.ready.includes('independent'));
  const p=await project(f,1);assert.equal(p.forecast.latestAt,null);assert.deepEqual(f.canonical(),ready);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),tree);
});

test('unknown: missing estimate and unbounded reserve cannot yield finite latest',async t=>{
  for(const which of ['estimate','reserve']){const f=fixture(t);const o=f.observation();if(which==='estimate')delete o.estimates.b;else o.outlook.reserve.remaining.highSeconds=null;f.publish(o);assert.equal((await project(f,1)).forecast.latestAt,null);}
});

test('history: real parallel publication branches conflict; all-tip resolution retains history',async t=>{
  const f=fixture(t),one=f.publish(f.observation());const cut=f.git('rev-parse','HEAD');
  const left=f.observation({basedOn:cut,asOf:1,parents:[one],checkpoint:7});const l=f.publish(left);
  const right=f.observation({basedOn:cut,asOf:1,parents:[one],checkpoint:8});const r=f.publish(right);
  const p=await project(f,2);screened(p);assert.match(JSON.stringify(p),/conflict/i);assert.ok(p.history.length>=3);
  f.publish(f.observation({asOf:2,parents:[l,r],checkpoint:10}));const resolved=await project(f,2);eta(resolved,9,11);assert.ok(resolved.history.length>=4);
});

for(const defect of ['delete','modify','malformed','wrong-digest','uppercase','missing-parent','nonancestor','wrong-root','missing-input'])test(`history integrity: ${defect} never silently falls back fresh`,async t=>{
  const f=fixture(t),one=f.publish(f.observation());
  if(defect==='delete'){rmSync(join(f.records,one.path));f.commit('Delete old forecast',1);}
  else if(defect==='modify'){f.put(one.path,'{}\n');f.commit('Modify old forecast',1);}
  else if(defect==='malformed'){const bytes='{broken\n';f.put(`forecasts/FO-${digest(bytes)}.json`,bytes);f.commit('Malformed newest',1);}
  else if(defect==='wrong-digest'||defect==='uppercase'){const o=f.observation({asOf:1,parents:[one]}),bytes=json(o);f.put(`forecasts/FO-${defect==='uppercase'?digest(bytes).toUpperCase():'0'.repeat(64)}.json`,bytes);f.commit('Invalid path',1);}
  else {const o=f.observation({asOf:1,parents:[one]});if(defect==='missing-parent')o.parents=[{...one,path:`forecasts/FO-${'a'.repeat(64)}.json`}];if(defect==='nonancestor')o.outlook.basedOn='1'.repeat(40);if(defect==='wrong-root')o.rootRef={...one};if(defect==='missing-input')o.outlook.inputs.push({...f.authority,path:'decisions/D-9999.md'});f.publish(o);}
  screened(await project(f,2));
});

test('pinned reads: uncommitted forecast is invisible; historical Q unaffected by later deletion',async t=>{
  const f=fixture(t),one=f.publish(f.observation()),q=f.git('rev-parse','HEAD');const before=await project(f,1,{revision:q});
  f.put(one.path,'broken working tree');assert.deepEqual(await project(f,1,{revision:q}),before);
  rmSync(join(f.records,one.path));f.commit('Delete',2);assert.deepEqual(await project(f,1,{revision:q}),before);
});

test('historical unknown: missing supplied snapshot never substitutes current completed node',async t=>{
  const f=fixture(t);f.publish(f.observation());f.done('a',6);screened(await project(f,6,{historicalSnapshots:{}}));
});

test('historical unknown: future completion at basedOn cannot certify past done',async t=>{
  const f=fixture(t);f.done('a',6);f.publish(f.observation({asOf:0}));screened(await project(f,6));
});

test('no progress: same nonempty handoff bytes with newer publication is unchanged',async t=>{
  const f=fixture(t);f.done('a',6);const one=f.publish(f.observation({asOf:6,checkpoint:10}));
  f.put('README.md','unrelated\n');f.commit('Unrelated',7);f.publish(f.observation({asOf:7,parents:[one],checkpoint:12}));const p=await project(f,7);assert.ok(p.progress.completedHandoffs.length);assert.match(JSON.stringify(p),/no.progress|unchanged.progress|progress.unchanged/i);
});

test('restart/cancel: root clock, misses and promises survive execution successor',async t=>{
  const f=fixture(t),one=f.publish(f.observation({checkpoint:6}));const successor={...structuredClone(f.plan),id:'PL-0002',supersedes:'PL-0001',time:{schema:'plan-time/v2',rootPlan:'PL-0001'}};f.writePlan(successor);f.commit('Restart same scope',25);
  const p=await project(f,25,{planId:'PL-0002'});assert.equal(p.elapsedSeconds,90000);assert.equal(p.remainingSeconds,-3600);assert.ok(p.history.length);assert.ok(p.checkpoint.missed.length);assert.equal(p.forecast.latestAt,null);
  f.publish(f.observation({asOf:25,checkpoint:27,parents:[one],planId:'PL-0002',outcome:'cancelled'}));const cancelled=await project(f,26,{planId:'PL-0002'});assert.equal(cancelled.remainingSeconds,-7200);assert.ok(cancelled.checkpoint.missed.length);assert.equal(cancelled.progress.releaseEvidence.length,0);
});

test('authority: descendant cannot reset start/deadline/minimum; legacy plans remain valid',async t=>{
  const m=await api();const f=fixture(t);
  assert.deepEqual(m.validatePlanTime(f.plan,f.state()),[]);
  for(const field of ['startedAt','deadline','minimum']){const p={...structuredClone(f.plan),id:'PL-0002',supersedes:'PL-0001'};if(field==='startedAt')p.time.baseline.startedAt=h(12);if(field==='deadline')p.time.baseline.deadline.at=h(48);if(field==='minimum')p.time.baseline.minimum.outcome='weakened quality';assert.ok(m.validatePlanTime(p,f.state()).length);}
  const legacy=fixture(t,{timed:false});assert.deepEqual(m.validatePlanTime(legacy.plan,legacy.state()),[]);assert.equal(measurePlan(legacy.state(),loadPlan(legacy.state(),'PL-0001')).time,null);
});

test('quality: cited delivered assessment and package handoff are not verified release',async t=>{
  const f=fixture(t);f.done('a',6);f.done('b',8);const o=f.observation({asOf:8,checkpoint:12,outcome:'delivered'});o.outlook.outcome.deliveredAt=h(8);o.outlook.outcome.evidenceRefs=[f.ref('rounds/0001-actor-b.md')];f.publish(o);const p=await project(f,25);assert.equal(p.progress.releaseEvidence.length,0);assert.ok(p.promises.every(x=>!['met-on-time','met-late'].includes(x.status??x.state)));
});

test('simulation: --now plus mutating parent-entry refuses before any record mutation',t=>{
  const f=fixture(t);const head=f.git('rev-parse','HEAD');const input=f.put('entry.json',json({schema:'continuation-entry/v1',products:[]}));const before=f.git('status','--porcelain');
  const r=f.cli('self-loop.mjs',['start','--config',join(f.records,'loop.json'),'--owner-store',f.store,'--now',h(12),'--parent-entry',input]);assert.notEqual(r.status,0);assert.match(r.stderr+r.stdout,/now|simulat|synthetic/i);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),before);
});

test('public input: pinned canonical handoff ledger is a regular public source',async t=>{
  const f=fixture(t),o=f.observation();o.outlook.inputs.push(f.ref('metrics/handoffs.jsonl'));f.publish(o);eta(await project(f,1),7,9);
});

test('invalid forecast cannot erase evidenced original budget',async t=>{
  const f=fixture(t),o=f.observation();o.outlook.inputs.push({...f.authority,sha256:'0'.repeat(64)});f.publish(o);const p=await project(f,25);screened(p);assert.equal(p.elapsedSeconds,90000);assert.equal(p.remainingSeconds,-3600);
});

test('unresolved blocker requires supported release bound, generic capacity assumption is insufficient',async t=>{
  const f=fixture(t,{packages:[{id:'external',needs:[],hold:'external approval',release:'unbounded external response'}]});
  f.publish(f.observation({estimates:{external:f.estimate(1,2)}}));assert.equal((await project(f,1)).forecast.latestAt,null);
});

test('immutable baseline rejects in-place start, deadline and quality tampering',async t=>{
  const m=await api();for(const field of ['startedAt','deadline','minimum']){const f=fixture(t),p=structuredClone(f.plan);if(field==='startedAt')p.time.baseline.startedAt=h(12);if(field==='deadline')p.time.baseline.deadline.at=h(48);if(field==='minimum')p.time.baseline.minimum.outcome='skip CI';f.writePlan(p);f.commit('Tamper root',12);assert.ok(m.validatePlanTime(p,f.state()).length);assert.equal((await project(f,25)).remainingSeconds,null);}
});

test('promise identity cannot be reused to extend due date',async t=>{
  const f=fixture(t),first=f.publish(f.observation()),o=f.observation({asOf:1,parents:[first]});o.promisesAdded=[{...f.plan.time.baseline.promises[0],dueAt:h(48)}];f.publish(o);const p=await project(f,25);assert.match(JSON.stringify(p),/promise.*conflict|duplicate.*promise/i);assert.ok(p.promises.some(x=>x.id==='usable'&&x.dueAt===h(24)&&x.status==='overdue'));
});

test('new completion after unchanged nonempty progress actually advances progress',async t=>{
  const f=fixture(t);f.done('a',6);const one=f.publish(f.observation({asOf:6,checkpoint:10}));f.done('b',7);f.publish(f.observation({asOf:7,checkpoint:12,parents:[one]}));const p=await project(f,7);assert.equal(p.progress.completedHandoffs.length,2);assert.doesNotMatch(p.findings.join('\n'),/unchanged-progress/);
});

test('real disconnected basedOn Git object is refused despite matching plan bytes',async t=>{
  const f=fixture(t);const o=f.observation(),tree=f.git('rev-parse','HEAD^{tree}'),disconnected=f.git('commit-tree',tree,'-m','Disconnected history');
  o.outlook.basedOn=disconnected;o.rootRef=f.ref('plans/PL-0001.md',disconnected);o.planRef=o.rootRef;f.publish(o);screened(await project(f,1));
});

test('cross-repository unavailable input stays unknown rather than substituting local bytes',async t=>{
  const f=fixture(t),foreign=fixture(t),o=f.observation();o.outlook.inputs.push({...foreign.authority,commit:'1'.repeat(40)});f.publish(o);screened(await project(f,1));
});

test('unrelated valid root does not poison current root forecast',async t=>{
  const f=fixture(t);f.publish(f.observation());const second={...structuredClone(f.plan),id:'PL-0002',scope:'unrelated-outcome'};second.time.rootPlan='PL-0002';f.writePlan(second);f.commit('Independent scope',1);
  const o=f.observation({asOf:1,planId:'PL-0002'});o.rootRef=o.planRef;f.publish(o);eta(await project(f,1),7,9);
});

test('entry: next and start share simulated clock, preserve independent opportunity and write nothing',async t=>{
  const f=fixture(t,{packages:[{id:'independent',needs:[]},{id:'external',needs:[],hold:'external approval',release:'unbounded external response'}]});
  f.publish(f.observation({estimates:{external:f.estimate(1,null)}}));const head=f.git('rev-parse','HEAD'),status=f.git('status','--porcelain');
  for(const op of ['next','start']){const r=f.cli('self-loop.mjs',[op,'--config',join(f.records,'loop.json'),'--owner-store',f.store,'--now',h(25)]);assert.equal(r.status,0,r.stderr);assert.ok(r.stdout.includes(h(25)));assert.match(r.stdout,/overdue by 3600 s/);assert.match(r.stdout,/independent.*R-0001-actor-independent/);assert.match(r.stdout,/external approval/);assert.match(r.stdout,/unknown/i);assert.equal(f.git('rev-parse','HEAD'),head);assert.equal(f.git('status','--porcelain'),status);}
});

test('mutation sensitivity: forged current done rows cannot rewrite historical operands',async t=>{
  const f=fixture(t);f.publish(f.observation());const forged=f.canonical().packages.map(p=>({...p,status:'done'}));eta(await project(f,1,{canonicalPackagesAtQ:forged}),7,9);
  const m=await api(),history=m.loadForecastHistory(f.records,f.state().revision,'PL-0001');const key=history.observations[0].outlook.basedOn;
  f.done('a',6);screened(await project(f,6,{historicalSnapshots:{[key]:f.state()}}));
});
