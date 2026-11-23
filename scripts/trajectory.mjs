#!/usr/bin/env node
// D-0015, D-0024, D-0026, design/trajectory.md#the-row
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { CI_WORDS } from "./lib/check-runs.mjs";
import { ledgerRecords, notGreen, readCi, readingCause, recordsLoop, saveReceipt } from "./lib/ci-receipt.mjs";
import { admit, blockerState, dispositions, FIELDS as LISTS, isKey, isRuling, readRuling, rulingRows, transition, withStatus } from "./lib/blockers.mjs";
import { JUDGE_RECORD } from "./lib/judge-bar.mjs";
import { tipProblem } from "./lib/tip.mjs";

export const TRAJECTORY = "metrics/trajectory.jsonl";
export const VERDICTS = ["-", "CONTINUE", "CONVERGED", "REFRAME"];
export const CI = ["-", ...CI_WORDS];
export const DEFAULTS = { areaRounds: 3, recur: 2, growthRatio: 2, growthMin: 300, window: 4 };
export const COLUMNS = ["time", "round", "phase", "area", "role", "model", "verdict", "opened", "closed", "suite", "owner", "commit", "ci"];
// A blocker is `class:id`; any characters but whitespace, commas and (in the class) colons.
const BLOCKER = /^[^\s,:]+:[^\s,]+$/u;
const list = value => (!value || value === "-" ? [] : value.split(",").map(s => s.trim()).filter(Boolean));
// design/trajectory.md#the-row
const BLOCKER_FIELDS = { opened: BLOCKER, closed: BLOCKER, shelved: /^[^\s,]+$/u, carried: BLOCKER };
const ADDED_FIELDS = ["shelved", "carried"];
const EXCLUSIVE = [["opened", "carried"], ["opened", "shelved"], ["closed", "shelved"]];
const byRound = rows => [...rows].sort((a, b) => a.round - b.round);

/** Validate a row (the TSV columns, as strings except round); returns it with defaults filled. */
export function validateRow(fields, now = new Date()) {
  const r = { time: now.toISOString().slice(0, 19) + "Z", area: "-", model: "-", verdict: "-", opened: "-", closed: "-", suite: "-", owner: "0", commit: "-", ci: "-", ...fields };
  const fail = m => { throw new UsageError(m); };
  if (!Number.isInteger(r.round) || r.round < 1) fail("round must be a whole number from 1");
  for (const k of ["phase", "role", "area"]) if (typeof r[k] !== "string" || !r[k].trim() || /[\n\t]/.test(r[k])) fail(`${k} must be a one-line name`);
  if (!VERDICTS.includes(r.verdict)) fail(`verdict must be one of ${VERDICTS.join(", ")}`);
  if (!CI.includes(r.ci)) fail(`ci must be one of ${CI.join(", ")}`);
  if (r.commit !== "-" && !/^[0-9a-f]{40}$/.test(r.commit)) fail("commit must be a full 40-character SHA");
  if ("tip" in r && (!/^[0-9a-f]{40}$/.test(r.tip) || r.commit === "-")) fail("tip must be a full 40-character SHA after a ruled commit");
  if (!/^\d+$/.test(r.owner)) fail("owner must be a whole number from 0");
  if (r.suite !== "-" && !/^\d+\/\d+$/.test(r.suite)) fail("suite must be pass/fail, e.g. 812/0");
  for (const [k, form] of Object.entries(BLOCKER_FIELDS)) {
    if (!(k in r)) continue;
    if (typeof r[k] !== "string") fail(`${k} must be a list of class:id separated by commas`);
    for (const b of list(r[k])) if (!form.test(b)) fail(`${k} items must be class:id, got ${b}`);
  }
  for (const [a, b] of EXCLUSIVE) {
    const both = list(r[a]).filter(key => list(r[b]).includes(key));
    if (both.length) fail(`${both.join(", ")} cannot be both ${a} and ${b} in one row`);
  }
  return r;
}

/** The historical TSV form (one row per role per round). Every row must have every column. */
export function parse(text) {
  const lines = text.split("\n").filter(Boolean);
  if (!lines.length) return [];
  if (lines[0] !== COLUMNS.join("\t")) throw new Error(`trajectory header must be: ${COLUMNS.join(" ")}`);
  return lines.slice(1).map((line, i) => {
    const cells = line.split("\t");
    if (cells.length !== COLUMNS.length) throw new Error(`trajectory row ${i + 2} has ${cells.length} columns, expected ${COLUMNS.length}`);
    const row = Object.fromEntries(COLUMNS.map((c, j) => [c, cells[j]]));
    row.round = Number(row.round);
    if (!Number.isInteger(row.round)) throw new Error(`trajectory row ${i + 2}: round is not a number`);
    return row;
  });
}

