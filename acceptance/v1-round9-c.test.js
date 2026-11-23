import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { jsonOutput, output, put } from './fixture.mjs';
import { admission } from './round7-b-fixture.mjs';
import { acceptedPatch, refusedPatch, publish, rulings, sourceRuling } from './comment-contract-fixture.mjs';
import { edit, record, round6B, phase, next, prepare } from './round6-b-fixture.mjs';
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

test('R9-C-binding-01 fresh · flow: stale, local-scope and edited old outputs cannot approve a new Python revision; a fresh full-source judge can · loss: false-verdict', t => {
  const {w,p,prepared} = admission(t), path='src/value.py', source='value = "# literal data"\n';
  edit(prepared,{[path]:source});
  const pending = () => {
    const result=record(w,p,prepared);
    assert.equal(result.status,7,output(result));
    assert.match(output(result),/pending independent resolution/);
  };
  pending();
  const correct=sourceRuling(path,source,'python');
  const first=publish(w,p,[{...correct,source:createHash('sha256').update(source+'\n').digest('hex')}]);
  pending();
  publish(w,p,[{...correct,scope:'comment',verdict:'literal'}]);
  pending();
  publish(w,p,[{...correct,path:'src/another.py'}]);
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
  ['code-only','# Legacy explanation.\nvalue = 1\n','# Legacy explanation.\nvalue = 2\n',['Legacy explanation.'],['Legacy explanation.']],
  ['partial-deletion','# Legacy explanation.\n# Removed explanation.\nvalue = 1\n','# Legacy explanation.\nvalue = 2\n',['Legacy explanation.','Removed explanation.'],['Legacy explanation.']],
  ['duplicate','# Legacy explanation.\nvalue = 1\n','# Legacy explanation.\n# Legacy explanation.\nvalue = 2\n',['Legacy explanation.'],['Legacy explanation.','Legacy explanation.']],
]) test(`R9-C-legacy-${kind} fresh · flow: Python legacy comments survive a ${kind} edit with complete independent inventories · loss: false-verdict`,t=>{
  const w=round6B(t),path='src/legacy.py',p=phase(w,'legacy',{files:{[path]:before}});
  const prepared=prepare(w,p,'actor');
  edit(prepared,{[path]:after});
  assert.equal(record(w,p,prepared).status,7);
  publish(w,p,[sourceRuling(path,before,'python',oldComments),sourceRuling(path,after,'python',newComments)]);
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
