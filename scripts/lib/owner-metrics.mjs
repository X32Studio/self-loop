import { ANSWERS, batchesFrom, OUTCOMES, parseEvents } from "../decisions.mjs";
import { citedPredicates, predicateReplay } from "../loop.mjs";
import { interventionDisposition, ownerRecords } from "../records-check.mjs";
import { UsageError } from "./args.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { CLASSES } from "./owner-words.mjs";
import { firstPublication } from "./plan-measures.mjs";

const share = (part, whole) => whole ? part / whole : null;

export function phaseWindow(handoffs, phase) {
  const first = handoffs.filter(h => h.phase === phase && Number.isFinite(Date.parse(h.time)))
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))[0];
  return { from: first?.time ?? null, to: null, start: first?.id ?? null, end: null };
}

const within = (window, time, now) => {
  const at = Date.parse(time);
  return window.from !== null && Number.isFinite(at) && at >= Date.parse(window.from) && at <= now;
};

export function phaseMetrics(records, phase, { revision = "HEAD", falseAlarms = true } = {}) {
  const now = Date.now();
  const tree = ownerRecords(records, revision);
  if (phase === undefined || phase === null || phase === "") {
    let loop = {};
    try { loop = JSON.parse(tree.read("loop.json") || "{}"); } catch (e) { throw new UsageError(`loop.json is not JSON (${e.message}); pass --phase`); }
    phase = typeof loop.phase === "string" && loop.phase.trim() ? loop.phase : null;
    if (!phase) throw new UsageError("--phase is needed: the committed records have no loop.json phase");
  }
  const window = phaseWindow(parseHandoffs(tree.read(HANDOFFS)), phase);
  const states = tree.states.filter(s => within(window, s.word.time, now));
  const classes = Object.fromEntries([...CLASSES, "unclassified", "open"].map(c => [c, 0]));
  for (const s of states) classes[s.settled ? s.class : "open"]++;
  // F-0011, R-0008-judge-mechanisms, design/generative-engine.md#raised-first-replay
  const interventions = tree.interventions.map(({ id, path, text }) => {
    const disposition = interventionDisposition(text);
    return { id, path, ...disposition, predicates: disposition.disposed && disposition.rung === "screening predicate" ? citedPredicates(disposition.carriedBy) : [] };
  });
  const byIntervention = new Map(interventions.map(i => [i.id, i]));
  const settled = states.filter(s => s.settled && s.class === "direction");
  const cited = settled.flatMap(s => (byIntervention.get(s.mark.intervention)?.predicates ?? [])
    .map(predicate => ({ word: s.word.id, time: s.word.time, intervention: s.mark.intervention, predicate })));
  const replay = cited.length ? predicateReplay(records, { revision: tree.rev, phase, from: window.from, cited, falseAlarms }) : { results: [], predicates: {} };
  const screening = [...tree.raised.screening];
  for (const i of interventions) if (i.disposed && i.rung === "screening predicate" && !i.predicates.length)
    screening.push({ rule: "predicate", path: i.path, detail: `${i.id} names the screening predicate rung, but its carried-by: names no registered predicate, so nothing is replayed (A2)` });
  // R-0008-judge, D-0030, design/round9-a.md#raised-first-and-would-have-fired
  const directions = settled.map(s => {
    const claim = tree.raised.claims.get(s.mark.intervention);
    const replayed = replay.results.filter(r => r.word === s.word.id).map(({ predicate, fires, snapshot, evidence, needs }) => ({ predicate, fires, snapshot, evidence, ...(needs ? { needs } : {}) }));
    return { id: s.word.id, time: s.word.time, intervention: s.mark.intervention, raisedFirst: claim?.named === null ? "no" : claim?.named ?? null,
      verified: Boolean(claim?.verified), wouldHaveFired: replayed.filter(r => r.fires === true).map(r => r.predicate), predicates: replayed, problems: claim?.problems ?? [] };
  });
  const raisedFirst = directions.filter(d => d.verified).length;
  const covered = directions.filter(d => d.wouldHaveFired.length);
  const batches = batchesFrom([...tree.ids.values()].filter(p => /^owner\/B-\d{4}\.md$/.test(p)), path => tree.read(path))
    .filter(b => b.phase === phase);
  const answersByOutcome = Object.fromEntries([...OUTCOMES, "unlabelled"].map(o => [o, 0]));
  for (const answer of batches.flatMap(b => b.answers)) answersByOutcome[OUTCOMES.includes(answer.outcome) ? answer.outcome : "unlabelled"]++;
  const labelled = OUTCOMES.reduce((n, o) => n + answersByOutcome[o], 0);
  return {
    phase, window, words: states.length, classes,
    ownerDirections: directions.length, raisedFirst, raisedFirstShare: share(raisedFirst, directions.length),
    wouldHaveFired: { directions: covered.length, words: covered.map(d => d.id), basis: COUNTERFACTUAL },
    batchesSent: batches.length, batchesAnswered: batches.filter(b => b.answers.length > 0).length,
    ownerWaiting: ownerWaiting(batches, { records, revision: tree.rev, events: parseEvents(tree.read(ANSWERS)), now }),
    answersByOutcome, answeredWithOutcome: labelled, precision: share(answersByOutcome["as-recommended"], labelled),
    unclassified: classes.unclassified,
    screening, interventions, undisposed: interventions.filter(i => !i.disposed).map(i => i.id), predicates: replay.predicates,
    directions, unclassifiedWords: states.filter(s => s.settled && s.class === "unclassified").map(s => s.word.id),
    openWords: states.filter(s => !s.settled).map(s => s.word.id),
    awaitingIntervention: states.filter(s => !s.settled && s.class === "direction").map(s => ({ id: s.word.id, intervention: s.mark.intervention })),
  };
}

