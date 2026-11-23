// P-0006, F-0012, design/dispatch.md#ready-state
import { existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { git, regularFiles, run } from './git-plumbing.mjs';
import { node as nodeCommand } from './commands.mjs';
import { HEAVY_ROLES, normalize, preparedIn } from '../call.mjs';
import { parseHandoffs, ROLES } from './handoff.mjs';
import { batchesFrom } from '../decisions.mjs';
import { hostLoad, resolveOwnerStore } from './registry.mjs';
import { fileOverlap, globOverlap } from './plan-globs.mjs';
import { gunzipSync } from 'node:zlib';
import { parseRows } from '../trajectory.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const PLAN_ID = /^PL-\d{4}$/;
export const HANDOFF_ID = /^R-(\d{4})-(reviewer|critic|actor|judge)((?:-[a-z]+)*)$/;
const recordPointer = /^(?:PL|D|P|F|B|I|L)-\d{4}$|^R-\d{4}-[a-z]+(?:-[a-z]+)*$/;

export function snapshot(records, revision = 'HEAD') {
  records = realpathSync(resolve(records));
  const head = git(records, 'rev-parse', `${revision}^{commit}`);
  const files = new Set(regularFiles(records, head).map(f => f.path)), cache = new Map();
  const bytes = path => {
    if (!files.has(path)) return null;
    if (!cache.has(path)) cache.set(path, run('git', ['-C', records, 'show', `${head}:${path}`]));
    return cache.get(path);
  };
  return { records, revision: head, files, bytes, read: path => bytes(path)?.toString('utf8') ?? '' };
}

function jsonList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function list(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  if (!value.trim()) return [];
  if (value.trim().startsWith('[')) {
    const parsed = jsonList(value);
    if (parsed) return parsed;
  }
  const parts = [], chars = Array.from(value);
  let start = 0, depth = 0;
  chars.forEach((c, i) => {
    if ('[{'.includes(c)) depth++;
    if (']}'.includes(c)) depth--;
    if (c === ',' && depth === 0) { parts.push(chars.slice(start, i).join('').trim()); start = i + 1; }
  });
  parts.push(chars.slice(start).join('').trim());
  return parts;
}

export function parsePlan(source) {
  let plan;
  if (source.trim().startsWith('{')) plan = JSON.parse(source);
  else {
    plan = { packages: [] };
    let current = plan;
    for (const line of source.split('\n')) {
      const title = /^# (PL-\d{4})(?:\s|$)/.exec(line);
      const section = /^## (?:Package\s+)?([\w.-]+)\s*$/.exec(line);
      const field = /^([a-z][a-zA-Z-]*):\s*(.*?)\s*$/.exec(line);
      if (title) plan.id = title[1];
      else if (section) { current = { id: section[1] }; plan.packages.push(current); }
      else if (field) {
        if (Object.hasOwn(current, field[1])) throw new Error(`duplicate field ${field[1]}`);
        current[field[1]] = field[2];
      }
    }
  }
  if (!object(plan)) throw new Error('plan must be an object');
  if (typeof plan.time === 'string') {
    try { plan.time = JSON.parse(plan.time); } catch {  }
  }
  if (object(plan.packages)) plan.packages = Object.entries(plan.packages).map(([id, p]) => ({ ...p, id }));
  if (Array.isArray(plan.packages)) plan.packages = plan.packages.map(p => {
    if (!object(p)) throw new Error('package must be an object');
    return { ...p, files: list(p.files), needs: list(p.needs), authority: list(p.authority),
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
  object(p.settings) && Object.keys(p.settings).length ? Object.entries(p.settings).sort(([a], [b]) => a.localeCompare(b)) : 'current', p.acceptance]);

export function validatePlan(plan, state) {
  const errors = [], fail = message => errors.push(message);
  if (!PLAN_ID.test(plan.id)) fail('plan id must be PL-NNNN');
  for (const key of ['scope', 'phase']) if (!text(plan[key])) fail(`plan needs ${key}`);
  if (!Array.isArray(plan.packages)) return [...errors, 'plan needs a packages list'];
  const packages = new Map(), handoffs = new Set();
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
    if (handoffs.has(p.handoff)) fail(`duplicate expected handoff ${p.handoff}`);
    handoffs.add(p.handoff);
    if (!Array.isArray(p.authority) || !p.authority.length || !p.authority.every(text)) fail(`${p.id}: authority is required`);
    else for (const authority of p.authority) {
      if (!/^D-\d{4}$|^R-\d{4}-judge(?:-[a-z]+)*$/.test(authority)) fail(`${p.id}: authority must be a decision or judge ruling: ${authority}`);
      reference(authority, `${p.id} authority`);
    }
    for (const field of ['files', 'needs']) if (!Array.isArray(p[field]) || !p[field].every(text)) fail(`${p.id}: ${field} must be a list (empty is allowed)`);
    if (Array.isArray(p.files)) for (const path of p.files) {
      try { globOverlap(path, path); } catch (e) { fail(`${p.id}: ${e.message}`); }
    }
    if (p.settings !== undefined && p.settings !== 'current' && !object(p.settings)) fail(`${p.id}: settings must be current or a JSON object`);
    for (const field of ['interface', 'acceptance']) {
      const pointer = typeof p[field] === 'string' && /^((?:PL|D|P|F|B|I|L)-\d{4}|R-\d{4}-[a-z]+(?:-[a-z]+)*)(?:#\S+)?$/.exec(p[field]);
      if (pointer) reference(pointer[1], `${p.id} ${field}`);
    }
  }
  for (const p of plan.packages) for (const need of Array.isArray(p.needs) ? p.needs : []) if (!packages.has(need)) reference(need, `${p.id} needs`);
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { fail(`needs cycle at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of packages.get(id)?.needs ?? []) if (packages.has(dep)) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  if (plan.packages.every(p => Array.isArray(p.needs))) for (const id of packages.keys()) visit(id);
  if (!errors.length) for (let i = 0; i < plan.packages.length; i++) for (let j = i + 1; j < plan.packages.length; j++) {
    const a = plan.packages[i], b = plan.packages[j], overlap = fileOverlap(a.files, b.files);
    if (overlap) fail(`${a.id} and ${b.id} share overlapping files: ${overlap.left} / ${overlap.right}`);
  }
  const all = plansFrom(state).filter(p => p.id !== plan.id), prior = all.find(p => p.id === plan.supersedes);
  if (plan.supersedes) {
    reference(plan.supersedes, 'supersedes');
    if (plan.supersedes === plan.id) fail('supersedes cycle');
    if (prior && (prior.scope !== plan.scope || prior.phase !== plan.phase)) fail('supersedes must name the same scope and phase');
  }
  const sameScope = all.filter(p => p.scope === plan.scope && p.phase === plan.phase);
  const descendants = new Set();
  for (const p of sameScope) {
    let current = p; const seen = new Set();
    while (current?.supersedes && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.supersedes === plan.id) { descendants.add(p.id); break; }
      current = all.find(q => q.id === current.supersedes);
    }
  }
  const heads = sameScope.filter(p => !sameScope.some(q => q.supersedes === p.id) && !descendants.has(p.id));
  if (heads.some(p => p.id !== plan.supersedes)) fail(`scope ${plan.scope} already has a plan; supersedes must name its current head`);
  let ancestor = plan;
  const chain = new Set();
  while (ancestor?.supersedes) {
    if (chain.has(ancestor.id)) { fail('supersedes cycle'); break; }
    chain.add(ancestor.id);
    ancestor = ancestor.supersedes === plan.id ? plan : all.find(p => p.id === ancestor.supersedes);
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

export function planContext(state, plan, { live = true } = {}) {
  if (!state.files.has('loop.json')) throw new Error('missing committed loop.json');
  const cfg = { ...normalize(JSON.parse(state.read('loop.json')), state.records), configFile: join(state.records, 'loop.json') };
  if (resolve(cfg.records) !== state.records || cfg.phase !== plan.phase) throw new Error('plan and loop.json must name the same records repository and phase');
  return { cfg, handoffs: parseHandoffs(state.read('metrics/handoffs.jsonl')),
    trajectory: parseRows(state.read('metrics/trajectory.jsonl')),
    batches: batchesFrom([...state.files], state.read), plans: plansFrom(state), prepared: live ? preparedIn(cfg) : [] };
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

export function readyPlan(state, plan, { context = planContext(state, plan), host, base, now = Date.now() } = {}) {
  const { cfg, handoffs, batches, plans, prepared } = context;
  if (plans.some(p => p.supersedes === plan.id)) throw new Error(`${plan.id} is superseded; request the current plan`);
  host ??= hostLoad({ cfg, store: resolveOwnerStore() });
  const completed = id => handoffs.some(h => h.id === id && h.phase === plan.phase && state.files.has(h.record));
  const pending = prepared.filter(p => (!p.phase || p.phase === plan.phase) && !completed(p.id));
  const matching = id => pending.filter(p => p.id === id);
  const active = pending.filter(p => p.liveWorkspace);
  const leases = id => (host.calls ?? []).filter(c => c.kind === 'call' && c.id === id && c.records && resolve(c.records) === resolve(cfg.records));
  const rows = plan.packages.map(p => ({ id: p.id, handoff: p.handoff, role: p.role,
    settings: !p.settings || p.settings === 'current' ? cfg.agents[p.role] : { ...cfg.agents[p.role], ...p.settings },
    status: completed(p.handoff) ? 'done' : matching(p.handoff).some(w => w.liveWorkspace) || leases(p.handoff).length ? 'running' : 'ready', holds: [] }));
  const byId = new Map(rows.map(row => [row.id, row]));
  const hold = (row, kind, target, release) => { row.holds.push({ kind, target, release }); row.status = 'waiting'; };
  for (let i = 0; i < plan.packages.length; i++) {
    const p = plan.packages[i], row = rows[i];
    if (row.status === 'done' || row.status === 'running') {
      if (row.status === 'running') row.evidence = [...matching(p.handoff).filter(w => w.liveWorkspace).map(w => ({ workspace: w.ws, state: 'prepared; launch acknowledgement unknown' })),
        ...leases(p.handoff).map(c => ({ lease: c.pid, state: 'a live call lease of call.mjs (the CLI call runs)' }))];
      continue;
    }
    for (const need of p.needs) {
      if (byId.has(need)) {
        if (byId.get(need).status !== 'done') hold(row, 'package', need, `record successful handoff ${byId.get(need).handoff}`);
      } else if (/^B-/.test(need) && !batches.find(b => b.id === need)?.answered)
        hold(row, 'batch', need, `commit the owner's answer to ${need}`);
    }
    for (const w of active) {
      const old = plans.flatMap(q => q.packages).find(q => q.handoff === w.id);
      const paths = old?.files ?? (w.owns ?? []).flatMap(f => [f, `${f.replace(/\/$/, '')}/**`]);
      const overlap = fileOverlap(p.files, paths);
      if (overlap) hold(row, 'writer', w.id, `record or reconcile ${w.id} before writing ${overlap.left}`);
    }
    for (const w of matching(p.handoff).filter(w => !w.liveWorkspace)) {
      const terminal = [...state.files].filter(f => /-audit\.json$/.test(f)).some(f => {
        const audit = JSON.parse(state.read(f));
        if (audit.id !== w.id || !audit.agent?.session) return false;
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
        if (!release.computed) {
          row.holds.at(-1).computed = false;
          row.unchecked = { hold: why, release: p.release.trim(), review: RELEASE_IN_WORDS };
        }
      }
    } else if (text(p.hold)) row.unheld = { hold: p.hold.trim(), why: 'names no release condition, so it is not a hold (A3)' };
    if (object(p.settings) && Object.entries(p.settings).some(([k, v]) => cfg.agents[p.role]?.[k] !== v))
      hold(row, 'settings', 'loop.json settings', `configure the authorized ${p.role} settings before preparation`);
    if (p.role === 'judge' && base === null) hold(row, 'merge', 'integration SHA', 'merge the diverged hand-off heads that loop.mjs next names; the judge rules on one integration SHA');
    const task = resolve(cfg.workDir, p.task ?? `tasks/${p.handoff}.md`);
    if (!existsSync(task)) hold(row, 'task', task, 'write the package task with features, goal, interface and acceptance');
    if (row.status === 'ready') {
      const [, round, role, suffix] = HANDOFF_ID.exec(p.handoff);
      const prepare = cfg.agents[p.role]?.runner === 't3' ? ['--prepare'] : [];
      const judged = p.role === 'judge' && base ? ['--base', base] : [];
      row.command = nodeCommand('call.mjs', cfg.configFile, role, '--round', String(Number(round)), '--step', role + suffix, ...judged, '--task', task, ...prepare);
    }
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
        row.status = 'waiting';
        delete row.command;
      }
      if (row.status === 'ready') claims.push({ plan, p, row });
    }
    summarize(entry.result);
  }
  return entries;
}
