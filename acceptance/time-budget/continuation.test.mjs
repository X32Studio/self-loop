// D-0060, F-0016
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fixture, digest, json, h } from './fixture.mjs';
const linuxIdentity=process.platform==='linux'&&existsSync('/proc/sys/kernel/random/boot_id');
const id=x=>`ct:${digest(JSON.stringify(x))}`;
const moduleURL=new URL('../../scripts/lib/continuation.mjs',import.meta.url).href;
const ledger='metrics/continuations.jsonl';
const measured={measured:{load1:0.1,cores:20,availableGiB:32,totalGiB:64,load:'fixture',memory:'fixture',total:'fixture'}};
const rows=f=>f.state().read(ledger).split('\n').filter(Boolean).map(JSON.parse);
function bind(f){
  f.put('delegations/T-0001.md','# T-0001\nOwning parent: parent-tb; authorized usable-flow\n');f.commit('Delegation');
  const b={productKey:id([f.records]),scope:f.plan.scope,phase:f.plan.phase,planRef:f.ref('plans/PL-0001.md'),delegationRef:f.ref('delegations/T-0001.md'),attemptRef:null,nonce:null,environmentId:'tb-env',parentThreadId:'parent-tb',taskId:'tb-task',childThreadId:'tb-child',runId:'tb-run'};
  b.generation=id([b.productKey.slice(3),b.phase,b.scope,'PL-0001',b.planRef.sha256,b.delegationRef.sha256,null,b.environmentId,b.taskId,b.runId]);
  f.put('evidence/0001/binding.json',json(b));f.commit('Binding');return {b,ref:f.ref('evidence/0001/binding.json')};
}
function terminal(f,b,status){f.put('evidence/0001/terminal.json',json({environmentId:b.environmentId,taskId:b.taskId,runId:b.runId,status}));f.commit('Terminal',7);return {source:'t3-terminal',sourceRef:f.ref('evidence/0001/terminal.json'),terminalStatus:status};}
function call(f,method,args){
  const script=`const m=await import(${JSON.stringify(moduleURL)});console.log(JSON.stringify(await m[process.argv[1]](...JSON.parse(process.argv[2]))));`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',script,method,JSON.stringify(args)],{cwd:f.dir,env:f.env,encoding:'utf8',timeout:20000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
const enter=(f,b)=>call(f,'reconcileAtExistingParentEntry',[f.records,{environmentId:b.environmentId,parentThreadId:b.parentThreadId,runId:'tb-parent-entry',deathRefs:[]},measured]);
function publishPair(f){const one=f.publish(f.observation());f.publish(f.observation({asOf:6,checkpoint:12,parents:[one]}));}

for(const status of ['failed','cancelled','completed'])test(`stable binding: forecast updates then ${status} without handoff`,{skip:!linuxIdentity},t=>{
  const f=fixture(t),{b,ref}=bind(f);publishPair(f);const observation=terminal(f,b,status);
  assert.equal(f.ref(b.planRef.path).sha256,b.planRef.sha256);assert.equal(f.ref(b.delegationRef.path).sha256,b.delegationRef.sha256);
  const captured=call(f,'capture',[observation,ref,f.records]);assert.ok(captured.obligationId,JSON.stringify(captured));assert.deepEqual(captured.unknowns,[]);
  const again=call(f,'capture',[observation,ref,f.records]);assert.equal(again.obligationId,captured.obligationId);assert.equal(rows(f).filter(r=>r.type==='bind').length,1);assert.equal(rows(f).filter(r=>r.type==='observe').length,1);
  const result=enter(f,b);assert.ok(result.pending.some(p=>p.obligationId===captured.obligationId));assert.ok(result.pending.every(p=>p.owner.parentThreadId==='parent-tb' && /actual parent entry/.test(p.nextTrigger)));
  assert.ok(result.pending.some(p=>p.ready.includes('a')));assert.ok(result.consumeRowId);enter(f,b);assert.equal(rows(f).filter(r=>r.type==='consume').length,1);assert.equal(rows(f).filter(r=>r.type==='send-receipt'||r.type==='intent').length,0);
  assert.equal(rows(f).find(r=>r.type==='bind').payload.generation,b.generation);
});

test('stable binding: successful canonical handoffs retain existing completed behavior',t=>{
  const f=fixture(t),{b,ref}=bind(f);publishPair(f);f.done('a',6);f.done('b',7);const o=terminal(f,b,'completed'),c=call(f,'capture',[o,ref,f.records]);assert.ok(c.obligationId,JSON.stringify(c));enter(f,b);
  assert.ok(rows(f).some(r=>r.type==='invalidate'&&r.payload.reason==='completed'));assert.equal(rows(f).filter(r=>r.type==='send-receipt').length,0);
});

test('genuine successor keeps stale-plan binding rejection',t=>{
  const f=fixture(t),{b,ref}=bind(f);publishPair(f);const p={...structuredClone(f.plan),id:'PL-0002',supersedes:'PL-0001',time:{schema:'plan-time/v2',rootPlan:'PL-0001'}};f.writePlan(p);f.commit('Real execution successor',7);
  const o=terminal(f,b,'failed'),c=call(f,'capture',[o,ref,f.records]);assert.equal(c.obligationId,null);assert.match(c.unknowns.join('\n'),/stale plan binding/);
});

test('uncertain existing claim is not stolen by forecast refresh or later entry',{skip:!linuxIdentity},t=>{
  const f=fixture(t),{b,ref}=bind(f);const first=f.publish(f.observation());const o=terminal(f,b,'failed'),c=call(f,'capture',[o,ref,f.records]);assert.ok(c.obligationId,JSON.stringify(c));
  const old=rows(f),previous=digest(JSON.stringify(old.at(-1))),claimant={host:'unreachable-host',bootId:'unknown-boot',pid:1234,startId:'unknown-start',parentThreadId:b.parentThreadId,runId:'uncertain-entry'};
  const payload={obligationId:c.obligationId,generation:b.generation,expectedHead:f.git('rev-parse','HEAD'),claimOrdinal:1,claimId:id([c.obligationId.slice(3),1,claimant]),claimant};
  const row={schema:'continuation-row/v1',type:'claim',rowId:id([previous,payload]),previousRowHash:previous,recordedAt:h(8),payload};
  f.put(ledger,old.map(JSON.stringify).join('\n')+'\n'+JSON.stringify(row)+'\n');f.commit('Uncertain previous claim',8);
  f.publish(f.observation({asOf:9,checkpoint:12,parents:[first]}));const result=enter(f,b);assert.equal(result.consumeRowId,null);assert.ok(result.pending.some(p=>/death unverified/.test(p.blocker)));assert.equal(rows(f).filter(r=>r.type==='claim').length,1);
});
