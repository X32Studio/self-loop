// F-0012, design/time-model.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from '../lib/git-plumbing.mjs';
import { snapshot, parsePlan, validatePlan, loadPlan, readyPlan } from '../lib/plan.mjs';
import { reconcilePlans } from '../loop.mjs';
import { loadForecastHistory, projectPlanTime, validatePlanTime } from '../lib/plan-time.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');
const at = s => new Date(Date.parse('2026-11-22T00:00:00Z') + s * 1000).toISOString();
function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), 'time-model-')); t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  const write = (path, value) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), typeof value === 'string' ? value : JSON.stringify(value)); };
  const commit = () => { git(repo, 'add', '.'); git(repo, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture'); return git(repo, 'rev-parse', 'HEAD'); };
  const ref = (path, commit = git(repo, 'rev-parse', 'HEAD')) => ({ repository: repo, commit, path, sha256: hash(snapshot(repo, commit).bytes(path)) });
  write('decisions/D-0001.md', '# D-0001\nApproved minimum and time agreement'); commit();
  const authority = ref('decisions/D-0001.md');
  const p = id => ({ id, authority: ['D-0001'], goal: id, files: [], needs: [], role: 'actor', handoff: `R-0001-actor-${id}`, interface: 'fixed', acceptance: 'fixed' });
  const plan = { id: 'PL-0001', scope: 'phase/scope', phase: 'v1', packages: [p('a'), { ...p('b'), needs: ['a'] }, p('c')], time: { schema: 'plan-time/v2', rootPlan: 'PL-0001', baseline: { previousRoot: null, startedAt: at(0), startRefs: [authority], deadline: { at: at(100), authorityRefs: [authority] }, minimum: { outcome: 'usable release', criteriaRefs: [authority], authorityRefs: [authority] }, promises: [] } } };
  write('plans/PL-0001.md', plan); const base = commit();
  const estimate = (lo, hi) => ({ asOf: at(0), remaining: { lowSeconds: lo, highSeconds: hi }, availableAfter: { lowSeconds: 0, highSeconds: 0 }, basisRefs: [authority], assumptions: ['independent capacity available'], unknowns: [] });
  const observation = () => ({ schema: 'plan-forecast/v1', rootRef: ref('plans/PL-0001.md', base), planRef: ref('plans/PL-0001.md', base), parents: [], outlook: { asOf: at(0), observation: { observedAt: at(0), recordedAt: at(0), evidenceRefs: [authority] }, basedOn: base, inputs: [authority], releasePackages: ['b', 'c'], reserve: { remaining: { lowSeconds: 1, highSeconds: 2 }, covers: ['review'], basisRefs: [authority], assumptions: [] }, checkpointAt: at(5), change: { reason: 'initial outlook', authorityRefs: [authority], deferredPackages: [] }, outcome: { state: 'active', evidenceRefs: [], deliveredAt: null } }, estimates: { a: estimate(5, 6), b: estimate(2, 3), c: estimate(3, 4) }, promisesAdded: [] });
  const publish = o => { const bytes = JSON.stringify(o), path = `forecasts/FO-${hash(bytes)}.json`; write(path, bytes); commit(); return path; };
  return { repo, write, commit, ref, plan, base, authority, observation, publish };
}
test('legacy parse/validation and one-line time remain separate from readiness', t => {
  const f = fixture(t), state = snapshot(f.repo);
  assert.deepEqual(validatePlanTime(f.plan, state), []);
  assert.deepEqual(validatePlan(f.plan, state), []);
  assert.deepEqual(validatePlanTime({ id: 'PL-0001' }, state), []);
  assert.equal(projectPlanTime(state, { id: 'PL-0001' }), null);
  assert.deepEqual(parsePlan(`# PL-0001\ntime: ${JSON.stringify(f.plan.time)}\n`).time, f.plan.time);
});
test('pinned DAG uses max for fork/join and signed overdue budget with strict equality', t => {
  const f = fixture(t); f.publish(f.observation()); const q = snapshot(f.repo);
  const h = loadForecastHistory(f.repo, q.revision, f.plan.id); assert.deepEqual(h.errors, []);
  const view = now => projectPlanTime(q, f.plan, { now: at(now), forecastHistory: h });
  assert.equal(view(1).forecast.earliestAt, at(8)); assert.equal(view(1).forecast.latestAt, at(11));
  assert.equal(view(5).forecast.stale, false); assert.equal(view(6).forecast.stale, true);
  assert.equal(view(100).remainingSeconds, 0); assert.equal(view(3700).remainingSeconds, -3600);
  assert.equal(view(-1).elapsedSeconds, null); assert.equal(view(-1).remainingSeconds, null);
});
test('later completion changes progress and staleness, never historical ETA', t => {
  const f = fixture(t); f.publish(f.observation());
  const record = 'rounds/0001-actor-a.md'; f.write(record, '# completed a');
  f.write('metrics/handoffs.jsonl', JSON.stringify({ id: 'R-0001-actor-a', time: at(6), phase: 'v1', round: 1, step: 'actor-a', role: 'actor', attempt: 1, agent: { runner: 'test' }, view: f.base, product: null, audit: { violations: 0 }, files: [record], record }) + '\n'); f.commit();
  const q = snapshot(f.repo), r = projectPlanTime(q, f.plan, { now: at(6) });
  assert.equal(r.forecast.earliestAt, at(8)); assert.equal(r.forecast.latestAt, at(11)); assert.equal(r.progress.completedHandoffs.length, 1); assert.ok(r.forecast.staleReasons.includes('canonical progress changed'));
  const missing = projectPlanTime(q, f.plan, { now: at(6), historicalSnapshots: {} });
  assert.equal(missing.forecast.latestAt, null); assert.match(missing.forecast.unknowns.join(), /snapshot missing/);
});
test('concurrent full forecasts conflict; malformed newest and deleted history cannot fall back', t => {
  const f = fixture(t), a = f.observation(); const path = f.publish(a);
  const b = f.observation(); b.outlook.change.reason = 'concurrent'; f.publish(b);
  let q = snapshot(f.repo), r = projectPlanTime(q, f.plan, { now: at(1) });
  assert.equal(r.history.length, 2); assert.equal(r.forecast.latestAt, null); assert.match(r.findings.join(), /forecast-conflict/);
  rmSync(join(f.repo, path)); f.commit();
  let h = loadForecastHistory(f.repo, git(f.repo, 'rev-parse', 'HEAD'), f.plan.id); assert.match(h.errors.join(), /deleted/); assert.equal(h.observations.length, 2);
  f.write('forecasts/FO-nothex.json', '{}'); f.commit(); h = loadForecastHistory(f.repo, git(f.repo, 'rev-parse', 'HEAD'), f.plan.id); assert.match(h.errors.join(), /digest/);
});
test('null upper and unknown start stay unknown; late cadence cannot erase history', t => {
  const f = fixture(t), a = f.observation(); a.estimates.a.remaining.highSeconds = null; f.publish(a);
  const r = projectPlanTime(snapshot(f.repo), f.plan, { now: at(10) });
  assert.equal(r.forecast.latestAt, null); assert.equal(r.checkpoint.missed.length, 1); assert.equal(r.checkpoint.missed[0].status, 'timing-unverified');
  assert.equal(r.progress.releaseEvidence.length, 0);
});
test('query commit ignores working tree and later unrelated commits', t => {
  const f = fixture(t); const path = f.publish(f.observation()), pinned = git(f.repo, 'rev-parse', 'HEAD');
  f.write('docs/unrelated.md', 'unrelated'); f.commit();
  f.write(path, '{broken');
  const q = snapshot(f.repo), r = projectPlanTime(q, f.plan, { now: at(1) });
  assert.equal(r.forecast.stale, false); assert.equal(r.forecast.latestAt, at(11));
  assert.equal(loadForecastHistory(f.repo, pinned, f.plan.id).observations.length, 1);
  assert.equal(readFileSync(join(f.repo, path), 'utf8'), '{broken');
});
test('wrong root on a successor observation remains a visible error, while budget remains signed', t => {
  const f = fixture(t), first = f.publish(f.observation()), o = f.observation();
  o.outlook.basedOn = git(f.repo, 'rev-parse', 'HEAD'); o.parents = [f.ref(first)]; o.rootRef = f.ref(first);
  f.publish(o); const r = projectPlanTime(snapshot(f.repo), f.plan, { now: at(101) });
  assert.equal(r.forecast.latestAt, null); assert.equal(r.remainingSeconds, -1); assert.equal(r.history.length, 2);
});
test('malformed forecast object cannot throw or substitute older finite projection', t => {
  const f = fixture(t); f.publish(f.observation());
  const o = f.observation(); o.outlook = null; f.publish(o);
  const r = projectPlanTime(snapshot(f.repo), f.plan, { now: at(1) });
  assert.equal(r.forecast.latestAt, null); assert.equal(r.remainingSeconds, 99);
});
test('generic capacity assumptions cannot bound an unresolved external hold', t => {
  const f = fixture(t), plan = structuredClone(f.plan);
  plan.id = 'PL-0002'; plan.supersedes = f.plan.id; plan.time = { schema: 'plan-time/v2', rootPlan: f.plan.id };
  plan.packages[1].hold = 'external approval'; plan.packages[1].release = 'unbounded external response';
  f.write('plans/PL-0002.md', plan); const basedOn = f.commit();
  const o = f.observation(); o.outlook.basedOn = basedOn; o.planRef = f.ref('plans/PL-0002.md'); f.publish(o);
  const r = projectPlanTime(snapshot(f.repo), plan, { now: at(1) });
  assert.equal(r.forecast.latestAt, null); assert.match(r.forecast.unknowns.join(), /unresolved hold/);
});

test('malformed optional time screens without obstructing ready or unrelated reconciliation', t => {
  const f = fixture(t);
  f.write('loop.json', { product: f.repo, records: f.repo, workDir: `${f.repo}-work`, phase: 'v1', briefs: {}, agents: { actor: { runner: 't3' } } });
  const legacy = { ...f.plan, id: 'PL-0002', scope: 'other', time: undefined, packages: [{ ...f.plan.packages[0], handoff: 'R-0002-actor-a', task: import.meta.filename }] };
  f.write('plans/PL-0002.md', legacy);
  for (const markdown of [true, false]) {
    const p = { ...f.plan, time: '{broken', packages: [{ ...f.plan.packages[0], task: import.meta.filename }] };
    const source = markdown ? `# ${p.id}\nscope: ${p.scope}\nphase: ${p.phase}\ntime: {broken\n## a\n${Object.entries(p.packages[0]).filter(([k]) => k !== 'id').map(([k, v]) => `${k}: ${Array.isArray(v) ? JSON.stringify(v) : v}`).join('\n')}\n` : JSON.stringify(p);
    f.write('plans/PL-0001.md', source); f.commit();
    const state = snapshot(f.repo), parsed = loadPlan(state, p.id);
    assert.deepEqual(validatePlan(parsed, state), []);
    assert.match(validatePlanTime(parsed, state).join(), /invalid plan-time/);
    assert.equal(readyPlan(state, parsed, { host: { admits: true } }).packages[0].status, 'ready');
    const reconciled = reconcilePlans(f.repo, state.revision, 'v1', { live: false, host: { admits: true } });
    assert.equal(reconciled.problem, null);
    assert.equal(reconciled.plans.length, 2);
    assert.ok(reconciled.plans.every(p => p.result?.packages[0].status === 'ready'));
    assert.equal(projectPlanTime(state, parsed, { now: at(1) }).forecast.latestAt, null);
  }
});
test('omitted descendant time retains original budget and history across multiple successors', t => {
  const f = fixture(t); f.publish(f.observation());
  const next = { ...f.plan, id: 'PL-0002', supersedes: f.plan.id, time: undefined };
  const last = { ...next, id: 'PL-0003', supersedes: next.id };
  f.write('plans/PL-0002.md', next); f.write('plans/PL-0003.md', last); f.commit();
  const state = snapshot(f.repo), r = projectPlanTime(state, last, { now: at(101) });
  assert.match(validatePlanTime(last, state).join(), /lineage missing/);
  assert.deepEqual(validatePlan(last, state), []);
  assert.equal(r.rootPlan, f.plan.id); assert.equal(r.elapsedSeconds, 101); assert.equal(r.remainingSeconds, -1);
  assert.equal(r.deadline, at(100)); assert.equal(r.history.length, 1); assert.equal(r.checkpoint.missed.length, 1);
  assert.match(r.findings.join(), /lineage missing/);
  assert.equal(r.forecast.latestAt, null);
  const legacy = { ...f.plan, time: undefined };
  f.write('plans/PL-0001.md', legacy); f.commit();
  assert.equal(projectPlanTime(snapshot(f.repo), last, { now: at(101) }), null);
  assert.deepEqual(validatePlanTime(last, snapshot(f.repo)), []);
});
function completeA(f) {
  const record = 'rounds/0001-actor-a.md'; f.write(record, '# completed a');
  f.write('metrics/handoffs.jsonl', JSON.stringify({ id: 'R-0001-actor-a', time: at(1), phase: 'v1', round: 1, step: 'actor-a', role: 'actor', attempt: 1, agent: { runner: 'test' }, view: f.base, product: null, audit: { violations: 0 }, files: [record], record }) + '\n'); f.commit();
}
function refresh(f, parents, seconds) {
  const o = f.observation(); o.outlook.basedOn = git(f.repo, 'rev-parse', 'HEAD');
  o.parents = parents.map(path => f.ref(path));
  o.outlook.asOf = at(seconds); o.outlook.observation.observedAt = at(seconds); o.outlook.observation.recordedAt = at(seconds);
  o.outlook.checkpointAt = at(seconds + 5);
  for (const e of Object.values(o.estimates)) e.asOf = at(seconds);
  return f.publish(o);
}
test('latest refresh detects progress then stall despite commit repinning', t => {
  const f = fixture(t), first = f.publish(f.observation()); completeA(f);
  const second = refresh(f, [first], 2), third = refresh(f, [second], 3);
  const state = snapshot(f.repo), history = loadForecastHistory(f.repo, state.revision, f.plan.id);
  assert.deepEqual(history.errors, []);
  const r = projectPlanTime(state, f.plan, { now: at(3), forecastHistory: history });
  assert.equal(r.forecast.progressComparison[0].status, 'unchanged');
  assert.equal(r.history[1].progressComparison[0].status, 'changed');
  assert.match(r.findings.join(), /unchanged-progress/); assert.ok(r.findings.some(v => v.includes(third)));
  const cuts = { ...history.snapshots }; delete cuts[history.observations[1].outlook.basedOn];
  const missing = projectPlanTime(state, f.plan, { now: at(3), forecastHistory: history, historicalSnapshots: cuts });
  assert.equal(missing.forecast.progressComparison[0].status, 'unknown');
  assert.match(missing.findings.join(), /progress-comparison-unknown/);
  assert.ok(!missing.findings.some(v => v.startsWith('unchanged-progress') && v.includes(third)));
});
test('branch resolution retains per-parent progress instead of flattening history', t => {
  const f = fixture(t), first = f.publish(f.observation()); completeA(f);
  const concurrent = f.observation(); concurrent.outlook.change.reason = 'concurrent at original cut';
  const branch = f.publish(concurrent);
  const resolution = refresh(f, [first, branch], 2);
  refresh(f, [resolution], 3);
  const state = snapshot(f.repo), history = loadForecastHistory(f.repo, state.revision, f.plan.id);
  assert.deepEqual(history.errors, []);
  const r = projectPlanTime(state, f.plan, { now: at(3), forecastHistory: history });
  assert.deepEqual(r.history[2].progressComparison.map(c => c.status), ['changed', 'changed']);
  assert.equal(r.forecast.progressComparison[0].status, 'unchanged');
});