/** Rows from either form, by extension. A malformed JSON row is an error. */
export function readRows(file) {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  return file.endsWith(".jsonl") ? parseRows(text, file) : parse(text);
}

export function parseRows(text, source = TRAJECTORY) {
  return text.split("\n").filter(Boolean).map((line, i) => {
    try { return validateRow({ time: "-", ...JSON.parse(line) }); } catch (e) { throw new Error(`${source}:${i + 1}: not a valid row (${e.message})`); }
  });
}

/**
 * Alarms over the rows (and optional module sizes per commit). Each alarm has a stable `key`, a `type`, a message and
 * its evidence.
 */
export function alarms(rows, { sizes = {}, ...options } = {}) {
  const o = { ...DEFAULTS, ...options };
  const out = [];
  // 1. The same area in N or more rounds of one phase.
  const areas = new Map();
  for (const r of rows) {
    if (r.area === "-" || !r.area) continue;
    const key = `${r.phase}\t${r.area}`;
    if (!areas.has(key)) areas.set(key, new Set());
    areas.get(key).add(r.round);
  }
  for (const [key, rounds] of areas) {
    if (rounds.size < o.areaRounds) continue;
    const [phase, area] = key.split("\t");
    const sorted = [...rounds].sort((a, b) => a - b);
    out.push({ type: "area-rounds", key: `area-rounds:${phase}:${area}`, count: sorted.length, at: sorted.at(-1),
      message: `area ${area} took ${sorted.length} rounds in phase ${phase}`, evidence: { rounds: sorted } });
  }
  // design/trajectory.md#recurrence-distinct-blockers
  const known = new Set(), classes = new Map();
  for (const r of byRound(rows)) {
    const { carried, opened } = dispositions(r);
    for (const b of carried) known.add(b);
    for (const b of opened) {
      if (known.has(b)) continue;
      known.add(b);
      const cls = b.split(":")[0];
      if (!classes.has(cls)) classes.set(cls, []);
      classes.get(cls).push({ blocker: b, round: r.round });
    }
  }
  for (const [cls, firsts] of classes) {
    if (firsts.length < o.recur) continue;
    const rounds = [...new Set(firsts.map(f => f.round))];
    out.push({ type: "blocker-recurring", key: `blocker-recurring:${cls}`, count: firsts.length, at: rounds.at(-1),
      message: `blocker class ${cls}: ${firsts.length} distinct blockers opened in ${rounds.length} round(s)`, evidence: { rounds, blockers: firsts.map(f => f.blocker) } });
  }
  // design/round9-b.md#partly-closed-reads-the-transition
  const states = new Map(), judged = new Map();
  for (const r of rulingRows(rows)) {
    const before = states.get(r.phase) ?? new Map();
    const key = `${r.phase}\t${r.area}`;
    const n = (judged.get(key) ?? 0) + 1;
    judged.set(key, n);
    const earlier = withStatus(before, "open").filter(b => b.origin === "opened" && b.area === r.area).map(b => b.key);
    const after = transition(before, r);
    states.set(r.phase, after);
    const now = status => earlier.filter(b => after.get(b).status === status);
    const still = now("open"), shelvedHere = now("shelved");
    if (n >= 2 && r.area !== "-" && still.length)
      out.push({ type: "partly-closed", key: `partly-closed:${r.phase}:${r.area}:${r.round}`, count: still.length, at: r.round,
        message: `area ${r.area} was ruled on ${n} times and ${still.length} of its ${earlier.length} earlier blocker(s) are still open after round ${r.round}`,
        evidence: { round: r.round, stillOpen: still, closed: now("closed"), ...(shelvedHere.length ? { shelved: shelvedHere } : {}) } });
  }
  // 4. A judged round whose commit failed the remote CI (pending is a wait, not an alarm), and a judge row whose
  //    candidate never reached real CI: never read (`absent`) or unreadable (`unknown`) (D-0015 item 4).
  for (const r of rows) {
    const absent = r.role === "judge" && ["absent", "unknown"].includes(r.ci);
    if (!absent && (r.verdict === "-" || r.ci !== "failure")) continue;
    const type = absent ? "ci-absent" : "ci-not-green";
    out.push({ type, key: `${type}:${r.phase}:${r.round}`, count: 1, at: r.round, evidence: { round: r.round, commit: r.commit, ci: r.ci },
      message: `round ${r.round} was judged on ${r.commit.slice(0, 7)} but its remote CI ${absent ? (r.ci === "absent" ? "never ran or was never read" : "could not be read") : "failed"}` });
  }
  // 5. A watched module or document that grew past the ratio within the last `window` judged rounds.
  const series0 = rows.filter(r => r.verdict !== "-" && r.commit !== "-").sort((a, b) => a.round - b.round);
  for (const [path, byCommit] of Object.entries(sizes)) {
    const series = series0.map(r => ({ round: r.round, commit: r.commit, size: lookup(byCommit, r.commit) })).filter(p => p.size !== undefined);
    for (let i = 0; i < series.length; i++) {
      const start = series[Math.max(0, i - o.window)];
      const now = series[i];
      if (now.size >= o.growthMin && start.size > 0 && now.size / start.size >= o.growthRatio) {
        out.push({ type: "growth", key: `growth:${path}`, count: now.size, at: now.round,
          message: `${path} grew from ${start.size} to ${now.size} between rounds ${start.round} and ${now.round}`, evidence: { path, from: start, to: now } });
        break; // the first crossing; the diagnosis covers the rest of the run
      }
    }
  }
  return out.sort((a, b) => a.at - b.at || a.type.localeCompare(b.type));
}

