// self-loop-records@f81d0e8:evidence/0012/admitted-positive-final/effective-contract.json
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { positiveFixture, at, digest } from '../../acceptance/time-budget/positive-fixture.mjs';
import { timeLines } from '../loop.mjs';

const scripts = new URL('../', import.meta.url).pathname;
function cli(f, command) {
  const r = spawnSync(process.execPath, [join(scripts, 'self-loop.mjs'), command,
    '--config', join(f.records, 'loop.json'), '--owner-store', join(f.records, 'missing-store'), '--now', at('13:00')],
  { encoding: 'utf8', cwd: f.records, timeout: 30000,
    env: { ...process.env, HOME: f.records, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return r.stdout;
}
function tree(dir) {
  const out = {};
  function walk(path, prefix = '') {
    for (const e of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + e.name, full = join(path, e.name);
      if (e.isDirectory()) walk(full, name + '/'); else out[name] = digest(readFileSync(full));
    }
  }
  walk(dir);
  return out;
}

for (const [scenario, budget, promise, availability, deliveredAt] of [
  ['positive-on-time', 'delivered-on-time', 'met-on-time', 'verified', at('11:50')],
  ['positive-late', 'delivered-late', 'met-late', 'verified', at('12:10')],
  ['no-event', 'overdue', 'overdue', 'verified', null],
  ['untrusted-time', 'overdue', 'overdue', 'verified', null],
  ['foreign-promise', 'delivered-on-time', 'overdue', 'verified', at('11:50')],
  ['different-promise-complete', 'delivered-on-time', 'met-on-time', 'verified', at('11:50')],
  ['current-regression', 'delivered-on-time', 'met-on-time', 'unavailable', at('11:50')],
  ['later-gate-ci-red', 'delivered-on-time', 'met-on-time', 'unavailable', at('11:50')],
  ['later-gate-suite-unknown', 'delivered-on-time', 'met-on-time', 'unverified', at('11:50')],
]) test(`synthetic committed evidence in next/start: ${scenario}`, t => {
  const f = positiveFixture(t, scenario, { external: true });
  const ready = f.ready(), before = [tree(f.records), tree(f.product)];
  for (const command of ['next', 'start']) {
    const text = cli(f, command);
    assert.ok(text.includes(`Minimum delivery: ${budget} · evidence: verified · delivered at: ${deliveredAt ?? 'unknown (timing unverified)'} · current availability: ${availability}`), text);
    const promises = text.split('\n').filter(l => l.includes('Promise history:')).map(l => JSON.parse(l.split('Promise history: ')[1]));
    assert.equal(promises.length, 1); assert.equal(promises[0].status, promise);
    assert.match(text, /Elapsed: 46800 s · deadline: 2026-11-22T12:00:00Z · budget: overdue by 3600 s/);
    assert.match(text, /read-only simulation/);
    assert.match(text, /Usable-release ETA \(scope verified\): earliest 2026-11-22T11:00:00.000Z · latest 2026-11-22T11:20:00.000Z/);
    assert.match(text, /Conditional arithmetic diagnostic as of/);
    assert.match(text, /Forecast history: .*"latestAt":"2026-11-22T11:20:00.000Z"/);
    assert.match(text, /Continue authorized ready work under existing readiness and quality gates/);
    if (!deliveredAt) {
      assert.doesNotMatch(text.split('\n').find(l => l.includes('Minimum delivery:')), /delivered-on-time|delivered-late/);
      assert.equal(promises[0].deliveredAt, null);
    }
  }
  assert.deepEqual(f.ready(), ready);
  assert.deepEqual([tree(f.records), tree(f.product)], before);
});

test('unknown scope keeps finite arithmetic diagnostic separate from unknown usable-release ETA', t => {
  const f = positiveFixture(t, 'unassigned-issuer', { external: true });
  const before = tree(f.records), ready = f.ready();
  for (const command of ['next', 'start']) {
    const text = cli(f, command);
    assert.match(text, /Usable-release ETA \(scope unverified\): earliest unknown · latest unknown/);
    assert.match(text, /Conditional arithmetic diagnostic as of .*earliest 2026-11-22T11:00:00.000Z · latest 2026-11-22T11:20:00.000Z/);
    assert.match(text, /Minimum delivery: overdue · evidence: unverified/);
  }
  assert.deepEqual(f.ready(), ready); assert.deepEqual(tree(f.records), before);
});

for (const scenario of ['timely-forecast-publication', 'late-publication-earlier-delivery'])
  test(`next/start checkpoint history: ${scenario}`, t => {
    const f = positiveFixture(t, scenario, { external: true });
    const before = tree(f.records), ready = f.ready();
    for (const command of ['next', 'start']) {
      const text = cli(f, command);
      const rows = label => text.split('\n').filter(l => l.includes(label)).map(l => JSON.parse(l.split(label)[1]));
      const resolved = rows('Resolved checkpoint history: '), missed = rows('Missed checkpoint history: ');
      if (scenario === 'timely-forecast-publication') {
        assert.ok(resolved.some(r => r.observationRef.path === f.foRef.path && r.status === 'met-on-time'));
        assert.ok(!missed.some(r => r.observationRef.path === f.foRef.path));
      } else {
        assert.equal(resolved.length, 0);
        assert.ok(missed.some(r => r.observationRef.path === f.foRef.path && r.status === 'missed'));
      }
      assert.ok(missed.some(r => r.observationRef.path === f.fo2Ref.path));
      assert.match(text, /Minimum delivery: delivered-on-time/);
      assert.equal(rows('Forecast history: ').length, 2);
      assert.match(text, /execution awaits an actual parent entry/);
    }
    assert.deepEqual(f.ready(), ready); assert.deepEqual(tree(f.records), before);
  });

test('renderer does not promote arithmetic or unverified ETA fields, or mutate its projection', () => {
  const p = { forecast: { earliestAt: at('11:00'), latestAt: at('11:20'), releaseEta: {
    evidenceStatus: 'unverified', earliestAt: at('11:00'), latestAt: at('11:20') } } };
  const before = structuredClone(p), text = timeLines(p).join('\n');
  assert.match(text, /Usable-release ETA \(scope unverified\): earliest unknown · latest unknown/);
  assert.match(text, /Minimum delivery: unknown · evidence: unverified · delivered at: unknown \(timing unverified\) · current availability: unverified/);
  assert.deepEqual(p, before);
});
