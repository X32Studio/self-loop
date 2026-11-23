// self-loop-records@d66cdb5:evidence/0010/continuation-response/contracts.json; b694377:serializationBinding.
import { createHash } from 'node:crypto';
export { isDeepStrictEqual as sameBinding } from 'node:util';

export const LEDGER = 'metrics/continuations.jsonl';
export const fields = Object.freeze({
  bind: 'productKey scope phase planRef delegationRef attemptRef nonce environmentId parentThreadId taskId childThreadId runId generation',
  observe: 'bindingRowId eventId source sourceRef terminalStatus cursor obligationId',
  claim: 'obligationId generation expectedHead claimOrdinal claimId claimant',
  intent: 'claimId intentId kind normalAttemptRef',
  'send-receipt': 'intentId threadId messageId runId delivery status',
  uncertain: 'claimId intentId reason evidenceRefs',
  'release-claim': 'claimId deathRef successorClaimOrdinal',
  consume: 'claimId generation observedHead cursor consumeRefs disposition',
  invalidate: 'obligationId reason authorityRefs',
});
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const bytesHash = value => createHash('sha256').update(value).digest('hex');
export const identity = value => `ct:${hash(value)}`;
export const raw = value => value.startsWith('ct:') ? value.slice(3) : value;
export const text = value => typeof value === 'string' && value.length > 0;
export const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const cid = value => typeof value === 'string' && /^ct:[a-f0-9]{64}$/.test(value);
export const revision = value => typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
export const exact = (value, names) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(' ') === names.split(' ').sort().join(' ');
export function demand(ok, why) { if (!ok) throw new Error(`continuation: ${why}`); }
export const publicPath = path => text(path) && /^(?:loop\.json|(?:plans|decisions|rounds|delegations|evidence|metrics|owner)\/[A-Za-z0-9._/-]+)$/.test(path) && !path.split('/').some(p => !p || p === '.' || p === '..' || /private|sealed|auth|secret|transcript|audit|\.log(?:\.|$)/i.test(p));
export const reference = r => exact(r, 'repository commit path sha256') && text(r.repository) && revision(r.commit) && publicPath(r.path) && hex(r.sha256);
const refs = xs => Array.isArray(xs) && xs.length > 0 && xs.every(reference);
export const claimantValid = c => exact(c, 'host bootId pid startId parentThreadId runId') && [c.host,c.bootId,c.startId].every(text) && Number.isSafeInteger(c.pid) && c.pid > 0 && (c.parentThreadId === null || text(c.parentThreadId)) && (c.runId === null || text(c.runId));
export const generationOf = b => identity([raw(b.productKey),b.phase,b.scope,b.planRef.path.match(/PL-\d{4}/)?.[0],b.planRef.sha256,b.delegationRef.sha256,b.nonce,b.environmentId,b.taskId,b.runId]);
export const obligationOf = b => identity(['reconcile',raw(b.productKey),b.phase,b.scope,raw(b.generation)]);
const terminal = s => ['completed','failed','cancelled','interrupted'].includes(s);
export const isTerminal = terminal;
function payload(type, input) {
  demand(Object.hasOwn(fields,type) && exact(input,fields[type]), `invalid ${type} fields`);
  const p = Object.fromEntries(fields[type].split(' ').map(k => [k,input[k]]));
  if (type === 'bind') {
    demand(cid(p.productKey) && cid(p.generation) && [p.scope,p.phase,p.environmentId,p.parentThreadId,p.taskId,p.childThreadId,p.runId].every(text), 'unknown binding identity');
    demand(reference(p.planRef) && /^plans\/PL-\d{4}\.md$/.test(p.planRef.path) && reference(p.delegationRef) && /^delegations\/T-\d{4}\.md$/.test(p.delegationRef.path) && (p.attemptRef === null || reference(p.attemptRef)) && (p.nonce === null || text(p.nonce)), 'binding references');
    demand(p.attemptRef === null || text(p.nonce), 'attempt nonce missing');
    demand(p.generation === generationOf(p), 'generation mismatch');
  } else if (type === 'observe') {
    demand(cid(p.bindingRowId) && cid(p.eventId) && cid(p.obligationId) && reference(p.sourceRef), 'observation identity');
    demand(['t3-terminal','record-change'].includes(p.source) && (p.source === 't3-terminal' ? terminal(p.terminalStatus) : p.terminalStatus === null), 'observation status');
    demand(exact(p.cursor,'ordinal previousRowHash source') && Number.isSafeInteger(p.cursor.ordinal) && p.cursor.ordinal > 0 && (p.cursor.previousRowHash === null || hex(p.cursor.previousRowHash)), 'cursor');
    demand(p.source === 't3-terminal' ? p.cursor.source === null : Array.isArray(p.cursor.source) && p.cursor.source.length === 3 && revision(p.cursor.source[0]) && publicPath(p.cursor.source[1]) && hex(p.cursor.source[2]), 'source cursor');
  } else if (type === 'claim') {
    demand([p.obligationId,p.generation,p.claimId].every(cid) && revision(p.expectedHead) && Number.isSafeInteger(p.claimOrdinal) && p.claimOrdinal > 0 && claimantValid(p.claimant), 'claim');
    demand(p.claimId === identity([raw(p.obligationId),p.claimOrdinal,p.claimant]), 'claim ID');
  } else if (type === 'intent') {
    demand(cid(p.claimId) && cid(p.intentId) && ['parent-send','ordinary-entry'].includes(p.kind) && (p.normalAttemptRef === null || reference(p.normalAttemptRef)), 'intent');
  } else if (type === 'send-receipt') {
    demand(cid(p.intentId) && [p.threadId,p.messageId,p.runId,p.delivery,p.status].every(text), 'send receipt');
  } else if (type === 'uncertain') {
    demand(cid(p.claimId) && cid(p.intentId) && text(p.reason) && refs(p.evidenceRefs), 'uncertainty');
  } else if (type === 'release-claim') {
    demand(cid(p.claimId) && reference(p.deathRef) && Number.isSafeInteger(p.successorClaimOrdinal) && p.successorClaimOrdinal > 1, 'release');
  } else if (type === 'consume') {
    demand(cid(p.claimId) && cid(p.generation) && revision(p.observedHead) && refs(p.consumeRefs) && ['locally-reconciled','accountable-wait'].includes(p.disposition), 'consume');
  } else if (type === 'invalidate') {
    demand(cid(p.obligationId) && ['superseded','completed'].includes(p.reason) && refs(p.authorityRefs), 'invalidate');
  }
  return p;
}
export function makeRow(type, input, previousRowHash, recordedAt = new Date().toISOString()) {
  demand(previousRowHash === null || hex(previousRowHash), 'previous row hash');
  demand(typeof recordedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(recordedAt) && Number.isFinite(Date.parse(recordedAt)), 'recordedAt');
  const p = payload(type,input);
  return { schema:'continuation-row/v1', type, rowId:identity([previousRowHash,p]), previousRowHash, recordedAt, payload:p };
}
export function reduceRows(rows) {
  const bindings = new Map(), obligations = new Map(), claims = new Map(), intents = new Map(), events = new Map();
  let previous = null;
  for (let i=0;i<rows.length;i++) {
    const r=rows[i];
    demand(exact(r,'schema type rowId previousRowHash recordedAt payload') && r.schema === 'continuation-row/v1', 'row schema');
    const expected=makeRow(r.type,r.payload,previous,r.recordedAt);
    demand(JSON.stringify(r) === JSON.stringify(expected), 'row chain, hash or field order');
    const p=r.payload;
    if (r.type === 'bind') {
      demand(![...bindings.values()].some(b => b.generation === p.generation), 'duplicate binding');
      bindings.set(r.rowId,p);
    } else if (r.type === 'observe') {
      const b=bindings.get(p.bindingRowId);
      demand(b && obligationOf(b) === p.obligationId, 'unbound observation');
      demand(p.cursor.ordinal === i+1 && p.cursor.previousRowHash === previous, 'local cursor mismatch');
      const eventId=p.source === 't3-terminal' ? identity(['t3-terminal',b.environmentId,b.taskId,b.runId]) : identity(['record-change',...p.cursor.source]);
      demand(p.eventId === eventId, 'event ID mismatch');
      demand(p.source !== 'record-change' || JSON.stringify(p.cursor.source) === JSON.stringify([p.sourceRef.commit,p.sourceRef.path,p.sourceRef.sha256]), 'record source cursor mismatch');
      const prior=events.get(p.eventId) ?? [];
      demand(!prior.some(o => o.terminalStatus === p.terminalStatus && o.bindingRowId === p.bindingRowId), 'duplicate observation');
      prior.push(p); events.set(p.eventId,prior);
      let o=obligations.get(p.obligationId);
      if (!o) { o={binding:b,ordinal:0,claim:null,consumed:false,invalidated:false,conflict:false,cursor:p.cursor}; obligations.set(p.obligationId,o); }
      o.cursor=p.cursor;
      if (p.source === 't3-terminal' && prior.some(x => x.terminalStatus !== p.terminalStatus || x.bindingRowId !== p.bindingRowId)) {
        for (const event of prior) { const old=obligations.get(event.obligationId); if(old) { old.conflict=true; old.consumed=false; } }
      } else o.consumed=false;
    } else if (r.type === 'claim') {
      const o=obligations.get(p.obligationId);
      demand(o && !o.invalidated && !o.consumed && !o.conflict && !o.claim && p.generation === o.binding.generation && p.claimOrdinal === o.ordinal+1, 'stale or conflicting claim');
      o.ordinal=p.claimOrdinal; o.claim=p; claims.set(p.claimId,{payload:p,obligation:o,intent:null,uncertain:false,released:false,consumed:false});
    } else if (r.type === 'invalidate') {
      const o=obligations.get(p.obligationId); demand(o && !o.invalidated,'invalid invalidation'); o.invalidated=true;
    } else {
      const c=r.type === 'send-receipt' ? claims.get(intents.get(p.intentId)?.claimId) : claims.get(p.claimId);
      demand(c && !c.released && !c.consumed && !c.obligation.invalidated, 'stale claim token');
      if (r.type === 'intent') {
        demand(!c.intent && p.intentId === identity([raw(c.payload.obligationId),c.payload.claimOrdinal,p.kind]),'intent ID or duplicate intent');
        c.intent=p; intents.set(p.intentId,p);
      } else if (r.type === 'send-receipt') {
        demand(c.intent && !c.receipt,'receipt without intent or duplicate'); c.receipt=p;
      } else if (r.type === 'uncertain') {
        demand(c.intent?.intentId === p.intentId,'uncertain intent mismatch'); c.uncertain=true;
      } else if (r.type === 'release-claim') {
        demand(!c.intent && p.successorClaimOrdinal === c.payload.claimOrdinal+1,'unsafe claim release');
        c.released=true; c.obligation.claim=null;
      } else if (r.type === 'consume') {
        demand(!c.intent && !c.obligation.conflict && p.generation === c.payload.generation && JSON.stringify(p.cursor) === JSON.stringify(c.obligation.cursor), 'unsafe or stale consumption');
        c.consumed=true; c.obligation.consumed=true; c.obligation.claim=null;
      }
    }
    previous=bytesHash(JSON.stringify(r));
  }
  return {bindings,obligations,claims,events,previous};
}
export function parseLedger(bytes) {
  demand(!bytes || bytes.endsWith('\n'), 'unterminated ledger');
  const rows=bytes ? bytes.slice(0,-1).split('\n').map(line => JSON.parse(line)) : [];
  reduceRows(rows); return rows;
}
export async function transaction(records, build) {
  const {commitRecords}=await import('./records-commit.mjs');
  const result=commitRecords(records,snap => {
    const old=snap.read(LEDGER), rows=parseLedger(old), initial=rows.length;
    const append=(type,p) => {
      const row=makeRow(type,p,reduceRows(rows).previous);
      reduceRows([...rows,row]); rows.push(row); return row;
    };
    const value=build(snap,rows,append);
    if(rows.length > initial) {
      const layout=JSON.parse(snap.read('records.json') || '{}');
      demand(layout.extraKinds?.some(k => k.kind === 'Continuation delivery' && k.path === LEDGER && k.changes === 'append-only' && k.settlesOwnerWords === false),'coordinator must publish Continuation delivery extraKind');
      snap.add(LEDGER,old+rows.slice(initial).map(r => JSON.stringify(r)+'\n').join(''));
    }
    return {message:'Record local continuation reconciliation',value};
  });
  return {commit:result.commit,...result.value};
}