export const COUNTERFACTUAL = "today's predicate code replayed on the records commit before each word; coverage for the independent review, never raised first";

const stamp = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

// R-0008-judge, D-0036, F-0012, design/round9-a.md#owner-waiting
export function ownerWaiting(batches, { records, revision, events, now = Date.now(), published = path => firstPublication({ records, revision }, path) }) {
  const intervals = batches.map(b => {
    const from = published(b.file);
    const replaced = events.find(e => e.batch === b.id && "replacedBy" in e);
    const answered = b.answers.length ? Math.min(...b.answers.map(a => stamp(a.time) ?? Infinity)) : null;
    const state = b.answers.length ? "answered" : replaced ? "replaced" : "open";
    const to = state === "answered" ? (Number.isFinite(answered) ? answered : null) : state === "replaced" ? stamp(replaced.time) : Math.floor(now / 1000) * 1000;
    const seconds = from !== null && to !== null && to >= from ? (to - from) / 1000 : null;
    const unknown = from === null ? `${b.file} has no single first publication in the records history`
      : to === null ? `${b.id}'s ${state === "answered" ? "answer" : "replacement"} has no valid time`
      : seconds === null ? `${b.id} ends before its publication` : null;
    return { batch: b.id, state, from: from === null ? null : new Date(from).toISOString(), to: to === null ? null : new Date(to).toISOString(), seconds, ...(unknown ? { unknown } : {}) };
  });
  const unknowns = intervals.filter(i => i.unknown).map(i => i.unknown);
  return { seconds: unknowns.length ? null : intervals.reduce((sum, i) => sum + i.seconds, 0), batches: intervals.length,
    open: intervals.filter(i => i.state === "open").map(i => i.batch), intervals, unknowns,
    definition: "each batch of the phase from its first publication to its first answer, to its replacement, or, while open, to now; summed" };
}

