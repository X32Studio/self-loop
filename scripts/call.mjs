#!/usr/bin/env node
// One isolated role call, and nothing else: build the role's view, run the agent once, audit what it accessed, record
// one hand-off. It never decides what happens next (convergence, closing, retries, owner batches are the lead's;
// SKILL.md). Every behaviour below is certain: decided from git objects, paths and structured events.
//
// - View. The role reads a folder built from one records commit by an allow-list of what is public by construction:
//   regular files (no symlinks) of the public kinds (PUBLIC_KINDS; never Sealed, Evidence, Engines, Backtests), and of
//   the Rounds kind only the records a hand-off at that commit names as public, or that the commit's records.json lists
//   in `publicImports` (older records the lead declared public); for the judge alone, also its own earlier private
//   records (`sealed/judge/`). Nothing ignored, staged, uncommitted, undeclared or
//   from another commit; never a redaction of a larger copy. The view's INDEX.md lists exactly what it holds. Briefs
//   and the lead's task are files of the same commit / given verbatim. The frame reviewer also gets the product's
//   purpose documents at the base commit.
// - Agent. Claude always runs `--restricted` (no project or session memory) with --strict-mcp-config; the frame reviewer
//   gets file tools only and its folder as working directory (confined reads). Codex is refused for the frame reviewer:
//   its sandbox confines writes, not reads; critic, actor and judge may run on it, their reads screened by the audit.
//   The `cmd` runner is a test stand-in, refused unless SELF_LOOP_TEST=1.
//   Critic, actor and judge work in a detached worktree of the product at the base commit (setup commands run first; a
//   failing setup stops the call before any model runs). Only the judge is given the sealed roots.
// - Audit. Afterwards, from the structured tool events, with canonical paths (audit-access.mjs). A certain violation
//   fails the call (exit 6); flags and denied calls are recorded for the lead.
// - Hand-off. On success one records commit holds exactly: the public round record, the evidence (log, audit, every
//   other file the role wrote under out/), the actor's current design files, for the judge its full record in sealed/judge/, one line of
//   metrics/handoffs.jsonl and the INDEX.md generated from that exact tree. Nothing else staged rides along. Critic and
//   actor changes to the paths they own become a product commit on top of the base; only after the records commit
//   holds its hand-off does the base branch move to it, by compare-and-swap. Other changes are reported, not taken.
//   A failed call commits only its numbered evidence and gets no line.
// - Refusals before any model runs: the round record already exists; an uncommitted change to the hand-off record;
//   missing phase frame before an adversarial call; missing or unknown task features; a brief missing at the view
//   commit; a protected base branch; an unknown runner or role; for a critic, actor or judge (dry runs and preparations
//   included), an alarm of the phase in the view's trajectory that no reviewer-diagnosis hand-off recorded after it
//   names (lib/diagnosis.mjs). The reviewer and `record` are never refused by an alarm.
//
// - T3 child threads (runner `t3`, never the frame reviewer): `--prepare` does everything up to the agent run and writes
//   the child's prompt with a nonce; the lead starts the child; `record --ws` then audits the child's own transcript
//   (bound to the supplied provider session ID, with the prepared prompt in its first submission) and records the hand-off.
//
// node call.mjs <config.json> <role> --round N --task <file> [--step <role[-mode]>] [--view <records rev>]
//   [--base <product rev or branch>] [--dry-run | --prepare]
// node call.mjs <config.json> record --ws <prepared workspace> [--session <provider session ID>] [--transcript <file>]
// role: reviewer | critic | actor | judge. Exit 0 hand-off recorded, 1 the call failed (setup, agent exit, no report),
// 6 certain access violation, 7 refused by the records rules, 64 usage. Prints the hand-off line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import "./lib/unbind-git.mjs";
import { auditAccess, canonical, eventsOf, FILE_TOOLS } from "./audit-access.mjs";
import { addedProse, commentResolutions } from "./lib/comments.mjs";
import { blobs, git, gitOk, regularFiles, writeFiles } from "./lib/git-plumbing.mjs";
import { appendJsonLines, commitRecords, RecordsConflict } from "./lib/records-commit.mjs";
import { findTranscripts, preparedPhase, t3Prompt, transcriptEvents } from "./lib/t3-child.mjs";
import { taskFeatures } from "./lib/blueprint.mjs";
import { parseArgs } from "./lib/args.mjs";
import { node as nodeCommand } from "./lib/commands.mjs";
import { undiagnosedAlarms } from "./lib/diagnosis.mjs";
import { HANDOFFS, hasPhaseFrame, idOf, parseHandoffs, recordOf, ROLES, validateHandoff } from "./lib/handoff.mjs";
import { classify, DEFAULT_LAYOUT, inspect, isPublicKind, parseLayout, renderIndex } from "./records-check.mjs";
import { parseRows, TRAJECTORY } from "./trajectory.mjs";

export const EXIT = { done: 0, failure: 1, violation: 6, records: 7, usage: 64 };
export const HEAVY_ROLES = ["critic", "actor", "judge"];
export const LOAD_ENV = "SELF_LOOP_LOAD_DIR";
export const loadDir = (env = process.env, home = homedir()) => env[LOAD_ENV] ? resolve(env[LOAD_ENV]) : join(home, ".self-loop", "load");
export { PUBLIC_KINDS } from "./records-check.mjs";
// Kinds whose text the index or the check reads; the others are listed by path only.
const QUOTED = new Set(["Backtests", "Evidence", "Blueprint evidence", "Sealed"]);
const digest = text => createHash("sha256").update(text).digest("hex");
const pad = n => String(n).padStart(4, "0");

export class Stop extends Error { constructor(code, message) { super(message); this.code = code; } }

// ---------- config ----------

export function load(configPath) {
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  return { ...normalize(cfg, dirname(resolve(configPath))), configFile: resolve(configPath) };
}