const lookup = (byCommit, commit) => {
  for (const [c, v] of Object.entries(byCommit)) if (c.startsWith(commit) || commit.startsWith(c)) return v;
  return undefined;
};

/** Alarms raised by rows up to and including round `n` (what supervision would have seen after that round). */
export const alarmsAfter = (rows, n, options) => alarms(rows.filter(r => r.round <= n), options);

/**
 * Fill a row's CI from one reading of the loop that owns its ledger (`records`, from lib/ci-receipt.mjs
 * `ledgerRecords`), saved as a receipt the row names; or say why it cannot be appended (null when it can, and nothing is
 * saved then). See the header for the rules.
 */
export function closeRow(row, records) {
  let loop = null;
  if (records) try { loop = recordsLoop(records); } catch (e) { return e.message; }
  if (!loop) {
    if (row.verdict === "CONVERGED")
      return `a CONVERGED row needs the loop's CI, and ${records ? `${records} holds no loop.json` : `the ledger is not ${TRAJECTORY} at the top of a records repository`}`;
    row.ci = "absent";
    return null;
  }
  if (row.phase !== loop.phase) return `--phase ${row.phase} is not the loop's phase ${JSON.stringify(loop.phase ?? null)} (${loop.config})`;
  const pushed = row.tip ?? row.commit;
  const problem = row.tip && tipProblem(loop.product, row.commit, row.tip);
  if (problem) return problem;
  const reading = readCi(loop, pushed);
  if (row.verdict === "CONVERGED" && reading.ci !== "success") return notGreen("CONVERGED", loop, pushed, reading);
  if (reading.ci === "unknown") console.error(`CI of ${pushed} unreadable, written as unknown: ${readingCause(reading)}`);
  Object.assign(row, { ci: reading.ci, ciReceipt: saveReceipt(records, row.round, reading) });
  return null;
}

// D-0026, R-0007-judge (R7-2), design/round9-b.md#one-ruling-one-transition
function additionOrder(records, paths) {
  const r = spawnSync("git", ["-C", records, "log", "--reverse", "--diff-filter=A", "--format=%x00", "--name-only", "--", ...paths], { encoding: "utf8" });
  const order = new Map();
  if (r.status !== 0) return order;
  let n = 0;
  for (const line of r.stdout.split("\n")) if (line === "\0") n++; else if (line && !order.has(line)) order.set(line, n);
  return order;
}

export function roundRulings(records, round) {
  const folder = join(records, "rounds");
  const paths = (existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : [])
    .filter(entry => entry.isFile() && Number(JUDGE_RECORD.exec(`rounds/${entry.name}`)?.[1]) === round)
    .map(entry => `rounds/${entry.name}`).sort();
  const order = paths.length > 1 ? additionOrder(records, paths) : new Map();
  const rank = path => order.get(path) ?? Infinity;
  return paths.sort((a, b) => (rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1) || a.localeCompare(b))
    .map(path => readRuling(path, readFileSync(join(records, path), "utf8")));
}

export function admitBlockers(row, records) {
  const flags = Object.fromEntries(LISTS.map(f => [f, list(row[f])]));
  if (!records)
    return flags.opened.length ? `--opened ${flags.opened.join(",")}: an opened key must be named by the round's judge record, and the ledger is not ${TRAJECTORY} at the top of a records repository` : null;
  const result = admit(row, roundRulings(records, row.round), flags, { where: records });
  if (result.refusal) return result.refusal;
  for (const f of LISTS) {
    if (result.fields[f].length) row[f] = result.fields[f].join(",");
    else if (f === "opened" || f === "closed") row[f] = "-";
    else delete row[f];
  }
  if (result.sources.length) console.error(`blocker keys from ${result.sources.join(", ")}`);
  return null;
}

