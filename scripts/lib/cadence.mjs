// D-0032, D-0030, D-0058, D-0060, design/generative-engine-b.md#the-cadence, design/mandatory-control-plane.md#3
import { compareArchFacts, structuralBreaches } from "./arch-facts.mjs";
import { UsageError } from "./args.mjs";
import { globMatch } from "./plan-globs.mjs";

export const CADENCE_DEFAULTS = Object.freeze({ adversarial: 3, deliveries: 4, outerGrace: 2 });
export const FRAME_STEP = /^reviewer-frame(?:-[a-z]+)*$/;
export const ARCH_STEP = /^reviewer-architecture(?:-[a-z]+)*$/;
export const DISTILL_STEP = /^reviewer-distill(?:-[a-z]+)*$/;
export const JUDGE_FRAME_STEP = /^judge-frame(?:-[a-z]+)*$/;
export const PHASE_FRAME_STEP = "reviewer-frame";
// design/generative-engine-b.md#the-advancing-round
export const ADVANCING_CALLS = Object.freeze([
  { name: "blind frame", role: "reviewer", step: "reviewer-frame-blind", kind: /^reviewer-frame-blind(?:-[a-z]+)*$/ },
  { name: "frame", role: "reviewer", step: "reviewer-frame", kind: /^reviewer-frame(?!-blind(?:-|$))(?:-[a-z]+)*$/ },
  { name: "judge-frame", role: "judge", step: "judge-frame", kind: JUDGE_FRAME_STEP },
]);

const isRuling = row => row.role === "judge" && row.verdict !== "-";
const keys = value => [...new Set((Array.isArray(value) ? value : typeof value === "string" && value !== "-" ? value.split(",") : [])
  .map(s => String(s).trim()).filter(Boolean))];
const numeric = (a, b) => a - b;
const isFrameStep = step => FRAME_STEP.test(step) || JUDGE_FRAME_STEP.test(step);

export function cadenceOf(cfg) {
  const where = cfg.configFile ?? "loop.json";
  if (!("cadence" in cfg) || cfg.cadence === undefined) return { adversarial: CADENCE_DEFAULTS.adversarial, source: "default" };
  const given = cfg.cadence;
  if (!given || typeof given !== "object" || Array.isArray(given))
    throw new UsageError(`${where}: cadence must be an object such as {"adversarial": ${CADENCE_DEFAULTS.adversarial}}, got ${JSON.stringify(given)}`);
  const unknown = Object.keys(given).filter(key => !(key in CADENCE_DEFAULTS));
  if (unknown.length) throw new UsageError(`${where}: cadence takes only ${Object.keys(CADENCE_DEFAULTS).join(", ")}, got ${unknown.join(", ")}`);
  if ("adversarial" in given && !(Number.isInteger(given.adversarial) && given.adversarial >= 1))
    throw new UsageError(`${where}: cadence.adversarial must be a positive whole number, got ${JSON.stringify(given.adversarial)}`);
  if ("deliveries" in given && !(Number.isInteger(given.deliveries) && given.deliveries >= 1))
    throw new UsageError(`${where}: cadence.deliveries must be a positive whole number, got ${JSON.stringify(given.deliveries)}`);
  if ("outerGrace" in given && !(Number.isInteger(given.outerGrace) && given.outerGrace >= 0))
    throw new UsageError(`${where}: cadence.outerGrace must be a non-negative whole number, got ${JSON.stringify(given.outerGrace)}`);
  const hasAny = "adversarial" in given || "deliveries" in given || "outerGrace" in given;
  const out = { adversarial: given.adversarial ?? CADENCE_DEFAULTS.adversarial, source: hasAny ? "loop.json" : "default" };
  if ("deliveries" in given) out.deliveries = given.deliveries;
  if ("outerGrace" in given) out.outerGrace = given.outerGrace;
  return out;
}

// P-0011, D-0058
export function outerCadenceOf(cfg) {
  cadenceOf(cfg);
  const given = cfg.cadence ?? {};
  return {
    deliveries: given.deliveries ?? CADENCE_DEFAULTS.deliveries,
    outerGrace: given.outerGrace ?? CADENCE_DEFAULTS.outerGrace,
    source: "deliveries" in given || "outerGrace" in given ? "loop.json" : "default",
  };
}

