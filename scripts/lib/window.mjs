// P-0011, D-0016, D-0058, D-0062, D-0064, D-0067, D-0068, design/two-loop-rhythm.md#2, design/paseo-and-judge-policy.md#1
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "./args.mjs";
import { JUDGE_FRAME_STEP } from "./cadence.mjs";
import { criticContradictedByTrajectory, criticConvergedAccepted, receiptProblem } from "./ci.mjs";
import { gatesOf, recordsLoop, rowReceiptProblem } from "./ci-receipt.mjs";
import { alarmKeys, DIAGNOSIS_STEP, taskOfRecord } from "./diagnosis.mjs";
import { git, gitOk } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { evaluateCertifiedWaveCoverage } from "./provenance.mjs";
import { appendJsonLines, commitRecords, recordsSnapshot } from "./records-commit.mjs";
import { validateJudgeIndependence, validateModelVendors } from "./vendor.mjs";
import {
  CLOSE_VERDICTS, MAX_HORIZON, MIN_HORIZON, parseWindows, WINDOW_ID, windowAlarmKey, WINDOWS, windowState,
} from "./window-state.mjs";
import { DEFAULT_LAYOUT, indexOfTree } from "../records-check.mjs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";

export { CLOSE_VERDICTS, MAX_HORIZON, MIN_HORIZON, parseWindows, WINDOW_ID, windowAlarmKey, WINDOWS, windowState };

export class WindowRefusalError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
const SUITE_PASS = /^[1-9]\d*\/0$/;
const pad = n => String(n).padStart(4, "0");
const oneLine = s => typeof s === "string" && s.trim().length > 0 && !/[\r\n\t]/.test(s);
const evidenceJson = path => path.startsWith("evidence/") && path.endsWith(".json");
const stamp = now => (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 19) + "Z";

export function hasWindowDiagnosis({ records, revision = "HEAD", handoffs, read, files, phase, open }) {
  const key = windowAlarmKey(phase, open.id), openedMs = Date.parse(open.openedAt);
  let handoffCommits = null;
  const lineCommit = index => {
    if (!handoffCommits) {
      handoffCommits = [];
      let sha = null;
      for (const line of git(records, "blame", "--porcelain", revision, "--", HANDOFFS).split("\n")) {
        const m = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
        if (m) sha = m[1];
        else if (line.startsWith("\t") && line.length > 1) handoffCommits.push(sha);
      }
    }
    return handoffCommits[index] ?? null;
  };
  for (let i = 0; i < handoffs.length; i++) {
    const h = handoffs[i];
    if (h.role !== "reviewer" || !DIAGNOSIS_STEP.test(h.step) || h.phase !== phase) continue;
    if (files && !files.has(h.record)) continue;
    if (!alarmKeys(taskOfRecord(read(h.record))).includes(key)) continue;
    const hMs = Date.parse(h.time);
    if (!Number.isFinite(hMs) || hMs < openedMs) continue;
    if (hMs > openedMs) return h;
    const c = lineCommit(i);
    if (c && gitOk(records, "cat-file", "-e", `${c}:${WINDOWS}`)
      && parseWindows(git(records, "show", `${c}:${WINDOWS}`), WINDOWS).some(e => e.type === "open" && e.id === open.id)) return h;
  }
  return null;
}

const posRound = r => (Number.isInteger(r) && r > 0 ? [r] : []);

export function defaultStartRound(records, at = "HEAD") {
  const snap = recordsSnapshot(records, at);
  const used = [...snap.files.keys()].flatMap(p => { const m = /^rounds\/(\d+)-/.exec(p); return m ? posRound(Number(m[1])) : []; });
  return Math.max(
    0,
    ...used,
    ...parseRows(snap.read(TRAJECTORY)).flatMap(r => posRound(r.round)),
    ...parseHandoffs(snap.read(HANDOFFS)).flatMap(h => posRound(h.round)),
  ) + 1;
}

function rawLoopJson(records, read) {
  const committed = read("loop.json");
  if (committed) {
    try { return JSON.parse(committed); } catch {}
  }
  const file = join(records, "loop.json");
  if (existsSync(file)) {
    try { return JSON.parse(readFileSync(file, "utf8")); } catch {}
  }
  return null;
}

function loopExtras(obj, fb = {}) {
  const out = {};
  for (const key of ["judgeIndependence", "modelVendors", "provenanceBaseline", "leadPaths"]) {
    if (Object.hasOwn(obj ?? {}, key)) out[key] = obj[key];
    else if (Object.hasOwn(fb, key)) out[key] = fb[key];
  }
  return out;
}

