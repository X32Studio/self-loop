import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { json, jsonl, jsonOutput, output, put, status, world, writeGh } from './fixture.mjs';
import { pushWorld } from './r6-push-fixture.mjs';
import { round6B, phase, next, greenCheck } from './round6-b-fixture.mjs';
import { seed, seeded } from './scenario.mjs';

const split = x => (x ?? '').split(',').filter(v => v && v !== '-').sort();
function dispositionWorld(t) {
  const w = round6B(t), p = phase(w);
  writeGh(w, { [p.initial]: [greenCheck] });
  const file = join(p.records, 'metrics/trajectory.jsonl');
  put(p.records, 'metrics/trajectory.jsonl', '');
  const ruling = (n, body, suffix = '') => {
    const name = `${String(n).padStart(4, '0')}-judge${suffix}`;
    put(p.records, `rounds/${name}.md`, `# R-${name}\n\nphase: v1\nrole: judge\nproduct: ${p.initial}\n\n## Public report\n\nVERDICT: CONTINUE\n${body}\n`);
    w.commit(p.records, `Record ${name}`);
  };
  const append = (n, flags = []) => w.run('trajectory.mjs', ['append', '--file', file, '--round', String(n), '--phase', 'v1', '--role', 'judge', '--commit', p.initial, '--verdict', 'CONTINUE', '--area', 'delivery', ...flags]);
  const alarms = () => jsonOutput(w.run('trajectory.mjs', ['alarms', '--file', file, '--json']));
  return { w, p, file, ruling, append, alarms };
}

test('R9-B1-01 ordered · flow: lead appends a structured ruling without transcribing its keys, then reads next and alarms · loss: wrong-result', t => {
  const f = dispositionWorld(t);
  const draw = seeded(seed + 901), count = 3 + draw(8);
  const keys = Array.from({length: count}, (_, i) => `delivery:R2-${i + 1}`);
  f.ruling(2, `OPENED: ${keys.join(', ')}\nCLOSED: -\nSHELVED: -\nCARRIED: -\n` + keys.map(k => `\n### ${k}\nflow: Lead publishes the reviewed artifact.\nloss: wrong-result. Wrong artifact published.\n`).join(''));
  const row = jsonOutput(f.append(2));
  assert.deepEqual(split(row.opened), keys.sort());
  assert.equal(f.alarms().find(a => a.key === 'blocker-recurring:delivery')?.count, count);
  f.w.commit(f.p.records, 'Publish appended opened blockers');
  const shown = next(f.w, f.p);
  for (const k of keys) assert.ok(shown.includes(k), shown);
  f.ruling(3, `OPENED: -\nCLOSED: ${keys.join(', ')}\nSHELVED: -\nCARRIED: -`);
  assert.deepEqual(split(jsonOutput(f.append(3)).closed), keys.sort());
  assert.equal(f.alarms().filter(a => a.type === 'partly-closed').length, 0);
  f.w.commit(f.p.records, 'Publish appended closures');
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*delivery:R2-/i);
});

test('R9-B1-02 ordered · flow: historical ruling flags preserve full identifiers and refuse a truncated key before writing · loss: wrong-result', t => {
  const f = dispositionWorld(t);
  const key = 'release:R9-1:part';
  f.ruling(9, `### ${key}\nflow: Lead releases an artifact.\nloss: wrong-result. Wrong artifact.`);
  const before = readFileSync(f.file, 'utf8');
  const refused = f.append(9, ['--opened', 'release:R9-1']);
  status(refused, 2);
  assert.equal(readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(split(jsonOutput(f.append(9, ['--opened', key])).opened), [key]);
});

// D-0024 item 2; R-0008-judge-frame, Transcription premise.
test('R9-B1-03 ordered · flow: carried blockers stay visible until closed without generating recurrence or partly-closed counts · loss: false-verdict', t => {
  const f = dispositionWorld(t), draw = seeded(seed + 903);
  const keys = Array.from({length: 2 + draw(7)}, (_, i) => `release:R1-${i + 1}`);
  put(f.p.records, 'metrics/trajectory.jsonl', jsonl({round: 1, phase: 'v1', role:'judge', verdict:'CONTINUE', area:'delivery', opened:'-', closed:'-', carried:keys.join(','), ci:'success', commit:f.p.initial}));
  for (const round of [2, 3]) {
    jsonOutput(f.append(round));
    f.w.commit(f.p.records, `Publish carried blockers through round ${round}`);
    const shown = next(f.w, f.p);
    for (const key of keys) assert.ok(shown.includes(key), shown);
    assert.deepEqual(f.alarms().filter(a => ['partly-closed', 'blocker-recurring'].includes(a.type)), []);
  }
  jsonOutput(f.append(4, ['--closed', keys.join(',')]));
  f.w.commit(f.p.records, 'Publish explicit closure');
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*release:R1-/i);
  assert.deepEqual(f.alarms().filter(a => ['partly-closed', 'blocker-recurring'].includes(a.type)), []);
});

