// self-loop-records@bd8a1ad:evidence/0012/admitted-time-budget/contracts.json
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, digest, h, json } from '../../acceptance/time-budget/fixture.mjs';

function run(f, script, args) {
  const r = f.cli(script, args);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
const measure = (f, hour, plan = 'PL-0001') => JSON.parse(run(f, 'plan.mjs', ['measure', '--records', f.records, '--plan', plan, '--now', h(hour), '--json'])).time;
const entry = (f, command, hour) => run(f, 'self-loop.mjs', [command, '--config', join(f.records, 'loop.json'), '--owner-store', f.store, '--now', h(hour)]);
function tree(dir) {
  const result = {};
  function visit(path, prefix = '') {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + e.name, full = join(path, e.name);
      if (e.isDirectory()) visit(full, name + '/');
      else result[name] = digest(readFileSync(full));
    }
  }
  visit(dir);
  return result;
}

// self-loop-records@f81d0e8:evidence/0012/admitted-positive-final/effective-contract.json
function syntheticHandoffEvent(f, id, hour) {
  const author = 'SyntheticIndependentObserver', requestId = 'synthetic-completion-observation';
  const role = 'time-observer', selector = '# Synthetic archival root';
  f.put('decisions/D-0002.md', `${selector}\nSynthetic trusted archive for acceptance only; no physical clock or production event proof.\n${author} ${role} ${requestId} event-attest PL-0001 handoff-completed ${id}\n`);
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

test('real entry lifecycle: committed baseline, frozen ETA, progress, revision and restarted process', t => {
  const f = fixture(t), baseline = f.ref('plans/PL-0001.md');
  assert.equal(measure(f, 0).forecast.latestAt, null);
  const first = f.publish(f.observation());
  const initial = measure(f, 1);
  assert.equal(initial.forecast.earliestAt, h(7));
  assert.equal(initial.forecast.latestAt, h(9));
  assert.equal(initial.elapsedSeconds, 3600);
  assert.equal(initial.remainingSeconds, 23 * 3600);
  for (const command of ['next', 'start']) {
    const text = entry(f, command, 1);
    assert.ok(text.includes(h(7)), text);
    assert.ok(text.includes(h(9)), text);
    assert.match(text, /read-only simulation/);
  }
  f.done('a', 6);
  const current = measure(f, 6);
  assert.equal(current.forecast.earliestAt, h(7));
  assert.equal(current.forecast.latestAt, h(9));
  assert.equal(current.progress.completedHandoffs.length, 1);
  assert.ok(current.forecast.staleReasons.includes('canonical progress changed'));
  syntheticHandoffEvent(f, 'a', 6);
  f.publish(f.observation({ asOf: 6, parents: [first], checkpoint: 12 }));
  const refreshed = measure(f, 6);
  assert.equal(refreshed.forecast.earliestAt, h(8));
  assert.equal(refreshed.forecast.latestAt, h(9));
  assert.deepEqual(refreshed.forecast.historicalDone, ['a']);
  assert.deepEqual(refreshed.forecast.releaseEta, { earliestAt: null, latestAt: null, evidenceStatus: 'unverified' });
  assert.equal(refreshed.budget.deliveredAt, null);
  assert.equal(refreshed.plan, 'PL-0001');
  assert.equal(refreshed.rootPlan, 'PL-0001');
  assert.equal(refreshed.deadline, h(24));
  assert.equal(refreshed.elapsedSeconds, 6 * 3600);
  assert.equal(refreshed.remainingSeconds, 18 * 3600);
  assert.equal(refreshed.history.length, 2);
  assert.equal(refreshed.history[0].earliestAt, h(7));
  assert.deepEqual(measure(f, 6), refreshed);
  for (const command of ['next', 'start']) assert.ok(entry(f, command, 6).includes(h(8)));
  assert.equal(f.ref(baseline.path).sha256, baseline.sha256);
  assert.equal(f.state().read('metrics/handoffs.jsonl').trim().split('\n').length, 1);
  assert.deepEqual(refreshed.progress.releaseEvidence, []);
});

test('real forecast refresh keeps raw canonical completion timestamps timing-unverified', t => {
  const f = fixture(t), baseline = f.ref('plans/PL-0001.md');
  const first = f.publish(f.observation());
  f.done('a', 6);
  f.publish(f.observation({ asOf: 6, parents: [first], checkpoint: 12 }));
  const before = tree(f.dir), refreshed = measure(f, 6);
  assert.equal(refreshed.progress.completedHandoffs.length, 1);
  assert.equal(refreshed.forecast.earliestAt, null);
  assert.equal(refreshed.forecast.latestAt, null);
  assert.deepEqual(refreshed.forecast.historicalDone, []);
  assert.ok(refreshed.forecast.unknowns.includes('a: historical completion timing-unverified'));
  assert.deepEqual(refreshed.forecast.releaseEta, { earliestAt: null, latestAt: null, evidenceStatus: 'unverified' });
  assert.deepEqual(refreshed.progress.releaseEvidence, []);
  assert.equal(refreshed.budget.deliveredAt, null);
  assert.equal(refreshed.history.length, 2);
  assert.equal(refreshed.history[0].earliestAt, h(7));
  assert.equal(refreshed.history[0].latestAt, h(9));
  assert.equal(refreshed.plan, 'PL-0001');
  assert.equal(refreshed.rootPlan, 'PL-0001');
  assert.equal(refreshed.deadline, h(24));
  assert.equal(refreshed.elapsedSeconds, 6 * 3600);
  assert.equal(refreshed.remainingSeconds, 18 * 3600);
  assert.deepEqual(measure(f, 6), refreshed);
  for (const command of ['next', 'start']) entry(f, command, 6);
  assert.equal(f.ref(baseline.path).sha256, baseline.sha256);
  assert.deepEqual(tree(f.dir), before);
});

test('real restarted execution keeps root budget, old misses and cancellation history', t => {
  const f = fixture(t), first = f.publish(f.observation({ checkpoint: 6, outcome: 'cancelled' }));
  const successor = { ...structuredClone(f.plan), id: 'PL-0002', supersedes: 'PL-0001', time: { schema: 'plan-time/v2', rootPlan: 'PL-0001' } };
  f.writePlan(successor); f.commit('Restart authorized execution', 25);
  f.publish(f.observation({ asOf: 25, parents: [first], planId: 'PL-0002', checkpoint: 30 }));
  const result = measure(f, 25, 'PL-0002');
  assert.equal(result.rootPlan, 'PL-0001');
  assert.equal(result.deadline, h(24));
  assert.equal(result.elapsedSeconds, 25 * 3600);
  assert.equal(result.remainingSeconds, -3600);
  assert.equal(result.history.length, 2);
  assert.ok(result.history.some(x => x.outcome === 'cancelled'));
  assert.ok(result.checkpoint.missed.some(x => x.at === h(6)));
  assert.equal(result.promises[0].status, 'overdue');
  assert.deepEqual(measure(f, 25, 'PL-0002'), result);
  for (const command of ['next', 'start']) {
    const text = entry(f, command, 25);
    assert.match(text, /overdue by 3600 s/);
    assert.match(text, /Missed checkpoint history:/);
    assert.ok(text.includes(h(6)));
  }
});

test('real read-only entries ignore uncommitted forecast bytes and preserve all fixture files including refs/index', t => {
  const f = fixture(t), first = f.publish(f.observation());
  f.put(first.path, '{uncommitted corruption');
  const before = tree(f.dir);
  assert.equal(measure(f, 24).remainingSeconds, 0);
  assert.equal(measure(f, 25).forecast.latestAt, h(9));
  for (const command of ['next', 'start']) entry(f, command, 25);
  assert.deepEqual(tree(f.dir), before);
  for (const command of ['next', 'start']) {
    const r = f.cli('self-loop.mjs', [command, '--config', join(f.records, 'loop.json'), '--owner-store', f.store, '--now', h(25), '--parent-entry', join(f.dir, 'missing-entry.json')]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /--now simulation.*--parent-entry/);
    assert.deepEqual(tree(f.dir), before);
  }
});

test('real ordinary live entry reports system clock and future-clock anomaly without writing', t => {
  const f = fixture(t);
  const future = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  f.plan.time.baseline.startedAt = future;
  f.writePlan(f.plan); f.commit('Future baseline anomaly fixture');
  const before = tree(f.dir), lower = Date.now();
  const report = JSON.parse(run(f, 'self-loop.mjs', ['start', '--config', join(f.records, 'loop.json'), '--owner-store', f.store, '--json']));
  assert.equal(report.clock.mode, 'live');
  assert.equal(report.clock.source, 'system-utc');
  assert.ok(Date.parse(report.clock.now) >= lower && Date.parse(report.clock.now) <= Date.now());
  assert.match(report.session.next, /clock-anomaly/);
  assert.match(report.session.next, /Elapsed: unknown/);
  assert.deepEqual(tree(f.dir), before);
});