function resolveLoop(records, read, cfg) {
  const baseExtras = loopExtras(rawLoopJson(records, read));
  if (cfg) return { product: resolve(cfg.product), gates: cfg.gates, ...gatesOf(cfg), ...loopExtras(cfg, baseExtras) };
  const text = read("loop.json");
  if (text) {
    const raw = JSON.parse(text);
    if (raw && typeof raw.product === "string" && raw.product.trim())
      return { product: resolve(records, raw.product), gates: raw.gates, ...gatesOf(raw), ...loopExtras(raw) };
  }
  const fromDisk = recordsLoop(records);
  return fromDisk ? { ...fromDisk, ...baseExtras } : null;
}

function verifyEvidence({ records, head, files, read, open, commit, handoffs, rows, cfg }) {
  if (!SHA.test(commit ?? "")) throw new WindowRefusalError(`window ${open.id} verified close requires a 40-hex --commit SHA`);
  const loop = resolveLoop(records, read, cfg);
  if (!loop?.product) throw new WindowRefusalError(`window ${open.id} verified close requires loop.json or --config naming the product repository`);
  const pol = validateJudgeIndependence(loop.judgeIndependence);
  if (!pol.ok) throw new WindowRefusalError(`window ${open.id} cannot close verified: ${pol.error}`);
  const mv = validateModelVendors(loop.modelVendors);
  if (!mv.ok) throw new WindowRefusalError(`window ${open.id} cannot close verified: ${mv.error}`);
  const phaseRows = rows.filter(r => r.phase === open.phase);
  const judges = handoffs.filter(h => h.phase === open.phase && h.role === "judge" && !JUDGE_FRAME_STEP.test(h.step) && files.has(h.record));
  const critics = handoffs.filter(h => h.phase === open.phase && h.role === "critic" && files.has(h.record));
  const actors = handoffs.filter(h => h.phase === open.phase && h.role === "actor" && h.product?.commit && files.has(h.record));
  const hasFile = p => files.has(p);

  const judgeRuling = phaseRows.filter(r =>
    r.role === "judge" && r.round >= open.startRound && (r.commit === commit || r.tip === commit)
  ).at(-1) ?? null;

  let activeRuling = null;
  let judgeFailure = null;
  if (judgeRuling?.verdict === "CONVERGED") {
    if (!SUITE_PASS.test(judgeRuling.suite ?? "")) {
      judgeFailure = `window ${open.id} cannot close verified: judge ruling in round ${judgeRuling.round} has failing or missing suite count ${JSON.stringify(judgeRuling.suite)}`;
    } else {
      const judge = judges.findLast(h => h.round === judgeRuling.round && h.product?.base === judgeRuling.commit);
      if (!judge) {
        judgeFailure = `window ${open.id} cannot close verified: no committed judge hand-off in ${HANDOFFS} for round ${judgeRuling.round} on ${judgeRuling.commit}`;
      } else {
        const cov = evaluateCertifiedWaveCoverage({
          repo: loop.product, records, revision: head, files, read, cfg: loop, phase: open.phase,
          targetCommit: commit, targetRuling: judgeRuling, judge, judges, critics, actors,
          rows: phaseRows, allHandoffs: handoffs, allRows: rows,
        });
        if (!cov.actors.length) judgeFailure = `window ${open.id} cannot close verified: no committed actor hand-off in ${HANDOFFS} covering ${commit}`;
        else if (cov.problem) judgeFailure = `window ${open.id} cannot close verified: judge/actor independence failed (${cov.problem})`;
        else activeRuling = judgeRuling;
      }
    }
  }

  let criticVerified = false;
  let criticFailure = null;
  if (!activeRuling) {
    const windowCritics = critics.filter(c => c.round >= open.startRound);
    for (let i = windowCritics.length - 1; i >= 0; i--) {
      const ch = windowCritics[i];
      const certSha = ch.product?.commit || ch.product?.base || null;
      const criticRow = phaseRows.filter(r =>
        r.role === "critic" && r.round === ch.round && (r.commit === commit || r.tip === commit)
      ).at(-1) ?? null;
      const matchesCommit = certSha === commit || (criticRow && criticRow.commit === certSha && criticRow.tip === commit);
      if (!matchesCommit) continue;
      if (!criticConvergedAccepted(ch, { has: hasFile, read })) {
        criticFailure ??= `window ${open.id} cannot close verified: critic ${ch.id} is not an independent no-dispute PASS/CONVERGED hand-off`;
        continue;
      }
      if (criticContradictedByTrajectory(phaseRows, ch, [commit, certSha, criticRow?.tip])) {
        criticFailure ??= `window ${open.id} cannot close verified: critic ${ch.id} is contradicted by a later trajectory ruling on ${commit}`;
        continue;
      }
      if (ch.product?.base && ch.product?.commit && ch.product.base !== ch.product.commit
        && !gitOk(loop.product, "--no-replace-objects", "merge-base", "--is-ancestor", ch.product.base, ch.product.commit)) {
        criticFailure ??= `window ${open.id} cannot close verified: critic ${ch.id} base is not an ancestor of its commit`;
        continue;
      }
      if (criticRow) {
        if (criticRow.verdict !== "PASS" && criticRow.verdict !== "CONVERGED") {
          criticFailure ??= `window ${open.id} cannot close verified: critic ruling in round ${criticRow.round} has verdict ${JSON.stringify(criticRow.verdict)}`;
          continue;
        }
        if (criticRow.suite !== undefined && !SUITE_PASS.test(criticRow.suite ?? "")) {
          criticFailure ??= `window ${open.id} cannot close verified: critic ruling in round ${criticRow.round} has failing or missing suite count ${JSON.stringify(criticRow.suite)}`;
          continue;
        }
      }
      const cov = evaluateCertifiedWaveCoverage({
        repo: loop.product, records, revision: head, files, read, cfg: loop, phase: open.phase,
        targetCommit: commit, targetRuling: criticRow, judge: ch, judges, critics, actors,
        rows: phaseRows, allHandoffs: handoffs, allRows: rows,
      });
      if (!cov.actors.length) {
        criticFailure ??= `window ${open.id} cannot close verified: no committed actor hand-off in ${HANDOFFS} covering ${commit}`;
        continue;
      }
      if (cov.problem) {
        criticFailure ??= `window ${open.id} cannot close verified: critic/actor independence failed (${cov.problem})`;
        continue;
      }
      if (cov.actors.some(a => !ch.product?.base || !gitOk(loop.product, "--no-replace-objects", "merge-base", "--is-ancestor", a.product.commit, ch.product.base))) {
        criticFailure ??= `window ${open.id} cannot close verified: critic ${ch.id} base does not cover all wave actor commits`;
        continue;
      }
      activeRuling = criticRow;
      criticVerified = true;
      break;
    }
  }

  if (!activeRuling && !criticVerified) {
    throw new WindowRefusalError(
      judgeFailure ?? criticFailure
        ?? `window ${open.id} cannot close verified: no CONVERGED judge ruling or independent no-dispute critic PASS/CONVERGED ruling covering ${commit} in ${TRAJECTORY} / ${HANDOFFS} (round >= ${open.startRound})`,
    );
  }
  const evidenceFiles = [...files.keys()].filter(evidenceJson);
  const suiteReceipt = evidenceFiles.find(p => { try { return receiptProblem(JSON.parse(read(p)), loop.product, commit) === null; } catch { return false; } }) ?? null;
  if (!suiteReceipt) throw new WindowRefusalError(`window ${open.id} cannot close verified: no committed green suite-green receipt for ${commit} under evidence/`);
  const { require } = gatesOf(loop);
  let ciReceipt = null;
  if (require) {
    const ciSha = activeRuling?.tip ?? commit;
    const checkOk = r => (r?.sha === commit || r?.sha === ciSha) && r.ci === "success" && r.ok === true
      && require.every(spec => r.conclusions?.[spec] === "success");
    if (activeRuling?.ciReceipt && rowReceiptProblem(activeRuling, p => files.has(p) ? read(p) : null) === null) {
      try { if (checkOk(JSON.parse(read(activeRuling.ciReceipt)))) ciReceipt = activeRuling.ciReceipt; } catch {}
    }
    ciReceipt ??= evidenceFiles.find(p => { try { return checkOk(JSON.parse(read(p))); } catch { return false; } }) ?? null;
    if (!ciReceipt) throw new WindowRefusalError(`window ${open.id} cannot close verified: remote CI is configured (${require.join(", ")}) and no committed green CI receipt exists for ${commit}`);
  }
  return { suiteReceipt, ciReceipt };
}

