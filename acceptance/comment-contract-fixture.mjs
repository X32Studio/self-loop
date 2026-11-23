import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { json, jsonOutput, output, put, status } from './fixture.mjs';
import { prepare, record, edit, head, assertRefused } from './round6-b-fixture.mjs';

export function sourceRuling(path, source, language, proseComments = []) {
  return {path, source: createHash('sha256').update(source).digest('hex'), line:1, rule:'D-0016',
    contract:'comment-admission-v2', scope:'source', language,
    text:`Full-source lexical coverage is not established for ${language}.`,
    verdict:proseComments.length ? 'prose' : 'compliant', ...(proseComments.length ? {proseComments} : {}),
    evidence:'Fixed acceptance scenario: whole frozen source reviewed under its stated language/tool facts; literals and consuming directives are data, listed explanatory comments are prose.'};
}

export function commentRuling(path, source, line, text) {
  return {...sourceRuling(path, source, 'js'), line, scope:'comment', text, verdict:'prose'};
}

export function publish(w,p,rows) {
  p.resolutionRound = (p.resolutionRound ?? 19) + 1;
  const judge = prepare(w,p,'judge',{round:p.resolutionRound});
  put(judge.ws,'out/comment-resolutions.json',json(rows));
  const result = jsonOutput(record(w,p,judge,'Independent fixture review of frozen sources. No convergence claim.\n'));
  assert.equal(result.role,'judge');
  assert.notEqual(result.agent.session, `${p.name}-R-0002-actor-fixture-child`);
  return result;
}

function language(path,source) {
  if (/\.[mc]?tsx?$|\.[mc]?jsx?$/.test(path) || /^#!.*\bnode\b/.test(source)) return 'js';
  if (/\.pyi?$/.test(path)) return 'python';
  if (/\.ya?ml$/.test(path)) return 'yaml';
  if (/\.swift$/.test(path)) return 'swift';
  if (/\.sql$/.test(path)) return 'sql';
  if (/\.css$/.test(path)) return 'css';
  if (/\.html?$/.test(path)) return 'html';
  if (/\.(sh|bash|zsh)$/.test(path) || /^#!/.test(source) || path.startsWith('.githooks/')) return 'shell';
  return null;
}

export function rulings(files,diagnostics = []) {
  return Object.entries(files).flatMap(([path,source]) => {
    if (source === null) return [];
    const lang = language(path,source);
    if (!lang) return [];
    const comments = diagnostics.filter(d=>d[0]===path);
    const rows = [sourceRuling(path,source,lang,comments.map(d=>d[2]))];
    for (const [,line,phrase] of comments) {
      const text = source.split('\n')[line-1].trim().replace(/^.*\/\/+\s*/, '').replace(/^\s*\*\s*/, '').replace(/\s*\*\/$/,'').trim();
      rows.push(commentRuling(path,source,line,text.includes(phrase) ? text : phrase));
    }
    return rows;
  });
}

export function resolvedRecord(w,p,prepared,files,diagnostics=[],legacy={},refusal=false) {
  const first = record(w,p,prepared);
  if (first.status === 0) {
    assert.equal(refusal,false,'Prohibited prose passed before independent review');
    return first;
  }
  status(first,7);
  assert.match(output(first),/pending independent resolution/);
  if (!refusal) for (const [path,source] of Object.entries(files)) {
    if (source !== null && language(path,source) === 'js' && !/\.[mc]?tsx?$/.test(path) && !legacy[path])
      assert.ok(!output(first).includes(`${path}:`), `Established valid ECMAScript must remain automatic: ${output(first)}`);
  }
  const rows = rulings(files,diagnostics);
  for (const [path,comments] of Object.entries(legacy)) {
    const before = w.runGit(p.product,'show',`${prepared.base ?? p.initial}:${path}`).stdout;
    rows.push(...rulings({[path]:before},comments.map(([line,text])=>[path,line,text])));
    const after = files[path];
    if (after && language(path,after) === 'js') {
      for (const [,text] of comments) for (const [i,line] of after.split('\n').entries())
        if (line.trim().endsWith('// ' + text) || line.trim() === '// ' + text)
          rows.push(commentRuling(path,after,i+1,text));
    }
  }
  publish(w,p,rows);
  for (const [path,source] of Object.entries(files)) if (source !== null)
    assert.equal(readFileSync(join(prepared.wt,path),'utf8'),source,'review must retry the identical source');
  return record(w,p,prepared);
}

export function acceptedPatch(w,p,prepared,files,diagnostics=[],legacy={}) {
  edit(prepared,files);
  const result = jsonOutput(resolvedRecord(w,p,prepared,files,diagnostics,legacy));
  assert.notEqual(result.product.commit,result.product.base);
  for (const [path,source] of Object.entries(files)) {
    if (source === null) assert.equal(w.git(p.product,'ls-tree','--name-only',result.product.commit,'--',path),'');
    else assert.equal(w.runGit(p.product,'show',`${result.product.commit}:${path}`).stdout,source);
  }
}

export function refusedPatch(w,p,prepared,files,diagnostic,legacy={}) {
  const before = head(w,p);
  edit(prepared,files);
  const diagnostics = Array.isArray(diagnostic[0]) ? diagnostic : [diagnostic];
  const result = resolvedRecord(w,p,prepared,files,diagnostics,legacy,true);
  status(result,7);
  assert.doesNotMatch(output(result),/pending independent resolution/);
  const expected = diagnostics.map(([path,line,phrase])=> {
    const lang = language(path,files[path]);
    return lang !== 'js' || /\.[mc]?tsx?$/.test(path) ? [path,1,`Full-source lexical coverage is not established for ${lang}.`] : [path,line,phrase];
  });
  assertRefused(w,p,prepared,result,expected);
  assert.equal(head(w,p),before);
}
