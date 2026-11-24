#!/usr/bin/env node
// A view of what the phase's records and gates call for. Release observations go into the product Git directory.
// `self-loop.mjs` runs the same views for a product found through the owner store's registry, or for every product.
import { createHash } from "node:crypto";
import { normalOpportunities } from "./lib/normal-entry.mjs";
import { ALARM_DETECTOR_REVISION, buildAlarmContext, readNormalEntry } from "./lib/normal-entry-source.mjs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEAVY_ROLES, load, normalize, preparedIn, Stop } from "./call.mjs";
import { ANSWERS, batchesFrom } from "./decisions.mjs";
import { ALARMS, currentStall, parseAlarms } from "./lib/alarms.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { collectArchFacts, structuralBreaches } from "./lib/arch-facts.mjs";
import { FEATURE_EVENTS, inspectBlueprint } from "./lib/blueprint.mjs";
import { advancingAction, ARCH_STEP, cadenceLines, cadenceOf, cadenceState, dueReason, JUDGE_FRAME_STEP, outerCadenceOf, outerLoopLines, outerLoopState } from "./lib/cadence.mjs";
import { ciGreen, fullSha, judgeAccepted, receiptProblem } from "./lib/ci.mjs";
import { gatesOf } from "./lib/ci-receipt.mjs";
import { command, env, evidencePrefix, gatherCommand, node, shell } from "./lib/commands.mjs";
import { proseInTree } from "./lib/comments.mjs";
import { firings, undiagnosedAlarms } from "./lib/diagnosis.mjs";
import { blobs, git, gitOk, regularFiles, run } from "./lib/git-plumbing.mjs";
import { HANDOFFS, hasPhaseFrame, idOf, parseHandoffs } from "./lib/handoff.mjs";
import { isSubstantiveOwnerWord, MARKS, WORDS } from "./lib/owner-words.mjs";
import { hostLine } from "./lib/host.mjs";
import { phaseMetrics, waitingText } from "./lib/owner-metrics.mjs";
import { admitAcrossPlans, isIdle, LEAD_STEPS, planContext, plansFrom, readyPlan, snapshot, validatePlan } from "./lib/plan.mjs";
import { measurePlan } from "./lib/plan-measures.mjs";
import { hostLoad, REGISTRY, resolveOwnerStore } from "./lib/registry.mjs";
import { ssotNextSummary } from "./lib/ssot.mjs";
import { stallThreshold } from "./lib/thresholds.mjs";
import { tipCovers } from "./lib/tip.mjs";
import { independenceModel, modelVendor } from "./lib/vendor.mjs";
import { hasWindowDiagnosis, parseWindows, WINDOWS, windowState } from "./lib/window.mjs";
import { check, openWords, RUNGS } from "./records-check.mjs";
import { alarms, parseRows, TRAJECTORY } from "./trajectory.mjs";
import { reconcileReleases } from "./version-gate.mjs";

const pad = n => String(n).padStart(4, "0");
/** Records paths that may hold a gate receipt (suite-green.mjs). */
const evidenceJson = path => path.startsWith("evidence/") && path.endsWith(".json");
const relevant = path => /^(blueprint|decisions|owner|purpose|rounds)\/.*\.md$/.test(path) || /^sealed\/judge\/\d+\/judge(?:-[a-z]+)*-\d+\.md$/.test(path) || evidenceJson(path)
  || [ALARMS, ANSWERS, FEATURE_EVENTS, HANDOFFS, TRAJECTORY, WINDOWS, "loop.json", "records.json"].includes(path);

/** The committed records the views read, from the records HEAD. */
export function recordsOf(cfg, at = "HEAD") {
  const revision = fullSha(cfg.records, at);
  const entries = regularFiles(cfg.records, revision);
  const files = entries.map(e => e.path);
  const selected = entries.filter(e => relevant(e.path));
  const data = new Map(blobs(cfg.records, selected.map(e => e.sha)).map((bytes, i) => [selected[i].path, bytes.toString("utf8")]));
  const read = path => data.get(path) ?? "";
  const blueprint = inspectBlueprint(cfg.records, { files, read, product: { product: cfg.product, tip: cfg.branch } });
  const features = [...blueprint.features.values()].filter(f => f.phase === cfg.phase).map(f => ({ ...f, event: blueprint.latest.get(f.id) }));
  return { revision, files, read, blueprint, features, building: features.filter(f => f.event?.status === "building"),
    handoffs: parseHandoffs(read(HANDOFFS)), rows: parseRows(read(TRAJECTORY)), windows: parseWindows(read(WINDOWS), WINDOWS),
    batches: batchesFrom(files, read).filter(b => b.phase === cfg.phase) };
}

function nextRound(state, prepared) {
  const used = state.files.flatMap(path => {
    const match = /^rounds\/(\d+)-/.exec(path);
    return match ? [Number(match[1])] : [];
  });
  return Math.max(0, ...used, ...prepared.map(p => p.round), ...state.rows.map(r => r.round)) + 1;
}

const knownRuling = row => row.role === "judge" && row.verdict !== "-";
// design/round9-b.md#the-transition
import { blockerState as foldRulings, withStatus } from "./lib/blockers.mjs";
export function blockerState(rows) {
  const state = foldRulings(rows);
  const listed = status => withStatus(state, status).map(b => `${b.key} (R-${pad(b.round)})`);
  return { open: listed("open"), shelved: listed("shelved") };
}

function gateCommands(cfg, sha, round, managed) {
  const { suite, install = cfg.setup.map(argv => command(...argv)).join(" && "), format } = cfg.gates ?? {};
  const { remote, require } = gatesOf(cfg);
  const out = gate => evidencePrefix(cfg.records, round, gate, sha, managed);
  const suiteOptions = [...(install ? ["--install", install] : []), ...(format ? ["--format", format] : [])];
  const suiteCommand = node("suite-green.mjs", "--repo", cfg.product, "--sha", sha, "--out", out("suite"), ...suiteOptions);
  return { require, remote,
    suite: suiteCommand + " --command " + (suite ? shell(suite) : env("FULL_SUITE_COMMAND", "set the full suite command")) };
}

function recordedAfter(cfg, state, row) {
  const index = state.rows.indexOf(row);
  const lines = state.read(TRAJECTORY).split("\n");
  let line = 0;
  for (let seen = -1; line < lines.length; line++) if (lines[line] && ++seen === index) break;
  const commit = git(cfg.records, "blame", "--porcelain", "-L", `${line + 1},${line + 1}`, state.revision, "--", TRAJECTORY).slice(0, 40);
  const before = gitOk(cfg.records, "cat-file", "-e", `${commit}:${HANDOFFS}`)
    ? git(cfg.records, "show", `${commit}:${HANDOFFS}`).split("\n").filter(Boolean).length : 0;
  return new Set(state.handoffs.slice(before).map(h => h.id));
}

