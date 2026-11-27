// P-0006, F-0012, D-0060, D-0063, D-0064, D-0069, design/dispatch.md#file-ownership, design/dispatch.md#ready-state, design/mandatory-control-plane.md#4
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, regularFiles, run } from './git-plumbing.mjs';
import { canonical } from './path-canonical.mjs';
import { HEAVY_ROLES, normalize, preparedIn } from '../call.mjs';
import { HANDOFFS, parseHandoffs, ROLES } from './handoff.mjs';
import { batchesFrom } from '../decisions.mjs';
import { isSubstantiveOwnerWord, MARKS, parseWords, wordClasses, WORDS } from './owner-words.mjs';
import { hostLoad, resolveOwnerStore } from './registry.mjs';
import { fileOverlap, globOverlap } from './plan-globs.mjs';
import { criticCausalBase, HANDOFF_ID, isCodeJudge, judgeCoverageProblems, judgeJoinProblems, judgeLineageProblems, packageOrder, planCallCommand, planPackageMap, reviewCoverage } from './plan-lineage.mjs';
import { parseWindows, WINDOWS, windowState } from './window-state.mjs';
import { gunzipSync } from 'node:zlib';
import { classify, DEFAULT_LAYOUT, parseLayout } from '../records-check.mjs';
import { parseRows, TRAJECTORY } from '../trajectory.mjs';

export { criticCausalBase, HANDOFF_ID, isCodeJudge, judgeCoverageProblems, judgeJoinProblems, judgeLineageProblems, packageOrder, planCallCommand, planPackageMap, reviewCoverage };

const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PLAN_ID = /^PL-\d{4}$/;
const recordPointer = /^(?:PL|D|P|F|B|I|L)-\d{4}$|^R-\d{4}-[a-z]+(?:-[a-z]+)*$/;

export function snapshot(records, revision = 'HEAD') {
  records = realpathSync(resolve(records));
  const head = git(records, 'rev-parse', `${revision}^{commit}`), files = new Set(regularFiles(records, head).map(f => f.path)), cache = new Map();
  const bytes = path => !files.has(path) ? null : (cache.has(path) ? cache.get(path) : cache.set(path, run('git', ['-C', records, 'show', `${head}:${path}`])).get(path));
  return { records, revision: head, files, bytes, read: path => bytes(path)?.toString('utf8') ?? '' };
}

const jsonList = value => { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; } };

