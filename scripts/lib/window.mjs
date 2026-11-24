// Bounded Horizon Window ledger (`metrics/windows.jsonl`): single source of truth for bounded multi-round
// refactoring windows ("bounded slack + inevitable gate"). Append-only JSONL committed via `commitRecords`.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { UsageError } from "./args.mjs";
import { JUDGE_FRAME_STEP } from "./cadence.mjs";
import { receiptProblem } from "./ci.mjs";
import { gatesOf, recordsLoop, rowReceiptProblem } from "./ci-receipt.mjs";
import { alarmKeys, DIAGNOSIS_STEP, taskOfRecord } from "./diagnosis.mjs";
import { git, gitOk } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { appendJsonLines, commitRecords, recordsSnapshot } from "./records-commit.mjs";
import { independenceModel, modelVendor } from "./vendor.mjs";
import { DEFAULT_LAYOUT, indexOfTree } from "../records-check.mjs";
import { parseRows, TRAJECTORY } from "../trajectory.mjs";

export const WINDOWS = "metrics/windows.jsonl";
export const WINDOW_ID = /^W-\d{4}$/;
export const MIN_HORIZON = 2;
export const MAX_HORIZON = 12;
export const CLOSE_VERDICTS = Object.freeze(["verified", "reframed"]);
export const windowAlarmKey = (phase, id) => `window-horizon:${phase}:${id}`;

export class WindowRefusalError extends Error {}

const SHA = /^[0-9a-f]{40}$/;
const SUITE_PASS = /^[1-9]\d*\/0$/;
const pad = n => String(n).padStart(4, "0");
const oneLine = s => typeof s === "string" && s.trim().length > 0 && !/[\r\n\t]/.test(s);
const isoTime = s => typeof s === "string" && s.length > 0 && Number.isFinite(Date.parse(s));
const evidenceJson = path => path.startsWith("evidence/") && path.endsWith(".json");
const stamp = now => (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 19) + "Z";

/** Parse and strictly validate every event in `metrics/windows.jsonl`. Fails closed on any defect. */
export function parseWindows(text, source = WINDOWS) {
  const events = [], openById = new Map(), openByPhase = new Map();
  let nextSeq = 1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const fail = m => { throw new Error(`${source}:${i + 1}: ${m}`); };
    let row;
    try { row = JSON.parse(lines[i]); } catch (e) { fail(`not JSON (${e.message})`); }
    if (!row || typeof row !== "object" || Array.isArray(row)) fail("window event must be an object");
    if (row.type === "open") {
      const expected = `W-${pad(nextSeq++)}`;
      if (row.id !== expected) fail(`open event id must be sequential ${expected}, got ${JSON.stringify(row.id)}`);
      if (!oneLine(row.phase)) fail("phase must be a non-empty single-line string");
      if (!Number.isInteger(row.startRound) || row.startRound < 1) fail(`startRound must be a positive integer, got ${JSON.stringify(row.startRound)}`);
      if (!Number.isInteger(row.horizon) || row.horizon < MIN_HORIZON || row.horizon > MAX_HORIZON)
        fail(`horizon must be an integer in ${MIN_HORIZON}..${MAX_HORIZON}, got ${JSON.stringify(row.horizon)}`);
      if (!oneLine(row.goal)) fail("goal must be a non-empty single-line string");
      if (!Array.isArray(row.invariants) || !row.invariants.length || !row.invariants.every(oneLine))
        fail("invariants must be a non-empty list of single-line strings");
      if (!isoTime(row.openedAt)) fail("openedAt must be a valid ISO timestamp");
      if (!oneLine(row.openedBy)) fail("openedBy must be a non-empty single-line string");
      if (openByPhase.has(row.phase)) fail(`phase ${row.phase} already has open window ${openByPhase.get(row.phase)}`);
      openById.set(row.id, row);
      openByPhase.set(row.phase, row.id);
    } else if (row.type === "close") {
      const open = WINDOW_ID.test(row.id ?? "") ? openById.get(row.id) : null;
      if (!open) fail(`cannot close ${JSON.stringify(row.id)} (unknown or already closed)`);
      if (row.phase !== open.phase) fail(`close phase ${JSON.stringify(row.phase)} does not match open phase ${open.phase}`);
      if (!isoTime(row.closedAt)) fail("closedAt must be a valid ISO timestamp");
      if (!oneLine(row.closedBy)) fail("closedBy must be a non-empty single-line string");
      if (!CLOSE_VERDICTS.includes(row.verdict)) fail(`verdict must be one of ${CLOSE_VERDICTS.join(", ")}, got ${JSON.stringify(row.verdict)}`);
      if (row.verdict === "verified" && !SHA.test(row.commit ?? "")) fail("verified close requires a 40-hex commit SHA");
      if (row.verdict === "reframed" && row.commit != null && !SHA.test(row.commit)) fail("reframed close commit must be null or a 40-hex SHA");
      for (const opt of ["suiteReceipt", "ciReceipt", "note"])
        if (row[opt] != null && typeof row[opt] !== "string") fail(`${opt} must be a string`);
      openById.delete(row.id);
      openByPhase.delete(row.phase);
    } else fail(`unknown window event type ${JSON.stringify(row.type)}`);
    events.push(row);
  }
  return events;
}