function checkouts(product) {
  const found = new Map();
  let path = null;
  for (const line of git(product, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/") && path) found.set(line.slice("branch refs/heads/".length), path);
  }
  return found;
}

export function integrationOf(cfg, state, handoffs, rows) {
  const { product } = cfg;
  const known = new Map();
  const ancestor = (a, b) => {
    if (a === b) return true;
    const key = `${a} ${b}`;
    if (!known.has(key)) known.set(key, gitOk(product, "merge-base", "--is-ancestor", a, b));
    return known.get(key);
  };
  const named = [...new Set([...rows.map(r => r.commit), ...handoffs.map(h => h.product?.commit)].filter(sha => /^[0-9a-f]{40}$/.test(sha ?? "")))];
  const found = new Set(named.length ? run("git", ["-C", product, "cat-file", "--batch-check=%(objectname) %(objecttype)"], { encoding: "utf8", input: named.join("\n") + "\n" })
    .split("\n").filter(line => line.endsWith(" commit")).map(line => line.split(" ")[0]) : []);
  const exists = sha => found.has(sha);
  const branch = cfg.branch ?? null;
  const branchHead = fullSha(product, branch ?? "HEAD");
  const row = rows.findLast(r => r.role === "judge" && r.commit !== "-") ?? null;
  const problems = [];
  let judged = row?.commit ?? null;
  if (judged && !exists(judged)) {
    problems.push(`the last judged commit ${judged} (round ${row.round}) is not a commit in ${product}`);
    judged = null;
  }
  let after = null;
  if (row) {
    try { after = recordedAfter(cfg, state, row); }
    catch (error) {
      after = new Set();
      problems.push(`the hand-offs recorded after the ruling of round ${row.round} cannot be read: ${error.message}`);
    }
  }
  const recorded = handoffs.filter(h => HEAVY_ROLES.includes(h.role) && h.product && (!after || after.has(h.id)) && exists(h.product.commit));
  const line = recorded.filter(h => !judged || ancestor(judged, h.product.commit));
  const points = [...new Set([...(judged ? [judged] : []), ...line.map(h => h.product.commit)])];
  const independent = new Set(points.length > 1 ? git(product, "merge-base", "--independent", ...points).split("\n").filter(Boolean) : points);
  const heads = points.filter(sha => independent.has(sha));
  const by = sha => sha === judged ? `the last judged commit, round ${row.round}` : line.findLast(h => h.product.commit === sha)?.id;
  const refs = [...new Set([branch, ...cfg.protected].filter(Boolean))]
    .filter(name => gitOk(product, "show-ref", "--verify", "--quiet", `refs/heads/${name}`))
    .map(name => ({ name, sha: fullSha(product, `refs/heads/${name}`) }));
  const tipsOf = base => refs.filter(ref => ref.sha !== base && ancestor(base, ref.sha) && tipCovers(product, base, ref.sha));
  const judgedTips = judged ? tipsOf(judged) : [];
  const result = { branch, branchHead, judged, row, problems, ancestor, heads: heads.map(sha => ({ sha, by: by(sha) })), judgedTips,
    recordedTip: judged && row.tip ? row.tip : null, tips: [] };
  if (!heads.length) return { ...result, sha: branchHead, source: `${branch ?? "HEAD"}: no judged commit or hand-off commit of the phase yet`, heads: [{ sha: branchHead, by: branch ?? "HEAD" }], relation: "at" };
  if (heads.length > 1) {
    const merge = branch && heads.every(head => ancestor(head, branchHead)) ? branchHead : null;
    return { ...result, sha: null, merge, relation: "heads" };
  }
  const sha = heads[0];
  const source = sha === judged ? `the last judged commit, round ${row.round}` : `${by(sha)}, recorded after ${row ? `the ruling of round ${row.round}` : "the phase began"}`;
  const tips = sha === judged ? judgedTips : tipsOf(sha);
  const relation = branchHead === sha ? "at" : tips.some(t => t.name === branch) ? "tip"
    : ancestor(branchHead, sha) ? "lags" : ancestor(sha, branchHead) ? "ahead" : "diverged";
  return { ...result, sha, source, tips, relation };
}

function convergence({ words, state, rows, cfg, target, integration, ci, suite, frame, ruling, judges, actors, pending, openAlarms, checkRecords, prose, cadence, ssot, win }) {
  const reasons = [];
  if (!frame) reasons.push(`phase frame (${HANDOFFS})`);
  if (win?.active) reasons.push(`open bounded window ${win.active.id} (${win.mode}) must be closed before phase convergence (${WINDOWS})`);
  if (cadence.state.due) reasons.push(`${dueReason(cadence)} (${TRAJECTORY}, ${HANDOFFS})`);
  if (pending.length) reasons.push("unrecorded prepared work (call.json)");
  if (words.length) reasons.push(`open words (${WORDS}, ${MARKS})`);
  if (state.blueprint.failures.length || !state.features.length || state.features.some(f => !["done", "retired"].includes(f.event?.status)))
    reasons.push(`unfinished or empty blueprint (${FEATURE_EVENTS})`);
  if (state.batches.some(b => !b.answered))
    reasons.push(`open owner batches: ${state.batches.filter(b => !b.answered).map(b => b.id).join(", ")} (${ANSWERS})`);
  if (!integration.sha) reasons.push(`one integration SHA: the phase's hand-off heads diverge (${HANDOFFS}); merge needed`);
  if (!suite) reasons.push("exact-SHA suite receipt (suite-green.mjs)");
  if (!ci?.ok) reasons.push("exact-SHA CI (next's own reading, ci-green.mjs)");
  if (ruling?.verdict !== "CONVERGED" || !/^[1-9]\d*\/0$/.test(ruling.suite))
    reasons.push(`judge convergence with a green suite count on ${target ?? "the integration SHA"} (${TRAJECTORY})`);
  const blockers = blockerState(rows).open;
  if (blockers.length) reasons.push(`open blockers: ${blockers.join(", ")} (${TRAJECTORY})`);
  if (!openAlarms || openAlarms.length) reasons.push(`alarms with no matching diagnosis (${HANDOFFS}, ${TRAJECTORY})`);
  if (checkRecords.failures.length)
    reasons.push(`records-check.mjs: ${checkRecords.failures.map(f => `${f.path} (${f.rule})`).join(", ")}`);
  if (prose.subtraction && (!prose.lines || prose.lines.length))
    reasons.push(`${prose.lines ? prose.lines.length : "unknown"} prose comment lines in the product tree at ${prose.sha ?? "the integration SHA"} (D-0016, since ${prose.subtraction.id})`);
  if (ssot?.convergenceReason) reasons.push(ssot.convergenceReason);

  const judge = judges.findLast(h => h.round === ruling?.round && h.product?.base === ruling.commit);
  if (ruling?.verdict === "CONVERGED") {
    if (!judge || !judgeAccepted(judge, { has: path => state.files.includes(path), read: state.read }))
      reasons.push(`ACCEPTANCE: pass needs confirmation (${judge?.record ?? TRAJECTORY})`);
    const actor = actors.findLast(h => integration.ancestor(h.product.commit, target));
    if (!modelVendor(judge?.agent) || !modelVendor(actor?.agent) || modelVendor(judge.agent) === modelVendor(actor.agent)
        || !independenceModel(judge.agent) || !independenceModel(actor.agent) || independenceModel(judge.agent) === independenceModel(actor.agent))
      reasons.push(`judge/actor independence needs confirmation (${HANDOFFS})`);
  }
  return reasons;
}

// F-0012, R-0008-judge-frame-dispatch, design/dispatch.md#ready-state
export function reconcilePlans(records, revision, phase, { host, base, live = true, now = Date.now() } = {}) {
  let state, plans;
  try { state = snapshot(records, revision); plans = plansFrom(state); }
  catch (error) { return { state: null, problem: `the plans cannot be read: ${error.message}`, plans: [], idle: [], unchecked: [] }; }
  const current = plans.filter(plan => plan.phase === phase && !plans.some(other => other.supersedes === plan.id)).toSorted((a, b) => a.id.localeCompare(b.id)).map(plan => {
    const errors = validatePlan(plan, state);
    if (errors.length) return { plan, errors };
    try {
      const context = live ? undefined : planContext(state, plan, { live: false });
      return { plan, result: readyPlan(state, plan, { host, base, now, ...(context ? { context } : {}) }) };
    } catch (error) { return { plan, problem: error.message }; }
  });
  admitAcrossPlans(current);
  const rowsWith = test => current.flatMap(({ plan, result }) => result ? result.packages.filter(test).map(row => ({ ...row, plan: plan.id })) : []);
  return { state, problem: null, plans: current, idle: rowsWith(isIdle), unchecked: rowsWith(row => row.unchecked) };
}

// F-0012, R-0008-judge-mechanisms, design/generative-engine.md#idle-packages-and-holds
export const idleSteps = row => row.command ? [row.command] : row.holds.filter(h => LEAD_STEPS.includes(h.kind)).map(h => `${h.kind}: ${h.target}; ${h.release}`);

function idleAction(reconciled) {
  const { idle } = reconciled;
  return { title: `${idle.length} package${idle.length === 1 ? "" : "s"} ready by the plan with no start and no recorded hold (A3, screening): ${idle.map(p => `${p.id} (${p.plan})`).join(", ")}`,
    steps: ["Start each now, or record why it waits: a revision of its plan whose package carries hold: <why> and release: <record IDs, owner batch IDs, capacity or ISO times, comma-separated, which next computes>. A release in words is not checked: it stays listed for review on every reading until the plan names a computable one. No minute threshold applies until a launch or acknowledgement event is recorded.",
      ...idle.flatMap(p => [`${p.id} (${p.handoff}, ${p.plan})${p.unheld ? `: its hold "${p.unheld.hold}" ${p.unheld.why}` : ""}${p.released ? `: its hold is released (${p.released.release})` : ""}:`,
        ...idleSteps(p).map(step => `  ${step}`)])] };
}

// R-0008-judge, design/round9-a.md#a-release-in-words
function wordedAction(reconciled) {
  const { unchecked } = reconciled;
  return { title: `${unchecked.length} release${unchecked.length === 1 ? "" : "s"} in words that no code can check, awaiting review (A3, screening): ${unchecked.map(p => `${p.id} (${p.plan})`).join(", ")}`,
    steps: [...unchecked.map(p => `${p.id} (${p.handoff}, ${p.plan}) waits "${p.unchecked.hold}" until "${p.unchecked.release}": ${p.unchecked.review}.`),
      "Each stays a wait; nothing is refused. Revise the plan with a computable release once the condition can be named, or start the package if the condition already holds."] };
}

function planActions(records, reconciled) {
  if (reconciled.problem) return [{ title: reconciled.problem, steps: [node("records-check.mjs", "--repo", records)] }];
  return reconciled.plans.flatMap(({ plan, errors, result, problem }) => {
    const query = node("plan.mjs", "ready", "--records", records, "--plan", plan.id);
    if (errors) return [{ title: `plan ${plan.id} does not validate`, steps: [...errors, node("plan.mjs", "validate", join(records, "plans", `${plan.id}.md`), "--records", records)] }];
    if (problem) return [{ title: `plan ${plan.id} cannot be reconciled: ${problem}`, steps: [query] }];
    const by = status => result.packages.filter(p => p.status === status);
    const waiting = by("waiting").filter(p => !p.idle);
    if (!by("ready").length && !by("waiting").length) return [];
    return [{
      title: `plan ${plan.id} (${plan.scope}): ${by("ready").length} ready, ${by("waiting").length} waiting, ${by("running").length} running, ${by("done").length} done`,
      steps: [...(result.idle.length ? [`Ready by the plan and not started: ${result.idle.join(", ")} (the A3 item above).`] : []),
        ...waiting.map(p => `${p.id} (${p.handoff}) waits: ${p.holds.map(h => `${h.kind} ${h.target}; release: ${h.release}${h.computed === false ? " (in words, not checked)" : ""}`).join(" · ")}`),
        "This reading reserves no capacity and records no launch.", query],
    }];
  });
}

// F-0011, R-0008-judge-mechanisms, design/generative-engine.md#intervention-dispositions
function dispositionAction(metrics) {
  const undisposed = metrics.interventions.filter(i => !i.disposed);
  return { title: `${undisposed.length} intervention${undisposed.length === 1 ? "" : "s"} without a disposition (A1, screening; nothing refuses on it): ${undisposed.map(i => i.id).join(", ")}`,
    steps: [...undisposed.map(i => `${i.id}: ${i.problems.join("; ")}`),
      `Append to each the lines rung: <${RUNGS.join(" | ")}> and carried-by: <the existing mechanism or admitted feature that carries its general question, or none: why none can>. A screening predicate is named by its id (${Object.keys(PREDICATES).join(", ")}); owner-words.mjs metrics replays it and reports whether it would have fired, which is coverage, never raised first (A2).`] };
}

// F-0011, F-0012, R-0008-judge-mechanisms, design/generative-engine.md#the-measures-header
const figure = value => value === null || value === undefined ? "unknown" : String(value);
const percent = share => share === null || share === undefined ? "unknown" : `${Math.round(share * 1000) / 10}%`;

// design/time-entry.md
export function queryClock({ now, clockMode } = {}) {
  const mode = clockMode ?? (now === undefined ? "live" : "simulation");
  const at = now === undefined ? Date.now() : typeof now === "number" ? now : Date.parse(now);
  if (!["live", "simulation"].includes(mode) || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime()))
    throw new UsageError("query clock requires a valid time and live or simulation mode");
  return { now: at, clockMode: mode };
}

