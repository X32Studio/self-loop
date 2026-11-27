// P-0011, D-0016, D-0058, D-0062, D-0064, D-0067, design/two-loop-rhythm.md#2, design/paseo-and-judge-policy.md#2
export const WINDOWS = "metrics/windows.jsonl";
export const WINDOW_ID = /^W-\d{4}$/;
export const MIN_HORIZON = 2;
export const MAX_HORIZON = 12;
export const CLOSE_VERDICTS = Object.freeze(["verified", "reframed"]);
export const windowAlarmKey = (phase, id) => `window-horizon:${phase}:${id}`;

const SHA = /^[0-9a-f]{40}$/;
const REPORT_DELIMITER = "\n```\n\n## Report (verbatim)\n\n";
const CLEAR_FIELD = /^(?:-|none)$/i;
const PASSING_SUITE = /^[1-9]\d*\/0$/;
const pad = n => String(n).padStart(4, "0");
const oneLine = s => typeof s === "string" && s.trim().length > 0 && !/[\r\n\t]/.test(s);
const isoTime = s => typeof s === "string" && s.length > 0 && Number.isFinite(Date.parse(s));

function reportBody(full) {
  const boundary = full.indexOf(REPORT_DELIMITER);
  return boundary < 0 ? full : full.slice(boundary + REPORT_DELIMITER.length);
}

function headerFields(report, name) {
  return [...report.matchAll(new RegExp(`^${name}:[ \t]*(.*)$`, "gm"))].map(m => m[1].trim());
}

export function parseNoDisputeCritic(handoff, { read = null, has = null } = {}) {
  if (!handoff || handoff.role !== "critic" || typeof read !== "function") return null;
  if (handoff.audit !== undefined && handoff.audit?.violations !== 0) return null;
  if (!Array.isArray(handoff.files) || typeof handoff.record !== "string") return null;
  const checkHas = typeof has === "function" ? has : () => true;
  if (!checkHas(handoff.record)) return null;
  const round = pad(handoff.round);
  const sealed = `sealed/critic/${round}/${handoff.step}-${handoff.attempt}.md`;
  const file = handoff.files.includes(sealed) ? sealed : handoff.record;
  if (!handoff.files.includes(file) || !checkHas(file)) return null;
  const full = read(file);
  if (typeof full !== "string" || !full) return null;
  const report = reportBody(full);
  const verdict = headerFields(report, "VERDICT"), acceptance = headerFields(report, "ACCEPTANCE");
  const disputes = headerFields(report, "DISPUTES"), opened = headerFields(report, "OPENED");
  const ok = verdict.length === 1 && (verdict[0] === "CONVERGED" || verdict[0] === "PASS")
    && acceptance.length === 1 && acceptance[0] === "pass"
    && disputes.length <= 1 && disputes.every(v => CLEAR_FIELD.test(v))
    && opened.length <= 1 && opened.every(v => CLEAR_FIELD.test(v));
  if (!ok) return null;
  return {
    id: handoff.id ?? null,
    round: handoff.round,
    verdict: verdict[0],
    commit: handoff.product?.commit ?? handoff.product?.base ?? null,
    base: handoff.product?.base ?? null,
    record: handoff.record,
    time: handoff.time ?? "",
  };
}

export function isNoDisputeCriticHandoff(handoff, opts = {}) {
  return Boolean(parseNoDisputeCritic(handoff, opts));
}

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

export function windowState({ windows = [], handoffs = [], rows = [], phase, nextRound = null, read = null, files = null }) {
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
      remainingActorRounds: 0, endRound: null, nextRound, gateDue: false, actorBlocked: false,
      lastRuling: null, criticConverged: null, alarm: null, history };
  }
  const actorRounds = [...new Set(
    handoffs.filter(h => h.phase === active.phase && h.role === "actor" && h.round >= active.startRound).map(h => h.round)
  )].sort((a, b) => a - b);
  const usedActorRounds = actorRounds.length;
  const mode = usedActorRounds < active.horizon - 1 ? "slack" : usedActorRounds === active.horizon - 1 ? "converging" : "gate-due";
  const phaseRows = rows.filter(r => r.phase === active.phase && r.round >= active.startRound);
  const lastRowRuling = phaseRows
    .filter(r => (r.role === "judge" || r.role === "critic") && r.verdict !== "-")
    .sort((a, b) => a.round - b.round).at(-1) ?? null;
  const hasFn = files
    ? (typeof files.has === "function" ? p => files.has(p) : Array.isArray(files) ? p => files.includes(p) : null)
    : null;
  const criticConverged = typeof read === "function"
    ? handoffs
      .filter(h => h.phase === active.phase && h.role === "critic" && h.round >= active.startRound)
      .map(h => parseNoDisputeCritic(h, { read, has: hasFn }))
      .filter(c => {
        if (!c) return false;
        const contradicting = phaseRows.findLast(r => r.round >= c.round
          && ((c.commit && (r.commit === c.commit || r.tip === c.commit)) || r.round === c.round)
          && r.verdict !== "-");
        if (!contradicting) return true;
        if (contradicting.verdict !== "CONVERGED" && contradicting.verdict !== "PASS") return false;
        return contradicting.suite === undefined || contradicting.suite === "-" || PASSING_SUITE.test(contradicting.suite);
      })
      .sort((a, b) => a.round - b.round || String(a.time).localeCompare(String(b.time)))
      .at(-1) ?? null
    : null;
  const lastRuling = criticConverged && (!lastRowRuling || criticConverged.round > lastRowRuling.round)
    ? { round: criticConverged.round, phase: active.phase, role: "critic", verdict: criticConverged.verdict, commit: criticConverged.commit ?? "-", id: criticConverged.id }
    : lastRowRuling;
  const alarm = lastRuling?.verdict === "CONTINUE" ? {
    type: "window-horizon", key: windowAlarmKey(active.phase, active.id), windowId: active.id,
    phase: active.phase, round: lastRuling.round,
    message: `window ${active.id} (${active.horizon} rounds, start ${active.startRound}) received ${lastRuling.role} verdict CONTINUE in round ${lastRuling.round}; diagnose before reframing or opening a new window`,
  } : null;
  return {
    active, mode, usedActorRounds, actorRounds,
    remainingSlack: Math.max(0, active.horizon - 1 - usedActorRounds),
    remainingActorRounds: Math.max(0, active.horizon - usedActorRounds),
    endRound: active.endRound, nextRound,
    gateDue: mode === "gate-due", actorBlocked: mode === "gate-due",
    lastRuling, criticConverged, alarm, history,
  };
}
