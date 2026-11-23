// self-loop-records@7bcdbbf:evidence/0012/brief-r12-scope-acceptance.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { positiveFixture, at, canonical, digest, json } from './positive-fixture.mjs';
import { evaluateTimeEvidence } from '../../scripts/lib/plan-time-evidence.mjs';
import { projectPlanTime } from '../../scripts/lib/plan-time.mjs';

const cases = [
  { id: 'matching', selected: ['restart'], valid: true },
  { id: 'missing-required-terminal', selected: ['core'] },
  { id: 'different-terminal', selected: ['polish'] },
  { id: 'equivalent-explicit-closure', selected: ['restart', 'core'], valid: true },
  { id: 'permuted-explicit-closure', selected: ['core', 'restart'], valid: true },
  { id: 'required-dependency-deferral', selected: ['restart'], deferred: ['core'] },
  { id: 'required-terminal-deferral', selected: ['core'], deferred: ['restart'] },
  { id: 'unapproved-optional-deferral', selected: ['restart'], deferred: ['polish'] },
  { id: 'approved-optional-deferral', selected: ['restart'], deferred: ['polish'], approvedOptional: true, valid: true },
  { id: 'wrong-cut', selected: ['restart'], bad: 'cut' },
  { id: 'other-plan', selected: ['restart'], bad: 'plan' },
  { id: 'unauthorized-source', selected: ['restart'], bad: 'role' },
];
function fixture(t, c) {
  const f = positiveFixture(t, 'positive-on-time', { external: true });
  const basedOn = f.revision;
  const observation = JSON.parse(f.git('show', `${f.foRef.commit}:${f.foRef.path}`));
  observation.parents = [f.foRef];
  observation.outlook.basedOn = basedOn;
  observation.outlook.releasePackages = c.selected;
  observation.outlook.change.deferredPackages = c.deferred ?? [];
  const bytes = json(observation), path = `forecasts/FO-${digest(bytes)}.json`;
  f.put(path, bytes); f.commit('Synthetic descendant with independently assessed selection');
  const observationRef = f.ref(path);
  const envelope = structuredClone(f.scope.envelope);
  envelope.basedOn = c.bad === 'cut' ? f.basedOn : basedOn;
  if (c.bad === 'plan') envelope.planRef = f.criteria[0];
  if (c.approvedOptional) envelope.claim.deferred = [{ package: 'polish', authorityRef: f.authority, selector: '## Optional', reason: 'Independently approved omission' }];
  const { type, rootRef, planRef, claim } = envelope;
  const source = { author: 'IndependentJudge', role: c.bad === 'role' ? 'actor' : 'judge', requestId: 'request-scope', endorsesClaim: digest(canonical({ type, rootRef, planRef, basedOn: envelope.basedOn, claim })) };
  const dir = 'evidence/0012/selection-assessment';
  const sourceBytes = json(source);
  const platform = f.git('show', `${f.scope.envelope.sourceRef.commit}:evidence/0012/archive-1/platform.json`) + '\n';
  f.put(`${dir}/source.json`, sourceBytes);
  f.put(`${dir}/platform.json`, platform);
  f.put(`${dir}/archive-hashes.json`, json({ 'source.json': digest(sourceBytes), 'platform.json': digest(platform) }));
  f.commit('Synthetic independent Scope archive for exact new observation cut');
  envelope.sourceRef = f.ref(`${dir}/source.json`);
  envelope.provenanceRefs = [f.ref(`${dir}/platform.json`), f.ref(`${dir}/archive-hashes.json`)];
  const bindingBytes = json(envelope), bindingPath = `evidence/0012/time-binding/TB-${digest(bindingBytes)}.json`;
  f.put(bindingPath, bindingBytes); f.commit('Synthetic independently endorsed Scope binding');
  return { f, observationRef, revision: f.git('rev-parse', 'HEAD') };
}
function read(f, revision) {
  const args = f.args(revision);
  assert.deepEqual(args.forecastHistory.errors, [], 'structurally valid real Git forecast history');
  assert.equal(args.forecastHistory.observations.length, 2);
  const evidence = evaluateTimeEvidence(args);
  const projection = projectPlanTime(args.stateAtQ, args.plan, args);
  return { evidence, projection };
}
function assertDelivery(evidence, projection, f) {
  const release = evidence.releases.find(r => r.ref.sha256 === f.release.ref.sha256);
  assert.equal(release.verification, 'verified', 'selection mismatch must not invalidate independent complete release');
  assert.equal(release.availableAt, at('11:50'));
  assert.equal(projection.budget.status, 'delivered-on-time');
  assert.equal(projection.budget.deliveredAt, at('11:50'));
}
for (const c of cases) test(`scope correspondence: ${c.id}`, t => {
  const { f, observationRef, revision } = fixture(t, c);
  const before = f.ready(revision), { evidence, projection } = read(f, revision);
  assertDelivery(evidence, projection, f);
  assert.equal(evidence.scopeByObservation[f.foRef.path].verification, 'verified', 'independent historical matching observation stays verified');
  assert.equal(projection.observationRef.path, observationRef.path, 'new actual observation must be selected');
  assert.deepEqual(f.ready(revision), before);
  assert.deepEqual(before, f.ready(f.beforeEvidence));
  const scope = evidence.scopeByObservation[observationRef.path];
  if (c.valid) {
    assert.equal(scope.verification, 'verified');
    assert.equal(projection.forecast.releaseEta.evidenceStatus, 'verified');
    assert.equal(projection.forecast.releaseEta.earliestAt, '2026-11-22T11:00:00.000Z');
    assert.equal(projection.forecast.releaseEta.latestAt, '2026-11-22T11:20:00.000Z');
  } else {
    assert.notEqual(scope.verification, 'verified', 'actual forecast selection/deferral needs independent corresponding authorization');
    assert.equal(projection.forecast.releaseEta.earliestAt, null);
    assert.equal(projection.forecast.releaseEta.latestAt, null);
    assert.notEqual(projection.forecast.releaseEta.evidenceStatus, 'verified');
  }
});
for (const c of cases.filter(c => ['matching', 'missing-required-terminal', 'required-dependency-deferral', 'approved-optional-deferral'].includes(c.id))) {
  test(`scope correspondence actual CLI next/start: ${c.id}`, t => {
    const { f, revision } = fixture(t, c), ready = f.ready(revision);
    const status = f.git('status', '--porcelain');
    for (const command of ['next', 'start']) {
      const result = spawnSync(process.execPath, [new URL('../../scripts/self-loop.mjs', import.meta.url).pathname, command,
        '--config', `${f.records}/loop.json`, '--owner-store', `${f.records}/missing-store`, '--now', at('13:00')],
      { cwd: f.records, encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: f.records, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const text = result.stdout;
      assert.match(text, /Minimum delivery: delivered-on-time · evidence: verified/);
      assert.match(text, /Continue authorized ready work under existing readiness and quality gates/);
      if (c.valid) assert.match(text, /Usable-release ETA \(scope verified\): earliest 2026-11-22T11:00:00.000Z · latest 2026-11-22T11:20:00.000Z/);
      else {
        assert.doesNotMatch(text, /Usable-release ETA \(scope verified\):/);
        assert.match(text, /Usable-release ETA \(scope [^)]+\): earliest unknown · latest unknown/);
      }
    }
    assert.equal(f.git('rev-parse', 'HEAD'), revision);
    assert.equal(f.git('status', '--porcelain'), status);
    assert.deepEqual(f.ready(revision), ready);
  });
}
