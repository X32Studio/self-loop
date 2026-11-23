// self-loop-records@97f4adf:evidence/0012/code-sol/findings.json, TB1-SOL-R12-01..03
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, h, host, json, project } from './fixture.mjs';
import { loadPlan, parsePlan } from '../../scripts/lib/plan.mjs';
import { reconcilePlans } from '../../scripts/loop.mjs';
import { measurePlan } from '../../scripts/lib/plan-measures.mjs';
import { validatePlanTime } from '../../scripts/lib/plan-time.mjs';

const clock = n => ({ now: Date.parse(h(n)), clockMode: 'simulation' });
const unchanged = /unchanged.progress|no.progress|progress.unchanged/i;
const measure = (f, id, n) => measurePlan(f.state(), loadPlan(f.state(), id), clock(n)).time;
const reconcile = f => reconcilePlans(f.records, 'HEAD', 'tb', { host, live: false, now: Date.parse(h(25)) });
const cliMeasure = (f, id, n) => {
  const r = f.cli('plan.mjs', ['measure', '--records', f.records, '--plan', id, '--now', h(n), '--json']);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout).time;
};
const markdown = p => [`# ${p.id}`, `scope: ${p.scope}`, `phase: ${p.phase}`, `time: ${p.time}`,
  ...p.packages.flatMap(x => [`## ${x.id}`, ...Object.entries(x).filter(([k]) => k !== 'id').map(([k,v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)])].join('\n') + '\n';

for (const encoding of ['Markdown', 'JSON']) test(`SOL01 ${encoding}: malformed optional time preserves both plans and CLI readiness`, t => {
  const f = fixture(t, { timed: false, packages: [{ id: 'a', needs: [] }] });
  const broken = { ...structuredClone(f.plan), time: '{broken' };
  const healthy = { ...structuredClone(f.plan), id: 'PL-0002', scope: 'independent', packages: [{ ...f.plan.packages[0], id: 'c', files: ['src/c/**'], handoff: 'R-0001-actor-c' }] };
  f.writePlan(healthy);
  f.put('plans/PL-0001.md', encoding === 'Markdown' ? markdown(broken) : json(broken));
  f.commit('Malformed optional field beside independent work');
  const head = f.git('rev-parse', 'HEAD'), status = f.git('status', '--porcelain');
  assert.equal(parsePlan(f.state().read('plans/PL-0001.md')).id, 'PL-0001');
  const r = reconcile(f);
  assert.equal(r.problem, null);
  for (const [id, pkg] of [['PL-0001', 'a'], ['PL-0002', 'c']]) {
    const row = r.plans.find(p => p.plan.id === id);
    assert.ok(row?.result?.ready.includes(pkg), JSON.stringify(row));
    const cli = f.cli('plan.mjs', ['ready', '--records', f.records, '--plan', id, '--now', h(25), '--json']);
    assert.equal(cli.status, 0, cli.stderr);
    assert.ok(JSON.parse(cli.stdout).ready.includes(pkg), cli.stdout);
  }
  const p = cliMeasure(f, 'PL-0001', 25);
  assert.ok(p, 'malformed optional time must remain visible as unknown');
  assert.equal(p.elapsedSeconds, null);
  assert.equal(p.remainingSeconds, null);
  assert.equal(p.forecast.latestAt, null);
  assert.ok(p.findings.length || p.forecast.unknowns.length);
  assert.equal(cliMeasure(f, 'PL-0002', 25), null);
  assert.equal(f.git('rev-parse', 'HEAD'), head);
  assert.equal(f.git('status', '--porcelain'), status);
});

for (const depth of [1, 2]) test(`SOL02 ${depth}-hop omitted time: original budget, promise and missed checkpoint survive`, t => {
  const f = fixture(t);
  const first = f.publish(f.observation({ checkpoint: 6 }));
  for (let n = 2; n <= depth + 1; n++) {
    const successor = { ...structuredClone(f.plan), id: `PL-000${n}`, supersedes: `PL-000${n-1}` };
    delete successor.time;
    f.writePlan(successor); f.commit(`Restart ${n} without optional time`, 25);
  }
  const id = `PL-000${depth+1}`, s = f.state(), plan = loadPlan(s, id);
  assert.ok(validatePlanTime(plan, s).length, 'budget-bearing ancestry needs missing-lineage screening');
  const r = reconcile(f);
  assert.equal(r.problem, null);
  assert.ok(r.plans.find(p => p.plan.id === id)?.result?.ready.includes('a'));
  for (const p of [measure(f, id, 26), cliMeasure(f, id, 26)]) {
    assert.ok(p, 'omitted optional time cannot hide undertaking history');
    assert.equal(p.rootPlan, 'PL-0001');
    assert.equal(p.elapsedSeconds, 26 * 3600);
    assert.equal(p.deadline, h(24));
    assert.equal(p.remainingSeconds, -7200);
    assert.ok(p.history.some(row => row.ref.path === first.path));
    assert.ok(p.checkpoint.missed.some(row => row.at === h(6)));
    assert.ok(p.promises.some(row => row.id === 'usable' && row.dueAt === h(24) && row.status === 'overdue'));
    assert.ok(p.findings.length, 'missing lineage must stay visible');
    assert.equal(p.forecast.latestAt, null, 'ancestor forecast is not a fresh successor forecast');
  }
});

test('SOL02 control: genuinely legacy two-hop no-time chain stays ready with null time', t => {
  const f = fixture(t, { timed: false });
  for (let n = 2; n <= 3; n++) {
    f.writePlan({ ...structuredClone(f.plan), id: `PL-000${n}`, supersedes: `PL-000${n-1}` });
    f.commit(`Legacy successor ${n}`);
  }
  assert.deepEqual(validatePlanTime(loadPlan(f.state(), 'PL-0003'), f.state()), []);
  assert.equal(cliMeasure(f, 'PL-0003', 26), null);
  assert.ok(reconcile(f).plans.find(p => p.plan.id === 'PL-0003')?.result?.ready.includes('a'));
});

test('SOL03 selected head: empty -> X -> X screens stall; subsequent Y is genuine progress', async t => {
  const f = fixture(t);
  const zero = f.publish(f.observation());
  f.done('a', 3);
  const one = f.publish(f.observation({ asOf: 3, checkpoint: 8, parents: [zero] }));
  const progressed = await project(f, 3);
  assert.equal(progressed.progress.completedHandoffs.length, 1);
  assert.doesNotMatch(progressed.findings.join('\n'), unchanged);
  const two = f.publish(f.observation({ asOf: 4, checkpoint: 12, parents: [one], estimates: { a: f.estimate(0, 0, 4), b: f.estimate(4, 5, 4) } }));
  const stalled = cliMeasure(f, 'PL-0001', 4);
  assert.equal(stalled.observationRef.path, two.path);
  assert.equal(stalled.history.length, 3);
  assert.match(stalled.findings.join('\n'), unchanged);
  assert.equal(stalled.progress.completedHandoffs.length, 1);
  f.done('b', 5);
  const latest = f.publish(f.observation({ asOf: 5, checkpoint: 13, parents: [two] }));
  const advanced = await project(f, 5);
  assert.equal(advanced.progress.completedHandoffs.length, 2);
  assert.equal(advanced.observationRef.path, latest.path);
  for (const finding of advanced.findings.filter(x => unchanged.test(x))) {
    assert.ok(finding.includes(two.path), 'retained stall must identify the historical stalled observation');
    assert.ok(!finding.includes(latest.path), 'new advancing head must not be reported unchanged');
  }
  assert.doesNotMatch(JSON.stringify(advanced.forecast), /unchanged-progress/);
});

test('SOL03 repinning: identical completion bytes and parent at newer Git cut are still unchanged', async t => {
  const f = fixture(t);
  f.done('a', 2);
  const one = f.publish(f.observation({ asOf: 2, checkpoint: 8 }));
  const before = await project(f, 2);
  f.put('README.md', 'Unrelated explanatory edit\n'); f.commit('Repin only', 3);
  const repinned = f.ref(one.path);
  assert.notEqual(repinned.commit, one.commit);
  assert.equal(repinned.sha256, one.sha256);
  f.publish(f.observation({ asOf: 3, checkpoint: 9, parents: [repinned] }));
  const after = await project(f, 3);
  const a = before.progress.completedHandoffs[0], b = after.progress.completedHandoffs[0];
  assert.notEqual(a.commit, b.commit);
  assert.deepEqual([a.repository, a.path, a.sha256], [b.repository, b.path, b.sha256]);
  assert.equal(after.forecast.stale, false);
  assert.match(after.findings.join('\n'), unchanged);
});

test('SOL03 branching: different-cut tips conflict, all-tip resolution retains the stalled X edge', async t => {
  const f = fixture(t), zero = f.publish(f.observation()), cut = f.git('rev-parse', 'HEAD');
  const left = f.observation({ basedOn: cut, asOf: 2, checkpoint: 8, parents: [zero] });
  f.done('a', 3);
  const right = f.publish(f.observation({ asOf: 3, checkpoint: 9, parents: [zero] }));
  const l = f.publish(left, 4);
  const conflict = await project(f, 4);
  assert.equal(conflict.observationRef, null);
  assert.equal(conflict.forecast.latestAt, null);
  assert.match(conflict.findings.join('\n'), /conflict/i);
  const resolution = f.publish(f.observation({ asOf: 5, checkpoint: 12, parents: [l, right] }));
  const resolved = await project(f, 5);
  assert.equal(resolved.observationRef.path, resolution.path);
  assert.equal(resolved.history.length, 4);
  assert.doesNotMatch(resolved.findings.join('\n'), /forecast-conflict/);
  assert.match(JSON.stringify({ findings: resolved.findings, history: resolved.history }), unchanged, 'resolution has no new evidence beyond the X parent');
  assert.equal(resolved.progress.completedHandoffs.length, 1);
});

test('SOL03 unknown comparison: unavailable historical cut cannot certify unchanged or advancing evidence', async t => {
  const f = fixture(t), first = f.publish(f.observation());
  f.done('a', 3);
  f.publish(f.observation({ asOf: 3, checkpoint: 9, parents: [first] }));
  const p = await project(f, 3, { historicalSnapshots: {} });
  assert.equal(p.forecast.latestAt, null);
  assert.match(JSON.stringify(p), /missing|unavailable|unknown|incomplete/i);
  assert.doesNotMatch(p.findings.join('\n'), unchanged);
});
