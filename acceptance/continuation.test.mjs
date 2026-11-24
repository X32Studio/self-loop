// D-0060
import assert from 'node:assert/strict';
import nodeTest from 'node:test';
const modelOnly = process.env.CT_PROFILE === 'model';
const linuxIdentity = process.platform === 'linux' && existsSync('/proc/sys/kernel/random/boot_id');
const test = modelOnly || !linuxIdentity ? () => {} : nodeTest;
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile, execFileSync, fork } from 'node:child_process';
import { hostname } from 'node:os';
import { once } from 'node:events';
const { mechanisms, pkg, at, planText } = modelOnly ? {} : await import('./v1-round9-fixture.mjs');
const { put, json } = modelOnly ? {} : await import('./fixture.mjs');
const { snapshot, loadPlan, planContext, readyPlan, admitAcrossPlans, releaseOf } = modelOnly ? {} : await import('../scripts/lib/plan.mjs');
const moduleURL = new URL('../scripts/lib/continuation.mjs', import.meta.url).href;

const H = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const digest = x => createHash('sha256').update(x).digest('hex');
const ID = x => `ct:${H(x)}`;
const ledger = 'metrics/continuations.jsonl';
const host = { admits: true, over: [], calls: [], cores: 20, load: 0.25, availableGB: 32 };
const measured = { measured: { load1: 0.25, cores: 20, availableGiB: 32, totalGiB: 64, load: 'fixture', memory: 'fixture', total: 'fixture' } };
const keys = {
  bind: ['productKey','scope','phase','planRef','delegationRef','attemptRef','nonce','environmentId','parentThreadId','taskId','childThreadId','runId','generation'],
  observe: ['bindingRowId','eventId','source','sourceRef','terminalStatus','cursor','obligationId'],
  claim: ['obligationId','generation','expectedHead','claimOrdinal','claimId','claimant'],
  intent: ['claimId','intentId','kind','normalAttemptRef'],
  'send-receipt': ['intentId','threadId','messageId','runId','delivery','status'],
  uncertain: ['claimId','intentId','reason','evidenceRefs'],
  'release-claim': ['claimId','deathRef','successorClaimOrdinal'],
  consume: ['claimId','generation','observedHead','cursor','consumeRefs','disposition'],
  invalidate: ['obligationId','reason','authorityRefs'],
};

function rows(f) {
  const s = snapshot(f.p.records);
  const bytes = s.read(ledger);
  if (!bytes) return [];
  assert.ok(bytes.endsWith('\n'));
  const result = bytes.trimEnd().split('\n').map(JSON.parse);
  let previous = null;
  for (const r of result) {
    assert.deepEqual(Object.keys(r), ['schema','type','rowId','previousRowHash','recordedAt','payload']);
    assert.equal(r.schema, 'continuation-row/v1');
    assert.equal(r.previousRowHash, previous);
    assert.deepEqual(Object.keys(r.payload), keys[r.type]);
    assert.equal(r.rowId, ID([previous, r.payload]));
    previous = digest(JSON.stringify(r));
  }
  return result;
}

function ref(f, path) {
  const s = snapshot(f.p.records);
  assert.ok(s.files.has(path), path);
  return { repository: f.p.records, commit: s.revision, path, sha256: digest(s.bytes(path)) };
}

function canonical(f, id = f.planId ?? 'PL-0001') {
  const s = snapshot(f.p.records), plan = loadPlan(s, id), context = planContext(s, plan);
  const result = readyPlan(s, plan, { context, host });
  admitAcrossPlans([{ plan, result }]);
  return { s, plan, context, result };
}

