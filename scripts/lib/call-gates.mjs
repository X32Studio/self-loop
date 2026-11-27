// F-0008, F-0015, D-0015, D-0016, D-0017, D-0058, D-0060, P-0011, R-0055-judge-frame-hygiene
import { collectArchFacts } from "./arch-facts.mjs";
import { ARCH_STEP, outerCadenceOf, outerLoopState } from "./cadence.mjs";
import { node as nodeCommand } from "./commands.mjs";
import { undiagnosedAlarms } from "./diagnosis.mjs";
import { git, gitOk } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs, recordOf } from "./handoff.mjs";
import { isSubstantiveOwnerWord } from "./owner-words.mjs";
import { isPreparedRunner } from "./paseo.mjs";
import { DISPLAY_SHA_LEN } from "./ssot.mjs";
import { preparedIn as defaultPreparedIn } from "./t3-child.mjs";
import { parseWindows, windowAlarmKey, WINDOWS, windowState } from "./window.mjs";
import { openWords } from "../records-check.mjs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";

const DEFAULT_EXIT = { done: 0, failure: 1, gate: 2, violation: 6, records: 7, usage: 64 };
const stopError = (deps, code, message) => (deps?.Stop ? new deps.Stop(code, message) : Object.assign(new Error(message), { code }));

export function viewHandoffs(cfg, view, viewPaths) {
  return viewPaths.has(HANDOFFS)
    ? parseHandoffs(git(cfg.records, "show", `${view}:${HANDOFFS}`)).filter(h => h.phase === cfg.phase && viewPaths.has(h.record))
    : [];
}

export function lastOuterBaselineSha(cfg, view, viewPaths) {
  const handoffs = viewHandoffs(cfg, view, viewPaths);
  const { baseline } = outerLoopState({ handoffs, phase: cfg.phase });
  const sha = baseline?.product?.base ?? baseline?.product?.commit ?? null;
  return sha && gitOk(cfg.product, "cat-file", "-e", `${sha}^{commit}`) ? sha : null;
}

export function archBaselineFacts(cfg, view, viewPaths, baseline, validBase) {
  if (!baseline || !ARCH_STEP.test(baseline.step ?? "")) return null;
  const factsPath = (baseline.files ?? []).find(p => p.endsWith("arch-facts.json") && viewPaths.has(p));
  if (factsPath) {
    try { return JSON.parse(git(cfg.records, "show", `${view}:${factsPath}`)); } catch {}
  }
  if (validBase) {
    try { return collectArchFacts(cfg.product, validBase); } catch {}
  }
  return null;
}

export function refuseUndiagnosed(cfg, view, round, deps = {}) {
  const exit = deps.EXIT ?? DEFAULT_EXIT;
  let open;
  try { open = undiagnosedAlarms(cfg.records, view, cfg.phase, { repo: cfg.product }); }
  catch (e) { throw stopError(deps, exit.records, `the trajectory or hand-offs at view ${view.slice(0, DISPLAY_SHA_LEN)} cannot be read for the alarm check: ${e.message}`); }
  if (!open.length) return;
  const keys = open.map(a => a.key);
  const letters = "bcdefghijklmnopqrstuvwxyz";
  let step = "reviewer-diagnosis";
  for (let i = 0; gitOk(cfg.records, "cat-file", "-e", `HEAD:${recordOf(round, step)}`) && i < letters.length; i++) step = `reviewer-diagnosis-${letters[i]}`;
  const prepareFlag = isPreparedRunner(cfg.agents.reviewer?.runner) ? ["--prepare"] : [];
  throw stopError(deps, exit.records, [
    `phase ${cfg.phase} has ${open.length} alarm(s) that no reviewer-diagnosis hand-off recorded after them names (records ${view.slice(0, DISPLAY_SHA_LEN)}; no model was called):`,
    ...open.map(a => `  ${a.key}  (row of round ${a.round}: ${a.message})`),
    "Diagnose first: write a diagnosis task with the line",
    `  alarms: ${keys.join(", ")}`,
    `then run ${nodeCommand("call.mjs", cfg.configFile ?? "<config.json>", "reviewer", "--round", round, "--step", step, "--task", "<diagnosis task file>", ...prepareFlag)}`,
  ].join("\n"));
}