function list(value) {
  if (Array.isArray(value) || typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) { const parsed = jsonList(value); if (parsed) return parsed; }
  const parts = [], chars = Array.from(value);
  let start = 0, depth = 0;
  chars.forEach((c, i) => {
    if ('[{'.includes(c)) depth++; else if (']}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(chars.slice(start, i).join('').trim()); start = i + 1; }
  });
  return [...parts, chars.slice(start).join('').trim()];
}

export function parsePlan(source) {
  let plan;
  if (source.trim().startsWith('{')) plan = JSON.parse(source);
  else {
    plan = { packages: [] };
    let current = plan;
    for (const line of source.split('\n')) {
      const title = /^# (PL-\d{4})(?:\s|$)/.exec(line), section = /^## (?:Package\s+)?([\w.-]+)\s*$/.exec(line), field = /^([a-z][a-zA-Z-]*):\s*(.*?)\s*$/.exec(line);
      if (title) plan.id = title[1];
      else if (section) plan.packages.push(current = { id: section[1] });
      else if (field) { if (Object.hasOwn(current, field[1])) throw new Error(`duplicate field ${field[1]}`); current[field[1]] = field[2]; }
    }
  }
  if (!object(plan)) throw new Error('plan must be an object');
  if (typeof plan.time === 'string') { try { plan.time = JSON.parse(plan.time); } catch {} }
  if (object(plan.packages)) plan.packages = Object.entries(plan.packages).map(([id, p]) => ({ ...p, id }));
  if (Array.isArray(plan.packages)) plan.packages = plan.packages.map(p => {
    if (!object(p)) throw new Error('package must be an object');
    return { ...p, files: list(p.files), needs: list(p.needs), authority: list(p.authority),
      ...(p.reviews !== undefined ? { reviews: list(p.reviews) } : {}),
      settings: typeof p.settings === 'string' && p.settings.startsWith('{') ? JSON.parse(p.settings) : p.settings };
  });
  return plan;
}

export function recordPath(id) {
  const round = HANDOFF_ID.exec(id);
  if (round) return `rounds/${round[1]}-${round[2]}${round[3]}.md`;
  const dirs = { PL: 'plans', D: 'decisions', P: 'purpose', F: 'blueprint', B: 'owner', I: 'interventions', L: 'lessons' };
  return recordPointer.test(id) && dirs[id.split('-')[0]] ? `${dirs[id.split('-')[0]]}/${id}.md` : null;
}

export function plansFrom(state) {
  return [...state.files].filter(f => /^plans\/PL-\d{4}\.md$/.test(f)).map(f => {
    const p = parsePlan(state.read(f));
    if (`plans/${p.id}.md` !== f) throw new Error(`${f}: plan ID differs from its path`);
    return p;
  });
}

const contract = p => JSON.stringify([p.authority?.toSorted(), p.goal, p.files?.toSorted(), p.interface, p.needs?.toSorted(), p.role,
  object(p.settings) && Object.keys(p.settings).length ? Object.entries(p.settings).sort(([a], [b]) => a.localeCompare(b)) : 'current', p.acceptance,
  ...(Array.isArray(p.reviews) && p.reviews.length ? [p.reviews.toSorted()] : [])]);

const AUTHORITY_ID = /^D-\d{4}$|^R-\d{4}-(?:reviewer|judge)(?:-[a-z]+)*$/;
const WORD_CITE = /(?<![\w-])W-[0-9a-f]{10}(?![\w-])/g, BATCH_CITE = /(?<![\w-])B-\d{4}(?![\w-])/g;
const REVIEW_OR_JUDGE_CITE = /(?<![\w-])R-\d{4}-(?:reviewer|judge)(?:-[a-z]+)*(?![\w-])/g;
const TEXT_RECORD = /\.(md|tsv|json|txt|mjs|js|ts|ya?ml)$/i;
const DISTILL_KINDS = new Set(['Purpose', 'Decisions', 'Blueprint', 'Interventions', 'Lessons']);

// D-0060, design/mandatory-control-plane.md#4
function openSubstantiveWords(state) {
  if (!state.files.has(WORDS)) return [];
  const words = parseWords(state.read(WORDS));
  if (!words.length) return [];
  const marks = state.files.has(MARKS) ? wordClasses(parseWords(state.read(MARKS))) : new Map();
  const extra = state.files.has('records.json') ? (JSON.parse(state.read('records.json')).extraKinds ?? []) : [];
  const layout = parseLayout(readFileSync(DEFAULT_LAYOUT, 'utf8'), extra), ids = new Set(), cited = new Set();
  for (const path of state.files) {
    const rec = classify(layout, path);
    if (rec?.id) ids.add(rec.id);
    if (path !== WORDS && path !== MARKS && TEXT_RECORD.test(path) && (DISTILL_KINDS.has(rec?.kind) || rec?.settlesOwnerWords === true))
      for (const m of state.read(path).matchAll(WORD_CITE)) cited.add(m[0]);
  }
  return words.filter(w => {
    if (!isSubstantiveOwnerWord(w.text)) return false;
    const mark = marks.get(w.id) ?? null;
    return !(mark ? (mark.as !== 'direction' || ids.has(mark.intervention)) : cited.has(w.id));
  });
}

// D-0060, design/mandatory-control-plane.md#4
function decisionAuthorityProblem(id, state, { batches, handoffIds, hasHandoffs }) {
  const doc = state.read(recordPath(id)), by = /^by:\s*(.*)$/mi.exec(doc)?.[1]?.trim() ?? '';
  const answeredBatch = bid => Boolean(batches.find(b => b.id === bid)?.answered);
  const committedHandoff = hid => Boolean(recordPath(hid) && state.files.has(recordPath(hid)) && (!hasHandoffs || handoffIds.has(hid)));
  if (/^owner\b/i.test(by)) {
    const byBatches = [...new Set([...by.matchAll(BATCH_CITE)].map(m => m[0]))];
    return byBatches.length && !byBatches.some(answeredBatch) ? `${id} claims owner batch ${byBatches.join(', ')} with no verbatim answer in owner/answers.jsonl` : null;
  }
  const batchRefs = [...new Set([...doc.matchAll(BATCH_CITE)].map(m => m[0]))];
  const handoffRefs = [...new Set([...doc.matchAll(REVIEW_OR_JUDGE_CITE)].map(m => m[0]))];
  if (batchRefs.some(answeredBatch) || handoffRefs.some(committedHandoff)) return null;
  const details = [...(batchRefs.length ? [`unanswered batch ${batchRefs.join(', ')}`] : []), ...(handoffRefs.length ? [`uncommitted handoff ${handoffRefs.join(', ')}`] : [])];
  return `${id} lacks owner or generation-engine authority${by ? ` (by: ${by})` : ''}${details.length ? `: ${details.join('; ')}` : ': requires by: owner, a verbatim-answered B-NNNN batch, or a committed R-NNNN-reviewer-* / R-NNNN-judge-* handoff'}`;
}

// P-0012, D-0059, D-0060, design/parallel-dispatch.md#3
export function readPlanWindow(state, phase, nextRound = 1, { handoffs = null, rows = null } = {}) {
  if (!state.files.has(WINDOWS)) return { mode: 'normal', active: null, actorBlocked: false };
  const windows = parseWindows(state.read(WINDOWS), WINDOWS);
  const phaseHandoffs = (handoffs ?? (state.files.has(HANDOFFS) ? parseHandoffs(state.read(HANDOFFS)) : [])).filter(h => h.phase === phase && state.files.has(h.record));
  const phaseRows = (rows ?? (state.files.has(TRAJECTORY) ? parseRows(state.read(TRAJECTORY)) : [])).filter(r => r.phase === phase);
  return windowState({ windows, handoffs: phaseHandoffs, rows: phaseRows, phase, nextRound });
}

// D-0060, D-0064, design/mandatory-control-plane.md#4
function checkActorCoverage(plan, state, handoffs, fail) {
  const win = readPlanWindow(state, plan.phase, 1, { handoffs });
  if (!plan.packages.some(p => p.role === 'actor') || (win.active && (win.mode === 'slack' || win.mode === 'converging'))) return;
  const { uncoveredActors } = reviewCoverage(plan);
  if (uncoveredActors.length) fail(`${plan.id}: actor package(s) lack critic coverage outside an open W-NNNN window: ${uncoveredActors.join(', ')}`);
}

export function validatePlan(plan, state) {
  const errors = [], fail = message => errors.push(message);
  if (!PLAN_ID.test(plan.id)) fail('plan id must be PL-NNNN');
  for (const key of ['scope', 'phase']) if (!text(plan[key])) fail(`plan needs ${key}`);
  if (!Array.isArray(plan.packages)) return [...errors, 'plan needs a packages list'];
  for (const w of openSubstantiveWords(state)) fail(`open substantive owner word ${w.id} must be distilled or marked before planning (0-turn grace)`);
  const hasHandoffs = state.files.has(HANDOFFS), handoffs = hasHandoffs ? parseHandoffs(state.read(HANDOFFS)) : [];
  const handoffIds = new Set(handoffs.map(h => h.id)), batches = batchesFrom([...state.files], state.read);
  const packages = new Map(), handoffsSeen = new Set();
  const hasRecord = id => recordPath(id) && state.files.has(recordPath(id));
  const reference = (id, at) => { if (!hasRecord(id)) fail(`${at}: missing committed record ${id}`); };
  for (const p of plan.packages) {
    if (!text(p.id) || !/^[\w.-]+$/.test(p.id)) fail('package needs a simple id');
    if (packages.has(p.id) || recordPointer.test(p.id)) fail(`duplicate or record-shaped package id: ${p.id}`);
    packages.set(p.id, p);
    for (const key of ['goal', 'interface', 'acceptance', 'handoff']) if (!text(p[key])) fail(`${p.id}: needs ${key}`);
    if (!ROLES.includes(p.role)) fail(`${p.id}: unknown role ${p.role}`);
    const h = HANDOFF_ID.exec(p.handoff ?? '');
    if (!h || Number(h[1]) < 1 || h[2] !== p.role) fail(`${p.id}: handoff must name this role and a positive round`);
    if (handoffsSeen.has(p.handoff)) fail(`duplicate expected handoff ${p.handoff}`);
    handoffsSeen.add(p.handoff);
    if (!Array.isArray(p.authority) || !p.authority.length || !p.authority.every(text)) fail(`${p.id}: authority is required`);
    else for (const authority of p.authority) {
      if (!AUTHORITY_ID.test(authority)) fail(`${p.id}: authority must be a decision, reviewer handoff, or judge ruling: ${authority}`);
      reference(authority, `${p.id} authority`);
      if (hasRecord(authority)) {
        if (/^D-\d{4}$/.test(authority)) { const problem = decisionAuthorityProblem(authority, state, { batches, handoffIds, hasHandoffs }); if (problem) fail(`${p.id} authority: ${problem}`); }
        else if (hasHandoffs && !handoffIds.has(authority)) fail(`${p.id} authority: ${authority} has no committed handoff in ${HANDOFFS}`);
      }
    }
    for (const field of ['files', 'needs']) if (!Array.isArray(p[field]) || !p[field].every(text)) fail(`${p.id}: ${field} must be a list (empty is allowed)`);
    if (p.reviews !== undefined && (!Array.isArray(p.reviews) || !p.reviews.every(text))) fail(`${p.id}: reviews must be a list of package ids`);
    if (Array.isArray(p.files)) for (const path of p.files) { try { globOverlap(path, path); } catch (e) { fail(`${p.id}: ${e.message}`); } }
    if (p.settings !== undefined && p.settings !== 'current' && !object(p.settings)) fail(`${p.id}: settings must be current or a JSON object`);
    for (const field of ['interface', 'acceptance']) {
      const pointer = typeof p[field] === 'string' && /^((?:PL|D|P|F|B|I|L)-\d{4}|R-\d{4}-[a-z]+(?:-[a-z]+)*)(?:#\S+)?$/.exec(p[field]);
      if (pointer) reference(pointer[1], `${p.id} ${field}`);
    }
  }
  const byRef = planPackageMap(plan);
  for (const p of plan.packages) for (const need of Array.isArray(p.needs) ? p.needs : []) if (!byRef.has(need)) reference(need, `${p.id} needs`);
  for (const p of plan.packages) for (const target of Array.isArray(p.reviews) ? p.reviews : []) {
    if (target === p.id) fail(`${p.id}: reviews cannot reference itself`);
    else if (!packages.has(target)) fail(`${p.id} reviews: unknown in-plan package ${target}`);
  }
  const visiting = new Set(), visited = new Set();
  const visit = id => {
    if (visiting.has(id)) { fail(`needs cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of packages.get(id)?.needs ?? []) { const target = byRef.get(dep); if (target) visit(target.id); }
    visiting.delete(id); visited.add(id);
  };
  if (plan.packages.every(p => Array.isArray(p.needs))) for (const id of packages.keys()) visit(id);
  checkActorCoverage(plan, state, handoffs, fail);
  if (!errors.length) {
    const { ordered } = packageOrder(plan);
    for (let i = 0; i < plan.packages.length; i++) for (let j = i + 1; j < plan.packages.length; j++) {
      const a = plan.packages[i], b = plan.packages[j];
      if (ordered(a.id, b.id)) continue;
      const overlap = fileOverlap(a.files, b.files);
      if (overlap) fail(`${a.id} and ${b.id} share overlapping files: ${overlap.left} / ${overlap.right}`);
    }
  }
  const all = plansFrom(state).filter(p => p.id !== plan.id), prior = all.find(p => p.id === plan.supersedes);
  if (plan.supersedes) {
    reference(plan.supersedes, 'supersedes');
    if (plan.supersedes === plan.id) fail('supersedes cycle');
    if (prior && (prior.scope !== plan.scope || prior.phase !== plan.phase)) fail('supersedes must name the same scope and phase');
  }
  const sameScope = all.filter(p => p.scope === plan.scope && p.phase === plan.phase), descendants = new Set();
  for (const p of sameScope) {
    for (let current = p, seen = new Set(); current?.supersedes && !seen.has(current.id); current = all.find(q => q.id === current.supersedes)) {
      seen.add(current.id);
      if (current.supersedes === plan.id) { descendants.add(p.id); break; }
    }
  }
  if (sameScope.filter(p => !sameScope.some(q => q.supersedes === p.id) && !descendants.has(p.id)).some(p => p.id !== plan.supersedes))
    fail(`scope ${plan.scope} already has a plan; supersedes must name its current head`);
  for (let ancestor = plan, chain = new Set(); ancestor?.supersedes; ancestor = ancestor.supersedes === plan.id ? plan : all.find(p => p.id === ancestor.supersedes)) {
    if (chain.has(ancestor.id)) { fail('supersedes cycle'); break; }
    chain.add(ancestor.id);
  }
  if (prior) for (const p of plan.packages) {
    const previous = prior.packages.find(q => q.handoff === p.handoff);
    if (previous && contract(previous) !== contract(p)) fail(`${p.id}: changed contract must name a new handoff, not ${p.handoff}`);
  }
  return errors;
}

export function loadPlan(state, id) {
  if (!PLAN_ID.test(id) || !state.files.has(`plans/${id}.md`)) throw new Error(`missing committed plan ${id}`);
  const plan = parsePlan(state.read(`plans/${id}.md`));
  const errors = validatePlan(plan, state);
  if (errors.length) throw new Error(errors.join('\n'));
  return plan;
}

const AUDIT_STEP_RE = /^(?:evidence|sealed\/judge)\/(\d{4})\/([a-z]+(?:-[a-z]+)*)-\d+-audit\.json$/;
const MAX_AUDIT_PARSE_BYTES = 1048576, AUDIT_SLICE_BYTES = 65536, AUDIT_META_KEYS = new Set(['id', 'nonce', 'agent']);

function indexAuditFiles(files) {
  const byStep = new Map();
  for (const f of files) {
    const m = AUDIT_STEP_RE.exec(f);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`, list = byStep.get(key) ?? [];
    list.push(f); byStep.set(key, list);
  }
  return byStep;
}

const stepKeyOf = w => Number.isInteger(w.round) && typeof w.step === 'string' && w.step
  ? `${String(w.round).padStart(4, '0')}/${w.step}`
  : (m => m ? `${m[1]}/${m[2]}${m[3]}` : null)(HANDOFF_ID.exec(w.id ?? ''));

function skipJsonString(src, i) {
  for (i++; i < src.length; i++) { if (src[i] === '\\') i++; else if (src[i] === '"') return i + 1; }
  return src.length;
}

function extractTopLevelFields(src) {
  const found = {};
  for (let i = 0, depth = 0; i < src.length && Object.keys(found).length < AUDIT_META_KEYS.size;) {
    const ch = src[i];
    if (ch === '{' || ch === '[') { depth++; i++; continue; }
    if (ch === '}' || ch === ']') { depth--; i++; continue; }
    if (ch !== '"') { i++; continue; }
    const end = skipJsonString(src, i);
    if (depth !== 1) { i = end; continue; }
    let j = end;
    while (j < src.length && /\s/.test(src[j])) j++;
    if (src[j] !== ':') { i = end; continue; }
    let key; try { key = JSON.parse(src.slice(i, end)); } catch { i = end; continue; }
    for (j++; j < src.length && /\s/.test(src[j]); j++);
    if (!AUDIT_META_KEYS.has(key)) { i = j; continue; }
    if (src[j] === '"') { const ve = skipJsonString(src, j); try { found[key] = JSON.parse(src.slice(j, ve)); } catch {} i = ve; }
    else if (src[j] === '{') {
      let d = 0, k = j;
      while (k < src.length) {
        if (src[k] === '"') k = skipJsonString(src, k);
        else if (src[k] === '{') { d++; k++; }
        else if (src[k] === '}') { k++; if (--d === 0) break; }
        else k++;
      }
      if (d === 0) { try { found[key] = JSON.parse(src.slice(j, k)); } catch {} i = k; } else i = j + 1;
    } else {
      const m = /^(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(j));
      if (m) { try { found[key] = JSON.parse(m[0]); } catch {} i = j + m[0].length; } else i = j;
    }
  }
  return found;
}

function readAuditMeta(state, file) {
  const raw = state.bytes?.(file), buf = raw == null ? null : (Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  if (!buf) { const txt = state.read(file); if (!txt) return null; try { return JSON.parse(txt); } catch { return null; } }
  if (buf.length <= MAX_AUDIT_PARSE_BYTES) { try { return JSON.parse(buf.toString('utf8')); } catch { return null; } }
  const head = extractTopLevelFields(buf.subarray(0, AUDIT_SLICE_BYTES).toString('utf8'));
  if (head.id !== undefined && head.agent !== undefined) return head;
  const tail = buf.subarray(Math.max(0, buf.length - AUDIT_SLICE_BYTES)).toString('utf8'), close = tail.lastIndexOf(']');
  return close >= 0 ? { ...extractTopLevelFields(`{${tail.slice(close + 1)}`), ...head } : head;
}

// F-0015, P-0014, P-0015, R-0055-judge-frame-hygiene
export function buildSharedPlanContext(state, cfg = null, { live = true, plans = null } = {}) {
  if (!cfg) {
    if (!state.files.has('loop.json')) throw new Error('missing committed loop.json');
    cfg = { ...normalize(JSON.parse(state.read('loop.json')), state.records), configFile: join(state.records, 'loop.json') };
  }
  return { cfg, handoffs: parseHandoffs(state.read('metrics/handoffs.jsonl')), trajectory: parseRows(state.read('metrics/trajectory.jsonl')),
    batches: batchesFrom([...state.files], state.read), plans: plans ?? plansFrom(state), prepared: live ? preparedIn(cfg) : [],
    auditFilesByStep: indexAuditFiles(state.files) };
}

export function planContext(state, plan, { live = true } = {}) {
  const shared = buildSharedPlanContext(state, null, { live });
  if (canonical(shared.cfg.records) !== state.records || shared.cfg.phase !== plan.phase) throw new Error('plan and loop.json must name the same records repository and phase');
  return shared;
}

// F-0012, R-0008-judge-mechanisms, design/generative-engine.md#idle-packages-and-holds
export const LEAD_STEPS = Object.freeze(['task', 'settings', 'merge', 'attempt']);
export const isIdle = row => !['done', 'running'].includes(row.status) && row.holds.every(h => LEAD_STEPS.includes(h.kind));

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
export const RELEASE_IN_WORDS = 'release in words: cannot be checked; name a record ID, an owner batch ID, capacity or an ISO time to make it computable';

export function releaseOf(release, { state, batches, host, now = Date.now() }) {
  const parts = String(release ?? '').split(',').map(part => part.trim()).filter(Boolean);
  const conditions = parts.map(part => {
    if (part === 'capacity') return { part, met: Boolean(host?.admits) };
    if (ISO_TIME.test(part) && Number.isFinite(Date.parse(part))) return { part, met: now >= Date.parse(part) };
    if (/^B-\d{4}$/.test(part)) return { part, met: Boolean(batches.find(b => b.id === part)?.answered) };
    if (recordPointer.test(part) && recordPath(part)) return { part, met: state.files.has(recordPath(part)) };
    return null;
  });
  if (!parts.length || conditions.includes(null)) return { computed: false, met: false, conditions: [] };
  return { computed: true, met: conditions.every(c => c.met), conditions };
}

export function readyPlan(state, plan, { context = planContext(state, plan), host, base, window = null, now = Date.now() } = {}) {
  const { cfg, handoffs, batches, plans, prepared } = context;
  if (plans.some(p => p.supersedes === plan.id)) throw new Error(`${plan.id} is superseded; request the current plan`);
  host ??= hostLoad({ cfg, store: resolveOwnerStore() });
  const phaseHandoffs = handoffs.filter(h => h.phase === plan.phase && state.files.has(h.record));
  const win = window ?? readPlanWindow(state, plan.phase, 1, { handoffs: phaseHandoffs, rows: context.trajectory });
  const completed = id => phaseHandoffs.some(h => h.id === id);
  const pending = prepared.filter(p => (!p.phase || p.phase === plan.phase) && !completed(p.id));
  const matching = id => pending.filter(p => p.id === id);
  const active = pending.filter(p => p.liveWorkspace);
  const leases = id => (host.calls ?? []).filter(c => c.kind === 'call' && c.id === id && c.records && canonical(c.records) === canonical(cfg.records));
  const rows = plan.packages.map(p => ({ id: p.id, handoff: p.handoff, role: p.role,
    settings: !p.settings || p.settings === 'current' ? cfg.agents[p.role] : { ...cfg.agents[p.role], ...p.settings },
    status: completed(p.handoff) ? 'done' : matching(p.handoff).some(w => w.liveWorkspace) || leases(p.handoff).length ? 'running' : 'ready', holds: [] }));
  const byRef = planPackageMap(plan);
  const byId = new Map(rows.map(row => [row.id, row]));
  let auditByStep = context.auditFilesByStep ?? null;
  const hold = (row, kind, target, release) => { row.holds.push({ kind, target, release }); row.status = 'waiting'; };
  for (let i = 0; i < plan.packages.length; i++) {
    const p = plan.packages[i], row = rows[i];
    if (row.status === 'done' || row.status === 'running') {
      if (row.status === 'running') row.evidence = [...matching(p.handoff).filter(w => w.liveWorkspace).map(w => ({ workspace: w.ws, state: 'prepared; launch acknowledgement unknown' })),
        ...leases(p.handoff).map(c => ({ lease: c.pid, state: 'a live call lease of call.mjs (the CLI call runs)' }))];
      continue;
    }
    for (const need of p.needs) {
      const dep = byRef.get(need);
      if (dep) { const depRow = byId.get(dep.id); if (depRow.status !== 'done') hold(row, 'package', dep.id, `record successful handoff ${depRow.handoff}`); }
      else if (/^B-/.test(need) && !batches.find(b => b.id === need)?.answered) hold(row, 'batch', need, `commit the owner's answer to ${need}`);
    }
    for (const w of active) {
      const old = plans.flatMap(q => q.packages).find(q => q.handoff === w.id);
      const paths = Array.isArray(w.dispatch?.files) ? w.dispatch.files : (old?.files ?? null);
      if (!paths?.length) continue;
      const overlap = fileOverlap(p.files, paths);
      if (overlap) hold(row, 'writer', w.id, `record or reconcile ${w.id} before writing ${overlap.left}`);
    }
    const missing = matching(p.handoff).filter(w => !w.liveWorkspace);
    if (missing.length && !auditByStep) auditByStep = indexAuditFiles(state.files);
    for (const w of missing) {
      const key = stepKeyOf(w), candidates = key ? (auditByStep.get(key) ?? []) : [];
      const terminal = candidates.some(f => {
        const audit = readAuditMeta(state, f);
        if (!audit || audit.id !== w.id || !audit.agent?.session) return false;
        if (typeof audit.nonce === 'string') return audit.nonce === w.nonce;
        if (audit.nonce !== undefined) return false;
        const log = f.replace(/-audit\.json$/, '.log.gz');
        return state.files.has(log) && gunzipSync(state.bytes(log)).toString('utf8').includes(w.nonce);
      });
      if (!terminal) hold(row, 'attempt', w.id, `reconcile missing workspace ${w.ws}; no committed failed attempt proves it stopped`);
    }
    if (HEAVY_ROLES.includes(p.role) && !host.admits) for (const reason of host.over) hold(row, 'capacity', reason, 'remeasure host load and available memory within the configured bound');
    if (text(p.release)) {
      const release = releaseOf(p.release, { state, batches, host, now }), why = text(p.hold) ? p.hold.trim() : 'no reason given';
      if (release.computed && release.met) row.released = { hold: text(p.hold) ? p.hold.trim() : null, release: p.release.trim() };
      else {
        hold(row, 'hold', why, p.release.trim());
        if (!release.computed) { row.holds.at(-1).computed = false; row.unchecked = { hold: why, release: p.release.trim(), review: RELEASE_IN_WORDS }; }
      }
    } else if (text(p.hold)) row.unheld = { hold: p.hold.trim(), why: 'names no release condition, so it is not a hold (A3)' };
    if (object(p.settings) && Object.entries(p.settings).some(([k, v]) => cfg.agents[p.role]?.[k] !== v))
      hold(row, 'settings', 'loop.json settings', `configure the authorized ${p.role} settings before preparation`);
    let pinnedBase = null;
    if (p.role === 'critic' && !row.holds.some(h => h.kind === 'package')) {
      const cb = criticCausalBase(plan, p, { repo: cfg.product, handoffs: phaseHandoffs, base });
      if (!cb.ok) hold(row, 'merge', cb.target, cb.release); else if (cb.pinned) pinnedBase = cb.base;
    }
    if (p.role === 'judge') {
      if (base === null) hold(row, 'merge', 'integration SHA', 'merge the diverged hand-off heads that loop.mjs next names; the judge rules on one integration SHA');
      if (isCodeJudge(p)) for (const jp of judgeJoinProblems(plan, { repo: cfg.product, handoffs: phaseHandoffs, base, window: win })) hold(row, jp.kind, jp.target, jp.release);
    }
    const task = resolve(cfg.workDir, p.task ?? `tasks/${p.handoff}.md`);
    if (!existsSync(task)) hold(row, 'task', task, 'write the package task with features, goal, interface and acceptance');
    if (row.status === 'ready') row.command = planCallCommand(cfg, plan.id, p, { base: p.role === 'judge' && base ? base : pinnedBase });
  }
  return summarize({ plan: plan.id, scope: plan.scope, revision: state.revision, packages: rows, host,
    trajectory: (context.trajectory ?? []).filter(r => r.phase === plan.phase).map(r => ({ round: r.round, time: r.time, verdict: r.verdict, area: r.area })),
    unknowns: ['Ready is a measured-host recommendation, not a capacity reservation or launch acknowledgement. Reconcile after each launch.'] });
}

function summarize(result) {
  for (const row of result.packages) row.idle = isIdle(row);
  result.ready = result.packages.filter(r => r.status === 'ready').map(r => r.id);
  result.idle = result.packages.filter(r => r.idle).map(r => r.id);
  result.unchecked = result.packages.filter(r => r.unchecked).map(r => r.id);
  return result;
}

// R-0008-judge, D-0036, design/round9-a.md#one-writer-across-current-plans
export function admitAcrossPlans(entries) {
  const ordered = entries.filter(e => e.result).toSorted((a, b) => a.plan.id.localeCompare(b.plan.id));
  const rowsOf = ({ plan, result }) => plan.packages.map((p, i) => ({ plan: plan.id, p, row: result.packages[i] }));
  const claims = ordered.flatMap(rowsOf).filter(({ row }) => row.status === 'running');
  for (const entry of ordered) {
    for (const { plan, p, row } of rowsOf(entry)) {
      if (row.status === 'done' || row.status === 'running') continue;
      for (const claim of claims) {
        if (claim.plan === plan || row.holds.some(h => h.kind === 'writer' && h.target === claim.p.handoff)) continue;
        const overlap = fileOverlap(p.files, claim.p.files);
        if (!overlap) continue;
        row.holds.push({ kind: 'writer', target: claim.p.handoff,
          release: `record successful handoff ${claim.p.handoff} (${claim.p.id}, ${claim.plan}), which writes ${overlap.right}, before writing ${overlap.left}` });
        row.status = 'waiting'; delete row.command;
      }
      if (row.status === 'ready') claims.push({ plan, p, row });
    }
    summarize(entry.result);
  }
  return entries;
}

// F-0012, F-0015, P-0015, R-0008-judge-frame-dispatch
export function reconcilePlans(records, revision, phase, { host, base, live = true, now = Date.now() } = {}) {
  let state, plans;
  try { state = snapshot(records, revision); plans = plansFrom(state); }
  catch (error) { return { state: null, problem: `the plans cannot be read: ${error.message}`, plans: [], idle: [], unchecked: [] }; }
  let shared = null, sharedErr = null, resolvedHost = host;
  const getShared = plan => {
    if (sharedErr) throw sharedErr;
    if (!shared) { try { shared = buildSharedPlanContext(state, null, { live, plans }); } catch (err) { sharedErr = err; throw err; } }
    if (canonical(shared.cfg.records) !== state.records || shared.cfg.phase !== plan.phase) throw new Error('plan and loop.json must name the same records repository and phase');
    if (resolvedHost === undefined) resolvedHost = hostLoad({ cfg: shared.cfg, store: resolveOwnerStore() });
    return shared;
  };
  const current = plans.filter(p => p.phase === phase && !plans.some(o => o.supersedes === p.id)).toSorted((a, b) => a.id.localeCompare(b.id)).map(plan => {
    const errors = validatePlan(plan, state);
    if (errors.length) return { plan, errors };
    try { return { plan, result: readyPlan(state, plan, { context: getShared(plan), host: resolvedHost, base, now }) }; }
    catch (error) { return { plan, problem: error.message }; }
  });
  admitAcrossPlans(current);
  const rowsWith = test => current.flatMap(({ plan, result }) => result ? result.packages.filter(test).map(row => ({ ...row, plan: plan.id })) : []);
  return { state, problem: null, plans: current, idle: rowsWith(isIdle), unchecked: rowsWith(row => row.unchecked) };
}
