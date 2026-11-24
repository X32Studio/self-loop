// D-0060
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
function hasProcessIdentity() {
  try {
    const stat=readFileSync(`/proc/${process.pid}/stat`,'utf8');
    return Boolean(readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() && stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
  } catch { return false; }
}
function assertUnsupported(result,ledger) {
  assert.equal(result.consumeRowId,null);
  assert.ok(result.pending.length);
  for(const pending of result.pending) {
    assert.deepEqual(pending.owner,{environmentId:'env',parentThreadId:'parent'});
    assert.match(pending.nextTrigger,/actual parent entry/);
    assert.match(pending.blocker,/identity unavailable/);
  }
  assert.equal(ledger.filter(r => ['consume','release-claim'].includes(r.type)).length,0);
}
import { createHash } from 'node:crypto';
import { hash, sameBinding, identity, raw, bytesHash, makeRow, reduceRows, parseLedger, generationOf, obligationOf } from '../lib/continuation-store.mjs';

const ref=(path='plans/PL-0001.md') => ({repository:'/fixture/records',commit:'a'.repeat(40),path,sha256:'b'.repeat(64)});
const claimant={host:'test-host',bootId:'boot-one',pid:101,startId:'200',parentThreadId:'parent',runId:'parent-run'};
function fixture() {
  const rows=[];
  const add=(type,p) => { const row=makeRow(type,p,reduceRows(rows).previous,'2026-11-22T00:00:00.000Z'); reduceRows([...rows,row]); rows.push(row); return row; };
  const b={productKey:identity(['/fixture/records']),scope:'A/s1',phase:'v1',planRef:ref(),delegationRef:ref('delegations/T-0001.md'),attemptRef:null,nonce:null,environmentId:'env',parentThreadId:'parent',taskId:'task',childThreadId:'child',runId:'run',generation:''};
  b.generation=generationOf(b);
  const bind=add('bind',b),id=obligationOf(b);
  const observe=(status='failed') => add('observe',{bindingRowId:bind.rowId,eventId:identity(['t3-terminal','env','task','run']),source:'t3-terminal',sourceRef:ref(`evidence/0001/${status}.json`),terminalStatus:status,cursor:{ordinal:rows.length+1,previousRowHash:reduceRows(rows).previous,source:null},obligationId:id});
  const claim=() => { const ordinal=reduceRows(rows).obligations.get(id).ordinal+1; return add('claim',{obligationId:id,generation:b.generation,expectedHead:'a'.repeat(40),claimOrdinal:ordinal,claimId:identity([raw(id),ordinal,claimant]),claimant}); };
  const consume=c => add('consume',{claimId:c.payload.claimId,generation:b.generation,observedHead:'a'.repeat(40),cursor:reduceRows(rows).obligations.get(id).cursor,consumeRefs:[ref()],disposition:'accountable-wait'});
  return {rows,add,b,bind,id,observe,claim,consume};
}
test('ledger: H uses exact UTF-8 compact arrays and nested hashes are unprefixed',() => {
  assert.equal(hash(['A','中文',null]),createHash('sha256').update('["A","中文",null]').digest('hex'));
  const f=fixture();
  assert.equal(f.b.generation,identity([raw(f.b.productKey),'v1','A/s1','PL-0001','b'.repeat(64),'b'.repeat(64),null,'env','task','run']));
  assert.equal(f.id,identity(['reconcile',raw(f.b.productKey),'v1','A/s1',raw(f.b.generation)]));
});
test('ledger: exact row order, hashes, truncation, extra keys and tampering reject',() => {
  const f=fixture(); f.observe();
  const bytes=f.rows.map(r => JSON.stringify(r)+'\n').join('');
  assert.deepEqual(parseLedger(bytes),f.rows);
  assert.throws(() => parseLedger(bytes.slice(0,-1)),/unterminated/);
  for(const mutation of [r => r.payload.scope='other',r => r.extra=true,r => r.previousRowHash='c'.repeat(64),r => r.schema='other']) {
    const rows=structuredClone(f.rows); mutation(rows[0]); assert.throws(() => reduceRows(rows));
  }
  const reordered={type:f.rows[0].type,...f.rows[0]}; assert.throws(() => reduceRows([reordered]),/field order/);
});
test('ledger: duplicates cannot create second claim or consumption',() => {
  const f=fixture(); f.observe(); assert.throws(() => f.observe(),/duplicate observation/);
  const c=f.claim(); assert.throws(() => f.claim(),/claim/); f.consume(c);
  assert.throws(() => f.consume(c),/stale claim/);
  assert.throws(() => f.claim(),/claim/);
});
test('ledger: conflicting terminals revoke consumption and block future claims',() => {
  const f=fixture(); f.observe(); f.consume(f.claim()); f.observe('completed');
  const o=reduceRows(f.rows).obligations.get(f.id);
  assert.equal(o.conflict,true); assert.equal(o.consumed,false);
  assert.throws(() => f.claim(),/conflicting claim/);
});
test('ledger: stale running cannot overwrite a terminal',() => {
  const f=fixture(); f.observe(); assert.throws(() => f.observe('running'),/status/);
  assert.equal(reduceRows(f.rows).obligations.get(f.id).consumed,false);
});
test('ledger: identity and cursor mismatches reject even when row hash is recomputed',() => {
  const f=fixture(); f.observe();
  for(const change of [p => p.cursor.ordinal=88,p => p.cursor.previousRowHash=null,p => p.eventId=identity(['wrong']),p => p.bindingRowId=identity(['other']),p => p.obligationId=identity(['other'])]) {
    const rows=structuredClone(f.rows); change(rows[1].payload);
    rows[1]=makeRow('observe',rows[1].payload,bytesHash(JSON.stringify(rows[0])));
    assert.throws(() => reduceRows(rows));
  }
});
test('ledger: unknown binding and private references cannot become pending',() => {
  const f=fixture();
  for(const change of [b => b.runId=null,b => b.attemptRef=ref('evidence/private/attempt.json'),b => b.planRef.sha256='bad',b => b.nonce=undefined]) {
    const b=structuredClone(f.b); change(b); assert.throws(() => makeRow('bind',b,null));
  }
});
test('ledger: release before intent advances ordinal and old token stays dead',() => {
  const f=fixture(); f.observe(); const old=f.claim();
  f.add('release-claim',{claimId:old.payload.claimId,deathRef:ref('evidence/0001/death.json'),successorClaimOrdinal:2});
  const next=f.claim(); assert.equal(next.payload.claimOrdinal,2);
  assert.throws(() => f.consume(old),/stale claim/); f.consume(next);
});
test('ledger: intent without receipt remains uncertain and is never blindly retried',() => {
  const f=fixture(); f.observe(); const c=f.claim();
  const intentId=identity([raw(f.id),1,'parent-send']);
  f.add('intent',{claimId:c.payload.claimId,intentId,kind:'parent-send',normalAttemptRef:null});
  f.add('uncertain',{claimId:c.payload.claimId,intentId,reason:'receipt lost',evidenceRefs:[ref('evidence/0001/loss.json')]});
  assert.throws(() => f.add('release-claim',{claimId:c.payload.claimId,deathRef:ref('evidence/0001/death.json'),successorClaimOrdinal:2}),/unsafe/);
  assert.throws(() => f.consume(c),/unsafe/);
  f.add('send-receipt',{intentId,threadId:'parent',messageId:'message',runId:'run',delivery:'started',status:'running'});
  assert.equal(reduceRows(f.rows).obligations.get(f.id).consumed,false);
  assert.throws(() => f.consume(c),/unsafe/);
});
test('ledger: supersession and completion invalidate without erasing evidence',() => {
  for(const reason of ['superseded','completed']) {
    const f=fixture(); f.observe(); const c=f.claim();
    f.add('invalidate',{obligationId:f.id,reason,authorityRefs:[ref()]});
    assert.equal(f.rows.length,4); assert.throws(() => f.consume(c),/stale/);
    assert.throws(() => f.claim(),/claim/);
  }
});
test('ledger: independent scope cannot clear another obligation',() => {
  const a=fixture(),b=fixture(); b.b.scope='B/s2'; b.b.generation=generationOf(b.b);
  a.observe(); const c=a.claim();
  assert.throws(() => a.add('consume',{claimId:c.payload.claimId,generation:b.b.generation,observedHead:'a'.repeat(40),cursor:reduceRows(a.rows).obligations.get(a.id).cursor,consumeRefs:[ref()],disposition:'locally-reconciled'}),/stale/);
  assert.equal(reduceRows(a.rows).obligations.get(a.id).consumed,false);
});
test('ledger: new record event requires a fresh exact cursor consumption',() => {
  const f=fixture(); f.observe(); const c=f.claim();
  const stale=structuredClone(reduceRows(f.rows).obligations.get(f.id).cursor);
  const source=['a'.repeat(40),'decisions/D-0001.md','b'.repeat(64)];
  f.add('observe',{bindingRowId:f.bind.rowId,eventId:identity(['record-change',...source]),source:'record-change',sourceRef:ref(source[1]),terminalStatus:null,cursor:{ordinal:f.rows.length+1,previousRowHash:reduceRows(f.rows).previous,source},obligationId:f.id});
  assert.throws(() => f.add('consume',{claimId:c.payload.claimId,generation:f.b.generation,observedHead:'a'.repeat(40),cursor:stale,consumeRefs:[ref()],disposition:'locally-reconciled'}),/stale/);
  f.consume(c);
});

async function integratedFixture(t) {
  const {loopProduct,ownerStore,git,temp}=await import('./helpers.mjs');
  const {mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync}=await import('node:fs');
  const {join,dirname}=await import('node:path');
  const f=loopProduct({dir:realpathSync(temp('self-loop-product-'))}), store=ownerStore([{name:'fixture',records:f.records,aliases:[]}]);
  const prior=process.env.SELF_LOOP_OWNER_STORE; process.env.SELF_LOOP_OWNER_STORE=store;
  t.after(() => { if(prior === undefined) delete process.env.SELF_LOOP_OWNER_STORE; else process.env.SELF_LOOP_OWNER_STORE=prior; rmSync(f.dir,{recursive:true,force:true}); rmSync(store,{recursive:true,force:true}); });
  const write=(path,body) => { mkdirSync(dirname(join(f.records,path)),{recursive:true}); writeFileSync(join(f.records,path),typeof body === 'string' ? body : JSON.stringify(body)); };
  const commit=() => { git(f.records,'add','-A'); git(f.records,'commit','-qm','fixture observation'); return git(f.records,'rev-parse','HEAD'); };
  const pointer=path => ({repository:f.records,commit:git(f.records,'rev-parse','HEAD'),path,sha256:bytesHash(readFileSync(join(f.records,path)))});
  const packages=[
    ...['ready','secure'].map(id => ({id,authority:['D-0001'],goal:`Review fixture ${id}`,files:[],interface:'review only',needs:[],role:'actor',acceptance:'fixture review',handoff:`R-0001-actor-${id}`,task:import.meta.filename,...(id === 'secure' ? {hold:'security refusal',release:'explicit security resolution'} : {})})),
    {id:'critic',authority:['D-0001'],goal:'Review fixture critic',files:[],interface:'review only',needs:['ready','secure'],reviews:['ready','secure'],role:'critic',acceptance:'fixture review',handoff:'R-0001-critic-cr',task:import.meta.filename},
    {id:'judge',authority:['D-0001'],goal:'Review fixture judge',files:[],interface:'review only',needs:['critic'],role:'judge',acceptance:'fixture review',handoff:'R-0001-judge',task:import.meta.filename},
  ];
  const plan={id:'PL-0001',scope:'A/s1',phase:'v1',packages};
  write('plans/PL-0001.md',plan); write('decisions/D-0001.md','# D-0001\n\nby: owner\nReview fixture only; no runtime launch authorized.\n');
  write('delegations/T-0001.md','# T-0001\nAccountable coordinator for fixture review.\n');
  write('records.json',{extraKinds:[{kind:'Continuation delivery',path:'metrics/continuations.jsonl',changes:'append-only',settlesOwnerWords:false}]});
  commit();
  const b={productKey:identity([f.records]),scope:plan.scope,phase:plan.phase,planRef:pointer('plans/PL-0001.md'),delegationRef:pointer('delegations/T-0001.md'),attemptRef:null,nonce:null,environmentId:'env',parentThreadId:'parent',taskId:'task',childThreadId:'child',runId:'run',generation:''};
  b.generation=generationOf(b);
  write('evidence/0001/binding.json',b); write('evidence/0001/terminal.json',{environmentId:'env',taskId:'task',latestTerminalRunId:'run',latestTerminalStatus:'failed'}); commit();
  const bindingRef=pointer('evidence/0001/binding.json');
  const observation={source:'t3-terminal',sourceRef:pointer('evidence/0001/terminal.json'),terminalStatus:'failed'};
  const parent={environmentId:'env',parentThreadId:'parent',runId:'parent-run',deathRefs:[]};
  const host={measured:{load1:0,cores:8,availableGiB:64,totalGiB:64,load:'fixture measured',memory:'fixture measured',total:'fixture measured'}};
  const api=await import('../lib/continuation.mjs');
  const ledger=() => parseLedger(readFileSync(join(f.records,'metrics/continuations.jsonl'),'utf8'));
  return {...f,store,write,commit,pointer,plan,b,bindingRef,observation,parent,host,api,ledger};
}
test('integrated: capture, null input, canonical hold, repeat entry and supersession',async t => {
  const f=await integratedFixture(t);
  const captured=await f.api.capture(f.observation,f.bindingRef,f.records);
  assert.ok(captured.obligationId); assert.deepEqual(captured.unknowns,[]);
  assert.equal((await f.api.capture(f.observation,f.bindingRef,f.records)).commit,captured.commit);
  const absent=await f.api.reconcileAtExistingParentEntry(f.records,null,null);
  assert.equal(absent.commit,captured.commit); assert.equal(absent.consumeRowId,null); assert.ok(absent.pending[0].owner); assert.ok(absent.unknowns.length);
  assert.equal((await f.api.capture(null,null,f.records)).obligationId,null);
  const missingHost=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,null);
  assert.equal(missingHost.consumeRowId,null); assert.ok(missingHost.unknowns.length);
  const result=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  if(hasProcessIdentity()) {
  assert.ok(result.consumeRowId); assert.deepEqual(result.unknowns,[]);
  const secure=result.pending[0].packages.find(p => p.id === 'secure');
  assert.equal(secure.status,'waiting'); assert.equal(secure.holds.find(h => h.kind === 'hold').computed,false);
  assert.deepEqual(result.pending[0].ready,['ready']);
  const again=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  assert.equal(again.consumeRowId,null); assert.equal(again.commit,result.commit);
  assert.equal(f.ledger().filter(r => r.type === 'consume').length,1);
  } else {
    assertUnsupported(result,f.ledger());
    const again=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
    assertUnsupported(again,f.ledger()); assert.equal(again.commit,result.commit);
  }
  f.write('plans/PL-0002.md',{...f.plan,id:'PL-0002',supersedes:'PL-0001'}); f.commit();
  await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  assert.equal(f.ledger().at(-1).type,'invalidate');
  assert.equal(f.ledger().at(-1).payload.reason,'superseded');
});
test('integrated: verified same-host death releases before intent; live and mismatched death identity never steal',async t => {
  if(!hasProcessIdentity()) { t.skip('positive recovery requires actual proc boot/start identity'); return; }
  const f=await integratedFixture(t);
  const {spawn}=await import('node:child_process');
  const {readFileSync}=await import('node:fs');
  const {hostname}=await import('node:os');
  const {once}=await import('node:events');
  const {transaction}=await import('../lib/continuation-store.mjs');
  const child=spawn(process.execPath,['-e','setInterval(() => {}, 1000)'],{stdio:'ignore'});
  t.after(() => { if(child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child,'spawn');
  const stat=readFileSync(`/proc/${child.pid}/stat`,'utf8');
  const old={host:hostname(),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:child.pid,startId:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],parentThreadId:'parent',runId:'old-run'};
  const captured=await f.api.capture(f.observation,f.bindingRef,f.records);
  await transaction(f.records,(snap,rows,append) => {
    append('claim',{obligationId:captured.obligationId,generation:f.b.generation,expectedHead:snap.head,claimOrdinal:1,claimId:identity([raw(captured.obligationId),1,old]),claimant:old}); return {};
  });
  f.write('evidence/0001/death.json',{claimant:old,observation:'terminated'}); f.commit();
  f.parent.deathRefs=[f.pointer('evidence/0001/death.json')];
  const live=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  assert.equal(live.consumeRowId,null); assert.match(live.pending[0].blocker,/unverified/);
  const exit=once(child,'exit'); child.kill(); await exit;
  f.write('evidence/0001/wrong-death.json',{claimant:{...old,startId:'different-start'},observation:'terminated'}); f.commit();
  const correct=f.parent.deathRefs;
  f.parent.deathRefs=[f.pointer('evidence/0001/wrong-death.json')];
  const unknown=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  assert.equal(unknown.consumeRowId,null); assert.match(unknown.pending[0].blocker,/unverified/);
  f.parent.deathRefs=correct;
  const recovered=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  assert.ok(recovered.consumeRowId);
  assert.equal(f.ledger().filter(r => r.type === 'release-claim').length,1);
  assert.deepEqual(f.ledger().filter(r => r.type === 'claim').map(r => r.payload.claimOrdinal),[1,2]);
});

test('ledger: shared record cursor preserves independent scope consumption',() => {
  const f=fixture();
  const b={...f.b,scope:'B/s2'}; b.generation=generationOf(b);
  const bind=f.add('bind',b), id=obligationOf(b);
  const sourceRef=ref('loop.json'), source=[sourceRef.commit,sourceRef.path,sourceRef.sha256];
  const observe=(bindingRowId,obligationId) => f.add('observe',{bindingRowId,eventId:identity(['record-change',...source]),source:'record-change',sourceRef,terminalStatus:null,cursor:{ordinal:f.rows.length+1,previousRowHash:reduceRows(f.rows).previous,source},obligationId});
  observe(f.bind.rowId,f.id); f.consume(f.claim());
  observe(bind.rowId,id);
  const state=reduceRows(f.rows);
  assert.equal(state.obligations.get(f.id).consumed,true);
  assert.equal(state.obligations.get(f.id).conflict,false);
  assert.equal(state.obligations.get(id).conflict,false);
  const claimId=identity([raw(id),1,claimant]);
  f.add('claim',{obligationId:id,generation:b.generation,expectedHead:'a'.repeat(40),claimOrdinal:1,claimId,claimant});
  f.add('consume',{claimId,generation:b.generation,observedHead:'a'.repeat(40),cursor:state.obligations.get(id).cursor,consumeRefs:[ref()],disposition:'locally-reconciled'});
  assert.throws(() => observe(bind.rowId,id),/duplicate observation/);
  assert.equal(f.rows.filter(r => r.type === 'consume').length,2);
  assert.ok([...reduceRows(f.rows).obligations.values()].every(o => o.consumed && !o.conflict));
});

test('ledger: binding equality ignores object key order, preserves exact values',() => {
  const f=fixture();
  const reorder=value => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse().map(([k,v]) => [k,reorder(v)])) : value;
  const b=reorder(f.b);
  assert.ok(sameBinding(f.bind.payload,b));
  assert.notEqual(bytesHash(JSON.stringify(f.b)),bytesHash(JSON.stringify(b)));
  for(const key of ['parentThreadId','childThreadId','runId','scope']) assert.equal(sameBinding(f.bind.payload,{...b,[key]:'changed'}),false);
  assert.equal(sameBinding(f.bind.payload,{...b,planRef:{...b.planRef,sha256:'c'.repeat(64)}}),false);
});
test('integrated: reordered binding is idempotent and later record observation survives',async t => {
  const f=await integratedFixture(t);
  f.write('evidence/0001/reordered.json',Object.fromEntries(Object.entries(f.b).reverse())); f.commit();
  const binding=f.pointer('evidence/0001/reordered.json');
  const first=await f.api.capture(f.observation,binding,f.records);
  assert.ok(first.rowId);
  const again=await f.api.capture(f.observation,binding,f.records);
  assert.equal(again.rowId,first.rowId); assert.equal(again.commit,first.commit);
  const changed=await f.api.capture({source:'record-change',sourceRef:f.pointer('loop.json'),terminalStatus:null},binding,f.records);
  assert.ok(changed.rowId); assert.deepEqual(changed.unknowns,[]);
  assert.equal(f.ledger().filter(r => r.type === 'bind').length,1);
  f.write('evidence/0001/conflicting.json',{...f.b,parentThreadId:'different-parent'}); f.commit();
  await assert.rejects(f.api.capture(f.observation,f.pointer('evidence/0001/conflicting.json'),f.records),/conflicting binding/);
});
test('integrated: unsupported identity never steals an existing claim',async t => {
  if(hasProcessIdentity()) { t.skip('unsupported-identity branch requires actual missing capability'); return; }
  const f=await integratedFixture(t);
  const {transaction}=await import('../lib/continuation-store.mjs');
  const captured=await f.api.capture(f.observation,f.bindingRef,f.records);
  await transaction(f.records,(snap,rows,append) => {
    append('claim',{obligationId:captured.obligationId,generation:f.b.generation,expectedHead:snap.head,claimOrdinal:1,claimId:identity([raw(captured.obligationId),1,claimant]),claimant}); return {};
  });
  f.write('evidence/0001/death.json',{claimant,observation:'terminated'}); f.commit();
  f.parent.deathRefs=[f.pointer('evidence/0001/death.json')];
  const before=f.ledger();
  const result=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host);
  assertUnsupported(result,f.ledger()); assert.deepEqual(f.ledger(),before);
});
test('integrated: CLI explicit owner store wins over absent or conflicting environment and host bounds',async t => {
  const f=await integratedFixture(t);
  const {ownerStore}=await import('./helpers.mjs');
  const {writeFileSync,rmSync}=await import('node:fs');
  const {join}=await import('node:path');
  const {fileURLToPath}=await import('node:url');
  const {spawnSync}=await import('node:child_process');
  const other=ownerStore([{name:'fixture',records:f.records,aliases:[]}],{bound:{minAvailableMemoryGB:1e9}});
  const absent=ownerStore([]);
  t.after(() => { rmSync(other,{recursive:true,force:true}); rmSync(absent,{recursive:true,force:true}); });
  const input=join(f.dir,'parent-entry.json');
  writeFileSync(input,JSON.stringify({schema:'continuation-entry/v1',products:[{records:f.records,parentBinding:f.parent,hostObservation:f.host,observations:[{publicObservation:f.observation,bindingRef:f.bindingRef}]}]}));
  const cli=store => {
    const env={...process.env};
    if(store === null) delete env.SELF_LOOP_OWNER_STORE; else env.SELF_LOOP_OWNER_STORE=store;
    const result=spawnSync(process.execPath,[fileURLToPath(new URL('../self-loop.mjs',import.meta.url)),'start','--config',join(f.records,'loop.json'),'--owner-store',f.store,'--parent-entry',input,'--json'],{encoding:'utf8',env});
    assert.equal(result.error,undefined);
    assert.ok(result.stdout.trim(),result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.ownerStore,f.store);
    const product=report.continuation.products.find(p => p.records === f.records);
    assert.ok(product, result.stdout); assert.deepEqual(product.errors,[]);
    assert.ok(product.captures[0].rowId); assert.deepEqual(product.captures[0].unknowns,[]);
    return product;
  };
  for(const environment of [null,absent,other]) {
    const product=cli(environment);
    if(hasProcessIdentity()) assert.deepEqual(product.reconciliation.pending[0].ready,['ready']);
    else assertUnsupported(product.reconciliation,f.ledger());
  }
  const {resolveOwnerStore,hostLoad}=await import('../lib/registry.mjs');
  const selected=resolveOwnerStore({flag:f.store}), foreign=resolveOwnerStore({flag:other});
  assert.equal(hostLoad({store:selected,measure:() => f.host.measured}).admits,true);
  assert.equal(hostLoad({store:foreign,measure:() => f.host.measured}).admits,false);
  const blocked=await f.api.reconcileAtExistingParentEntry(f.records,f.parent,f.host,{store:foreign});
  if(hasProcessIdentity()) {
    assert.deepEqual(blocked.pending[0].ready,[]);
    assert.ok(blocked.pending[0].packages.find(p => p.id === 'ready').holds.some(h => h.kind === 'capacity'));
  } else assertUnsupported(blocked,f.ledger());
  assert.equal(f.ledger().filter(r => r.type === 'bind').length,1);
  assert.equal(f.ledger().filter(r => r.type === 'observe').length,1);
});
test('integrated: shared record duplicate returns its own binding row',async t => {
  const f=await integratedFixture(t);
  f.write('plans/PL-0002.md',{...f.plan,id:'PL-0002',scope:'B/s2'}); f.commit();
  const b={...f.b,scope:'B/s2',planRef:f.pointer('plans/PL-0002.md')}; b.generation=generationOf(b);
  f.write('evidence/0001/second-binding.json',b); f.commit();
  const second=f.pointer('evidence/0001/second-binding.json');
  const observation={source:'record-change',sourceRef:f.pointer('loop.json'),terminalStatus:null};
  const first=await f.api.capture(observation,f.bindingRef,f.records);
  const next=await f.api.capture(observation,second,f.records);
  assert.notEqual(first.rowId,next.rowId); assert.deepEqual(next.unknowns,[]);
  const repeat=await f.api.capture(observation,second,f.records);
  assert.equal(repeat.rowId,next.rowId); assert.equal(repeat.commit,next.commit);
  assert.ok([...reduceRows(f.ledger()).obligations.values()].every(o => !o.conflict));
});