// design/time-entry.md
export function cliClock(args) {
  if (!("now" in args)) return queryClock();
  if (typeof args.now !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(args.now) || !Number.isFinite(Date.parse(args.now)))
    throw new UsageError("--now must be a UTC ISO time with explicit Z");
  const at = Date.parse(args.now);
  if (new Date(at).toISOString().slice(0, 19) !== args.now.slice(0, 19)) throw new UsageError("--now must be a valid calendar time");
  return queryClock({ now: at, clockMode: "simulation" });
}

// design/time-entry.md
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

export function measuresLines({ metrics, problem, reconciled, cadence, now, clockMode }) {
  const clock = queryClock({ now, clockMode });
  const owner = metrics
    ? `owner directions ${figure(metrics.ownerDirections)} · raised first ${figure(metrics.raisedFirst)} · precision of batch answers ${percent(metrics.precision)} (${metrics.answersByOutcome["as-recommended"]} as-recommended of ${metrics.answeredWithOutcome} labelled) · owner waiting ${waitingText(metrics.ownerWaiting)}`
    : `owner directions unknown · raised first unknown · precision of batch answers unknown · owner waiting unknown (not computed: ${problem})`;
  const returns = cadence.state.returns.length ? "returns per area: listed below" : "returns per area: none (no judged adversarial round in the cadence window)";
  const lines = [`Measures (F-0011 item 7, F-0012 item 5; quote them in reports; no target, alarm or gate rests on them): ${owner} · ${returns} (owner-words.mjs metrics, lib/cadence.mjs)`];
  const measured = (reconciled?.plans ?? []).filter(p => p.result);
  if (!measured.length) lines.push(`  no current plan of the phase: critical path unknown · idle dispatchable unknown (plan.mjs measure)`);
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

// F-0011, R-0008-judge-mechanisms, design/generative-engine.md#raised-first-replay
const unknownAt = why => ({ fires: null, evidence: [why] });
const rowsAt = ({ snap, phase }) => parseRows(snap.read(TRAJECTORY)).filter(r => r.phase === phase);
const trajectoryAlarm = type => ({ path: "alarm", source: `trajectory.mjs alarms (${type})`, reads: [TRAJECTORY], clock: false,
  evaluate: ctx => {
    const found = alarms(rowsAt(ctx)).filter(a => a.type === type);
    return { fires: found.length > 0, evidence: found.length ? found.map(a => `${a.key}: ${a.message}`) : [`no ${type} alarm`] };
  } });

export const PREDICATES = Object.freeze({
  "stall": { path: "alarm", source: "loop.mjs stallState (tick)", clock: true,
    reads: ["blueprint/", FEATURE_EVENTS, HANDOFFS, TRAJECTORY, "owner/", "rounds/", "loop.json"],
    evaluate: (ctx, at) => {
      if (!ctx.cfg) return unknownAt("no usable loop.json in this records commit");
      const result = stallState(ctx.cfg, ctx.state, stallThreshold(ctx.cfg.tick), at);
      return { fires: result.stalled, evidence: [result.line] };
    } },
  "advancing-round-due": { path: "next", source: "lib/cadence.mjs cadenceState", clock: false, reads: [HANDOFFS, TRAJECTORY, "rounds/", "loop.json"],
    evaluate: ctx => {
      if (!ctx.cfg) return unknownAt("no usable loop.json in this records commit");
      const setting = cadenceOf(ctx.cfg);
      const handoffs = parseHandoffs(ctx.snap.read(HANDOFFS)).filter(h => h.phase === ctx.phase && ctx.snap.files.has(h.record));
      const state = cadenceState({ handoffs, rows: rowsAt(ctx), adversarial: setting.adversarial, nextRound: 0 });
      return { fires: state.due, evidence: cadenceLines({ ...setting, state }, `${TRAJECTORY}, ${HANDOFFS}`).slice(0, 1) };
    } },
  "idle-packages": { path: "next", source: "lib/plan.mjs isIdle over readyPlan (A3)", clock: false,
    reads: ["plans/", HANDOFFS, "owner/", "rounds/", "decisions/", "purpose/", "blueprint/", "interventions/", "lessons/", "loop.json"],
    needs: { event: "a committed launch or acknowledgement event for each started package, and the measured capacity at reconciliation", feature: "F-0012" },
    evaluate: (ctx, at) => {
      if (!ctx.cfg) return unknownAt("no usable loop.json in this records commit");
      const reconciled = reconcilePlans(ctx.records, ctx.revision, ctx.phase, { host: { admits: true, over: [], calls: [] }, base: undefined, live: false, now: at });
      if (reconciled.problem) return unknownAt(reconciled.problem);
      return reconciled.idle.length
        ? unknownAt(`ready by the plan with no recorded start or hold: ${reconciled.idle.map(p => `${p.id} (${p.plan})`).join(", ")}; whether each was started or capacity held it is not in the records`)
        : { fires: false, evidence: ["every package of the current plans is done or held by its plan, an owner batch or a recorded hold"] };
    } },
  "open-words": { path: "next", source: "records-check.mjs openWords", clock: false, reads: [""],
    evaluate: ctx => {
      const open = openWords(ctx.records, ctx.revision);
      return { fires: open.length > 0, evidence: open.length ? open.map(w => w.id) : ["no open owner word"] };
    } },
  "area-rounds": trajectoryAlarm("area-rounds"),
  "blocker-recurring": trajectoryAlarm("blocker-recurring"),
  "partly-closed": trajectoryAlarm("partly-closed"),
  "ci-not-green": trajectoryAlarm("ci-not-green"),
  "ci-absent": trajectoryAlarm("ci-absent"),
});

export function citedPredicates(text) {
  return Object.keys(PREDICATES).filter(id => new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(text ?? ""));
}

function predicateContext(records, revision, phase) {
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
    get state() { return state ??= this.cfg ? recordsOf(this.cfg, revision) : null; },
  };
}

