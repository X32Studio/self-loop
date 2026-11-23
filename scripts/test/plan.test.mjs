// P-0006, D-0018, design/dispatch.md#ready-state
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { globOverlap } from '../lib/plan-globs.mjs';
import { admitAcrossPlans, parsePlan, RELEASE_IN_WORDS, validatePlan, readyPlan } from '../lib/plan.mjs';
import { executionInterval, measurePlan, renderMeasures } from '../lib/plan-measures.mjs';
import { git, roomyStore, scripts, setup, temp } from './helpers.mjs';

const pkg = (id, changes = {}) => ({ id, authority: ['D-0001'], goal: `Deliver ${id}`, files: [],
  interface: 'fixed contract', needs: [], role: 'actor', acceptance: 'accept the contract',
  handoff: `R-0001-actor-${id}`, ...changes });
const plan = packages => ({ id: 'PL-0001', scope: 'v1/round-1', phase: 'v1', packages });
const state = (files = {}) => {
  const contents = { 'decisions/D-0001.md': '# D-0001\n', ...files };
  return { revision: 'a'.repeat(40), files: new Set(Object.keys(contents)), read: path => contents[path] ?? '',
    bytes: path => contents[path] ?? null };
};

test('flow: planner separates future file patterns; loss: wrong-result', () => {
  for (const [a, b, overlap] of [
    ['src/**/plan*.mjs', 'src/planner.mjs', true],
    ['src/**/plan*.mjs', 'src/new/planning-*.mjs', true],
    ['src/**/plan*.mjs', 'src/**/cadence*.mjs', false],
    ['src/*/a.js', 'src/a.js', false],
    ['src/{actor,critic}/[a-c]?.js', 'src/actor/b1.js', true],
    ['src/{actor,critic}/[a-c]?.js', 'src/actor/z1.js', false],
    ['src/[!a-c].js', 'src/b.js', false],
    ['src/[!a-c].js', 'src/z.js', true],
    ['docs/', 'docs/**/readme.md', true],
    ['src/路径?.js', 'src/路径甲.js', true],
  ]) {
    assert.equal(globOverlap(a, b), overlap, `${a} / ${b}`);
    assert.equal(globOverlap(b, a), overlap, `${b} / ${a}`);
  }
});

test('flow: planner submits a Markdown read-only task and JSON plan; loss: false-verdict', () => {
  const md = '# PL-0001 Plan\nscope: v1/round-1\nphase: v1\n## a\nauthority: D-0001\ngoal: Deliver a\nfiles: \ninterface: fixed contract\nneeds: \nrole: actor\nacceptance: accept the contract\nhandoff: R-0001-actor-a\n';
  assert.deepEqual(validatePlan(parsePlan(md), state()), []);
  assert.deepEqual(validatePlan(parsePlan(JSON.stringify(plan([pkg('a')]))), state()), []);
});

test('flow: planner validates an authority and a dependency chain; loss: false-verdict', () => {
  assert.deepEqual(validatePlan(plan([pkg('a'), pkg('b', { needs: ['a', 'D-0001'] })]), state()), []);
  assert.match(validatePlan(plan([pkg('a', { authority: [] })]), state()).join(), /authority/);
  assert.match(validatePlan(plan([pkg('a', { needs: ['D-0099'] })]), state()).join(), /D-0099/);
  assert.match(validatePlan(plan([pkg('a', { needs: ['b'] }), pkg('b', { needs: ['a'] })]), state()).join(), /cycle/);
});

test('flow: planner fixes future ownership collisions while keeping read-only packages; loss: wrong-result', () => {
  const a = pkg('a', { files: ['scripts/**/plan*.mjs'] });
  assert.deepEqual(validatePlan(plan([a, pkg('b')]), state()), []);
  assert.match(validatePlan(plan([a, pkg('b', { files: ['scripts/new/planning.mjs'] })]), state()).join(), /overlap/);
});

