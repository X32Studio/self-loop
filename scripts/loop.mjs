#!/usr/bin/env node
// F-0003, F-0015, P-0014, P-0015, D-0015, D-0016, D-0058, D-0060, D-0064, D-0066, D-0067, R-0055-judge-frame-hygiene
import { createHash } from "node:crypto";
import { normalOpportunities } from "./lib/normal-entry.mjs";
import { ALARM_DETECTOR_REVISION, buildAlarmContext, readNormalEntry } from "./lib/normal-entry-source.mjs";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEAVY_ROLES, load, preparedIn, Stop } from "./call.mjs";
import { ANSWERS, batchesFrom } from "./decisions.mjs";
import { ALARMS, currentStall, parseAlarms } from "./lib/alarms.mjs";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { collectArchFacts } from "./lib/arch-facts.mjs";
import { blockerState as foldRulings, withStatus } from "./lib/blockers.mjs";
import { FEATURE_EVENTS, inspectBlueprint } from "./lib/blueprint.mjs";
import { advancingAction, ARCH_STEP, cadenceLines, cadenceOf, cadenceState, dueReason, JUDGE_FRAME_STEP, outerCadenceOf, outerLoopLines, outerLoopState } from "./lib/cadence.mjs";
import { ciGreen, fullSha, judgeAccepted, receiptMatches } from "./lib/ci.mjs";
import { gatesOf } from "./lib/ci-receipt.mjs";
import { command, env, evidencePrefix, gatherCommand, node, shell } from "./lib/commands.mjs";
import { proseInTree } from "./lib/comments.mjs";
import { firings, undiagnosedAlarms } from "./lib/diagnosis.mjs";
import { computeDispatchPlan, renderDispatchLines } from "./lib/dispatch.mjs";
import { blobs, git, gitOk, regularFiles } from "./lib/git-plumbing.mjs";
import { HANDOFFS, hasPhaseFrame, idOf, parseHandoffs } from "./lib/handoff.mjs";
import { hostLine } from "./lib/host.mjs";
import { certifiedCriticOn, checkouts, integrationOf, recordedAfter } from "./lib/integration.mjs";
import { phaseMetrics } from "./lib/owner-metrics.mjs";
import { isSubstantiveOwnerWord, MARKS, WORDS } from "./lib/owner-words.mjs";
import { isPreparedRunner } from "./lib/paseo.mjs";
import { isIdle, LEAD_STEPS, reconcilePlans } from "./lib/plan.mjs";
import {
  citedPredicates,
  cliClock,
  createPredicates,
  firstParentHistory,
  measuresLines,
  predicateContext as makePredicateContext,
  predicateReplay as replayPredicates,
  queryClock,
  timeLines,
} from "./lib/predicate-replay.mjs";
import { evaluateCertifiedWaveCoverage } from "./lib/provenance.mjs";
import { liveEvidenceStats } from "./lib/records-prune.mjs";
import { hostLoad, REGISTRY, resolveOwnerStore } from "./lib/registry.mjs";
import { ssotNextSummary } from "./lib/ssot.mjs";
import {
  MAX_FAST_PROSE_FILES,
  MAX_FAST_PROSE_MS,
  MAX_LIVE_EVIDENCE_BYTES,
  MAX_LIVE_EVIDENCE_FILES,
  MAX_STALE_WORKSPACES,
} from "./lib/thresholds.mjs";
import { tipCovers } from "./lib/tip.mjs";
import { hasWindowDiagnosis, parseWindows, WINDOWS, windowState } from "./lib/window.mjs";
import { cleanWorkDir } from "./lib/work-hygiene.mjs";
import { check, openWords, RUNGS } from "./records-check.mjs";
import { parseRows, TRAJECTORY } from "./trajectory.mjs";
import { reconcileReleases } from "./version-gate.mjs";

export {
  certifiedCriticOn,
  checkouts,
  citedPredicates,
  cliClock,
  createPredicates,
  firstParentHistory,
  integrationOf,
  measuresLines,
  queryClock,
  reconcilePlans,
  recordedAfter,
  timeLines,
};