export function normalize(cfg, base = process.cwd()) {
  for (const key of ["product", "records", "workDir", "phase", "briefs", "agents"]) if (!cfg[key]) throw new Stop(EXIT.usage, `config needs "${key}"`);
  const out = { ...cfg, product: resolve(base, cfg.product), records: resolve(base, cfg.records), workDir: resolve(base, cfg.workDir) };
  out.sealed = (cfg.sealed ?? []).map(p => resolve(base, p));
  out.owns = cfg.owns ?? {};
  out.protected = cfg.protected ?? [];
  out.purpose = cfg.purpose ?? [];
  out.setup = cfg.setup ?? [];
  const inside = (a, b) => a === b || a.startsWith(`${b}/`);
  if (inside(canonical(out.workDir), canonical(out.records)) || inside(canonical(out.records), canonical(out.workDir)))
    throw new Stop(EXIT.usage, "workDir and records must not contain one another");
  return out;
}

// ---------- the view ----------

/** Paths of the records commit a role may read (see the header). */
export function publicPaths(cfg, commit, layout, role = null, files = regularFiles(cfg.records, commit)) {
  const has = new Set(files.map(f => f.path));
  const text = path => (has.has(path) ? git(cfg.records, "show", `${commit}:${path}`) : "");
  const publicRounds = new Set();
  if (has.has(HANDOFFS)) for (const h of parseHandoffs(text(HANDOFFS))) publicRounds.add(h.record);
  if (has.has("records.json")) {
    const imports = JSON.parse(text("records.json")).publicImports ?? [];
    for (const p of imports) if (classify(layout, p)?.kind !== "Sealed") publicRounds.add(p);
  }
  return files.filter(f => {
    if (publicRounds.has(f.path)) return true;
    if (role === "judge" && f.path.startsWith("sealed/judge/")) return true;
    const c = classify(layout, f.path);
    return c && isPublicKind(c.kind);
  });
}

/** Build a role's view of the records at `commit` into `into`; returns the paths it holds. */
export function buildView(cfg, commit, into, layout, extraKinds = [], role = null, files) {
  const entries = publicPaths(cfg, commit, layout, role, files);
  mkdirSync(into, { recursive: true });
  writeFiles(into, entries, blobs(cfg.records, entries.map(e => e.sha)));
  const state = inspect(into, { files: entries.map(e => e.path), config: { extraKinds }, blueprint: false });
  writeFileSync(join(into, "INDEX.md"), renderIndex(state));
  return entries.map(e => e.path);
}

function recordsConfig(cfg, commit) {
  return gitOk(cfg.records, "cat-file", "-e", `${commit}:records.json`) ? JSON.parse(git(cfg.records, "show", `${commit}:records.json`)) : {};
}

// ---------- the agent ----------

/** Command and arguments of one agent run. */
export function argv(agent, { confined, cwd, addDirs }) {
  if (agent.runner === "claude") return ["claude", ["-p", "--restricted", "--strict-mcp-config",
    ...(confined ? ["--tools", FILE_TOOLS.join(",")] : ["--tools", [...FILE_TOOLS, "Bash"].join(","), "--allowedTools", "Bash"]),
    "--permission-mode", "acceptEdits", ...addDirs.flatMap(d => ["--add-dir", d]),
    ...(agent.model ? ["--model", agent.model] : []), ...(agent.effort ? ["--effort", agent.effort] : []),
    "--output-format", "stream-json", "--verbose"]];
  // Codex sandbox: workspace-write by default. A role that must run the product's real tests (listening sockets,
  // boot identity, signed native apps) may set `sandbox: "danger-full-access"` in its agent config; its reads were
  // never confined (screening only), and the frame reviewer never runs on Codex. Measured 2026-11-20: R-0035-judge in
  // workspace-write could not listen or read the boot identity and got 54/203 instead of the host's 518/559.
  if (agent.runner === "codex" && agent.sandbox && !["workspace-write", "danger-full-access"].includes(agent.sandbox))
    throw new Stop(EXIT.usage, `unknown codex sandbox ${agent.sandbox} (workspace-write or danger-full-access)`);
  if (agent.runner === "codex") return ["codex", ["exec", "--json", "--skip-git-repo-check", "-C", cwd,
    "-c", `sandbox_mode="${agent.sandbox ?? "workspace-write"}"`, ...addDirs.flatMap(d => ["--add-dir", d]),
    ...(agent.model ? ["-m", agent.model] : []), ...(agent.effort ? ["-c", `model_reasoning_effort="${agent.effort}"`] : []), "-"]];
  if (agent.runner === "t3") { // a T3 child thread the lead starts from --prepare's prompt; recorded by `record`
    if (!["codex", "claude"].includes(agent.provider)) throw new Stop(EXIT.usage, "a t3 agent needs provider codex or claude");
    return null;
  }
  if (agent.runner === "cmd") { // a stand-in for tests: it confines nothing itself
    if (process.env.SELF_LOOP_TEST !== "1") throw new Stop(EXIT.usage, "the cmd runner is a test stand-in and is refused unless SELF_LOOP_TEST=1; use claude or codex");
    return [agent.cmd[0], agent.cmd.slice(1)];
  }
  throw new Stop(EXIT.usage, `unknown runner ${agent.runner} (claude, codex, t3 or cmd)`);
}

