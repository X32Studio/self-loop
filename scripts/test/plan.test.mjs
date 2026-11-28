// P-0006, D-0018, D-0063, D-0064, design/dispatch.md#file-ownership, design/dispatch.md#ready-state
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { globOverlap } from '../lib/plan-globs.mjs';
import { admitAcrossPlans, buildSharedPlanContext, criticCausalBase, judgeCoverageProblems, judgeJoinProblems, judgeLineageProblems, packageOrder, parsePlan, planCallCommand, planPackageMap, reconcilePlans, RELEASE_IN_WORDS, validatePlan, readyPlan } from '../lib/plan.mjs';
import { executionInterval, firstPublication, measurePlan, renderMeasures } from '../lib/plan-measures.mjs';
import { citedPredicates, cliClock, createPredicates, firstParentHistory, measuresLines, predicateContext, predicateReplay, queryClock, timeLines } from '../lib/predicate-replay.mjs';
import { certifiedCriticOn, checkouts, integrationOf, recordedAfter } from '../lib/integration.mjs';
import { git, repo, roomyStore, scripts, setup, temp } from './helpers.mjs';

const pkg = (id, changes = {}) => ({ id, authority: ['D-0001'], goal: `Deliver ${id}`, files: [],
  interface: 'fixed contract', needs: [], role: 'actor', acceptance: 'accept the contract',
  handoff: `R-0001-actor-${id}`, ...changes });
const covered = packages => {
  const actorIds = packages.filter(p => p.role === 'actor').map(p => p.id);
  return [...packages,
    pkg('cr', { role: 'critic', handoff: 'R-0001-critic-cr', needs: actorIds, reviews: actorIds }),
    pkg('j', { role: 'judge', handoff: 'R-0001-judge', needs: ['cr'] })];
};
const plan = packages => ({ id: 'PL-0001', scope: 'v1/round-1', phase: 'v1', packages });
const state = (files = {}) => {
  const contents = { 'decisions/D-0001.md': '# D-0001\nby: owner\n', ...files };
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
  const md = '# PL-0001 Plan\nscope: v1/round-1\nphase: v1\n## a\nauthority: D-0001\ngoal: Deliver a\nfiles: \ninterface: fixed contract\nneeds: \nrole: actor\nacceptance: accept the contract\nhandoff: R-0001-actor-a\n## cr\nauthority: D-0001\ngoal: Deliver cr\nfiles: \ninterface: fixed contract\nneeds: a\nreviews: a\nrole: critic\nacceptance: accept the contract\nhandoff: R-0001-critic-cr\n## j\nauthority: D-0001\ngoal: Deliver j\nfiles: \ninterface: fixed contract\nneeds: cr\nrole: judge\nacceptance: accept the contract\nhandoff: R-0001-judge\n';
  assert.deepEqual(validatePlan(parsePlan(md), state()), []);
  assert.deepEqual(validatePlan(parsePlan(JSON.stringify(plan(covered([pkg('a')])))), state()), []);
});

test('flow: planner validates an authority and a dependency chain; loss: false-verdict', () => {
  assert.deepEqual(validatePlan(plan(covered([pkg('a'), pkg('b', { needs: ['a', 'D-0001'] })])), state()), []);
  assert.match(validatePlan(plan(covered([pkg('a', { authority: [] })])), state()).join(), /authority/);
  assert.match(validatePlan(plan(covered([pkg('a', { needs: ['D-0099'] })])), state()).join(), /D-0099/);
  assert.match(validatePlan(plan(covered([pkg('a', { needs: ['b'] }), pkg('b', { needs: ['a'] })])), state()).join(), /cycle/);
});

test('flow: planner fixes future ownership collisions while keeping read-only packages; loss: wrong-result', () => {
  const a = pkg('a', { files: ['scripts/**/plan*.mjs'] });
  assert.deepEqual(validatePlan(plan(covered([a, pkg('b')])), state()), []);
  assert.match(validatePlan(plan(covered([a, pkg('b', { files: ['scripts/new/planning.mjs'] })])), state()).join(), /overlap/);
});

test('flow: planner revises a contract without replaying a prior completion; loss: false-verdict', () => {
  const old = plan(covered([pkg('a')]));
  const records = state({ 'plans/PL-0001.md': JSON.stringify(old) });
  const changed = { ...old, id: 'PL-0002', supersedes: old.id, packages: covered([pkg('a', { interface: 'new contract' })]) };
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
  const old = plan(covered([pkg('a', { files: ['a.js', 'b.js'], needs: ['D-0001'] })]));
  const next = { ...old, id: 'PL-0002', supersedes: old.id, packages: covered([pkg('a', { files: ['b.js', 'a.js'], needs: ['D-0001'], settings: {} })]) };
  assert.deepEqual(validatePlan(next, state({ 'plans/PL-0001.md': JSON.stringify(old) })), []);
});

test('flow: the lead runs a ready package whose role runs on a CLI runner; loss: stuck, the printed command is refused by call.mjs, which takes --prepare only for a t3 runner', () => {
  const current = plan([pkg('a'), pkg('b', { role: 'critic', handoff: 'R-0001-critic-b' })]);
  current.packages.forEach(p => { p.task = import.meta.filename; });
  const context = { cfg: { agents: { actor: { runner: 't3' }, critic: { runner: 'claude' } }, workDir: '/', configFile: '/loop.json' },
    handoffs: [], batches: [], plans: [current], prepared: [] };
  const [actor, critic] = readyPlan(state(), current, { context, host: { admits: true, over: [] } }).packages;
  assert.deepEqual([actor.status, critic.status], ['ready', 'ready']);
  assert.match(actor.command, /--plan PL-0001 --package a --task \S+ --prepare$/);
  assert.match(critic.command, /call\.mjs.* critic --round 1 --step critic-b --plan PL-0001 --package b --task \S+$/);
  assert.doesNotMatch(critic.command, /--prepare/);
});

