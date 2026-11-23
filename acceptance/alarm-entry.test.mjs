import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { firings, undiagnosedAlarms } from '../scripts/lib/diagnosis.mjs';
import { buildAlarmContext } from '../scripts/lib/normal-entry-source.mjs';
import { parseRows } from '../scripts/trajectory.mjs';
import { put, json, jsonl, status, skill } from './fixture.mjs';
import { phase } from './round6-b-fixture.mjs';
import { pkg, planText, judgeRow } from './v1-round9-fixture.mjs';

const detector = '32c9634ed2457e47e1e12f4a3d4e59a337a3472a';
const trajectoryPath = 'metrics/trajectory.jsonl', stallPath = 'metrics/alarms.jsonl';
const alarmKey = 'ci-not-green:v1:1';
const stallKey = 'stall:v1:2026-11-22T00:00:00Z';
const occurrenceId = (repo, phase, origin, key, publication, lineHash) => 'alarm-' + hash(JSON.stringify([repo, phase, origin, key, publication, lineHash]));
const manifestPath = 'evidence/normal-entry/manifest.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = '2026-11-22T00:00:00Z';
const copy = value => structuredClone(value);
const section = text => text.match(/^Normal opportunities:[^\n]*(?:\n  [^\n]*)*/m)?.[0];

