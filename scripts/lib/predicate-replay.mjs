// F-0011, F-0012, F-0015, R-0008-judge-mechanisms, R-0054-reviewer-architecture, design/generative-engine.md#raised-first-replay
import { join } from "node:path";
import { normalize } from "../call.mjs";
import { openWords } from "../records-check.mjs";
import { alarms, parseRows, TRAJECTORY } from "../trajectory.mjs";
import { UsageError } from "./args.mjs";
import { FEATURE_EVENTS } from "./blueprint.mjs";
import { cadenceLines, cadenceOf, cadenceState } from "./cadence.mjs";
import { git } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { reconcilePlans as defaultReconcilePlans, snapshot } from "./plan.mjs";
import { measurePlan } from "./plan-measures.mjs";
import { stallThreshold } from "./thresholds.mjs";

const figure = value => value === null || value === undefined ? "unknown" : String(value);
const percent = share => share === null || share === undefined ? "unknown" : `${Math.round(share * 1000) / 10}%`;

function formatWaiting(w) {
  if (w.seconds === null) return `unknown (${w.unknowns.join("; ")})`;
  if (!w.batches) return "0 s (no owner batch sent in the phase)";
  return `${w.seconds} s over ${w.batches} owner batch${w.batches === 1 ? "" : "es"} of the phase${w.open.length ? `, ${w.open.join(", ")} still open and accruing` : ", none open"}`;
}

// F-0012
export function queryClock({ now, clockMode } = {}) {
  const mode = clockMode ?? (now === undefined ? "live" : "simulation");
  const at = now === undefined ? Date.now() : typeof now === "number" ? now : Date.parse(now);
  if (!["live", "simulation"].includes(mode) || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime()))
    throw new UsageError("query clock requires a valid time and live or simulation mode");
  return { now: at, clockMode: mode };
}

// F-0012
export function cliClock(args) {
  if (!("now" in args)) return queryClock();
  if (typeof args.now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(args.now) || !Number.isFinite(Date.parse(args.now)))
    throw new UsageError("--now must be a UTC ISO time with explicit Z");
  const at = Date.parse(args.now);
  if (new Date(at).toISOString().slice(0, 19) !== args.now.slice(0, 19)) throw new UsageError("--now must be a valid calendar time");
  return queryClock({ now: at, clockMode: "simulation" });
}

// F-0012
export function timeLines(time) {
  if (!time) return [];
  const seconds = n => n == null ? "unknown" : `${n} s`;
  const detail = value => typeof value === "string" ? value : JSON.stringify(value);
  const f = time.forecast ?? {}, c = time.checkpoint ?? {}, b = time.budget ?? {}, eta = f.releaseEta ?? {};
  const checkpointDue = c.nextAt && Date.parse(c.nextAt) === Date.parse(time.queriedAt) ? " · due now" : "";
  const remaining = time.remainingSeconds == null ? "unknown" : time.remainingSeconds < 0 ? `overdue by ${-time.remainingSeconds} s` : time.remainingSeconds === 0 ? "due now (0 s)" : `${time.remainingSeconds} s remaining`;
  return [
    `Time budget ${time.rootPlan} / ${time.plan} · queried ${time.queriedAt} · ${time.clockMode === "simulation" ? "read-only simulation" : "live clock"}`,
    `  Elapsed: ${seconds(time.elapsedSeconds)} · deadline: ${time.deadline ?? "unspecified"} · budget: ${remaining}`,
    `  Minimum delivery: ${b.status ?? "unknown"} · evidence: ${b.evidenceStatus ?? "unverified"} · delivered at: ${b.deliveredAt ?? "unknown (timing unverified)"} · current availability: ${b.currentAvailability ?? "unverified"}`,
    `  Usable-release ETA (scope ${eta.evidenceStatus ?? "unverified"}): earliest ${eta.evidenceStatus === "verified" ? eta.earliestAt ?? "unknown" : "unknown"} · latest ${eta.evidenceStatus === "verified" ? eta.latestAt ?? "unknown" : "unknown"}`,
    `  Conditional arithmetic diagnostic as of ${f.asOf ?? "unknown"}: earliest ${f.earliestAt ?? "unknown"} · latest ${f.latestAt ?? "unknown"} · ${f.stale === true ? "stale" : f.stale === false ? "not marked stale" : "freshness unknown"}`,
    ...(f.conditionalOn ?? []).map(x => `  Conditional on: ${detail(x)}`),
    ...(f.unknowns ?? []).map(x => `  Forecast uncertainty: ${detail(x)}`),
    ...(f.staleReasons ?? []).map(x => `  Stale reason: ${detail(x)}`),
    `  Next requested checkpoint: ${c.nextAt ?? "unknown"}${checkpointDue} (execution awaits an actual parent entry)`,
    ...(c.resolved ?? []).map(x => `  Resolved checkpoint history: ${detail(x)}`),
    ...(c.missed ?? []).map(x => `  Missed checkpoint history: ${detail(x)}`),
    ...(time.promises ?? []).map(x => `  Promise history: ${detail(x)}`),
    ...(time.history ?? []).map(x => `  Forecast history: ${detail(x)}`),
    ...(time.findings ?? []).map(x => `  Time finding: ${detail(x)}`),
    ...(time.actions ?? []).map(x => `  Suggested time action: ${detail(x)}`),
  ];
}