function appendWindowEvent(records, message, buildEvent) {
  const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
  const { commit, value } = commitRecords(records, ctx => {
    const old = ctx.read(WINDOWS);
    const events = parseWindows(old, WINDOWS);
    const event = buildEvent(events, ctx);
    const next = appendJsonLines(old, [event]);
    parseWindows(next, WINDOWS);
    ctx.add(WINDOWS, next);
    if (ctx.files.has("INDEX.md")) {
      const index = indexOfTree(records, ctx.tree(), { layoutText });
      if (index !== ctx.read("INDEX.md")) ctx.add("INDEX.md", index);
    }
    return { message: message(event), value: event };
  });
  return { event: value, commit };
}

export function openWindow(records, { phase, startRound, horizon, goal, invariants, by = "lead", now = new Date() }) {
  if (!oneLine(phase)) throw new UsageError("phase must be a non-empty single-line string");
  if (!Number.isInteger(startRound) || startRound < 1) throw new UsageError(`startRound must be a positive integer, got ${JSON.stringify(startRound)}`);
  if (!Number.isInteger(horizon) || horizon < MIN_HORIZON || horizon > MAX_HORIZON)
    throw new UsageError(`horizon must be an integer between ${MIN_HORIZON} and ${MAX_HORIZON}, got ${JSON.stringify(horizon)}`);
  if (!oneLine(goal)) throw new UsageError("goal must be a non-empty single-line string");
  if (!Array.isArray(invariants) || !invariants.length || !invariants.every(oneLine))
    throw new UsageError("invariants must be a non-empty list of single-line strings");
  if (!oneLine(by)) throw new UsageError("by must be a non-empty single-line string");
  return appendWindowEvent(records, e => `window: open ${e.id} (${e.phase}, horizon ${e.horizon})`, events => {
    const existing = windowState({ windows: events, phase }).active;
    if (existing) throw new WindowRefusalError(`phase ${phase} already has open window ${existing.id}; close it before opening another`);
    return {
      type: "open", id: `W-${pad(events.filter(e => e.type === "open").length + 1)}`, phase: phase.trim(),
      startRound, horizon, goal: goal.trim(), invariants: invariants.map(s => s.trim()), openedAt: stamp(now), openedBy: by.trim(),
    };
  });
}