function firstParentHistory(records, revision, { names = true } = {}) {
  return git(records, "log", "--first-parent", "--reverse", "--format=%x00%H %ct", ...(names ? ["--name-only"] : []), revision).split("\0").filter(Boolean).map(block => {
    const [head, ...paths] = block.split("\n").filter(Boolean);
    const [sha, seconds] = head.split(" ");
    return { sha, time: Number(seconds) * 1000, paths };
  });
}

export function predicateReplay(records, { revision = "HEAD", phase, from = null, cited, falseAlarms = true }) {
  const history = firstParentHistory(records, revision, { names: falseAlarms });
  const contexts = new Map();
  const contextAt = sha => { if (!contexts.has(sha)) contexts.set(sha, predicateContext(records, sha, phase)); return contexts.get(sha); };
  const end = i => i + 1 < history.length ? history[i + 1].time - 1 : Date.now();
  const results = [], predicates = {};
  for (const id of [...new Set(cited.map(c => c.predicate))]) {
    const predicate = PREDICATES[id], entries = cited.filter(c => c.predicate === id);
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
    predicates[id] = summary;
  }
  return { results, predicates };
}

const SUBTRACTION = /^reviewer-subtraction(?:-[a-z]+)*$/;
const SHOWN_PROSE = 10;

/** The phase's due actions as text, from the committed records and the gates. */
// design/dispatch.md#ready-state
export function integrationTarget(cfg, state = recordsOf(cfg)) {
  const managed = new Set(state.files);
  const integration = integrationOf(cfg, state, state.handoffs.filter(h => h.phase === cfg.phase && managed.has(h.record)), state.rows.filter(r => r.phase === cfg.phase));
  return integration.sha ?? integration.merge ?? null;
}