export function measuresLines({ metrics, problem, reconciled, cadence, now, clockMode, waitingText = formatWaiting }) {
  const clock = queryClock({ now, clockMode });
  const owner = metrics
    ? `owner directions ${figure(metrics.ownerDirections)} · raised first ${figure(metrics.raisedFirst)} · precision of batch answers ${percent(metrics.precision)} (${metrics.answersByOutcome["as-recommended"]} as-recommended of ${metrics.answeredWithOutcome} labelled) · owner waiting ${waitingText(metrics.ownerWaiting)}`
    : `owner directions unknown · raised first unknown · precision of batch answers unknown · owner waiting unknown (not computed: ${problem})`;
  const returns = cadence.state.returns.length ? "returns per area: listed below" : "returns per area: none (no judged adversarial round in the cadence window)";
  const lines = [`Measures (F-0011 item 7, F-0012 item 5; quote them in reports; no target, alarm or gate rests on them): ${owner} · ${returns} (owner-words.mjs metrics, lib/cadence.mjs)`];
  const measured = (reconciled?.plans ?? []).filter(p => p.result);
  if (!measured.length) lines.push("  no current plan of the phase: critical path unknown · idle dispatchable unknown (plan.mjs measure)");
  for (const { plan } of measured) {
    let m;
    try { m = measurePlan(reconciled.state, plan, clock); }
    catch (error) { lines.push(`  ${plan.id} (${plan.scope}): critical path unknown · idle dispatchable unknown · owner waiting unknown (not measured: ${error.message})`); continue; }
    const seconds = value => value === null || value === undefined ? "unknown" : `${value} s`;
    const waiting = m.ownerWaiting.intervals.length ? `owner waiting ${seconds(m.ownerWaiting.seconds)} on ${m.ownerWaiting.intervals.map(i => i.batch).join(", ")}` : "owner waiting n/a (the plan names no owner batch)";
    lines.push(`  ${plan.id} (${plan.scope}): critical path ${seconds(m.criticalPath.seconds)} · idle dispatchable ${seconds(m.idleDispatchable.seconds)} · ${waiting} (plan.mjs measure)`);
    lines.push(...timeLines(m.time).map(line => `  ${line}`));
  }
  return lines;
}

const unknownAt = why => ({ fires: null, evidence: [why] });
const rowsAt = ({ snap, phase }) => parseRows(snap.read(TRAJECTORY)).filter(r => r.phase === phase);
const trajectoryAlarm = type => ({
  path: "alarm", source: `trajectory.mjs alarms (${type})`, reads: [TRAJECTORY], clock: false,
  evaluate: ctx => {
    const found = alarms(rowsAt(ctx)).filter(a => a.type === type);
    return { fires: found.length > 0, evidence: found.length ? found.map(a => `${a.key}: ${a.message}`) : [`no ${type} alarm`] };
  },
});

