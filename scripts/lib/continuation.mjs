// self-loop-records@d66cdb5:evidence/0010/continuation-response/contracts.json; b694377:public.md.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { bytesHash, sameBinding, identity, raw, exact, text, demand, reference, claimantValid, generationOf, obligationOf, isTerminal, reduceRows, transaction } from './continuation-store.mjs';

function processIdentity(pid) {
  try {
    const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
    return {host:hostname(),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid,startId:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]};
  } catch { return null; }
}
function ancestor(repo, a, b) {
  return spawnSync('git',['-C',repo,'merge-base','--is-ancestor',a,b],{encoding:'utf8'}).status === 0;
}
function refAt(state,path) {
  demand(state.files.has(path),`missing canonical reference ${path}`);
  return {repository:state.records,commit:state.revision,path,sha256:bytesHash(state.bytes(path))};
}
async function dependencies() {
  const [plan,registry,plumbing]=await Promise.all([import('./plan.mjs'),import('./registry.mjs'),import('./git-plumbing.mjs')]);
  return {plan,registry,plumbing};
}
function context(records,head,deps,options) {
  const {plan,registry,plumbing}=deps;
  const repo=registry.real(records);
  const store=options.store ?? registry.resolveOwnerStore();
  const registered=registry.loadRegistry(store).products.filter(p => registry.real(p.records) === repo);
  demand(registered.length === 1,'records must have one canonical registry identity');
  const state=plan.snapshot(repo,head);
  function readRef(ref) {
    demand(reference(ref) && registry.real(ref.repository) === repo && ref.repository === repo,'invalid, private or foreign reference');
    demand(ancestor(repo,ref.commit,head),'reference is not an ancestor of this snapshot');
    const pinned=plan.snapshot(repo,ref.commit);
    demand(pinned.files.has(ref.path),'missing regular public reference');
    const bytes=pinned.bytes(ref.path);
    demand(bytesHash(bytes) === ref.sha256,'reference digest mismatch');
    return bytes.toString('utf8');
  }
  return {state,readRef,store,productKey:identity([repo]),plan,plumbing,repo};
}
function validateReferences(c,rows) {
  const cursors=new Map();
  for(const row of rows) {
    const p=row.payload;
    const refs=[p.planRef,p.delegationRef,p.attemptRef,p.sourceRef,p.normalAttemptRef,p.deathRef,...(p.consumeRefs ?? []),...(p.authorityRefs ?? []),...(p.evidenceRefs ?? [])].filter(Boolean);
    for(const ref of refs) c.readRef(ref);
    if(row.type === 'observe' && p.source === 'record-change') {
      const key=JSON.stringify([p.bindingRowId,p.sourceRef.path]);
      const old=cursors.get(key);
      demand(!old || ancestor(c.repo,old,p.sourceRef.commit),'nonancestor source cursor in ledger');
      cursors.set(key,p.sourceRef.commit);
    }
  }
}
function bindingFrom(ref,c) {
  const b=JSON.parse(c.readRef(ref));
  demand(exact(b,'productKey scope phase planRef delegationRef attemptRef nonce environmentId parentThreadId taskId childThreadId runId generation'),'binding receipt fields');
  demand(b.productKey === c.productKey && b.generation === generationOf(b),'binding identity mismatch');
  c.readRef(b.planRef); c.readRef(b.delegationRef);
  if(b.attemptRef !== null) {
    const attempt=JSON.parse(c.readRef(b.attemptRef));
    demand(text(b.nonce) && attempt.nonce === b.nonce,'normal attempt nonce mismatch');
  } else demand(b.nonce === null,'coordinator binding uses delegation identity, not a guessed nonce');
  const pinned=c.plan.snapshot(c.repo,b.planRef.commit);
  const plan=c.plan.loadPlan(pinned,b.planRef.path.match(/PL-\d{4}/)?.[0]);
  demand(plan.scope === b.scope && plan.phase === b.phase,'binding plan scope mismatch');
  return b;
}
function view(c,host) {
  const plans=c.plan.plansFrom(c.state), entries=[];
  for(const p of plans.filter(p => !plans.some(q => q.supersedes === p.id))) {
    const plan=c.plan.loadPlan(c.state,p.id);
    const ctx=c.plan.planContext(c.state,plan);
    const result=c.plan.readyPlan(c.state,plan,{context:ctx,host});
    entries.push({plan,result,ctx});
  }
  c.plan.admitAcrossPlans(entries);
  return entries;
}
function canonicalRefs(c,entry) {
  const paths=new Set([`plans/${entry.plan.id}.md`,'loop.json']);
  for(const p of entry.plan.packages) for(const a of p.authority) paths.add(c.plan.recordPath(a));
  for(const path of c.state.files) if(path.startsWith('owner/') || path === 'metrics/handoffs.jsonl' || path === 'metrics/trajectory.jsonl') paths.add(path);
  for(const h of entry.ctx.handoffs) if(h.phase === entry.plan.phase && c.state.files.has(h.record)) paths.add(h.record);
  return [...paths].sort().map(path => refAt(c.state,path));
}
function waiting(id,o,blocker,extra={}) {
  return {obligationId:id,generation:o.binding.generation,scope:o.binding.scope,owner:{environmentId:o.binding.environmentId,parentThreadId:o.binding.parentThreadId},nextTrigger:'next actual parent entry; independent receiver unavailable',blocker,...extra};
}
export async function capture(publicObservation,bindingRef,records,options={}) {
  const deps=await dependencies();
  return transaction(records,(snap,rows,append) => {
    let b,c;
    try {
      c=context(records,snap.head,deps,options); validateReferences(c,rows); b=bindingFrom(bindingRef,c);
      demand(exact(publicObservation,'source sourceRef terminalStatus'),'public observation fields');
      demand(['t3-terminal','record-change'].includes(publicObservation.source),'unknown source');
      const source=c.readRef(publicObservation.sourceRef);
      if(publicObservation.source === 't3-terminal') {
        const receipt=JSON.parse(source);
        demand([b.environmentId,b.taskId,b.runId].every(text) && receipt.environmentId === b.environmentId && receipt.taskId === b.taskId && (receipt.latestTerminalRunId ?? receipt.runId) === b.runId && (receipt.latestTerminalStatus ?? receipt.status) === publicObservation.terminalStatus,'missing exact public task/run mapping');
        if(!isTerminal(publicObservation.terminalStatus)) return {rowId:null,obligationId:null,unknowns:['nonterminal observation ignored; prior terminal remains absorbing']};
      } else demand(publicObservation.terminalStatus === null,'record observation has no terminal status');
      const current=c.plan.loadPlan(c.state,b.planRef.path.match(/PL-\d{4}/)[0]);
      demand(bytesHash(c.state.bytes(b.planRef.path)) === b.planRef.sha256 && !c.plan.plansFrom(c.state).some(p => p.supersedes === current.id),'stale plan binding');
    } catch(e) { return {rowId:null,obligationId:null,unknowns:[e.message]}; }
    let folded=reduceRows(rows);
    let bindingRowId=[...folded.bindings].find(([,x]) => x.generation === b.generation)?.[0];
    if(bindingRowId) demand(sameBinding(folded.bindings.get(bindingRowId),b),'conflicting binding receipt');
    else {
      try { bindingRowId=append('bind',b).rowId; } catch(e) { return {rowId:null,obligationId:null,unknowns:[e.message]}; }
    }
    const {source,sourceRef,terminalStatus}=publicObservation;
    const sourceCursor=source === 't3-terminal' ? null : [sourceRef.commit,sourceRef.path,sourceRef.sha256];
    const eventId=source === 't3-terminal' ? identity(['t3-terminal',b.environmentId,b.taskId,b.runId]) : identity(['record-change',...sourceCursor]);
    const obligationId=obligationOf(b);
    folded=reduceRows(rows);
    const prior=folded.events.get(eventId) ?? [];
    if(prior.some(p => p.bindingRowId === bindingRowId && p.terminalStatus === terminalStatus)) return {rowId:rows.find(r => r.type === 'observe' && r.payload.eventId === eventId && r.payload.bindingRowId === bindingRowId && r.payload.terminalStatus === terminalStatus)?.rowId ?? null,obligationId,unknowns:folded.obligations.get(obligationId)?.conflict ? ['conflicting terminal observations'] : []};
    if(source === 'record-change') {
      const old=rows.filter(r => r.type === 'observe' && r.payload.bindingRowId === bindingRowId && r.payload.source === source && r.payload.sourceRef.path === sourceRef.path).at(-1);
      if(old && !ancestor(c.repo,old.payload.sourceRef.commit,sourceRef.commit)) return {rowId:null,obligationId:null,unknowns:['nonancestor source cursor']};
    }
    const cursor={ordinal:rows.length+1,previousRowHash:reduceRows(rows).previous,source:sourceCursor};
    const row=append('observe',{bindingRowId,eventId,source,sourceRef,terminalStatus,cursor,obligationId});
    return {rowId:row.rowId,obligationId,unknowns:reduceRows(rows).obligations.get(obligationId).conflict ? ['conflicting terminal observations'] : []};
  });
}
export async function reconcileAtExistingParentEntry(records,parentBinding,hostObservation,options={}) {
  const deps=await dependencies();
  return transaction(records,(snap,rows,append) => {
    const pending=[],unknowns=[],allRefs=[];
    let consumeRowId=null,c,entries;
    const folded=reduceRows(rows);
    try {
      demand(exact(parentBinding,'environmentId parentThreadId runId deathRefs') && [parentBinding.environmentId,parentBinding.parentThreadId,parentBinding.runId].every(text) && Array.isArray(parentBinding.deathRefs) && parentBinding.deathRefs.every(reference),'unknown parent identity');
      c=context(records,snap.head,deps,options);
      validateReferences(c,rows);
      demand(exact(hostObservation,'measured') && exact(hostObservation.measured,'load1 cores availableGiB totalGiB load memory total'), 'missing measured host observation');
      const m=hostObservation.measured;
      demand(['load1','cores','availableGiB','totalGiB'].every(k => Number.isFinite(m[k]) && m[k] >= 0) && m.cores > 0 && m.totalGiB > 0 && ['load','memory','total'].every(k => text(m[k])), 'invalid host measurement');
      const host=deps.registry.hostLoad({store:c.store,measure:() => m});
      entries=view(c,host);
    } catch(e) {
      return {consumeRowId,pending:[...folded.obligations].filter(([,o]) => !o.invalidated && !o.consumed).map(([id,o]) => waiting(id,o,e.message)),canonicalRefs:[],unknowns:[e.message]};
    }
    const proc=processIdentity(process.pid);
    const claimant=proc && {...proc,parentThreadId:parentBinding.parentThreadId,runId:parentBinding.runId};
    for(const [id,o] of folded.obligations) {
      if(o.invalidated) continue;
      const b=o.binding;
      if(b.productKey !== c.productKey) { unknowns.push('foreign ledger product binding'); continue; }
      const entry=entries.find(e => e.plan.phase === b.phase && e.plan.scope === b.scope);
      if(!entry) { if(!o.consumed) pending.push(waiting(id,o,'canonical plan unavailable')); continue; }
      const refs=canonicalRefs(c,entry); allRefs.push(...refs);
      const planRef=refs.find(r => r.path === `plans/${entry.plan.id}.md`);
      if(planRef.path !== b.planRef.path) {
        let ancestorPlan=entry.plan;
        const all=c.plan.plansFrom(c.state);
        const seen=new Set();
        while(ancestorPlan?.supersedes && !seen.has(ancestorPlan.id) && `plans/${ancestorPlan.id}.md` !== b.planRef.path) { seen.add(ancestorPlan.id); ancestorPlan=all.find(p => p.id === ancestorPlan.supersedes); }
        if(ancestorPlan && `plans/${ancestorPlan.id}.md` === b.planRef.path) append('invalidate',{obligationId:id,reason:'superseded',authorityRefs:refs});
        else pending.push(waiting(id,o,'plan supersession chain unknown'));
        continue;
      }
      if(planRef.sha256 !== b.planRef.sha256) { pending.push(waiting(id,o,'plan changed in place; explicit new binding required')); continue; }
      if(entry.result.packages.every(p => p.status === 'done')) { append('invalidate',{obligationId:id,reason:'completed',authorityRefs:refs}); continue; }
      const packages=entry.result.packages.filter(p => p.status !== 'done').map(p => ({...p,owner:{environmentId:b.environmentId,parentThreadId:b.parentThreadId},nextTrigger:p.status === 'running' ? 'exact child terminal or ordinary attempt reconciliation' : p.holds.length ? p.holds.map(h => h.release).join('; ') : 'ordinary authorized preparation on actual parent entry'}));
      const summary=waiting(id,o,'canonical work remains; local consumption does not deliver packages',{packages,ready:entry.result.ready,unchecked:entry.result.unchecked});
      if(o.consumed) { pending.push(summary); continue; }
      if(b.environmentId !== parentBinding.environmentId || b.parentThreadId !== parentBinding.parentThreadId) { pending.push(waiting(id,o,'different parent binding; actual owning parent entry required')); continue; }
      if(o.conflict) { pending.push(waiting(id,o,'conflicting terminal observations')); unknowns.push('conflicting terminal observations'); continue; }
      const siblings=[...folded.bindings.values()].filter(x => x.delegationRef.path === b.delegationRef.path && x.scope === b.scope && x.phase === b.phase && x.generation !== b.generation);
      if(siblings.some(x => x.delegationRef.sha256 === b.delegationRef.sha256)) { pending.push(waiting(id,o,'multiple run bindings without explicit replacement delegation; current generation unknown')); continue; }
      if(siblings.some(x => ancestor(c.repo,b.delegationRef.commit,x.delegationRef.commit) && x.delegationRef.sha256 !== b.delegationRef.sha256)) { pending.push(waiting(id,o,'replacement delegation binding; old generation cannot claim current work')); continue; }
      if(!claimantValid(claimant)) { pending.push(waiting(id,o,'local boot/start identity unavailable')); continue; }
      if(o.claim) {
        const claim=folded.claims.get(o.claim.claimId);
        if(claim.intent) { pending.push(waiting(id,o,claim.receipt ? 'send receipt is not application consumption' : 'intent exists; delivery uncertain, no replay')); continue; }
        const old=claim.payload.claimant;
        const live=processIdentity(old.pid);
        const sameHost=old.host === proc.host && old.bootId === proc.bootId;
        let deathRef=null;
        if(sameHost && live === null) for(const ref of parentBinding.deathRefs) {
          try {
            const proof=JSON.parse(c.readRef(ref));
            if(exact(proof,'claimant observation') && JSON.stringify(proof.claimant) === JSON.stringify(old) && proof.observation === 'terminated') {
              try { process.kill(old.pid,0); } catch(e) { if(e.code === 'ESRCH') deathRef=ref; }
            }
          } catch {}
        }
        if(!deathRef) { pending.push(waiting(id,o,'claimant death unverified; no timeout or PID-reuse steal')); continue; }
        append('release-claim',{claimId:claim.payload.claimId,deathRef,successorClaimOrdinal:o.ordinal+1});
      }
      const claimOrdinal=o.ordinal+1,claimId=identity([raw(id),claimOrdinal,claimant]);
      append('claim',{obligationId:id,generation:b.generation,expectedHead:snap.head,claimOrdinal,claimId,claimant});
      consumeRowId=append('consume',{claimId,generation:b.generation,observedHead:snap.head,cursor:o.cursor,consumeRefs:refs,disposition:packages.some(p => p.holds.length) ? 'accountable-wait' : 'locally-reconciled'}).rowId;
      pending.push(summary);
    }
    return {consumeRowId,pending,canonicalRefs:[...new Map(allRefs.map(r => [JSON.stringify(r),r])).values()],unknowns:[...new Set(unknowns)]};
  });
}
