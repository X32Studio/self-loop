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

export function commentRuling(path, source, line, text, lang = language(path, source)) {
  return {...sourceRuling(path, source, lang), line, scope:'comment', text, verdict:'prose'};
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
  if (/\.[mc]?[tj]sx?$/i.test(path) || /^#!.*\b(?:node|nodejs|deno|bun)\b/.test(source)) return 'js';
  if (/\.pyi?$/i.test(path) || /^#!.*\bpython[\d.]*/.test(source)) return 'python';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  if (/\.swift$/i.test(path)) return 'swift';
  if (/\.sql$/i.test(path)) return 'sql';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.(?:sh|bash|zsh|ksh)$/i.test(path) || /^#!.*\b(?:sh|bash|zsh|dash|ksh)\b/.test(source) || /(?:^|\/)\.githooks\/[^/]+$/.test(path)) return 'shell';
  if (/\.go$/i.test(path)) return 'go';
  if (/\.rs$/i.test(path)) return 'rust';
  if (/\.(?:c|h)$/i.test(path)) return 'c';
  if (/\.(?:cc|cpp|cxx|hpp)$/i.test(path)) return 'cpp';
  if (/\.java$/i.test(path)) return 'java';
  if (/\.kts?$/i.test(path)) return 'kotlin';
  if (/\.toml$/i.test(path)) return 'toml';
  return null;
}

const stripMarker = raw => raw.trim()
  .replace(/^(?:.*\/\/+\s*|\/\*+(?:\s*\*)*\s*|\*\s*(?!\/)|#+\s*|--+\s*|<!--\s*)/, '')
  .replace(/\s*(?:\*+\/|-->)$/, '')
  .trim();

const pendingCommentsOf = text => {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^  (.+?):(\d+): pending independent resolution \(comment\); source sha256 [0-9a-f]{64}; rule D-0016; (.*)$/.exec(line);
    if (m) map.set(`${m[1]}:${m[2]}`, m[3]);
  }
  return map;
};

export function rulings(files,diagnostics = [],pendingText = '') {
  const pending = pendingText ? pendingCommentsOf(pendingText) : new Map();
  return Object.entries(files).flatMap(([path,source]) => {
    if (source === null) return [];
    const lang = language(path,source);
    if (!lang) return [];
    const comments = diagnostics.filter(d=>d[0]===path);
    const rows = lang === 'sql' || source.includes('\0') ? [sourceRuling(path,source,lang,comments.map(d=>d[2]))] : [];
    const seenLines = new Set();
    for (const [,line,phrase] of comments) {
      seenLines.add(line);
      const candidate = pending.get(`${path}:${line}`);
      const stripped = stripMarker(source.split('\n')[line-1] ?? '');
      rows.push(commentRuling(path,source,line,candidate ?? (stripped.includes(phrase) ? stripped : phrase),lang));
    }
    for (const [key, candidate] of pending) {
      const [pPath, pLine] = [key.slice(0, key.lastIndexOf(':')), Number(key.slice(key.lastIndexOf(':') + 1))];
      if (pPath === path && !seenLines.has(pLine)) rows.push(commentRuling(path,source,pLine,candidate,lang));
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
  if (!refusal && !Object.keys(legacy).length) {
    const needsReview = Object.entries(files).some(([path,source]) => source !== null && (language(path,source) === 'sql' || source.includes('\0')));
    assert.equal(needsReview,true,`Supported deterministic language must pass on first record(): ${output(first)}`);
  }
  status(first,7);
  assert.match(output(first),/pending independent resolution/);
  const out = output(first);
  const rows = rulings(files,diagnostics,out);
  const pending = pendingCommentsOf(out);
  for (const [path,comments] of Object.entries(legacy)) {
    const before = w.runGit(p.product,'show',`${prepared.base ?? p.initial}:${path}`).stdout;
    rows.push(...rulings({[path]:before},comments.map(([line,text])=>[path,line,text])));
    const after = files[path];
    const lang = after ? language(path,after) : null;
    if (after && lang) {
      for (const [,text] of comments) for (const [i,line] of after.split('\n').entries())
        if (stripMarker(line) === text || pending.get(`${path}:${i+1}`) === text)
          rows.push(commentRuling(path,after,i+1,text,lang));
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
  assertRefused(w,p,prepared,result,diagnostics);
  assert.equal(head(w,p),before);
}