const pad = n => String(n).padStart(4, "0");
const evidenceJson = path => path.startsWith("evidence/") && path.endsWith(".json");
const relevant = path => /^(blueprint|decisions|owner|purpose|rounds)\/.*\.md$/.test(path)
  || /^sealed\/judge\/\d+\/judge(?:-[a-z]+)*-\d+\.md$/.test(path)
  || /^sealed\/critic\/\d+\/[^/]+-\d+\.md$/.test(path)
  || evidenceJson(path)
  || [ALARMS, ANSWERS, FEATURE_EVENTS, HANDOFFS, TRAJECTORY, WINDOWS, "loop.json", "records.json"].includes(path);

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
  const pos = n => Number.isInteger(n) && n > 0;
  return Math.max(0, ...used.filter(pos), ...prepared.map(p => p.round).filter(pos), ...state.rows.map(r => r.round).filter(pos)) + 1;
}

const knownRuling = row => (row.role === "judge" || row.role === "critic") && row.verdict !== "-";
// design/round9-b.md#the-transition
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

function convergence({ words, state, rows, cfg, target, integration, ci, suite, frame, ruling, judges, critics, criticCert, actors, pending, openAlarms, checkRecords, prose, cadence, ssot, win }) {
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
  const hasJudgeConvergence = ruling?.role === "judge" && ruling.verdict === "CONVERGED" && /^[1-9]\d*\/0$/.test(ruling.suite);
  const hasCriticConvergence = Boolean(criticCert);
  if (!hasJudgeConvergence && !hasCriticConvergence)
    reasons.push(`judge convergence or independent no-dispute critic PASS/CONVERGED ruling with a green suite count on ${target ?? "the integration SHA"} (${TRAJECTORY})`);
  const blockers = blockerState(rows).open;
  if (blockers.length) reasons.push(`open blockers: ${blockers.join(", ")} (${TRAJECTORY})`);
  if (!openAlarms || openAlarms.length) reasons.push(`alarms with no matching diagnosis (${HANDOFFS}, ${TRAJECTORY})`);
  if (checkRecords.failures.length)
    reasons.push(`records-check.mjs: ${checkRecords.failures.map(f => `${f.path} (${f.rule})`).join(", ")}`);
  if (prose.subtraction && (!prose.lines || prose.lines.length))
    reasons.push(`${prose.lines ? prose.lines.length : "unknown"} prose comment lines in the product tree at ${prose.sha ?? "the integration SHA"} (D-0016, since ${prose.subtraction.id})`);
  if (ssot?.convergenceReason) reasons.push(ssot.convergenceReason);

  const judge = ruling?.role === "judge" ? judges.findLast(h => h.round === ruling.round && h.product?.base === ruling.commit) : null;
  if (ruling?.role === "judge" && ruling.verdict === "CONVERGED") {
    const files = new Set(state.files);
    if (!judge || !judgeAccepted(judge, { has: path => files.has(path), read: state.read })) reasons.push(`ACCEPTANCE: pass needs confirmation (${judge?.record ?? TRAJECTORY})`);
    if (evaluateCertifiedWaveCoverage({ repo: cfg.product, records: cfg.records, revision: state.revision, files, read: state.read, cfg, phase: cfg.phase, targetCommit: target, targetRuling: ruling, judge: judge ?? null, judges, critics, actors, rows, allHandoffs: state.handoffs, allRows: state.rows, isAncestor: integration.ancestor }).problem)
      reasons.push(`judge/actor independence needs confirmation (${HANDOFFS})`);
  }
  return reasons;
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

// F-0011, F-0012, F-0015, R-0008-judge-mechanisms, design/generative-engine.md#raised-first-replay
export const PREDICATES = createPredicates({ stallState, reconcilePlans });
export const predicateContext = (records, revision, phase, opts = {}) => makePredicateContext(records, revision, phase, { recordsOf, ...opts });
export const predicateReplay = (records, opts = {}) => replayPredicates(records, { stallState, recordsOf, reconcilePlans, predicates: PREDICATES, ...opts });

const SUBTRACTION = /^reviewer-subtraction(?:-[a-z]+)*$/;
const SHOWN_PROSE = 10;

// design/dispatch.md#ready-state
export function integrationTarget(cfg, state = recordsOf(cfg)) {
  const managed = new Set(state.files);
  const integration = integrationOf(cfg, state, state.handoffs.filter(h => h.phase === cfg.phase && managed.has(h.record)), state.rows.filter(r => r.phase === cfg.phase));
  return integration.sha ?? integration.merge ?? null;
}

export function nextLines(cfg, config, state, { store = null, load: measured = null, now, clockMode, full: fullDiag = false } = {}) {
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
  const critics = workers.filter(h => h.role === "critic");
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
  const criticCert = integration.sha ? certifiedCriticOn({ cfg, state, rows, actors, judges, critics, target, integration, covers }) : null;
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
  const stateCheck = check(records, { config: JSON.parse(state.read("records.json") || "{}"), fast: !fullDiag });
  const suite = target && state.files.filter(evidenceJson).find(path => {
    try { return receiptMatches(JSON.parse(state.read(path)), product, target); } catch { return false; }
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
    const prepare = isPreparedRunner(cfg.agents[role]?.runner) ? ["--prepare"] : [];
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
  let baselineFacts = null;
  if (outerBase.baseline && ARCH_STEP.test(outerBase.baseline.step ?? "")) {
    const fp = (outerBase.baseline.files ?? []).find(p => p.endsWith("arch-facts.json") && managed.has(p));
    if (fp) try { baselineFacts = JSON.parse(state.read(fp)); } catch {}
    if (!baselineFacts && validArchBase) try { baselineFacts = collectArchFacts(product, validArchBase); } catch {}
  }
  let currentFacts = null;
  if (target) try { currentFacts = collectArchFacts(product, target, { baselineSha: validArchBase }); } catch {}
  const outer = outerLoopState({
    handoffs, rows, currentFacts, baselineFacts, prepared: pending.filter(p => !p.phase || p.phase === phase),
    deliveries: outerSetting.deliveries, outerGrace: outerSetting.outerGrace, phase, targetSha: target,
  });
  const win = windowState({ windows: state.windows ?? parseWindows(state.read(WINDOWS), WINDOWS), handoffs, rows, phase, nextRound: round, read: state.read, files: managed });
  const reconciled = state.files.some(path => /^plans\/PL-\d{4}\.md$/.test(path)) ? reconcilePlans(records, state.revision, phase, { host, base: target, now: clock.now }) : null;
  let metrics = null, metricsProblem = null;
  try { metrics = phaseMetrics(records, phase, { revision: state.revision, falseAlarms: false }); } catch (error) { metricsProblem = error.message; }
  const subtraction = handoffs.findLast(h => SUBTRACTION.test(h.step)) ?? null;
  const prose = { sha: target, subtraction, lines: null, deferred: false, problem: null };
  if (target) {
    try {
      const res = proseInTree(product, target, {
        records: cfg.records,
        cache: true,
        maxFiles: subtraction || fullDiag ? null : MAX_FAST_PROSE_FILES,
        maxMs: subtraction || fullDiag ? null : MAX_FAST_PROSE_MS,
        deferOnBudget: !(subtraction || fullDiag),
      });
      if (Array.isArray(res)) prose.lines = res;
      else if (res?.deferred) { prose.deferred = true; prose.problem = res.reason; }
      else prose.lines = res?.lines ?? null;
    } catch (error) { prose.problem = error.message; }
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
  try { openAlarms = undiagnosedAlarms(records, state.revision, phase, { repo: product }); }
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
      "Record after the child has finished (--session optional when nonce uniquely matches).",
      node("call.mjs", config, "record", "--ws", p.ws));
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
  if (reconciled) {
    for (const { title, steps } of planActions(records, reconciled)) action(title, `plans/, ${HANDOFFS}, prepared call.json, D-0025`, ...steps);
    for (const { plan, result } of reconciled.plans.filter(p => p.result)) {
      try {
        const dp = computeDispatchPlan({ state: reconciled.state, plan, ready: result, product, base: target, host, window: win, now: clock.now });
        const hasBatch = dp.parallelBatch.actors.length >= 2 || dp.parallelBatch.critics.length >= 2;
        if (hasBatch || dp.needsIntegration) {
          action(
            `Parallel wave (${plan.id}, topology: ${dp.coverage.topology}): ${dp.parallelBatch.actors.length} parallel actor(s), ${dp.parallelBatch.critics.length} ready critic(s)${dp.needsIntegration ? ", integration needed" : ""}`,
            "plans/, D-0059, P-0012",
            ...renderDispatchLines(dp),
          );
        }
      } catch {}
    }
  }
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
        `${substantiveWords.length} substantive open owner word(s) (${substantiveWords.map(w => w.id).join(", ")}): run reviewer-distill to distill verbatim words into purpose/decisions/design with first-principles derivation and generalization (blocks critic/actor calls immediately, 0-turn grace; D-0060):`,
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
    if (!ruling && !judges.some(h => covers(h.product?.base)) && !criticCert) action("no judge ruling on the integration head", `${HANDOFFS}, ${TRAJECTORY}`, ...callFor("judge"));
  }
  if (win.mode === "gate-due") {
    action(
      `bounded window ${win.active.id} gate due (${win.usedActorRounds}/${win.active.horizon} actor rounds spent; further actor calls are mechanically refused until closed)`,
      WINDOWS,
      `Goal: ${win.active.goal}`,
      `Invariants: ${win.active.invariants.join("; ")}`,
      "Complete mandatory verification (suite-green, CI if configured, independent no-dispute critic or judge) and close the window:",
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
    if (!sha || rulings.some(row => row.role === "judge" && row.round === h.round && row.commit === sha)) continue;
    // D-0015, D-0009
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
  const hygieneOver = [];
  try {
    const ev = liveEvidenceStats({ repo: records, head: state.revision, files: state.files, read: state.read });
    const work = cleanWorkDir(cfg.workDir, { maxRound: Math.max(0, round - 1), recordedIds: new Set(state.handoffs.map(h => h.id)), apply: false });
    if (ev.fileCount > MAX_LIVE_EVIDENCE_FILES) hygieneOver.push(`${ev.fileCount} live evidence files (> ${MAX_LIVE_EVIDENCE_FILES})`);
    if (ev.totalBytes > MAX_LIVE_EVIDENCE_BYTES) hygieneOver.push(`${Math.round(ev.totalBytes / 1048576)} MiB live evidence (> ${Math.round(MAX_LIVE_EVIDENCE_BYTES / 1048576)} MiB)`);
    if (ev.oversizedAudits.length) hygieneOver.push(`${ev.oversizedAudits.length} oversized audit(s) (> 1 MiB)`);
    if (work.candidates.length > MAX_STALE_WORKSPACES) hygieneOver.push(`${work.candidates.length} stale workspace(s) (> ${MAX_STALE_WORKSPACES})`);
  } catch {}
  if (hygieneOver.length)
    action(`operational hygiene threshold exceeded (screening): ${hygieneOver.join("; ")}`, "F-0015, lib/records-prune.mjs, lib/work-hygiene.mjs",
      node("self-loop.mjs", "clean", "--config", config, "--apply"));
  let hookReason = !existsSync(join(records, ".githooks", "pre-commit")) ? "missing .githooks/pre-commit" : null;
  if (!hookReason) {
    let hp = "";
    try { hp = git(records, "config", "--local", "--get", "core.hooksPath"); } catch {}
    if (!hp) hookReason = "core.hooksPath is unset";
  }
  if (hookReason)
    action(`records pre-commit hook inactive (${hookReason}, screening)`, "F-0015, lib/init.mjs",
      node("self-loop.mjs", "hooks", "install", "--records", records));

  const reasons = convergence({ words, state, rows, cfg, target, integration, ci, suite, frame, ruling, judges, critics, criticCert, actors, pending, openAlarms, checkRecords: stateCheck, prose, cadence, ssot, win });
  if (stallError) lines.splice(header, 0, "", `- the alarm ledger cannot be read: ${stallError.message} [${ALARMS}]`, `  ${node("records-check.mjs", "--repo", records)}`);
  if (stalled)
    lines.splice(header, 0, "", `- stall alarm raised ${stalled.time}: no recorded phase activity since ${stalled.since} (${stalled.source}) [${ALARMS}]`,
      `  Resume the phase or record why it waits; ${node("loop.mjs", "stall", "--hours", stalled.threshold, "--config", config)}`);
  if (reasons.length) action("convergence conditions not met", "SKILL.md convergence gates", ...reasons, status,
    node("decisions.mjs", "status", "--records", records, "--phase", phase), node("records-check.mjs", "--repo", records));
  else lines.push("", "The recorded convergence checks are satisfied. Confirm the ruling and acceptance before claiming convergence.");
  return lines.join("\n");
}

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

export const liveStall = (cfg, state) => currentStall(parseAlarms(state.read(ALARMS)), cfg.phase, lastActivity(cfg, state).time);

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
  if (mode === "next") return void console.log(nextLines(cfg, config, state, { ...clock, full: "full" in args }));
  const result = stallState(cfg, state, Number(args.hours), clock.now);
  console.log(result.line);
  return result.stalled ? 2 : 0;
});