/** Pure derivation of bounded window state for one phase. */
export function windowState({ windows = [], handoffs = [], rows = [], phase, nextRound = null }) {
  const byId = new Map(), history = [];
  for (const e of windows) {
    if (phase && e.phase !== phase) continue;
    if (e.type === "open") {
      const entry = { ...e, endRound: e.startRound + e.horizon - 1, closed: null };
      byId.set(e.id, entry);
      history.push(entry);
    } else if (e.type === "close" && byId.has(e.id)) byId.get(e.id).closed = e;
  }
  const active = history.find(w => !w.closed) ?? null;
  if (!active) {
    return { active: null, mode: "normal", usedActorRounds: 0, actorRounds: [], remainingSlack: 0,
      remainingActorRounds: 0, endRound: null, nextRound, gateDue: false, actorBlocked: false, alarm: null, history };
  }
  const actorRounds = [...new Set(
    handoffs.filter(h => h.phase === active.phase && h.role === "actor" && h.round >= active.startRound).map(h => h.round)
  )].sort((a, b) => a - b);
  const usedActorRounds = actorRounds.length;
  const mode = usedActorRounds < active.horizon - 1 ? "slack" : usedActorRounds === active.horizon - 1 ? "converging" : "gate-due";
  const lastRuling = rows
    .filter(r => r.phase === active.phase && r.role === "judge" && r.verdict !== "-" && r.round >= active.startRound)
    .sort((a, b) => a.round - b.round).at(-1) ?? null;
  const alarm = lastRuling?.verdict === "CONTINUE" ? {
    type: "window-horizon", key: windowAlarmKey(active.phase, active.id), windowId: active.id,
    phase: active.phase, round: lastRuling.round,
    message: `window ${active.id} (${active.horizon} rounds, start ${active.startRound}) received judge verdict CONTINUE in round ${lastRuling.round}; diagnose before reframing or opening a new window`,
  } : null;
  return {
    active, mode, usedActorRounds, actorRounds,
    remainingSlack: Math.max(0, active.horizon - 1 - usedActorRounds),
    remainingActorRounds: Math.max(0, active.horizon - usedActorRounds),
    endRound: active.endRound, nextRound,
    gateDue: mode === "gate-due", actorBlocked: mode === "gate-due", alarm, history,
  };
}

/** Check whether a committed post-open `reviewer-diagnosis` hand-off in `phase` cites `window-horizon:<phase>:<id>`. */
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

/** Next default round number from committed records (rounds/, trajectory, handoffs). */
export function defaultStartRound(records, at = "HEAD") {
  const snap = recordsSnapshot(records, at);
  const used = [...snap.files.keys()].flatMap(p => { const m = /^rounds\/(\d+)-/.exec(p); return m ? [Number(m[1])] : []; });
  return Math.max(0, ...used, ...parseRows(snap.read(TRAJECTORY)).map(r => r.round), ...parseHandoffs(snap.read(HANDOFFS)).map(h => h.round)) + 1;
}