test('integrated: canonical plan change before publication discards stale capture on CAS rebuild', async t => {
  const f=await integratedFixture(t);
  const cp=(await import('node:child_process')).default;
  const {syncBuiltinESMExports}=await import('node:module');
  const {existsSync}=await import('node:fs');
  const {join}=await import('node:path');
  const real=cp.spawnSync;
  let changed=false, advanced;
  cp.spawnSync=(command,args,options) => {
    if(!changed && command === 'git' && args.includes(f.records) && args.includes('commit-tree')) {
      changed=true;
      f.write('plans/PL-0001.md',{...f.plan,packages:f.plan.packages.map(p => ({...p,goal:p.goal+' revised'}))});
      advanced=f.commit();
    }
    return real(command,args,options);
  };
  syncBuiltinESMExports();
  let result;
  try { result=await f.api.capture(f.observation,f.bindingRef,f.records,{store:{path:f.store,source:'--owner-store'}}); }
  finally { cp.spawnSync=real; syncBuiltinESMExports(); }
  assert.equal(changed,true);
  assert.equal(result.commit,advanced);
  assert.equal(result.rowId,null);
  assert.match(result.unknowns.join(' '),/stale plan binding/);
  assert.equal(existsSync(join(f.records,'metrics/continuations.jsonl')),false);
});