export function closeWindow(records, { id, phase = null, commit = null, verdict, by = "lead", note = null, now = new Date(), cfg = null }) {
  if (!WINDOW_ID.test(id ?? "")) throw new UsageError(`id must match W-NNNN, got ${JSON.stringify(id)}`);
  if (!CLOSE_VERDICTS.includes(verdict)) throw new UsageError(`verdict must be one of ${CLOSE_VERDICTS.join(", ")}, got ${JSON.stringify(verdict)}`);
  if (!oneLine(by)) throw new UsageError("by must be a non-empty single-line string");
  if (note != null && !oneLine(note)) throw new UsageError("note must be a non-empty single-line string");
  return appendWindowEvent(records, e => `window: close ${e.id} (${e.phase}, ${e.verdict})`, (events, { head, files, read }) => {
    const open = events.find(e => e.type === "open" && e.id === id);
    if (!open) throw new WindowRefusalError(`window ${id} does not exist`);
    if (events.some(e => e.type === "close" && e.id === id)) throw new WindowRefusalError(`window ${id} is already closed`);
    if (phase && phase !== open.phase) throw new WindowRefusalError(`window ${id} belongs to phase ${open.phase}, not ${phase}`);
    const handoffs = parseHandoffs(read(HANDOFFS)), rows = parseRows(read(TRAJECTORY));
    let suiteReceipt = null, ciReceipt = null;
    if (verdict === "verified") {
      ({ suiteReceipt, ciReceipt } = verifyEvidence({ records, head, files, read, open, commit, handoffs, rows, cfg }));
    } else {
      if (!hasWindowDiagnosis({ records, revision: head, handoffs, read, files, phase: open.phase, open }))
        throw new WindowRefusalError(`window ${id} cannot close reframed: no post-open reviewer-diagnosis hand-off in phase ${open.phase} cites alarms: ${windowAlarmKey(open.phase, id)}`);
      if (commit != null && !SHA.test(commit)) throw new UsageError(`commit must be a 40-hex SHA when provided, got ${JSON.stringify(commit)}`);
    }
    return {
      type: "close", id, phase: open.phase, closedAt: stamp(now), closedBy: by.trim(), commit: commit ?? null, verdict,
      ...(suiteReceipt ? { suiteReceipt } : {}), ...(ciReceipt ? { ciReceipt } : {}), ...(note ? { note: note.trim() } : {}),
    };
  });
}