export function createPredicates({ stallState = null, reconcilePlans = defaultReconcilePlans } = {}) {
  return Object.freeze({
    "stall": {
      path: "alarm", source: "loop.mjs stallState (tick)", clock: true,
      reads: ["blueprint/", FEATURE_EVENTS, HANDOFFS, TRAJECTORY, "owner/", "rounds/", "loop.json"],
      evaluate: (ctx, at) => {
        if (!ctx.cfg) return unknownAt("no usable loop.json in this records commit");
        if (!stallState || !ctx.state) return unknownAt("stall evaluator not configured");
        const result = stallState(ctx.cfg, ctx.state, stallThreshold(ctx.cfg.tick), at);
        return { fires: result.stalled, evidence: [result.line] };
      },
    },
    "advancing-round-due": {
      path: "next", source: "lib/cadence.mjs cadenceState", clock: false, reads: [HANDOFFS, TRAJECTORY, "rounds/", "loop.json"],
      evaluate: ctx => {
        if (!ctx.cfg) return unknownAt("no usable loop.json in this records commit");
        const setting = cadenceOf(ctx.cfg);
        const handoffs = parseHandoffs(ctx.snap.read(HANDOFFS)).filter(h => h.phase === ctx.phase && ctx.snap.files.has(h.record));
        const state = cadenceState({ handoffs, rows: rowsAt(ctx), adversarial: setting.adversarial, nextRound: 0 });
        return { fires: state.due, evidence: cadenceLines({ ...setting, state }, `${TRAJECTORY}, ${HANDOFFS}`).slice(0, 1) };
      },
    },
    "idle-packages": {
      path: "next", source: "lib/plan.mjs isIdle over readyPlan (A3)", clock: false,
      reads: ["plans/", HANDOFFS, "owner/", "rounds/", "decisions/", "purpose/", "blueprint/", "interventions/", "lessons/", "loop.json"],
      needs: { event: "a committed launch or acknowledgement event for each started package, and the measured capacity at reconciliation", feature: "F-0012" },
      evaluate: (ctx, at) => {
        if (!ctx.cfg) return unknownAt("no usable loop.json in this records commit");
        const reconciled = reconcilePlans(ctx.records, ctx.revision, ctx.phase, { host: { admits: true, over: [], calls: [] }, base: undefined, live: false, now: at });
        if (reconciled.problem) return unknownAt(reconciled.problem);
        return reconciled.idle.length
          ? unknownAt(`ready by the plan with no recorded start or hold: ${reconciled.idle.map(p => `${p.id} (${p.plan})`).join(", ")}; whether each was started or capacity held it is not in the records`)
          : { fires: false, evidence: ["every package of the current plans is done or held by its plan, an owner batch or a recorded hold"] };
      },
    },
    "open-words": {
      path: "next", source: "records-check.mjs openWords", clock: false, reads: [""],
      evaluate: ctx => {
        const open = openWords(ctx.records, ctx.revision);
        return { fires: open.length > 0, evidence: open.length ? open.map(w => w.id) : ["no open owner word"] };
      },
    },
    "area-rounds": trajectoryAlarm("area-rounds"),
    "blocker-recurring": trajectoryAlarm("blocker-recurring"),
    "partly-closed": trajectoryAlarm("partly-closed"),
    "ci-not-green": trajectoryAlarm("ci-not-green"),
    "ci-absent": trajectoryAlarm("ci-absent"),
  });
}

export const PREDICATES = createPredicates();

export function citedPredicates(text) {
  return Object.keys(PREDICATES).filter(id => new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(text ?? ""));
}

export function predicateContext(records, revision, phase, { recordsOf = null } = {}) {
  let snap, cfg, state;
  return {
    records, revision, phase,
    get snap() { return snap ??= snapshot(records, revision); },
    get cfg() {
      if (cfg === undefined) {
        cfg = null;
        const text = this.snap.read("loop.json");
        if (text) try { cfg = { ...normalize(JSON.parse(text), records), records, phase, configFile: join(records, "loop.json") }; } catch { cfg = null; }
      }
      return cfg;
    },
    get state() { return state ??= this.cfg && recordsOf ? recordsOf(this.cfg, revision) : null; },
  };
}