function prompt({ role, round, phase, ws, view, base, owns, sealed, wt = null }) {
  return [
    `You are the ${role} of a self-loop, round ${round}, phase ${phase}. Your working folder is ${ws}.`,
    "Read brief-shared.md, brief.md and task.md there first and follow them. records/ is a read-only view of the loop's records at commit " +
      `${view}; read records/INDEX.md before anything else in it. Write only under out/.`,
    role === "reviewer" ? "Only the files in your working folder exist for this task; purpose/ holds the product's purpose documents."
      : `The product worktree is ${wt ?? "your current directory"}, detached at ${base}. Write only: ${owns.join(", ") || "(nothing in the product)"}. Do not commit; your owned paths are committed for you.`,
    "Write your report to out/report.md. Questions only the owner can decide go to out/decisions.json (see your brief).",
    role === "judge" ? "out/report.md is your full ruling and stays private to you and the lead. out/public.md is the only part the other roles read: properties broken, blockers by class and id, to-do lists; never held-out content, names or paths." : "",
    role === "judge" && sealed.length ? `Held-out cases (yours alone): ${sealed.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
}

// ---------- product ----------

function changedPaths(wt) {
  const out = spawnSync("git", ["-C", wt, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout;
  const entries = out.split("\0").filter(Boolean);
  const changed = [];
  for (let i = 0; i < entries.length; i++) {
    changed.push(entries[i].slice(3));
    if (/[RC]/.test(entries[i].slice(0, 2))) changed.push(entries[++i]);
  }
  return [...new Set(changed)];
}

function commitOwned(wt, base, { inside, outside }, message) {
  if (!inside.length) return { commit: base, outside };
  git(wt, "add", "-A", "--", ...inside);
  git(wt, "commit", "-q", "--no-verify", "-m", message, "--", ...inside);
  return { commit: git(wt, "rev-parse", "HEAD"), outside };
}

// ---------- records commits ----------

/** Check and index the exact candidate tree for this attempt. */
function indexHandOff(records, own, { tree, add, read }, { layoutText, extraKinds, sealed }) {
  const layout = parseLayout(layoutText, extraKinds);
  const all = regularFiles(records, tree()).filter(e => e.path !== "INDEX.md");
  const { publicImports = [] } = JSON.parse(read("records.json") || "{}");
  const textual = all.filter(e => !QUOTED.has(classify(layout, e.path)?.kind) || publicImports.includes(e.path));
  const contents = new Map(blobs(records, textual.map(e => e.sha)).map((bytes, i) => [textual[i].path, bytes.toString("utf8")]));
  const state = inspect(records, { layoutText, files: all.map(e => e.path), own, screenOnly: own, blueprint: false,
    config: { extraKinds, sealed, publicImports }, read: p => contents.get(p) ?? "" });
  const failures = state.failures.filter(f => own.includes(f.path) || f.path === HANDOFFS);
  if (failures.length) throw new Stop(EXIT.records, `records check refused the hand-off: ${failures.slice(0, 5).map(f => `${f.rule} ${f.path} ${f.detail}`).join("; ")}`);
  add("INDEX.md", renderIndex(state));
  return state.screening.filter(s => own.includes(s.path));
}

/** Every file under `dir`, relative. */
function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(n => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), `${prefix}${n}/`) : [`${prefix}${n}`]));
}

/** Validate the reserved output directory before reading any of its files as evidence. */
function designOutputs(ws, role, layout) {
  const dir = join(ws, "out", "design");
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return [];
  if (!stat.isDirectory()) throw new Stop(EXIT.records, "out/design must be a directory of actor design files");
  return readdirSync(dir, { withFileTypes: true }).map(entry => {
    const path = `design/${entry.name}`;
    if (role !== "actor" || !entry.isFile() || classify(layout, path)?.kind !== "Design")
      throw new Stop(EXIT.records, `out/${path} is not an actor's out/design/<area>.md regular file`);
    return path;
  });
}

// ---------- the call ----------

/**
 * One role call. Returns { code, message, handoff?, ws? }; never throws for the agent's behaviour.
 * @param opts { round, step?, task (text), view? (records rev), base? (product rev or branch), dry? }
 */
export function call(cfg, role, opts, { log = () => {}, now = () => new Date() } = {}) {
  try { return callInner(cfg, role, opts, { log, now }); }
  catch (e) {
    if (e instanceof Stop) return { code: e.code, message: e.message };
    return { code: EXIT.failure, message: String(e.stack ?? e) };
  }
}