function fixture(t) {
  const dir = mkdtempSync(join(process.env.NORMAL_ACCEPTANCE_TMP ?? tmpdir(), 'normal-entry-'));
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
  const p = phase(w, 'normal', { files: { FIXTURE_ID: dir + '\n' } });
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
  const project = async (revision = head(), due = false, contextOverride = undefined) => {
    const { readNormalEntry } = await import('../scripts/lib/normal-entry-source.mjs');
    const { normalOpportunities } = await import('../scripts/lib/normal-entry.mjs');
    const blockers = { open: ['core:open (R-0001)'], shelved: ['core:shelved (R-0001)'] };
    const alarmContext = contextOverride === undefined ? context(revision) : contextOverride;
    const facts = await readNormalEntry({ records: p.records, revision, phase: 'v1', alarmContext, cadence: { due, stateIdentity: hash('cadence') }, blockers });
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
  const episodes = new Map();
  const ledger = (rows, path = trajectoryPath) => {
    put(p.records, path, rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
    return commit(p.records);
  };
  const alarm = (raw, key = alarmKey, publication, revision = head(), origin = 'trajectory', occurrence = 0) => {
    const path = origin === 'trajectory' ? trajectoryPath : stallPath;
    const bytes = Buffer.from(git(p.records, 'show', `${revision}:${path}`) + '\n');
    const line = typeof raw === 'string' ? raw : JSON.stringify(raw);
    let start = -1, from = 0;
    for (let n = 0; n <= occurrence; n++) { start = bytes.indexOf(Buffer.from(line), from); from = start + Buffer.byteLength(line); }
    assert.ok(start >= 0);
    const entryId = occurrenceId(identity, 'v1', origin, key, publication, hash(line));
    episodes.set(key, entryId);
    return { kind: 'alarm', path, entryId, clauseId: 'alarm', operation: 'upsert', predecessor: null,
      source: { repo: identity, revision, path,
        selector: { type: 'alarm', origin, key, lineSha256: hash(line), occurrence, detectorRevision: detector },
        entryRange: [start, from], clauseRange: [start, from], blobSha256: hash(bytes), clauseSha256: hash(line) } };
  };
  const context = (revision = head()) => {
    let fs = [], validation = 'valid';
    try {
      const present = git(p.records, 'ls-tree', revision, '--', trajectoryPath);
      if (present) fs = firings(parseRows(git(p.records, 'show', `${revision}:${trajectoryPath}`)));
    } catch { validation = 'unknown'; }
    let undiagnosedKeys = [];
    try { undiagnosedKeys = undiagnosedAlarms(p.records, revision, 'v1').map(a => a.key); }
    catch { validation = 'unknown'; }
    return buildAlarmContext({ records: p.records, revision, phase: 'v1', detectorRevision: detector,
      trajectory: { validation, firings: fs, undiagnosedKeys },
      stall: { validation: 'valid', currentKey: episodes.has(stallKey) ? stallKey : null } });
  };
  const diagnose = ({ time = stamp, phase: diagPhase = 'v1', bodyOnly = false } = {}) => {
    const record = 'rounds/0002-reviewer-diagnosis.md';
    put(p.records, record, `# Diagnosis\n${bodyOnly ? '' : `alarms: ${alarmKey}\n`}## Report (verbatim)\nalarms: ${alarmKey}\n`);
    const prior = git(p.records, 'show', `HEAD:metrics/handoffs.jsonl`);
    put(p.records, 'metrics/handoffs.jsonl', prior + '\n' + jsonl({ id: 'R-0002-reviewer-diagnosis', round: 2, phase: diagPhase,
      role: 'reviewer', step: 'reviewer-diagnosis', time, view: head(), attempt: 1, record, files: [record],
      product: { base: p.initial, commit: p.initial }, agent: { runner: 'claude', model: 'fixture-reviewer' }, audit: { violations: 0 } }));
    return commit(p.records);
  };
  return { ...w, ...p, baseline, identity, head, pointer, source, row, publish, cli, project, check, evidence, disposition,
    ledger, alarm, context, diagnose,
    get manifest() { return manifest; }, set manifest(v) { manifest = v; }, answer };
}

const line = extra => judgeRow(1, { time: stamp, ci: 'failure', commit: 'a'.repeat(40), ...extra });
const current = p => p.items.filter(i => i.current);
const alarmItems = p => p.items.filter(i => JSON.parse(i.logicalKey)[1] === 'alarm');
const state = (p, item = alarmItems(p).at(-1)) => {
  const rows = p.alarmStates.filter(s => s.version === item.version);
  assert.equal(rows.length, 1, 'one total state per distinct emitted alarm version');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['version', 'occurrenceId', 'identityBasis', 'evaluatedAtCut', 'applicability', 'diagnosis', 'successorOccurrenceId', 'reason'].sort());
  assert.equal(rows[0].evaluatedAtCut, p.currentCut);
  return rows[0];
};
const expect = (actual, fields) => { for (const [key, value] of Object.entries(fields)) assert.deepEqual(actual[key], value, key); };
const versions = p => p.items.map(i => i.version).sort();
const hasReason = (p, code) => assert.ok(p.items.some(i => i.reason === code) || p.diagnostics.some(d => d.code === code), `${code}: ${JSON.stringify(p)}`);
async function pending(t) {
  const f = fixture(t), raw = line(), publication = f.ledger([raw]);
  f.manifest.schema = 'normal-entry-manifest/v2';
  f.manifest.inventory = [f.alarm(raw, alarmKey, publication)]; f.publish();
  return { f, raw, publication };
}
async function account(f) {
  const p = await f.project(); const refs = f.evidence();
  f.manifest.dispositions = p.items.map(i => f.disposition(i, refs)); f.publish();
  return f.project();
}

// evidence/0012/alarm-response@9f4cef3; AE01-AE17; E01-E14; synthetic only, AE18 excluded.
test('AE01 AE12 AE14: normal next/start retain diagnosis, ready work and one event/cadence packet', async t => {
  const { f } = await pending(t), p = await f.check('pending');
  assert.equal(p.schema, 'normal-entry-projection/v2');
  expect(state(p), { occurrenceId: f.manifest.inventory[0].entryId, identityBasis: 'source', applicability: 'active', diagnosis: 'required', successorOccurrenceId: null, reason: 'alarm_active' });
  expect(p.items[0], { status: 'pending', reason: 'absent' });
  assert.match(f.cli(), /alarms need diagnosis:.*ci-not-green:v1:1/);
  assert.deepEqual((await f.project(f.head(), true)).packet.tags, ['event', 'cadence']);
  for (const key of ['admitted', 'launchAuthority', 'launchAck', 'clean']) assert.equal(Object.hasOwn(p, key), false);
  const before = f.git(f.records, 'status', '--porcelain'); f.cli('start');
  assert.equal(f.git(f.records, 'status', '--porcelain'), before);
});

test('E01 AE02 AE06 AE16 SOL-001: same-second duplicate changes canonical coverage; later diagnosis does not cure ambiguity', async t => {
  for (const later of [false, true]) await t.test(String(later), async t => {
    const { f, raw, publication } = await pending(t);
    f.diagnose({ time: later ? '2026-11-22T00:00:01Z' : stamp });
    assert.deepEqual(undiagnosedAlarms(f.records, f.head(), 'v1'), []);
    const a = await f.check(); expect(state(a), { diagnosis: 'covered', applicability: 'active' });
    assert.equal(a.items[0].status, 'pending');
    f.ledger([raw, raw]);
    const canonical = firings(parseRows(f.git(f.records, 'show', `HEAD:${trajectoryPath}`)));
    assert.deepEqual(canonical.filter(a => a.key === alarmKey).map(a => a.row), [1, 1]);
    assert.equal(undiagnosedAlarms(f.records, f.head(), 'v1').length, later ? 0 : 2);
    const stale = await f.project(); expect(stale.items[0], { status: 'unknown', reason: 'stale_inventory' });
    assert.equal(state(stale).occurrenceId, state(a).occurrenceId);
    f.manifest.inventory = [{ ...f.alarm(raw, alarmKey, publication, f.head(), 'trajectory', 1), predecessor: a.items[0].version }]; f.publish();
    const b = await f.project(), item = current(b)[0];
    expect(state(b, item), { occurrenceId: null, identityBasis: 'unverified', applicability: 'unknown', diagnosis: 'unknown', successorOccurrenceId: null, reason: 'alarm_identity_ambiguous' });
    assert.equal(item.status, 'unknown');
    f.manifest.dispositions = [f.disposition(item, f.evidence())]; f.publish();
    assert.equal(current(await f.project())[0].status, 'unknown');
  });
});

test('E02 AE06 AE07: duplicate inventory deduplicates, exact accounting and pinned reads remain stable', async t => {
  const f = fixture(t), raw = line(), publication = f.ledger([raw]); f.diagnose();
  const row = f.alarm(raw, alarmKey, publication);
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [row, copy(row)]; f.publish();
  expect((await f.project()).accounting, { uniqueVersions: 1, duplicateOccurrences: 1, inputOccurrences: 2 });
  const p = await account(f), cut = f.head();
  expect(p.accounting, { uniqueVersions: 1, duplicateOccurrences: 3, inputOccurrences: 4 });
  assert.equal(p.items[0].status, 'reconciled'); assert.equal(state(p).diagnosis, 'covered');
  assert.deepEqual(await f.project(cut), p);
  put(f.records, 'design/unrelated.md', '# Other work\n'); f.commit(f.records);
  assert.deepEqual(await f.project(cut), p);
  put(f.records, manifestPath, '{broken'); f.git(f.records, 'add', manifestPath);
  put(f.records, trajectoryPath, 'working-only');
  assert.deepEqual(await f.project(cut), p);
});

test('E03 AE03 AE17: deletion and readdition starts new episode and never carries disposition', async t => {
  const { f, raw } = await pending(t), a = await account(f), original = copy(f.manifest.inventory[0]);
  f.manifest.inventory = [{ ...original, operation: 'delete', source: null, predecessor: a.items[0].version }]; f.publish();
  rmSync(join(f.records, trajectoryPath)); f.commit(f.records);
  const publication = f.ledger([raw]);
  const added = f.alarm(raw, alarmKey, publication);
  assert.notEqual(added.entryId, original.entryId);
  f.manifest.inventory.push(added); f.publish();
  const p = await f.project(), item = current(p).find(i => i.source !== null);
  assert.equal(state(p, item).occurrenceId, added.entryId); assert.equal(item.status, 'pending');
  assert.ok(p.items.some(i => i.version === a.items[0].version));
});

test('E04 AE03 AE07: moving a selected line changes fingerprint, reverting cannot restore identity within episode', async t => {
  const { f, raw, publication } = await pending(t), a = await f.project();
  const unrelated = line({ round: 9, ci: 'success' });
  for (const rows of [[unrelated, raw], [raw]]) {
    f.ledger(rows);
    f.manifest.inventory = [{ ...f.alarm(raw, alarmKey, publication), predecessor: current(await f.project())[0].version }]; f.publish();
    const p = await f.project(); expect(state(p, current(p)[0]), { occurrenceId: null, reason: 'alarm_identity_ambiguous' });
  }
  assert.ok((await f.project()).items.some(i => i.version === a.items[0].version));
});

test('E05 AE03 AE08: two keys on one row are distinct; changed firing supersedes with independent pending work', async t => {
  const f = fixture(t), rows = [1, 2, 3, 4].map(round => line({ round, area: '中文 area', ci: round === 4 ? 'failure' : 'success' }));
  const publication = f.ledger(rows), key = 'area-rounds:v1:中文 area', ciKey = 'ci-not-green:v1:4';
  f.manifest.schema = 'normal-entry-manifest/v2';
  f.manifest.inventory = [f.alarm(rows[3], key, publication), f.alarm(rows[3], ciKey, publication)]; f.publish();
  const a = await f.project(); assert.equal(a.items.length, 2); assert.equal(new Set(a.alarmStates.map(s => s.occurrenceId)).size, 2);
  assert.ok(a.alarmStates.every(s => s.applicability === 'active'));
  rows.push(line({ round: 5, area: '中文 area', ci: 'success' })); const nextPub = f.ledger(rows);
  const successor = f.alarm(rows[4], key, nextPub);
  const old = f.manifest.inventory[0];
  f.manifest.inventory = [{ ...old, operation: 'delete', source: null, predecessor: a.items.find(i => JSON.parse(i.logicalKey)[3] === old.entryId).version }, successor]; f.publish();
  const b = await f.project(), oldItem = b.items.find(i => i.version === a.items.find(i => JSON.parse(i.logicalKey)[3] === old.entryId).version);
  expect(state(b, oldItem), { applicability: 'superseded', successorOccurrenceId: successor.entryId, diagnosis: 'not_applicable' });
  assert.equal(current(b).find(i => i.source !== null && JSON.parse(i.logicalKey)[3] === successor.entryId).status, 'pending');
});

test('E06 AE06 AE09 AE17: stall duplicates preserve episode; conflicting bytes and restore require new occurrence', async t => {
  const f = fixture(t), raw = { type: 'stall', key: stallKey, time: stamp, phase: 'v1', since: stamp, source: 'fixture', hours: 24, threshold: 12, unsettled: true, by: 'tick', onStall: 'report', action: 'report' };
  const publication = f.ledger([raw], stallPath);
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [f.alarm(raw, stallKey, publication, f.head(), 'stall')]; f.publish();
  const original = f.manifest.inventory[0].entryId;
  for (const rows of [[raw, raw], [raw]]) {
    const before = await f.project(); f.ledger(rows, stallPath);
    f.manifest.inventory = [{ ...f.alarm(raw, stallKey, publication, f.head(), 'stall'), predecessor: current(before)[0].version }]; f.publish();
    expect(state(await f.project(), current(await f.project())[0]), { occurrenceId: original, applicability: 'active', diagnosis: 'not_applicable' });
  }
  f.ledger([raw, { ...raw, hours: 25 }], stallPath);
  const old = current(await f.project())[0];
  f.manifest.inventory = [{ ...f.alarm(raw, stallKey, publication, f.head(), 'stall'), predecessor: old.version }]; f.publish();
  hasReason(await f.project(), 'alarm_identity_ambiguous');
  const restored = f.ledger([raw], stallPath);
  const row = f.alarm(raw, stallKey, restored, f.head(), 'stall'); assert.notEqual(row.entryId, original);
  f.manifest.inventory.push(row); f.publish();
  assert.equal(current(await f.project()).find(i => JSON.parse(i.logicalKey)[3] === row.entryId).status, 'pending');
});

test('E07 E08 SOL-002 AE05 AE15: invalid keyed states are total; invalid successor never borrows identity', async t => {
  const { f } = await pending(t), a = await account(f), original = copy(f.manifest.inventory[0]);
  const bad = { ...copy(original), predecessor: a.items[0].version }; bad.source.blobSha256 = '0'.repeat(64);
  f.manifest.inventory = [bad, { kind: 'alarm', entryId: 'bad', clauseId: 'alarm', path: trajectoryPath, operation: 'upsert', source: null, predecessor: null }, null]; f.publish();
  const p = await f.project();
  assert.equal(p.alarmStates.length, alarmItems(p).length);
  for (const item of current(p)) {
    expect(state(p, item), { occurrenceId: null, identityBasis: 'unverified', applicability: 'unknown', diagnosis: 'unknown', successorOccurrenceId: null });
    assert.equal(item.status, 'unknown');
  }
  hasReason(p, 'bad_digest'); hasReason(p, 'bad_pointer');
  assert.equal(state(p, p.items.find(i => i.version === a.items[0].version)).occurrenceId, original.entryId);
});

test('E09 AE04 AE17: explicit source-null tombstone reconciles without current context, unlike invalid chain', async t => {
  for (const remove of [false, true]) await t.test(String(remove), async t => {
    const { f } = await pending(t), a = await f.project(), original = copy(f.manifest.inventory[0]);
    f.manifest.inventory = [{ ...original, operation: 'delete', source: null, predecessor: a.items[0].version }]; f.publish();
    if (remove) { rmSync(join(f.records, trajectoryPath)); f.commit(f.records); }
    let p = await f.project(f.head(), false, null), tomb = current(p)[0];
    expect(tomb, { status: 'pending', reason: 'deletion_review' });
    expect(state(p, tomb), { occurrenceId: original.entryId, identityBasis: 'predecessor', applicability: 'inactive', diagnosis: 'not_applicable', reason: 'alarm_inactive' });
    f.manifest.dispositions = [f.disposition(tomb, f.evidence())]; f.publish();
    p = await f.project(f.head(), false, null); assert.equal(current(p)[0].status, 'reconciled');
    assert.equal(p.items.find(i => i.version === a.items[0].version).status, 'pending');
    if (!remove) assert.equal(undiagnosedAlarms(f.records, f.head(), 'v1').length, 1);
    f.manifest.inventory[0].predecessor = 'f'.repeat(64); f.publish();
    hasReason(await f.project(f.head(), false, null), 'broken_chain');
  });
});

test('E10 E11 AE04 AE05 AE12: missing source and context never synthesize deletion or reconcile current upsert', async t => {
  const { f } = await pending(t), a = await account(f);
  for (const context of [null, { ...f.context(), revision: 'f'.repeat(40) }, { ...f.context(), phase: 'other' }, { ...f.context(), detectorRevision: 'f'.repeat(40) }]) {
    const p = await f.project(f.head(), false, context);
    expect(p.items[0], { status: 'unknown', reason: 'alarm_context_unknown' });
    assert.equal(state(p).occurrenceId, state(a).occurrenceId);
  }
  rmSync(join(f.records, trajectoryPath)); f.commit(f.records);
  const p = await f.project(f.head(), false, null);
  expect(p.items[0], { status: 'unknown', reason: 'source_unavailable' });
  assert.equal(state(p).occurrenceId, state(a).occurrenceId); assert.deepEqual(p.accounting.tombstones, []);
});

async function migration(t) {
  const f = fixture(t); f.manifest.inventory = [f.row()]; f.publish();
  const m1 = await account(f); assert.equal(m1.schema, 'normal-entry-projection/v1'); assert.equal(Object.hasOwn(m1, 'alarmStates'), false);
  const raw = line(), publication = f.ledger([raw]);
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory.push(f.alarm(raw, alarmKey, publication)); f.publish();
  const m2 = await account(f), saved = copy(f.manifest);
  assert.ok(m2.items.every(i => i.status === 'reconciled'));
  f.manifest = { ...copy(saved), schema: 'normal-entry-manifest/v1', inventory: [f.row('rejected')], dispositions: [] }; const m3cut = f.publish();
  const m3 = await f.check('unknown'); assert.deepEqual(versions(m3), versions(m2));
  assert.ok(current(m3).every(i => i.reason === 'unsupported_downgrade'));
  assert.deepEqual(m3.accounting, m2.accounting); assert.equal(m3.schema, 'normal-entry-projection/v2');
  const diagnostic = m3.diagnostics.find(d => d.scope === 'manifest' && d.code === 'unsupported_downgrade');
  expect(diagnostic, { scope: 'manifest', subject: 'inventory', provenance: [{ revision: m3cut, path: manifestPath, selector: '/schema' }] });
  return { f, saved, m1, m2, m3 };
}

test('E12 SOL-003 AE17: M1/M2/M3/M4 rejection and explicit disposition withdrawal', async t => {
  const { f, saved, m2 } = await migration(t);
  f.manifest = { ...saved, dispositions: [] }; f.publish();
  const m4 = await f.check('pending'); assert.deepEqual(versions(m4), versions(m2));
  assert.ok(m4.items.every(i => i.status === 'pending' && i.reason === 'absent'));
  assert.ok(!m4.diagnostics.some(d => d.code === 'unsupported_downgrade'));
  f.manifest = saved; f.publish(); assert.ok((await f.project()).items.every(i => i.status === 'reconciled'));
  f.manifest.inventory = [saved.inventory[0]]; f.publish(); hasReason(await f.project(), 'inventory_omission');
});

test('E13 AE05 AE15 AE17: malformed v2 cannot activate, import, withdraw; valid empty v2 activates', async t => {
  for (const field of ['inventory', 'dispositions']) await t.test(field, async t => {
    const f = fixture(t); f.manifest.inventory = [f.row()]; f.publish();
    const a = await account(f), saved = copy(f.manifest);
    f.manifest = { ...copy(saved), schema: 'normal-entry-manifest/v2', [field]: {} }; f.publish();
    const bad = await f.check('unknown'); assert.equal(bad.schema, 'normal-entry-projection/v1');
    assert.equal(Object.hasOwn(bad, 'alarmStates'), false); assert.deepEqual(versions(bad), versions(a)); hasReason(bad, 'bad_type');
    f.manifest = saved; f.publish(); assert.equal((await f.project()).items[0].status, 'reconciled');
    assert.equal((await f.project()).schema, 'normal-entry-projection/v1');
  });
  const f = fixture(t); f.manifest.schema = 'normal-entry-manifest/v2'; f.publish();
  const empty = await f.project(); assert.equal(empty.schema, 'normal-entry-projection/v2'); assert.deepEqual(empty.alarmStates, []);
});

test('E14 AE10 AE14 AE17: deleting rejected manifest does not clear downgrade; same blob recovery is processed', async t => {
  const { f, saved, m2 } = await migration(t);
  rmSync(join(f.records, manifestPath)); f.commit(f.records);
  const deleted = await f.check('unknown'); assert.equal(deleted.schema, 'normal-entry-projection/v2'); hasReason(deleted, 'unsupported_downgrade');
  assert.deepEqual(versions(deleted), versions(m2));
  f.manifest = copy(saved); f.publish(); const restored = await f.check();
  assert.deepEqual(versions(restored), versions(m2)); assert.ok(restored.items.every(i => i.status === 'reconciled'));
  hasReason(await f.project('f'.repeat(40)), 'missing_cut');
  f.manifest.baseline = f.head(); f.publish(); hasReason(await f.project(), 'baseline_reset');
  f.manifest = copy(saved); f.publish(); hasReason(await f.project(), 'baseline_reset');
});

test('AE08 AE16: wrong phase, report-only and diagnosis before publication cannot cover canonical alarm', async t => {
  for (const variant of ['positive', 'phase', 'body', 'before']) await t.test(variant, async t => {
    const f = fixture(t);
    if (variant === 'before') f.diagnose();
    const raw = line(), publication = f.ledger([raw]);
    if (variant !== 'before') f.diagnose({ phase: variant === 'phase' ? 'other' : 'v1', bodyOnly: variant === 'body' });
    f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [f.alarm(raw, alarmKey, publication)]; f.publish();
    const open = undiagnosedAlarms(f.records, f.head(), 'v1'); assert.equal(open.length, variant === 'positive' ? 0 : 1);
    const p = await f.check(); assert.equal(state(p).diagnosis, variant === 'positive' ? 'covered' : 'required');
    assert.equal(p.items[0].status, 'pending');
    const task = put(f.dir, 'blocked-task.md', 'features: F-0003\nRun the admitted bounded package.\n');
    const run = f.run('call.mjs', [f.config, 'actor', '--round', '2', '--task', task, '--dry-run']);
    if (variant !== 'positive') { assert.equal(run.status, 7); assert.match(run.stdout + run.stderr, /diagnos|alarm/i); }
  });
});

test('AE08: another repository cannot lend source, disposition or diagnosis', async t => {
  const { f: p } = await pending(t), { f: q } = await pending(t); p.diagnose();
  const a = await account(p); q.manifest.dispositions = copy(p.manifest.dispositions);
  q.manifest.inventory.push(copy(p.manifest.inventory[0])); q.publish();
  const b = await q.project(); assert.equal(b.state, 'unknown'); hasReason(b, 'external_repo');
  assert.equal(undiagnosedAlarms(q.records, q.head(), 'v1').length, 1);
  assert.equal((await p.project()).items[0].status, a.items[0].status);
  assert.match(q.cli(), /independent/); assert.match(p.cli(), /independent/);
});

test('AE05 AE15: absent, empty, unsupported detector and malformed ledger are distinct with valid sibling', async t => {
  const f = fixture(t); hasReason(await f.project(), 'missing_manifest');
  f.manifest.schema = 'normal-entry-manifest/v2'; f.publish();
  assert.equal((await f.project()).items.length, 0);
  const raw = line(), publication = f.ledger([raw]);
  const bad = f.alarm(raw, alarmKey, publication); bad.source.selector.detectorRevision = 'f'.repeat(40);
  f.manifest.inventory = [f.row(), bad]; f.publish();
  const unsupported = await f.check('unknown'); hasReason(unsupported, 'unsupported_detector');
  assert.equal(current(unsupported).find(i => JSON.parse(i.logicalKey)[1] === 'answer_clause').status, 'pending');
  const m = fixture(t), sibling = m.row();
  m.manifest.schema = 'normal-entry-manifest/v2'; m.manifest.inventory = [sibling]; m.publish();
  const siblingVersion = current(await m.project())[0].version;
  const malformedCut = m.ledger(['{malformed']);
  const malformedAlarm = m.alarm('{malformed', alarmKey, malformedCut);
  assert.equal(malformedAlarm.source.selector.detectorRevision, detector);
  assert.deepEqual(malformedAlarm.source.entryRange, [0, Buffer.byteLength('{malformed')]);
  assert.deepEqual(malformedAlarm.source.clauseRange, malformedAlarm.source.entryRange);
  assert.equal(malformedAlarm.source.blobSha256, hash('{malformed\n'));
  assert.equal(malformedAlarm.source.clauseSha256, hash('{malformed'));
  m.manifest.inventory = [sibling, malformedAlarm]; m.publish();
  const malformed = await m.project(); assert.equal(malformed.state, 'unknown');
  hasReason(malformed, 'alarm_source_invalid');
  expect(state(malformed), { identityBasis: 'unverified', occurrenceId: null, applicability: 'unknown' });
  const currentSibling = current(malformed).find(i => JSON.parse(i.logicalKey)[1] === 'answer_clause');
  expect(currentSibling, { version: siblingVersion, status: 'pending', reason: 'absent' });
  assert.ok(!malformed.diagnostics.some(d => ['unsupported_detector', 'broken_chain', 'inventory_omission'].includes(d.code)));
});

test('AE10 AE11 AE14: security hold and leave/resume preserve blockers and independent ready work', async t => {
  const { f } = await pending(t);
  put(f.records, 'plans/PL-0002.md', planText('PL-0002', [
    pkg('security-writer', { round: 2, hold: 'security approval', release: 'explicit security authorization' }),
    pkg('writer-dependent', { round: 2, needs: ['security-writer'] }),
    pkg('independent', { round: 2 }),
  ], { supersedes: 'PL-0001' }));
  const raw = line({ opened: 'core:open,core:shelved' }); f.ledger([raw, line({ round: 2, ci: 'success', shelved: 'core:shelved' })]);
  for (const action of ['leave', 'resume']) {
    put(f.records, `decisions/D-${action === 'leave' ? '0040' : '0041'}.md`, `# ${action}\n\nstatus: active\nby: owner\n\n${action} area core; blocker disposition unchanged.\n`); f.commit(f.records);
    const out = f.cli(); assert.match(out, /core:open/); assert.match(out, /core:shelved/);
    assert.match(out, /independent/); assert.match(out, /security/);
    const p = await f.project(); assert.deepEqual(p.blockers, { open: ['core:open (R-0001)'], shelved: ['core:shelved (R-0001)'] });
  }
});

test('AE12 AE13: NO_CHANGE needs exact lineage; approval bytes are not semantic SOUND or launch ACK', async t => {
  for (const mode of ['NO_CHANGE', 'UNKNOWN', 'missing', 'invalid', 'conflicting']) await t.test(mode, async t => {
    const { f } = await pending(t), p = await f.project(), d = f.disposition(p.items[0], f.evidence());
    if (mode === 'UNKNOWN') d.outcome = 'UNKNOWN';
    if (mode === 'invalid') d.consumer.clauseSha256 = '0'.repeat(64);
    f.manifest.dispositions = mode === 'missing' ? [] : [d];
    if (mode === 'conflicting') f.manifest.dispositions.push({ ...copy(d), id: 'conflict', reason: 'Different scoped hold' });
    if (mode !== 'missing') f.publish();
    const out = await f.project();
    expect(out.items[0], { status: mode === 'NO_CHANGE' ? 'reconciled' : 'pending', reason: { NO_CHANGE: 'exact_link', UNKNOWN: 'unknown_outcome', missing: 'absent', invalid: 'invalid_disposition', conflicting: 'conflicting_disposition' }[mode] });
    assert.equal(state(out).diagnosis, 'required');
    assert.equal(Object.hasOwn(out, 'admitted'), false); assert.equal(Object.hasOwn(out, 'launchAck'), false);
    assert.match(f.cli(), /alarms need diagnosis/);
  });
});

test('AE15: private blob read spy rejects metrics wildcard, reviewer records and external source before content read', async t => {
  const { f } = await pending(t);
  const privatePaths = ['metrics/private.jsonl', 'sealed/judge/secret.md', 'raw/session.json', 'rounds/0099-reviewer-diagnosis.md'];
  const oids = [];
  for (const [n, path] of privatePaths.entries()) { put(f.records, path, `PRIVATE-SENTINEL-${n}\n`); }
  f.commit(f.records);
  for (const [n, path] of privatePaths.entries()) {
    oids.push(f.git(f.records, 'rev-parse', `HEAD:${path}`));
    const bad = copy(f.manifest.inventory[0]); bad.entryId = `bad-${n}`; bad.path = path;
    bad.source.path = path; bad.source.revision = f.head(); f.manifest.inventory.push(bad);
  }
  const link = 'metrics/alarms.jsonl'; symlinkSync('/nonexistent/private-target', join(f.records, link)); f.commit(f.records);
  const symlink = copy(f.manifest.inventory[0]); symlink.entryId = 'symlink'; symlink.path = link;
  symlink.source.path = link; symlink.source.revision = f.head(); symlink.source.selector.origin = 'stall'; f.manifest.inventory.push(symlink); f.publish();
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
  try { p = await f.project(f.head(), false, null); }
  finally { Object.assign(childProcess, originals); syncBuiltinESMExports(); }
  assert.ok(calls.length, 'spy sees Git boundary');
  const reads = calls.filter(c => c.args.includes('show') || (c.args.includes('cat-file') && !c.args.some(a => a.startsWith('--batch-check')) && !c.args.includes('-e') && !c.args.includes('-t')));
  assert.ok(!reads.some(c => [...c.args, c.input].some(a => [...oids, ...privatePaths].some(p => a.includes(p)))), JSON.stringify(reads));
  assert.doesNotMatch(JSON.stringify(p), /PRIVATE-SENTINEL|private-target/);
  assert.equal(p.state, 'unknown'); hasReason(p, 'symlink');
});

test('AE15: all four legacy families retain exact versions across v2 activation', async t => {
  const f = fixture(t);
  put(f.records, 'owner/words.jsonl', jsonl({ id: 'W-0000000001', time: stamp, text: 'Fixture intent', source: 'fixture', session: 'fixture', ordinal: 1 }));
  put(f.records, 'reviews/grok-R0001-gap.md', '# Gap\n\nFixture gap\n');
  put(f.records, 'decisions/D-0042.md', '# Trial\n\nFixture trial\n'); f.commit(f.records);
  const word = f.pointer('owner/words.jsonl', 'Fixture intent', f.head(), { type: 'word', id: 'W-0000000001' });
  const rows = [f.row(), ['owner_word', word], ['judge_gap', f.pointer('reviews/grok-R0001-gap.md', 'Fixture gap')], ['trial', f.pointer('decisions/D-0042.md', 'Fixture trial')]];
  f.manifest.inventory = rows.map((r, n) => Array.isArray(r) ? { kind: r[0], entryId: `legacy-${n}`, clauseId: 'clause', path: r[1].path, operation: 'upsert', source: r[1], predecessor: null } : r);
  f.publish(); const before = await account(f);
  assert.equal(before.items.length, 4); assert.ok(before.items.every(i => i.status === 'reconciled'));
  f.manifest.schema = 'normal-entry-manifest/v2'; f.publish();
  const after = await f.check(); assert.deepEqual(versions(after), versions(before));
  assert.ok(after.items.every(i => i.status === 'reconciled')); assert.deepEqual(after.alarmStates, []);
});

test('E03: first-parent merge publication defines P; side branch source is not substituted', async t => {
  const f = fixture(t), raw = line();
  f.git(f.records, 'branch', 'source-side');
  f.git(f.records, 'switch', '-q', 'source-side'); const side = f.ledger([raw]);
  f.git(f.records, 'switch', '-q', 'main');
  put(f.records, 'design/main.md', '# Main\n'); f.commit(f.records);
  f.git(f.records, 'merge', '--no-ff', '-qm', 'Publish source through merge', 'source-side'); const publication = f.head();
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [f.alarm(raw, alarmKey, publication)]; f.publish();
  const p = await f.project();
  assert.equal(state(p).occurrenceId, occurrenceId(f.identity, 'v1', 'trajectory', alarmKey, publication, hash(JSON.stringify(raw))));
  assert.notEqual(state(p).occurrenceId, occurrenceId(f.identity, 'v1', 'trajectory', alarmKey, side, hash(JSON.stringify(raw))));
});

test('E11: missing context does not veto noncurrent source-verified exact accounting', async t => {
  const { f, raw, publication } = await pending(t), a = await account(f);
  put(f.records, 'design/rebind.md', '# Rebind\n'); f.commit(f.records);
  f.manifest.inventory = [{ ...f.alarm(raw, alarmKey, publication), predecessor: a.items[0].version }]; f.publish();
  const p = await f.project(f.head(), false, null);
  const historical = p.items.find(i => i.version === a.items[0].version);
  assert.equal(historical.status, 'reconciled'); assert.equal(state(p, historical).reason, 'alarm_context_unknown');
  assert.equal(current(p)[0].status, 'unknown');
});

test('AE09: independently recorded child running, failed and unknown evidence cannot erase elapsed-record stall', async t => {
  const f = fixture(t), raw = { type: 'stall', key: stallKey, time: stamp, phase: 'v1', since: stamp, source: 'metrics/trajectory.jsonl', hours: 24, threshold: 12, unsettled: true, by: 'tick', onStall: 'report', action: 'report' };
  const publication = f.ledger([raw], stallPath);
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [f.alarm(raw, stallKey, publication, f.head(), 'stall')]; f.publish();
  const a = await f.project();
  for (const childState of ['running-progress', 'terminal-failed', 'unknown']) {
    put(f.records, 'evidence/normal-entry/public-child.json', json({ synthetic: true, state: childState, observedAt: stamp, provenance: 'fixture-only' })); f.commit(f.records);
    const p = await f.project(); assert.deepEqual(versions(p), versions(a));
    expect(state(p), { occurrenceId: state(a).occurrenceId, applicability: 'active', diagnosis: 'not_applicable' });
    assert.equal(p.items[0].status, 'pending'); assert.match(f.cli(), /independent/);
  }
});

test('E04: upstream evidence change and revert within selected-line episode remain ambiguous', async t => {
  const f = fixture(t), rows = [1, 2, 3].map(round => line({ round, area: 'core', ci: 'success' }));
  const publication = f.ledger(rows), key = 'area-rounds:v1:core';
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [f.alarm(rows[2], key, publication)]; f.publish();
  assert.equal(state(await f.project()).applicability, 'active');
  for (const first of [line({ round: 9, area: 'core', ci: 'success' }), rows[0]]) {
    const previous = current(await f.project())[0]; f.ledger([first, rows[1], rows[2]]);
    f.manifest.inventory = [{ ...f.alarm(rows[2], key, publication), predecessor: previous.version }]; f.publish();
    const p = await f.project(); assert.equal(current(p)[0].status, 'unknown');
    assert.equal(state(p, current(p)[0]).occurrenceId, null); hasReason(p, 'alarm_identity_ambiguous');
  }
});

test('E05: cross-phase exact-key collision is ambiguous before configured-phase filtering', async t => {
  const f = fixture(t), rows = [1, 2, 3].map(round => line({ round, area: 'other:core', ci: 'success' }));
  rows.push(...[1, 2, 3].map(round => line({ round, phase: 'v1:other', area: 'core', ci: 'success' })));
  const publication = f.ledger(rows), key = 'area-rounds:v1:other:core';
  assert.equal(firings(parseRows(rows.map(r => JSON.stringify(r)).join('\n'))).filter(a => a.key === key).length, 2);
  f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.inventory = [f.alarm(rows[2], key, publication)]; f.publish();
  const p = await f.project(); expect(state(p), { occurrenceId: null, applicability: 'unknown', reason: 'alarm_identity_ambiguous' });
});

test('E13: no prior inventory malformed v2 stays legacy; valid envelope with invalid member activates', async t => {
  const f = fixture(t); f.manifest.schema = 'normal-entry-manifest/v2'; f.manifest.dispositions = {}; f.publish();
  const bad = await f.project(); assert.equal(bad.schema, 'normal-entry-projection/v1'); assert.deepEqual(bad.items, []);
  assert.equal(Object.hasOwn(bad, 'alarmStates'), false); hasReason(bad, 'bad_type');
  f.manifest.dispositions = [];
  f.manifest.inventory = [{ kind: 'alarm', entryId: 'bad', clauseId: 'alarm', path: trajectoryPath, operation: 'upsert', source: null, predecessor: null }]; f.publish();
  const active = await f.project(); assert.equal(active.schema, 'normal-entry-projection/v2');
  expect(state(active), { occurrenceId: null, identityBasis: 'unverified', applicability: 'unknown' });
});


test('AE1-CODE-SOL-001: BOM repair starts a new canonical publication episode', async t => {
  for (const origin of ['trajectory', 'stall']) await t.test(origin, async t => {
    const f = fixture(t);
    const path = origin === 'trajectory' ? trajectoryPath : stallPath;
    const key = origin === 'trajectory' ? alarmKey : stallKey;
    const raw = origin === 'trajectory' ? line() : { type: 'stall', key: stallKey, time: stamp, phase: 'v1', since: stamp, source: 'fixture', hours: 24, threshold: 12, unsettled: true, by: 'tick', onStall: 'report', action: 'report' };
    const text = JSON.stringify(raw);
    const invalidPublication = f.ledger(['\uFEFF' + text], path);
    const repairedPublication = f.ledger([text], path);
    f.manifest.schema = 'normal-entry-manifest/v2';
    const valid = f.alarm(text, key, repairedPublication, f.head(), origin);
    f.manifest.inventory = [f.row(), valid]; f.publish();
    const verified = await f.project();
    expect(state(verified), { identityBasis: 'source', occurrenceId: occurrenceId(f.identity, 'v1', origin, key, repairedPublication, hash(text)) });
    assert.equal(alarmItems(verified).at(-1).status, 'pending');
    const wrong = copy(valid);
    wrong.entryId = occurrenceId(f.identity, 'v1', origin, key, invalidPublication, hash(text));
    f.manifest.inventory.push(wrong); f.publish();
    hasReason(await f.project(), 'bad_pointer');
  });
});

test('AE1-CODE-SOL-001: BOM at current source is rejected by both canonical ledgers', async t => {
  for (const origin of ['trajectory', 'stall']) await t.test(origin, async t => {
    const f = fixture(t);
    const path = origin === 'trajectory' ? trajectoryPath : stallPath;
    const key = origin === 'trajectory' ? alarmKey : stallKey;
    const raw = origin === 'trajectory' ? line() : { type: 'stall', key: stallKey, time: stamp, phase: 'v1', since: stamp, source: 'fixture', hours: 24, threshold: 12, unsettled: true, by: 'tick', onStall: 'report', action: 'report' };
    const text = '\uFEFF' + JSON.stringify(raw), publication = f.ledger([text], path);
    f.manifest.schema = 'normal-entry-manifest/v2';
    f.manifest.inventory = [f.row(), f.alarm(text, key, publication, f.head(), origin)]; f.publish();
    const result = await f.project();
    hasReason(result, 'alarm_source_invalid');
    expect(state(result), { identityBasis: 'unverified', occurrenceId: null, applicability: 'unknown' });
    assert.equal(result.items.find(i => JSON.parse(i.logicalKey)[1] === 'answer_clause').status, 'pending');
  });
});

test('AE1-CODE-SOL-002 abstract injected-context control: malformed current context cannot erase a valid source proof or lend applicability', async t => {
  const { f } = await pending(t);
  f.manifest.inventory.push(f.row()); f.publish();
  const before = await f.project(), proof = state(before).occurrenceId;
  assert.equal(state(before).identityBasis, 'source');
  const context = f.context(); context.trajectory.validation = 'unknown';
  const result = await f.project(f.head(), false, context);
  expect(state(result), { identityBasis: 'source', occurrenceId: proof, applicability: 'unknown', diagnosis: 'unknown', reason: 'alarm_context_unknown' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.items.find(i => JSON.parse(i.logicalKey)[1] === 'answer_clause').status, 'pending');
});

test('AE1-CODE-SOL-002 actual committed malformed stall ledger: stale current precedence and retained historical proof reach next/start', async t => {
  const { f } = await pending(t);
  const trajectory = copy(f.manifest.inventory[0]), sibling = f.row();
  const raw = { type: 'stall', key: stallKey, time: stamp, phase: 'v1', since: stamp, source: 'fixture', hours: 24, threshold: 12, unsettled: true, by: 'tick', onStall: 'report', action: 'report' };
  const publication = f.ledger([raw], stallPath);
  const original = f.alarm(raw, stallKey, publication, f.head(), 'stall');
  f.manifest.inventory = [trajectory, sibling, original]; f.publish();
  const accounted = await account(f);
  const old = current(accounted).find(i => i.source?.path === stallPath);
  const proof = state(accounted, old).occurrenceId;
  expect(old, { status: 'reconciled', reason: 'exact_link' });
  expect(state(accounted, old), { identityBasis: 'source', occurrenceId: original.entryId });
  f.manifest.inventory[2] = { ...f.alarm(raw, stallKey, publication, f.head(), 'stall'), predecessor: old.version };
  f.publish();
  const rebound = current(await f.project()).find(i => i.source?.path === stallPath);
  assert.notEqual(rebound.version, old.version);
  const refs = f.evidence(); f.manifest.dispositions.push(f.disposition(rebound, refs)); f.publish();
  const before = await f.project();
  assert.equal(before.items.find(i => i.version === rebound.version).status, 'reconciled');
  const malformedCut = f.ledger(['{malformed'], stallPath);
  assert.equal(f.git(f.records, 'show', `${malformedCut}:${stallPath}`), '{malformed');
  const result = await f.check('unknown');
  const historical = result.items.find(i => i.version === old.version);
  const stale = result.items.find(i => i.version === rebound.version);
  expect(historical, { current: false, status: 'reconciled', reason: 'exact_link' });
  expect(state(result, historical), { identityBasis: 'source', occurrenceId: proof, applicability: 'unknown', diagnosis: 'unknown', reason: 'alarm_context_unknown' });
  expect(stale, { current: true, status: 'unknown', reason: 'stale_inventory' });
  expect(state(result, stale), { identityBasis: 'source', occurrenceId: proof, applicability: 'unknown', diagnosis: 'unknown', reason: 'stale_inventory' });
  const answer = current(result).find(i => JSON.parse(i.logicalKey)[1] === 'answer_clause');
  expect(answer, { version: current(accounted).find(i => JSON.parse(i.logicalKey)[1] === 'answer_clause').version, status: 'reconciled' });
  const active = current(result).find(i => i.source?.path === trajectoryPath);
  expect(active, { status: 'reconciled' });
  expect(state(result, active), { applicability: 'active', diagnosis: 'required', identityBasis: 'source' });
  for (const entry of ['next', 'start']) {
    const output = f.cli(entry), normal = section(output);
    assert.ok(normal.includes(`${historical.version} reconciled/exact_link`));
    assert.ok(normal.includes(`alarm ${historical.version}: unknown/unknown (alarm_context_unknown); occurrence ${proof}; identity source`));
    assert.ok(normal.includes(`${stale.version} unknown/stale_inventory`));
    assert.ok(normal.includes(`alarm ${stale.version}: unknown/unknown (stale_inventory); occurrence ${proof}; identity source`));
    assert.ok(normal.includes(`${answer.version} reconciled/exact_link`));
    assert.match(output, /independent/);
    assert.match(output, /alarms need diagnosis:.*ci-not-green:v1:1/);
  }
  const task = put(f.dir, 'malformed-ledger-task.md', 'features: F-0003\nRun the admitted bounded package.\n');
  const blocked = f.run('call.mjs', [f.config, 'actor', '--round', '2', '--task', task, '--dry-run']);
  assert.equal(blocked.status, 7);
  assert.match(blocked.stdout + blocked.stderr, /diagnos|alarm/i);
});
