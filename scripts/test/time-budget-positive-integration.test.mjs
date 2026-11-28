// F-0016, R-0056-judge-frame-velocity
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { positiveFixture, at, digest } from '../../acceptance/time-budget/positive-fixture.mjs';
import { fixture, h } from '../../acceptance/time-budget/fixture.mjs';
import { projectPlanTime } from '../lib/plan-time.mjs';

function noGitMaintenanceEnv(base = process.env) {
  const out = { ...base };
  const raw = Number(out.GIT_CONFIG_COUNT);
  let n = Number.isInteger(raw) && raw > 0 ? raw : 0;
  for (const [key, val] of [['gc.auto', '0'], ['maintenance.auto', 'false']]) {
    let has = false;
    for (let i = 0; i < n; i++) if (out[`GIT_CONFIG_KEY_${i}`] === key && out[`GIT_CONFIG_VALUE_${i}`] === val) has = true;
    if (!has) { out[`GIT_CONFIG_KEY_${n}`] = key; out[`GIT_CONFIG_VALUE_${n}`] = val; n++; }
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

const savedGitConfig = new Map();
before(() => {
  const next = noGitMaintenanceEnv(process.env);
  for (const k of Object.keys(next)) {
    if (k === 'GIT_CONFIG_COUNT' || k.startsWith('GIT_CONFIG_KEY_') || k.startsWith('GIT_CONFIG_VALUE_')) {
      savedGitConfig.set(k, process.env[k]);
      process.env[k] = next[k];
    }
  }
});
after(() => {
  for (const [k, v] of savedGitConfig) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const project = (f, rev) => { const a = f.args(rev); return projectPlanTime(a.stateAtQ, a.plan, a); };
const scripts = new URL('../', import.meta.url).pathname;
function cli(f, script, args) {
  const r = spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: 'utf8', cwd: f.records, timeout: 30000,
    env: noGitMaintenanceEnv({ ...process.env, HOME: f.records, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }) });
  assert.equal(r.status, 0, r.stderr || r.stdout); return r.stdout;
}
function tree(dir) {
  const out = {};
  const walk = (path, prefix = '') => { for (const e of readdirSync(path, { withFileTypes: true })) {
    const name = prefix + e.name, full = join(path, e.name);
    if (e.isDirectory()) walk(full, name + '/'); else out[name] = digest(readFileSync(full));
  } };
  walk(dir); return out;
}

for (const [scenario, budget, promise, availability] of [
  ['positive-on-time', 'delivered-on-time', 'met-on-time', 'verified'],
  ['positive-late', 'delivered-late', 'met-late', 'verified'],
  ['no-event', 'overdue', 'overdue', 'verified'],
  ['foreign-promise', 'delivered-on-time', 'overdue', 'verified'],
  ['different-promise-complete', 'delivered-on-time', 'met-on-time', 'verified'],
  ['current-regression', 'delivered-on-time', 'met-on-time', 'unavailable'],
  ['later-gate-ci-red', 'delivered-on-time', 'met-on-time', 'unavailable'],
  ['later-gate-suite-unknown', 'delivered-on-time', 'met-on-time', 'unverified'],
  ['event-conflict', 'overdue', 'overdue', 'verified'],
  ['event-correction', 'delivered-late', 'met-late', 'verified'],
]) test(`real pinned projection: ${scenario}`, t => {
  const f = positiveFixture(t, scenario, { external: true }), p = project(f);
  assert.equal(p.budget.status, budget, JSON.stringify(p.findings));
  assert.equal(p.promises[0].status, promise);
  assert.equal(p.budget.currentAvailability, availability);
  assert.equal(p.budget.evidenceStatus, 'verified');
  assert.equal(p.elapsedSeconds, 13 * 3600); assert.equal(p.remainingSeconds, -3600);
  assert.equal(p.progress.releaseEvidence.length, 1);
  const old = project(f, f.beforeEvidence);
  assert.equal(old.forecast.releaseEta.latestAt, null);
  assert.equal(old.budget.status, 'overdue'); assert.deepEqual(old.progress.releaseEvidence, []);
  assert.equal(old.history[0].latestAt, p.history[0].latestAt);
  assert.deepEqual(project(f, f.beforeEvidence), old);
});

for (const scenario of ['timely-forecast-publication', 'late-publication-earlier-delivery']) test(`checkpoint join: ${scenario}`, t => {
  const f = positiveFixture(t, scenario), p = project(f);
  const resolved = p.checkpoint.resolved.find(r => r.observationRef.path === f.foRef.path);
  assert.equal(Boolean(resolved), scenario === 'timely-forecast-publication');
  if (!resolved) assert.equal(p.checkpoint.missed.find(r => r.observationRef.path === f.foRef.path).status, 'missed');
  assert.equal(p.promises[0].status, 'met-on-time');
  assert.equal(p.history.length, 2); assert.equal(p.plan, 'PL-0001');
  assert.equal(p.history[1].progressComparison[0].status, 'changed');
});

for (const scenario of ['timely-historical-handoff', 'future-historical-handoff', 'late-historical-handoff-proof']) test(`historical completion operands: ${scenario}`, t => {
  const f = positiveFixture(t, scenario), p = project(f);
  assert.equal(p.progress.completedHandoffs.length, 1);
  const last = p.history.at(-1);
  assert.deepEqual(last.historicalDone, scenario === 'timely-historical-handoff' ? ['core'] : []);
  if (scenario === 'timely-historical-handoff') assert.equal(last.latestAt, '2026-11-22T10:40:00.000Z');
  if (scenario === 'future-historical-handoff') assert.equal(last.latestAt, null);
  assert.equal(p.history[0].latestAt, '2026-11-22T11:20:00.000Z');
});

test('actual measure, next, start expose evidence without writes; malformed unrelated evidence does not block ready work', t => {
  const f = positiveFixture(t), args = ['--records', f.records, '--plan', 'PL-0001', '--now', at('13:00')];
  const ready = f.ready();
  const raw = '{broken'; f.put(`evidence/0012/time-binding/TB-${digest(raw)}.json`, raw); const q = f.commit('Unrelated malformed evidence');
  assert.deepEqual(f.ready(q), ready);
  const before = tree(f.records);
  const measured = JSON.parse(cli(f, 'plan.mjs', ['measure', ...args, '--json']));
  assert.equal(measured.time.budget.status, 'delivered-on-time');
  assert.match(cli(f, 'plan.mjs', ['measure', ...args]), /Delivery: verified; at 2026-11-22T11:50:00Z/);
  for (const command of ['next', 'start']) {
    const text = cli(f, 'self-loop.mjs', [command, '--config', join(f.records, 'loop.json'), '--owner-store', join(f.records, 'missing-store'), '--now', at('13:00')]);
    assert.match(text, /met-on-time/); assert.match(text, /read-only simulation/);
    const refused = spawnSync(process.execPath, [join(scripts, 'self-loop.mjs'), command, '--now', at('13:00'), '--parent-entry', '/missing'], { encoding: 'utf8', env: noGitMaintenanceEnv(process.env) });
    assert.notEqual(refused.status, 0); assert.match(refused.stderr + refused.stdout, /--now simulation.*--parent-entry/);
  }
  assert.deepEqual(tree(f.records), before);
});

test('no deadline remains unspecified and forecast refresh preserves execution bytes', t => {
  const f = fixture(t, { deadline: null }), first = f.publish(f.observation()), original = f.ref('plans/PL-0001.md');
  f.publish(f.observation({ asOf: 6, parents: [first], checkpoint: 12 }));
  const r = f.cli('plan.mjs', ['measure', '--records', f.records, '--plan', 'PL-0001', '--now', h(25), '--json']);
  assert.equal(r.status, 0, r.stderr); const p = JSON.parse(r.stdout).time;
  assert.equal(p.budget.status, 'unspecified'); assert.equal(p.remainingSeconds, null);
  assert.equal(p.elapsedSeconds, 25 * 3600); assert.equal(p.history.length, 2);
  assert.equal(f.ref(original.path).sha256, original.sha256);
  assert.ok(p.findings.some(s => s.startsWith('unchanged-progress:')));
});