function callInner(cfg, role, { round, step = role, task, view: viewRev = "HEAD", base: baseRev, dry = false, prepare = false }, { log, now }) {
  // ----- refusals before any model runs -----
  if (!ROLES.includes(role)) throw new Stop(EXIT.usage, `role must be one of ${ROLES.join(", ")}`);
  if (!Number.isInteger(round) || round < 1) throw new Stop(EXIT.usage, "--round must be a whole number from 1");
  if (step !== role && !new RegExp(`^${role}(-[a-z]+)+$`).test(step)) throw new Stop(EXIT.usage, `--step must be ${role} or ${role}-<word>`);
  if (typeof task !== "string" || !task.trim()) throw new Stop(EXIT.usage, "--task must name a non-empty file: the lead's instructions for this call");
  const agent = cfg.agents[role];
  if (!agent) throw new Stop(EXIT.usage, `config needs agents.${role}`);
  if (role === "reviewer" && agent.runner === "codex") throw new Stop(EXIT.usage, "the frame reviewer cannot run on codex: its sandbox does not confine reads (DEBT.md)");
  if (role === "reviewer" && agent.runner === "t3") throw new Stop(EXIT.usage, "the frame reviewer stays on the claude CLI: a T3 child cannot be confined to its folder");
  if ((agent.runner === "t3") !== Boolean(prepare) && !dry) throw new Stop(EXIT.usage, agent.runner === "t3"
    ? `agents.${role} runs as a T3 child thread: prepare it with --prepare, start the child with the printed prompt, then \`record --ws\``
    : "--prepare is only for a role whose runner is t3");
  argv(agent, { confined: true, cwd: ".", addDirs: [] }); // unknown runner
  const id = idOf(round, step);
  const record = recordOf(round, step);
  if (gitOk(cfg.records, "cat-file", "-e", `HEAD:${record}`) || existsSync(join(cfg.records, record)))
    throw new Stop(EXIT.records, `${record} already exists: round ${round} has a ${step} record; choose another round or step (no model was called)`);
  if (gitOk(cfg.records, "cat-file", "-e", `HEAD:${HANDOFFS}`) && !gitOk(cfg.records, "diff", "--quiet", "HEAD", "--", HANDOFFS))
    throw new Stop(EXIT.records, `${HANDOFFS} has uncommitted changes; commit or discard them first`);
  if (role !== "reviewer") {
    const head = git(cfg.records, "rev-parse", "HEAD");
    const paths = new Set(regularFiles(cfg.records, head).map(f => f.path));
    const handoffs = paths.has(HANDOFFS) ? parseHandoffs(git(cfg.records, "show", `${head}:${HANDOFFS}`)) : [];
    if (!hasPhaseFrame(handoffs, cfg.phase, path => paths.has(path)))
      throw new Stop(EXIT.records, `phase ${cfg.phase} has no committed reviewer-frame hand-off in ${HANDOFFS}; run the frame reviewer first`);
  }
  let view;
  try { view = git(cfg.records, "rev-parse", "--verify", "--quiet", `${viewRev}^{commit}`); } catch { throw new Stop(EXIT.usage, `--view ${viewRev} is not a records commit`); }
  let features;
  try { features = taskFeatures(task, role); } catch (e) { throw new Stop(EXIT.records, e.message); }
  const viewFiles = regularFiles(cfg.records, view);
  const viewPaths = new Set(viewFiles.map(f => f.path));
  const missing = features.find(id => !viewPaths.has(`blueprint/${id}.md`));
  if (missing) throw new Stop(EXIT.records, `features: ${missing} is not a regular blueprint record at view ${view.slice(0, 7)}`);
  const briefs = [cfg.briefs.shared, cfg.briefs[role]].filter(Boolean);
  if (!cfg.briefs[role]) throw new Stop(EXIT.usage, `config needs briefs.${role}`);
  for (const b of briefs) if (!gitOk(cfg.records, "cat-file", "-e", `${view}:${b}`)) throw new Stop(EXIT.usage, `brief ${b} is not committed in the records at ${view.slice(0, 7)}`);
  const baseName = baseRev ?? cfg.branch ?? "HEAD";
  let base;
  try { base = git(cfg.product, "rev-parse", "--verify", "--quiet", `${baseName}^{commit}`); } catch { throw new Stop(EXIT.usage, `--base ${baseName} is not a product commit`); }
  const branch = gitOk(cfg.product, "show-ref", "--verify", "--quiet", `refs/heads/${baseName}`) ? baseName : null;
  const commits = ["critic", "actor"].includes(role);
  if (commits && branch && cfg.protected.includes(branch)) throw new Stop(EXIT.usage, `${branch} is protected; a role works on a loop branch, the lead promotes with gated-push.mjs`);
  if (role !== "reviewer") refuseUndiagnosed(cfg, view, round);
  const extra = recordsConfig(cfg, view);
  const extraKinds = extra.extraKinds ?? [];
  const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
  const layout = parseLayout(layoutText, extraKinds);

  // ----- the workspace -----
  mkdirSync(cfg.workDir, { recursive: true });
  const ws = mkdtempSync(join(cfg.workDir, `${pad(round)}-${step}-`));
  mkdirSync(join(ws, "out"));
  const holds = buildView(cfg, view, join(ws, "records"), layout, extraKinds, role, viewFiles);
  writeFileSync(join(ws, "brief-shared.md"), cfg.briefs.shared ? git(cfg.records, "show", `${view}:${cfg.briefs.shared}`) : "");
  writeFileSync(join(ws, "brief.md"), git(cfg.records, "show", `${view}:${cfg.briefs[role]}`));
  writeFileSync(join(ws, "task.md"), task);
  let wt = null, keep = false;
  const cleanup = () => { if (!keep) removeWorktree(cfg, wt); };
  try {
    if (role === "reviewer") {
      const purpose = regularFiles(cfg.product, base).filter(f => cfg.purpose.some(p => f.path === p || f.path.startsWith(`${p.replace(/\/$/, "")}/`)));
      writeFiles(join(ws, "purpose"), purpose, blobs(cfg.product, purpose.map(f => f.sha)));
    } else {
      wt = join(ws, "wt");
      git(cfg.product, "worktree", "add", "-q", "--detach", wt, base);
      for (const cmd of cfg.setup) {
        const r = spawnSync(cmd[0], cmd.slice(1), { cwd: wt, encoding: "utf8", maxBuffer: 1 << 28 });
        if (r.status !== 0) throw new Stop(EXIT.failure, `setup \`${cmd.join(" ")}\` exited ${r.status} in the ${role}'s worktree; no model was called\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000)}`);
      }
    }
    const owns = cfg.owns[role] ?? [];
    const text = prompt({ role, round, phase: cfg.phase, ws, view, base, owns, sealed: cfg.sealed, wt: agent.runner === "t3" ? wt : null });
    writeFileSync(join(ws, "prompt.md"), text);
    if (dry) return { code: EXIT.done, message: `dry run: ${ws} (view ${view.slice(0, 7)}, ${holds.length} records); nothing called or recorded`, ws };

    const ctx = { role, round, step, phase: cfg.phase, task, features, id, record, view, briefs, base, branch, commits, extraKinds, ws, wt, owns, agent };
    if (prepare) {
      const nonce = createHash("sha256").update(`${ws}\n${now().toISOString()}\n${Math.random()}`).digest("hex").slice(0, 16);
      const childPrompt = t3Prompt({ id, nonce, wt, ws, text });
      const manifest = `${JSON.stringify({ version: 2, ...ctx, nonce, preparedAt: now().getTime() }, null, 1)}\n`;
      const snapshot = preparationFile(cfg, ws);
      mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
      writeFileSync(snapshot, JSON.stringify({ manifest: digest(manifest), prompt: digest(childPrompt), task: digest(task), scope: preparationScope(cfg) }),
        { mode: 0o600, flag: "wx" });
      writeFileSync(join(ws, "t3-prompt.md"), childPrompt);
      writeFileSync(join(ws, "call.json"), manifest);
      keep = true;
      return { code: EXIT.done, message: `${id} prepared for a T3 child in ${ws}; start it with t3-prompt.md, then: call.mjs <config> record --ws ${ws} --session <provider session ID>`,
        prepared: { id, ws, wt, nonce, prompt: childPrompt, target: { provider: agent.provider, model: agent.model ?? null, effort: agent.effort ?? null } } };
    }
    const confined = role === "reviewer";
    const cwd = confined ? ws : wt;
    const addDirs = confined ? [] : [ws, ...(role === "judge" ? cfg.sealed : [])];
    const [command, args] = argv(agent, { confined, cwd, addDirs });
    log(`${id}: ${role} (${agent.runner}${agent.model ? ` ${agent.model}` : ""})`);
    const started = Date.now();
    const release = HEAVY_ROLES.includes(role) ? holdLease({ role, id, records: cfg.records }, log) : () => {};
    let r;
    try {
      r = spawnSync(command, args, { cwd, input: text, encoding: "utf8", maxBuffer: 1 << 30, timeout: (cfg.timeoutMin ?? 120) * 60_000,
        env: { ...process.env, SELF_LOOP_WORKSPACE: ws } });
    } finally { release(); }
    const events = eventsOf(role, r.stdout ?? "");
    const run = { status: r.status, error: r.error ?? null, log: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, events, cwd,
      facts: { runner: agent.runner, model: agent.model ?? null, effort: agent.effort ?? null,
        observedModel: events.find(e => e.event.type === "system" && e.event.subtype === "init")?.event.model ?? null,
        costUsd: events.find(e => e.event.type === "result")?.event.total_cost_usd ?? null, seconds: Math.round((Date.now() - started) / 100) / 10 } };
    keep = true; // finish releases the worktree only after recording the attempt.
    return finish(cfg, ctx, run, { log, now });
  } finally { cleanup(); }
}