function fixture(t, { scope = 'A/s1', external = false, review = false } = {}) {
  const f = mechanisms(t);
  put(f.p.records, 'decisions/D-0001.md', '# D-0001\nid: D-0001\nby: owner\nstatus: active\nAuthorize only ready and secure fixture goals.\n');
  put(f.p.records, 'decisions/D-0002.md', '# D-0002\nid: D-0002\nby: owner\nstatus: active\nAuthorize final review only; implementation is not authorized.\n');
  const declaration = JSON.parse(readFileSync(join(f.p.records, 'records.json'), 'utf8'));
  declaration.extraKinds.push({ kind: 'Continuation delivery', path: ledger, changes: 'append-only', settlesOwnerWords: false });
  declaration.extraKinds.push({ kind: 'Delegation', path: 'delegations/T-NNNN.md', changes: 'append-only' });
  put(f.p.records, 'records.json', json(declaration));
  f.publish('Fixture continuation declarations', at(2));
  if (external) assert.equal(f.sendBatch(1, at(3)), 'B-0001');
  f.items = review ? [pkg('final-review', { role: 'judge', round: 1, authority: 'D-0002', step: 'judge-final' })] : [
    pkg('ready', { round: 1, authority: 'D-0001', ...(external ? { hold: 'external approval', release: 'B-0001' } : {}) }),
    pkg('secure', { round: 1, authority: 'D-0001', hold: 'security refusal', release: 'explicit security resolution' }),
  ];
  f.plan('PL-0001', f.items, { scope });
  f.scope = scope;
  f.effectFile = join(f.w.dir, 'effects.jsonl');
  for (const name of ['t3','claude','codex','gh','crontab','launchctl']) {
    const script = `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(f.effectFile)}, JSON.stringify({command:${JSON.stringify(name)},args:process.argv.slice(2)})+'\\n');process.exit(78);\n`;
    chmodSync(put(f.w.bin, name, script), 0o755);
  }
  f.env = { PATH: `${f.w.bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: f.w.home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid', SELF_LOOP_OWNER_STORE: f.w.owner, SELF_LOOP_ADAPTERS: 'none' };
  t.after(() => assert.equal(existsSync(f.effectFile) ? readFileSync(f.effectFile, 'utf8') : '', '', 'local profile must make zero external CLI effects'));
  return f;
}

function binding(f, suffix = 'one', runId = `run-${suffix}`) {
  const path = `delegations/T-${suffix === 'independent' ? '0002' : '0001'}.md`;
  const prior = suffix === 'two' ? snapshot(f.p.records).read(path) : '';
  put(f.p.records, path, prior + `# Fixture coordinator\nOwner: root\nScope: ${f.scope}\nBrief: reconcile canonical plans at actual parent entry\nNonce: coordinator-${suffix}\n`);
  f.publish(`Public delegation ${suffix}`, at(21));
  const planRef = ref(f, `plans/${f.planId ?? 'PL-0001'}.md`), delegationRef = ref(f, path);
  const productKey = ID([f.p.records]), nonce = null;
  const b = { productKey, scope: f.scope, phase: 'v1', planRef, delegationRef, attemptRef: null, nonce,
    environmentId: 'fixture-host', parentThreadId: 'root', taskId: `task-${suffix}`, childThreadId: `child-${suffix}`, runId };
  b.generation = ID([productKey.slice(3), b.phase, b.scope, f.planId ?? 'PL-0001', planRef.sha256, delegationRef.sha256, nonce, b.environmentId, b.taskId, runId]);
  const receipt = `evidence/0001/continuation-binding-${suffix}.json`;
  put(f.p.records, receipt, json(b)); f.publish('Public launch binding', at(22));
  f.bindings ??= new Map(); f.bindings.set(b, ref(f, receipt));
  return b;
}

function observation(f, b, status = 'failed') {
  f.receipts ??= new Map();
  const key = JSON.stringify([b.generation,status]);
  if (f.receipts.has(key)) return f.receipts.get(key);
  const path = `evidence/0001/continuation-terminal-${H([key])}.json`;
  put(f.p.records, path, json({ environmentId:b.environmentId, taskId:b.taskId, runId:b.runId, status }));
  f.publish('Public terminal receipt', at(23));
  const o = { source:'t3-terminal', sourceRef:ref(f,path), terminalStatus:status };
  f.receipts.set(key,o); return o;
}
function invoke(f, method, args, extraEnv = {}) {
  const script = `const m=await import(${JSON.stringify(moduleURL)});const r=await m[process.argv[1]](...JSON.parse(process.argv[2]));process.stdout.write(JSON.stringify(r));`;
  return new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module','-e',script,method,JSON.stringify(args)],
    { cwd: f.w.dir, env: { ...f.env, ...extraEnv }, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${method}: ${stderr || error.message}`));
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    }));
}
const observe = (f, b, status) => invoke(f, 'capture', [observation(f, b, status), f.bindings.get(b), f.p.records]);
const enter = (f, b, extra = {}, env = {}) => invoke(f, 'reconcileAtExistingParentEntry', [f.p.records,
  { environmentId: b.environmentId, parentThreadId: 'root', runId: 'actual-parent-entry', deathRefs: [], ...extra }, measured], env);

async function concurrentEntries(f, b) {
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const arrivals = join(f.w.dir, 'cas-arrivals'), release = join(f.w.dir, 'cas-release');
  const proxy = `#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process'), args=process.argv.slice(2);
if(process.env.CT_CAS_BARRIER && args.includes('commit-tree') && !fs.existsSync(${JSON.stringify(release)})) {
 fs.appendFileSync(${JSON.stringify(arrivals)}, process.pid+'\\n');
 const stop=Date.now()+10000;
 while(!fs.existsSync(${JSON.stringify(release)})) { if(Date.now()>stop) process.exit(79); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10); }
}
const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(r.status??80);
`;
  chmodSync(put(f.w.bin, 'git', proxy), 0o755);
  const attempts = [enter(f,b,{}, { CT_CAS_BARRIER:'1' }),enter(f,b,{}, { CT_CAS_BARRIER:'1' })];
  const settled = Promise.allSettled(attempts);
  const deadline = Date.now()+12000;
  while ((!existsSync(arrivals) || readFileSync(arrivals,'utf8').trim().split('\n').length < 2) && Date.now()<deadline)
    await new Promise(resolve => setTimeout(resolve,10));
  const count = existsSync(arrivals) ? readFileSync(arrivals,'utf8').trim().split('\n').length : 0;
  put(f.w.dir, 'cas-release', 'release');
  const results = await settled;
  assert.equal(count, 2, 'both candidate writers must reach the pre-publication barrier');
  for (const r of results) assert.equal(r.status, 'fulfilled', String(r.reason));
}

const typed = (f, type) => rows(f).filter(r => r.type === type);
const pending = (f, obligation) => {
  const all = rows(f), o = all.find(r => r.type === 'observe' && r.payload.obligationId === obligation);
  assert.ok(o, 'accepted observation durable in HEAD');
  const bind = all.find(r => r.rowId === o.payload.bindingRowId);
  assert.equal(bind.payload.parentThreadId, 'root');
  assert.equal(typed(f, 'consume').length, 0, 'no actual entry means no consumption');
  assert.equal(typed(f, 'send-receipt').length, 0, 'no transport means no delivery receipt');
  return bind;
};
const consumed = f => {
  const c = typed(f, 'consume');
  assert.equal(c.length, 1);
  assert.ok(c[0].payload.consumeRefs.length > 0);
  for (const r of c[0].payload.consumeRefs) {
    assert.equal(r.repository, f.p.records);
    const s = snapshot(r.repository, r.commit);
    assert.equal(digest(s.bytes(r.path)), r.sha256);
  }
  return c[0];
};

function seed(f, type, payload) {
  const old = rows(f), previousRowHash = old.length ? digest(JSON.stringify(old.at(-1))) : null;
  const ordered = Object.fromEntries(keys[type].map(k => [k, payload[k]]));
  assert.ok(Object.values(ordered).every(v => v !== undefined));
  const row = { schema: 'continuation-row/v1', type, rowId: ID([previousRowHash, ordered]), previousRowHash,
    recordedAt: at(50), payload: ordered };
  put(f.p.records, ledger, snapshot(f.p.records).read(ledger) + JSON.stringify(row) + '\n');
  f.publish(`Fixture durable ${type}`, at(50));
  return row;
}
function claim(f, b, obligationId, claimant = { host: 'fixture-host', bootId: 'boot-a', pid: 2147483647, startId: 'start-a', parentThreadId: 'root', runId: 'dead-entry' }) {
  return seed(f, 'claim', { obligationId, generation: b.generation, expectedHead: snapshot(f.p.records).revision,
    claimOrdinal: 1, claimId: ID([obligationId.slice(3), 1, claimant]), claimant });
}

 test('A_FAIL_B_CONTINUES: actual later entry preserves A ready and security hold while B completes', async t => {
  const a = fixture(t), b = fixture(t, { scope: 'B/s2' }), ba = binding(a), bb = binding(b);
  const accepted = await observe(a, ba);
  b.handoffs(...b.items.map(p => ({ round: 1, step: p.handoff.replace('R-0001-', ''), time: at(60) })));
  b.publish('B completed', at(60));
  pending(a, accepted.obligationId);
  a.w.register([{ ...a.p, name:'a' }, { ...b.p, name:'b' }], []);
  const input = put(a.w.dir, 'parent-entry.json', json({ schema:'continuation-entry/v1', products:[
    { records:a.p.records, parentBinding:{ environmentId:ba.environmentId, parentThreadId:'root', runId:'actual-parent-entry', deathRefs:[] }, hostObservation:measured, observations:[] },
    { records:b.p.records, parentBinding:{ environmentId:bb.environmentId, parentThreadId:'root', runId:'actual-parent-entry', deathRefs:[] }, hostObservation:measured, observations:[] },
  ] }));
  const entry = a.w.run('self-loop.mjs', ['start','--owner-store',a.w.owner,'--config',b.p.config,'--parent-entry',input]);
  assert.equal(entry.status, 0, entry.stderr);
  consumed(a);
  const c = canonical(a).result;
  assert.deepEqual(c.ready, ['ready']);
  assert.equal(c.packages.find(p => p.id === 'secure').unchecked.release, 'explicit security resolution');
  assert.ok(c.packages.find(p => p.id === 'ready').command.includes('call.mjs'));
});

test('AGE_AND_MOUNT_INDEPENDENT: unrelated commits do not replace plan generation', async t => {
  const f = fixture(t), b = binding(f), accepted = await observe(f, b);
  put(f.p.records, 'README.md', '# Unrelated mount metadata\n'); f.publish('Mount metadata', at(22));
  const again = await observe(f, b);
  assert.equal(again.obligationId, accepted.obligationId);
  assert.equal(typed(f, 'observe').length, 1);
  await enter(f, b); consumed(f);
});

for (const id of ['ACTIVE_CHILD_IDLE_COORDINATOR','FAILED_COORDINATOR_ACTIVE_CHILD','UNKNOWN_LAUNCH_ACK']) test(`${id}: canonical preparation is running with unknown acknowledgement`, async t => {
  const f = fixture(t), prepared = f.prepare(f.items[0]), b = binding(f);
  assert.ok(prepared.nonce && prepared.id && prepared.ws);
  const before = canonical(f).result.packages[0];
  assert.equal(before.status, 'running');
  assert.match(JSON.stringify(before.evidence), /prepared; launch acknowledgement unknown/);
  const accepted = await observe(f, b, id === 'FAILED_COORDINATOR_ACTIVE_CHILD' ? 'failed' : 'running');
  if (id !== 'FAILED_COORDINATOR_ACTIVE_CHILD') assert.equal(accepted.obligationId, null);
  await enter(f, b);
  assert.equal(canonical(f).result.packages[0].status, 'running');
  assert.equal(canonical(f).context.prepared.filter(p => p.id === prepared.id).length, 1);
});

for (const external of [true,false]) test(`${external ? 'TRUE_EXTERNAL_BLOCK' : 'UNCHECKED_HOLD_CONTROL'}: release comes from canonical batch or remains unchecked`, async t => {
  const f = fixture(t, { external }), b = binding(f), c = canonical(f);
  const release = external ? 'B-0001' : 'explicit security resolution';
  assert.deepEqual(releaseOf(release, { state: c.s, batches: c.context.batches, host }).computed, external);
  assert.equal(releaseOf(release, { state: c.s, batches: c.context.batches, host }).met, false);
  await observe(f, b); await enter(f, b); consumed(f);
  const row = canonical(f).result.packages.find(p => p.id === (external ? 'ready' : 'secure'));
  assert.equal(row.status, 'waiting'); assert.equal(Boolean(row.unchecked), !external);
  assert.equal(row.command, undefined);
});

test('OLD_FAILURE_AFTER_REPLACEMENT: old receipt cannot consume replacement generation', async t => {
  const f = fixture(t), old = binding(f); await observe(f, old);
  const replacement = binding(f, 'two');
  await observe(f, replacement); await observe(f, old); await enter(f, replacement);
  const all = rows(f), binds = all.filter(r => r.type === 'bind');
  assert.ok(binds.some(r => r.payload.generation === replacement.generation));
  for (const c of typed(f, 'consume')) assert.notEqual(c.payload.generation, old.generation);
});

test('DUPLICATE_CONCURRENT_RECOVERY: duplicate observations and competing consumers own once', async t => {
  const f = fixture(t), b = binding(f);
  observation(f,b);
  await Promise.all([observe(f, b), observe(f, b)]);
  assert.equal(typed(f, 'observe').length, 1);
  await concurrentEntries(f, b);
  assert.equal(typed(f, 'claim').length, 1); consumed(f);
  assert.deepEqual(canonical(f).result.ready, ['ready']);
  assert.equal(canonical(f).result.packages[1].status, 'waiting');
});

test('COMPLETED_SCOPE: canonical handoffs invalidate stale terminal', async t => {
  const f = fixture(t), b = binding(f); await observe(f, b);
  f.handoffs(...f.items.map(p => ({ round: 1, step: p.handoff.replace('R-0001-', ''), time: at(60) })));
  f.publish('Complete canonical scope', at(60));
  assert.ok(canonical(f).result.packages.every(p => p.status === 'done'));
  await enter(f, b);
  assert.equal(typed(f, 'consume').length, 0);
  assert.ok(typed(f, 'invalidate').some(r => r.payload.reason === 'completed'));
});

for (const id of ['MISSED_PARENT_DRAIN','CRASH_BEFORE_DELIVERY','UNAVAILABLE_TRANSPORT']) test(`${id}: durable pending without an executing parent`, async t => {
  const f = fixture(t), b = binding(f), accepted = await observe(f, b);
  pending(f, accepted.obligationId);
  const s = snapshot(f.p.records);
  assert.ok(s.read(ledger).includes(accepted.obligationId));
  assert.equal(canonical(f).result.ready[0], 'ready');
  if (id === 'MISSED_PARENT_DRAIN') { await enter(f, b); consumed(f); }
});

test('REVIEW_NOT_IMPLEMENTATION: review authority exposes only judge; missing admission is rejected', async t => {
  const f = fixture(t, { review: true }), b = binding(f);
  await observe(f, b); await enter(f, b);
  const c = canonical(f);
  assert.deepEqual(c.result.packages.map(p => p.role), ['judge']);
  assert.match(c.s.read('decisions/D-0002.md'), /implementation is not authorized/);
  const bad = { ...c.plan, id: 'PL-0002', supersedes: 'PL-0001', packages: [{ ...c.plan.packages[0], id: 'build', role: 'actor', handoff: 'R-0002-actor-build', authority: ['R-0001-judge-admission'] }] };
  put(f.p.records, 'plans/PL-0002.md', planText(bad.id,bad.packages,{scope:f.scope,supersedes:'PL-0001'}));
  f.w.commit(f.p.records, 'Unadmitted fixture control');
  assert.throws(() => loadPlan(snapshot(f.p.records), 'PL-0002'), /missing committed record/);
});

test('LATE_RUNNING_EVENT: terminal absorbs later running and duplicate terminal', async t => {
  const f = fixture(t), b = binding(f), first = await observe(f, b);
  await observe(f, b, 'running'); await observe(f, b);
  pending(f, first.obligationId); assert.equal(typed(f, 'observe').length, 1);
  await enter(f, b); consumed(f);
});

test('CLAIMANT_DIES_BEFORE_INTENT: age and unknown PID identity never authorize stealing', async t => {
  const f = fixture(t), b = binding(f), accepted = await observe(f, b);
  claim(f, b, accepted.obligationId);
  await enter(f, b);
  assert.equal(typed(f, 'release-claim').length, 0);
  assert.equal(typed(f, 'claim').length, 1);
  assert.equal(typed(f, 'consume').length, 0);
});

test('LOST_SEND_RECEIPT: durable intent uncertainty never becomes local resend success', async t => {
  const f = fixture(t), b = binding(f), accepted = await observe(f, b), c = claim(f, b, accepted.obligationId);
  seed(f, 'intent', { claimId: c.payload.claimId, intentId: ID([accepted.obligationId.slice(3),1,'parent-send']), kind: 'parent-send', normalAttemptRef: null });
  await enter(f, b);
  assert.equal(typed(f, 'consume').length, 0);
  assert.equal(typed(f, 'send-receipt').length, 0);
  assert.equal(typed(f, 'release-claim').length, 0);
});

test('PLAN_REVISION_DURING_CLAIM: claimed old plan cannot be consumed after supersession', async t => {
  const f = fixture(t), b = binding(f), accepted = await observe(f, b); claim(f, b, accepted.obligationId);
  const replacement = f.items.map(p => ({ ...p, goal: `${p.goal} revised`, handoff: p.handoff.replace('0001','0002') }));
  f.plan('PL-0002', replacement, { scope: f.scope, supersedes: 'PL-0001', when: at(60) });
  await enter(f, b);
  assert.equal(typed(f, 'consume').length, 0);
  assert.ok(typed(f, 'invalidate').some(r => r.payload.reason === 'superseded'));
  assert.deepEqual(canonical(f, 'PL-0002').result.ready, ['ready']);
});


test('CRASH_BEFORE_DELIVERY writer boundary: process killed before CAS publishes no partial receipt/cursor', async t => {
  const f = fixture(t), b = binding(f); observation(f,b); const before = snapshot(f.p.records).revision;
  const realGit = execFileSync('which', ['git'], { encoding:'utf8' }).trim();
  const hit = join(f.w.dir, 'killed-writer');
  const proxy = `#!/usr/bin/env node
const fs=require('node:fs'), cp=require('node:child_process'), args=process.argv.slice(2);
if(args.includes('update-ref')) { fs.writeFileSync(${JSON.stringify(hit)},'before-CAS'); process.kill(process.ppid,'SIGKILL'); process.exit(137); }
const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit',env:process.env});process.exit(r.status??80);
`;
  chmodSync(put(f.w.bin,'git',proxy),0o755);
  await assert.rejects(observe(f,b));
  assert.ok(existsSync(hit), 'must reach actual writer publication boundary');
  assert.equal(snapshot(f.p.records).revision, before);
  assert.deepEqual(rows(f), []);
});

test('fresh boundary: null run identity cannot fabricate a terminal obligation', async t => {
  const f = fixture(t), b = binding(f,'one',null);
  const result = await observe(f,b);
  assert.equal(result.obligationId,null);
  assert.ok(result.unknowns.length > 0);
  assert.equal(typed(f,'observe').length,0);
});


test('fresh ENTRY boundary: omitted caller stays pending instead of silently consuming ownership', async t => {
  const f = fixture(t), b = binding(f), accepted = await observe(f,b);
  const input = put(f.w.dir,'null-entry.json',json({ schema:'continuation-entry/v1', products:[
    { records:f.p.records, parentBinding:null, hostObservation:null, observations:[] },
  ] }));
  const result = f.w.run('self-loop.mjs',['start','--owner-store',f.w.owner,'--config',f.p.config,'--parent-entry',input]);
  assert.equal(result.status,0,result.stderr);
  pending(f,accepted.obligationId);
  assert.match(result.stdout,/unknown|missing|unavailable/i);
});

function accountable(result, id, blocker) {
  const p = result.pending.find(p => p.obligationId === id);
  assert.ok(p, 'accepted unfinished obligation must remain visible');
  assert.deepEqual(p.owner, {environmentId:'fixture-host',parentThreadId:'root'});
  assert.equal(typeof p.nextTrigger, 'string'); assert.ok(p.nextTrigger.length);
  assert.match(p.blocker, blocker);
  return p;
}
async function liveProcess(t, f) {
  assert.equal(process.platform,'linux','same-host death acceptance requires Linux; unsupported is not a pass');
  const file=put(f.w.dir,'claimant.cjs',"process.send('ready');setInterval(()=>{},1000);\n");
  const child=fork(file,[],{env:f.env,stdio:['ignore','ignore','pipe','ipc']});
  t.after(()=>{ if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await once(child,'message');
  const stat=readFileSync(`/proc/${child.pid}/stat`,'utf8');
  const claimant={host:hostname(),bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:child.pid,
    startId:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],parentThreadId:'root',runId:'stranded-parent'};
  return {child,claimant};
}
function proof(f, claimant) {
  const path=`evidence/0001/continuation-death-${H([claimant])}.json`;
  put(f.p.records,path,json({claimant,observation:'terminated'}));
  f.publish('Public claimant observation',at(51)); return ref(f,path);
}
async function terminate(child) {
  const exited=once(child,'exit'); child.kill('SIGKILL');
  const [code,signal]=await exited; assert.equal(code,null); assert.equal(signal,'SIGKILL');
  assert.throws(()=>process.kill(child.pid,0),e=>e.code==='ESRCH');
}

test('VERIFIED_DEATH_RECLAIM: exact same-host terminated child releases before intent and consumes once',async t=>{
  const f=fixture(t), b=binding(f), accepted=await observe(f,b);
  const {child,claimant}=await liveProcess(t,f);
  const first=claim(f,b,accepted.obligationId,claimant);
  await terminate(child); const deathRef=proof(f,claimant);
  const result=await enter(f,b,{deathRefs:[deathRef]});
  assert.equal(typed(f,'release-claim').length,1);
  assert.deepEqual(typed(f,'release-claim')[0].payload,{claimId:first.payload.claimId,deathRef,successorClaimOrdinal:2});
  assert.equal(typed(f,'claim').at(-1).payload.claimOrdinal,2); consumed(f);
  accountable(result,accepted.obligationId,/canonical work remains/);
});

for(const mode of ['live','pid-reuse','foreign-boot','foreign-host','no-proof']) test(`NO_STEAL_${mode}: process identity uncertainty is not death`,async t=>{
  const f=fixture(t), b=binding(f), accepted=await observe(f,b);
  const {child,claimant}=await liveProcess(t,f);
  if(mode==='pid-reuse') claimant.startId=String(BigInt(claimant.startId)+1n);
  if(mode==='foreign-boot') claimant.bootId+='-other';
  if(mode==='foreign-host') claimant.host+='-other';
  claim(f,b,accepted.obligationId,claimant);
  if(mode==='foreign-boot'||mode==='foreign-host'||mode==='no-proof') await terminate(child);
  const deathRefs=mode==='no-proof'?[]:[proof(f,claimant)];
  const result=await enter(f,b,{deathRefs});
  assert.equal(typed(f,'release-claim').length,0); assert.equal(typed(f,'consume').length,0);
  assert.equal(typed(f,'claim').length,1);
  accountable(result,accepted.obligationId,/death unverified/);
});

for(const mode of ['null-parent','wrong-parent','wrong-environment','null-host','fake-host']) test(`UNKNOWN_CALLER_${mode}: zero consumption and accountable pending`,async t=>{
  const f=fixture(t), b=binding(f), accepted=await observe(f,b);
  let parent={environmentId:b.environmentId,parentThreadId:'root',runId:'actual',deathRefs:[]}, h=measured;
  if(mode==='null-parent') parent=null;
  if(mode==='wrong-parent') parent.parentThreadId='other';
  if(mode==='wrong-environment') parent.environmentId='other';
  if(mode==='null-host') h=null;
  if(mode==='fake-host') h={admits:true,released:true};
  const result=await invoke(f,'reconcileAtExistingParentEntry',[f.p.records,parent,h]);
  assert.equal(result.consumeRowId,null); assert.equal(typed(f,'claim').length,0);
  assert.equal(typed(f,'consume').length,0); accountable(result,accepted.obligationId,/identity|binding|host/);
});

test('PENDING_REASON_AND_RELEASE: owner batch blocks until answered; security remains unchecked',async t=>{
  const f=fixture(t,{external:true}), b=binding(f), accepted=await observe(f,b);
  const result=await enter(f,b), p=accountable(result,accepted.obligationId,/canonical work remains/);
  const ready=p.packages.find(p=>p.id==='ready'), secure=p.packages.find(p=>p.id==='secure');
  assert.equal(ready.status,'waiting'); assert.match(ready.nextTrigger,/B-0001/);
  assert.equal(secure.status,'waiting'); assert.match(secure.nextTrigger,/explicit security resolution/);
  assert.ok(secure.unchecked); assert.equal(secure.command,undefined);
  f.answer('B-0001',at(65)); f.publish('Owner answered',at(66));
  const later=await enter(f,b);
  assert.deepEqual(later.pending.find(p=>p.obligationId===accepted.obligationId).ready,['ready']);
  assert.equal(typed(f,'consume').length,1,'read-only refresh cannot redeliver old terminal');
});

async function barrierReached(file) {
  const deadline=Date.now()+10000;
  while(!existsSync(file) && Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
  assert.ok(existsSync(file),'positive barrier acknowledgement required; timeout is failure, never death');
}
function gitProxy(f, body) {
  const real=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  chmodSync(put(f.w.bin,'git',`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),args=process.argv.slice(2),real=${JSON.stringify(real)};
${body}
const r=cp.spawnSync(real,args,{stdio:'inherit',env:process.env});process.exit(r.status??80);
`),0o755);
}

test('FORCED_PLAN_REVISION_BEFORE_CAS: competing canonical revision forces complete callback re-read',async t=>{
  const f=fixture(t), b=binding(f); await observe(f,b);
  const hit=join(f.w.dir,'claim-built'), release=join(f.w.dir,'claim-release');
  gitProxy(f,`if(process.env.CT_RACE && args.includes('commit-tree') && !fs.existsSync(${JSON.stringify(release)})) {
fs.writeFileSync(${JSON.stringify(hit)},'candidate-built');const deadline=Date.now()+15000;
while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)process.exit(79);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}`);
  const attempt=enter(f,b,{}, {CT_RACE:'1'}); const settled=Promise.allSettled([attempt]);
  try {
    await barrierReached(hit);
    f.plan('PL-0002',f.items.map(p=>({...p,handoff:p.handoff.replace('0001','0002')})),{scope:f.scope,supersedes:'PL-0001',when:at(60)});
  } finally { put(f.w.dir,'claim-release','go'); }
  const [r]=await settled; assert.equal(r.status,'fulfilled',String(r.reason));
  assert.equal(typed(f,'claim').length,0,'old speculative claim must not publish');
  assert.equal(typed(f,'consume').length,0);
  assert.ok(typed(f,'invalidate').some(r=>r.payload.reason==='superseded'));
});

for(const boundary of ['after-CAS','after-restore']) test(`PUBLISHED_CRASH_${boundary}: committed consume survives writer death without duplicate`,async t=>{
  const f=fixture(t), b=binding(f); await observe(f,b);
  const before=snapshot(f.p.records).revision, hit=join(f.w.dir,'published-crash');
  gitProxy(f,`if(process.env.CT_CRASH && args.includes(${JSON.stringify(boundary==='after-CAS'?'update-ref':'restore')})) {
const r=cp.spawnSync(real,args,{stdio:'inherit',env:process.env});if(r.status!==0)process.exit(r.status??80);
fs.writeFileSync(${JSON.stringify(hit)},'published');process.kill(process.ppid,'SIGKILL');process.exit(137);}`);
  await assert.rejects(enter(f,b,{}, {CT_CRASH:'1'})); assert.ok(existsSync(hit));
  assert.notEqual(snapshot(f.p.records).revision,before);
  const c=consumed(f), bytes=snapshot(f.p.records).read(ledger);
  const again=await enter(f,b); assert.equal(again.consumeRowId,null);
  assert.equal(snapshot(f.p.records).read(ledger),bytes); assert.equal(consumed(f).rowId,c.rowId);
  assert.equal(typed(f,'intent').length,0); assert.equal(typed(f,'send-receipt').length,0);
});

test('POST_INTENT_DEATH: even verified death and a send receipt cannot become application acknowledgement',async t=>{
  const f=fixture(t), b=binding(f), a=await observe(f,b), {child,claimant}=await liveProcess(t,f);
  const c=claim(f,b,a.obligationId,claimant), intentId=ID([a.obligationId.slice(3),1,'parent-send']);
  seed(f,'intent',{claimId:c.payload.claimId,intentId,kind:'parent-send',normalAttemptRef:null});
  seed(f,'send-receipt',{intentId,threadId:'root',messageId:'public-message',runId:'public-run',delivery:'queued',status:'accepted'});
  await terminate(child); const deathRef=proof(f,claimant);
  const result=await enter(f,b,{deathRefs:[deathRef]});
  assert.equal(typed(f,'release-claim').length,0); assert.equal(typed(f,'consume').length,0);
  accountable(result,a.obligationId,/not application consumption/);
});

for(const command of ['start','next']) test(`OMITTED_PRODUCT_${command}: registry omission exposes pending without inventing caller`,async t=>{
  const f=fixture(t), b=binding(f), a=await observe(f,b);
  const input=put(f.w.dir,'omitted.json',json({schema:'continuation-entry/v1',products:[]}));
  const result=f.w.run('self-loop.mjs',[command,'--owner-store',f.w.owner,'--config',f.p.config,'--parent-entry',input]);
  assert.equal(result.status,0,result.stderr); pending(f,a.obligationId);
  assert.match(result.stdout,/root/); assert.match(result.stdout,/parent|caller/); assert.match(result.stdout,/unknown|unavailable|missing/);
});

test('CONFLICTING_TERMINALS: opposite terminal receipt is visible conflict and cannot consume',async t=>{
  const f=fixture(t), b=binding(f), a=await observe(f,b,'failed'); await observe(f,b,'completed');
  const r=await enter(f,b); assert.equal(typed(f,'consume').length,0);
  accountable(r,a.obligationId,/conflicting terminal/);
});

test('NORMAL_ATTEMPT_BINDING: actual preparation nonce is referenced, wrong nonce is refused',async t=>{
  const f=fixture(t), prepared=f.prepare(f.items[0]), b=binding(f);
  const path='evidence/0001/continuation-normal-attempt.json';
  const normal=JSON.parse(readFileSync(join(prepared.ws,'call.json'),'utf8'));
  assert.equal(normal.nonce,prepared.nonce);
  put(f.p.records,path,json({nonce:normal.nonce,id:prepared.id})); f.publish('Public fixture attempt identity',at(31));
  b.attemptRef=ref(f,path); b.nonce=prepared.nonce;
  b.generation=ID([b.productKey.slice(3),b.phase,b.scope,'PL-0001',b.planRef.sha256,b.delegationRef.sha256,b.nonce,b.environmentId,b.taskId,b.runId]);
  const receipt='evidence/0001/continuation-binding-attempt.json'; put(f.p.records,receipt,json(b)); f.publish('Bind actual preparation',at(32));
  f.bindings.set(b,ref(f,receipt)); const a=await observe(f,b); assert.ok(a.obligationId);
  await enter(f,b); assert.equal(canonical(f).result.packages[0].status,'running');
  const bad={...b,nonce:b.nonce+'-wrong'};
  bad.generation=ID([bad.productKey.slice(3),bad.phase,bad.scope,'PL-0001',bad.planRef.sha256,bad.delegationRef.sha256,bad.nonce,bad.environmentId,bad.taskId,bad.runId]);
  const badPath='evidence/0001/continuation-bad-nonce.json'; put(f.p.records,badPath,json(bad)); f.publish('Mismatched attempt',at(33));
  f.bindings.set(bad,ref(f,badPath)); const refused=await observe(f,bad);
  assert.equal(refused.obligationId,null); assert.match(refused.unknowns.join(' '),/nonce/);
});

const freshCell=()=>({terminal:0,claim:-1,intent:false,dead:false,count:0,ordinal:0});
const initialModel=()=>({products:[0,1].map(()=>({generation:0,done:false,cells:[freshCell(),freshCell()]}))});
const alphabet=[0,1].flatMap(p=>[0,1].flatMap(g=>[
  ...['observe','running','conflict','death','release','intent','revise','complete','unknown'].map(kind=>({p,g,kind,c:-1})),
  ...[0,1].flatMap(c=>['claim','consume'].map(kind=>({p,g,kind,c})))
]));
function modelStep(state,e,defect=null) {
  const s=structuredClone(state), p=s.products[e.p], x=p.cells[e.g];
  const current=e.g===p.generation && !p.done;
  if(e.kind==='revise' && p.generation===0) p.generation=1;
  if(e.kind==='complete' && current) p.done=true;
  if(e.kind==='observe' && defect!=='drop-observation' && current && x.terminal===0) x.terminal=1;
  if(e.kind==='observe' && defect==='cross-product-clear') s.products[1-e.p].cells.forEach(x=>x.terminal=0);
  if(e.kind==='running' && defect==='late-running') x.terminal=0;
  if(e.kind==='conflict' && defect!=='ignore-conflict' && current && x.terminal===1) x.terminal=2;
  if(e.kind==='claim' && (current || defect==='stale-generation') && x.terminal===1 && !x.count && (x.claim===-1 || defect==='steal-live')) {x.claim=e.c;x.ordinal++;x.dead=false;}
  if(e.kind==='death' && x.claim!==-1) x.dead=true;
  if(e.kind==='intent' && x.claim!==-1) x.intent=true;
  if(e.kind==='release' && defect!=='never-release' && x.claim!==-1 && (x.dead || defect==='timeout-death') && (!x.intent || defect==='post-intent-release')) {x.claim=-1;x.dead=false;}
  if(e.kind==='consume' && defect!=='never-consume' && current && x.terminal===1 && x.claim===e.c && !x.intent && !x.dead && (!x.count || defect==='duplicate-consume')) x.count++;
  if(e.kind==='unknown' && defect==='unknown-consume' && current && x.terminal===1) x.count++;
  return s;
}
function modelInvariant(before,after,e) {
  assert.deepEqual(after.products[1-e.p],before.products[1-e.p],'cross-product isolation');
  const a=after.products[e.p], b=before.products[e.p], x=b.cells[e.g], y=a.cells[e.g];
  assert.deepEqual(a.cells[1-e.g],b.cells[1-e.g],'other-generation isolation');
  assert.ok(y.count<=1,'at most one consume per generation/cursor');
  const current=e.g===b.generation && !b.done;
  if(e.kind==='observe' && current && x.terminal===0) assert.equal(y.terminal,1,'accepted event cannot disappear');
  if(e.kind==='conflict' && current && x.terminal===1) assert.equal(y.terminal,2,'conflict must stay visible');
  if(e.kind==='release' && x.claim!==-1 && x.dead && !x.intent) assert.equal(y.claim,-1,'verified pre-intent death must release');
  if(e.kind==='consume' && current && x.terminal===1 && x.claim===e.c && !x.intent && !x.dead && !x.count) assert.equal(y.count,1,'eligible local read must consume');
  if(y.count>x.count) {
    assert.equal(e.kind,'consume','actual known parent only'); assert.equal(e.g,b.generation,'current generation');
    assert.equal(x.claim,e.c,'same consumer token'); assert.equal(x.terminal,1,'unconflicted terminal');
    assert.equal(x.intent,false,'no external acknowledgement fabricated'); assert.equal(x.dead,false); assert.equal(b.done,false);
  }
  if(x.claim!==-1 && y.claim!==x.claim) {
    assert.equal(e.kind,'release','no live claim stealing'); assert.equal(x.dead,true,'positive death'); assert.equal(x.intent,false,'pre-intent only');
  }
  if(y.ordinal>x.ordinal) { assert.equal(e.g,b.generation); assert.equal(b.done,false); assert.equal(x.claim,-1); }
  if(x.terminal && y.terminal===0) assert.fail('terminal cannot be erased by later event or unrelated progress');
}
function enumerate(defect=null) {
  let layer=[{s:initialModel(),trace:[]}], seen=new Set([JSON.stringify(layer[0].s)]), edges=0;
  const depthStates=[1];
  for(let depth=0;depth<6;depth++) {
    const next=[];
    for(const {s,trace} of layer) for(const e of alphabet) {
      edges++; const after=modelStep(s,e,defect), path=[...trace,e];
      try {modelInvariant(s,after,e);} catch(error) {return {defect,edges,states:seen.size,counterexample:path,violation:error.message};}
      const key=JSON.stringify(after);
      if(!seen.has(key)) {seen.add(key);next.push({s:after,trace:path});}
    }
    layer=next;depthStates.push(layer.length);
  }
  return {defect,edges,states:seen.size,depthStates,counterexample:null,maxLength:6,products:2,generations:2,consumers:2};
}
const modelDefects=['cross-product-clear','late-running','stale-generation','steal-live','timeout-death','post-intent-release','duplicate-consume','unknown-consume','drop-observation','ignore-conflict','never-release','never-consume'];
nodeTest('ORACLE_FINITE_PREFIXES: 2 products x 2 generations x 2 consumers, all quotient states through length 6',()=>{
  const r=enumerate(); assert.equal(r.counterexample,null,JSON.stringify(r));
  process.stdout.write(JSON.stringify({profile:'independent-model-not-product',...r})+'\n');
});
nodeTest('ORACLE_SEEDED_DEFECTS: each mandatory safety target has an executable counterexample',()=>{
  for(const defect of modelDefects) {
    const r=enumerate(defect); assert.ok(r.counterexample,`surviving seed ${defect}`);
    process.stdout.write(JSON.stringify({profile:'seed-sensitivity-not-product',...r})+'\n');
  }
});

if(!modelOnly && !linuxIdentity) nodeTest('UNSUPPORTED_LOCAL_IDENTITY: explicit unknown pending, no consume/release; Linux positives not exercised',async t=>{
  const f=fixture(t), b=binding(f), a=await observe(f,b);
  let r=await enter(f,b); assert.equal(r.consumeRowId,null);
  accountable(r,a.obligationId,/identity unavailable/);
  claim(f,b,a.obligationId);
  r=await enter(f,b); assert.equal(r.consumeRowId,null);
  assert.equal(typed(f,'release-claim').length,0); assert.equal(typed(f,'consume').length,0);
  accountable(r,a.obligationId,/identity unavailable/);
  process.stdout.write(JSON.stringify({profile:'unsupported-identity',linuxPositiveCoverage:'NOT_EXECUTED',fullTransport:'DEFERRED'})+'\n');
});

test('SOL001_EXPLICIT_OWNER_STORE: CLI selected store survives different environment default',async t=>{
  const f=fixture(t), other=fixture(t), b=binding(f), o=observation(f,b);
  const input=put(f.w.dir,'explicit-store.json',json({schema:'continuation-entry/v1',products:[{
    records:f.p.records,parentBinding:{environmentId:b.environmentId,parentThreadId:'root',runId:'actual-entry',deathRefs:[]},
    hostObservation:measured,observations:[{publicObservation:o,bindingRef:f.bindings.get(b)}]
  }]}));
  const result=f.w.run('self-loop.mjs',['start','--owner-store',f.w.owner,'--config',f.p.config,'--parent-entry',input],
    {extraEnv:{SELF_LOOP_OWNER_STORE:other.w.owner}});
  assert.equal(result.status,0,result.stderr); assert.equal(typed(f,'observe').length,1); consumed(f);
  assert.equal(typed(other,'observe').length,0);
});

for(const consumedFirst of [false,true]) test(`SOL002_SHARED_CURSOR_${consumedFirst}: independent scopes never create terminal conflict`,async t=>{
  const f=fixture(t), a=binding(f);
  f.plan('PL-0002',[pkg('independent',{round:2,authority:'D-0001'})],{scope:'independent/s2'});
  f.planId='PL-0002';f.scope='independent/s2';const b=binding(f,'independent');
  const sourceRef=ref(f,'loop.json'), event={source:'record-change',sourceRef,terminalStatus:null};
  const first=await invoke(f,'capture',[event,f.bindings.get(a),f.p.records]);
  assert.deepEqual(first.unknowns,[]);
  if(consumedFirst) {await enter(f,a);assert.equal(typed(f,'consume').length,1);}
  const second=await invoke(f,'capture',[event,f.bindings.get(b),f.p.records]);
  assert.deepEqual(second.unknowns,[]); assert.notEqual(first.obligationId,second.obligationId);
  const r=await enter(f,b);assert.deepEqual(r.unknowns,[]);
  const cs=typed(f,'consume');assert.equal(cs.length,2);assert.equal(new Set(cs.map(r=>r.payload.generation)).size,2);
  await enter(f,b); assert.equal(typed(f,'consume').length,2);
});

test('SOL003_REORDERED_BINDING: canonical ledger order does not restrict receipt JSON key order',async t=>{
  const f=fixture(t), b=binding(f), path='evidence/0001/continuation-reordered.json';
  const reordered=Object.fromEntries(Object.entries(b).reverse());
  put(f.p.records,path,json(reordered)); f.publish('Alternate JSON serialization',at(24));f.bindings.set(b,ref(f,path));
  const one=await observe(f,b), two=await observe(f,b);
  assert.equal(one.obligationId,two.obligationId);assert.equal(one.rowId,two.rowId);
  assert.equal(typed(f,'bind').length,1);assert.equal(typed(f,'observe').length,1);
  const event={source:'record-change',sourceRef:ref(f,'loop.json'),terminalStatus:null};
  const r=await invoke(f,'capture',[event,f.bindings.get(b),f.p.records]);
  assert.equal(r.obligationId,one.obligationId); assert.deepEqual(r.unknowns,[]);
  assert.equal(typed(f,'observe').length,2);
});