function stepsByRound(entries) {
  const byRound = new Map();
  for (const { round, step, id } of entries) {
    if (!byRound.has(round)) byRound.set(round, new Map());
    byRound.get(round).set(step, id);
  }
  return byRound;
}

// design/generative-engine-b.md#the-window
export function cadenceState({ handoffs, rows, adversarial = CADENCE_DEFAULTS.adversarial, prepared = [], nextRound }) {
  const recorded = stepsByRound(handoffs);
  const complete = steps => [...steps.keys()].some(s => FRAME_STEP.test(s)) && [...steps.keys()].some(s => JUDGE_FRAME_STEP.test(s));
  const advancing = [...recorded].filter(([, steps]) => complete(steps)).map(([round]) => round).sort(numeric);
  const frame = handoffs.filter(h => h.role === "reviewer" && h.step === PHASE_FRAME_STEP)
    .sort((a, b) => a.round - b.round || String(a.time).localeCompare(String(b.time)))[0] ?? null;
  const last = advancing.at(-1) ?? null;
  const baseline = last !== null
    ? { kind: "advancing", round: last, ids: [...recorded.get(last)].filter(([s]) => isFrameStep(s)).map(([, id]) => id) }
    : frame ? { kind: "frame", round: frame.round, ids: [frame.id] } : null;
  const empty = { adversarial, baseline, advancing, rounds: [], count: 0, due: false, next: null, returns: [] };
  if (!baseline) return empty;

  const skip = new Set(advancing);
  const inWindow = row => !skip.has(row.round) && (baseline.kind === "advancing" ? row.round > baseline.round : row.round >= baseline.round);
  const window = rows.filter(row => isRuling(row) && inWindow(row));
  const rounds = [...new Set(window.map(row => row.round))].sort(numeric);
  const due = rounds.length >= adversarial;
  return { ...empty, rounds, count: rounds.length, due, returns: returnsOf(window),
    next: due ? advancingRound({ recorded, prepared, after: rounds.at(-1), nextRound }) : null };
}

// design/generative-engine-b.md#the-advancing-round
function advancingRound({ recorded, prepared, after, nextRound }) {
  const pending = stepsByRound(prepared.filter(p => isFrameStep(p.step)));
  const started = [...new Set([...recorded].filter(([round, steps]) => round > after && [...steps.keys()].some(isFrameStep)).map(([round]) => round)
    .concat([...pending.keys()].filter(round => round > after)))].sort(numeric);
  const round = started.at(-1) ?? nextRound;
  const done = recorded.get(round) ?? new Map(), held = pending.get(round) ?? new Map();
  const find = (steps, call) => [...steps].find(([step]) => call.kind.test(step));
  const [blind, frame] = ADVANCING_CALLS;
  const calls = ADVANCING_CALLS.map(call => {
    const ran = find(done, call), waiting = find(held, call);
    if (ran) return { ...call, state: "recorded", id: ran[1] };
    if (waiting) return { ...call, state: "prepared", id: waiting[1] };
    const after = call === blind ? find(done, frame) ?? find(held, frame) : null;
    return after ? { ...call, state: "covered", id: after[1] } : { ...call, state: "due" };
  });
  return { round, started: started.length > 0, calls };
}