export function refuseExhaustedWindow(cfg, view, viewPaths, round, deps = {}) {
  const exit = deps.EXIT ?? DEFAULT_EXIT;
  if (!viewPaths.has(WINDOWS)) return { mode: "normal", active: null, actorBlocked: false };
  let win;
  try {
    const windows = parseWindows(git(cfg.records, "show", `${view}:${WINDOWS}`), WINDOWS);
    const handoffs = viewHandoffs(cfg, view, viewPaths);
    const rows = viewPaths.has(TRAJECTORY) ? parseRows(git(cfg.records, "show", `${view}:${TRAJECTORY}`)).filter(r => r.phase === cfg.phase) : [];
    win = windowState({ windows, handoffs, rows, phase: cfg.phase, nextRound: round });
  } catch (e) {
    throw stopError(deps, exit.records, `the windows ledger at view ${view.slice(0, DISPLAY_SHA_LEN)} cannot be read: ${e.message}`);
  }
  if (!win.actorBlocked) return win;
  const w = win.active;
  const alarmKey = windowAlarmKey(cfg.phase, w.id);
  throw stopError(deps, exit.records, [
    `bounded window ${w.id} in phase ${cfg.phase} exhausted its horizon (${win.usedActorRounds}/${w.horizon} actor rounds used, start ${w.startRound}, end ${w.endRound}); further actor calls are refused until the window is closed (no model was called).`,
    "Verify (suite-green, CI if configured, critic, different-vendor judge) and close with:",
    `  ${nodeCommand("window.mjs", "close", "--records", cfg.records, "--id", w.id, "--verdict", "verified", "--commit", "<integration-sha>", ...(cfg.configFile ? ["--config", cfg.configFile] : []))}`,
    `Or run reviewer-diagnosis with \`alarms: ${alarmKey}\` and close reframed with:`,
    `  ${nodeCommand("window.mjs", "close", "--records", cfg.records, "--id", w.id, "--verdict", "reframed")}`,
  ].join("\n"));
}

export function refuseOuterLoopOverdue(cfg, view, viewPaths, base, round, win, packageFiles = null, deps = {}) {
  if (win && (win.mode === "slack" || win.mode === "converging")) return;
  const exit = deps.EXIT ?? DEFAULT_EXIT;
  const listPrepared = deps.preparedIn ?? defaultPreparedIn;
  let outerCfg, handoffs, rows;
  try {
    outerCfg = outerCadenceOf(cfg);
    handoffs = viewHandoffs(cfg, view, viewPaths);
    rows = viewPaths.has(TRAJECTORY) ? parseRows(git(cfg.records, "show", `${view}:${TRAJECTORY}`)).filter(r => r.phase === cfg.phase) : [];
  } catch (e) {
    throw stopError(deps, exit.records, `outer-loop cadence check failed at view ${view.slice(0, DISPLAY_SHA_LEN)}: ${e.message}`);
  }
  const baseCheck = outerLoopState({ handoffs, rows, phase: cfg.phase });
  const baselineSha = baseCheck.baseline?.product?.base ?? baseCheck.baseline?.product?.commit ?? null;
  const validBase = baselineSha && gitOk(cfg.product, "cat-file", "-e", `${baselineSha}^{commit}`) ? baselineSha : null;
  const baselineFacts = archBaselineFacts(cfg, view, viewPaths, baseCheck.baseline, validBase);
  const currentFacts = collectArchFacts(cfg.product, base, { baselineSha: validBase });
  const outer = outerLoopState({
    handoffs, rows, currentFacts, baselineFacts, prepared: listPrepared(cfg), packageFiles,
    deliveries: outerCfg.deliveries, outerGrace: outerCfg.outerGrace, phase: cfg.phase, targetSha: base,
  });
  if (!outer.blocked) return;
  const reasons = [];
  if (outer.t1Due) reasons.push(`T1 delivery cadence (${outer.deliveriesSince}/${outer.deliveries} committed deliveries, grace +${outer.outerGrace} exceeded)`);
  if (outer.t3Due) reasons.push(`T3 arch-facts breach (${outer.archBreaches.map(b => `${b.kind} ${b.path}: ${b.detail}`).join("; ")})`);
  const prepareFlag = isPreparedRunner(cfg.agents.reviewer?.runner) ? ["--prepare"] : [];
  throw stopError(deps, exit.records, [
    `outer loop is hard-due in phase ${cfg.phase}: ${reasons.join("; ")}; further actor calls are refused until reviewer-architecture commits (no model was called).`,
    "Run read-only architectural review:",
    `  ${nodeCommand("call.mjs", cfg.configFile ?? "<config.json>", "reviewer", "--round", round, "--step", "reviewer-architecture", "--base", base, "--task", "<architecture task file>", ...prepareFlag)}`,
  ].join("\n"));
}

export function refuseUndistilledOwnerWords(cfg, view, round, deps = {}) {
  const exit = deps.EXIT ?? DEFAULT_EXIT;
  const pending = openWords(cfg.records, view).filter(w => isSubstantiveOwnerWord(w.text));
  if (!pending.length) return;
  const prepareFlag = isPreparedRunner(cfg.agents.reviewer?.runner) ? ["--prepare"] : [];
  throw stopError(deps, exit.records, [
    `phase ${cfg.phase} has ${pending.length} un-distilled substantive owner word(s) (0-turn grace; no model was called):`,
    ...pending.map(w => `  ${w.id} (${w.time}): ${w.text.replace(/\s+/g, " ").slice(0, 120)}`),
    "Distill into purpose/decisions/design (citing each ID), mark via owner-words.mjs mark, or run:",
    `  ${nodeCommand("call.mjs", cfg.configFile ?? "<config.json>", "reviewer", "--round", round, "--step", "reviewer-distill", "--task", "<distill task file>", ...prepareFlag)}`,
  ].join("\n"));
}