export function nextLines(cfg, config, state, { store = null, load: measured = null, now, clockMode } = {}) {
  const clock = queryClock({ now, clockMode });
  const { records, product, phase } = cfg;
  const managed = new Set(state.files);
  const handoffs = state.handoffs.filter(h => h.phase === phase && managed.has(h.record));
  const rows = state.rows.filter(r => r.phase === phase);
  const prepared = preparedIn(cfg);
  const pending = prepared.filter(p => (!p.phase || p.phase === phase) && !managed.has(p.record) && p.liveWorkspace);
  const abandoned = prepared.filter(p => (!p.phase || p.phase === phase) && !managed.has(p.record) && !p.liveWorkspace);
  const words = openWords(records, state.revision);
  const frame = hasPhaseFrame(handoffs, phase, path => managed.has(path));
  const workers = handoffs.filter(h => ["critic", "actor"].includes(h.role) && h.product);
  const actors = workers.filter(h => h.role === "actor");
  // D-0032, design/generative-engine-b.md#the-advancing-round
  const judges = handoffs.filter(h => h.role === "judge" && !JUDGE_FRAME_STEP.test(h.step));
  const rulings = rows.filter(knownRuling);
  const integration = integrationOf(cfg, state, handoffs, rows);
  const { branch, branchHead, ancestor } = integration;
  const target = integration.sha ?? integration.merge ?? null;
  const covered = new Map();
  const covers = sha => {
    if (!sha || !target) return false;
    if (!covered.has(sha)) covered.set(sha, sha === target || tipCovers(product, sha, target));
    return covered.get(sha);
  };
  const ruling = integration.sha ? rulings.findLast(r => covers(r.commit)) : null;
  const tipOf = sha => sha === integration.sha ? integration.tips.find(t => t.name === branch) ?? integration.tips[0] ?? null : null;
  const recordedTip = integration.sha && integration.sha === integration.judged ? integration.recordedTip : null;
  const ciSha = recordedTip ?? integration.tips.find(t => t.name === branch)?.sha ?? target;
  const ciSource = !ciSha ? null : ciSha === recordedTip ? "the VERSION tip the trajectory row records"
    : ciSha !== target ? `the VERSION tip on ${branch}` : integration.sha ? "the integration SHA" : `the merge on ${branch}, pending a hand-off on it`;
  const round = nextRound(state, prepared);
  const gates = target ? gateCommands(cfg, target, round, managed) : { ...gatesOf(cfg), suite: null };
  const ciGather = ciSha ? gatherCommand({ repo: product, remote: gates.remote, sha: ciSha, require: gates.require,
    out: evidencePrefix(records, round, "ci", ciSha, managed) }) : null;
  const status = node("blueprint.mjs", "status", "--records", records, "--phase", phase);
  const owner = node("owner-words.mjs", "open", "--records", records);
  const trajectory = join(records, TRAJECTORY);
  const stateCheck = check(records, { config: JSON.parse(state.read("records.json") || "{}") });
  const suite = target && state.files.filter(evidenceJson).find(path => {
    try { return !receiptProblem(JSON.parse(state.read(path)), product, target); } catch { return false; }
  });

  let ci;
  let ciDetail = "configure gates.require in loop.json";
  if (!ciSha) ciDetail = "no integration SHA until the diverged heads are merged";
  else if (gates.require) {
    try {
      ci = ciGreen({ repo: product, remote: gates.remote, sha: ciSha, require: gates.require });
      ciDetail = ci.missing.join(", ");
    } catch (error) { ciDetail = error.message; }
  }

  const host = measured ?? hostLoad({ store: store ?? resolveOwnerStore({ env: process.env }), cfg });
  const full = !host.admits;
  const waiting = `Waiting on the host load: ${host.over.join("; ")}. No new heavy call (critic, actor, judge or suite) is suggested until the host is back within the bound (maxLoadRatio and minAvailableMemoryGB in the owner store's ${REGISTRY}; D-0025).`;
  const callFor = (role, step = role, at = round) => {
    if (HEAVY_ROLES.includes(role) && full) return [waiting];
    if (role === "judge" && !target) return ["Waiting on the merge of the diverged heads: the judge runs on one integration SHA."];
    const task = join(cfg.workDir, "tasks", `${idOf(at, step)}.md`);
    const base = role === "judge" || (role === "reviewer" && ARCH_STEP.test(step) && target) ? ["--base", target] : [];
    const mode = step === role ? [] : ["--step", step];
    const prepare = cfg.agents[role]?.runner === "t3" ? ["--prepare"] : [];
    return [`Write task ${task} before calling. Include features: (IDs or none for the reviewer).`,
      node("call.mjs", config, role, "--round", at, ...mode, ...base, "--task", task, ...prepare)];
  };
  const setting = cadenceOf(cfg);
  const outerSetting = outerCadenceOf(cfg);
  const cadence = { ...setting, state: cadenceState({ handoffs, rows, adversarial: setting.adversarial, nextRound: round,
    prepared: pending.filter(p => p.phase === phase) }) };
  const outerBase = outerLoopState({ handoffs, rows, phase });
  const archBaseSha = outerBase.baseline?.product?.base ?? outerBase.baseline?.product?.commit ?? null;
  const validArchBase = archBaseSha && gitOk(product, "cat-file", "-e", `${archBaseSha}^{commit}`) ? archBaseSha : null;
  let archBreaches = [];
  if (target) {
    try {
      const facts = collectArchFacts(product, target, { baselineSha: validArchBase });
      archBreaches = structuralBreaches(facts);
    } catch { /* unreadable product tree stays empty */ }
  }
  const outer = outerLoopState({
    handoffs,
    rows,
    archBreaches,
    deliveries: outerSetting.deliveries,
    outerGrace: outerSetting.outerGrace,
    phase,
    targetSha: target,
  });
  const win = windowState({ windows: state.windows ?? parseWindows(state.read(WINDOWS), WINDOWS), handoffs, rows, phase, nextRound: round });
  const reconciled = state.files.some(path => /^plans\/PL-\d{4}\.md$/.test(path)) ? reconcilePlans(records, state.revision, phase, { host, base: target, now: clock.now }) : null;
  let metrics = null, metricsProblem = null;
  try { metrics = phaseMetrics(records, phase, { revision: state.revision, falseAlarms: false }); } catch (error) { metricsProblem = error.message; }
  const subtraction = handoffs.findLast(h => SUBTRACTION.test(h.step)) ?? null;
  const prose = { sha: target, subtraction, lines: null, problem: null };
  if (target) {
    try { prose.lines = proseInTree(product, target, { records: cfg.records }); } catch (error) { prose.problem = error.message; }
  } else prose.problem = "no integration SHA until the diverged heads are merged";

  const relationText = { at: "is at it", tip: "is at its VERSION tip", lags: "lags it", ahead: "is ahead of it by commits no hand-off records", diverged: "diverged from it",
    heads: integration.merge ? "merges every diverged head and becomes the integration SHA when a hand-off records on it" : "does not merge every diverged head" }[integration.relation];
  const lines = [`Phase ${phase} · ${branch ?? "HEAD"} at ${branchHead} (loop.json, product Git)`,
    `Integration SHA ${integration.sha ?? "none: merge needed"}${integration.sha ? ` (${integration.source})` : ""} · ${branch ?? "HEAD"} ${relationText} (${TRAJECTORY}, ${HANDOFFS}, product Git)`,
    `Records HEAD ${state.revision} · frame ${frame ? "recorded" : "missing"} · ${state.features.length} features, ${state.building.length} building, ${pending.length} prepared (${HANDOFFS}, ${FEATURE_EVENTS}, call.json)`];
  const shownTips = integration.sha && integration.sha !== integration.judged ? integration.tips : integration.judgedTips;
  const tipBase = integration.sha && integration.sha !== integration.judged ? integration.sha : integration.judged;
  const rowTip = tipBase === integration.judged ? integration.recordedTip : null;
  if (shownTips.length || rowTip)
    lines.push(`VERSION tips of ${tipBase === integration.judged ? "the judged commit " : ""}${tipBase}: ${[...(rowTip ? [`${rowTip} (recorded in the round ${integration.row.round} row)`] : []),
      ...shownTips.filter(t => t.sha !== rowTip).map(t => `${t.sha} (${t.name})`), ...shownTips.filter(t => t.sha === rowTip).map(t => `on ${t.name}`)].join(", ")} (D-0009 item 2)`);
  lines.push(`Load ${host.calls.length}: heavy calls on this host (critic, actor and judge calls, suites; shown, not the bound)`,
    ...host.calls.map(c => `  ${c.line}`), ...host.problems.map(p => `  not read: ${p}`), ...host.retired.map(p => `  ${p}`),
    `Host ${host.admits ? "within" : "over"} the bound: ${hostLine(host.measured, host.bound)}`);
  const shelvedBlockers = blockerState(rows).shelved;
  if (shelvedBlockers.length) lines.push(`Shelved blockers (known limits, not open): ${shelvedBlockers.join(", ")} (${TRAJECTORY})`);
  lines.push(prose.lines ? `Prose comments at ${prose.sha}: ${prose.lines.length} (D-0016, lib/comments.mjs) · ${subtraction ? `a convergence condition since ${subtraction.id}` : "a convergence condition once the phase records a reviewer-subtraction hand-off"}`
    : `Prose comments not counted: ${prose.problem}`);
  lines.push(...measuresLines({ metrics, problem: metricsProblem, reconciled, cadence, ...clock }));
  lines.push(...cadenceLines(cadence, `${TRAJECTORY}, ${HANDOFFS}`));
  lines.push(...outerLoopLines(outer));
  if (win.active) {
    lines.push(`Window: ${win.active.id} (${win.mode} · ${win.usedActorRounds}/${win.active.horizon} actor rounds · end round ${win.endRound}) · goal: ${win.active.goal} (${WINDOWS})`,
      `  Invariants: ${win.active.invariants.join("; ")}`);
  }
  let openAlarms = null, alarmGateError = null;
  try { openAlarms = undiagnosedAlarms(records, state.revision, phase); }
  catch (error) { alarmGateError = error; }
  let stalled = null, stallError = null;
  try { stalled = liveStall(cfg, state); }
  catch (error) { stallError = error; }
  try {
    const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(k => [k, v[k]])) : v);
    const alarmContext = buildAlarmContext({ records, revision: state.revision, phase,
      detectorRevision: ALARM_DETECTOR_REVISION,
      trajectory: { validation: alarmGateError ? "unknown" : "valid", firings: firings(state.rows),
        undiagnosedKeys: (openAlarms ?? []).map(a => a.key) },
      stall: { validation: stallError ? "unknown" : "valid", currentKey: stalled?.key ?? null } });
    const normal = normalOpportunities(readNormalEntry({ records, revision: state.revision, phase, alarmContext,
      cadence: { due: cadence.state.due, stateIdentity: createHash("sha256").update(canonical(cadence.state)).digest("hex") },
      blockers: blockerState(rows) }));
    lines.push(`Normal opportunities: ${normal.state}`,
      ...normal.items.map(item => `  ${item.version} ${item.status}/${item.reason}`),
      ...(normal.alarmStates ?? []).map(row => `  alarm ${row.version}: ${row.applicability}/${row.diagnosis} (${row.reason}); occurrence ${row.occurrenceId ?? "unknown"}; identity ${row.identityBasis}; cut ${row.evaluatedAtCut}; successor ${row.successorOccurrenceId ?? "none"}`),
      ...normal.coverage.map(row => `  coverage ${row.family}: ${row.availability}/${row.completeness} (${row.reason})`),
      ...normal.diagnostics.map(row => `  diagnostic ${row.scope}/${row.code}: ${row.subject}`));
  } catch {
    lines.push("Normal opportunities: unknown", "  diagnostic projection/projection_failed");
  }
  lines.push("  Source: evidence/normal-entry/manifest.json; repair missing or invalid committed public inputs and explicit dispositions. Structural accounting grants no task authority.");
  const header = lines.length;
  const action = (title, source, ...steps) => lines.push("", `- ${title} [${source}]`, ...steps.map(s => `  ${s}`));

  if (gitOk(product, "cat-file", "-e", `${branchHead}:scripts/version-gate.mjs`) && gitOk(product, "cat-file", "-e", `${branchHead}:VERSION`)) {
    try {
      const branches = [...new Set([branch, ...cfg.protected].filter(Boolean))];
      for (const finding of reconcileReleases(product, gates.remote, branches)) {
        const name = finding.ref.slice("refs/heads/".length);
        action(`unattested remote tip: ${finding.ref} at ${finding.sha}`, "release gate receipts and remote Git refs",
          "Confirm who pushed and cite a committed owner word or decision after matching it to this update.",
          "From the product checkout, run " + node("version-gate.mjs", "reconcile", "--remote", gates.remote,
            "--branch", name, "--records", records, "--close", finding.id) + " --cite " + env("PUSH_AUTHORIZATION", "set the matching owner word or decision ID"));
      }
    } catch (error) { action(`release gate receipts could not be checked: ${error.message}`, "remote Git refs"); }
  }

  if (cadence.state.due) {
    const { title, steps } = advancingAction(cadence, callFor);
    action(title, `${TRAJECTORY}, ${HANDOFFS}, loop.json, D-0032`, ...steps);
  }
  if (outer.status === "async-due") {
    const triggers = [...(outer.t1Due ? ["T1"] : []), ...(outer.t3Due ? ["T3"] : [])].join("/");
    action(
      `Outer loop due asynchronously (${triggers}): run read-only reviewer-architecture in parallel on ${target ?? branchHead}; in-flight inner-loop work may finish; hard-blocks new actor after ${outer.graceRemaining} more deliveries`,
      `${HANDOFFS}, lib/cadence.mjs, lib/arch-facts.mjs`,
      ...outer.archBreaches.map(b => `Structural breach (${b.kind}): ${b.path} (${b.detail})`),
      ...callFor("reviewer", "reviewer-architecture", round),
    );
  } else if (outer.status === "hard-due") {
    const triggers = [...(outer.t1Due ? ["T1"] : []), ...(outer.t3Due ? ["T3"] : [])].join("/");
    action(
      `Outer loop hard-due (${triggers}): new actor calls are mechanically blocked (exit 7) until reviewer-architecture commits`,
      `${HANDOFFS}, lib/cadence.mjs, lib/arch-facts.mjs`,
      ...outer.archBreaches.map(b => `Structural breach (${b.kind}): ${b.path} (${b.detail})`),
      ...callFor("reviewer", "reviewer-architecture", round),
    );
  }
  for (const p of pending)
    action(`unrecorded prepared workspace ${p.id}${p.phase ? "" : " (phase unverified)"}`, join(p.ws, "call.json"),
      "Record after the child has finished. Use its provider-native session ID.",
      node("call.mjs", config, "record", "--ws", p.ws) + " --session " + env("PROVIDER_SESSION", "set the child provider session ID"));
  for (const p of abandoned)
    action(`unrecorded prepared workspace ${p.id} lost its ${p.role === "reviewer" ? "workspace" : "worktree"}`, join(p.ws, "call.json"),
      "Review the attempt evidence before preparing a retry.", node("records-check.mjs", "--repo", records));
  if (reconciled?.idle.length) {
    const { title, steps } = idleAction(reconciled);
    action(title, `plans/, ${HANDOFFS}, prepared call.json, call leases, D-0025`, ...steps);
  }
  if (reconciled?.unchecked.length) {
    const { title, steps } = wordedAction(reconciled);
    action(title, "plans/, R-0008-judge", ...steps);
  }
  if (reconciled)
    for (const { title, steps } of planActions(records, reconciled)) action(title, `plans/, ${HANDOFFS}, prepared call.json, D-0025`, ...steps);
  if (metrics?.interventions.some(i => !i.disposed)) {
    const { title, steps } = dispositionAction(metrics);
    action(title, "interventions/, RECORDS.md", ...steps);
  }
  const substantiveWords = words.filter(w => isSubstantiveOwnerWord(w.text));
  if (words.length)
    action(`${words.length} open owner words`, `${WORDS}, ${MARKS}`,
      owner, "Cite each distilled word in a record or mark it with a reason.",
      node("owner-words.mjs", "mark", "--records", records, "--id", words[0].id) + " --as " + env("MARK_AS", "set routine or not-owner") + " --note " + env("MARK_REASON", "set the reason"),
      ...(substantiveWords.length ? [
        `${substantiveWords.length} substantive open owner word(s) (${substantiveWords.map(w => w.id).join(", ")}): run async reviewer-distill to distill verbatim words into purpose/decisions/design with first-principles derivation and generalization (blocks further actor calls after 1-turn grace):`,
        ...callFor("reviewer", "reviewer-distill", round),
      ] : []));
  if (!frame) action("no phase frame", HANDOFFS, ...callFor("reviewer", "reviewer-frame"));

  const unclassified = state.features.filter(f => !f.event);
  if (unclassified.length)
    action(`features without status: ${unclassified.map(f => f.id).join(", ")}`, FEATURE_EVENTS, status,
      ...unclassified.map(f => node("blueprint.mjs", "set", "--records", records, "--feature", f.id) + " --status " +
        env("FEATURE_STATUS", "choose the recorded status") + " --by lead --note " + env("FEATURE_NOTE", "explain the status")));
  const named = new Set(pending.filter(p => p.phase === phase).flatMap(p => p.features ?? []));
  const idle = state.building.filter(f => !named.has(f.id));
  if (win.mode === "slack") {
    action(
      `bounded window ${win.active.id} (slack: ${win.usedActorRounds}/${win.active.horizon} actor rounds used, ${win.remainingSlack} slack round(s) remaining before convergence round ${win.endRound})`,
      WINDOWS,
      `Goal: ${win.active.goal}`,
      `Invariants for close: ${win.active.invariants.join("; ")}`,
      "Intermediate critic, suite-green, CI and judge checks are deferred during slack rounds. Run the next actor refactoring round:",
      ...callFor("actor", "actor", round));
  } else if (win.mode === "converging") {
    action(
      `bounded window ${win.active.id} (converging: final actor round ${win.endRound}, ${win.usedActorRounds}/${win.active.horizon} actor rounds used)`,
      WINDOWS,
      `Goal: ${win.active.goal}`,
      `Invariants for close: ${win.active.invariants.join("; ")}`,
      `Round ${win.endRound} is the final budgeted round of ${win.active.id}; bring the tree to green completeness for mandatory critic, judge, suite-green and CI verification:`,
      ...callFor("actor", "actor", round));
  } else if (idle.length)
    action(`building features without a recorded running call: ${idle.map(f => f.id).join(", ")}`, `${FEATURE_EVENTS}, prepared call.json`,
      ...(cadence.state.due ? [`The advancing round ${cadence.state.next.round} above runs alongside: prepare a critic here only for a feature whose direction is settled and whose area is not under review (D-0032 item 1).`] : []),
      "Check live calls before starting work. Prepare the next critic task for the selected features.",
      ...callFor("critic", "critic", cadence.state.due ? Math.max(round, cadence.state.next.round + 1) : round));

  const places = checkouts(product);
  const inBranch = (...steps) => places.has(branch)
    ? steps.map(argv => command("git", "-C", places.get(branch), ...argv)).join(" && ")
    : [command("git", "-C", product, "switch", branch), ...steps.map(argv => command("git", "-C", product, ...argv))].join(" && ");
  const integrationSource = `${TRAJECTORY}, ${HANDOFFS}, product Git ancestry`;
  for (const problem of integration.problems) action(`the integration SHA is read without part of the records: ${problem}`, integrationSource, node("records-check.mjs", "--repo", records));
  const protectedTip = integration.tips.find(t => t.name !== branch && cfg.protected.includes(t.name)) ?? null;
  if (branch && integration.relation === "heads") {
    const missing = integration.heads.filter(h => !ancestor(h.sha, branchHead));
    action(`merge needed: the phase's hand-off heads diverge: ${integration.heads.map(h => `${h.sha} (${h.by})`).join(", ")}`, integrationSource,
      ...(missing.length ? ["Merge them into the integration branch:", inBranch(["merge", "--no-edit", ...missing.map(h => h.sha)])]
        : [`${branch} at ${branchHead} merges them.`]),
      "The merge becomes the integration SHA when the next hand-off records on it (the suite, CI and judge below run on it).");
  } else if (branch && integration.relation === "lags") {
    const to = protectedTip && ancestor(branchHead, protectedTip.sha) ? protectedTip : null;
    action(`${branch} at ${branchHead} lags the integration SHA ${integration.sha} (${integration.source})`, integrationSource,
      `Fast-forward it${to ? ` to the VERSION tip ${to.sha} on ${to.name}` : ""}; next only reads:`, inBranch(["merge", "--ff-only", to?.sha ?? integration.sha]));
  } else if (branch && integration.relation === "diverged") {
    action(`${branch} at ${branchHead} diverged from the integration SHA ${integration.sha} (${integration.source})`, integrationSource,
      "Merge the integration SHA into it; the merge becomes the integration SHA when the next hand-off records on it:",
      inBranch(["merge", "--no-edit", integration.sha]));
  } else if (branch && integration.relation === "ahead") {
    action(`${branch} at ${branchHead} is ahead of the integration SHA ${integration.sha} by commits no hand-off records`, integrationSource,
      `They become the integration SHA when a hand-off records on them; the suite, CI and judge stay on ${integration.sha}.`);
  }
  if (branch && protectedTip && integration.relation !== "lags" && !ancestor(protectedTip.sha, branchHead))
    action(`${protectedTip.name} holds the VERSION tip ${protectedTip.sha} of the integration SHA and ${branch} does not contain it`, `${integrationSource}, D-0009 item 2`,
      "Bring it into the integration branch so the next protected push stays a fast-forward:",
      inBranch(["merge", ancestor(branchHead, protectedTip.sha) ? "--ff-only" : "--no-edit", protectedTip.sha]));
  if (branch && places.has(branch) && !gitOk(places.get(branch), "diff-index", "--cached", "--quiet", "HEAD"))
    action(`the checkout ${places.get(branch)} of ${branch} has an index that differs from ${branchHead}`, "product Git worktrees",
      "call.mjs moves the ref by compare-and-swap and never rewrites a checkout, so the index lags a moved ref (or holds staged changes). Reconcile it before editing or committing there:",
      command("git", "-C", places.get(branch), "status", "--short"));

  const lineHeads = target ? [target] : integration.heads.map(h => h.sha);
  for (const h of workers) {
    const sha = h.product.commit;
    if (sha === h.product.base || lineHeads.some(head => ancestor(sha, head))) continue;
    if (!branch) {
      action(`${h.role} commit not merged: ${sha} (${h.id})`, `${HANDOFFS}, loop.json`,
        "Configure the integration branch before merging.", command("git", "-C", product, "show", "--stat", sha));
    } else {
      action(`${h.role} commit not merged: ${sha} (${h.id})`, `${HANDOFFS}, product Git ancestry`, inBranch(["merge", "--no-edit", sha]));
    }
  }
  if (!target) action("the suite, CI and judge wait on the merge of the diverged heads", integrationSource);
  else if (win.mode !== "slack" && win.mode !== "converging") {
    if (!suite) action("no suite-green receipt for the integration head", "suite-green.mjs, evidence/", full ? waiting : gates.suite);
    if (!ci?.ok) action(`CI not green on the integration head: ${ciDetail}`, `next's own reading on ${ciSha} (${ciSource}), loop.json`, ciGather);
    if (!ruling && !judges.some(h => covers(h.product?.base))) action("no judge ruling on the integration head", `${HANDOFFS}, ${TRAJECTORY}`, ...callFor("judge"));
  }
  if (win.mode === "gate-due") {
    action(
      `bounded window ${win.active.id} gate due (${win.usedActorRounds}/${win.active.horizon} actor rounds spent; further actor calls are mechanically refused until closed)`,
      WINDOWS,
      `Goal: ${win.active.goal}`,
      `Invariants: ${win.active.invariants.join("; ")}`,
      "Complete mandatory verification (suite-green, CI if configured, critic, different-vendor judge) and close the window:",
      node("window.mjs", "close", "--records", records, "--id", win.active.id, "--verdict", "verified", "--commit", target ?? "<integration-sha>", "--config", config));
  }
  if (win.alarm && !hasWindowDiagnosis({ records, revision: state.revision, handoffs, read: state.read, files: managed, phase, open: win.active })) {
    action(
      `window horizon alarm needs diagnosis: ${win.alarm.key}`,
      `${WINDOWS}, ${TRAJECTORY}`,
      win.alarm.message,
      `Put this line in the diagnosis task: alarms: ${win.alarm.key}`,
      ...callFor("reviewer", "reviewer-diagnosis"),
      node("window.mjs", "close", "--records", records, "--id", win.active.id, "--verdict", "reframed"));
  }
  for (const h of judges) {
    const sha = h.product?.base;
    if (!sha || rulings.some(row => row.round === h.round && row.commit === sha)) continue;
    // The append reads CI itself, once, in the loop that owns the ledger (D-0015 item 1): nothing about CI is passed.
    // D-0009 item 2: a head that adds only VERSION to the ruled SHA is the pushed tip, and the row names both.
    const pushed = tipOf(sha);
    const tip = pushed ? ["--tip", pushed.sha] : [];
    const append = node("trajectory.mjs", "append", "--file", trajectory, "--round", h.round, "--phase", phase, "--role", "judge", "--commit", sha, ...tip);
    const fields = [["area", "JUDGE_AREA"], ["verdict", "JUDGE_VERDICT"], ["opened", "BLOCKERS_OPENED"], ["closed", "BLOCKERS_CLOSED"], ["suite", "JUDGE_SUITE"]]
      .map(([flag, name]) => ` --${flag} ${env(name, "set from the ruling")}`).join("");
    action(`ruling not in the trajectory: ${h.id}`, tip.length ? `${h.record}, D-0009 item 2` : h.record,
      "Read the ruling and fill in its exact findings. The append reads the CI of the pushed SHA and saves the receipt; a CONVERGED row needs it green.",
      append + fields);
  }
  if (alarmGateError) action(`the alarm gate cannot be computed: ${alarmGateError.message}`, `${TRAJECTORY}, ${HANDOFFS}`, node("records-check.mjs", "--repo", records));
  if (openAlarms?.length)
    action(`alarms need diagnosis: ${openAlarms.map(a => a.key).join(", ")}`, `${TRAJECTORY}, lib/diagnosis.mjs`,
      ...openAlarms.map(a => `${a.key}: ${a.message}`), node("trajectory.mjs", "alarms", "--file", trajectory),
      `Put this line in the diagnosis task: alarms: ${openAlarms.map(a => a.key).join(", ")}`, ...callFor("reviewer", "reviewer-diagnosis"));
  if (subtraction && prose.lines?.length)
    action(`${prose.lines.length} prose comment lines remain at ${prose.sha} after ${subtraction.id}`, "D-0016, lib/comments.mjs",
      ...prose.lines.slice(0, SHOWN_PROSE).map(p => `${p.path}:${p.line}: ${p.text}`),
      ...(prose.lines.length > SHOWN_PROSE ? [`and ${prose.lines.length - SHOWN_PROSE} more`] : []),
      "An actor moves what they say into the records or design and leaves pointers; the judge confirms nothing is lost.");
  const ssot = Object.hasOwn(cfg, "ssot") && target ? ssotNextSummary(cfg, resolve(config), target) : null;
  if (ssot?.action) action(ssot.action.title, "loop.json (ssot), ssot-check.mjs", ...ssot.action.steps);

  const reasons = convergence({ words, state, rows, cfg, target, integration, ci, suite, frame, ruling, judges, actors, pending, openAlarms, checkRecords: stateCheck, prose, cadence, ssot, win });
  if (stallError) lines.splice(header, 0, "", `- the alarm ledger cannot be read: ${stallError.message} [${ALARMS}]`, `  ${node("records-check.mjs", "--repo", records)}`);
  if (stalled)
    lines.splice(header, 0, "", `- stall alarm raised ${stalled.time}: no recorded phase activity since ${stalled.since} (${stalled.source}) [${ALARMS}]`,
      `  Resume the phase or record why it waits; ${node("loop.mjs", "stall", "--hours", stalled.threshold, "--config", config)}`);
  if (reasons.length) action("convergence conditions not met", "SKILL.md convergence gates", ...reasons, status,
    node("decisions.mjs", "status", "--records", records, "--phase", phase), node("records-check.mjs", "--repo", records));
  else lines.push("", "The recorded convergence checks are satisfied. Confirm the ruling and acceptance before claiming convergence.");
  return lines.join("\n");
}