// design/generative-engine-b.md#returns-per-area
function returnsOf(window) {
  const areas = new Map();
  for (const row of [...window].sort((a, b) => a.round - b.round)) {
    const area = row.area && row.area !== "-" ? row.area : "-";
    if (!areas.has(area)) areas.set(area, new Map());
    const perRound = areas.get(area);
    if (!perRound.has(row.round)) perRound.set(row.round, { opened: new Set(), closed: new Set(), shelved: new Set() });
    const tally = perRound.get(row.round);
    for (const field of ["opened", "closed", "shelved"]) for (const key of keys(row[field])) tally[field].add(key);
  }
  return [...areas].map(([area, perRound]) => ({ area, rounds: [...perRound].map(([round, t]) => ({
    round, opened: [...t.opened], closed: [...t.closed], shelved: [...t.shelved] })) }));
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const baselineText = baseline => baseline.kind === "frame"
  ? `the phase frame ${baseline.ids[0]}` : `the advancing round ${baseline.round} (${baseline.ids.join(", ")})`;
const roundsText = rounds => `${rounds.length === 1 ? "round" : "rounds"} ${rounds.join(", ")}`;
const settingText = ({ adversarial, source }) => `cadence.adversarial ${adversarial}${source === "loop.json" ? " in loop.json" : ", the default"}`;
const counted = state => `${plural(state.count, "judged adversarial round")} since ${baselineText(state.baseline)}`;

export function cadenceLines(cadence, sources) {
  const { state } = cadence;
  if (!state.baseline) return [`Cadence: counted from the phase frame, which is not recorded yet (${sources}; D-0032)`];
  const when = state.due ? "advancing round due" : `next advancing round after ${plural(state.adversarial, "judged adversarial round")}, ${state.adversarial - state.count} more`;
  const lines = [`Cadence: ${counted(state)}${state.count ? ` (${roundsText(state.rounds)})` : ""} · ${when} (${settingText(cadence)}; D-0032; ${sources})`];
  if (!state.returns.length) return lines;
  lines.push(`Returns per area since ${baselineText(state.baseline)}: blockers opened and closed per judged round (${sources})`);
  for (const { area, rounds } of state.returns)
    lines.push(`  ${area === "-" ? "no area" : area}: ${rounds.map(r => `round ${r.round} opened ${r.opened.length}, closed ${r.closed.length}${r.shelved.length ? `, shelved ${r.shelved.length}` : ""}`).join(" · ")}`);
  return lines;
}

export const dueReason = cadence => `advancing round due: ${counted(cadence.state)} (${roundsText(cadence.state.rounds)}; ${settingText(cadence)}; D-0032)`;

// design/generative-engine-b.md#what-next-lists
export function advancingAction(cadence, callFor) {
  const { state } = cadence, { round, started, calls } = state.next;
  const status = { recorded: c => `recorded, ${c.id}`, prepared: c => `prepared, ${c.id}; record it when the child finishes`, covered: c => `not needed after ${c.id}` };
  return {
    title: `advancing round due: ${counted(state)} (${roundsText(state.rounds)}), ${settingText(cadence)}`,
    steps: [`Round ${round} is the advancing round${started ? ", already started" : ""}: the generative engine reviews the direction, the value of continuing each area (the returns above) and the next features, a judge of another vendor rules on its derivations (D-0030). Hardening of an area under review pauses; work whose direction an owner decision or an independent ruling already settles runs alongside it, and work on a new or changed derivation waits for that ruling (D-0032 item 1, R-0008-judge-frame-dispatch).`,
      ...calls.flatMap(c => c.state === "due" ? [`${c.name} (${c.step}):`, ...callFor(c.role, c.step, round).map(line => `  ${line}`)]
        : [`${c.name} (${c.step}): ${status[c.state](c)}`])],
  };
}

const isOuterBaseline = step => FRAME_STEP.test(step) || ARCH_STEP.test(step) || JUDGE_FRAME_STEP.test(step);

function intersectsHotspots(packageFiles, hotspotPaths) {
  if (!packageFiles.length || !hotspotPaths.length) return false;
  for (const pattern of packageFiles) {
    for (const target of hotspotPaths) {
      if (pattern === target || globMatch(pattern, target)) return true;
    }
  }
  return false;
}

// P-0011, D-0058, D-0060, design/mandatory-control-plane.md#3
export function outerLoopState({
  handoffs = [],
  rows = [],
  archBreaches,
  baselineFacts = null,
  currentFacts = null,
  facts = null,
  prepared = [],
  packageFiles = null,
  deliveries = CADENCE_DEFAULTS.deliveries,
  outerGrace = CADENCE_DEFAULTS.outerGrace,
  phase = null,
  targetSha = null,
} = {}) {
  const scoped = phase ? handoffs.filter(h => h.phase === phase) : handoffs;
  const recordedIds = new Set(scoped.map(h => h.id).filter(Boolean));
  let baseline = null;
  let baselineIdx = -1;
  for (let i = 0; i < scoped.length; i++) {
    const h = scoped[i];
    if (!isOuterBaseline(h.step)) continue;
    if (!baseline
        || h.round > baseline.round
        || (h.round === baseline.round && (String(h.time ?? "").localeCompare(String(baseline.time ?? "")) >= 0))) {
      baseline = h;
      baselineIdx = i;
    }
  }
  const afterBaseline = baseline
    ? scoped.filter((h, i) => h.round > baseline.round || (h.round === baseline.round && i > baselineIdx))
    : scoped;
  const actorRounds = [...new Set(afterBaseline.filter(h => h.role === "actor").map(h => h.round))].sort(numeric);
  const deliveriesSince = actorRounds.length;
  const reviewedExactTarget = Boolean(
    baseline && ARCH_STEP.test(baseline.step) && targetSha
    && baseline.product?.base === targetSha && deliveriesSince === 0,
  );
  const resolvedFacts = currentFacts ?? facts;
  const computedBreaches = resolvedFacts && baselineFacts
    ? compareArchFacts(resolvedFacts, baselineFacts)
    : resolvedFacts && archBreaches === undefined
      ? structuralBreaches(resolvedFacts)
      : (archBreaches ?? []);
  const effectiveBreaches = reviewedExactTarget ? [] : computedBreaches;
  const hotspotPaths = [...new Set(effectiveBreaches.map(b => b.path).filter(Boolean))].sort();
  const activeArch = (prepared ?? []).filter(
    p => ARCH_STEP.test(p?.step ?? "")
      && (!phase || !p.phase || p.phase === phase)
      && p.cancelled !== true
      && p.liveWorkspace !== false
      && !(p.id && recordedIds.has(p.id)),
  );
  const archReviewActive = activeArch.length > 0;
  const t1Due = deliveriesSince >= deliveries;
  const t3Due = effectiveBreaches.length > 0;
  const triggered = t1Due || t3Due;
  const t1HardDue = t1Due && deliveriesSince >= deliveries + outerGrace;
  const t3HardDue = t3Due && deliveriesSince >= outerGrace;
  const graceExceeded = t1HardDue || t3HardDue;
  const status = !triggered ? "ok" : graceExceeded ? "hard-due" : "async-due";
  const blocked = !graceExceeded
    ? false
    : t3HardDue && archReviewActive && Array.isArray(packageFiles)
      ? intersectsHotspots(packageFiles, hotspotPaths)
      : true;
  const graceRemaining = !triggered
    ? outerGrace
    : Math.max(0, Math.min(
      t1Due ? (deliveries + outerGrace) - deliveriesSince : Infinity,
      t3Due ? outerGrace - deliveriesSince : Infinity,
    ));
  return {
    status,
    triggered,
    t1Due,
    t3Due,
    blocked,
    archReviewActive,
    hotspotPaths,
    deliveriesSince,
    deliveries,
    outerGrace,
    graceRemaining,
    baseline,
    actorRounds,
    archBreaches: effectiveBreaches,
  };
}

export function outerLoopLines(outer) {
  const baseLabel = outer.baseline ? outer.baseline.id : "phase start";
  const triggers = [...(outer.t1Due ? ["T1"] : []), ...(outer.t3Due ? ["T3"] : [])].join("+");
  if (!outer.triggered) {
    return [`Outer loop: ok · ${outer.deliveriesSince}/${outer.deliveries} committed deliveries since ${baseLabel} (grace +${outer.outerGrace})`];
  }
  const tail = outer.status === "hard-due"
    ? `grace (${outer.outerGrace}) exceeded; new actor calls blocked (exit 7)`
    : `${outer.graceRemaining} delivery(ies) before hard-block`;
  const lines = [`Outer loop: ${outer.status} (${triggers}) · ${outer.deliveriesSince}/${outer.deliveries} committed deliveries since ${baseLabel} · ${tail}`];
  for (const b of outer.archBreaches.slice(0, 5)) {
    lines.push(`  T3 ${b.kind}: ${b.path} (${b.detail})`);
  }
  return lines;
}
