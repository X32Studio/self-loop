#!/usr/bin/env node
import "./lib/unbind-git.mjs";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { addEvent, FEATURE_EVENTS, FEATURE_ID, inspectBlueprint, renderBlueprint, STATUSES } from "./lib/blueprint.mjs";
import { ownerAlarms, phaseMoveAlarms } from "./lib/blueprint-alarms.mjs";
import { notGreen, readCi, recordsLoop } from "./lib/ci-receipt.mjs";
import { listFiles } from "./records-check.mjs";
import { readRows, TRAJECTORY } from "./trajectory.mjs";

const show = errors => {
  for (const { path, line, detail } of errors) console.error(`${path}${line ? `:${line}` : ""}: ${detail}`);
};

const recordsFiles = repo => [...new Set([...listFiles(repo), ...(existsSync(join(repo, ".git")) ? listFiles(repo, { untracked: true }) : [])])]
  .filter(p => lstatSync(join(repo, p), { throwIfNoEntry: false })?.isFile()).sort();
const readIn = repo => p => readFileSync(join(repo, p), "utf8");

function load(repo) {
  return inspectBlueprint(repo, { files: recordsFiles(repo), read: readIn(repo) });
}

/**
 * The commit and CI a `done` citing a judge round takes from that round's last judge row in the trajectory: CONVERGED,
 * with the receipt of the reading the append made (`ciReceipt`, for its pushed SHA: the tip when it names one). Nothing
 * is supplied by the caller and nothing is read here; the append made the reading when it wrote the row.
 */
function roundEvidence(repo, round) {
  let rows;
  try { rows = readRows(join(repo, TRAJECTORY)); } catch (e) { return { problem: e.message }; }
  const row = rows.findLast(r => r.role === "judge" && `R-${String(r.round).padStart(4, "0")}-judge` === round);
  if (row?.verdict !== "CONVERGED") return { problem: `done --round ${round} needs that round's CONVERGED row in ${TRAJECTORY}; ${row ? `its last judge row says ${row.verdict}` : "it has none"}` };
  if (!row.ciReceipt) return { problem: `${round}'s CONVERGED row names no ciReceipt (it predates the append's own CI reading), so it carries no CI receipt for a done` };
  return { evidence: { commit: row.commit, ...(row.tip ? { tip: row.tip } : {}), ci: row.ciReceipt } };
}

/**
 * A baseline `done` (`--acceptance`, no round) cites a receipt in these records and is confirmed by one reading of the
 * cited commit now, where a push to the gates.remote of these records' loop.json goes, over its gates.require.
 * Without a loop.json there is no destination, so no done.
 */
function baselineProblem(repo, evidence) {
  let loop;
  try { loop = recordsLoop(repo); } catch (e) { return e.message; }
  if (!loop) return `a done needs the loop's CI, and ${repo} holds no loop.json`;
  const reading = readCi(loop, evidence.commit);
  return reading.ci === "success" ? null : notGreen("a done", loop, evidence.commit, reading);
}

function set(repo, args) {
  need(args, "feature", "status", "by", "note");
  if (!FEATURE_ID.test(args.feature) || !STATUSES.includes(args.status) || !args.by.trim() || !args.note.trim())
    throw new UsageError("set needs F-NNNN, a status (planned, designing, building, done, retired), --by and --note");
  const evidence = {};
  for (const key of ["round", "acceptance", "commit", "ci", "decision"]) {
    if (!(key in args)) continue;
    need(args, key);
    evidence[key] = args[key];
  }
  if (evidence.round && evidence.acceptance) throw new UsageError("use --round or --acceptance");
  const derived = args.status === "done" && evidence.round;
  if (derived && ("commit" in evidence || "ci" in evidence))
    throw new UsageError(`done --round takes its commit and CI from ${evidence.round}'s CONVERGED trajectory row; drop --commit and --ci`);
  const lock = join(repo, ".blueprint-set.lock");
  try { mkdirSync(lock); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    console.error("another blueprint set holds .blueprint-set.lock");
    return 2;
  }
  try {
    const state = load(repo);
    if (state.failures.length) { show(state.failures); return 2; }
    if (derived) {
      const found = roundEvidence(repo, evidence.round);
      if (found.problem) { console.error(found.problem); return 2; }
      Object.assign(evidence, found.evidence);
    }
    const event = { feature: args.feature, phase: state.features.get(args.feature)?.phase, status: args.status, time: new Date().toISOString(), by: args.by.trim(), note: args.note, evidence };
    const priorFindings = state.screening.length;
    try { addEvent(state, event, { writing: true }); } catch (e) { console.error(e.message); return 2; }
    const ci = args.status === "done" && evidence.acceptance && baselineProblem(repo, evidence);
    if (ci) { console.error(ci); return 2; }
    const path = join(repo, FEATURE_EVENTS);
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && !info.isFile()) throw new Error(`${FEATURE_EVENTS} must be a regular file`);
    const existing = info ? readFileSync(path, "utf8") : "";
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${existing && !existing.endsWith("\n") ? "\n" : ""}${JSON.stringify(event)}\n`);
    show(state.screening.slice(priorFindings));
    console.log(JSON.stringify(event));
    return 0;
  } finally { rmdirSync(lock); }
}

cli(() => {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  const options = { set: ["feature", "status", "round", "acceptance", "commit", "ci", "decision", "by", "note"], status: ["phase"], view: [] };
  if (!Object.hasOwn(options, command) || args._.length !== 1
      || Object.keys(args).some(key => !["_", "records", ...options[command]].includes(key)))
    throw new UsageError("blueprint.mjs set|status|view --records <dir>");
  need(args, "records");
  if ("phase" in args) need(args, "phase");
  if (!lstatSync(resolve(args.records), { throwIfNoEntry: false })?.isDirectory()) throw new UsageError("--records must name a directory");
  const repo = realpathSync.native(resolve(args.records));
  if (command === "set") return set(repo, args);
  const state = load(repo);
  show(state.failures);
  if (command === "view") {
    process.stdout.write(renderBlueprint(state, ownerAlarms(state).map(alarm => alarm.detail)));
  } else {
    show(phaseMoveAlarms(state));
    const features = [...state.features.values()].filter(f => !args.phase || f.phase === args.phase);
    for (const f of features) console.log(`${f.id} ${state.latest.get(f.id)?.status ?? "未记录"}  ${f.phase}  ${f.title}`);
    if (!features.length) console.log("没有功能。");
    if (!features.length || features.some(f => !["done", "retired"].includes(state.latest.get(f.id)?.status))) return 2;
  }
  return state.failures.length ? 2 : 0;
});