/**
 * The latest recorded activity of the phase: a blueprint event, hand-off, judge ruling or batch answer; with none, the
 * last commit of the configuration, else the last records commit other than the driver's own alarms.
 */
export function lastActivity(cfg, state) {
  const activities = [
    ...state.features.filter(f => f.event).map(f => ({ time: f.event.time, source: FEATURE_EVENTS })),
    ...state.handoffs.filter(h => h.phase === cfg.phase).map(h => ({ time: h.time, source: `${HANDOFFS} (${h.id})` })),
    ...state.rows.filter(r => r.phase === cfg.phase && knownRuling(r)).map(r => ({ time: r.time, source: `${TRAJECTORY} (round ${r.round})` })),
    ...state.batches.flatMap(b => b.answers.map(a => ({ time: a.time, source: `${ANSWERS} (${b.id})` }))),
    ...(state.windows ?? []).filter(w => w.phase === cfg.phase).map(w => ({ time: w.type === "open" ? w.openedAt : w.closedAt, source: `${WINDOWS} (${w.id} ${w.type})` })),
  ];
  return activities.filter(a => Number.isFinite(Date.parse(a.time))).reduce((latest, a) =>
    !latest || Date.parse(a.time) > Date.parse(latest.time) ? a : latest, null)
    ?? { time: git(cfg.records, "log", "-1", "--format=%cI", state.revision, "--", "loop.json")
        || git(cfg.records, "log", "-1", "--format=%cI", state.revision, "--", ".", `:(exclude)${ALARMS}`)
        || git(cfg.records, "show", "-s", "--format=%cI", state.revision),
      source: "phase configuration or records HEAD" };
}