test('flow: the lead runs loop.mjs next after committing a plan; loss: stuck, settled independent packages idle because the ready set is never queried (I-0002)', async () => {
  const s = await setup({}, { plans: false });
  const put = (root, path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const section = (id, role, handoff, files, needs = '', extra = []) => [`## ${id}`, 'authority: D-0001', `goal: Deliver ${id}`, `files: ${files}`,
    'interface: the fixed contract', `needs: ${needs}`, ...extra, `role: ${role}`, 'acceptance: its cases pass', `handoff: ${handoff}`, ''];
  put(s.records, 'loop.json', JSON.stringify(s.cfg));
  put(s.records, 'decisions/D-0001.md', '# D-0001 Build the planned work\nby: owner\n');
  put(s.records, 'plans/PL-0001.md', ['# PL-0001 Round two', 'scope: S5/round-2', 'phase: S5', '',
    ...section('build', 'actor', 'R-0002-actor-a', 'src/'), ...section('cases', 'critic', 'R-0002-critic-b', 'test/', '', ['reviews: build, follow']),
    ...section('follow', 'actor', 'R-0002-actor-c', 'docs/notes.md', 'build'),
    ...section('verdict', 'judge', 'R-0002-judge', '', 'cases, follow')].join('\n'));
  for (const id of ['R-0002-actor-a', 'R-0002-critic-b', 'R-0002-actor-c', 'R-0002-judge']) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  git(s.records, 'add', '-A'); git(s.records, 'commit', '-qm', 'plan');
  const config = join(s.records, 'loop.json');
  const run = () => spawnSync(process.execPath, [join(scripts, 'loop.mjs'), 'next', '--config', config], { encoding: 'utf8',
    env: { ...process.env, SELF_LOOP_LOAD_DIR: temp('self-loop-load-'), SELF_LOOP_OWNER_STORE: roomyStore() } });
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^- plan PL-0001 \(S5\/round-2\): 2 ready, 2 waiting, 0 running, 0 done \[plans\//m);
  assert.match(out.stdout, /^ {4}node \S+call\.mjs \S+loop\.json actor --round 2 --step actor-a --plan PL-0001 --package build --task \S+R-0002-actor-a\.md$/m);
  assert.match(out.stdout, /^ {4}node \S+call\.mjs \S+loop\.json critic --round 2 --step critic-b --plan PL-0001 --package cases --task \S+R-0002-critic-b\.md$/m);
  assert.match(out.stdout, /^ {2}follow \(R-0002-actor-c\) waits: package build; release: record successful handoff R-0002-actor-a$/m);
  assert.match(out.stdout, /^ {2}node \S+plan\.mjs ready --records \S+ --plan PL-0001$/m);
  assert.doesNotMatch(out.stdout, /plans\/PL-0001\.md \(undeclared\)/, 'RECORDS.md declares the Plan kind');
  put(s.records, 'plans/PL-0002.md', ['# PL-0002 Round two, revised', 'scope: S5/round-2', 'phase: S5', 'supersedes: PL-0001', '',
    ...section('cases', 'critic', 'R-0002-critic-bb', 'test/')].join('\n'));
  put(s.cfg.workDir, 'tasks/R-0002-critic-bb.md', 'features: F-0001\nR-0002-critic-bb\n');
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
  assert.match(merged.command, new RegExp(`call\\.mjs \\S+ judge --round 1 --step judge --base ${sha} --plan PL-0001 --package j --task \\S+ --prepare$`));
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
  const md = '# PL-0001 Plan\nscope: v1/round-1\nphase: v1\n## docs\nauthority: D-0001\ngoal: Deliver docs\nfiles: [A-Z]*.md, docs/\ninterface: fixed contract\nneeds: \nrole: actor\nacceptance: accept the contract\nhandoff: R-0001-actor-docs\n## code\nauthority: D-0001\ngoal: Deliver code\nfiles: ["scripts/**"]\ninterface: fixed contract\nneeds: \nrole: actor\nacceptance: accept the contract\nhandoff: R-0001-actor-code\n## cr\nauthority: D-0001\ngoal: Review\nfiles: test/a.test.mjs\ninterface: fixed contract\nneeds: docs, code\nreviews: docs, code\nrole: critic\nacceptance: accept the contract\nhandoff: R-0001-critic-cr\n## j\nauthority: D-0001\ngoal: Judge\nfiles: \ninterface: fixed contract\nneeds: cr\nrole: judge\nacceptance: accept the contract\nhandoff: R-0001-judge\n';
  const parsed = parsePlan(md);
  assert.deepEqual(parsed.packages.slice(0, 2).map(p => p.files), [['[A-Z]*.md', 'docs/'], ['scripts/**']]);
  assert.deepEqual(validatePlan(parsed, state()), []);
  parsed.packages[1].files = ['SKILL.md'];
  assert.match(validatePlan(parsed, state()).join(), /overlap/);
});

test('R8-2 a release in words stays a hold and is listed for review on every next reading; a computed release holds silently (flow: the lead holds one package until the owner says go and another until a ruling lands; loss: stuck, a wait no code can check silences the idle alarm for good)', async () => {
  const s = await setup({}, { plans: false });
  const put = (root, path, data) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), data); };
  const section = (id, handoff, files, extra = [], role = 'actor', needs = '') => [`## ${id}`, 'authority: D-0001', `goal: Deliver ${id}`, `files: ${files}`,
    'interface: the fixed contract', `needs: ${needs}`, `role: ${role}`, 'acceptance: its cases pass', `handoff: ${handoff}`, ...extra, ''];
  put(s.records, 'loop.json', JSON.stringify(s.cfg));
  put(s.records, 'decisions/D-0001.md', '# D-0001 Build the planned work\nby: owner\n');
  put(s.records, 'plans/PL-0001.md', ['# PL-0001 Round two', 'scope: S5/round-2', 'phase: S5', '',
    ...section('worded', 'R-0002-actor-a', 'src/a/', ['hold: the owner asked to wait', 'release: the owner says go']),
    ...section('ruled', 'R-0002-actor-b', 'src/b/', ['hold: waits for the ruling', 'release: D-0099']),
    ...section('free', 'R-0002-actor-c', 'src/c/'),
    ...section('cases', 'R-0002-critic-d', 'test/', ['reviews: worded, ruled, free'], 'critic', 'worded, ruled, free'),
    ...section('verdict', 'R-0002-judge', '', [], 'judge', 'cases')].join('\n'));
  for (const id of ['R-0002-actor-a', 'R-0002-actor-b', 'R-0002-actor-c', 'R-0002-critic-d', 'R-0002-judge']) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
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

test('D-0063 sequential plan ownership: transitive needs chains may share files while unordered and cross-depth overlaps stay refused and live writer holds persist (flow: critic-initial -> actor -> critic-post-actor share one living suite; loss: false-verdict / wrong-result)', () => {
  const seq = plan([
    pkg('critic-initial', { role: 'critic', handoff: 'R-0001-critic-init', files: ['acceptance/domain.test.mjs'], reviews: ['actor-fix'] }),
    pkg('actor-fix', { role: 'actor', handoff: 'R-0001-actor-fix', files: ['src/a.js'], needs: ['critic-initial'] }),
    pkg('critic-post', { role: 'critic', handoff: 'R-0001-critic-post', files: ['acceptance/domain.test.mjs'], needs: ['actor-fix'], reviews: ['actor-fix'] }),
    pkg('judge', { role: 'judge', handoff: 'R-0001-judge', files: [], needs: ['critic-post'] }),
  ]);
  assert.deepEqual(validatePlan(seq, state()), []);
  const ord = packageOrder(seq);
  assert.equal(ord.reaches('critic-initial', 'critic-post'), true);
  assert.equal(ord.ordered('critic-initial', 'critic-post'), true);

  const byHandoff = plan([
    pkg('critic-initial', { role: 'critic', handoff: 'R-0001-critic-init', files: ['acceptance/domain.test.mjs'] }),
    pkg('actor-fix', { role: 'actor', handoff: 'R-0001-actor-fix', files: ['src/a.js'], needs: ['R-0001-critic-init'] }),
    pkg('critic-post', { role: 'critic', handoff: 'R-0001-critic-post', files: ['acceptance/domain.test.mjs'], needs: ['R-0001-actor-fix'], reviews: ['actor-fix'] }),
    pkg('judge', { role: 'judge', handoff: 'R-0001-judge', files: [], needs: ['R-0001-critic-post'] }),
  ]);
  assert.deepEqual(validatePlan(byHandoff, state()), []);
  assert.equal(planPackageMap(byHandoff).get('R-0001-critic-init')?.id, 'critic-initial');
  assert.equal(planPackageMap(byHandoff).get('actor-fix')?.handoff, 'R-0001-actor-fix');
  assert.equal(packageOrder(byHandoff).ordered('critic-initial', 'critic-post'), true);
  assert.equal(packageOrder(byHandoff).reaches('R-0001-critic-init', 'R-0001-judge'), true);

  const preActorHandoffOnly = plan([
    pkg('critic-initial', { role: 'critic', handoff: 'R-0001-critic-init', files: ['acceptance/domain.test.mjs'] }),
    pkg('actor-fix', { role: 'actor', handoff: 'R-0001-actor-fix', files: ['src/a.js'], needs: ['R-0001-critic-init'] }),
    pkg('judge', { role: 'judge', handoff: 'R-0001-judge', files: [], needs: ['R-0001-actor-fix'] }),
  ]);
  assert.deepEqual(validatePlan(preActorHandoffOnly, state()), []);

  const missingExternal = plan([
    pkg('critic-initial', { role: 'critic', handoff: 'R-0001-critic-init', files: ['acceptance/domain.test.mjs'], needs: ['R-0001-critic-missing'] }),
    pkg('actor-fix', { role: 'actor', handoff: 'R-0001-actor-fix', files: ['src/a.js'], needs: ['R-0001-critic-init'] }),
    pkg('judge', { role: 'judge', handoff: 'R-0001-judge', files: [], needs: ['R-0001-actor-fix'] }),
  ]);
  assert.match(validatePlan(missingExternal, state()).join('\n'), /missing committed record R-0001-critic-missing/);

  const handoffCycle = plan([
    pkg('a', { files: ['src/a.js'], needs: ['R-0001-actor-b'] }),
    pkg('b', { files: ['src/b.js'], needs: ['R-0001-actor-a'] }),
    pkg('cr', { role: 'critic', handoff: 'R-0001-critic-cr', needs: ['a', 'b'], reviews: ['a', 'b'] }),
    pkg('j', { role: 'judge', handoff: 'R-0001-judge', needs: ['cr'] }),
  ]);
  assert.match(validatePlan(handoffCycle, state()).join('\n'), /needs cycle/);

  byHandoff.packages.forEach(p => { p.task = import.meta.filename; });
  const handoffCtx = {
    cfg: { agents: { critic: { runner: 't3' }, actor: { runner: 't3' }, judge: { runner: 't3' } }, workDir: '/', configFile: '/loop.json' },
    handoffs: [], batches: [], plans: [byHandoff], prepared: [],
  };
  const handoffReady0 = readyPlan(state(), byHandoff, { context: handoffCtx, host: { admits: true, over: [] } });
  assert.equal(handoffReady0.packages.find(p => p.id === 'critic-initial').status, 'ready');
  const waitingActor = handoffReady0.packages.find(p => p.id === 'actor-fix');
  assert.equal(waitingActor.status, 'waiting');
  assert.ok(waitingActor.holds.some(h => h.kind === 'package' && h.target === 'critic-initial' && /R-0001-critic-init/.test(h.release)));
  const handoffReady1 = readyPlan(
    state({ 'rounds/0001-critic-init.md': '# R-0001-critic-init\n' }),
    byHandoff,
    { context: { ...handoffCtx, handoffs: [{ id: 'R-0001-critic-init', phase: 'v1', record: 'rounds/0001-critic-init.md' }] }, host: { admits: true, over: [] } },
  );
  assert.equal(handoffReady1.packages.find(p => p.id === 'actor-fix').status, 'ready');
  assert.equal(handoffReady1.packages.find(p => p.id === 'critic-post').status, 'waiting');

  seq.packages.forEach(p => { p.task = import.meta.filename; });
  const context = {
    cfg: { agents: { critic: { runner: 't3' }, actor: { runner: 't3' }, judge: { runner: 't3' } }, workDir: '/', configFile: '/loop.json' },
    handoffs: [], batches: [], plans: [seq],
    prepared: [{ id: 'R-0001-critic-init', role: 'critic', phase: 'v1', liveWorkspace: true, ws: '/work/c0', dispatch: { files: ['acceptance/domain.test.mjs'] } }],
  };
  const ready = readyPlan(state(), seq, { context, host: { admits: true, over: [] } });
  const postRow = ready.packages.find(p => p.id === 'critic-post');
  assert.equal(postRow.status, 'waiting');
  assert.ok(postRow.holds.some(h => h.kind === 'package' && h.target === 'actor-fix'));
  assert.ok(postRow.holds.some(h => h.kind === 'writer' && h.target === 'R-0001-critic-init'));

  const crossDepth = plan([
    pkg('aa', { files: ['src/a0.js'] }),
    pkg('ab', { files: ['src/a1.js'], needs: ['aa'] }),
    pkg('ca', { role: 'critic', handoff: 'R-0001-critic-a', files: ['acceptance/domain.test.mjs'], needs: ['ab'], reviews: ['aa', 'ab'] }),
    pkg('ba', { files: ['src/b0.js'] }),
    pkg('cb', { role: 'critic', handoff: 'R-0001-critic-b', files: ['acceptance/domain.test.mjs'], needs: ['ba'], reviews: ['ba'] }),
    pkg('j', { role: 'judge', handoff: 'R-0001-judge', files: [], needs: ['ca', 'cb'] }),
  ]);
  assert.match(validatePlan(crossDepth, state()).join('\n'), /ca and cb share overlapping files/);
});

test('R49-1 measurePlan resolves same-plan handoff-ID needs identically to package-ID needs (flow: lead measures a sequential plan; loss: wrong-result)', () => {
  const at = iso => Date.parse(iso);
  const log = (start, end) => gzipSync([
    { timestamp: start, type: 'user', message: { content: 'task' } },
    { timestamp: end, type: 'result', subtype: 'success' },
  ].map(r => JSON.stringify(r)).join('\n'));
  const specs = [
    ['critic-init', 'critic', 'R-0002-critic-init', '2026-11-24T09:00:10Z', '2026-11-24T09:00:15Z', '2026-11-24T09:00:20Z', 5],
    ['actor-fix', 'actor', 'R-0002-actor-fix', '2026-11-24T09:00:30Z', '2026-11-24T09:00:40Z', '2026-11-24T09:00:45Z', 10],
    ['critic-post', 'critic', 'R-0002-critic-post', '2026-11-24T09:00:50Z', '2026-11-24T09:00:56Z', '2026-11-24T09:01:00Z', 6],
    ['judge-final', 'judge', 'R-0002-judge', '2026-11-24T09:01:10Z', '2026-11-24T09:01:21Z', '2026-11-24T09:01:25Z', 11],
  ];
  const files = {}, sent = { 'plans/PL-0001.md': at('2026-11-24T09:00:00Z') }, handoffs = [];
  for (const [, role, id, start, end, pub, seconds] of specs) {
    const rec = `rounds/${id.slice(2)}.md`, lg = `evidence/${id}.log.gz`;
    files[rec] = `# ${id}\n`; files[lg] = log(start, end); sent[rec] = at(pub);
    handoffs.push({ id, time: pub, phase: 'v1', round: 2, step: id.slice(7), role, attempt: 1, agent: { runner: 't3', seconds }, view: 'a'.repeat(40), product: null, audit: { violations: 0 }, record: rec, files: [rec, lg] });
  }
  files['metrics/handoffs.jsonl'] = handoffs.map(h => JSON.stringify(h)).join('\n') + '\n';
  const recState = state(files);
  const build = useHandoff => plan([
    pkg('critic-init', { role: 'critic', handoff: 'R-0002-critic-init', reviews: ['actor-fix'] }),
    pkg('actor-fix', { role: 'actor', handoff: 'R-0002-actor-fix', needs: [useHandoff ? 'R-0002-critic-init' : 'critic-init'] }),
    pkg('critic-post', { role: 'critic', handoff: 'R-0002-critic-post', needs: [useHandoff ? 'R-0002-actor-fix' : 'actor-fix'], reviews: ['actor-fix'] }),
    pkg('judge-final', { role: 'judge', handoff: 'R-0002-judge', needs: [useHandoff ? 'R-0002-critic-post' : 'critic-post'] }),
  ]);
  const byPkg = measurePlan(recState, build(false), { published: p => sent[p] ?? null, now: at('2026-11-24T09:02:00Z') });
  const byHandoff = measurePlan(recState, build(true), { published: p => sent[p] ?? null, now: at('2026-11-24T09:02:00Z') });
  assert.equal(byPkg.criticalPath.seconds, 32);
  assert.deepEqual(byHandoff.criticalPath, byPkg.criticalPath);
  assert.deepEqual(byHandoff.criticalPath.path, ['critic-init', 'actor-fix', 'critic-post', 'judge-final']);
  assert.deepEqual(byHandoff.idleDispatchable.intervals, byPkg.idleDispatchable.intervals);
  assert.deepEqual(byHandoff.idleDispatchable.intervals.map(i => i.dependencyAvailableWindowSeconds), [10, 10, 5, 10]);
  assert.deepEqual(byHandoff.execution, byPkg.execution);
});

test('R50-1/R50-2 criticCausalBase pins off-branch actors, holds diverged actors, and judgeLineageProblems preserves no-change actor ancestry (flow: critic/judge preparation; loss: wrong-result)', () => {
  const r = repo({ 'src/a.js': 'export const a = 1;\n', 'src/b.js': 'export const b = 1;\n', 'README.md': '# r\n' });
  const olderSha = git(r, 'rev-parse', 'HEAD');
  const commitOn = (parent, file, body, msg) => {
    git(r, 'checkout', '-q', '--detach', parent); writeFileSync(join(r, file), body);
    git(r, 'add', file); git(r, 'commit', '-qm', msg); return git(r, 'rev-parse', 'HEAD');
  };
  const docSha = commitOn(olderSha, 'README.md', '# doc\n', 'doc');
  const shaA = commitOn(olderSha, 'src/a.js', 'export const a = 2;\n', 'actor a');
  const shaB = commitOn(olderSha, 'src/b.js', 'export const b = 2;\n', 'actor b');
  git(r, 'checkout', '-q', '--detach', shaA); git(r, 'merge', '-q', '--no-edit', shaB);
  const mergeSha = git(r, 'rev-parse', 'HEAD');
  const pl = plan([
    pkg('c0', { role: 'critic', handoff: 'R-0001-critic-init' }), pkg('a1', { handoff: 'R-0001-actor-a', needs: ['c0'] }),
    pkg('a2', { handoff: 'R-0001-actor-b', needs: ['c0'] }), pkg('c1', { role: 'critic', handoff: 'R-0001-critic-one', needs: ['a1'] }),
    pkg('cj', { role: 'critic', handoff: 'R-0001-critic-join', needs: ['a1', 'a2'] }), pkg('j', { role: 'judge', handoff: 'R-0001-judge', needs: ['cj'] }),
  ]);
  pl.packages.forEach(p => { p.task = import.meta.filename; });
  const hs = [
    { id: 'R-0001-critic-init', phase: 'v1', record: 'rounds/0001-critic-init.md', product: { base: olderSha, commit: olderSha } },
    { id: 'R-0001-actor-a', phase: 'v1', record: 'rounds/0001-actor-a.md', product: { base: olderSha, commit: shaA } },
    { id: 'R-0001-actor-b', phase: 'v1', record: 'rounds/0001-actor-b.md', product: { base: olderSha, commit: shaB } },
  ];
  assert.deepEqual(criticCausalBase(pl, pl.packages[0], { repo: r, handoffs: hs, base: docSha }), { ok: true, base: docSha, pinned: false, missing: [] });
  const pinOne = criticCausalBase(pl, pl.packages[3], { repo: r, handoffs: hs, base: docSha });
  assert.deepEqual([pinOne.ok, pinOne.base, pinOne.pinned, pinOne.missing.length], [true, shaA, true, 1]);
  assert.match(pinOne.detail, new RegExp(shaA.slice(0, 12)));
  const div = criticCausalBase(pl, pl.packages[4], { repo: r, handoffs: hs, base: null });
  assert.deepEqual([div.ok, div.base, div.pinned, div.missing.length], [false, null, false, 2]);
  assert.match(div.release, /dispatch\.mjs integrate --plan PL-0001 --apply/);
  const files = Object.fromEntries(hs.map(h => [h.record, `# ${h.id}\n`]));
  const ctx = { cfg: { product: r, agents: { critic: { runner: 't3' }, actor: { runner: 't3' }, judge: { runner: 't3' } }, workDir: '/', configFile: '/loop.json' }, handoffs: hs, batches: [], plans: [pl], prepared: [] };
  const held = readyPlan(state(files), pl, { context: ctx, host: { admits: true, over: [] }, base: null });
  assert.match(held.packages.find(p => p.id === 'c1').command, new RegExp(`--base ${shaA}`));
  const cjHeld = held.packages.find(p => p.id === 'cj');
  assert.deepEqual([cjHeld.status, cjHeld.command, cjHeld.holds[0].kind], ['waiting', undefined, 'merge']);
  assert.match(readyPlan(state(files), pl, { context: ctx, host: { admits: true, over: [] }, base: mergeSha }).packages.find(p => p.id === 'cj').command, new RegExp(`--base ${mergeSha}`));

  const noDiffPlan = plan([pkg('a1', { handoff: 'R-0002-actor-fix' }), pkg('cp', { role: 'critic', handoff: 'R-0002-critic-post', needs: ['a1'] }), pkg('j', { role: 'judge', handoff: 'R-0002-judge', needs: ['cp'] })]);
  noDiffPlan.packages.forEach(p => { p.task = import.meta.filename; });
  const hsNoDiff = [
    { id: 'R-0002-actor-fix', phase: 'v1', record: 'rounds/0002-actor-fix.md', product: { base: docSha, commit: docSha } },
    { id: 'R-0002-critic-post', phase: 'v1', record: 'rounds/0002-critic-post.md', product: { base: docSha, commit: docSha } },
  ];
  assert.deepEqual(judgeLineageProblems(noDiffPlan, { repo: r, handoffs: hsNoDiff, base: olderSha }).map(p => [p.kind, p.id, p.sha]), [['merge', 'a1', docSha]]);
  assert.deepEqual(judgeLineageProblems(noDiffPlan, { repo: r, handoffs: hsNoDiff, base: docSha }), []);
  assert.deepEqual(judgeLineageProblems(noDiffPlan, { repo: r, handoffs: [hsNoDiff[0], { ...hsNoDiff[1], product: { base: olderSha, commit: olderSha } }], base: docSha }).map(p => [p.kind, p.id]), [['lineage', 'cp']]);
  const noDiffCtx = { ...ctx, handoffs: hsNoDiff, plans: [noDiffPlan] }, noDiffFiles = Object.fromEntries(hsNoDiff.map(h => [h.record, `# ${h.id}\n`]));
  assert.equal(readyPlan(state(noDiffFiles), noDiffPlan, { context: noDiffCtx, host: { admits: true, over: [] }, base: olderSha }).packages.find(p => p.id === 'j').status, 'waiting');
  assert.equal(readyPlan(state(noDiffFiles), noDiffPlan, { context: noDiffCtx, host: { admits: true, over: [] }, base: docSha }).packages.find(p => p.id === 'j').status, 'ready');
});

test('R51-1/R51-2/D-0064 T10: planCallCommand binds plan/package, readyPlan holds code judge on pending critic/coverage, and validatePlan allows actor+critic without mandatory judge', () => {
  const actorCritic = plan([
    pkg('a1', { handoff: 'R-0001-actor-a', files: ['src/a.js'] }),
    pkg('c1', { role: 'critic', handoff: 'R-0001-critic-post', files: ['test/a.test.js'], needs: ['a1'], reviews: ['a1'] }),
  ]);
  assert.deepEqual(validatePlan(actorCritic, state()), []);
  assert.match(validatePlan(plan([pkg('a1', { handoff: 'R-0001-actor-a', files: ['src/a.js'] })]), state()).join('\n'), /lack critic coverage/);

  const withJudge = plan([
    pkg('a1', { handoff: 'R-0001-actor-a', files: ['src/a.js'] }),
    pkg('c1', { role: 'critic', handoff: 'R-0001-critic-post', files: ['test/a.test.js'], needs: ['a1'], reviews: ['a1'] }),
    pkg('jf', { role: 'judge', handoff: 'R-0001-judge-frame', needs: ['a1'] }),
    pkg('j', { role: 'judge', handoff: 'R-0001-judge', needs: ['a1'] }),
  ]);
  withJudge.packages.forEach(p => { p.task = import.meta.filename; });
  const r = repo({ 'src/a.js': 'export const a = 1;\n' });
  const sha = git(r, 'rev-parse', 'HEAD');
  const actorH = { id: 'R-0001-actor-a', phase: 'v1', record: 'rounds/0001-actor-a.md', product: { base: sha, commit: sha } };
  const criticH = { id: 'R-0001-critic-post', phase: 'v1', record: 'rounds/0001-critic-post.md', product: { base: sha, commit: sha } };
  const cfg = { product: r, agents: { actor: { runner: 't3' }, critic: { runner: 't3' }, judge: { runner: 't3' } }, workDir: '/', configFile: '/loop.json' };
  const host = { admits: true, over: [] };

  const pendingCtx = { cfg, handoffs: [actorH], batches: [], plans: [withJudge], prepared: [] };
  const pendingState = state({ [actorH.record]: '# actor\n' });
  const pendingReady = readyPlan(pendingState, withJudge, { context: pendingCtx, host, base: sha });
  const jHeld = pendingReady.packages.find(p => p.id === 'j');
  const jfReady = pendingReady.packages.find(p => p.id === 'jf');
  const cReady = pendingReady.packages.find(p => p.id === 'c1');
  assert.equal(jfReady.status, 'ready');
  assert.equal(cReady.status, 'ready');
  assert.equal(cReady.command, planCallCommand(cfg, 'PL-0001', withJudge.packages[1], { base: sha }));
  assert.deepEqual([jHeld.status, jHeld.idle, jHeld.command], ['waiting', false, undefined]);
  assert.ok(jHeld.holds.some(h => h.kind === 'critic' && h.release.includes('R-0001-critic-post')));
  assert.deepEqual(judgeCoverageProblems(withJudge, { handoffs: [actorH] }).map(p => [p.kind, p.handoff]), [['critic', 'R-0001-critic-post']]);

  const doneCtx = { cfg, handoffs: [actorH, criticH], batches: [], plans: [withJudge], prepared: [] };
  const doneState = state({ [actorH.record]: '# actor\n', [criticH.record]: '# critic\n' });
  assert.deepEqual(judgeJoinProblems(withJudge, { repo: r, handoffs: [actorH, criticH], base: sha }), []);
  const jReady = readyPlan(doneState, withJudge, { context: doneCtx, host, base: sha }).packages.find(p => p.id === 'j');
  assert.equal(jReady.status, 'ready');
  assert.equal(jReady.command, planCallCommand(cfg, 'PL-0001', withJudge.packages[3], { base: sha }));

  const uncovered = plan([pkg('a1', { handoff: 'R-0001-actor-a', files: ['src/a.js'] }), pkg('j', { role: 'judge', handoff: 'R-0001-judge', needs: ['a1'] })]);
  uncovered.packages.forEach(p => { p.task = import.meta.filename; });
  const covHeld = readyPlan(pendingState, uncovered, { context: { ...pendingCtx, plans: [uncovered] }, host, base: sha }).packages.find(p => p.id === 'j');
  assert.deepEqual([covHeld.status, covHeld.idle, covHeld.holds[0].kind], ['waiting', false, 'coverage']);
  const slackReady = readyPlan(pendingState, uncovered, { context: { ...pendingCtx, plans: [uncovered] }, host, base: sha, window: { mode: 'slack' } }).packages.find(p => p.id === 'j');
  assert.equal(slackReady.status, 'ready');
});

// F-0015, P-0014, P-0015, R-0055-judge-frame-hygiene
test('F-0015 A7: buildSharedPlanContext indexes audits by round/step, verifies audit.nonce with 0 gunzipSync, parses >1 MiB legacy audits safely, and keeps legacy .log.gz fallback', () => {
  const pl = plan([
    pkg('fast', { handoff: 'R-0008-actor-fast', files: ['src/fast.js'] }),
    pkg('mismatch', { handoff: 'R-0008-actor-mismatch', files: ['src/mismatch.js'] }),
    pkg('legacy', { handoff: 'R-0008-actor-legacy', files: ['src/legacy.js'] }),
    pkg('huge', { handoff: 'R-0008-actor-huge', files: ['src/huge.js'] }),
    pkg('hugetail', { handoff: 'R-0008-actor-hugetail', files: ['src/hugetail.js'] }),
  ]);
  pl.packages.forEach(p => { p.task = import.meta.filename; });
  const padPayload = 'x'.repeat(1_200_000);
  const hugeHead = JSON.stringify({ id: 'R-0008-actor-huge', nonce: 'n-huge', agent: { session: 's-huge' }, flags: [{ pad: padPayload }] });
  const hugeTail = JSON.stringify({ flags: [{ pad: padPayload }], id: 'R-0008-actor-hugetail', nonce: 'n-tail', agent: { session: 's-tail' } });
  const recState = state({
    'evidence/0008/actor-fast-1-audit.json': JSON.stringify({ id: 'R-0008-actor-fast', nonce: 'n-fast', agent: { session: 's-fast' } }),
    'evidence/0008/actor-fast-1.log.gz': Buffer.from('not-gzip-proves-zero-gunzip'),
    'evidence/0008/actor-mismatch-1-audit.json': JSON.stringify({ id: 'R-0008-actor-mismatch', nonce: 'n-old', agent: { session: 's-m' } }),
    'evidence/0008/actor-mismatch-1.log.gz': gzipSync('prompt n-new\n'),
    'evidence/0008/actor-legacy-1-audit.json': JSON.stringify({ id: 'R-0008-actor-legacy', agent: { session: 's-leg' } }),
    'evidence/0008/actor-legacy-1.log.gz': gzipSync('prompt n-legacy\n'),
    'evidence/0008/actor-huge-1-audit.json': Buffer.from(hugeHead),
    'evidence/0008/actor-hugetail-1-audit.json': Buffer.from(hugeTail),
    'evidence/0009/actor-fast-1-audit.json': JSON.stringify({ id: 'R-0009-actor-fast', nonce: 'other', agent: { session: 's-other' } }),
  });
  const cfg = { agents: { actor: { runner: 't3' } }, workDir: '/', configFile: '/loop.json', records: '/records' };
  const shared = buildSharedPlanContext(recState, cfg, { live: false, plans: [pl] });
  assert.deepEqual(shared.auditFilesByStep.get('0008/actor-fast'), ['evidence/0008/actor-fast-1-audit.json']);
  assert.deepEqual(shared.auditFilesByStep.get('0009/actor-fast'), ['evidence/0009/actor-fast-1-audit.json']);
  const prepared = [
    { id: 'R-0008-actor-fast', round: 8, step: 'actor-fast', phase: 'v1', liveWorkspace: false, ws: '/w/fast', nonce: 'n-fast' },
    { id: 'R-0008-actor-mismatch', round: 8, step: 'actor-mismatch', phase: 'v1', liveWorkspace: false, ws: '/w/mismatch', nonce: 'n-new' },
    { id: 'R-0008-actor-legacy', phase: 'v1', liveWorkspace: false, ws: '/w/legacy', nonce: 'n-legacy' },
    { id: 'R-0008-actor-huge', round: 8, step: 'actor-huge', phase: 'v1', liveWorkspace: false, ws: '/w/huge', nonce: 'n-huge' },
    { id: 'R-0008-actor-hugetail', round: 8, step: 'actor-hugetail', phase: 'v1', liveWorkspace: false, ws: '/w/tail', nonce: 'n-tail' },
  ];
  const out = readyPlan(recState, pl, { context: { ...shared, prepared }, host: { admits: true, over: [] } });
  const byId = Object.fromEntries(out.packages.map(r => [r.id, r]));
  assert.equal(byId.fast.status, 'ready');
  assert.equal(byId.mismatch.status, 'waiting');
  assert.equal(byId.mismatch.holds[0].kind, 'attempt');
  assert.equal(byId.legacy.status, 'ready');
  assert.equal(byId.huge.status, 'ready');
  assert.equal(byId.hugetail.status, 'ready');
});

// F-0015, R-0054-reviewer-architecture
test('F-0015: reconcilePlans shares context across current plans and extracted leaf modules stay acyclic', async () => {
  const s = await setup({}, { plans: false });
  const put = (root, p, d) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), d); };
  const sec = (id, role, handoff, files, needs = '', extra = []) => [`## ${id}`, 'authority: D-0001', `goal: Deliver ${id}`, `files: ${files}`,
    'interface: fixed', `needs: ${needs}`, ...extra, `role: ${role}`, 'acceptance: green', `handoff: ${handoff}`, ''];
  put(s.records, 'loop.json', JSON.stringify(s.cfg));
  put(s.records, 'decisions/D-0001.md', '# D-0001\nby: owner\n');
  put(s.records, 'plans/PL-0001.md', ['# PL-0001 One', 'scope: S5/one', 'phase: S5', '',
    ...sec('a', 'actor', 'R-0002-actor-a', 'src/a/'), ...sec('ca', 'critic', 'R-0002-critic-a', 'test/a/', 'a', ['reviews: a'])].join('\n'));
  put(s.records, 'plans/PL-0002.md', ['# PL-0002 Two', 'scope: S5/two', 'phase: S5', '',
    ...sec('b', 'actor', 'R-0002-actor-b', 'src/b/'), ...sec('cb', 'critic', 'R-0002-critic-b', 'test/b/', 'b', ['reviews: b'])].join('\n'));
  for (const id of ['R-0002-actor-a', 'R-0002-critic-a', 'R-0002-actor-b', 'R-0002-critic-b']) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  git(s.records, 'add', '-A'); git(s.records, 'commit', '-qm', 'two plans');
  const rec = reconcilePlans(s.records, 'HEAD', 'S5', { host: { admits: true, over: [], calls: [] }, live: true });
  assert.equal(rec.problem, null);
  assert.equal(rec.plans.length, 2);
  assert.deepEqual(rec.plans.map(p => p.result.ready), [['a'], ['b']]);

  assert.equal(typeof queryClock, 'function');
  assert.equal(typeof cliClock, 'function');
  assert.equal(typeof timeLines, 'function');
  assert.equal(typeof measuresLines, 'function');
  assert.equal(typeof createPredicates, 'function');
  assert.equal(typeof predicateContext, 'function');
  assert.equal(typeof firstParentHistory, 'function');
  assert.equal(typeof predicateReplay, 'function');
  assert.equal(typeof recordedAfter, 'function');
  assert.equal(typeof checkouts, 'function');
  assert.equal(typeof integrationOf, 'function');
  assert.equal(typeof certifiedCriticOn, 'function');
  assert.deepEqual(citedPredicates('carried-by: open-words and stall'), ['stall', 'open-words']);
  assert.equal(cliClock({}).clockMode, 'live');
  assert.deepEqual(timeLines(null), []);

  for (const rel of ['lib/predicate-replay.mjs', 'lib/integration.mjs']) {
    const src = readFileSync(join(scripts, rel), 'utf8');
    assert.doesNotMatch(src, /from\s+["'][^"']*loop\.mjs["']/, `${rel} must not import loop.mjs`);
  }
});

