#!/usr/bin/env node
// F-0001, D-0015, D-0016, D-0064, D-0067
import "./lib/unbind-git.mjs";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { addEvent, FEATURE_EVENTS, FEATURE_ID, inspectBlueprint, parseRoundRef, renderBlueprint, STATUSES } from "./lib/blueprint.mjs";
import { ownerAlarms, phaseMoveAlarms } from "./lib/blueprint-alarms.mjs";
import { criticConvergedAccepted } from "./lib/ci.mjs";
import { notGreen, readCi, recordsLoop } from "./lib/ci-receipt.mjs";
import { gitOk } from "./lib/git-plumbing.mjs";
import { HANDOFFS, parseHandoffs } from "./lib/handoff.mjs";
import { evaluateCertifiedWaveCoverage } from "./lib/provenance.mjs";
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

// D-0015, D-0064, D-0067
function roundEvidence(repo, round) {
  let rows;
  try { rows = readRows(join(repo, TRAJECTORY)); } catch (e) { return { problem: e.message }; }
  const ref = parseRoundRef(round);
  if (!ref) return { problem: `done --round ${round} must name an existing judge or critic round` };
  if (ref.role === "judge") {
    const row = rows.findLast(r => r.role === "judge" && r.round === ref.round);
    if (row?.verdict !== "CONVERGED") return { problem: `done --round ${round} needs that round's CONVERGED row in ${TRAJECTORY}; ${row ? `its last judge row says ${row.verdict}` : "it has none"}` };
    if (!row.ciReceipt) return { problem: `${round}'s CONVERGED row names no ciReceipt (it predates the append's own CI reading), so it carries no CI receipt for a done` };
    return { evidence: { commit: row.commit, ...(row.tip ? { tip: row.tip } : {}), ci: row.ciReceipt } };
  }
  const handoffPath = join(repo, HANDOFFS);
  if (!existsSync(handoffPath)) return { problem: `done --round ${round} requires a committed critic hand-off in ${HANDOFFS}` };
  let handoffs;
  try { handoffs = parseHandoffs(readFileSync(handoffPath, "utf8")); } catch (e) { return { problem: e.message }; }
  const handoff = handoffs.findLast(h => h.id === round && h.role === "critic");
  if (!handoff) return { problem: `done --round ${round} has no critic hand-off in ${HANDOFFS}` };
  const has = p => existsSync(join(repo, p));
  const read = p => (has(p) ? readFileSync(join(repo, p), "utf8") : "");
  if (!criticConvergedAccepted(handoff, { has, read }))
    return { problem: `done --round ${round} requires a no-dispute critic PASS/CONVERGED hand-off with ACCEPTANCE: pass and audit.violations === 0` };
  const certSha = handoff.product?.commit || handoff.product?.base || null;
  const row = rows.findLast(r => r.role === "critic" && r.round === ref.round && (!certSha || r.commit === certSha || r.tip === certSha))
    ?? rows.findLast(r => r.role === "critic" && r.round === ref.round);
  if (!row || (row.verdict !== "PASS" && row.verdict !== "CONVERGED"))
    return { problem: `done --round ${round} needs that round's PASS/CONVERGED row in ${TRAJECTORY}; ${row ? `its last critic row says ${row.verdict}` : "it has none"}` };
  if (!row.ciReceipt) return { problem: `${round}'s ${row.verdict} row names no ciReceipt, so it carries no CI receipt for a done` };
  let rawLoop = null, loop = null;
  try { if (has("loop.json")) rawLoop = JSON.parse(read("loop.json")); } catch {}
  try { loop = recordsLoop(repo); } catch {}
  if (loop?.product) {
    if (handoff.product?.base && handoff.product?.commit && handoff.product.base !== handoff.product.commit
      && !gitOk(loop.product, "--no-replace-objects", "merge-base", "--is-ancestor", handoff.product.base, handoff.product.commit))
      return { problem: `done --round ${round} critic base is not an ancestor of its commit` };
    const files = new Set(recordsFiles(repo));
    const cov = evaluateCertifiedWaveCoverage({
      repo: loop.product, records: repo, files, read, cfg: rawLoop, phase: handoff.phase,
      targetCommit: row.commit, targetRuling: row, judge: handoff,
      allHandoffs: handoffs, allRows: rows, requireActor: false,
    });
    if (!cov.ok) return { problem: `done --round ${round} failed critic/actor independence (${cov.problem})` };
    if (cov.actors.some(a => !handoff.product?.base || !gitOk(loop.product, "--no-replace-objects", "merge-base", "--is-ancestor", a.product.commit, handoff.product.base)))
      return { problem: `done --round ${round} critic base does not cover all wave actor commits` };
  }
  return { evidence: { commit: row.commit, ...(row.tip ? { tip: row.tip } : {}), ci: row.ciReceipt } };
}

// D-0015
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
