// self-loop-records@cc91f1d:evidence/0012/admitted-positive-evidence/{examples.json,effective-contract.json}
import test from 'node:test';
import assert from 'node:assert/strict';
import { positiveFixture, specIds, at, digest, canonical } from './positive-fixture.mjs';
const evaluator = async () => (await import('../../scripts/lib/plan-time-evidence.mjs')).evaluateTimeEvidence;
const matching = (refs, ref) => refs?.some(r => r.repository === ref.repository && r.path === ref.path && r.sha256 === ref.sha256);
const releaseOf = (result, f) => result.releases.find(r => matching([r.ref], f.release.ref));
const scopeOf = (result, f) => result.scopeByObservation[f.foRef.path];
const checkpoint = (result, f) => result.checkpointResolutions.filter(r => matching([r.observationRef], f.foRef));
const positive = (r,f) => {assert.ok(matching(r.releaseEvidence,f.release.ref),'complete independently endorsed release must verify');assert.equal(releaseOf(r,f)?.verification,'verified');};
const noRelease = (r,f) => assert.ok(!matching(r.releaseEvidence,f.release.ref),'invalid release cannot enter verified evidence');
const noTime = (r,f) => assert.equal(releaseOf(r,f)?.availableAt ?? null,null,'untrusted occurrence cannot become delivery time');
const noScope = (r,f) => assert.notEqual(scopeOf(r,f)?.verification,'verified','invalid scope cannot verify');
async function evaluate(f,rev,now) { const args=f.args(rev);if(now)args.now=now;assert.deepEqual(args.forecastHistory.errors,[],'fixture forecast must be valid independently of evaluator');return (await evaluator())(args); }
for (const id of specIds) test(`admitted example: ${id}`, async t => {
  const f=positiveFixture(t,id), readyBefore=f.ready(f.beforeEvidence), r=await evaluate(f);
  assert.deepEqual(f.ready().filter(p=>p.id==='polish'),readyBefore.filter(p=>p.id==='polish'),'evidence verification must not change independent ready work');
  assert.ok(Array.isArray(r.findings));assert.ok(Array.isArray(r.releaseEvidence));
  switch(id) {
    case 'positive-on-time':
    case 'positive-late':
      positive(r,f);assert.equal(releaseOf(r,f).availableAt,at(id==='positive-late'?'12:10':'11:50'));
      assert.equal(Date.parse(releaseOf(r,f).availableAt)<=Date.parse(at('12:00')),id==='positive-on-time');break;
    case 'optional-deferral':positive(r,f);assert.equal(scopeOf(r,f)?.verification,'verified');assert.equal(scopeOf(r,f).criteria.filter(c=>c.purpose==='minimum').length,2);break;
    case 'timely-forecast-publication':positive(r,f);assert.ok(checkpoint(r,f).some(c=>c.status==='met-on-time'&&matching([c.updateRef],f.fo2Ref)));break;
    case 'late-publication-earlier-delivery':{
      positive(r,f);assert.equal(releaseOf(r,f).availableAt,at('11:50'));
      assert.ok(!checkpoint(r,f).some(c=>c.status==='met-on-time'));
      const old=await evaluate(f,f.beforeEvidence,at('12:00'));assert.deepEqual(old.releaseEvidence,[]);
      assert.ok(!Object.values(old.eventsBySubject).flat().some(e=>e.verification==='verified'));break;
    }
    case 'backdated-publication':assert.ok(!checkpoint(r,f).some(c=>c.status==='met-on-time'));break;
    case 'untrusted-time':case 'wrong-event-subject':case 'gate-finished-after-event':noTime(r,f);break;
    case 'foreign-promise':positive(r,f);assert.ok(!releaseOf(r,f).criteria.some(c=>(c.ref??c.criterion?.ref)?.path==='purpose/P-0003.md'),'minimum is not proof of different promise');break;
    case 'late-historical-handoff-proof':assert.ok(!(r.historicalDoneByObservation[f.foRef.path]??[]).includes('core'),'late-known completion proof must not rewrite old arithmetic');break;
    case 'conflicting-assessments':noScope(r,f);assert.match(JSON.stringify(r),/conflict/);break;
    case 'current-regression':positive(r,f);assert.equal(releaseOf(r,f).availableAt,at('11:50'));assert.equal(releaseOf(r,f).currentAvailability,'unavailable');break;
    case 'required-deferral':case 'self-optional-list':case 'unassigned-issuer':case 'archive-mismatch':case 'wrong-criterion-bytes':noScope(r,f);noRelease(r,f);break;
    default:noRelease(r,f);
  }
});
const controls=['different-promise-complete','ambiguous-selector','scope-superseded','missing-issuer','wrong-request','wrong-role','wrong-claim','duplicate-source','duplicate-binding','nonfinite-number','missing-task','unlisted-source','wrong-ancestry','missing-source','wrong-auth-path','self-authorization','closure-omission','wrong-selector','arbitrary-optional-authority','wrong-channel','wrong-artifact','missing-destination','missing-suite','missing-ci','missing-policy-require','split-candidates','no-event','raw-deliveredAt','explicit-empty-policy','timely-historical-handoff','future-historical-handoff'];
for (const id of controls) test(`A1–A5 control: ${id}`,async t=>{
  const f=positiveFixture(t,id,{external:id==='missing-issuer'}),r=await evaluate(f);
  if(id==='different-promise-complete'){positive(r,f);assert.ok(releaseOf(r,f).criteria.some(c=>(c.ref??c.criterion?.ref)?.path==='purpose/P-0003.md'));}
  else if(['no-event','raw-deliveredAt'].includes(id)){positive(r,f);noTime(r,f);}
  else if(id==='explicit-empty-policy')positive(r,f);
  else if(id==='timely-historical-handoff')assert.ok((r.historicalDoneByObservation[f.foRef.path]??[]).includes('core'));
  else if(id==='future-historical-handoff')assert.ok(!(r.historicalDoneByObservation[f.foRef.path]??[]).includes('core'));
  else noRelease(r,f);
  if(!id.includes('historical-handoff'))assert.deepEqual(f.ready(),f.ready(f.beforeEvidence));
});
test('A4 pinned Q ignores later HEAD evidence and poisoned worktree',async t=>{
  const f=positiveFixture(t),old=await evaluate(f,f.beforeEvidence),latest=await evaluate(f);
  positive(latest,f);assert.deepEqual(old.releaseEvidence,[]);
  f.put(f.release.ref.path,'{"poisoned":true}');
  assert.deepEqual(await evaluate(f),latest,'worktree bytes cannot change pinned results');
});
test('A1 canonical claim digest excludes envelope transport refs',()=>{
  const a={type:'event',rootRef:{path:'plans/PL-0001.md'},planRef:{path:'plans/PL-0001.md'},basedOn:'a'.repeat(40),claim:{at:at('11:50'),event:'release-available'}};
  const reversed=Object.fromEntries(Object.entries(a).reverse());
  assert.equal(digest(canonical(a)),digest(canonical(reversed)));
});
for(const id of ['external-positive','external-cross-repo','json-authorization','json-root-authorization','external-structured-claim','duplicate-authorization','ambiguous-authorization','missing-authorization-selector','invalid-authorization-selector','external-wrong-thread','external-wrong-request','external-wrong-run','external-wrong-status','external-wrong-terminal','external-pending','external-wrong-hash','external-traversal','external-wrong-directory','external-wrong-role','external-wrong-context','external-wrong-archive-commit','wrong-native-report','rewritten-binding','event-correction','event-conflict']) test(`final admitted correspondence: ${id}`,async t=>{
  const f=positiveFixture(t,id,{external:id.startsWith('external-'),crossRepo:id==='external-cross-repo'}),r=await evaluate(f);
  if(['external-positive','external-cross-repo','json-authorization','json-root-authorization','external-structured-claim'].includes(id)){positive(r,f);assert.equal(releaseOf(r,f).availableAt,at('11:50'));}
  else if(id==='event-correction'){positive(r,f);assert.equal(releaseOf(r,f).availableAt,at('12:10'));}
  else if(id==='event-conflict'){positive(r,f);noTime(r,f);assert.match(JSON.stringify(r),/conflict/);}
  else noRelease(r,f);
});
test('original Git objects survive replacement-object attack',async t=>{
  const f=positiveFixture(t),before=await evaluate(f);
  positive(before,f);
  const original=f.git('rev-parse',`${f.scope.ref.commit}:${f.scope.ref.path}`);
  f.put('evidence/0012/replacement.json','{"invalid":true}');
  const replacement=f.git('hash-object','-w','evidence/0012/replacement.json');
  f.git('replace',original,replacement);
  const saved=process.env.GIT_NO_REPLACE_OBJECTS;delete process.env.GIT_NO_REPLACE_OBJECTS;
  try{assert.deepEqual(await evaluate(f),before,'replacement refs cannot affect original-object verification');}
  finally{if(saved===undefined)delete process.env.GIT_NO_REPLACE_OBJECTS;else process.env.GIT_NO_REPLACE_OBJECTS=saved;}
});
test('unchanged native endorsement cannot authorize an invalid selector',async t=>{
  const f=positiveFixture(t,'invalid-authorization-selector'),b=f.scope.envelope;
  const source=JSON.parse(f.git('show',`${b.sourceRef.commit}:${b.sourceRef.path}`));
  const {type,rootRef,planRef,basedOn,claim}=b;
  assert.equal(source.endorsesClaim,digest(canonical({type,rootRef,planRef,basedOn,claim})));
  noScope(await evaluate(f),f);
});
test('reachable branch Event conflicts require explicit same-subject supersession',async t=>{
  const f=positiveFixture(t),base=f.revision;
  f.git('checkout','-qb','event-branch',base);
  const other=f.binding('event',{...f.eventClaim,at:at('12:10')});
  const branch=f.git('rev-parse','HEAD');
  f.git('checkout','-q','main');
  f.put('evidence/0012/independent.txt','Independent records branch\n');f.commit('Independent branch');
  f.git('merge','--no-ff','-m','Join public evidence',branch);
  const joined=f.git('rev-parse','HEAD'),conflicted=await evaluate(f,joined);
  positive(conflicted,f);noTime(conflicted,f);assert.match(JSON.stringify(conflicted),/conflict/);
  f.binding('event',{...f.eventClaim,at:at('11:55')},{supersedes:[f.event.ref,other.ref]});
  const corrected=await evaluate(f,f.git('rev-parse','HEAD'));
  positive(corrected,f);assert.equal(releaseOf(corrected,f).availableAt,at('11:55'));
  noTime(await evaluate(f,joined),f);
});
for(const kind of ['ci','suite']) for(const state of ['red','unknown','mismatch']) test(`later gate regression: ${kind}-${state}`,async t=>{
  const f=positiveFixture(t,`later-gate-${kind}-${state}`),r=await evaluate(f);
  positive(r,f);assert.equal(releaseOf(r,f).availableAt,at('11:50'),'later gate evidence cannot rewrite verified historical occurrence');
  if(state==='red')assert.equal(releaseOf(r,f).currentAvailability,'unavailable','exact candidate known-negative gate must be visible as current regression');
  else assert.equal(releaseOf(r,f).currentAvailability,'unverified','unknown or mismatched receipt remains unknown at Q');
});