/**
 * Refuse (exit 7) while the phase has an alarm at the view that no later diagnosis names (lib/diagnosis.mjs): the
 * premise behind further fixes is tested before them (SKILL.md Supervision item 2; D-0015 item 3).
 */
function refuseUndiagnosed(cfg, view, round) {
  let open;
  try { open = undiagnosedAlarms(cfg.records, view, cfg.phase); }
  catch (e) { throw new Stop(EXIT.records, `the trajectory or hand-offs at view ${view.slice(0, 7)} cannot be read for the alarm check: ${e.message}`); }
  if (!open.length) return;
  const keys = open.map(a => a.key);
  const letters = "bcdefghijklmnopqrstuvwxyz";
  let step = "reviewer-diagnosis";
  for (let i = 0; gitOk(cfg.records, "cat-file", "-e", `HEAD:${recordOf(round, step)}`) && i < letters.length; i++) step = `reviewer-diagnosis-${letters[i]}`;
  throw new Stop(EXIT.records, [
    `phase ${cfg.phase} has ${open.length} alarm(s) that no reviewer-diagnosis hand-off recorded after them names (records ${view.slice(0, 7)}; no model was called):`,
    ...open.map(a => `  ${a.key}  (row of round ${a.round}: ${a.message})`),
    "Diagnose first: write a diagnosis task with the line",
    `  alarms: ${keys.join(", ")}`,
    `then run ${nodeCommand("call.mjs", cfg.configFile ?? "<config.json>", "reviewer", "--round", round, "--step", step, "--task", "<diagnosis task file>")}`,
  ].join("\n"));
}