export function firstParentHistory(records, revision, { names = true } = {}) {
  return git(records, "log", "--first-parent", "--reverse", "--format=%x00%H %ct", ...(names ? ["--name-only"] : []), revision).split("\0").filter(Boolean).map(block => {
    const [head, ...paths] = block.split("\n").filter(Boolean);
    const [sha, seconds] = head.split(" ");
    return { sha, time: Number(seconds) * 1000, paths };
  });
}

export function predicateReplay(records, { revision = "HEAD", phase, from = null, cited, falseAlarms = true, stallState = null, recordsOf = null, reconcilePlans = defaultReconcilePlans, predicates = null } = {}) {
  const registry = predicates ?? (stallState || reconcilePlans !== defaultReconcilePlans ? createPredicates({ stallState, reconcilePlans }) : PREDICATES);
  const history = firstParentHistory(records, revision, { names: falseAlarms });
  const contexts = new Map();
  const contextAt = sha => { if (!contexts.has(sha)) contexts.set(sha, predicateContext(records, sha, phase, { recordsOf })); return contexts.get(sha); };
  const end = i => i + 1 < history.length ? history[i + 1].time - 1 : Date.now();
  const results = [], outPredicates = {};
  for (const id of [...new Set(cited.map(c => c.predicate))]) {
    const predicate = registry[id], entries = cited.filter(c => c.predicate === id);
    const touches = path => predicate.reads.some(r => r.endsWith("/") ? path.startsWith(r) : path === r);
    const keys = [];
    history.forEach((commit, i) => keys.push(i === 0 || !falseAlarms || commit.paths.some(touches) ? i : keys[i - 1]));
    const cache = new Map();
    const evaluate = (i, at) => {
      const key = predicate.clock ? `${keys[i]}@${at}` : keys[i];
      if (!cache.has(key)) {
        let result;
        try { result = predicate.evaluate(contextAt(history[keys[i]].sha), at); }
        catch (error) { result = unknownAt(`cannot be evaluated: ${error.message}`); }
        cache.set(key, result);
      }
      return cache.get(key);
    };
    const preWord = new Map(), summary = { path: predicate.path, source: predicate.source,
      cited: [...new Set(entries.map(e => e.intervention))], fired: [], notFired: [], unknown: [], ...(predicate.needs ? { needs: predicate.needs } : {}) };
    for (const entry of entries) {
      const at = Date.parse(entry.time);
      const i = Number.isFinite(at) ? history.findLastIndex(commit => commit.time < at) : -1;
      if (i < 0) {
        results.push({ ...entry, fires: null, snapshot: null, evidence: ["no records commit before the word"] });
        summary.unknown.push(entry.word);
        continue;
      }
      preWord.set(i, Math.min(preWord.get(i) ?? Infinity, at));
      const result = evaluate(i, at);
      results.push({ ...entry, fires: result.fires, snapshot: history[i].sha, evidence: result.evidence, ...(result.fires === null && predicate.needs ? { needs: predicate.needs } : {}) });
      summary[result.fires === true ? "fired" : result.fires === false ? "notFired" : "unknown"].push(entry.word);
    }
    if (falseAlarms) {
      const until = Math.max(...entries.map(e => Date.parse(e.time)).filter(Number.isFinite));
      const start = from && Number.isFinite(Date.parse(from)) ? Date.parse(from) : -Infinity;
      const episodes = [];
      let current = null, snapshots = 0, unknownSnapshots = 0;
      history.forEach((commit, i) => {
        if (commit.time < start || commit.time >= until) return;
        snapshots++;
        const result = evaluate(i, preWord.get(i) ?? Math.min(end(i), until - 1));
        if (result.fires !== true) { current = null; if (result.fires === null) unknownSnapshots++; return; }
        if (!current) episodes.push(current = { from: commit.sha, to: commit.sha, snapshots: 0, corrected: false });
        current.to = commit.sha;
        current.snapshots++;
        if (preWord.has(i)) current.corrected = true;
      });
      Object.assign(summary, { falseAlarms: episodes.filter(e => !e.corrected).length, episodes, snapshots, unknownSnapshots });
    }
    outPredicates[id] = summary;
  }
  return { results, predicates: outPredicates };
}