function effect(row, file) {
  let rows;
  try { rows = readRows(file); } catch (e) { return `the blocker state after this row is not computed: ${e.message}`; }
  const before = blockerState(rows, { phase: row.phase });
  const after = transition(before, row);
  const { closed, shelved, opened, carried } = dispositions(row);
  const listedHere = new Set([...opened, ...carried]);
  const idle = [...closed, ...shelved].filter(key => before.get(key)?.status !== "open" && !listedHere.has(key));
  const keys = status => withStatus(after, status).map(b => b.key).join(", ") || "none";
  return [`phase ${row.phase} after round ${row.round}: open ${keys("open")}; shelved ${keys("shelved")}`,
    ...idle.map(key => `${key} was not open in phase ${row.phase} before this row (no earlier ruling of the phase opened or carried it)`)].join("\n");
}

/** Flags that once named the loop or the CI word: the append derives them now, so passing one is a usage error. */
const REMOVED = ["config", "repo", "remote", "ci", "ci-receipt"];
const FIELDS = ["commit", "tip", "area", "verdict", "opened", "closed", "shelved", "carried", "suite", "owner", "model"];
const APPEND = ["file", "round", "phase", "role", ...FIELDS];
const USAGE = [
  "trajectory.mjs append --file <records>/metrics/trajectory.jsonl --round N --phase P --role judge --commit SHA [--tip SHA]",
  "  [--area A --verdict V --suite pass/fail --owner N --model M]",
  "  [--opened class:id,... --closed class:id,... --shelved class:id,... --carried class:id,...]: the round's ruling on --commit supplies these from its",
  "  OPENED:, CLOSED:, SHELVED: and CARRIED: lines; a flag adds a key another judge record of the round names, or records a ruling without those lines",
  "trajectory.mjs alarms --file <trajectory.jsonl | trajectory.tsv> [--sizes <json>] [--json]",
  "  [--area-rounds 3 --recur 2 --growth-ratio 2 --growth-min 300 --window 4]",
].join("\n");

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (command === "append") {
    const removed = REMOVED.find(key => key in args);
    if (removed) throw new UsageError(`--${removed} was removed: the append takes the product, push remote and required checks from the loop.json of the records holding --file, and reads CI itself`);
    const unknown = Object.keys(args).find(key => key !== "_" && !APPEND.includes(key));
    if (unknown) throw new UsageError(`append takes no --${unknown}`);
    need(args, "file", "round", "phase", "role", "commit");
    if (!args.file.endsWith(".jsonl")) throw new UsageError("append writes the trajectory, a .jsonl file");
    const fields = { round: Number(args.round), phase: args.phase, role: args.role };
    for (const k of FIELDS) if (args[k] && !(ADDED_FIELDS.includes(k) && !list(args[k]).length)) fields[k] = args[k];
    const row = validateRow(fields);
    const malformed = LISTS.flatMap(f => list(row[f]).filter(key => !isKey(key)).map(key => `--${f} ${key}`));
    if (malformed.length) throw new UsageError(`${malformed.join(", ")}: a blocker key is class:id, with no whitespace or comma`);
    let ledger;
    try { ledger = ledgerRecords(args.file, TRAJECTORY); } catch (e) { throw new UsageError(`--file: ${e.message}`); }
    const refusal = admitBlockers(row, ledger.records) ?? (validateRow(row), closeRow(row, ledger.records));
    if (refusal) {
      console.error(`Refused: ${refusal}`);
      return 2;
    }
    if (isRuling(row)) console.error(effect(row, ledger.path));
    appendFileSync(ledger.path, `${JSON.stringify(row)}\n`);
    console.log(JSON.stringify(row));
    return 0;
  }
  if (command === "alarms") {
    need(args, "file");
    const rows = readRows(args.file);
    const num = k => (args[k] === undefined || args[k] === "" ? undefined : Number(args[k]));
    const options = Object.fromEntries(Object.entries({
      areaRounds: num("area-rounds"), recur: num("recur"), growthRatio: num("growth-ratio"), growthMin: num("growth-min"), window: num("window"),
    }).filter(([, v]) => v !== undefined));
    const sizes = args.sizes ? JSON.parse(readFileSync(args.sizes, "utf8")) : {};
    const found = alarms(rows, { sizes, ...options });
    if ("json" in args) console.log(JSON.stringify(found, null, 2));
    else for (const a of found) console.log(`ALARM ${a.type}  ${a.message}`);
    if (!found.length && !("json" in args)) console.log("no alarms");
    return 0; // screening: never blocks
  }
  throw new UsageError(USAGE);
});