const preparationFile = (cfg, ws) => join(cfg.workDir, ".prepared", `${basename(ws)}.json`);
const preparationScope = cfg => [canonical(cfg.records), canonical(cfg.product), cfg.phase, ...cfg.sealed.map(canonical)];
const commonDir = repo => canonical(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"));

function readPreparation(cfg, ws) {
  const manifest = join(ws, "call.json");
  if (!existsSync(manifest)) throw new Stop(EXIT.usage, `${ws} holds no call.json: it was not prepared with --prepare`);
  const bytes = readFileSync(manifest, "utf8"), ctx = JSON.parse(bytes);
  const expected = readFileSync(join(ws, "t3-prompt.md"), "utf8");
  const task = readFileSync(join(ws, "task.md"), "utf8");
  const snapshot = preparationFile(cfg, ws);
  if (existsSync(snapshot)) {
    const saved = JSON.parse(readFileSync(snapshot, "utf8"));
    if (saved.manifest !== digest(bytes) || saved.task !== digest(task) || saved.prompt !== digest(expected)
      || JSON.stringify(saved.scope) !== JSON.stringify(preparationScope(cfg)))
      throw new Stop(EXIT.records, "the repositories, phase, or prepared files differ from the lead's preparation snapshot");
  } else if (ctx.version !== 1 || preparedPhase(ctx, ws) !== cfg.phase || task !== ctx.task
    || !gitOk(cfg.records, "cat-file", "-e", `${ctx.view}^{commit}`)) {
    throw new Stop(EXIT.records, "the call has no matching preparation snapshot");
  }
  if (ctx.ws !== ws || ctx.wt !== join(ws, "wt")) throw new Stop(EXIT.records, "the prepared workspace or worktree does not match call.json");
  if (ctx.wt && !existsSync(ctx.wt)) throw new Stop(EXIT.failure, `the worktree ${ctx.wt} is gone; prepare the call again`);
  if (commonDir(ctx.wt) !== commonDir(cfg.product)) throw new Stop(EXIT.records, "the prepared worktree belongs to a different product repository");
  ctx.phase = preparedPhase(ctx, ws);
  return { ctx, expected, binding: snapshot + ".session" };
}

export function preparedIn(cfg) {
  if (!existsSync(cfg.workDir)) return [];
  const found = [];
  for (const entry of readdirSync(cfg.workDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const ws = join(cfg.workDir, entry.name);
    const file = join(ws, "call.json");
    if (!existsSync(file)) continue;
    const ctx = JSON.parse(readFileSync(file, "utf8"));
    if (![1, 2].includes(ctx.version) || ctx.ws !== ws || !ctx.nonce || !ROLES.includes(ctx.role) || !Number.isInteger(ctx.round)
        || !/^[a-z]+(-[a-z]+)*$/.test(ctx.step) || ctx.record !== recordOf(ctx.round, ctx.step))
      throw new Error(`${file} is not a supported prepared call`);
    found.push({ ...ctx, phase: preparedPhase(ctx, ws), ws, liveWorkspace: ctx.wt === join(ws, "wt") && existsSync(ctx.wt) });
  }
  return found.sort((a, b) => a.round - b.round || a.step.localeCompare(b.step) || a.ws.localeCompare(b.ws));
}

function holdLease(fields, log) {
  try {
    const dir = loadDir();
    mkdirSync(dir, { recursive: true });
    for (let n = 0; ; n++) {
      const file = join(dir, `call-${process.pid}-${n}.json`);
      try {
        writeFileSync(file, `${JSON.stringify({ kind: "call", pid: process.pid, ...fields })}\n`, { flag: "wx" });
        return () => rmSync(file, { force: true });
      } catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } catch (error) {
    log(`screening host-load the call runs without a lease in ${loadDir()}: ${error.message}`);
    return () => {};
  }
}

function lastJudged(cfg, revision) {
  if (!gitOk(cfg.records, "cat-file", "-e", `${revision}:${TRAJECTORY}`)) return null;
  try {
    return parseRows(git(cfg.records, "show", `${revision}:${TRAJECTORY}`))
      .findLast(row => row.phase === cfg.phase && row.role === "judge" && row.commit !== "-") ?? null;
  } catch { return null; }
}

function ownedChanges(wt, base, owns) {
  if (git(wt, "rev-parse", "HEAD") !== base) git(wt, "reset", "-q", "--soft", base);
  git(wt, "reset", "-q");
  const changed = changedPaths(wt);
  const owned = p => owns.some(o => p === o || p.startsWith(`${o.replace(/\/$/, "")}/`));
  return { inside: changed.filter(owned), outside: changed.filter(p => !owned(p)) };
}

function proseChanges(wt, base, paths, records) {
  if (!paths.length) return [];
  const wanted = new Set(paths);
  const listed = regularFiles(wt, base).filter(entry => wanted.has(entry.path));
  const before = new Map(blobs(wt, listed.map(entry => entry.sha)).map((bytes, k) => [listed[k].path, bytes.toString("utf8")]));
  return addedProse(paths.map(path => {
    const stat = lstatSync(join(wt, path), { throwIfNoEntry: false });
    return { path, before: before.get(path) ?? null, after: stat?.isFile() ? readFileSync(join(wt, path), "utf8") : null };
  }), { resolutions: commentResolutions(records) });
}

function moveBranch(cfg, name, from, to) {
  return gitOk(cfg.product, "update-ref", `refs/heads/${name}`, to, from);
}

/** Record a prepared T3 call using the provider session ID of the child that the lead started. */
export function recordCall(cfg, wsDir, { transcript = null, session = null, log = () => {}, now = () => new Date() } = {}) {
  try {
    const ws = resolve(wsDir);
    const manifest = join(ws, "call.json");
    if (existsSync(manifest)) {
      const { record } = JSON.parse(readFileSync(manifest, "utf8"));
      if (gitOk(cfg.records, "cat-file", "-e", `HEAD:${record}`)) throw new Stop(EXIT.records, `${record} already exists: this call was recorded`);
    }
    const { ctx, expected, binding } = readPreparation(cfg, ws);
    const runner = ctx.agent.provider;
    const bound = existsSync(binding) ? readFileSync(binding, "utf8") : null;
    if (bound && session && bound !== session) throw new Stop(EXIT.records, "the call is already bound to a different provider session");
    session ??= bound;
    const found = transcript ? [{ runner, file: resolve(transcript) }] : findTranscripts(runner, ctx.nonce, ctx.preparedAt, session);
    if (found.length !== 1) throw new Stop(EXIT.failure, found.length
      ? `${found.length} transcripts hold nonce ${ctx.nonce} (${found.map(f => `${f.file} [${f.session}]`).join(", ")}); pass --session and, if needed, --transcript`
      : `no transcript holds nonce ${ctx.nonce} for the prepared ${runner} child; check the provider session ID`);
    const t = transcriptEvents(ctx.id, found[0]);
    if (!t.firstPrompt.includes(expected)) throw new Stop(EXIT.records, `the child's first prompt does not hold t3-prompt.md verbatim: start the child with exactly that text (${found[0].file})`);
    if (!t.session || t.forked || session && session !== t.session)
      throw new Stop(EXIT.records, `the transcript is not from the prepared ${runner} child session (${found[0].file})`);
    if (!session) throw new Stop(EXIT.records, `confirm the started child's provider session ID with --session (matching transcript: ${t.session} in ${found[0].file})`);
    if (!bound) {
      mkdirSync(dirname(binding), { recursive: true, mode: 0o700 });
      try { writeFileSync(binding, session, { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST" || readFileSync(binding, "utf8") !== session) throw error; }
    }
    if (t.status === "pending") throw new Stop(EXIT.failure, "the child's transcript has no terminal event yet; its worktree is still available");
    const run = { status: t.status === "failed" ? 1 : 0, error: null, log: t.text, events: t.events, cwd: t.cwd ?? ctx.wt,
      facts: { runner: `t3:${runner}`, session, model: ctx.agent.model ?? null, effort: ctx.agent.effort ?? null,
        observedModel: t.observedModel, costUsd: null, seconds: t.seconds } };
    log(`${ctx.id}: recording the T3 child's transcript ${found[0].file}`);
    return finish(cfg, ctx, run, { log, now });
  } catch (e) {
    if (e instanceof Stop) return { code: e.code, message: e.message };
    return { code: EXIT.failure, message: String(e.stack ?? e) };
  }
}

/** The rest of a call once its agent has run: audit, evidence, hand-off. `run` = { status, error, log, events, cwd, facts }. */
function finish(cfg, ctx, run, { log, now }) {
  const { role, round, step, phase = cfg.phase, task, features, id, record, view, briefs, base, branch, commits, extraKinds, ws, wt, owns, agent } = ctx;
  const confined = role === "reviewer";
  const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
  const audit = auditAccess(confined ? [ws] : [ws, wt, ...(role === "judge" ? cfg.sealed : [])], run.events,
    confined ? { cwd: run.cwd } : { tools: null, cwd: run.cwd, forbidden: role === "judge" ? [cfg.records] : [cfg.records, ...cfg.sealed] });
  const summary = { violations: audit.violations.length, denied: audit.denied.length, flags: audit.flags.length, unrecognized: audit.unrecognized };
  const reportFile = join(ws, "out", "report.md");
  const report = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
  let failure = audit.violations.length ? [EXIT.violation, `${role} accessed what it may not see: ${audit.violations.slice(0, 3).map(v => `${v.tool} ${v.path}`).join("; ")}`]
    : run.error ? [EXIT.failure, `${role} could not run: ${run.error.message}`]
    : run.status !== 0 ? [EXIT.failure, `${role} exited ${run.status}`]
    : !report.trim() ? [EXIT.failure, `${role} wrote no out/report.md`] : null;
  const designs = new Set(designOutputs(ws, role, parseLayout(layoutText, extraKinds)));
  const outputs = walk(join(ws, "out")).filter(p => role === "judge" || p !== "report.md")
    .map(path => [path, readFileSync(join(ws, "out", path))]);
  const agentFacts = run.facts;
  const product = { base, commit: base };
  const retry = agent.runner === "t3";
  let prose = [];
  if (!failure && commits) {
    const owned = ownedChanges(wt, base, owns);
    prose = proseChanges(wt, base, owned.inside, cfg.records);
    if (prose.length) {
      failure = [EXIT.records, [`the ${role}'s product changes add or change ${prose.length} ${prose.some(p => p.status === "pending") ? "comment candidate(s) awaiting action" : "prose comment line(s)"}; a comment is a pointer (record ID or design anchor) or a tool directive (D-0016):`,
        ...prose.map(p => p.status === "pending"
          ? `  ${p.path}:${p.line}: pending independent resolution (${p.scope}); source sha256 ${p.source}; rule ${p.rule}; ${p.text}`
          : `  ${p.path}:${p.line}: ${p.text}`),
        ...(prose.some(p => p.status === "pending") ? ["No prose verdict for pending candidates. Have an independent judge emit out/comment-resolutions.json by copying each candidate identity (path, source, line, rule, contract, scope, language, text) and adding verdict and authoritative evidence. For comment scope: literal/directive/pointer/prose. For source scope: compliant only after reviewing the ENTIRE source for D-0016, or prose, then retry unchanged source."] : []),
        ...(prose.some(p => p.scope === "source") ? ["Source prose never supplies generic move credit. For a code-only edit or partial comment deletion, an independent judge may publish complete proseComments inventories for both frozen sources (RECORDS.md, Comment resolution). Later edits to an old resolution or audit do not count; record a fresh audited judge hand-off."] : []),
        retry ? `Nothing was committed; the worktree ${wt} is kept: ${prose.some(p => p.status === "pending") ? "obtain the independent resolution described above" : "move the prose into records or design and leave a pointer"}, then run ${nodeCommand("call.mjs", cfg.configFile ?? "<config.json>", "record", "--ws", ws)} again`
          : "Nothing was committed to the product; call the role again with the rule in its task"].join("\n")];
    } else {
      const done = commitOwned(wt, base, owned, `${cfg.commitPrefix ?? "self-loop"}: ${id}`);
      Object.assign(product, { commit: done.commit, outside: done.outside.slice(0, 50) });
    }
  } else if (!failure && wt) Object.assign(product, { headMoved: git(wt, "rev-parse", "HEAD") !== base, changes: changedPaths(wt).slice(0, 50) });

  let done;
  try {
    done = commitRecords(cfg.records, (candidate) => {
      const { files, read, add } = candidate;
      const exists = path => files.has(path) || existsSync(join(cfg.records, path));
      const evDir = role === "judge" ? `sealed/judge/${pad(round)}` : `evidence/${pad(round)}`;
      let attempt = 1;
      while (exists(`${evDir}/${step}-${attempt}-audit.json`)) attempt++;
      const tag = `${evDir}/${step}-${attempt}`;
      const own = [];
      const put = (path, data, replace = false) => {
        if (!replace && exists(path)) throw new Stop(EXIT.records, `${path} already exists`);
        add(path, data);
        own.push(path);
      };
      put(`${tag}.log.gz`, gzipSync(run.log));
      if (prose.length) put(`${tag}-comments.json`, `${JSON.stringify({ id, role, attempt, base, prose }, null, 1)}\n`);
      put(`${tag}-audit.json`, `${JSON.stringify({ id, role, attempt, exit: run.status, agent: agentFacts, ...audit }, null, 1)}\n`);
      for (const [path, bytes] of outputs) put(`${tag}/out/${path}`, bytes);
      let handoff;
      const designConflicts = [];
      if (!failure) {
        for (const [path, bytes] of outputs) if (designs.has(path)) {
          const dest = lstatSync(join(cfg.records, path), { throwIfNoEntry: false });
          const parent = lstatSync(join(cfg.records, "design"), { throwIfNoEntry: false });
          if ((parent && !parent.isDirectory()) || (dest && (!dest.isFile() || !files.has(path))))
            throw new Stop(EXIT.records, `${path} has local changes or is not a regular records path; resolve it before recording the design`);
          const previous = git(cfg.records, "ls-tree", view, "--", path).split(/\s+/)[2];
          if (previous !== files.get(path)) {
            const current = files.has(path) ? digest(read(path)) : null;
            if (current !== digest(bytes)) {
              const changed = git(cfg.records, "log", "-1", "--format=%H", candidate.head, "--", path) || candidate.head;
              const writer = parseHandoffs(read(HANDOFFS)).findLast(h => h.files.includes(path));
              designConflicts.push({ path, current, changed, writer: writer?.id, proposal: `${tag}/out/${path}` });
            }
            continue;
          }
          put(path, bytes, true);
        }
        const header = [`# ${id}`, "", `phase: ${phase}`, `role: ${role}`, `agent: ${agent.runner} ${agent.model ?? ""}`.trim(), `view: records@${view}`,
          `briefs: ${briefs.join(", ")}`, `product: ${product.base}${product.commit !== product.base ? ` -> ${product.commit}` : ""}`,
          `audit: ${summary.violations} violations, ${summary.denied} denied, ${summary.flags} flags (${tag}-audit.json)`, ""];
        const full = [...header, "## Task (verbatim)", "", "```text", task.trim(), "```", "", "## Report (verbatim)", "", report.trim(), ""].join("\n");
        if (role === "judge") {
          const pub = join(ws, "out", "public.md");
          const text = existsSync(pub) ? readFileSync(pub, "utf8").trim() : "";
          put(record, [...header, "## Public report (verbatim, out/public.md)", "", text || "(the judge wrote no public report)", ""].join("\n"));
          put(`${tag}.md`, full);
        } else put(record, full);
        handoff = validateHandoff({ id, time: now().toISOString().slice(0, 19) + "Z", phase, round, step, role, attempt, agent: agentFacts, view,
          ...(features === undefined ? {} : { features }), briefs, task: digest(task), product, exit: run.status,
          audit: { ...summary, file: `${tag}-audit.json` }, record, files: [...own],
          ...(designConflicts.length ? { designConflicts } : {}) });
        put(HANDOFFS, appendJsonLines(read(HANDOFFS), [handoff]), true);
      }
      const screening = indexHandOff(cfg.records, own, candidate, { layoutText, extraKinds, sealed: cfg.sealed });
      return { message: `${cfg.commitPrefix ?? "self-loop"}: ${id}${failure ? ` attempt ${attempt} failed` : ""}`,
        value: { tag, handoff, screening, designConflicts } };
    });
  } catch (error) {
    if (failure) throw new Stop(failure[0], `${failure[1]}; its evidence could not be committed: ${error.message}`);
    if (error instanceof RecordsConflict) throw new Stop(EXIT.records, error.message);
    throw error;
  }
  const { tag, handoff, screening, designConflicts } = done.value;
  if (failure) {
    if (!(prose.length && retry)) removeWorktree(cfg, wt);
    throw new Stop(failure[0], `${failure[1]} (attempt evidence: ${tag}*; no hand-off)`);
  }
  for (const conflict of designConflicts) log(`screening design-conflict ${conflict.path} changed since the actor's view at ${conflict.changed}${conflict.writer ? ` (prior design hand-off ${conflict.writer})` : ""}. Proposal retained at ${conflict.proposal}`);
  for (const s of screening.slice(0, 10)) log(`screening ${s.rule} ${s.path}${s.line ? `:${s.line}` : ""} ${s.detail}`);
  const moved = [];
  if (product.commit !== base) {
    const integration = cfg.branch && !cfg.protected.includes(cfg.branch) && gitOk(cfg.product, "show-ref", "--verify", "--quiet", `refs/heads/${cfg.branch}`) ? cfg.branch : null;
    if (branch && branch !== integration)
      moved.push(moveBranch(cfg, branch, base, product.commit) ? `${branch} moved to ${product.commit.slice(0, 7)}`
        : `${branch} moved meanwhile, so it was not moved (the commit is ${product.commit})`);
    if (integration) {
      const head = git(cfg.product, "rev-parse", `refs/heads/${integration}`);
      moved.push(!gitOk(cfg.product, "merge-base", "--is-ancestor", head, product.commit)
        ? `${integration} at ${head.slice(0, 7)} was not moved: ${product.commit.slice(0, 7)} does not descend from it (next names both heads)`
        : moveBranch(cfg, integration, head, product.commit) ? `${integration} fast-forwarded to ${product.commit.slice(0, 7)}`
        : `${integration} moved meanwhile, so it was not moved (the commit is ${product.commit})`);
    }
  }
  if (commits) {
    const judged = lastJudged(cfg, done.commit);
    if (judged && gitOk(cfg.product, "cat-file", "-e", `${judged.commit}^{commit}`) && !gitOk(cfg.product, "merge-base", "--is-ancestor", judged.commit, base))
      log(`warning: the base ${base} does not descend from the last judged commit ${judged.commit} (round ${judged.round}); the hand-off is recorded and ${cfg.branch ?? "the integration branch"} keeps the judged line (next lists the commit until it is merged)`);
  }
  removeWorktree(cfg, wt);
  return { code: EXIT.done, message: `${id} recorded in records ${done.commit.slice(0, 7)}${moved.map(m => `; ${m}`).join("")}`, handoff, ws };
}

function removeWorktree(cfg, wt) {
  if (wt) spawnSync("git", ["-C", cfg.product, "worktree", "remove", "--force", wt], { stdio: "ignore" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const [configPath, role] = args._;
  let result;
  try {
    if (role === "record") {
      if (!configPath || !args.ws) throw new Stop(EXIT.usage, "node call.mjs <config.json> record --ws <prepared workspace> [--session <provider session ID>] [--transcript <file>]");
      result = recordCall(load(configPath), args.ws, { transcript: args.transcript || null, session: args.session || null, log: m => console.error(m) });
    } else {
      if (!configPath || !role || !args.round || !args.task) throw new Stop(EXIT.usage, "node call.mjs <config.json> <role> --round N --task <file> [--step s] [--view rev] [--base rev] [--dry-run | --prepare]");
      if (!existsSync(args.task)) throw new Stop(EXIT.usage, `--task ${args.task} does not exist`);
      result = call(load(configPath), role, { round: Number(args.round), step: args.step || role, task: readFileSync(args.task, "utf8"),
        view: args.view || "HEAD", base: args.base || undefined, dry: "dry-run" in args, prepare: "prepare" in args }, { log: m => console.error(m) });
    }
  } catch (e) { result = { code: e instanceof Stop ? e.code : EXIT.failure, message: e.message }; }
  if (result.prepared) console.log(JSON.stringify(result.prepared));
  if (result.handoff) console.log(JSON.stringify(result.handoff));
  console.error(result.message);
  process.exitCode = result.code;
}