/**
 * The committed stall alarm of the phase's current idle period, or null: the alarm whose key is this phase and the last
 * recorded activity, the identity `tick` writes it under. New activity or another phase ends it. Throws on a malformed
 * ledger.
 */
export const liveStall = (cfg, state) => currentStall(parseAlarms(state.read(ALARMS)), cfg.phase, lastActivity(cfg, state).time);

/** Whether the phase stalled: unfinished work (or no features) and no recorded activity for `hours`. */
export function stallState(cfg, state, hours, now = Date.now()) {
  const unsettled = state.features.filter(f => !["done", "retired"].includes(f.event?.status));
  if (state.features.length && !unsettled.length)
    return { stalled: false, settled: true, unsettled: [], line: `Phase ${cfg.phase}: all features settled (${FEATURE_EVENTS})` };
  const last = lastActivity(cfg, state);
  const elapsed = (now - Date.parse(last.time)) / 3600_000;
  const stalled = elapsed >= hours;
  return { stalled, settled: false, unsettled: unsettled.map(f => f.id), last, elapsed, hours,
    line: `Phase ${cfg.phase}: ${stalled ? "STALL" : "active"} · ${unsettled.map(f => f.id).join(", ") || "no features"} · last recorded activity ${last.time} (${last.source}), ${Math.max(0, elapsed).toFixed(2)}h ago` };
}

const invokedAsScript = () => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};

if (invokedAsScript()) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  const [mode] = args._;
  if (!["next", "stall"].includes(mode)) throw new UsageError("loop.mjs next --config <loop.json> | stall --hours N [--config <loop.json>]");
  if (mode === "next" || "config" in args) need(args, "config");
  if (mode === "stall") {
    need(args, "hours");
    if (!Number.isFinite(Number(args.hours)) || Number(args.hours) <= 0) throw new UsageError("--hours must be a positive number");
  }
  const clock = cliClock(args);
  const config = resolve(args.config ?? "loop.json");
  let cfg;
  try { cfg = load(config); }
  catch (error) { if (error instanceof Stop) throw new UsageError(error.message); throw error; }
  if (mode === "next") cadenceOf(cfg);
  const state = recordsOf(cfg);
  if (mode === "next") return void console.log(nextLines(cfg, config, state, clock));
  const result = stallState(cfg, state, Number(args.hours), clock.now);
  console.log(result.line);
  return result.stalled ? 2 : 0;
});