export function waitingText(w) {
  if (w.seconds === null) return `unknown (${w.unknowns.join("; ")})`;
  if (!w.batches) return "0 s (no owner batch sent in the phase)";
  return `${w.seconds} s over ${w.batches} owner batch${w.batches === 1 ? "" : "es"} of the phase${w.open.length ? `, ${w.open.join(", ")} still open and accruing` : ", none open"}`;
}

const percent = value => value === null ? "n/a" : `${Math.round(value * 1000) / 10}%`;

export function metricsLines(m) {
  const lines = [];
  if (m.window.from === null) lines.push(`phase ${m.phase}: no hand-off yet, so no window; no words counted`);
  else lines.push(`phase ${m.phase}: words captured from ${m.window.from} (${m.window.start}) to ${m.window.to ? `${m.window.to} (${m.window.end})` : "now"}: ${m.words}`);
  lines.push(`classes: ${Object.entries(m.classes).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  lines.push(`ownerDirections ${m.ownerDirections}`);
  lines.push(`raisedFirst ${m.raisedFirst} (${percent(m.raisedFirstShare)} of owner directions; a named record committed before every cited word)`);
  for (const d of m.directions)
    lines.push(`  ${d.id}  ${d.time}  ${d.intervention}  raised first: ${Array.isArray(d.raisedFirst) ? d.raisedFirst.join(", ") : d.raisedFirst ?? "not stated"}${d.verified ? " (verified by commit order)" : ""}${d.wouldHaveFired.length ? `  would have fired: ${d.wouldHaveFired.join(", ")}` : ""}${d.problems.length ? `  ${d.problems.join("; ")}` : ""}`);
  lines.push(`wouldHaveFired ${m.wouldHaveFired.directions} of ${m.ownerDirections} owner directions${m.wouldHaveFired.words.length ? ` (${m.wouldHaveFired.words.join(", ")})` : ""}: ${m.wouldHaveFired.basis}`);
  for (const [id, p] of Object.entries(m.predicates ?? {}))
    lines.push(`predicate ${id} (${p.path}, ${p.source}): cited by ${p.cited.join(", ")} · would have fired on the records commit before: ${p.fired.join(", ") || "none"} · would not have fired before: ${p.notFired.join(", ") || "none"}${p.unknown.length ? ` · undecided before: ${p.unknown.join(", ")}` : ""}${"falseAlarms" in p ? ` · false alarms ${p.falseAlarms} (firing episodes no correction followed, over ${p.snapshots} records commits${p.unknownSnapshots ? `, ${p.unknownSnapshots} undecided` : ""})` : ""}${p.needs ? ` · needs ${p.needs.event} (${p.needs.feature})` : ""}`);
  lines.push(`interventions ${m.interventions.length}, without a disposition ${m.undisposed.length}${m.undisposed.length ? `: ${m.undisposed.join(", ")}` : ""}`);
  lines.push(`batchesSent ${m.batchesSent}, batchesAnswered ${m.batchesAnswered}`);
  lines.push(`ownerWaiting ${waitingText(m.ownerWaiting)}`);
  lines.push(`answersByOutcome: ${Object.entries(m.answersByOutcome).map(([o, n]) => `${o} ${n}`).join(", ")}`);
  lines.push(`precision ${percent(m.precision)} (${m.answersByOutcome["as-recommended"]} as-recommended / ${m.answeredWithOutcome} answered with an outcome)`);
  lines.push(`unclassified ${m.unclassified}${m.unclassifiedWords.length ? `: ${m.unclassifiedWords.join(", ")}` : ""}`);
  const awaiting = new Map(m.awaitingIntervention.map(d => [d.id, d.intervention]));
  if (m.openWords.length) lines.push(`open ${m.openWords.length}, not counted until settled: ${m.openWords.map(id => awaiting.has(id) ? `${id} (direction, ${awaiting.get(id)} not recorded)` : id).join(", ")}`);
  for (const finding of m.screening) lines.push(`screening: ${finding.path}: ${finding.detail}`);
  return lines;
}