// D-0024 items 1–2; SKILL.md, Screening.
test('R9-B1-06 ordered · flow: repeated reviews with carried and newly opened blockers alarm only on new openings while next retains both · loss: false-verdict', t => {
  const f = dispositionWorld(t), carried = 'release:R0-1';
  const draw = seeded(seed + 906);
  const opened = Array.from({length: 2 + draw(7)}, (_, i) => `release:R1-${i + 1}`);
  f.ruling(1, `OPENED: ${opened.join(', ')}\nCLOSED: -\nSHELVED: -\nCARRIED: ${carried}\n` + opened.map(key => `\n### ${key}\nflow: Lead publishes the reviewed artifact.\nloss: wrong-result. Wrong artifact published.\n`).join(''));
  jsonOutput(f.append(1));
  for (const round of [2, 3]) {
    jsonOutput(f.append(round));
    f.w.commit(f.p.records, `Publish mixed blockers through round ${round}`);
    const shown = next(f.w, f.p);
    for (const key of [carried, ...opened]) assert.ok(shown.includes(key), shown);
    const alarms = f.alarms();
    const recurring = alarms.find(a => a.key === 'blocker-recurring:release');
    assert.equal(recurring?.count, opened.length);
    assert.deepEqual(recurring.evidence.blockers.slice().sort(), opened.slice().sort());
    const partial = alarms.find(a => a.type === 'partly-closed' && a.at === round);
    assert.equal(partial?.count, opened.length);
    assert.deepEqual(partial.evidence.stillOpen.slice().sort(), opened.slice().sort());
  }
  jsonOutput(f.append(4, ['--closed', opened.join(',')]));
  f.w.commit(f.p.records, 'Close new openings while retaining carry');
  assert.ok(next(f.w, f.p).includes(carried));
  assert.doesNotMatch(next(f.w, f.p), /open blockers?:[^\n]*release:R1-/i);
  assert.equal(f.alarms().filter(a => a.type === 'partly-closed' && a.at === 4).length, 0);
});

for (const missing of [true, false]) test(`R9-B2-${missing ? '01' : '02'} ordered · flow: maintainer promotes with ${missing ? 'a historical tree-less' : 'an exact tree'} suite receipt · loss: false-verdict`, t => {
  const p = pushWorld(t);
  if (missing) {
    const receipt = JSON.parse(readFileSync(p.receipt, 'utf8'));
    delete receipt.tree;
    const old = put(p.w.dir, 'historical-receipt.json', json(receipt));
    const before = p.snapshot();
    status(p.promote([], {suiteReceipt: old}), 2);
    assert.deepEqual(p.snapshot(), before);
  }
  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

for (const launcher of [true, false]) test(`R9-B3-${launcher ? '01' : '02'} ordered · flow: same-tree suite ${launcher ? 'launcher selects its runtime from external state' : 'direct node run has an established unchanged runtime'} · loss: false-verdict`, t => {
  const w = world(t), log = join(w.dir, 'executions');
  const selected = put(w.dir, 'selected.cjs', '');
  const repo = w.repo(join(w.dir, 'runtime'), {
    'probe.test.mjs': `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {appendFileSync} from 'node:fs';\ntest('runtime', () => {appendFileSync(${JSON.stringify(log)}, process.version+'\\n'); assert.equal(process.version, ${JSON.stringify(process.version)});});\n`,
    'launch.sh': `exec node --require ${JSON.stringify(selected)} --test probe.test.mjs\n`
  });
  const run = () => w.run(['--repo', repo, '--sha', 'HEAD', '--command', launcher ? 'sh launch.sh' : 'node --test probe.test.mjs', '--format', 'node-test'], {entry:'suite-green.mjs', extraEnv:{NODE_OPTIONS:''}});
  assert.equal(jsonOutput(run()).green, true);
  if (launcher) {
    put(w.dir, 'selected.cjs', "Object.defineProperty(process, 'version', {value:'v26.0.0'});\n");
    const result = jsonOutput(run(), 2);
    assert.equal(result.green, false);
    assert.equal(result.reusedFrom, undefined);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
  } else {
    assert.ok(jsonOutput(run()).reusedFrom);
    assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  }
});

for (const [i, spelling] of ['https://github.com:443/', 'ssh://git@github.com:22/', 'https://GITHUB.COM/'].entries()) test(`R9-B4-0${i+1} ordered · flow: CI gate reads a semantically equivalent supported destination then a different host · loss: false-verdict`, t => {
  const p = pushWorld(t);
  const set = url => p.w.git(p.product, 'remote', 'set-url', '--push', p.close.remote, url);
  status(p.diagnose(), 0);
  set(`${spelling}${p.first.slug}.git`);
  const receipt = jsonOutput(p.diagnose());
  assert.equal(receipt.host, 'github.com');
  assert.equal(receipt.repository, p.first.slug);
  set(`https://different.example:443/${p.first.slug}.git`);
  status(p.diagnose(), 2);
});

test('R9-B1-04 fresh · flow: a round has two structured judge reports and a retry must choose the same one without merging their keys · loss: wrong-result', t => {
  const f = dispositionWorld(t);
  for (const [suffix, key] of [['', 'release:R4-main'], ['-followup', 'release:R4-followup']])
    f.ruling(4, `OPENED: ${key}\nCLOSED: -\nSHELVED: -\nCARRIED: -\n\n### ${key}\nflow: Lead publishes a release.\nloss: wrong-result. Wrong artifact.`, suffix);
  const first = jsonOutput(f.append(4));
  const keys = split(first.opened);
  assert.equal(keys.length, 1, json(first));
  assert.ok(['release:R4-main','release:R4-followup'].includes(keys[0]));
  const again = jsonOutput(f.append(4));
  assert.deepEqual(split(again.opened), keys);
});

test('R9-B1-05 ordered · flow: a legacy carried and closed row stays closed in next and produces no partial-closure alarm · loss: false-verdict', t => {
  const f = dispositionWorld(t), key = 'release:R1-1';
  put(f.p.records, 'metrics/trajectory.jsonl', jsonl({round:1, phase:'v1', role:'judge', verdict:'CONTINUE', area:'delivery', opened:'-', closed:key, carried:key, ci:'success', commit:f.p.initial}));
  jsonOutput(f.append(2));
  assert.equal(f.alarms().filter(a => a.type === 'partly-closed').length, 0);
  assert.doesNotMatch(next(f.w,f.p), /open blockers?:[^\n]*release:R1-1/i);
});
