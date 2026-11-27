import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loopProduct, ownerStore, ROOMY, isolatedEnv, selfLoop, git } from './helpers.mjs';

// D-0016, D-0017, D-0069
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const detectorRevision = '32c9634ed2457e47e1e12f4a3d4e59a337a3472a';
const manifestPath = 'evidence/normal-entry/manifest.json';
const section = text => text.slice(text.indexOf('Normal opportunities:'), text.indexOf('\n\n-', text.indexOf('Normal opportunities:')));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alarm-entry-wiring-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const p = loopProduct({ dir: join(root, 'loop'), activity: '2026-11-22T00:00:00Z' });
  const write = (path, raw) => { mkdirSync(dirname(join(p.records, path)), { recursive: true }); writeFileSync(join(p.records, path), raw); };
  const commit = () => { git(p.records, 'add', '.'); git(p.records, 'commit', '-qm', 'synthetic wiring fixture'); return git(p.records, 'rev-parse', 'HEAD'); };
  const baseline = git(p.records, 'rev-parse', 'HEAD'), repo = `git-root:${baseline}`, key = 'ci-not-green:v1:1';
  const line = JSON.stringify({ time: '2026-11-22T01:00:00Z', round: 1, phase: 'v1', role: 'judge',
    area: '-', model: 'fixture', verdict: 'CONTINUE', opened: '-', closed: '-', suite: '1/0', owner: '0',
    commit: git(p.product, 'rev-parse', 'HEAD'), ci: 'failure' });
  write('metrics/trajectory.jsonl', line + '\n');
  const publication = commit();
  const occurrence = 'alarm-' + digest(JSON.stringify([repo, 'v1', 'trajectory', key, publication, digest(line)]));
  const source = { repo, revision: publication, path: 'metrics/trajectory.jsonl',
    selector: { type: 'alarm', origin: 'trajectory', key, lineSha256: digest(line), occurrence: 0, detectorRevision },
    entryRange: [0, Buffer.byteLength(line)], clauseRange: [0, Buffer.byteLength(line)],
    blobSha256: digest(line + '\n'), clauseSha256: digest(line) };
  const manifest = { schema: 'normal-entry-manifest/v2', repo, baseline, phase: 'v1',
    inventory: [{ kind: 'alarm', entryId: occurrence, clauseId: 'alarm', path: source.path, operation: 'upsert', source, predecessor: null }], dispositions: [] };
  write(manifestPath, JSON.stringify(manifest)); commit();
  mkdirSync(join(root, 'store'));
  const store = ownerStore([{ name: 'fixture', records: p.records }], { dir: join(root, 'store'), bound: ROOMY });
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const next = () => {
    const result = selfLoop(['next', '--config', join(p.records, 'loop.json')], { env, cwd: p.product });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  const diagnose = (time, bodyOnly = false, phase = 'v1') => {
    const record = 'rounds/0002-reviewer-diagnosis.md';
    write(record, `# Synthetic diagnosis\n${bodyOnly ? '## Report (verbatim)\n' : ''}alarms: ${key}\n`);
    write('metrics/handoffs.jsonl', JSON.stringify({ id: 'R-0002-reviewer-diagnosis', phase, round: 2,
      record, role: 'reviewer', step: 'reviewer-diagnosis', files: [record], view: publication, time,
      attempt: 1, audit: { violations: 0 }, agent: { runner: 'claude' }, product: null }) + '\n'); commit();
  };
  return { p, write, commit, key, line, occurrence, next, diagnose, env };
}
test('next separates identity and accounting; start forwards the same committed view', t => {
  const f = fixture(t), text = f.next();
  assert.match(text, /pending\/absent/); assert.match(text, /active\/required \(alarm_active\)/);
  assert.ok(text.includes(`occurrence ${f.occurrence}; identity source`));
  assert.ok(text.includes(`alarms need diagnosis: ${f.key}`));
  assert.match(text, /building features without a recorded running call/);
  assert.equal(section(f.next()), section(text));
  f.write(manifestPath, 'uncommitted invalid data'); f.write('metrics/trajectory.jsonl', 'uncommitted invalid data');
  const start = selfLoop(['start', '--json'], { env: f.env, cwd: f.p.product });
  assert.equal(start.status, 0, start.stderr);
  const report = JSON.parse(start.stdout); assert.equal(report.session.error, null);
  assert.equal(section(report.session.next), section(text));
});
test('same-second diagnosis leaves occurrence pending; raw duplicate requires diagnosis again', t => {
  const f = fixture(t); f.diagnose('2026-11-22T01:00:00Z');
  const covered = f.next();
  assert.match(covered, /active\/covered \(alarm_active\)/); assert.match(covered, /pending\/absent/);
  assert.doesNotMatch(covered, /alarms need diagnosis:/);
  f.write('metrics/trajectory.jsonl', f.line + '\n' + f.line + '\n'); f.commit();
  const duplicate = f.next();
  assert.ok(duplicate.includes(`alarms need diagnosis: ${f.key}, ${f.key}`));
  assert.match(duplicate, /unknown\/stale_inventory/);
  assert.match(duplicate, /building features without a recorded running call/);
});
test('strictly later diagnosis covers duplicate while current source stays stale', t => {
  const f = fixture(t); f.diagnose('2026-11-22T02:00:00Z');
  f.write('metrics/trajectory.jsonl', f.line + '\n' + f.line + '\n'); f.commit();
  const text = f.next(); assert.doesNotMatch(text, /alarms need diagnosis:/); assert.match(text, /unknown\/stale_inventory/);
});
for (const [name, bodyOnly, phase] of [['report-body-only', true, 'v1'], ['wrong-phase', false, 'other']]) {
  test(`${name} diagnosis cannot cover canonical entry`, t => {
    const f = fixture(t); f.diagnose('2026-11-22T02:00:00Z', bodyOnly, phase);
    const text = f.next(); assert.match(text, /active\/required/); assert.ok(text.includes(`alarms need diagnosis: ${f.key}`));
  });
}
test('unreadable durable stall ledger preserves diagnosis and ordinary work', t => {
  const f = fixture(t); f.write('metrics/alarms.jsonl', 'invalid json\n'); f.commit();
  const text = f.next(); assert.match(text, /the alarm ledger cannot be read:/);
  assert.ok(text.includes(`alarms need diagnosis: ${f.key}`)); assert.match(text, /building features without a recorded running call/);
});