test('flow: planner revises a contract without replaying a prior completion; loss: false-verdict', () => {
  const old = plan([pkg('a')]);
  const records = state({ 'plans/PL-0001.md': JSON.stringify(old) });
  const changed = { ...old, id: 'PL-0002', supersedes: old.id, packages: [pkg('a', { interface: 'new contract' })] };
  assert.match(validatePlan(changed, records).join(), /new handoff/);
  changed.packages[0].handoff = 'R-0001-actor-aa';
  assert.deepEqual(validatePlan(changed, records), []);
});

test('flow: records retain a late handoff and actual execution evidence; loss: wrong-result', () => {
  const log = gzipSync([
    { timestamp: '2026-11-22T00:00:13Z', type: 'user', message: { content: 'task' } },
    { timestamp: '2026-11-22T00:00:43Z', type: 'result', subtype: 'success' },
  ].map(r => JSON.stringify(r)).join('\n'));
  const h = { time: '2026-11-22T00:01:36Z', files: ['evidence/0001/actor-1.log.gz'], agent: { seconds: 30 } };
  const m = executionInterval(state({ [h.files[0]]: log }), h);
  assert.equal(m.seconds, 30);
  assert.equal(new Date(m.start).toISOString(), '2026-11-22T00:00:13.000Z');
  const missing = executionInterval(state(), h);
  assert.equal(missing.start, null);
  assert.equal(missing.seconds, 30);
  assert.ok(missing.unknowns.length);
});

test('flow: a replaced writer blocks only its successor while independent work proceeds; loss: wrong-result', () => {
  const old = plan([pkg('a', { files: ['scripts/plan.mjs'] })]);
  const current = { ...old, id: 'PL-0002', supersedes: old.id, packages: [pkg('a', { handoff: 'R-0001-actor-aa', files: old.packages[0].files }), pkg('b')] };
  const context = { cfg: { agents: { actor: { runner: 't3' } }, workDir: '/', configFile: '/loop.json' }, handoffs: [], batches: [],
    plans: [old, current], prepared: [{ id: old.packages[0].handoff, role: 'actor', phase: 'v1', liveWorkspace: true, ws: '/work/a' }] };
  current.packages.forEach(p => { p.task = import.meta.filename; });
  const result = readyPlan(state(), current, { context, host: { admits: true, over: [] } });
  assert.equal(result.packages[0].status, 'waiting');
  assert.equal(result.packages[1].status, 'ready');
  assert.match(result.packages[0].holds[0].release, /record or reconcile/);
  assert.match(result.packages[1].command, /--prepare/);
});

test('flow: a plan revision reorders declared sets without invalidating completed work; loss: false-verdict', () => {
  const old = plan([pkg('a', { files: ['a.js', 'b.js'], needs: ['D-0001'] })]);
  const next = { ...old, id: 'PL-0002', supersedes: old.id, packages: [pkg('a', { files: ['b.js', 'a.js'], needs: ['D-0001'], settings: {} })] };
  assert.deepEqual(validatePlan(next, state({ 'plans/PL-0001.md': JSON.stringify(old) })), []);
});

test('flow: the lead runs a ready package whose role runs on a CLI runner; loss: stuck, the printed command is refused by call.mjs, which takes --prepare only for a t3 runner', () => {
  const current = plan([pkg('a'), pkg('b', { role: 'critic', handoff: 'R-0001-critic-b' })]);
  current.packages.forEach(p => { p.task = import.meta.filename; });
  const context = { cfg: { agents: { actor: { runner: 't3' }, critic: { runner: 'claude' } }, workDir: '/', configFile: '/loop.json' },
    handoffs: [], batches: [], plans: [current], prepared: [] };
  const [actor, critic] = readyPlan(state(), current, { context, host: { admits: true, over: [] } }).packages;
  assert.deepEqual([actor.status, critic.status], ['ready', 'ready']);
  assert.match(actor.command, / --prepare$/);
  assert.match(critic.command, /call\.mjs.* critic --round 1 --step critic-b --task \S+$/);
  assert.doesNotMatch(critic.command, /--prepare/);
});

