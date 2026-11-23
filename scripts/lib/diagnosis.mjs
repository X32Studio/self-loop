// design/alarm-gate.md#the-rule; D-0015 item 3, D-0017
import { git, run } from "./git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./handoff.mjs";
import { alarms, parseRows, TRAJECTORY } from "../trajectory.mjs";

/** Steps that diagnose: `reviewer-diagnosis`, or a further one in the same round such as `reviewer-diagnosis-b`. */
export const DIAGNOSIS_STEP = /^reviewer-diagnosis(-[a-z]+)*$/;
/**
 * The part of a reviewer's round record that holds the lead's task: everything before its `## Report (verbatim)`
 * heading (call.mjs writes the header and the task verbatim above it), so nothing the reviewer wrote can name a key.
 */
export const taskOfRecord = text => text.split(/^## Report \(verbatim\)[ \t]*$/m, 1)[0];

/** The alarm keys a task names on its `alarms: <key>[, ...]` lines (backquotes around a key are allowed). */
export function alarmKeys(task) {
  return [...task.matchAll(/^alarms:[ \t]*(.*)$/gm)]
    .flatMap(m => m[1].split(",").map(key => key.trim().replace(/^`(.*)`$/, "$1").trim()).filter(Boolean));
}

const lines = text => text.split("\n").filter(Boolean); // the rows parseRows and parseHandoffs read, in order
const signature = list => JSON.stringify(list);

/** design/alarm-gate.md#the-rule (item 3) */
export function firings(rows, options) {
  const now = alarms(rows, options);
  if (!now.length) return [];
  const last = new Map(); // key -> { sig, row }
  for (let k = 0; k < rows.length; k++) {
    const byKey = new Map();
    for (const a of alarms(rows.slice(0, k + 1), options)) byKey.set(a.key, [...(byKey.get(a.key) ?? []), a]);
    for (const key of [...last.keys()]) if (!byKey.has(key)) last.delete(key);
    for (const [key, list] of byKey) {
      const sig = signature(list);
      if (last.get(key)?.sig !== sig) last.set(key, { sig, row: k });
    }
  }
  return now.map(a => ({ ...a, row: last.get(a.key).row }));
}

/** The commit that added each non-empty line of `path` at `commit` (`git blame`), in line order. */
function addedBy(repo, commit, path) {
  const out = git(repo, "blame", "--porcelain", commit, "--", path);
  const result = [];
  let sha = null;
  for (const line of out.split("\n")) {
    const header = /^([0-9a-f]{40}) \d+ \d+/.exec(line);
    if (header) { sha = header[1]; continue; }
    if (line.startsWith("\t") && line.length > 1) result.push(sha);
  }
  return result;
}

/** design/alarm-gate.md#the-rule (item 6) */
function rowsWhenRecorded(repo, commit, diagnoses) {
  const added = addedBy(repo, commit, HANDOFFS);
  const commits = [...new Set(diagnoses.map(d => added[d.i]))];
  const rowsAt = new Map(texts(repo, commits.map(c => `${c}:${TRAJECTORY}`)).map((t, k) => [commits[k], t === null ? [] : lines(t)]));
  return new Map(diagnoses.map(d => [d.i, rowsAt.get(added[d.i])]));
}

/** The text of `<rev>:<path>` for each spec, null where it does not exist: one `git cat-file --batch` for all of them. */
function texts(repo, specs) {
  if (!specs.length) return [];
  const out = run("git", ["-C", repo, "cat-file", "--batch"], { input: `${specs.join("\n")}\n` });
  const result = [];
  let at = 0;
  for (let i = 0; i < specs.length; i++) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString();
    if (header.endsWith(" missing") || header.endsWith(" ambiguous")) { result.push(null); at = nl + 1; continue; }
    const [, type, size] = header.split(" ");
    const start = nl + 1;
    result.push(type === "blob" ? out.subarray(start, start + Number(size)).toString("utf8") : null);
    at = start + Number(size) + 1;
  }
  return result;
}

/**
 * The phase's alarms at records commit `commit` that no diagnosis covers: [{ key, type, message, round, row, ... }].
 * Throws when the trajectory or the hand-offs at that commit cannot be read. A constant number of Git processes: the
 * ledgers, the diagnosis records, the blame of the hand-offs and the trajectories where diagnoses were recorded are each
 * read in one batch.
 */
export function undiagnosedAlarms(repo, commit, phase) {
  const [trajectory, handoffText] = texts(repo, [`${commit}:${TRAJECTORY}`, `${commit}:${HANDOFFS}`]);
  if (trajectory === null) return [];
  const rowLines = lines(trajectory);
  const rows = parseRows(rowLines.join("\n"), `${TRAJECTORY}@${commit.slice(0, 12)}`);
  const open = firings(rows).filter(a => rows[a.row].phase === phase);
  const result = () => open.filter(a => !covers(a)).map(a => ({ ...a, round: rows[a.row].round }));
  let covers = () => false;
  if (!open.length || handoffText === null) return result();

  const keys = new Set(open.map(a => a.key));
  const candidates = parseHandoffs(handoffText).map((h, i) => ({ h, i }))
    .filter(({ h }) => h.role === "reviewer" && DIAGNOSIS_STEP.test(h.step) && h.phase === phase);
  const records = texts(repo, candidates.map(({ h }) => `${commit}:${h.record}`));
  const naming = candidates.map((d, k) => ({ ...d, keys: new Set(records[k] === null ? [] : alarmKeys(taskOfRecord(records[k]))) }))
    .filter(d => [...d.keys].some(key => keys.has(key)));
  if (!naming.length) return result();
  let held;
  const after = (d, a) => {
    const order = byTime(d.h.time, rows[a.row].time);
    if (order) return order > 0;
    held ??= rowsWhenRecorded(repo, commit, naming);
    return held.get(d.i)[a.row] === rowLines[a.row];
  };
  covers = a => naming.some(d => d.keys.has(a.key) && after(d, a));
  return result();
}

const second = time => { const t = Date.parse(time); return Number.isFinite(t) ? Math.floor(t / 1000) : null; };
/** D-0017 item 3 */
function byTime(diagnosed, row) {
  const [d, r] = [second(diagnosed), second(row)];
  return d === null || r === null ? 0 : Math.sign(d - r);
}
