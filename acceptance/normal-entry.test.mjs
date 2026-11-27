import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { put, json, jsonl, status, skill } from './fixture.mjs';
import { phase } from './round6-b-fixture.mjs';
import { pkg, planText, judgeRow } from './v1-round9-fixture.mjs';

const manifestPath = 'evidence/normal-entry/manifest.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = '2026-11-22T00:00:00Z';
const copy = value => structuredClone(value);
const section = text => text.match(/^Normal opportunities:[^\n]*(?:\n  [^\n]*)*/m)?.[0];

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(process.env.NORMAL_ACCEPTANCE_TMP ?? tmpdir(), 'normal-entry-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin'), home = join(dir, 'home'), owner = join(dir, 'owner');
  for (const path of [bin, home, owner]) mkdirSync(path, { recursive: true });
  for (const command of ['gh', 'claude', 'codex', 't3']) chmodSync(put(bin, command, '#!/bin/sh\nexit 78\n'), 0o755);
  const env = { PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, HOME: home,
    XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file',
    GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_AUTHOR_DATE: stamp,
    GIT_COMMITTER_DATE: stamp, SELF_LOOP_OWNER_STORE: owner, SELF_LOOP_ADAPTERS: 'none', LC_ALL: 'C', TZ: 'UTC' };
  const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { env, encoding: 'utf8' }).trimEnd();
  const commit = (repo, message = 'Fixture publication') => {
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', message); return git(repo, 'rev-parse', 'HEAD');
  };
  const repo = (path, files) => {
    mkdirSync(path, { recursive: true }); git(path, 'init', '-q', '-b', 'main');
    for (const [name, value] of Object.entries(files)) put(path, name, value);
    commit(path); return path;
  };
  const run = (entry, args) => spawnSync(process.execPath, [join(skill, 'scripts', entry), ...args],
    { env, cwd: dir, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  const w = { dir, projects: dir, git, commit, repo, run };
  const p = phase(w, 'normal');
  put(owner, 'products.json', json({ roots: [], products: [{ name: 'normal', records: p.records, aliases: [] }] }));
  put(p.records, 'records.json', json({ extraKinds: [
    { kind: 'Normal-entry inventory', path: 'evidence/normal-entry/', changes: 'editable' },
    { kind: 'Plan', path: 'plans/PL-NNNN.md', changes: 'immutable', citedAs: 'PL-NNNN' },
  ] }));
  put(p.records, 'decisions/D-0031.md', '# D-0031\n\nstatus: active\nby: owner\n');
  put(p.records, 'plans/PL-0001.md', planText('PL-0001', [pkg('independent', { round: 2, authority: 'D-0031' })]));
  const answer = { batch: 'B-0001', time: stamp, words: '同意甲，暂缓乙', outcome: 'as-recommended' };
  put(p.records, 'owner/answers.jsonl', jsonl(answer));
  const baseline = commit(p.records);
  const identity = `git-root:${git(p.records, 'rev-list', '--max-parents=0', 'HEAD')}`;
  let manifest = { schema: 'normal-entry-manifest/v1', repo: identity, baseline, phase: 'v1', inventory: [], dispositions: [] };
  const head = () => git(p.records, 'rev-parse', 'HEAD');
  const pointer = (path, phrase, revision = head(), selector = { type: 'document' }) => {
    const bytes = execFileSync('git', ['-C', p.records, 'show', `${revision}:${path}`], { env });
    let end = bytes.length;
    if (selector.type !== 'document') { end = bytes.indexOf(10); if (end < 0) end = bytes.length; if (bytes[end - 1] === 13) end--; }
    const start = bytes.indexOf(Buffer.from(phrase));
    assert.ok(start >= 0, 'fixture phrase exists');
    const clauseRange = [start, start + Buffer.byteLength(phrase)];
    if (selector.type === 'answer') selector = { ...selector, lineSha256: hash(bytes.subarray(0, end)) };
    return { repo: identity, revision, path, selector, entryRange: [0, end], clauseRange,
      blobSha256: hash(bytes), clauseSha256: hash(bytes.subarray(...clauseRange)) };
  };
  const source = phrase => pointer('owner/answers.jsonl', phrase, head(), { type: 'answer', batch: answer.batch, time: stamp, occurrence: 0 });
  const row = (clauseId = 'alpha', phrase = '同意甲') => ({ kind: 'answer_clause', entryId: 'answer-one', clauseId,
    path: 'owner/answers.jsonl', operation: 'upsert', source: source(phrase), predecessor: null });
  const publish = () => { put(p.records, manifestPath, json(manifest)); return commit(p.records); };
  const cli = (entry = 'next') => status(run('self-loop.mjs', [entry, '--config', p.config]), 0);
  const project = async (revision = head(), due = false) => {
    const { readNormalEntry } = await import('../scripts/lib/normal-entry-source.mjs');
    const { normalOpportunities } = await import('../scripts/lib/normal-entry.mjs');
    const blockers = { open: ['core:open (R-0001)'], shelved: ['core:shelved (R-0001)'] };
    const facts = await readNormalEntry({ records: p.records, revision, phase: 'v1', cadence: { due, stateIdentity: hash('cadence') }, blockers });
    const result = normalOpportunities(facts);
    assert.strictEqual(result.blockers, blockers);
    return result;
  };
  const check = async expected => {
    const next = cli(), start = cli('start');
    assert.match(next, /Normal opportunities:/);
    assert.equal(section(start), section(next), 'start forwards the normal opportunity section');
    assert.match(next, /independent/, 'independent authorized package remains visible');
    const result = await project();
    if (expected) assert.equal(result.state, expected, JSON.stringify(result));
    return result;
  };
  let evidenceSequence = 0;
  const evidence = () => {
    evidenceSequence++;
    const refs = {};
    for (const key of ['rationale', 'ruling', 'consumer']) {
      const path = `evidence/normal-entry/public-${key}-${evidenceSequence}.json`;
      put(p.records, path, json({ passage: `${key} fixture evidence; no semantic admission claim` }));
      commit(p.records); refs[key] = pointer(path, `${key} fixture evidence`);
    }
    return refs;
  };
  const disposition = (item, refs, overrides = {}) => ({ id: 'd-' + item.version.slice(0, 12), version: item.version,
    source: item.source, outcome: 'NO_CHANGE', ...refs, decision: 'withhold', task: null,
    reason: 'Wait for actual authorized consumer acknowledgment', ...overrides });
  return { ...w, ...p, baseline, identity, head, pointer, source, row, publish, cli, project, check, evidence, disposition,
    get manifest() { return manifest; }, set manifest(v) { manifest = v; }, answer };
}

async function pending(t) {
  const f = fixture(t); f.manifest.inventory = [f.row()]; f.publish();
  return f;
}
const current = p => p.items.filter(i => i.current);
const reason = (p, code) => assert.ok(p.items.some(i => i.reason === code) || p.diagnostics.some(d => d.code === code), `expected ${code}: ${JSON.stringify(p)}`);

test('A01 ordered: ordinary next/start exposes bounded pending despite unknown completeness', async t => {
  const f = await pending(t), p = await f.check('pending');
  assert.equal(p.items.length, 1); assert.equal(p.items[0].reason, 'absent');
  assert.deepEqual(p.items[0].source, f.manifest.inventory[0].source);
  assert.equal(p.previousCut, f.baseline); assert.equal(p.currentCut, f.head());
  assert.deepEqual(p.packet.tags, ['event']); assert.ok(p.coverage.filter(c => c.family !== 'inventory').every(c => c.completeness === 'unknown'));
});
test('A02 ordered: unrelated HEAD and repeated invocation retain unresolved history', async t => {
  const f = await pending(t), a = await f.check();
  put(f.records, 'design/unrelated.md', '# Other work\n'); f.commit(f.records);
  const b = await f.check('pending'); assert.equal(b.items[0].version, a.items[0].version);
  assert.equal(b.previousCut, a.previousCut); assert.notEqual(b.packet.id, a.packet.id);
  assert.deepEqual(b, await f.project());
});
test('A03 ordered: staged/working manifests and sources cannot manufacture reconciliation', async t => {
  const f = await pending(t), a = await f.check(); const before = section(f.cli());
  put(f.records, manifestPath, '{"schema":"forged"}\n'); f.git(f.records, 'add', manifestPath);
  put(f.records, 'owner/answers.jsonl', 'working bytes\n');
  assert.deepEqual(await f.project(), a); assert.equal(section(f.cli()), before);
});
test('A04 ordered: exact public evidence supports structural reconciliation only', async t => {
  const f = await pending(t), a = await f.check();
  f.manifest.dispositions = [f.disposition(a.items[0], f.evidence())]; f.publish();
  const b = await f.check('accounted'); assert.equal(b.items[0].reason, 'exact_link'); assert.deepEqual(b.packet.tags, []);
});
test('A05 ordered: mixed clauses rebind independently and retain historical versions', async t => {
  const f = fixture(t); f.manifest.inventory = [f.row(), f.row('beta', '暂缓乙')]; f.publish();
  const a = await f.check(); const refs = f.evidence();
  f.manifest.dispositions = a.items.map(i => f.disposition(i, refs)); f.publish();
  put(f.records, 'owner/answers.jsonl', jsonl({ ...f.answer, words: '同意甲，推进乙' })); f.commit(f.records);
  f.manifest.inventory = [f.row(), f.row('beta', '推进乙')].map(r => ({ ...r, predecessor: a.items.find(i => i.logicalKey.includes(r.clauseId)).version }));
  f.publish(); const b = await f.check('pending'); assert.equal(b.items.length, 4);
  assert.ok(current(b).every(i => i.reason === 'stale'));
  const alpha = current(b).find(i => i.logicalKey.includes('alpha'));
  f.manifest.dispositions.push(f.disposition(alpha, f.evidence())); f.publish();
  const c = await f.check('pending'); assert.equal(current(c).find(i => i.version === alpha.version).status, 'reconciled');
  assert.equal(current(c).find(i => i.version !== alpha.version).status, 'pending');
});
test('A06 ordered: explicit tombstone and re-add cannot erase obligations', async t => {
  const f = await pending(t), a = await f.check(); const original = copy(f.manifest.inventory[0]);
  f.manifest.inventory = [{ ...original, operation: 'delete', source: null, predecessor: a.items[0].version }]; f.publish();
  const b = await f.check('pending'); reason(b, 'deletion_review'); assert.equal(b.items.length, 2);
  f.manifest.inventory = [{ ...original, predecessor: current(b)[0].version }]; f.publish();
  const c = await f.check('pending'); assert.equal(c.items.length, 3); assert.notEqual(current(c)[0].version, a.items[0].version);
});
test('A07 ordered: physical deletion and stale bytes override old exact dispositions', async t => {
  for (const mode of ['delete', 'edit']) await t.test(mode, async t => {
    const f = await pending(t), a = await f.check(); f.manifest.dispositions = [f.disposition(a.items[0], f.evidence())]; f.publish();
    if (mode === 'delete') rmSync(join(f.records, 'owner/answers.jsonl')); else put(f.records, 'owner/answers.jsonl', jsonl({ ...f.answer, words: 'changed' }));
    f.commit(f.records); reason(await f.check('unknown'), mode === 'delete' ? 'source_unavailable' : 'stale_inventory');
  });
});
test('A08 ordered: private and malformed routes leave the valid sibling pending', async t => {
  const f = await pending(t);
  for (const [n, path] of ['sealed/judge/secret.md', 'raw/session.json', '../owner/answers.jsonl', '/tmp/secret', 'owner/%61nswers.jsonl'].entries()) {
    const row = f.row(`bad-${n}`); row.path = path; row.source.path = path; f.manifest.inventory.push(row);
  }
  const link = 'decisions/D-0099.md'; symlinkSync('/unreachable/private-target', join(f.records, link));
  const row = f.row('symlink'); row.kind = 'trial'; row.path = link; row.source.path = link; row.source.selector = { type: 'document' };
  f.commit(f.records); row.source.revision = f.head(); f.manifest.inventory.push(row); f.publish();
  const p = await f.check('unknown'); assert.equal(p.items.find(i => i.logicalKey.includes('alpha')).status, 'pending');
  assert.ok(p.diagnostics.length > 0); assert.doesNotMatch(JSON.stringify(p), /private-target/);
});
test('A09 ordered: changed baseline and unavailable cut cannot reconcile', async t => {
  const f = await pending(t); await f.check(); f.manifest.baseline = f.head(); f.publish();
  reason(await f.check('unknown'), 'baseline_reset'); const p = await f.project('f'.repeat(40));
  assert.equal(p.state, 'unknown'); assert.ok(p.items.every(i => i.status === 'unknown'));
});
test('A10 ordered: identical duplicates collapse; conflicting current identity has no winner', async t => {
  const f = await pending(t); f.manifest.inventory.push(copy(f.manifest.inventory[0])); f.publish();
  const a = await f.check('pending'); assert.equal(a.items.length, 1); assert.ok(a.accounting.duplicateOccurrences > 0);
  f.manifest.inventory.push(f.row('alpha', '暂缓乙')); f.publish(); reason(await f.check('unknown'), 'duplicate_identity');
});
test('A11 ordered: malformed local rows retain valid siblings and report bounded diagnostics', async t => {
  const f = await pending(t), span = f.row('span'), digest = f.row('digest'), kind = f.row('kind');
  span.source.clauseRange = [99999, 100000]; digest.source.blobSha256 = '0'.repeat(64); kind.kind = 'mystery';
  f.manifest.inventory.push(span, digest, kind, null); f.manifest.dispositions = 'invalid'; f.publish();
  const p = await f.check('unknown'); assert.ok(p.items.some(i => i.logicalKey.includes('alpha')));
  assert.ok(p.diagnostics.length > 0);
});
test('A12 ordered: exact disposition outcomes and invalid evidence obey precedence', async t => {
  for (const mode of ['UNKNOWN', 'invalid', 'conflict', 'exact']) await t.test(mode, async t => {
    const f = await pending(t), a = await f.check(), d = f.disposition(a.items[0], f.evidence());
    if (mode === 'UNKNOWN') d.outcome = 'UNKNOWN';
    if (mode === 'invalid') d.consumer.clauseSha256 = '0'.repeat(64);
    f.manifest.dispositions = [d]; if (mode === 'conflict') f.manifest.dispositions.push({ ...copy(d), id: 'other', reason: 'A distinct hold reason' });
    f.publish(); const p = await f.check(); reason(p, { UNKNOWN: 'unknown_outcome', invalid: 'invalid_disposition', conflict: 'conflicting_disposition', exact: 'exact_link' }[mode]);
  });
});
test('A13 ordered: event and cadence coalesce without resetting due', async t => {
  const f = await pending(t); await f.check(); const a = await f.project(f.head(), true);
  assert.deepEqual(a.packet.tags, ['event', 'cadence']);
  f.manifest.dispositions = [f.disposition(a.items[0], f.evidence())]; f.publish();
  assert.deepEqual((await f.project(f.head(), true)).packet.tags, ['cadence']);
  const empty = fixture(t); empty.publish(); assert.deepEqual((await empty.project(empty.head(), true)).packet.tags, ['cadence']);
});
test('A14 ordered: ordinary malformed-data reporting retains ready work and blocker identity', async t => {
  const f = await pending(t);
  put(f.records, 'metrics/trajectory.jsonl', jsonl(
    judgeRow(2, { opened: 'core:open,core:shelved', time: stamp }),
    judgeRow(3, { shelved: 'core:shelved', time: stamp })));
  f.commit(f.records);
  const before = f.cli();
  assert.match(before, /core:open/); assert.match(before, /core:shelved/);
  put(f.records, manifestPath, '{broken'); f.commit(f.records);
  const p = await f.check('unknown'); assert.deepEqual(p.blockers, { open: ['core:open (R-0001)'], shelved: ['core:shelved (R-0001)'] });
  assert.match(before, /independent/); const after = f.cli('start');
  assert.doesNotMatch(after, /next failed:/); assert.match(after, /core:open/); assert.match(after, /core:shelved/);
});
test('A15 ordered: deletion omission and syntax failure retain obligations then permit repair', async t => {
  for (const mode of ['delete', 'omit', 'syntax']) await t.test(mode, async t => {
    const f = await pending(t), a = await f.check(); const saved = copy(f.manifest);
    if (mode === 'delete') rmSync(join(f.records, manifestPath));
    if (mode === 'omit') put(f.records, manifestPath, json({ ...saved, inventory: [] }));
    if (mode === 'syntax') put(f.records, manifestPath, '{'); f.commit(f.records);
    const b = await f.check('unknown'); assert.ok(b.items.some(i => i.version === a.items[0].version));
    reason(b, { delete: 'manifest_deleted', omit: 'inventory_omission', syntax: 'malformed_manifest' }[mode]);
    f.manifest = saved; f.publish(); const c = await f.check('pending'); assert.equal(c.items[0].version, a.items[0].version);
  });
});
test('A16 ordered: a source revision with identical clause bytes still needs an explicit rebind', async t => {
  const f = await pending(t), a = await f.check();
  put(f.records, 'design/relocation.md', '# Publish a new source cut\n'); f.commit(f.records);
  f.manifest.inventory = [{ ...f.row(), predecessor: a.items[0].version }]; f.publish();
  const b = await f.check('pending'); assert.equal(b.items.length, 2); assert.notEqual(current(b)[0].version, a.items[0].version);
});
test('A17 ordered: no inventory and empty inventory cannot imply universal completeness', async t => {
  const f = fixture(t); reason(await f.check('unknown'), 'missing_manifest');
  f.publish(); const p = await f.check('accounted'); assert.ok(p.coverage.length > 0);
  assert.ok(p.coverage.filter(c => c.family !== 'inventory').every(c => c.completeness === 'unknown')); assert.equal(p.items.length, 0);
});
test('A18 ordered: invalid conflicting candidate cannot hide behind a valid exact disposition', async t => {
  const f = await pending(t), a = await f.check(), d = f.disposition(a.items[0], f.evidence());
  f.manifest.dispositions = [d, { ...copy(d), id: 'bad', reason: 'Different candidate', outcome: 'BAD' }]; f.publish();
  const b = await f.check('unknown'); reason(b, 'conflicting_disposition'); assert.equal(b.items[0].status, 'pending');
});
test('A19 ordered: withdrawing a disposition restores pending despite historical evidence', async t => {
  const f = await pending(t), a = await f.check(); f.manifest.dispositions = [f.disposition(a.items[0], f.evidence())]; f.publish();
  await f.check('accounted'); f.manifest.dispositions = []; f.publish(); reason(await f.check('pending'), 'absent');
});
test('A20 ordered fixture-only: genuine live consumer acceptance remains external', async t => {
  const f = await pending(t), a = await f.check(); f.manifest.dispositions = [f.disposition(a.items[0], f.evidence())]; f.publish();
  const p = await f.check('accounted'); assert.equal(p.items[0].status, 'reconciled');
  assert.equal(Object.hasOwn(p, 'admitted'), false); assert.equal(Object.hasOwn(p, 'clean'), false);
});

test('F01 fresh: a byte-valid digest cannot legitimize a split UTF-8 clause', async t => {
  const f = await pending(t), bad = f.row('split');
  bad.source.clauseRange[0]++;
  const bytes = Buffer.from(jsonl(f.answer));
  bad.source.clauseSha256 = hash(bytes.subarray(...bad.source.clauseRange));
  f.manifest.inventory.push(bad); f.publish();
  const p = await f.check('unknown'); reason(p, 'bad_span');
  assert.equal(p.items.find(i => i.logicalKey.includes('alpha')).status, 'pending');
});
test('F02 fresh: changed entry byte offsets without predecessor cannot silently replace history', async t => {
  const f = await pending(t), a = await f.check();
  f.manifest.inventory = [f.row('alpha', '暂缓乙')]; f.publish();
  const p = await f.check('unknown'); reason(p, 'broken_chain');
  assert.ok(p.items.some(i => i.version === a.items[0].version));
});
test('F03 fresh: swapping duplicate conflict order cannot select a winner', async t => {
  const f = await pending(t); f.manifest.inventory.push(f.row('alpha', '暂缓乙')); f.publish();
  const a = await f.check('unknown'); f.manifest.inventory.reverse(); f.publish();
  const b = await f.check('unknown'); reason(a, 'duplicate_identity'); reason(b, 'duplicate_identity');
  assert.ok(current(a).every(i => i.status === 'unknown')); assert.ok(current(b).every(i => i.status === 'unknown'));
});

test('F04 fresh: Git content-call spy rejects an existing private blob before dereference', async t => {
  const f = fixture(t), path = 'sealed/private.md';
  put(f.records, path, 'PRIVATE-CONTENT-SENTINEL\n'); f.commit(f.records);
  const oid = f.git(f.records, 'rev-parse', `HEAD:${path}`);
  const row = f.row('private'); row.kind = 'trial'; row.path = path;
  row.source = f.pointer(path, 'PRIVATE-CONTENT-SENTINEL');
  f.manifest.inventory = [f.row(), row]; f.publish();
  const calls = [], originals = {};
  for (const method of ['spawnSync', 'execFileSync']) {
    originals[method] = childProcess[method];
    childProcess[method] = function(command, args, options) {
      if (command === 'git') calls.push({ args: [...args], input: String(options?.input ?? '') });
      return originals[method].apply(this, arguments);
    };
  }
  syncBuiltinESMExports();
  let p;
  try { p = await f.project(); }
  finally { Object.assign(childProcess, originals); syncBuiltinESMExports(); }
  assert.ok(calls.length, 'spy observes the actual Git boundary');
  const reads = calls.filter(c => c.args.includes('show') || (c.args.includes('cat-file') && !c.args.some(a => a.startsWith('--batch-check')) && !c.args.includes('-e') && !c.args.includes('-t')));
  assert.ok(!reads.some(c => [...c.args, c.input].some(a => a.includes(oid) || a.includes(path))), JSON.stringify(reads));
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-CONTENT-SENTINEL/);
  assert.equal(p.state, 'unknown'); assert.equal(p.items.find(i => i.logicalKey.includes('alpha')).status, 'pending');
});