test('flow: the lead runs loop.mjs next after committing a plan; loss: stuck, settled independent packages idle because the ready set is never queried (I-0002)', async () => {
  const s = await setup();
  const put = (root, path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const section = (id, role, handoff, files, needs = '') => [`## ${id}`, 'authority: D-0001', `goal: Deliver ${id}`, `files: ${files}`,
    'interface: the fixed contract', `needs: ${needs}`, `role: ${role}`, 'acceptance: its cases pass', `handoff: ${handoff}`, ''];
  put(s.records, 'loop.json', JSON.stringify(s.cfg));
  put(s.records, 'decisions/D-0001.md', '# D-0001 Build the planned work\n');
  put(s.records, 'plans/PL-0001.md', ['# PL-0001 Round two', 'scope: S5/round-2', 'phase: S5', '',
    ...section('build', 'actor', 'R-0002-actor-a', 'src/'), ...section('cases', 'critic', 'R-0002-critic-b', 'test/'),
    ...section('follow', 'actor', 'R-0002-actor-c', 'docs/notes.md', 'build')].join('\n'));
  for (const id of ['R-0002-actor-a', 'R-0002-critic-b', 'R-0002-actor-c']) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  git(s.records, 'add', '-A'); git(s.records, 'commit', '-qm', 'plan');
  const config = join(s.records, 'loop.json');
  const run = () => spawnSync(process.execPath, [join(scripts, 'loop.mjs'), 'next', '--config', config], { encoding: 'utf8',
    env: { ...process.env, SELF_LOOP_LOAD_DIR: temp('self-loop-load-'), SELF_LOOP_OWNER_STORE: roomyStore() } });
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^- plan PL-0001 \(S5\/round-2\): 2 ready, 1 waiting, 0 running, 0 done \[plans\//m);
  assert.match(out.stdout, /^ {4}node \S+call\.mjs \S+loop\.json actor --round 2 --step actor-a --task \S+R-0002-actor-a\.md$/m);
  assert.match(out.stdout, /^ {4}node \S+call\.mjs \S+loop\.json critic --round 2 --step critic-b --task \S+R-0002-critic-b\.md$/m);
  assert.match(out.stdout, /^ {2}follow \(R-0002-actor-c\) waits: package build; release: record successful handoff R-0002-actor-a$/m);
  assert.match(out.stdout, /^ {2}node \S+plan\.mjs ready --records \S+ --plan PL-0001$/m);
  assert.doesNotMatch(out.stdout, /plans\/PL-0001\.md \(undeclared\)/, 'RECORDS.md declares the Plan kind');
  put(s.records, 'plans/PL-0002.md', ['# PL-0002 Round two, revised', 'scope: S5/round-2', 'phase: S5', 'supersedes: PL-0001', '',
    ...section('cases', 'critic', 'R-0002-critic-b', 'test/')].join('\n'));
  git(s.records, 'add', '-A'); git(s.records, 'commit', '-qm', 'revise');
  const revised = run().stdout;
  assert.doesNotMatch(revised, /- plan PL-0001/);
  assert.match(revised, /^- plan PL-0002 \(S5\/round-2\): 1 ready, 0 waiting, 0 running, 0 done/m);
});

test('flow: the lead cites the committed plan in a role task; loss: wrong-result, the role cannot read the package it is asked to deliver', async () => {
  const plan = '# PL-0001 Round two\nscope: S5/round-2\nphase: S5\n\n## build\nauthority: D-0001\ngoal: Deliver build\nfiles: src/\ninterface: the fixed contract\nneeds: \nrole: actor\nacceptance: its cases pass\nhandoff: R-0002-actor-a\n';
  const s = await setup({ reviewer: [{ report: 'Frame report.' }] }, { recordFiles: { 'decisions/D-0001.md': '# D-0001 Build\n', 'plans/PL-0001.md': plan } });
  const r = s.run('reviewer', { task: 'Mode: FRAME. Read PL-0001.\nfeatures: none\n' });
  assert.equal(r.code, 0, r.message);
  assert.ok(existsSync(join(r.ws, 'records', 'plans', 'PL-0001.md')));
});

test('flow: the lead runs a ready judge package after two parallel actors recorded diverged heads; loss: false-verdict, the judge rules on one actor\'s commit instead of the integration SHA', () => {
  const judge = pkg('j', { role: 'judge', handoff: 'R-0001-judge' });
  const current = plan([judge]);
  current.packages.forEach(p => { p.task = import.meta.filename; });
  const context = { cfg: { agents: { judge: { runner: 't3' } }, workDir: '/', configFile: '/loop.json' }, handoffs: [], batches: [], plans: [current], prepared: [] };
  const host = { admits: true, over: [] };
  const sha = 'c'.repeat(40);
  const [merged] = readyPlan(state(), current, { context, host, base: sha }).packages;
  assert.equal(merged.status, 'ready');
  assert.match(merged.command, new RegExp(`call\\.mjs \\S+ judge --round 1 --step judge --base ${sha} --task \\S+ --prepare$`));
  const [diverged] = readyPlan(state(), current, { context, host, base: null }).packages;
  assert.equal(diverged.status, 'waiting');
  assert.equal(diverged.command, undefined);
  assert.match(diverged.holds[0].release, /merge the diverged hand-off heads/);
});

test('A3 holds: a release of record IDs, capacity or a time is computed, any other release stands as written, a hold without a release is no hold, and a live CLI lease is a start (flow: the lead records why packages wait and reconciles; loss: stuck, a released or empty hold keeps a package idle unseen)', () => {
  const at = Date.parse('2026-11-22T12:00:00Z');
  const packages = [
    pkg('ruled', { hold: 'waits for the ruling', release: 'D-0001' }),
    pkg('ruling', { hold: 'waits for the ruling', release: 'D-0099' }),
    pkg('words', { hold: 'the owner asked to wait', release: 'the owner says go' }),
    pkg('mixed', { hold: 'the ruling and the owner', release: 'D-0001, the owner says go' }),
    pkg('empty', { hold: 'waiting for the frame judge', release: '' }),
    pkg('room', { release: 'capacity' }),
    pkg('later', { release: '2026-11-23T00:00:00Z' }),
    pkg('past', { release: '2026-11-21T00:00:00Z, D-0001' }),
    pkg('cli', { role: 'critic', handoff: 'R-0001-critic-cli' }),
    pkg('untasked', { task: '/nowhere/R-0001-actor-untasked.md' }),
  ];
  const current = plan(packages);
  packages.filter(p => p.id !== 'untasked').forEach(p => { p.task = import.meta.filename; });
  const context = { cfg: { agents: { actor: { runner: 't3' }, critic: { runner: 'claude' } }, workDir: '/', configFile: '/loop.json', records: '/records' },
    handoffs: [], batches: [], plans: [current], prepared: [] };
  const lease = { kind: 'call', id: 'R-0001-critic-cli', records: '/records', pid: 7 };
  const run = host => Object.fromEntries(readyPlan(state(), current, { context, host: { ...host, calls: [lease] }, now: at }).packages.map(r => [r.id, r]));
  const rows = run({ admits: true, over: [] });
  const look = id => [rows[id].status, rows[id].idle, rows[id].holds.map(h => h.kind).join()];
  assert.deepEqual(look('ruled'), ['ready', true, '']);
  assert.deepEqual(rows.ruled.released, { hold: 'waits for the ruling', release: 'D-0001' });
  assert.deepEqual(look('ruling'), ['waiting', false, 'hold']);
  assert.deepEqual(look('words'), ['waiting', false, 'hold']);
  assert.equal(rows.words.holds[0].release, 'the owner says go');
  assert.deepEqual(rows.words.unchecked, { hold: 'the owner asked to wait', release: 'the owner says go', review: RELEASE_IN_WORDS });
  assert.equal(rows.words.holds[0].computed, false);
  assert.deepEqual(look('mixed'), ['waiting', false, 'hold'], 'one part in words makes the whole release unchecked');
  assert.equal(rows.mixed.unchecked.release, 'D-0001, the owner says go');
  for (const id of ['ruled', 'ruling', 'empty', 'room', 'later', 'past', 'cli', 'untasked']) assert.equal(rows[id].unchecked, undefined, id);
  assert.deepEqual(readyPlan(state(), current, { context, host: { admits: true, over: [], calls: [lease] }, now: at }).unchecked, ['words', 'mixed']);
  assert.deepEqual(look('empty'), ['ready', true, '']);
  assert.match(rows.empty.unheld.why, /names no release condition/);
  assert.deepEqual(look('room'), ['ready', true, '']);
  assert.deepEqual(look('later'), ['waiting', false, 'hold']);
  assert.deepEqual(look('past'), ['ready', true, '']);
  assert.deepEqual(look('cli'), ['running', false, '']);
  assert.match(rows.cli.evidence[0].state, /live call lease/);
  assert.deepEqual(look('untasked'), ['waiting', true, 'task']);
  assert.equal(rows.untasked.command, undefined);
  const full = run({ admits: false, over: ['load over the bound'] });
  assert.deepEqual([full.room.status, full.room.holds.map(h => h.kind).sort().join()], ['waiting', 'capacity,hold']);
  assert.equal(full.cli.status, 'running');
});

test('A3 plan lists: a bracket glob is a file pattern, a JSON array is a list (flow: the lead gives the documents package the files [A-Z]*.md; loss: stuck, the plan cannot be validated at all)', () => {
  const md = '# PL-0001 Plan\nscope: v1/round-1\nphase: v1\n## docs\nauthority: D-0001\ngoal: Deliver docs\nfiles: [A-Z]*.md, docs/\ninterface: fixed contract\nneeds: \nrole: actor\nacceptance: accept the contract\nhandoff: R-0001-actor-docs\n## code\nauthority: D-0001\ngoal: Deliver code\nfiles: ["scripts/**"]\ninterface: fixed contract\nneeds: \nrole: actor\nacceptance: accept the contract\nhandoff: R-0001-actor-code\n';
  const parsed = parsePlan(md);
  assert.deepEqual(parsed.packages.map(p => p.files), [['[A-Z]*.md', 'docs/'], ['scripts/**']]);
  assert.deepEqual(validatePlan(parsed, state()), []);
  parsed.packages[1].files = ['SKILL.md'];
  assert.match(validatePlan(parsed, state()).join(), /overlap/);
});

test('R8-2 a release in words stays a hold and is listed for review on every next reading; a computed release holds silently (flow: the lead holds one package until the owner says go and another until a ruling lands; loss: stuck, a wait no code can check silences the idle alarm for good)', async () => {
  const s = await setup();
  const put = (root, path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const section = (id, handoff, files, extra = []) => [`## ${id}`, 'authority: D-0001', `goal: Deliver ${id}`, `files: ${files}`,
    'interface: the fixed contract', 'needs: ', 'role: actor', 'acceptance: its cases pass', `handoff: ${handoff}`, ...extra, ''];
  put(s.records, 'loop.json', JSON.stringify(s.cfg));
  put(s.records, 'decisions/D-0001.md', '# D-0001 Build the planned work\n');
  put(s.records, 'plans/PL-0001.md', ['# PL-0001 Round two', 'scope: S5/round-2', 'phase: S5', '',
    ...section('worded', 'R-0002-actor-a', 'src/a/', ['hold: the owner asked to wait', 'release: the owner says go']),
    ...section('ruled', 'R-0002-actor-b', 'src/b/', ['hold: waits for the ruling', 'release: D-0099']),
    ...section('free', 'R-0002-actor-c', 'src/c/')].join('\n'));
  for (const id of ['R-0002-actor-a', 'R-0002-actor-b', 'R-0002-actor-c']) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  git(s.records, 'add', '-A'); git(s.records, 'commit', '-qm', 'plan');
  const env = { ...process.env, SELF_LOOP_LOAD_DIR: temp('self-loop-load-'), SELF_LOOP_OWNER_STORE: roomyStore() };
  const next = spawnSync(process.execPath, [join(scripts, 'loop.mjs'), 'next', '--config', join(s.records, 'loop.json')], { encoding: 'utf8', env });
  assert.equal(next.status, 0, next.stderr);
  const items = next.stdout.split('\n- ').slice(1).map(item => item.split('\n'));
  const worded = items.find(lines => /release in words/.test(lines[0]));
  assert.ok(worded, next.stdout);
  assert.match(worded[0], /^1 release in words that no code can check, awaiting review \(A3, screening\): worded \(PL-0001\) \[/);
  assert.doesNotMatch(worded[0], /\b(start|hold|idle|unstarted|dispatch)/i, 'the title keeps the idle item\'s pattern for idle packages only');
  assert.match(worded[1], /worded \(R-0002-actor-a, PL-0001\) waits "the owner asked to wait" until "the owner says go": release in words: cannot be checked; name a record ID/);
  const idle = items.find(lines => /no start and no recorded hold/.test(lines[0]));
  assert.match(idle[0], /: free \(PL-0001\) \[/);
  assert.doesNotMatch(idle.join('\n'), /or the condition in words/);
  assert.match(next.stdout, /worded \(R-0002-actor-a\) waits: hold the owner asked to wait; release: the owner says go \(in words, not checked\)/);
  assert.match(next.stdout, /ruled \(R-0002-actor-b\) waits: hold waits for the ruling; release: D-0099$/m);
  assert.match(next.stdout, /^ {2}PL-0001 \(S5\/round-2\): critical path unknown · idle dispatchable unknown · owner waiting n\/a \(the plan names no owner batch\) \(plan\.mjs measure\)$/m);
  assert.doesNotMatch(next.stdout, /owner waiting 0 s \(plan/);
  const ready = spawnSync(process.execPath, [join(scripts, 'plan.mjs'), 'ready', '--records', s.records, '--plan', 'PL-0001', '--json'], { encoding: 'utf8', env, cwd: s.records });
  assert.equal(ready.status, 0, ready.stderr);
  assert.deepEqual(JSON.parse(ready.stdout).unchecked, ['worded']);
});

test('R8-Grok-1 one writer across current plans: a ready package whose files overlap an earlier plan\'s ready or running package waits, held by it, and is offered no command (flow: the lead keeps a round plan and a documents plan whose packages both write docs/; loss: wrong-result, two writers of one file started from one reading)', () => {
  const round = { id: 'PL-0001', scope: 'v1/round-1', phase: 'v1', packages: [pkg('code', { files: ['scripts/**'] }), pkg('notes', { files: ['docs/notes.md'] })] };
  const docs = { id: 'PL-0002', scope: 'v1/docs', phase: 'v1', packages: [pkg('guide', { files: ['docs/'], handoff: 'R-0001-actor-guide' }), pkg('free', { files: ['assets/'], handoff: 'R-0001-actor-free' })] };
  const later = { id: 'PL-0003', scope: 'v1/tests', phase: 'v1', packages: [pkg('tests', { files: ['scripts/test/**'], handoff: 'R-0001-actor-tests' })] };
  for (const p of [...round.packages, ...docs.packages, ...later.packages]) p.task = import.meta.filename;
  const cfg = { agents: { actor: { runner: 't3' } }, workDir: '/', configFile: '/loop.json', records: '/records' };
  const reconcile = (calls = []) => {
    const plans = [later, docs, round];
    const entries = plans.map(plan => ({ plan, result: readyPlan(state(), plan, { context: { cfg, handoffs: [], batches: [], plans, prepared: [] }, host: { admits: true, over: [], calls } }) }));
    admitAcrossPlans(entries);
    return Object.fromEntries(entries.flatMap(e => e.result.packages.map(row => [row.id, row])));
  };
  const rows = reconcile();
  assert.deepEqual(Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.status])),
    { tests: 'waiting', guide: 'waiting', free: 'ready', code: 'ready', notes: 'ready' });
  assert.deepEqual(rows.guide.holds.map(h => [h.kind, h.target]), [['writer', 'R-0001-actor-notes']]);
  assert.match(rows.guide.holds[0].release, /^record successful handoff R-0001-actor-notes \(notes, PL-0001\), which writes docs\/notes\.md, before writing docs\/$/);
  assert.equal(rows.guide.command, undefined);
  assert.equal(rows.guide.idle, false, 'held by a real writer, so not flagged idle');
  assert.deepEqual(rows.tests.holds.map(h => h.target), ['R-0001-actor-code']);
  const running = reconcile([{ kind: 'call', id: 'R-0001-actor-guide', records: '/records', pid: 7 }]);
  assert.deepEqual([running.guide.status, running.notes.status, running.notes.holds.map(h => h.target)], ['running', 'waiting', ['R-0001-actor-guide']],
    'a running package of a later plan holds an earlier plan\'s ready package');
  assert.equal(running.code.status, 'ready');
});

test('measures-zero per plan: a batch the plan names accrues from its publication while open, a replaced batch waits for its replacement\'s answer, and a plan naming no batch prints no 0 s (flow: the lead measures a plan behind an unanswered batch; loss: wrong-result, an open owner wait printed as unknown or 0 s)', () => {
  const at = iso => Date.parse(iso);
  const records = state({ 'owner/B-0001.md': '# B-0001\n\nphase: v1\n', 'owner/B-0002.md': '# B-0002\n\nphase: v1\n', 'owner/B-0003.md': '# B-0003\n\nphase: v1\n',
    'owner/answers.jsonl': [{ batch: 'B-0002', time: '2026-11-22T00:02:00Z', replacedBy: 'B-0003' }, { batch: 'B-0003', time: '2026-11-22T00:06:00Z', words: 'yes' }].map(e => JSON.stringify(e)).join('\n') + '\n' });
  const sent = { 'owner/B-0001.md': at('2026-11-22T00:00:00Z'), 'owner/B-0002.md': at('2026-11-22T00:01:00Z'), 'owner/B-0003.md': at('2026-11-22T00:02:00Z'), 'plans/PL-0001.md': at('2026-11-21T00:00:00Z') };
  const measure = (packages, now) => measurePlan(records, plan(packages), { published: path => sent[path] ?? null, now });
  const open = measure([pkg('a', { needs: ['B-0001'] })], at('2026-11-22T00:10:00.700Z'));
  assert.deepEqual([open.ownerWaiting.seconds, open.ownerWaiting.intervals[0].open], [600, true]);
  assert.match(renderMeasures(open), /B-0001: 2026-11-22T00:00:00\.000Z -> now, still open; 600 s and accruing\./);
  assert.equal(measure([pkg('a', { needs: ['B-0001'] })], at('2026-11-22T00:20:00Z')).ownerWaiting.seconds, 1200);
  const replaced = measure([pkg('a', { needs: ['B-0002'] })], at('2026-11-22T00:20:00Z'));
  assert.deepEqual([replaced.ownerWaiting.seconds, replaced.ownerWaiting.intervals[0].open], [300, false]);
  const none = measure([pkg('a')], at('2026-11-22T00:20:00Z'));
  assert.deepEqual([none.ownerWaiting.seconds, none.ownerWaiting.intervals], [null, []], 'no figure, never 0');
  assert.match(renderMeasures(none), /^Owner waiting time: n\/a \(the plan names no owner batch; the phase figure is in loop\.mjs next\)\.$/m);
  assert.doesNotMatch(renderMeasures(none), /Owner waiting time: 0 s/);
});
