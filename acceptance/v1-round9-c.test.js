import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { jsonOutput, output, put, status } from './fixture.mjs';
import { admission } from './round7-b-fixture.mjs';
import { acceptedPatch, refusedPatch, publish, rulings, sourceRuling } from './comment-contract-fixture.mjs';
import { assertRefused, edit, head, record, round6B, phase, next, prepare } from './round6-b-fixture.mjs';
import { seeded, seed } from './scenario.mjs';

const literal = () => Array.from({length: 1 + seeded(seed + 902)(32)}, (_, i) => `export const s${i} = ${JSON.stringify(`https://example.test/${i} /* literal payload */ # data`)};`).join('\n') + '\n';
const directive = '// @ts-check\nexport const result = 1;\n';
for (const [kind, source] of [['literal', literal], ['directive', () => directive]]) {
  test(`R9-C-${kind}-01 ordered · flow: actor hands off valid ${kind} data with a real prose comment and retries after deleting only prose · loss: false-verdict`, t => {
    const {w,p,prepared} = admission(t), file = 'src/result.mjs', valid = source();
    refusedPatch(w,p,prepared,{[file]: valid + '// Explain the published result.\n'}, [file, valid.split('\n').length, 'Explain the published result.']);
    acceptedPatch(w,p,prepared,{[file]:valid});
  });
  test(`R9-C-${kind}-02 ordered · flow: phase-close scan distinguishes ${kind} data from prose in the committed product · loss: false-verdict`, t => {
    const w = round6B(t), valid = source();
    const good = phase(w, 'good', {files:{'src/result.mjs':valid}});
    const bad = phase(w, 'bad', {files:{'src/result.mjs':valid + '// Explain the published result.\n'}});
    for (const p of [good,bad]) {
      const ledger=readFileSync(join(p.records,'metrics/handoffs.jsonl'),'utf8');
      const frame=JSON.parse(ledger.trim());
      const file='rounds/0001-reviewer-subtraction.md';
      put(p.records,file,'# R-0001-reviewer-subtraction\n');
      put(p.records,'metrics/handoffs.jsonl',ledger + JSON.stringify({...frame,id:'R-0001-reviewer-subtraction',step:'reviewer-subtraction',record:file,files:[file]})+'\n');
      w.commit(p.records,'Record completed subtraction review fixture');
    }
    const clear=next(w,good);
    assert.match(clear, /Prose comments at[^\n]*: 0 \(/i);
    assert.doesNotMatch(clear,/prose comment lines (remain|in the product tree)/);
    const pending = next(w,bad);
    assert.match(pending,/Prose comments not counted: pending independent comment resolution/);
    assert.doesNotMatch(pending,/Prose comments at[^\n]*: 0/);
    assert.match(pending,/unknown prose comment lines in the product tree/);
    publish(w,bad,rulings({'src/result.mjs':valid + '// Explain the published result.\n'},
      [['src/result.mjs',valid.split('\n').length,'Explain the published result.']]));
    const resolved = next(w,bad);
    assert.doesNotMatch(resolved,/pending independent comment resolution/);
    assert.match(resolved,/Prose comments at[^\n]*: 1 \(/i);
    assert.match(resolved,/1 prose comment lines remain/i);

  });
}

function evidence(root) {
  return readdirSync(root, {withFileTypes:true}).flatMap(e => e.isDirectory() ? evidence(join(root,e.name)) : e.name.endsWith('.json') ? [readFileSync(join(root,e.name),'utf8')] : []).join('\n');
}

test('R9-C-review-01 fresh · flow: actor hands off SQL whose comment reading depends on an unrecorded SQL dialect, then changes the source · loss: false-verdict', t => {
  const {w,p,prepared} = admission(t), file = 'src/query.sql';
  const sources = ["SELECT 'it\\'s -- data';\n", "SELECT 'it\\'s -- changed data';\n"];
  for (const source of sources) {
    edit(prepared, {[file]:source});
    const result = record(w,p,prepared);
    assert.notEqual(result.status, 0, 'An undecided dialect candidate was silently accepted: ' + output(result));
    assert.match(output(result), /independent|review|resolution/i);
    const saved = evidence(p.records);
    assert.ok(saved.includes(file), saved);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const blob = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
    assert.ok(saved.includes(sha256) || saved.includes(blob), 'No evidence binds the candidate to its exact source bytes');
    assert.match(saved, /D-0016/);
  }
});

test('R9-C-binding-01 fresh · flow: stale, local-scope and edited old outputs cannot approve a new dialect-ambiguous SQL revision; a fresh full-source judge can · loss: false-verdict', t => {
  const {w,p,prepared} = admission(t), path='src/value.sql', source="SELECT 'it\\'s -- data';\n";
  edit(prepared,{[path]:source});
  const pending = () => {
    const result=record(w,p,prepared);
    assert.equal(result.status,7,output(result));
    assert.match(output(result),/pending independent resolution/);
  };
  pending();
  const correct=sourceRuling(path,source,'sql');
  const first=publish(w,p,[{...correct,source:createHash('sha256').update(source+'\n').digest('hex')}]);
  pending();
  publish(w,p,[{...correct,scope:'comment',verdict:'literal'}]);
  pending();
  publish(w,p,[{...correct,path:'src/another.sql'}]);
  pending();
  const oldOutput=first.files.find(f=>f.endsWith('/out/comment-resolutions.json'));
  put(p.records,oldOutput,JSON.stringify([correct]));
  w.commit(p.records,'Edit old output without a new judge');
  pending();
  publish(w,p,[correct]);
  const final=jsonOutput(record(w,p,prepared));
  assert.equal(w.runGit(p.product,'show',`${final.product.commit}:${path}`).stdout,source);
});

for (const [kind,before,after,oldComments,newComments] of [
  ['code-only',"-- Legacy explanation.\nSELECT 'it\\'s -- v1';\n","-- Legacy explanation.\nSELECT 'it\\'s -- v2';\n",['Legacy explanation.'],['Legacy explanation.']],
  ['partial-deletion',"-- Legacy explanation.\n-- Removed explanation.\nSELECT 'it\\'s -- v1';\n","-- Legacy explanation.\nSELECT 'it\\'s -- v2';\n",['Legacy explanation.','Removed explanation.'],['Legacy explanation.']],
  ['duplicate',"-- Legacy explanation.\nSELECT 'it\\'s -- v1';\n","-- Legacy explanation.\n-- Legacy explanation.\nSELECT 'it\\'s -- v2';\n",['Legacy explanation.'],['Legacy explanation.','Legacy explanation.']],
]) test(`R9-C-legacy-${kind} fresh · flow: SQL legacy comments survive a ${kind} edit with complete independent inventories · loss: false-verdict`,t=>{
  const w=round6B(t),path='src/legacy.sql',p=phase(w,'legacy',{files:{[path]:before}});
  const prepared=prepare(w,p,'actor');
  edit(prepared,{[path]:after});
  assert.equal(record(w,p,prepared).status,7);
  publish(w,p,[sourceRuling(path,before,'sql',oldComments),sourceRuling(path,after,'sql',newComments)]);
  const result=record(w,p,prepared);
  if(kind==='duplicate') {
    assert.equal(result.status,7,output(result));
    assert.doesNotMatch(output(result),/pending independent resolution/);
    assert.match(output(result),/prose comment line/);
  } else {
    const h=jsonOutput(result);
    assert.equal(w.runGit(p.product,'show',`${h.product.commit}:${path}`).stdout,after);
  }
});

test('R9-C-fastpass-01 fresh · flow: D-0064 T10 deterministic 0-comment, pointer-only, and directive-only sources across all supported languages land via real call.mjs record with zero judge-comments calls · loss: stuck / false-verdict', t => {
  const {w,p,prepared} = admission(t);
  const files = {
    'src/app.ts': 'export type N = number;\nexport const f = (x: N): N => x + 1;\n',
    'src/view.tsx': 'export const Card = ({ title }: { title: string }) => <section>{title}</section>;\n',
    'src/tool.py': '# D-0016\nVALUE = "# not prose"\n',
    'src/App.swift': '// D-0064\nlet s = "// literal"\n',
    'src/cfg.yml': '# $schema: ./schema.json\nmode: fast\n',
    'src/run.sh': '#!/usr/bin/env bash\n# shellcheck disable=SC2086\necho "$1"\n',
    'src/style.css': '.card { content: "/* literal */"; }\n',
    'src/index.html': '<!doctype html><html><body><p>ok</p></body></html>\n',
    'src/main.go': 'package main\nfunc main() { _ = `// raw` }\n',
    'src/lib.rs': '// D-0064\npub fn id(x: i32) -> i32 { x }\n',
    'src/core.c': '// D-0064\nint add(int a, int b) { return a + b; }\n',
    'src/core.cpp': 'int n = 1\'000;\n',
    'src/App.java': '// D-0068\nclass App { int v = 1; }\n',
    'src/App.kt': '// ktlint-disable\nfun ok() = 1\n',
    'src/Cargo.toml': '[package]\nname = "demo"\n',
  };
  edit(prepared, files);
  const res = record(w, p, prepared);
  assert.equal(res.status, 0, output(res));
  const handoff = jsonOutput(res);
  assert.notEqual(handoff.product.commit, handoff.product.base);
  const rows = w.git(p.records, 'show', 'HEAD:metrics/handoffs.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.some(r => r.role === 'judge' || /judge-comments/.test(r.step)), false, 'no judge-comments call expected');
  for (const [file, text] of Object.entries(files)) {
    assert.equal(w.runGit(p.product, 'show', `${handoff.product.commit}:${file}`).stdout, text);
  }
});

test('R9-C-fastpass-02 fresh · flow: added prose in Go, C, C++, Rust, Java, and Kotlin refuses before commit with zero judge-comments calls · loss: false-verdict', t => {
  const {w,p,prepared} = admission(t);
  const cases = [
    ['src/main.go', 'package main\nfunc main() {}\n', '// Explain main entrypoint.\n'],
    ['src/core.c', 'int zero(void) { return 0; }\n', '/* Explain why zero returns 0. */\n'],
    ['src/core.cpp', 'int zero() { return 0; }\n', '// Explain zero helper.\n'],
    ['src/lib.rs', 'pub fn one() -> i32 { 1 }\n', '// Explain constant one.\n'],
    ['src/App.java', 'class App {}\n', '// Explain empty class.\n'],
    ['src/App.kt', 'fun one() = 1\n', '// Explain one return.\n'],
  ];
  const bad = Object.fromEntries(cases.map(([f, clean, prose]) => [f, clean + prose]));
  const diags = cases.map(([f, clean, prose]) => [f, clean.split('\n').length, prose.replace(/^(?:\/\/|\/\*)\s*|\s*\*\/\n$|\n$/g, '')]);
  const before = head(w, p);
  edit(prepared, bad);
  const badRes = record(w, p, prepared);
  status(badRes, 7);
  assert.match(output(badRes), /pending independent resolution \(comment\)/);
  assertRefused(w, p, prepared, badRes, diags);
  assert.equal(head(w, p), before);
  edit(prepared, Object.fromEntries(cases.map(([f, clean]) => [f, clean])));
  assert.equal(record(w, p, prepared).status, 0);
  const rows = w.git(p.records, 'show', 'HEAD:metrics/handoffs.jsonl').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.some(r => r.role === 'judge' || /judge-comments/.test(r.step)), false);
});
