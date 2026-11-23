// F-0012, design/time-model.md
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { git, gitOk } from './git-plumbing.mjs';
import { snapshot, parsePlan, plansFrom, validatePlan, releaseOf } from './plan.mjs';
import { parseHandoffs } from './handoff.mjs';
import { evaluateTimeEvidence } from './plan-time-evidence.mjs';
import { batchesFrom } from '../decisions.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = /^[a-f0-9]{40}$/;
const digest = /^[a-f0-9]{64}$/;
const foPath = /^forecasts\/FO-([a-f0-9]{64})\.json$/;
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const time = value => typeof value === 'number' && Number.isFinite(value) ? value : utc(value);
const iso = value => Number.isFinite(value) && Math.abs(value) <= 8640000000000000 ? new Date(value).toISOString() : null;
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim());
const identity = ref => ref ? JSON.stringify([ref.repository, ref.path, ref.sha256]) : '';
const refOf = (state, path) => ({ repository: state.records, commit: state.revision, path, sha256: hash(state.bytes(path)) });
const publicPath = path => typeof path === 'string' && !path.split('/').some(p => !p || p === '.' || p === '..' || /(?:private|sealed|auth|transcript|session)/i.test(p)) && (/^(?:plans|forecasts|decisions|purpose|blueprint|rounds|reviews|design|docs|evidence)\//.test(path) || /^metrics\/(?:handoffs|trajectory|blueprint)\.jsonl$/.test(path)) && !/\.(?:gz|log)$/.test(path);
const ancestor = (repo, a, b) => sha.test(a ?? '') && sha.test(b ?? '') && gitOk(repo, 'merge-base', '--is-ancestor', a, b);

function checkRef(ref, state, errors, label = 'ref') {
  try {
    if (!obj(ref) || !isAbsolute(ref.repository ?? '') || realpathSync(ref.repository) !== ref.repository || !sha.test(ref.commit ?? '') || !digest.test(ref.sha256 ?? '') || !publicPath(ref.path)) throw new Error('invalid public pinned reference');
    if (ref.repository === state.records && !ancestor(state.records, ref.commit, state.revision)) throw new Error('reference is not an ancestor of cut');
    const cut = snapshot(ref.repository, ref.commit);
    if (!cut.files.has(ref.path) || hash(cut.bytes(ref.path)) !== ref.sha256) throw new Error('missing regular blob or hash mismatch');
    return cut;
  } catch (e) { errors.push(`${label}: ${e.message}`); return null; }
}
function refs(value, state, errors, label, required = false) {
  if (!Array.isArray(value) || required && !value.length) { errors.push(`${label}: evidence refs required`); return; }
  for (const ref of value) checkRef(ref, state, errors, label);
}
function promises(value, state, errors) {
  if (!Array.isArray(value)) { errors.push('promises must be a list'); return; }
  const ids = new Set();
  for (const p of value) {
    if (!obj(p) || typeof p.id !== 'string' || !p.id || ids.has(p.id) || utc(p.dueAt) === null) { errors.push('invalid or duplicate promise'); continue; }
    ids.add(p.id); refs(p.criteriaRefs, state, errors, 'promise criteria', true); refs(p.authorityRefs, state, errors, 'promise authority', true);
  }
}
function inheritedTime(plan, state) {
  if (plan.time !== undefined) return { plan, errors: [] };
  let prior = plan;
  const seen = new Set(), errors = [];
  while (prior.supersedes) {
    if (seen.has(prior.id)) return { plan, errors: ['time lineage unavailable: execution cycle'] };
    seen.add(prior.id);
    try {
      const path = `plans/${prior.supersedes}.md`;
      if (!state.files.has(path)) throw new Error('predecessor missing');
      prior = parsePlan(state.read(path));
      if (prior.scope !== plan.scope || prior.phase !== plan.phase) throw new Error('scope/phase mismatch');
    } catch (e) { return { plan, errors: [`time lineage unavailable: ${e.message}`] }; }
    if (prior.time !== undefined) {
      errors.push('time lineage missing: descendant omitted inherited time root');
      return { plan: { ...plan, time: obj(prior.time) ? { schema: prior.time.schema, rootPlan: prior.time.rootPlan } : prior.time }, errors };
    }
  }
  return { plan, errors };
}
export function validatePlanTime(plan, state) {
  const inherited = inheritedTime(plan, state);
  return [...inherited.errors, ...validateTime(inherited.plan, state)];
}
function validateTime(plan, state) {
  const errors = [];
  if (plan.time === undefined) return errors;
  const t = plan.time;
  if (!obj(t) || t.schema !== 'plan-time/v2' || !/^PL-\d{4}$/.test(t.rootPlan ?? '')) return ['invalid plan-time/v2 root'];
  try {
    const root = t.rootPlan === plan.id ? plan : parsePlan(state.read(`plans/${t.rootPlan}.md`));
    if (root.time?.rootPlan !== root.id || root.scope !== plan.scope || root.phase !== plan.phase) errors.push('root lineage scope/phase mismatch');
    if (root.id !== plan.id && Object.hasOwn(t, 'baseline')) errors.push('baseline is root-only');
    let p = plan; const seen = new Set();
    while (p.id !== root.id && p.supersedes && !seen.has(p.id)) { seen.add(p.id); p = parsePlan(state.read(`plans/${p.supersedes}.md`)); }
    if (p.id !== root.id) errors.push('root is not an execution ancestor');
    const b = root.time?.baseline;
    if (!obj(b)) return [...errors, 'root baseline missing'];
    if (b.startedAt !== null && utc(b.startedAt) === null) errors.push('invalid baseline start');
    refs(b.startRefs, state, errors, 'start', b.startedAt !== null);
    if (b.deadline !== null) {
      if (!obj(b.deadline) || utc(b.deadline.at) === null) errors.push('invalid deadline');
      refs(b.deadline?.authorityRefs, state, errors, 'deadline authority', true);
    }
    if (!obj(b.minimum) || typeof b.minimum.outcome !== 'string' || !b.minimum.outcome.trim()) errors.push('minimum outcome missing');
    refs(b.minimum?.criteriaRefs, state, errors, 'minimum criteria', true);
    refs(b.minimum?.authorityRefs, state, errors, 'minimum authority', true);
    promises(b.promises, state, errors);
    if (b.previousRoot !== null) {
      const cut = checkRef(b.previousRoot, state, errors, 'previous root');
      if (cut) { const prior = parsePlan(cut.read(b.previousRoot.path)); if (prior.id === root.id || prior.time?.rootPlan !== prior.id) errors.push('invalid previous root'); }
    }
    if (plan.supersedes) {
      const prior = parsePlan(state.read(`plans/${plan.supersedes}.md`));
      if (prior.time && prior.time.rootPlan !== t.rootPlan && identity(b.previousRoot) !== identity(refOf(state, `plans/${prior.time.rootPlan}.md`))) errors.push('new root must cite previous root');
    }
    if (state.records && sha.test(state.revision ?? '')) {
      const path = `plans/${root.id}.md`;
      const changes = git(state.records, 'log', '--format=%H', '--diff-filter=MDT', state.revision, '--', path);
      if (changes) errors.push('immutable root was modified or deleted');
    }
  } catch (e) { errors.push(`root history unavailable: ${e.message}`); }
  return errors;
}
const interval = value => obj(value) && ['lowSeconds', 'highSeconds'].every(k => value[k] === null || Number.isSafeInteger(value[k]) && value[k] >= 0) && (value.lowSeconds === null || value.highSeconds === null || value.lowSeconds <= value.highSeconds);
const maxima = observations => observations.filter(o => !observations.some(n => n.parents?.some(p => identity(p) === identity(o.ref))));

function validateObservation(o, cut, publication) {
  const errors = [];
  if (o.schema !== 'plan-forecast/v1' || !obj(o.outlook) || !obj(o.estimates)) return ['invalid forecast schema'];
  const x = o.outlook;
  if (!sha.test(x.basedOn ?? '') || !ancestor(cut.records, x.basedOn, publication)) errors.push('basedOn must be full ancestor of publication');
  for (const [name, ref] of [['rootRef', o.rootRef], ['planRef', o.planRef]]) {
    checkRef(ref, cut, errors, name);
    if (ref?.repository !== cut.records || !/^plans\/PL-\d{4}\.md$/.test(ref?.path ?? '') || !cut.files.has(ref.path) || hash(cut.bytes(ref.path)) !== ref.sha256) errors.push(`${name}: cut does not contain anchored plan`);
  }
  try {
    const plan = parsePlan(cut.read(o.planRef.path));
    errors.push(...validatePlan(plan, cut), ...validatePlanTime(plan, cut));
    const heads = plansFrom(cut).filter(p => p.scope === plan.scope && p.phase === plan.phase).filter(p => !plansFrom(cut).some(q => q.supersedes === p.id));
    if (heads.length !== 1 || heads[0].id !== plan.id || `plans/${plan.time?.rootPlan}.md` !== o.rootRef.path) errors.push('forecast is not anchored to unique execution head/root');
  } catch (e) { errors.push(`plan unavailable: ${e.message}`); }
  const a = utc(x.asOf), observed = utc(x.observation?.observedAt), recorded = utc(x.observation?.recordedAt), checkpoint = utc(x.checkpointAt);
  if ([a, observed, recorded, checkpoint].includes(null) || observed > recorded || a > recorded || checkpoint <= a) errors.push('invalid observation time ordering');
  refs(x.observation?.evidenceRefs, cut, errors, 'observation evidence', true);
  refs(x.inputs, cut, errors, 'inputs', true);
  if (!strings(x.releasePackages) || !x.releasePackages.length) errors.push('releasePackages required');
  if (!interval(x.reserve?.remaining) || !strings(x.reserve?.covers) || !strings(x.reserve?.assumptions)) errors.push('invalid reserve');
  refs(x.reserve?.basisRefs, cut, errors, 'reserve basis', true);
  if (!x.change?.reason || !strings(x.change?.deferredPackages)) errors.push('change reason/deferredPackages missing');
  refs(x.change?.authorityRefs, cut, errors, 'change authority', true);
  if (!['active', 'cancelled', 'delivered'].includes(x.outcome?.state)) errors.push('invalid outcome');
  refs(x.outcome?.evidenceRefs, cut, errors, 'outcome evidence');
  if (x.outcome?.deliveredAt !== null && utc(x.outcome?.deliveredAt) === null) errors.push('invalid delivery time');
  for (const [id, e] of Object.entries(o.estimates)) {
    if (!obj(e) || utc(e.asOf) !== a || !interval(e.remaining) || !interval(e.availableAfter) || !strings(e.assumptions) || !strings(e.unknowns)) errors.push(`${id}: invalid estimate`);
    refs(e?.basisRefs, cut, errors, `${id} basis`, true);
  }
  refs(o.parents, cut, errors, 'parents');
  promises(o.promisesAdded, cut, errors);
  return errors;
}
export function loadForecastHistory(recordsRepository, queryCommit, rootPlan) {
  const result = { observations: [], publicationRefs: [], snapshots: {}, errors: [] };
  try {
    const repo = realpathSync(recordsRepository), q = snapshot(repo, queryCommit);
    const commits = git(repo, 'rev-list', '--reverse', '--topo-order', q.revision).split('\n').filter(Boolean);
    if (git(repo, 'rev-parse', '--is-shallow-repository') === 'true') result.errors.push('history-incomplete: shallow repository');
    const seen = new Map();
    for (const commit of commits) {
      const tree = snapshot(repo, commit);
      for (const path of tree.files) {
        if (!path.startsWith('forecasts/')) continue;
        const bytes = tree.bytes(path), h = hash(bytes);
        if (seen.has(path)) { if (seen.get(path).hash !== h) result.errors.push(`history-incomplete: modified ${path}`); continue; }
        seen.set(path, { hash: h, commit });
        if (!foPath.test(path) || foPath.exec(path)[1] !== h) { result.errors.push(`history-incomplete: invalid forecast digest ${path}`); continue; }
        let o;
        try { o = JSON.parse(bytes); } catch { result.errors.push(`history-incomplete: malformed ${path}`); continue; }
        if (o.rootRef?.path !== `plans/${rootPlan}.md`) {
          try {
            if (!sha.test(o.outlook?.basedOn ?? '')) throw new Error('unclassifiable root history');
            const anchor = snapshot(repo, o.outlook.basedOn);
            const anchoredPlan = parsePlan(anchor.read(o.planRef?.path));
            if (anchoredPlan.time?.rootPlan !== rootPlan) continue;
          } catch (e) { result.errors.push(`history-incomplete: ${path}: ${e.message}`); continue; }
        }
        o = { ...o, ref: refOf(tree, path), publicationCommit: commit, errors: [] };
        try {
          if (!sha.test(o.outlook?.basedOn ?? '')) throw new Error('invalid basedOn');
          const cut = result.snapshots[o.outlook.basedOn] ??= snapshot(repo, o.outlook.basedOn);
          o.errors.push(...validateObservation(o, cut, commit));
          const prior = result.observations.filter(p => ancestor(repo, p.publicationCommit, o.outlook.basedOn));
          const rootPromises = parsePlan(cut.read(o.rootRef?.path)).time?.baseline?.promises ?? [];
          const usedPromises = new Set([...rootPromises, ...prior.flatMap(p => Array.isArray(p.promisesAdded) ? p.promisesAdded : [])].map(p => p.id));
          for (const p of Array.isArray(o.promisesAdded) ? o.promisesAdded : []) if (usedPromises.has(p.id)) o.errors.push(`promise-conflict: reused ${p.id}`);
          const expected = maxima(prior).map(p => identity(p.ref)).sort();
          if (JSON.stringify(expected) !== JSON.stringify((o.parents ?? []).map(identity).sort())) o.errors.push('parents must cite all maxima at basedOn');
          for (const p of o.parents ?? []) if (!prior.some(v => identity(v.ref) === identity(p))) o.errors.push('parent missing from root history');
          const pubParents = git(repo, 'rev-list', '--parents', '-n', '1', commit).split(' ').slice(1);
          for (const parent of pubParents) {
            const ps = snapshot(repo, parent), pp = plansFrom(ps);
            const anchored = pp.find(p => `plans/${p.id}.md` === o.planRef?.path);
            if (!anchored || pp.some(p => p.supersedes === anchored.id)) o.errors.push('execution superseded before publication');
          }
        } catch (e) { o.errors.push(`history-incomplete: ${e.message}`); }
        result.observations.push(o); result.publicationRefs.push(o.ref);
      }
      for (const [path, first] of seen) if (ancestor(repo, first.commit, commit) && !tree.files.has(path)) result.errors.push(`history-incomplete: deleted ${path} at ${commit}`);
    }
    result.errors.push(...result.observations.flatMap(o => o.errors.map(e => `${o.ref.path}: ${e}`)));
  } catch (e) { result.errors.push(`history-incomplete: ${e.message}`); }
  result.errors = [...new Set(result.errors)];
  return result;
}

function completion(state, plan, asOf = null) {
  const errors = [], rows = [], done = new Set(), uncertain = new Set();
  try {
    for (const p of plan.packages) {
      const matches = parseHandoffs(state.read('metrics/handoffs.jsonl')).filter(h => h.id === p.handoff && h.phase === plan.phase && state.files.has(h.record));
      if (matches.length > 1) { uncertain.add(p.id); errors.push(`${p.id}: ambiguous completion`); continue; }
      const h = matches[0];
      if (!h) continue;
      const stamp = utc(h.time);
      if (asOf !== null && (stamp === null || stamp > asOf)) { uncertain.add(p.id); errors.push(`${p.id}: completion time unavailable or future`); continue; }
      if (h.files.some(f => !state.files.has(f))) { uncertain.add(p.id); errors.push(`${p.id}: completion source unavailable`); continue; }
      done.add(p.id); rows.push(refOf(state, h.record));
    }
  } catch (e) { errors.push(e.message); for (const p of plan.packages) uncertain.add(p.id); }
  return { done, uncertain, rows, errors };
}
function arithmetic(o, cut, verifiedDone = []) {
  const unknowns = [], conditionalOn = strings(o.outlook?.reserve?.assumptions) ? [...o.outlook.reserve.assumptions] : [];
  if (!obj(o.outlook) || !strings(o.outlook.releasePackages) || !obj(o.estimates)) return { earliestAt: null, latestAt: null, unknowns: ['malformed forecast operands'], conditionalOn };
  if (!cut || cut.revision !== o.outlook?.basedOn) return { earliestAt: null, latestAt: null, unknowns: ['history-incomplete: exact basedOn snapshot missing'], conditionalOn };
  let plan;
  try { plan = parsePlan(cut.read(o.planRef.path)); } catch { return { earliestAt: null, latestAt: null, unknowns: ['historical plan missing'], conditionalOn }; }
  const completed = completion(cut, plan);
  for (const id of completed.done) if (!verifiedDone.includes(id)) {
    completed.done.delete(id); completed.uncertain.add(id);
    completed.errors.push(`${id}: historical completion timing-unverified`);
  }
  unknowns.push(...completed.errors);
  const byId = new Map(plan.packages.map(p => [p.id, p])), ends = new Map(), visiting = new Set();
  const max = values => values.includes(null) ? null : Math.max(0, ...values);
  const add = (a, b) => a === null || b === null || !Number.isSafeInteger(a + b) ? null : a + b;
  function end(id) {
    if (ends.has(id)) return ends.get(id);
    const p = byId.get(id), e = o.estimates?.[id];
    if (!p || visiting.has(id)) { unknowns.push(`${id}: missing package or dependency cycle`); return [null, null]; }
    visiting.add(id);
    let value;
    if (completed.done.has(id)) value = [0, 0];
    else if (completed.uncertain.has(id) || !interval(e?.remaining) || !interval(e?.availableAfter)) { unknowns.push(`${id}: missing historical estimate/operand`); value = [null, null]; }
    else {
      unknowns.push(...(strings(e.unknowns) ? e.unknowns : ['malformed estimate unknowns'])); conditionalOn.push(...(strings(e.assumptions) ? e.assumptions : []));
      const parents = p.needs.filter(n => byId.has(n)).map(end);
      const foreign = p.needs.filter(n => !byId.has(n));
      if (foreign.length || p.hold || p.release) conditionalOn.push(`${id}: readiness and external release assumptions apply`);
      let unresolvedHold = false;
      if (p.release) {
        const released = releaseOf(p.release, { state: cut, batches: batchesFrom([...cut.files], cut.read), host: { admits: false }, now: utc(o.outlook.asOf) });
        const bounds = p.release.split(',').map(v => utc(v.trim()));
        const bound = bounds.length && bounds.every(v => v !== null) ? Math.max(...bounds) : null;
        const supportedDelay = bound === null ? null : Math.max(0, Math.ceil((bound - utc(o.outlook.asOf)) / 1000));
        unresolvedHold = !released.met && (supportedDelay === null || e.availableAfter.highSeconds === null || e.availableAfter.highSeconds < supportedDelay);
        if (unresolvedHold) unknowns.push(`${id}: unresolved hold has no supported release bound`);
      }
      const unbounded = unresolvedHold || !strings(e.unknowns) || !strings(e.assumptions) || e.unknowns.length || foreign.length && !e.assumptions.length;
      value = ['lowSeconds', 'highSeconds'].map((k, i) => i === 1 && unbounded ? null : add(max([e.availableAfter[k], ...parents.map(v => v[i])]), e.remaining[k]));
    }
    visiting.delete(id); ends.set(id, value); return value;
  }
  const terminal = (o.outlook.releasePackages ?? []).map(end), reserve = o.outlook.reserve?.remaining;
  if (!terminal.length || !interval(reserve)) unknowns.push('release mapping/reserve unavailable');
  conditionalOn.push('Release criteria mapping, shared capacity, review/CI and external input coverage require cited evidence; forecast is conditional.');
  const bounds = ['lowSeconds', 'highSeconds'].map((k, i) => terminal.length && interval(reserve) ? add(max(terminal.map(v => v[i])), reserve[k]) : null);
  return { earliestAt: bounds[0] === null ? null : iso(utc(o.outlook.asOf) + bounds[0] * 1000), latestAt: bounds[1] === null ? null : iso(utc(o.outlook.asOf) + bounds[1] * 1000), unknowns: [...new Set(unknowns)], conditionalOn: [...new Set(conditionalOn)] };
}

export function projectPlanTime(stateAtQ, plan, { now = Date.now(), clockMode = 'live', canonicalPackagesAtQ, forecastHistory, historicalSnapshots } = {}) {
  const inherited = inheritedTime(plan, stateAtQ);
  plan = inherited.plan;
  if (plan.time === undefined && !inherited.errors.length) return null;
  const baselineErrors = validateTime(plan, stateAtQ), findings = [...inherited.errors, ...baselineErrors], clock = time(now);
  const history = forecastHistory ?? loadForecastHistory(stateAtQ.records, stateAtQ.revision, plan.time?.rootPlan);
  findings.push(...(history.errors ?? []));
  const snapshots = historicalSnapshots ?? history.snapshots ?? {};
  const getCut = key => snapshots instanceof Map ? snapshots.get(key) : snapshots[key];
  let baseline;
  try { baseline = (plan.time.rootPlan === plan.id ? plan : parsePlan(stateAtQ.read(`plans/${plan.time.rootPlan}.md`))).time.baseline; } catch { findings.push('baseline unavailable'); }
  const current = completion(stateAtQ, plan); findings.push(...current.errors);
  const observations = history.observations ?? [];
  const anomaly = clock === null || !['live', 'simulation'].includes(clockMode) || clockMode === 'live' && [baseline?.startedAt, ...observations.flatMap(o => [o.outlook?.asOf, o.outlook?.observation?.recordedAt])].some(t => utc(t) !== null && utc(t) > clock);
  if (anomaly) findings.push('clock-anomaly: elapsed, remaining and freshness unknown');
  const evidence = evaluateTimeEvidence({ stateAtQ, plan, forecastHistory: history, historicalSnapshots: snapshots, now, clockMode });
  const delivery = (criteriaRefs, promiseId = null) => {
    const matches = evidence.releases.filter(r => r.verification === 'verified' && Array.isArray(criteriaRefs) && criteriaRefs.length && criteriaRefs.every(ref => r.criteria.some(c => identity(c.ref) === identity(ref) && (c.purpose === 'minimum' || c.purpose === 'promise' && c.promiseId === promiseId))));
    const timed = matches.filter(r => utc(r.availableAt) !== null).sort((a, b) => utc(a.availableAt) - utc(b.availableAt));
    return { evidenceStatus: matches.length ? 'verified' : 'unverified', evidenceRefs: matches.map(r => r.ref), deliveredAt: timed[0]?.availableAt ?? null,
      currentAvailability: matches.some(r => r.currentAvailability === 'verified') ? 'verified' : matches.some(r => r.currentAvailability === 'unavailable') ? 'unavailable' : 'unverified' };
  };
  const minimum = delivery(baseline?.minimum?.criteriaRefs);
  const resolutionsFor = o => evidence.checkpointResolutions.filter(r => identity(r.observationRef) === identity(o.ref) && observations.some(update => identity(update.ref) === identity(r.updateRef) && !update.errors?.length));
  const rows = observations.map(o => {
    const cut = getCut(o.outlook?.basedOn), computed = arithmetic(o, cut, evidence.historicalDoneByObservation[o.ref?.path]), reasons = [];
    const errors = [...(o.errors ?? [])];
    if (cut && cut.revision === o.outlook?.basedOn) errors.push(...validateObservation(o, cut, o.publicationCommit ?? o.ref?.commit));
    if (o.planRef?.path !== `plans/${plan.id}.md` || stateAtQ.files.has(o.planRef?.path) && hash(stateAtQ.bytes(o.planRef.path)) !== o.planRef.sha256) reasons.push('execution plan changed');
    try {
      const oldPlan = parsePlan(cut.read(o.planRef.path));
      const old = completion(cut, oldPlan, utc(o.outlook.asOf));
      if (JSON.stringify([...old.rows.map(identity)].sort()) !== JSON.stringify([...current.rows.map(identity)].sort())) reasons.push('canonical progress changed');
      for (const ref of o.outlook.inputs ?? []) if (ref.repository === stateAtQ.records && (!stateAtQ.files.has(ref.path) || hash(stateAtQ.bytes(ref.path)) !== ref.sha256)) reasons.push(`input changed: ${ref.path}`);
    } catch { errors.push('history-incomplete: comparison snapshot unavailable'); }
    if (!anomaly && clock > utc(o.outlook?.checkpointAt) && !resolutionsFor(o).some(r => r.status === 'met-on-time')) reasons.push('checkpoint expired');
    if (!anomaly && computed.latestAt && clock > utc(computed.latestAt) && (minimum.deliveredAt === null || utc(minimum.deliveredAt) > utc(computed.latestAt))) reasons.push(minimum.deliveredAt === null ? 'forecast completion expired without verified delivery' : 'forecast completion missed: delivered-late');
    return { ref: o.ref ?? null, asOf: o.outlook?.asOf ?? null, ...computed, ...(errors.length ? { earliestAt: null, latestAt: null } : {}), unknowns: [...computed.unknowns, ...errors], stale: reasons.length > 0 || errors.length > 0 || anomaly, staleReasons: reasons, checkpointAt: o.outlook?.checkpointAt ?? null, outcome: o.outlook?.outcome?.state ?? 'unknown', publicationTiming: (evidence.eventsBySubject[o.ref?.path] ?? []).some(e => e.event === 'forecast-published' && e.verification === 'verified' && identity(e.subjectRef) === identity(o.ref)) ? 'verified' : 'timing-unverified', scope: evidence.scopeByObservation[o.ref?.path] ?? null, historicalDone: evidence.historicalDoneByObservation[o.ref?.path] ?? [] };
  });
  const heads = maxima(observations);
  if (heads.length > 1) findings.push('forecast-conflict: multiple maximal observations');
  const selected = heads.length === 1 && heads[0].planRef?.path === `plans/${plan.id}.md` ? rows[observations.indexOf(heads[0])] : null;
  const invalid = findings.some(f => !f.startsWith('clock-anomaly')); 
  const forecast = selected ? { ...selected } : { asOf: null, earliestAt: null, latestAt: null, conditionalOn: [], unknowns: ['no unique current forecast'], stale: true, staleReasons: [] };
  if (invalid) { forecast.earliestAt = null; forecast.latestAt = null; forecast.stale = true; forecast.unknowns.push(...findings); }
  forecast.releaseEta = { earliestAt: forecast.scope?.verification === 'verified' ? forecast.earliestAt : null, latestAt: forecast.scope?.verification === 'verified' ? forecast.latestAt : null, evidenceStatus: forecast.scope?.verification ?? 'unverified' };
  const allPromises = [...(Array.isArray(baseline?.promises) ? baseline.promises : []), ...observations.flatMap(o => Array.isArray(o.promisesAdded) ? o.promisesAdded : [])], ids = new Set();
  const promiseRows = allPromises.map(p => {
    if (ids.has(p.id)) findings.push(`promise-conflict: ${p.id}`); ids.add(p.id);
    const delivered = delivery(p.criteriaRefs, p.id);
    return { ...p, ...delivered, status: !anomaly && !baselineErrors.length && utc(p.dueAt) !== null && delivered.deliveredAt !== null ? (utc(delivered.deliveredAt) <= utc(p.dueAt) ? 'met-on-time' : 'met-late') : anomaly || utc(p.dueAt) === null ? 'timing-unverified' : clock > utc(p.dueAt) ? 'overdue' : clock === utc(p.dueAt) ? 'due-now' : 'pending' };
  });
  const checkpoints = rows.filter(r => !anomaly && utc(r.checkpointAt) !== null && clock > utc(r.checkpointAt)).map(r => {
    const resolutions = resolutionsFor(r), timely = resolutions.some(x => x.status === 'met-on-time');
    return { observationRef: r.ref, at: r.checkpointAt, status: timely ? 'met-on-time' : resolutions.length ? 'missed' : 'timing-unverified', resolutions, reason: timely ? 'Verified timely publication resolves this checkpoint; older query reports remain unchanged.' : 'No trusted publication-time proof establishes an on-time subsequent update.' };
  });
  const missed = checkpoints.filter(c => c.status !== 'met-on-time');
  const progressAt = o => {
    try {
      const cut = getCut(o.outlook.basedOn);
      if (cut?.revision !== o.outlook.basedOn) return null;
      const progress = completion(cut, parsePlan(cut.read(o.planRef.path)), utc(o.outlook.asOf));
      const oldEvidence = evaluateTimeEvidence({ stateAtQ: cut, plan: parsePlan(cut.read(o.planRef.path)), now: o.outlook.asOf, clockMode: 'simulation' });
      return progress.errors.length ? null : JSON.stringify([...progress.rows.map(identity), ...oldEvidence.releaseEvidence.map(identity)].sort());
    } catch { return null; }
  };
  observations.forEach((o, i) => {
    const currentProgress = progressAt(o);
    const comparisons = (Array.isArray(o.parents) ? o.parents : []).map(ref => {
      const parents = observations.filter(p => identity(p.ref) === identity(ref));
      const priorProgress = parents.length === 1 ? progressAt(parents[0]) : null;
      return { parentRef: ref, status: currentProgress === null || priorProgress === null ? 'unknown' : currentProgress === priorProgress ? 'unchanged' : 'changed' };
    });
    rows[i].progressComparison = comparisons;
    if (comparisons.length && comparisons.every(c => c.status === 'unchanged')) findings.push(`unchanged-progress: ${o.ref?.path ?? i}: canonical evidence identities unchanged from cited parents; forecast refresh is not progress`);
    if (comparisons.some(c => c.status === 'unknown')) findings.push(`progress-comparison-unknown: ${o.ref?.path ?? i}: cited parent/comparison cut unavailable`);
  });
  if (selected) forecast.progressComparison = selected.progressComparison;
  if (minimum.deliveredAt === null && observations.some(o => o.outlook?.outcome?.state === 'delivered')) findings.push('delivery-unverified: forecast outcome/handoff completion does not prove usable release and trusted event time');
  if (canonicalPackagesAtQ?.some(p => p.status === 'ready')) findings.push('independent ready opportunities remain governed by readyPlan');
  const start = utc(baseline?.startedAt), deadline = utc(baseline?.deadline?.at);
  return { rootPlan: plan.time?.rootPlan ?? null, plan: plan.id, revision: stateAtQ.revision, observationRef: selected?.ref ?? null, history: rows, queriedAt: iso(clock), clockMode,
    elapsedSeconds: anomaly || baselineErrors.length || start === null || clock < start ? null : Math.floor((clock - start) / 1000), remainingSeconds: anomaly || baselineErrors.length || deadline === null ? null : Math.floor((deadline - clock) / 1000), deadline: baseline?.deadline?.at ?? null,
    budget: { ...minimum, status: deadline === null ? 'unspecified' : anomaly || baselineErrors.length ? 'timing-unverified' : minimum.deliveredAt !== null ? (utc(minimum.deliveredAt) <= deadline ? 'delivered-on-time' : 'delivered-late') : clock > deadline ? 'overdue' : clock === deadline ? 'due-now' : 'active' },
    forecast, progress: { completedHandoffs: current.rows, releaseEvidence: evidence.releaseEvidence, releases: evidence.releases, historicalDoneByObservation: evidence.historicalDoneByObservation }, checkpoint: { nextAt: selected?.checkpointAt ?? null, missed, resolved: checkpoints.filter(c => c.status === 'met-on-time') }, promises: promiseRows, findings: [...new Set([...findings, ...evidence.findings])],
    actions: [...(forecast.stale ? ['Publish a new evidence-based forecast through the existing lead workflow.'] : []), ...(missed.length ? ['Report retained checkpoint misses at this entry; no autonomous wake is implied.'] : []), 'Continue authorized ready work under existing readiness and quality gates.'] };
}
