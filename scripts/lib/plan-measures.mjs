// P-0006, P-0019, F-0012, F-0017, design/dispatch.md#measurements
import { realpathSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { git } from './git-plumbing.mjs';
import { parseHandoffs } from './handoff.mjs';
import { planPackageMap } from './plan.mjs';
import { projectPlanTime } from './plan-time.mjs';
import { batchesFrom } from '../decisions.mjs';

const stamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const iso = value => value === null ? null : new Date(value).toISOString();
const delta = (start, end) => start !== null && end !== null && end >= start ? (end - start) / 1000 : null;
const FIRST_PUB_MAX = 8;
const FIRST_PUB_CACHE = new Map();
const SHA = /^[0-9a-f]{40}$/;

const repoKey = repo => { try { return realpathSync(repo); } catch { return repo; } };
const touchLru = (map, key, value, max) => {
  map.delete(key);
  if (map.size >= max) map.delete(map.keys().next().value);
  map.set(key, value);
  return value;
};

function firstPublicationIndex(records, revision) {
  const rev = SHA.test(revision ?? '') ? revision : git(records, 'rev-parse', '--verify', `${revision}^{commit}`);
  const key = `${repoKey(records)}\0${rev}`;
  const cached = FIRST_PUB_CACHE.get(key);
  if (cached) return touchLru(FIRST_PUB_CACHE, key, cached, FIRST_PUB_MAX);
  const byPath = new Map();
  const raw = git(records, 'log', '--reverse', '--no-renames', '--format=%x00%cI', '--name-only', '--diff-filter=A', rev);
  for (const block of raw.split('\0')) {
    if (!block) continue;
    const lines = block.split(/\r?\n/).filter(Boolean);
    const date = lines[0];
    if (!date) continue;
    for (let i = 1; i < lines.length; i++) {
      let dates = byPath.get(lines[i]);
      if (!dates) { dates = []; byPath.set(lines[i], dates); }
      dates.push(date);
    }
  }
  return touchLru(FIRST_PUB_CACHE, key, byPath, FIRST_PUB_MAX);
}

export function firstPublication(state, path) {
  const dates = firstPublicationIndex(state.records, state.revision).get(path) ?? [];
  return dates.length === 1 ? stamp(dates[0]) : null;
}

export function executionInterval(state, handoff) {
  if (!handoff) return { start: null, end: null, seconds: null, unknowns: ['no committed handoff'] };
  const source = handoff.files.find(p => p.endsWith('.log.gz'));
  const recordedSeconds = Number.isFinite(handoff.agent?.seconds) && handoff.agent.seconds >= 0 ? handoff.agent.seconds : null;
  const unknowns = [];
  let start = null, end = null;
  if (source && state.files.has(source)) {
    try {
      const lines = gunzipSync(state.bytes(source)).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
      for (const r of lines) {
        const at = stamp(r.timestamp);
        if (at === null) continue;
        const p = r.type === 'event_msg' ? r.payload : null;
        if (start === null && (r.type === 'user' && !r.toolUseResult && !r.isMeta || p?.type === 'user_message')) start = at;
        if (r.type === 'result' && r.subtype === 'success' || p?.type === 'task_complete') end = at;
      }
    } catch (error) { unknowns.push(`${source}: cannot reconstruct timestamps (${error.message})`); }
  }
  if (delta(start, end) === null) unknowns.push('execution start/end unavailable; handoff time is not execution end');
  return { start, end, seconds: delta(start, end) ?? recordedSeconds, source: source ?? 'metrics/handoffs.jsonl agent.seconds', unknowns };
}

function settlement(batches, batch) {
  const seen = new Set();
  for (let b = batch; b && !seen.has(b.id); b = batches.find(other => other.id === b.replacedBy)) {
    seen.add(b.id);
    if (b.answers.length) return { answer: b.answers[0] };
    if (!b.replacedBy) return { open: true };
  }
  return {};
}

export function measurePlan(state, plan, { published = path => firstPublication(state, path), now = Date.now(), clockMode = 'live', canonicalPackagesAtQ, forecastHistory, historicalSnapshots } = {}) {
  if (typeof now === 'string') now = Date.parse(now);
  const handoffs = parseHandoffs(state.read('metrics/handoffs.jsonl'));
  const batches = batchesFrom([...state.files], state.read);
  const byRef = planPackageMap(plan);
  const measurements = new Map(plan.packages.map(p => {
    const h = handoffs.find(h => h.id === p.handoff && h.phase === plan.phase && state.files.has(h.record));
    return [p.id, { handoff: h, ...executionInterval(state, h) }];
  }));
  const paths = new Map(), visiting = new Set();
  function pathTo(id) {
    if (paths.has(id)) return paths.get(id);
    const p = byRef.get(id), m = measurements.get(id);
    if (!p || visiting.has(id)) return { seconds: null, path: [id] };
    visiting.add(id);
    const parents = [...new Set(p.needs.map(n => byRef.get(n)?.id).filter(depId => depId && depId !== id))].map(pathTo);
    visiting.delete(id);
    const known = m.seconds !== null && parents.every(parent => parent.seconds !== null);
    const longest = parents.reduce((best, parent) => (parent.seconds ?? 0) > (best.seconds ?? 0) ? parent : best, { seconds: 0, path: [] });
    const result = { seconds: known ? longest.seconds + m.seconds : null, path: [...longest.path, id] };
    paths.set(id, result);
    return result;
  }
  const totals = plan.packages.map(p => pathTo(p.id));
  const critical = totals.reduce((best, p) => (p.seconds ?? 0) > (best.seconds ?? 0) ? p : best, { seconds: 0, path: [] });
  const allKnown = totals.every(p => p.seconds !== null);
  const timed = [...measurements.values()];
  const elapsed = timed.length && timed.every(m => m.start !== null && m.end !== null)
    ? delta(Math.min(...timed.map(m => m.start)), Math.max(...timed.map(m => m.end))) : null;
  const publication = published(`plans/${plan.id}.md`);
  const batchIds = new Set(plan.packages.flatMap(p => p.needs).filter(n => /^B-\d{4}$/.test(n)));
  const owners = [...batchIds].map(id => {
    const { answer, open = false } = settlement(batches, batches.find(b => b.id === id));
    const sent = published(`owner/${id}.md`), answered = open ? Math.floor(now / 1000) * 1000 : stamp(answer?.time);
    return { batch: id, from: iso(sent), to: open ? null : iso(answered), open, seconds: delta(sent, answered),
      source: open ? 'batch first publication -> now (no answer yet)' : 'batch first publication -> committed answer event',
      unknowns: ['Actual owner-channel send/delivery is not recorded; publication is the send proxy.',
        ...(delta(sent, answered) === null ? ['missing or inconsistent publication/answer timestamp'] : [])] };
  });
  const idle = plan.packages.map(p => {
    const m = measurements.get(p.id), prerequisites = [publication];
    for (const need of p.needs) {
      const dep = byRef.get(need);
      if (dep) {
        const h = measurements.get(dep.id).handoff;
        prerequisites.push(h ? published(h.record) : null);
      } else if (/^B-/.test(need)) prerequisites.push(stamp(owners.find(b => b.batch === need)?.to));
    }
    const from = prerequisites.every(t => t !== null) ? Math.max(...prerequisites) : null;
    return { package: p.id, seconds: null, interval: { from: iso(from), to: iso(m.start) },
      dependencyAvailableWindowSeconds: delta(from, m.start),
      unknowns: ['Historical capacity, admission and launch acknowledgements are absent; this window is not proven dispatchable idle time.',
        ...(from === null ? ['dependency availability timestamp unavailable'] : []), ...m.unknowns] };
  });
  return { plan: plan.id, scope: plan.scope, revision: state.revision,
    time: projectPlanTime(state, plan, { now, clockMode, canonicalPackagesAtQ, forecastHistory, historicalSnapshots }),
    criticalPath: { seconds: allKnown ? critical.seconds : null, path: allKnown ? critical.path : null,
      elapsedSeconds: elapsed, definition: 'longest dependency path of recorded execution durations; excludes owner/capacity/recording delays',
      unknowns: timed.flatMap((m, i) => m.seconds === null ? [`${plan.packages[i].id}: duration unavailable`] : []) },
    idleDispatchable: { seconds: null, denominatorSeconds: null, intervals: idle,
      unknowns: ['No committed capacity/admission history; aggregate package-seconds and idle proportion are unknown.'] },
    ownerWaiting: { seconds: owners.length && owners.every(b => b.seconds !== null) ? owners.reduce((sum, b) => sum + b.seconds, 0) : null,
      intervals: owners, definition: 'sum of referenced batch publication-to-answer seconds, an open batch counted to now; overlapping waits are not elapsed owner time',
      unknowns: owners.length ? ['Channel send timestamps unavailable; sums use publication proxies.'] : ['The plan names no owner batch, so its owner waiting does not apply (n/a); the phase figure is in loop.mjs next.'] },
    execution: Object.fromEntries([...measurements].map(([id, m]) => [id, { from: iso(m.start), to: iso(m.end), seconds: m.seconds, source: m.source, unknowns: m.unknowns }])) };
}

export function renderMeasures(result) {
  const seconds = value => value === null ? 'unknown' : `${value} s`;
  return [`Plan ${result.plan} · ${result.scope} · records ${result.revision}`,
    `Critical-path work: ${seconds(result.criticalPath.seconds)}; observed execution elapsed: ${seconds(result.criticalPath.elapsedSeconds)}.`,
    'Idle dispatchable time: unknown (historical capacity, admission and launch acknowledgement timestamps unavailable).',
    result.ownerWaiting.intervals.length ? `Owner waiting time: ${seconds(result.ownerWaiting.seconds)} (batch publication to answer, or to now while open; actual channel send unknown).`
      : 'Owner waiting time: n/a (the plan names no owner batch; the phase figure is in loop.mjs next).',
    ...result.idleDispatchable.intervals.map(i => `  ${i.package}: candidate interval ${i.interval.from ?? 'unknown'} -> ${i.interval.to ?? 'unknown'}; idle seconds unknown.`),
    ...result.ownerWaiting.intervals.map(i => `  ${i.batch}: ${i.from ?? 'unknown'} -> ${i.open ? 'now, still open' : i.to ?? 'unknown'}; ${seconds(i.seconds)}${i.open ? ' and accruing' : ''}.`),
    ...result.criticalPath.unknowns.map(u => `Unknown: ${u}`),
    ...(result.time ? [
      `Time budget: ${result.time.budget?.status ?? 'unknown'}; root ${result.time.rootPlan}; elapsed ${seconds(result.time.elapsedSeconds)}; remaining ${seconds(result.time.remainingSeconds)}; deadline ${result.time.deadline ?? 'unspecified'}.`,
      `Delivery: ${result.time.budget?.evidenceStatus ?? 'unverified'}; at ${result.time.budget?.deliveredAt ?? 'timing-unverified'}; current availability ${result.time.budget?.currentAvailability ?? 'unverified'}.`,
      ...(result.time.checkpoint.resolved ?? []).map(m => `Checkpoint ${m.at}: ${m.status}.`),
      `Release ETA: ${result.time.forecast.releaseEta?.earliestAt ?? 'unknown'} -> ${result.time.forecast.releaseEta?.latestAt ?? 'unknown'}; scope ${result.time.forecast.releaseEta?.evidenceStatus ?? 'unverified'}.`,
      `Forecast arithmetic (conditional): ${result.time.forecast.earliestAt ?? 'unknown'} -> ${result.time.forecast.latestAt ?? 'unknown'}; ${result.time.forecast.stale ? 'stale' : 'conditional'}; next checkpoint ${result.time.checkpoint.nextAt ?? 'unknown'}.`,
      ...result.time.checkpoint.missed.map(m => `Checkpoint ${m.at}: ${m.status}.`),
      ...result.time.promises.map(p => `Promise ${p.id}: ${p.status} (${p.dueAt}).`),
      ...result.time.forecast.unknowns.map(u => `Time unknown: ${u}`),
      ...result.time.findings.map(f => `Time finding: ${f}`),
      ...result.time.actions.map(a => `Time action: ${a}`)
    ] : []),
    result.criticalPath.definition, result.ownerWaiting.definition].join('\n');
}