// P-0019, F-0017
test('F-0017 TB-03: firstPublication caches one repo-wide git log pass across 6+ paths, returns exact ISO timestamps, rejects re-added paths, and refreshes on moving HEAD', () => {
  const r = repo({});
  const put = (p, body) => { mkdirSync(dirname(join(r, p)), { recursive: true }); writeFileSync(join(r, p), body); };
  const commitAt = (isoDate, msg) => {
    const res = spawnSync('git', ['-C', r, 'commit', '-qm', msg], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate },
    });
    assert.equal(res.status, 0, res.stderr);
  };
  const t1 = '2026-11-20T10:00:00Z';
  const t2 = '2026-11-21T11:30:00Z';
  const t3 = '2026-11-22T12:45:00Z';
  const t4 = '2026-11-23T14:15:00Z';
  const t5 = '2026-11-24T15:00:00Z';
  put('plans/PL-0001.md', '# PL-0001\n');
  put('owner/B-0001.md', '# B-0001\n');
  put('rounds/0001-actor-a.md', '# a\n');
  git(r, 'add', '-A'); commitAt(t1, 'c1');
  put('rounds/0001-actor-b.md', '# b\n');
  put('rounds/0001-critic.md', '# c\n');
  put('rounds/0001-readded.md', '# v1\n');
  git(r, 'add', '-A'); commitAt(t2, 'c2');
  git(r, 'rm', '-q', 'rounds/0001-readded.md');
  put('plans/PL-0001.md', '# PL-0001 updated\n');
  put('rounds/0002-actor.md', '# a2\n');
  git(r, 'add', '-A'); commitAt(t3, 'c3');
  put('rounds/0001-readded.md', '# v2\n');
  git(r, 'add', '-A'); commitAt(t4, 'c4');
  const rev = git(r, 'rev-parse', 'HEAD');

  const prevPath = process.env.PATH ?? '';
  const realGit = prevPath.split(':').map(dir => join(dir, 'git')).find(p => existsSync(p));
  assert.ok(realGit, 'real git binary must be resolvable on PATH');
  const bin = temp('self-loop-gitwrap-');
  const logFile = join(bin, 'git-log-calls.txt');
  const wrapper = join(bin, 'git');
  writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "log" ]; then
    printf 'log\\n' >> ${JSON.stringify(logFile)}
    break
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`);
  chmodSync(wrapper, 0o755);

  const st = { records: r, revision: rev };
  try {
    process.env.PATH = `${bin}:${prevPath}`;
    assert.equal(firstPublication(st, 'plans/PL-0001.md'), Date.parse(t1));
    assert.equal(firstPublication(st, 'owner/B-0001.md'), Date.parse(t1));
    assert.equal(firstPublication(st, 'rounds/0001-actor-a.md'), Date.parse(t1));
    assert.equal(firstPublication(st, 'rounds/0001-actor-b.md'), Date.parse(t2));
    assert.equal(firstPublication(st, 'rounds/0001-critic.md'), Date.parse(t2));
    assert.equal(firstPublication(st, 'rounds/0002-actor.md'), Date.parse(t3));
    assert.equal(firstPublication(st, 'rounds/0001-readded.md'), null);
    assert.equal(firstPublication(st, 'rounds/9999-missing.md'), null);
  } finally {
    process.env.PATH = prevPath;
  }
  const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
  assert.equal(calls.length, 1, `expected <= 1 git log subprocess, got ${calls.length}`);

  put('rounds/0003-late.md', '# late\n');
  git(r, 'add', '-A'); commitAt(t5, 'c5');
  assert.equal(firstPublication({ records: r, revision: 'HEAD' }, 'rounds/0003-late.md'), Date.parse(t5));
});