function resolveLoop(records, read, cfg) {
  if (cfg) return { product: resolve(cfg.product), gates: cfg.gates, ...gatesOf(cfg) };
  const text = read("loop.json");
  if (text) {
    const raw = JSON.parse(text);
    if (raw && typeof raw.product === "string" && raw.product.trim())
      return { product: resolve(records, raw.product), gates: raw.gates, ...gatesOf(raw) };
  }
  return recordsLoop(records);
}

function verifyEvidence({ records, files, read, open, commit, handoffs, rows, cfg }) {
  if (!SHA.test(commit ?? "")) throw new WindowRefusalError(`window ${open.id} verified close requires a 40-hex --commit SHA`);
  const loop = resolveLoop(records, read, cfg);
  if (!loop?.product) throw new WindowRefusalError(`window ${open.id} verified close requires loop.json or --config naming the product repository`);
  const ruling = rows.filter(r =>
    r.phase === open.phase && r.role === "judge" && r.round >= open.startRound && (r.commit === commit || r.tip === commit)
  ).at(-1) ?? null;
  if (!ruling || ruling.verdict !== "CONVERGED")
    throw new WindowRefusalError(`window ${open.id} cannot close verified: no CONVERGED judge ruling covering ${commit} in ${TRAJECTORY} (round >= ${open.startRound})`);
  if (!SUITE_PASS.test(ruling.suite ?? ""))
    throw new WindowRefusalError(`window ${open.id} cannot close verified: judge ruling in round ${ruling.round} has failing or missing suite count ${JSON.stringify(ruling.suite)}`);
  const judge = handoffs.findLast(h =>
    h.phase === open.phase && h.role === "judge" && !JUDGE_FRAME_STEP.test(h.step)
    && h.round === ruling.round && h.product?.base === ruling.commit && files.has(h.record)
  );
  if (!judge) throw new WindowRefusalError(`window ${open.id} cannot close verified: no committed judge hand-off in ${HANDOFFS} for round ${ruling.round} on ${ruling.commit}`);
  const actors = handoffs.filter(h => h.phase === open.phase && h.role === "actor" && h.product?.commit && files.has(h.record));
  const covers = h => gitOk(loop.product, "merge-base", "--is-ancestor", h.product.commit, commit);
  const actor = actors.filter(h => h.round >= open.startRound).findLast(covers) ?? actors.findLast(covers);
  if (!actor) throw new WindowRefusalError(`window ${open.id} cannot close verified: no committed actor hand-off in ${HANDOFFS} covering ${commit}`);
  const [jv, av, jm, am] = [modelVendor(judge.agent), modelVendor(actor.agent), independenceModel(judge.agent), independenceModel(actor.agent)];
  if (!jv || !av || jv === av || !jm || !am || jm === am)
    throw new WindowRefusalError(`window ${open.id} cannot close verified: judge/actor vendor and model independence failed (actor ${av ?? "unknown"}/${am ?? "unknown"} vs judge ${jv ?? "unknown"}/${jm ?? "unknown"})`);
  const evidenceFiles = [...files.keys()].filter(evidenceJson);
  const suiteReceipt = evidenceFiles.find(p => { try { return receiptProblem(JSON.parse(read(p)), loop.product, commit) === null; } catch { return false; } }) ?? null;
  if (!suiteReceipt) throw new WindowRefusalError(`window ${open.id} cannot close verified: no committed green suite-green receipt for ${commit} under evidence/`);
  const { require } = gatesOf(loop);
  let ciReceipt = null;
  if (require) {
    const ciSha = ruling.tip ?? commit;
    const checkOk = r => (r?.sha === commit || r?.sha === ciSha) && r.ci === "success" && r.ok === true
      && require.every(spec => r.conclusions?.[spec] === "success");
    if (ruling.ciReceipt && rowReceiptProblem(ruling, p => files.has(p) ? read(p) : null) === null) {
      try { if (checkOk(JSON.parse(read(ruling.ciReceipt)))) ciReceipt = ruling.ciReceipt; } catch {}
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

/** Commit an `open` event to `metrics/windows.jsonl` atomically. */
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

/** Commit a `close` event to `metrics/windows.jsonl` after mechanically verifying real evidence. */
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
      ({ suiteReceipt, ciReceipt } = verifyEvidence({ records, files, read, open, commit, handoffs, rows, cfg }));
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
