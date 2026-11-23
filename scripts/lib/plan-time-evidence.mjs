// F-0012; design/time-model.md; cc91f1d admitted positive evidence A1–A5.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, normalize, dirname, basename } from 'node:path';
import { parsePlan, validatePlan } from './plan.mjs';
import { gunzipSync } from 'node:zlib';
import { ciWord } from './check-runs.mjs';
import { AWS_ACCOUNT_RE, isCodeCommitHost } from './ci-destination.mjs';
import { validateHandoff } from './handoff.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const BINDING = /^evidence\/\d{4}\/time-binding\/TB-([a-f0-9]{64})\.json$/;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
const identity = ref => JSON.stringify([ref?.repository, ref?.path, ref?.sha256]);
const equal = (a, b) => canonical(a) === canonical(b);
const utc = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
const need = (condition, message) => { if (!condition) throw new Error(message); };
const publicPath = p => typeof p === 'string' && !p.split('/').some(s => !s || s === '.' || s === '..' || /private|sealed|auth|transcript|session/i.test(s)) && !/\.(gz|log)$/.test(p) && (/^(plans|forecasts|decisions|purpose|blueprint|rounds|reviews|design|docs|evidence)\//.test(p) || /^metrics\/(handoffs|trajectory|blueprint)\.jsonl$/.test(p));
const authorityPath = p => /^(decisions\/D|purpose\/P|delegations\/T)-\d{4}\.md$/.test(p ?? '');

export function canonical(value) {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') { need(Number.isFinite(value), 'non-finite JSON number'); return JSON.stringify(value); }
  if (typeof value === 'string') { need(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value), 'unpaired Unicode surrogate'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  need(object(value), 'non-JSON value');
  return `{${Object.keys(value).sort().map(k => `${canonical(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function parseExactJSON(bytes) {
  const s = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let i = 0;
  const ws = () => { while (/[\x20\t\r\n]/.test(s[i] ?? '\0')) i++; };
  function string() {
    const start = i++;
    for (;;) {
      need(i < s.length, 'unterminated JSON string');
      const c = s[i++];
      if (c === '\\') { i++; continue; }
      if (c === '"') break;
    }
    const v = JSON.parse(s.slice(start, i)); canonical(v); return v;
  }
  function value() {
    ws(); const c = s[i];
    if (c === '"') return string();
    if (c === '{') {
      i++; ws(); const out = Object.create(null), keys = new Set();
      if (s[i] === '}') { i++; return out; }
      for (;;) {
        need(s[i] === '"', 'JSON object key required'); const k = string();
        need(!keys.has(k), `duplicate JSON key: ${k}`); keys.add(k);
        ws(); need(s[i++] === ':', 'JSON colon required'); out[k] = value(); ws();
        if (s[i] === '}') { i++; return out; }
        need(s[i++] === ',', 'JSON comma required'); ws();
      }
    }
    if (c === '[') {
      i++; ws(); const out = []; if (s[i] === ']') { i++; return out; }
      for (;;) { out.push(value()); ws(); if (s[i] === ']') { i++; return out; } need(s[i++] === ',', 'JSON comma required'); }
    }
    const m = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
    need(m, 'invalid JSON value'); i += m[0].length; const v = JSON.parse(m[0]); canonical(v); return v;
  }
  const result = value(); ws(); need(i === s.length, 'trailing JSON bytes'); return result;
}

export function selectFragment(bytes, selector) {
  need(typeof selector === 'string', 'missing exact selector');
  const source = Buffer.isBuffer(bytes) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : bytes;
  if (selector === '' || selector.startsWith('/')) {
    let value = parseExactJSON(source);
    if (selector) for (const part of selector.slice(1).split('/')) {
      need(!/~(?:[^01]|$)/.test(part), 'invalid JSON pointer escape');
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      need(value !== null && typeof value === 'object' && Object.hasOwn(value, key) && (!Array.isArray(value) || /^(0|[1-9]\d*)$/.test(key)), 'missing JSON pointer'); value = value[key];
    }
    return typeof value === 'string' ? value : canonical(value);
  }
  const lines = source.split(/\r?\n/), headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1]; else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return; }
    if (!fence && /^#{1,6}\s+/.test(line)) headings.push({ line, index, depth: /^#+/.exec(line)[0].length });
  });
  const matches = headings.filter(h => h.line === selector);
  need(matches.length === 1, 'missing or ambiguous heading');
  const h = matches[0], end = headings.find(n => n.index > h.index && n.depth <= h.depth)?.index ?? lines.length;
  return lines.slice(h.index + 1, end).join('\n');
}

function git(repo, ...args) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_GRAFT_FILE: '/dev/null' };
  for (const k of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|SHALLOW_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(k)) delete env[k];
  return execFileSync('git', ['--no-replace-objects', '-C', repo, ...args], { env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function ancestor(repo, a, b) { try { need(SHA.test(a) && SHA.test(b), 'non-pinned ancestry'); git(repo, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } }
function reader(records, revision) {
  need(isAbsolute(records ?? '') && realpathSync(records) === records && SHA.test(revision ?? ''), 'pinned canonical snapshot required');
  const cuts = new Map();
  function cut(repository, commit) {
    const key = `${repository}\0${commit}`;
    if (cuts.has(key)) return cuts.get(key);
    need(SHA.test(commit), 'full commit required');
    need(git(repository, 'rev-parse', `${commit}^{commit}`).toString().trim() === commit, 'not a commit');
    const files = new Map(git(repository, 'ls-tree', '-r', '-z', '--full-tree', commit).toString().split('\0').filter(Boolean).flatMap(line => {
      const [meta, path] = line.split('\t'), [mode, type, oid] = meta.split(' ');
      return type === 'blob' && /^(100644|100755)$/.test(mode) ? [[path, oid]] : [];
    }));
    const bytes = path => { need(files.has(path), `missing regular blob: ${path}`); return git(repository, 'cat-file', 'blob', files.get(path)); };
    const result = { records: repository, revision: commit, files, bytes, read: path => bytes(path).toString('utf8') }; cuts.set(key, result); return result;
  }
  const q = cut(records, revision);
  function ref(ref, kind = 'public', at = null) {
    need(object(ref) && isAbsolute(ref.repository ?? '') && realpathSync(ref.repository) === ref.repository && SHA.test(ref.commit ?? '') && HASH.test(ref.sha256 ?? ''), 'invalid pinned Ref');
    need(kind === 'authority' ? authorityPath(ref.path) : kind === 'policy' ? authorityPath(ref.path) || ref.path === 'loop.json' : publicPath(ref.path), 'non-public/disallowed Ref path');
    if (ref.repository === records) need(ancestor(records, ref.commit, revision), 'Ref outside query ancestry');
    const state = cut(ref.repository, ref.commit), bytes = state.bytes(ref.path);
    need(hash(bytes) === ref.sha256, 'Ref hash mismatch');
    if (at && ref.repository === records) { need(ancestor(records, ref.commit, at), 'operand Ref newer than basedOn'); need(hash(cut(records, at).bytes(ref.path)) === ref.sha256, 'operand missing or changed at basedOn'); }
    if (/\.jsonl$/.test(ref.path)) bytes.toString().split('\n').filter(Boolean).forEach(parseExactJSON);
    else if (/\.json$/.test(ref.path) || /^[\s]*[\[{]/.test(bytes.toString())) parseExactJSON(bytes);
    return bytes;
  }
  return { q, cut, ref };
}

function scan(r, findings) {
  const repo = r.q.records, q = r.q.revision, seen = new Map(), bindings = [];
  const shallow = git(repo, 'rev-parse', '--is-shallow-repository').toString().trim() === 'true';
  if (shallow) findings.push('history-incomplete: shallow repository');
  const commits = git(repo, 'rev-list', '--reverse', '--topo-order', q).toString().trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const state = r.cut(repo, commit);
    for (const path of state.files.keys()) {
      if (!/^evidence\/[^/]+\/time-binding\//.test(path)) continue;
      const bytes = state.bytes(path), digest = hash(bytes), prior = seen.get(path);
      if (prior) { if (prior.digest !== digest) prior.problems.add('history-incomplete: modified binding'); continue; }
      const row = { ref: { repository: repo, commit, path, sha256: digest }, first: commit, digest, problems: new Set(shallow ? ['history-incomplete: shallow repository'] : []) };
      seen.set(path, row); bindings.push(row);
      try {
        need(BINDING.exec(path)?.[1] === digest, 'invalid binding filename digest');
        row.value = parseExactJSON(bytes);
        need(row.value.schema === 'plan-time-binding/v1' && ['scope', 'release', 'event'].includes(row.value.type), 'invalid binding schema');
      } catch (e) { row.problems.add(e.message); }
    }
    for (const [path, row] of seen) if (ancestor(repo, row.first, commit) && !state.files.has(path)) row.problems.add('history-incomplete: deleted binding');
  }
  return bindings;
}

function observationsAt(r, root, findings) {
  const seen = new Map();
  for (const commit of git(r.q.records, 'rev-list', '--reverse', '--topo-order', r.q.revision).toString().trim().split('\n').filter(Boolean)) {
    const cut = r.cut(r.q.records,commit);
    for (const path of cut.files.keys()) {
      if (!path.startsWith('forecasts/')) continue;
      const bytes=cut.bytes(path), digest=hash(bytes), prior=seen.get(path);
      if (prior) { if (digest !== prior.ref.sha256) prior.errors.push('modified forecast'); continue; }
      try {
        need(/^forecasts\/FO-([a-f0-9]{64})\.json$/.exec(path)?.[1] === digest,'forecast filename digest mismatch');
        const o=parseExactJSON(bytes);
        if (o.rootRef?.path !== `plans/${root}.md`) continue;
        const entry={...o,ref:{repository:r.q.records,commit,path,sha256:digest},publicationCommit:commit,errors:[]}; seen.set(path,entry);
        try {
          need(o.schema === 'plan-forecast/v1' && object(o.outlook) && object(o.estimates),'invalid forecast');
          need(SHA.test(o.outlook.basedOn ?? '') && ancestor(r.q.records,o.outlook.basedOn,commit),'invalid forecast basedOn');
          r.ref(o.rootRef,'public',o.outlook.basedOn);r.ref(o.planRef,'public',o.outlook.basedOn);
          const x=o.outlook, asOf=utc(x.asOf), observed=utc(x.observation?.observedAt), recorded=utc(x.observation?.recordedAt), checkpoint=utc(x.checkpointAt);
          need([asOf,observed,recorded,checkpoint].every(v=>v!==null) && observed<=recorded && asOf<=recorded && checkpoint>asOf,'invalid forecast times');
          requiredRefs(x.observation.evidenceRefs,r,'public',x.basedOn);requiredRefs(x.inputs,r,'public',x.basedOn);
          need(Array.isArray(o.parents) && Array.isArray(o.promisesAdded),'invalid forecast history lists');
          for (const ref of o.parents) r.ref(ref,'public',x.basedOn);
          const prior=[...seen.values()].filter(p=>p!==entry && ancestor(r.q.records,p.publicationCommit,x.basedOn));
          const heads=prior.filter(p=>!prior.some(n=>(n.parents??[]).some(ref=>identity(ref)===identity(p.ref))));
          need(equal(heads.map(p=>identity(p.ref)).sort(),o.parents.map(identity).sort()),'forecast parent history incomplete');
        } catch(e) { entry.errors.push(e.message); }
      } catch(e) { findings.push(`history-incomplete: ${path}: ${e.message}`); }
    }
    for (const [path,o] of seen) if (ancestor(r.q.records,o.publicationCommit,commit) && !cut.files.has(path)) o.errors.push('deleted forecast');
  }
  return [...seen.values()];
}

function wholeToken(fragment, token) {
  if (!text(token)) return false;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_-])${escaped}(?![\\p{L}\\p{N}\\p{M}_-])`, 'u').test(fragment);
}
function claimDigest(b) { return hash(canonical({ type: b.type, rootRef: b.rootRef, planRef: b.planRef, basedOn: b.basedOn, claim: b.claim })); }
function requiredRefs(list, r, kind = 'public', at = null) {
  need(Array.isArray(list) && list.length > 0, 'nonempty evidence refs required');
  return list.map(ref => r.ref(ref, kind, at));
}
function packageClosure(plan, ids) {
  const packages = new Map((plan.packages ?? []).map(p => [p.id, p]));
  need(Array.isArray(ids) && ids.length && ids.every(text) && new Set(ids).size === ids.length, 'invalid package list');
  const done = new Set(), active = new Set();
  function walk(id) {
    if (done.has(id)) return;
    need(!active.has(id) && packages.has(id), 'missing dependency or cycle'); active.add(id);
    const p = packages.get(id); need(Array.isArray(p.needs), 'missing package dependencies');
    p.needs.forEach(walk); active.delete(id); done.add(id);
  }
  ids.forEach(walk); return done;
}
function scopeClaim(row, r, observations) {
  const b = row.value, c = b.claim, cut = r.cut(r.q.records, b.basedOn);
  need(object(c) && Array.isArray(c.criteria) && c.criteria.length && Array.isArray(c.deferred), 'invalid scope claim');
  const plan = parsePlan(r.ref(b.planRef, 'public', b.basedOn).toString());
  need(!validatePlan(plan, { ...cut, files: new Set(cut.files.keys()) }).length, 'invalid execution plan/contract');
  const root = parsePlan(r.ref(b.rootRef, 'public', b.basedOn).toString());
  need(root.id === root.time?.rootPlan && root.scope === plan.scope && root.phase === plan.phase, 'invalid baseline root');
  need(!git(r.q.records,'log','--format=%H','--diff-filter=MDT',r.q.revision,'--',b.rootRef.path).toString().trim(), 'immutable baseline modified or deleted');
  const baseline = root.time?.baseline;
  need(object(baseline?.minimum) && Array.isArray(baseline.minimum.criteriaRefs) && baseline.minimum.criteriaRefs.length, 'minimum criteria unavailable');
  const close = ids => packageClosure(plan, ids);
  const closure = close(c.releasePackages), required = new Set(), criteriaKeys = new Set();
  const promises = [...(baseline.promises ?? []), ...observations.filter(o => identity(o.rootRef) === identity(b.rootRef)).flatMap(o => o.promisesAdded ?? [])];
  for (const criterion of c.criteria) {
    need(['minimum','promise'].includes(criterion.purpose), 'invalid criterion purpose');
    need(criterion.purpose === 'minimum' ? criterion.promiseId === null : text(criterion.promiseId), 'invalid promise criterion');
    const known = criterion.purpose === 'minimum' ? baseline.minimum.criteriaRefs : promises.find(p => p.id === criterion.promiseId)?.criteriaRefs;
    need(known?.some(ref => identity(ref) === identity(criterion.ref)), 'criterion outside immutable baseline/promise');
    const key = canonical([identity(criterion.ref), criterion.selector, criterion.purpose, criterion.promiseId]);
    need(!criteriaKeys.has(key), 'duplicate criterion'); criteriaKeys.add(key);
    selectFragment(r.ref(criterion.ref, 'public', b.basedOn), criterion.selector);
    for (const id of close(criterion.packages)) { required.add(id); need(closure.has(id), 'required criterion not covered by release closure'); }
  }
  for (const ref of baseline.minimum.criteriaRefs) need(c.criteria.some(x => x.purpose === 'minimum' && identity(x.ref) === identity(ref)), 'minimum criterion missing');
  const deferred = new Set();
  for (const d of c.deferred) {
    need(text(d.package) && text(d.reason) && plan.packages.some(p => p.id === d.package) && !deferred.has(d.package) && !required.has(d.package) && !closure.has(d.package), 'required or invalid deferral');
    const fragment = selectFragment(r.ref(d.authorityRef, 'authority', b.basedOn), d.selector);
    need(wholeToken(fragment, d.package) && /\boptional\b/i.test(fragment), 'optional package authority absent'); deferred.add(d.package);
  }
  requiredRefs(c.gatePolicyRefs, r, 'policy', b.basedOn);
  return { criteria: c.criteria, releasePackages: c.releasePackages, closure: [...closure], deferred: [...deferred], policies: c.gatePolicyRefs, plan, cut };
}
function forecastScopeProblems(o, scope) {
  const findings = [];
  try {
    const actual = packageClosure(scope.plan, o.outlook?.releasePackages);
    for (const id of scope.closure) if (!actual.has(id)) findings.push(`forecast omits approved release closure package: ${id}`);
    for (const id of actual) if (!scope.closure.includes(id)) findings.push(`forecast includes unapproved release closure package: ${id}`);
    const deferred = o.outlook?.change?.deferredPackages;
    need(Array.isArray(deferred) && deferred.every(text) && new Set(deferred).size === deferred.length, 'invalid forecast deferred packages');
    for (const id of deferred) {
      if (actual.has(id) || scope.closure.includes(id)) findings.push(`forecast defers release closure package: ${id}`);
      if (!scope.deferred.includes(id)) findings.push(`forecast deferral lacks scope authorization: ${id}`);
    }
  } catch (e) { findings.push(e.message); }
  return findings;
}
export function versionOnly(repo, from, to) {
  if (!ancestor(repo, from, to)) return false;
  let at = to;
  while (at !== from) {
    const parents = git(repo, 'rev-list', '--parents', '-n', '1', at).toString().trim().split(' ').slice(1);
    if (parents.length !== 1) return false;
    at = parents[0];
  }
  if (from === to) return true;
  const files = git(repo, 'diff', '--no-renames', '--name-only', '-z', from, to).toString().split('\0').filter(Boolean);
  return files.length === 1 && files[0] === 'VERSION';
}
function gateClaims(c, scope, r) {
  need(Array.isArray(c.gateRefs), 'gate refs missing');
  const policies = scope.policies.map(ref => ({ ref, bytes: r.ref(ref, 'policy') }));
  const loops = policies.filter(p => p.ref.path === 'loop.json');
  need(loops.length === 1, 'unique pinned loop policy required');
  const cfg = parseExactJSON(loops[0].bytes), gates = cfg.gates;
  need(object(gates) && Object.hasOwn(gates, 'require'), 'required CI policy missing');
  const required = Array.isArray(gates.require) ? gates.require : typeof gates.require === 'string' ? gates.require.split(',').map(s => s.trim()).filter(Boolean) : null;
  need(required && required.every(s => typeof s === 'string' && /^[^/]+\/.+$/.test(s)), 'invalid required CI policy');
  need(required.length || Array.isArray(gates.require) && gates.require.length === 0, 'implicit empty gate policy');
  const receipts = c.gateRefs.map(item => ({ ...item, bytes: r.ref(item.ref) }));
  const data = receipts.map(item => ({ ...item, value: parseExactJSON(item.bytes) }));
  let green = true;
  if (required.length) {
    const ci = data.filter(item => item.kind === 'ci'); need(ci.length === 1, 'unique CI receipt required');
    const v = ci[0].value;
    need(v.sha === c.candidate.sha && v.host === c.candidate.destination.host && v.repository === c.candidate.destination.repository && Array.isArray(v.missing) && object(v.conclusions), 'CI receipt candidate/destination/verdict mismatch');
    if (Object.hasOwn(c.candidate.destination, 'account')) {
      need(typeof v.account === 'string' && AWS_ACCOUNT_RE.test(v.account) && v.account === c.candidate.destination.account, 'CI receipt candidate/destination account mismatch');
    }
    const passed=v.ok===true && v.ci==='success' && !v.missing.length && Object.keys(v.conclusions).length && Object.entries(v.conclusions).every(([key, verdict]) => /^[^/]+\/.+$/.test(key) && verdict === 'success') && required.every(key => v.conclusions[key] === 'success');
    const failed=v.ok===false && v.ci==='failure' && required.every(key=>text(v.conclusions[key])) && ciWord({ok:false,conclusions:Object.fromEntries(required.map(key=>[key,v.conclusions[key]]))})==='failure';
    need(passed || failed,'required CI check status unknown or inconsistent');
    if(!passed) green=false;
  }
  if (text(gates.suite)) {
    const suites = data.filter(item => item.kind === 'suite'); need(suites.length === 1, 'unique suite receipt required');
    const v = suites[0].value, candidate = c.candidate;
    need(v.repository === candidate.repository && v.tree === candidate.tree && typeof v.green === 'boolean' && Number.isInteger(v.exit) && v.command === gates.suite, 'suite receipt mismatch');
    need(v.sha === candidate.sha || SHA.test(v.sha ?? '') && text(v.versionVaried) && versionOnly(candidate.repository, v.sha, candidate.sha), 'suite SHA mismatch');
    if (text(v.versionVaried)) need(git(candidate.repository, 'show', `${candidate.sha}:VERSION`).toString().trim() === v.versionVaried, 'VERSION variation mismatch');
    need(object(v.summary) && Number.isInteger(v.summary.tests) && v.summary.tests > 0 && Number.isInteger(v.summary.fail) && v.summary.fail >= 0 && Number.isInteger(v.summary.cancelled) && v.summary.cancelled >= 0, 'suite summary invalid');
    need(object(v.log) && HASH.test(v.log.sha256 ?? '') && Number.isSafeInteger(v.log.bytes) && v.log.bytes >= 0, 'suite log digest missing');
    const path = suites[0].ref.path.replace(/\.json$/, '.log');
    const cut = r.cut(suites[0].ref.repository, suites[0].ref.commit);
    const log = cut.files.has(`${path}.gz`) ? gunzipSync(cut.bytes(`${path}.gz`)) : cut.bytes(path);
    need(log.length === v.log.bytes && hash(log) === v.log.sha256, 'suite log digest mismatch');
    const summary = { tests: 0, fail: 0, cancelled: 0 }; let found = false;
    for (const m of log.toString().matchAll(/^(?:#|ℹ)\s+(tests|fail|cancelled)\s+(\d+)\s*$/gm)) { summary[m[1]] += Number(m[2]); found = true; }
    need(found && Object.keys(summary).every(k => summary[k] === v.summary[k]), 'suite log summary mismatch');
    const passed=v.exit===0 && v.summary.fail===0 && v.summary.cancelled===0;
    need(v.green===passed,'suite green flag inconsistent with exit/summary');
    if(!passed) green=false;
  }
  for (const key of Object.keys(gates)) if (!['remote','require','suite','install','protected'].includes(key)) need(gates[key] === null || gates[key] === false, `unsupported required gate: ${key}`);
  need(!data.some(item => !['ci','suite'].includes(item.kind)), 'unsupported applicable gate');
  need(policies.every(p => p.ref.path === 'loop.json'), 'additional gate policy requires existing validator');
  return { data, green };
}
function releaseClaim(row, scope, r) {
  const c = row.value.claim;
  need(object(c) && object(c.candidate), 'invalid release claim');
  const v = c.candidate;
  need(isAbsolute(v.repository ?? '') && normalize(v.repository) === v.repository && SHA.test(v.sha ?? '') && SHA.test(v.tree ?? '') && text(v.destination?.host) && text(v.destination?.repository), 'invalid candidate identity');
  if (isCodeCommitHost(v.destination.host) || Object.hasOwn(v.destination, 'account')) {
    need(typeof v.destination.account === 'string' && AWS_ACCOUNT_RE.test(v.destination.account), 'invalid candidate destination account');
  }
  need(git(v.repository, 'rev-parse', `${v.sha}^{tree}`).toString().trim() === v.tree, 'candidate tree mismatch');
  need(text(c.recipient) && !/^(actor|lead|implementer)(?:-only)?$/i.test(c.recipient) && text(c.channel), 'intended recipient/channel unavailable');
  need(Array.isArray(c.criteriaResults), 'criteria results missing');
  const criteria = []; let available = true;
  for (const expected of scope.criteria) {
    const matches = c.criteriaResults.filter(x => identity(x.criterion?.ref) === identity(expected.ref) && x.criterion?.selector === expected.selector);
    need(matches.length === 1, 'criterion result missing or duplicate');
    const result = matches[0], a = result.availability;
    need(['pass','fail'].includes(result.result) && object(a) && typeof a.usable === 'boolean' && a.recipient === c.recipient && a.channel === c.channel && HASH.test(a.artifactSha256 ?? ''), 'criterion availability unverified');
    if(result.result !== 'pass' || !a.usable) available = false;
    const artifacts = requiredRefs(result.evidenceRefs, r);
    const treeBytes = git(v.repository, 'cat-file', 'tree', v.tree);
    need(artifacts.some(bytes => hash(bytes) === a.artifactSha256) || hash(treeBytes) === a.artifactSha256, 'availability artifact digest mismatch');
    criteria.push(expected);
  }
  const gates=gateClaims(c,scope,r);
  return { available:available && gates.green, criteria, candidate: v, receipts:gates.data, recipient:c.recipient, channel:c.channel };
}

function authenticate(row, r) {
  const b = row.value, sourceBytes = r.ref(b.sourceRef), digest = claimDigest(b);
  if (b.sourceRef.repository === r.q.records) need(ancestor(r.q.records,b.sourceRef.commit,row.first), 'source-unverified: source newer than binding');
  let source = null;
  if (/^[\s]*[\[{]/.test(sourceBytes.toString())) source = parseExactJSON(sourceBytes);
  const corresponds = source && (source.endorsesClaim === digest || object(source.claim) && equal(source.claim, b.claim));
  need(b.authorizationRef.repository === r.q.records,'source-unverified: authorization must exist in records');
  const fragment=selectFragment(r.ref(b.authorizationRef,'authority',b.basedOn),b.authorizationSelector);
  const operation={scope:'scope-assess',release:'release-assess',event:'event-attest'}[b.type];
  need(wholeToken(fragment,operation),'source-unverified: operation unauthorized');
  const nativeRefs = b.provenanceRefs.filter(ref => ref.path === 'metrics/handoffs.jsonl');
  if (nativeRefs.length) {
    const matches = [];
    for (const ref of nativeRefs) {
      const lines = r.ref(ref).toString().split('\n').filter(Boolean).map(parseExactJSON);
      for (const h of lines) if (h.files?.includes(b.sourceRef.path)) matches.push({ h, ref });
    }
    need(matches.length === 1, 'source-unverified: ambiguous or absent native handoff');
    const { h, ref } = matches[0];
    validateHandoff(h);
    need([h.id,h.role,h.task].every(token=>wholeToken(fragment,token)),'source-unverified: native assignment unauthorized');
    need(text(h.id) && text(h.step) && SHA.test(h.view ?? '') && HASH.test(h.task ?? '') && ['reviewer','judge'].includes(h.role) && text(h.record) && h.files.includes(h.record), 'source-unverified: invalid native assignment');
    need(ref.repository === r.q.records && b.sourceRef.repository === r.q.records && ancestor(r.q.records,h.view,ref.commit) && ancestor(r.q.records,ref.commit,row.first), 'source-unverified: native assignment order');
    need(hash(r.cut(r.q.records,ref.commit).bytes(b.sourceRef.path)) === b.sourceRef.sha256, 'source-unverified: native report digest');
    r.ref(b.authorizationRef,'authority',h.view);
    need(publicPath(h.record) && r.cut(r.q.records,ref.commit).files.has(h.record), 'source-unverified: public native report missing');
    const report=r.cut(r.q.records,ref.commit).bytes(h.record);
    let reportClaim=false;
    if(/^[\s]*[\[{]/.test(report.toString())) { const value=parseExactJSON(report); reportClaim=value.endorsesClaim===digest || object(value.claim) && equal(value.claim,b.claim); }
    need(reportClaim || wholeToken(report.toString(),digest),'source-unverified: native public report does not endorse claim');
    need(corresponds || wholeToken(sourceBytes.toString(),digest), 'source-unverified: native claim endorsement mismatch');
  } else {
    need(object(source) && text(source.author) && text(source.requestId) && ['reviewer','judge','time-observer','independent-assessor'].includes(source.role), 'source-unverified: independent source identity missing');
    need(corresponds, 'source-unverified: source claim correspondence mismatch');
    need([source.author,source.role,source.requestId].every(token=>wholeToken(fragment,token)),'source-unverified: external assignment unauthorized');
    const archive=b.provenanceRefs.filter(ref=>ref.repository===b.sourceRef.repository && ref.commit===b.sourceRef.commit && dirname(ref.path)===dirname(b.sourceRef.path) && ref.path.endsWith('.json')).map(ref=>({ref,value:parseExactJSON(r.ref(ref))}));
    const platforms=archive.filter(({value:v})=>object(v) && v.taskId===source.requestId && v.childThreadId===source.author && v.status==='completed' && v.latestTerminalStatus==='completed' && v.hasPendingChildRuns===false && [v.taskId,v.childThreadId,v.childRunId,v.latestTerminalRunId].every(text) && v.childRunId===v.latestTerminalRunId);
    need(platforms.length===1,'source-unverified: archived platform correspondence missing or ambiguous');
    const platform=platforms[0];
    const manifests=archive.filter(({value:v})=>object(v) && Object.values(v).every(x=>typeof x==='string' && HASH.test(x)) && Object.keys(v).every(k=>text(k) && basename(k)===k && !['.','..'].includes(k)) && v[basename(b.sourceRef.path)]===b.sourceRef.sha256 && v[basename(platform.ref.path)]===platform.ref.sha256);
    need(manifests.length===1,'source-unverified: archived output/platform hash correspondence missing or ambiguous');
    if (b.sourceRef.repository === r.q.records) need(ancestor(r.q.records,b.authorizationRef.commit,b.sourceRef.commit) && ancestor(r.q.records,b.sourceRef.commit,row.first), 'source-unverified: assignment/source order');
  }
  if(source) for(const key of ['rootRef','planRef','basedOn']) if(Object.hasOwn(source,key)) need(equal(source[key],b[key]),'source-unverified: source context mismatch');
}
function subject(row) {
  const b = row.value;
  return canonical([b.type, identity(b.rootRef), identity(b.planRef), b.type === 'event' ? [b.claim?.event, identity(b.claim?.subjectRef)] : b.type === 'release' ? [identity(b.claim?.scopeRef), b.claim?.candidate ?? null] : b.basedOn]);
}
function eventClaim(row, r, byRef, observations, clock) {
  const b = row.value, c = b.claim;
  need(object(c) && ['forecast-published','release-available','handoff-completed'].includes(c.event) && utc(c.at) !== null, 'invalid event');
  need(clock !== null && utc(c.at) <= clock, 'clock-anomaly: event after query');
  r.ref(c.subjectRef); requiredRefs(c.basisRefs, r);
  if (c.event === 'release-available') {
    const release = byRef.get(identity(c.subjectRef));
    need(release?.value.type === 'release' && release.verified && !release.conflict && release.release, 'event subject is not verified release');
    need(identity(release.value.rootRef) === identity(b.rootRef) && identity(release.value.planRef) === identity(b.planRef), 'event root/plan mismatch');
    for (const { value } of release.release.receipts) {
      const stamps = [value.completedAt, value.finishedAt, ...(Array.isArray(value.checks) ? value.checks.flatMap(x => [x.completedAt, x.completed_at]) : [])];
      for (const stamp of stamps.filter(x => x !== undefined && x !== null)) need(utc(stamp) !== null && utc(stamp) <= utc(c.at), 'gate completed after event');
    }
  } else if (c.event === 'forecast-published') {
    const o = observations.find(x => identity(x.ref) === identity(c.subjectRef));
    need(o && !(o.errors?.length) && identity(o.rootRef) === identity(b.rootRef) && identity(o.planRef) === identity(b.planRef), 'event subject is not valid anchored forecast');
    need(utc(o.outlook?.asOf) !== null && utc(o.outlook.asOf) <= utc(c.at), 'forecast event precedes asOf');
  } else {
    need(/^rounds\/\d{4}-(reviewer|critic|actor|judge)(-[a-z]+)*\.md$/.test(c.subjectRef.path), 'handoff event subject invalid');
    const cut = r.cut(c.subjectRef.repository, c.subjectRef.commit);
    const rows = cut.read('metrics/handoffs.jsonl').split('\n').filter(Boolean).map(parseExactJSON);
    need(rows.filter(h => h.record === c.subjectRef.path && h.files?.includes(h.record)).length === 1, 'canonical handoff subject missing');
  }
}

export function evaluateTimeEvidence({ stateAtQ, plan, forecastHistory, historicalSnapshots, now = Date.now(), clockMode = 'live' } = {}) {
  const out = { scopeByObservation: {}, eventsBySubject: {}, releaseEvidence: [], releases: [], historicalDoneByObservation: {}, checkpointResolutions: [], findings: [] };
  let observations = [];
  const clock = ['live','simulation'].includes(clockMode) ? (typeof now === 'number' && Number.isFinite(now) ? now : utc(now)) : null;
  try {
    const r = reader(stateAtQ?.records, stateAtQ?.revision);
    observations = observationsAt(r,plan?.time?.rootPlan,out.findings);
    const scanned = scan(r, out.findings);
    for (const row of scanned.filter(row => !row.value)) out.findings.push(...[...row.problems].map(p => `${row.ref.path}: ${p}`));
    const bindings = scanned.filter(row => row.value?.rootRef?.path === `plans/${plan?.time?.rootPlan}.md`);
    const byRef = new Map(bindings.map(row => [identity(row.ref), row]));
    for (const row of bindings) {
      const b = row.value;
      try {
        need(SHA.test(b.basedOn ?? '') && ancestor(r.q.records, b.basedOn, row.first), 'invalid basedOn');
        r.ref(b.rootRef, 'public', b.basedOn); r.ref(b.planRef, 'public', b.basedOn);
        need(b.rootRef.repository === r.q.records && b.planRef.repository === r.q.records, 'foreign root/plan');
        const anchored = parsePlan(r.ref(b.planRef).toString());
        need(`plans/${anchored.time?.rootPlan}.md` === b.rootRef.path, 'plan/root mismatch');
        r.ref(b.sourceRef); r.ref(b.authorizationRef, 'authority', b.basedOn);
        need(identity(b.authorizationRef) !== identity(b.sourceRef) && b.authorizationRef.path !== row.ref.path, 'self authorization');
        requiredRefs(b.provenanceRefs, r);
        need(Array.isArray(b.supersedes), 'supersedes must be a list');
        for (const ref of b.supersedes) {
          r.ref(ref); const prior = byRef.get(identity(ref));
          need(prior && prior !== row && subject(prior) === subject(row) && ancestor(r.q.records, prior.first, row.first), 'invalid supersession subject/order');
        }
        authenticate(row, r);
        row.authenticated = true;
      } catch (e) { row.problems.add(e.message); }
    }
    for (const row of bindings.filter(x => x.value.type === 'scope')) {
      try { row.scope = scopeClaim(row, r, observations); } catch (e) { row.problems.add(e.message); }
      row.verified = row.authenticated && !row.problems.size;
    }
    const markConflicts = type => {
      const groups = new Map();
      for (const row of bindings.filter(x => x.value.type === type && x.authenticated && !x.currentRegression && (type!=='release' || x.verified))) {
        const key = subject(row); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row);
      }
      for (const rows of groups.values()) {
        const live = rows.filter(row => !rows.some(other => other.verified && other.value.supersedes.some(ref => identity(ref) === identity(row.ref))));
        const conflict = new Set(live.map(row => canonical(row.value.claim))).size > 1 || live.some(row => [...row.problems].some(p => p.startsWith('history-incomplete')));
        for (const row of rows) { row.superseded = !live.includes(row); row.conflict = conflict; if (conflict) row.problems.add('evidence-conflict'); }
      }
    };
    markConflicts('scope');
    for (const row of bindings.filter(x => x.value.type === 'release')) {
      try {
        r.ref(row.value.claim?.scopeRef);
        const scope = byRef.get(identity(row.value.claim.scopeRef));
        need(scope?.value.type === 'scope' && scope.verified && !scope.conflict && !scope.superseded, 'scope unverified');
        need(identity(scope.value.rootRef) === identity(row.value.rootRef) && identity(scope.value.planRef) === identity(row.value.planRef), 'release scope root/plan mismatch');
        row.release = releaseClaim(row, scope.scope, r);
        if(!row.release.available) { row.currentRegression = row.authenticated && !row.problems.size; row.problems.add('criterion availability unverified'); }
      } catch (e) { row.problems.add(e.message); }
      row.verified = row.authenticated && !row.problems.size;
    }
    markConflicts('release');
    for (const row of bindings.filter(x => x.value.type === 'event')) {
      try { eventClaim(row, r, byRef, observations, clock); } catch (e) { row.problems.add(e.message); }
      row.verified = row.authenticated && !row.problems.size;
    }
    markConflicts('event');
    const good = row => row.verified && !row.conflict && !row.superseded;
    for (const row of bindings) {
      const b = row.value, findings = [...row.problems];
      out.findings.push(...findings.map(s => `${row.ref.path}: ${s}`));
      if (b.type === 'event' && b.claim?.subjectRef?.path) (out.eventsBySubject[b.claim.subjectRef.path] ??= []).push({ ref: row.ref, ...b.claim, at: good(row) ? b.claim.at : null, verification: row.conflict ? 'conflict' : good(row) ? 'verified' : 'unverified', findings });
      if (b.type === 'release') {
        const events = bindings.filter(e => e.value.type === 'event' && e.value.claim?.event === 'release-available' && identity(e.value.claim.subjectRef) === identity(row.ref) && good(e));
        const at = good(row) && events.length ? events.map(e => e.value.claim.at).sort((a,b) => utc(a)-utc(b))[0] : null;
        const regressions = bindings.filter(n=>n.currentRegression && subject(n)===subject(row) && ancestor(r.q.records,row.first,n.first));
        const currentUnknown=bindings.some(n=>n!==row && n.authenticated && !n.verified && !n.currentRegression && n.value.type==='release' && subject(n)===subject(row) && ancestor(r.q.records,row.first,n.first));
        const currentUnavailable=regressions.some(n=>!bindings.some(later=>later.authenticated && later.release?.available && ancestor(r.q.records,n.first,later.first) && later.value.supersedes.some(ref=>identity(ref)===identity(n.ref))));
        const release = { ref: row.ref, criteria: row.release?.criteria ?? [], candidate: b.claim?.candidate ?? null, availableAt: at, verification: row.conflict ? 'conflict' : good(row) ? 'verified' : 'unverified', currentAvailability: currentUnavailable || row.currentRegression ? 'unavailable' : currentUnknown ? 'unverified' : good(row) ? 'verified' : 'unverified', findings };
        out.releases.push(release); if (good(row)) out.releaseEvidence.push(row.ref);
      }
    }
    for (const o of observations) {
      const scopes = bindings.filter(row => row.value.type === 'scope' && identity(row.value.rootRef) === identity(o.rootRef) && identity(row.value.planRef) === identity(o.planRef) && row.value.basedOn === o.outlook?.basedOn && good(row));
      const scopeProblems = scopes.length ? [...new Set(scopes.flatMap(row => forecastScopeProblems(o, row.scope)))] : ['scope evidence unavailable'];
      out.scopeByObservation[o.ref.path] = { verification: scopes.length && !scopeProblems.length ? 'verified' : 'unverified', refs: scopes.map(x => x.ref), criteria: scopes[0]?.scope.criteria ?? [], releasePackages: scopes[0]?.scope.releasePackages ?? [], findings: scopeProblems };
      if (scopes.length) out.findings.push(...scopeProblems.map(problem => `${o.ref.path}: ${problem}`));
      out.historicalDoneByObservation[o.ref.path] = [];
      try {
        const cut = r.cut(r.q.records, o.outlook.basedOn), historical = parsePlan(cut.read(o.planRef.path));
        const handoffs = cut.read('metrics/handoffs.jsonl').split('\n').filter(Boolean).map(parseExactJSON);
        for (const p of historical.packages) {
          const h = handoffs.filter(h => h.id === p.handoff && h.phase === historical.phase);
          if (h.length !== 1 || !h[0].files?.every(path => cut.files.has(path))) continue;
          const event = bindings.find(e => e.value.type === 'event' && e.value.claim?.event === 'handoff-completed' && good(e) && ancestor(r.q.records, e.first, o.outlook.basedOn) && utc(e.value.claim.at) <= utc(o.outlook.asOf) && e.value.claim.subjectRef.repository === r.q.records && e.value.claim.subjectRef.path === h[0].record && hash(cut.bytes(h[0].record)) === e.value.claim.subjectRef.sha256);
          if (event) out.historicalDoneByObservation[o.ref.path].push(p.id);
        }
      } catch { /* design/time-model.md: unknown historical completion is never zero remaining. */ }
      const descends = (candidate, target, seen = new Set()) => {
        if (seen.has(identity(candidate.ref))) return false; seen.add(identity(candidate.ref));
        return (candidate.parents ?? []).some(ref => identity(ref) === identity(target.ref) || observations.some(parent => identity(parent.ref) === identity(ref) && descends(parent, target, seen)));
      };
      for (const update of observations.filter(n => !(n.errors?.length) && identity(n.rootRef) === identity(o.rootRef) && identity(n.planRef) === identity(o.planRef) && descends(n, o) && utc(n.outlook?.asOf) > utc(o.outlook?.asOf))) {
        const events = bindings.filter(e => e.value.type === 'event' && e.value.claim?.event === 'forecast-published' && identity(e.value.claim.subjectRef) === identity(update.ref) && good(e));
        for (const e of events) out.checkpointResolutions.push({ observationRef: o.ref, updateRef: update.ref, eventRef: e.ref, at: e.value.claim.at, status: utc(e.value.claim.at) <= utc(o.outlook.checkpointAt) ? 'met-on-time' : 'missed' });
      }
    }
  } catch (e) { out.findings.push(`history-incomplete: ${e.message}`); }
  out.findings = [...new Set(out.findings)];
  return out;
}
