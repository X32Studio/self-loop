#!/usr/bin/env node
// F-0008, F-0015, P-0014, P-0015, D-0015, D-0016, D-0058, D-0060, D-0061, D-0066, D-0068, D-0069, R-0055-judge-frame-hygiene
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import "./lib/unbind-git.mjs";
import { auditAccess, canonical, eventsOf, FILE_TOOLS, serializeBoundedAudit } from "./audit-access.mjs";
import { collectArchFacts, structuralBreaches } from "./lib/arch-facts.mjs";
import { parseArgs } from "./lib/args.mjs";
import { taskFeatures } from "./lib/blueprint.mjs";
import { ARCH_STEP, JUDGE_FRAME_STEP } from "./lib/cadence.mjs";
import { archBaselineFacts, lastOuterBaselineSha, refuseExhaustedWindow, refuseOuterLoopOverdue, refuseUndiagnosed, refuseUndistilledOwnerWords, viewHandoffs } from "./lib/call-gates.mjs";
import { node as nodeCommand } from "./lib/commands.mjs";
import { addedProse, commentResolutions } from "./lib/comments.mjs";
import { validateDispatchCall } from "./lib/dispatch.mjs";
import { blobs, git, gitOk, regularFiles, writeFiles } from "./lib/git-plumbing.mjs";
import { HANDOFFS, hasPhaseFrame, idOf, parseHandoffs, recordOf, ROLES, validateHandoff } from "./lib/handoff.mjs";
import { ADAPTERS, isAdapter, isPreparedRunner, resolveAdapter } from "./lib/paseo.mjs";
import { snapshot as planSnapshot } from "./lib/plan.mjs";
import { globMatch } from "./lib/plan-globs.mjs";
import { verifyProvenance } from "./lib/provenance.mjs";
import { appendJsonLines, commitRecords, RecordsConflict } from "./lib/records-commit.mjs";
import { parsePruneManifests } from "./lib/records-prune.mjs";
import { DISPLAY_SHA_LEN, renderSsotStatusMarkdown } from "./lib/ssot.mjs";
import { cancelPreparedCall, preparationFile, preparationScope, preparedIn, readPreparation, resolveChildSession, t3Prompt, transcriptEvents } from "./lib/t3-child.mjs";
import { validateJudgeIndependence, validateModelVendors } from "./lib/vendor.mjs";
import { collectCleanOutFiles, reclaimWorkspacePayloads } from "./lib/work-hygiene.mjs";
import { classify, DEFAULT_LAYOUT, inspect, isPublicKind, parseLayout, renderIndex } from "./records-check.mjs";
import { purgeTreeReceipts, stageSuiteWorkspace } from "./suite-green.mjs";

export { archBaselineFacts, viewHandoffs };

export const EXIT = { done: 0, failure: 1, gate: 2, violation: 6, records: 7, usage: 64 };
export const HEAVY_ROLES = ["critic", "actor", "judge"];
export const LOAD_ENV = "SELF_LOOP_LOAD_DIR";
export const loadDir = (env = process.env, home = homedir()) => env[LOAD_ENV] ? resolve(env[LOAD_ENV]) : join(home, ".self-loop", "load");
export { PUBLIC_KINDS } from "./records-check.mjs";
export { preparedIn } from "./lib/t3-child.mjs";

const QUOTED = new Set(["Backtests", "Evidence", "Blueprint evidence", "Sealed"]);
const JUDGE_COMMENTS_STEP = /^judge-comments(?:-[a-z]+)*$/;
const isMetaJudge = (role, step) => role === "judge" && (JUDGE_FRAME_STEP.test(step) || JUDGE_COMMENTS_STEP.test(step));
const requiresPlan = (role, step) => role !== "reviewer" && !isMetaJudge(role, step);
const digest = text => createHash("sha256").update(text).digest("hex");
const pad = n => String(n).padStart(4, "0");

export class Stop extends Error { constructor(code, message) { super(message); this.code = code; } }

export function load(configPath) {
  const abs = resolve(configPath);
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  return { ...normalize(raw, dirname(abs)), configFile: abs };
}

export function normalize(cfg, base = process.cwd()) {
  for (const key of ["product", "records", "workDir", "phase", "briefs", "agents"]) if (!cfg[key]) throw new Stop(EXIT.usage, `config needs "${key}"`);
  const pol = validateJudgeIndependence(cfg.judgeIndependence);
  if (!pol.ok) throw new Stop(EXIT.usage, pol.error);
  const mv = validateModelVendors(cfg.modelVendors);
  if (!mv.ok) throw new Stop(EXIT.usage, mv.error);
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

export function argv(agent, { confined, cwd, addDirs }) {
  if (agent.runner === "claude") return ["claude", ["-p", "--restricted", "--strict-mcp-config",
    ...(confined ? ["--tools", FILE_TOOLS.join(",")] : ["--tools", [...FILE_TOOLS, "Bash"].join(","), "--allowedTools", "Bash"]),
    "--permission-mode", "acceptEdits", ...addDirs.flatMap(d => ["--add-dir", d]),
    ...(agent.model ? ["--model", agent.model] : []), ...(agent.effort ? ["--effort", agent.effort] : []),
    "--output-format", "stream-json", "--verbose"]];
  if (agent.runner === "codex" && agent.sandbox && !["workspace-write", "danger-full-access"].includes(agent.sandbox))
    throw new Stop(EXIT.usage, `unknown codex sandbox ${agent.sandbox} (workspace-write or danger-full-access)`);
  if (agent.runner === "codex") return ["codex", ["exec", "--json", "--skip-git-repo-check", "-C", cwd,
    "-c", `sandbox_mode="${agent.sandbox ?? "workspace-write"}"`, ...addDirs.flatMap(d => ["--add-dir", d]),
    ...(agent.model ? ["-m", agent.model] : []), ...(agent.effort ? ["-c", `model_reasoning_effort="${agent.effort}"`] : []), "-"]];
  if (isPreparedRunner(agent.runner)) {
    if (typeof agent.provider !== "string" || !agent.provider.trim()) {
      throw new Stop(EXIT.usage, "a t3/paseo agent needs a non-empty provider string");
    }
    if (agent.adapter !== undefined && agent.adapter !== null && !isAdapter(agent.adapter)) {
      throw new Stop(EXIT.usage, `unknown adapter ${JSON.stringify(agent.adapter)} (expected ${ADAPTERS.join(", ")})`);
    }
    return null;
  }
  if (agent.runner === "cmd") {
    if (process.env.SELF_LOOP_TEST !== "1") throw new Stop(EXIT.usage, "the cmd runner is a test stand-in and is refused unless SELF_LOOP_TEST=1; use claude or codex");
    return [agent.cmd[0], agent.cmd.slice(1)];
  }
  throw new Stop(EXIT.usage, `unknown runner ${agent.runner} (claude, codex, t3, paseo or cmd)`);
}

function prompt({ role, step = role, round, phase, ws, view, base, owns, sealed, wt = null, ssotHint = null, suiteHint = null }) {
  const isArchReviewer = role === "reviewer" && ARCH_STEP.test(step);
  return [
    `You are the ${role} of a self-loop, round ${round}, phase ${phase}. Your working folder is ${ws}.`,
    `Read brief-shared.md, brief.md and task.md there first and follow them. records/ is a read-only view of the loop's records at commit ${view}; read records/INDEX.md before anything else in it. Write only under out/.`,
    isArchReviewer
      ? `Read-only product worktree is ${wt ?? join(ws, "wt")}, detached at ${base}. Deterministic whole-repo metrics are in arch-facts.json. purpose/ holds the product's purpose documents. File tools only; never modify the product worktree.`
      : role === "reviewer"
        ? "Only the files in your working folder exist for this task; purpose/ holds the product's purpose documents."
        : `The product worktree is ${wt ?? "your current directory"}, detached at ${base}. Write only: ${owns.join(", ") || "(nothing in the product)"}. Do not commit; your owned paths are committed for you.`,
    "Write your report to out/report.md. Questions only the owner can decide go to out/decisions.json (see your brief).",
    role === "judge" ? "out/report.md is your full ruling and stays private to you and the lead. out/public.md is the only part the other roles read: properties broken, blockers by class and id, to-do lists; never held-out content, names or paths." : "",
    role === "judge" && sealed.length ? `Held-out cases (yours alone): ${sealed.join(", ")}.` : "",
    suiteHint ?? "",
    ssotHint ?? "",
  ].filter(Boolean).join("\n");
}

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

export function call(cfg, role, opts, { log = () => {}, now = () => new Date() } = {}) {
  try { return callInner(cfg, role, opts, { log, now }); }
  catch (e) {
    if (e instanceof Stop || Number.isInteger(e?.code)) return { code: e.code, message: e.message };
    return { code: EXIT.failure, message: String(e.stack ?? e) };
  }
}

function callInner(cfg, role, { round, step = role, task, view: viewRev = "HEAD", base: baseRev, dry = false, prepare = false, plan: planId = null, package: pkgOpt = null, pkg: pkgArg = null }, { log, now }) {
  const packageId = pkgArg ?? pkgOpt ?? null;
  if (Boolean(planId) !== Boolean(packageId)) throw new Stop(EXIT.usage, "--plan and --package must be passed together");
  if (!ROLES.includes(role)) throw new Stop(EXIT.usage, `role must be one of ${ROLES.join(", ")}`);
  if (!Number.isInteger(round) || round < 1) throw new Stop(EXIT.usage, "--round must be a whole number from 1");
  if (step !== role && !new RegExp(`^${role}(-[a-z]+)+$`).test(step)) throw new Stop(EXIT.usage, `--step must be ${role} or ${role}-<word>`);
  if (typeof task !== "string" || !task.trim()) throw new Stop(EXIT.usage, "--task must name a non-empty file: the lead's instructions for this call");
  const agent = cfg.agents[role];
  if (!agent) throw new Stop(EXIT.usage, `config needs agents.${role}`);
  if (role === "reviewer" && agent.runner === "codex") throw new Stop(EXIT.usage, "the frame reviewer cannot run on codex: its sandbox does not confine reads (DEBT.md)");
  if (role === "reviewer" && isPreparedRunner(agent.runner) && resolveAdapter(agent) === "codex")
    throw new Stop(EXIT.usage, `the frame reviewer cannot run on ${agent.runner}:codex: Codex transcripts use shell command_execution rather than structured file-only tools and cannot be strictly file-confined`);
  if (isPreparedRunner(agent.runner) !== Boolean(prepare) && !dry) throw new Stop(EXIT.usage, isPreparedRunner(agent.runner)
    ? `agents.${role} runs as a ${agent.runner === "paseo" ? "Paseo child agent" : "T3 child thread"}: prepare it with --prepare, start the child with the printed prompt, then \`record --ws\``
    : "--prepare is only for a role whose runner is t3 or paseo");
  argv(agent, { confined: true, cwd: ".", addDirs: [] });
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
  const missing = features.find(fid => !viewPaths.has(`blueprint/${fid}.md`));
  if (missing) throw new Stop(EXIT.records, `features: ${missing} is not a regular blueprint record at view ${view.slice(0, DISPLAY_SHA_LEN)}`);
  const briefs = [cfg.briefs.shared, cfg.briefs[role]].filter(Boolean);
  if (!cfg.briefs[role]) throw new Stop(EXIT.usage, `config needs briefs.${role}`);
  for (const b of briefs) if (!gitOk(cfg.records, "cat-file", "-e", `${view}:${b}`)) throw new Stop(EXIT.usage, `brief ${b} is not committed in the records at ${view.slice(0, DISPLAY_SHA_LEN)}`);
  const baseName = baseRev ?? cfg.branch ?? "HEAD";
  let base;
  try { base = git(cfg.product, "rev-parse", "--verify", "--quiet", `${baseName}^{commit}`); } catch { throw new Stop(EXIT.usage, `--base ${baseName} is not a product commit`); }
  const branch = gitOk(cfg.product, "show-ref", "--verify", "--quiet", `refs/heads/${baseName}`) ? baseName : null;
  const commits = ["critic", "actor"].includes(role);
  if (commits && branch && cfg.protected.includes(branch)) throw new Stop(EXIT.usage, `${branch} is protected; a role works on a loop branch, the lead promotes with gated-push.mjs`);
  if (role !== "reviewer") refuseUndiagnosed(cfg, view, round, { Stop, EXIT });
  if (HEAVY_ROLES.includes(role)) {
    const prov = verifyProvenance({ repo: cfg.product, records: cfg.records, sha: base, cfg, mode: "base" });
    if (!prov.ok) throw new Stop(EXIT.records, `--base ${base.slice(0, DISPLAY_SHA_LEN)} failed provenance verification: ${prov.reasons.join("; ")}`);
  }
  if (commits) refuseUndistilledOwnerWords(cfg, view, round, { Stop, EXIT });
  if (requiresPlan(role, step) && !planId)
    throw new Stop(EXIT.records, `${role} (${step}) requires --plan PL-NNNN --package <id> (D-0060; only reviewer, judge-frame*, and judge-comments* are exempt)`);
  const win = role === "actor" ? refuseExhaustedWindow(cfg, view, viewPaths, round, { Stop, EXIT }) : null;
  let dispatchMeta = null;
  if (planId && packageId) {
    const check = validateDispatchCall({
      cfg, state: planSnapshot(cfg.records, "HEAD"), planId, packageId, role, step, round, base,
      prepared: preparedIn(cfg), window: win,
    });
    if (!check.ok) throw new Stop(EXIT.records, check.errors.join("\n"));
    dispatchMeta = { plan: planId, package: packageId, files: check.scopeFiles, peerFiles: check.peerFiles };
  }
  if (role === "actor") refuseOuterLoopOverdue(cfg, view, viewPaths, base, round, win, dispatchMeta?.files ?? null, { Stop, EXIT, preparedIn });

  const extra = recordsConfig(cfg, view);
  const extraKinds = extra.extraKinds ?? [];
  const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
  const layout = parseLayout(layoutText, extraKinds);

  mkdirSync(cfg.workDir, { recursive: true });
  const ws = mkdtempSync(join(cfg.workDir, `${pad(round)}-${step}-`));
  mkdirSync(join(ws, "out"));
  const holds = buildView(cfg, view, join(ws, "records"), layout, extraKinds, role, viewFiles);
  writeFileSync(join(ws, "brief-shared.md"), cfg.briefs.shared ? git(cfg.records, "show", `${view}:${cfg.briefs.shared}`) : "");
  writeFileSync(join(ws, "brief.md"), git(cfg.records, "show", `${view}:${cfg.briefs[role]}`));
  writeFileSync(join(ws, "task.md"), task);
  const isArchReviewer = role === "reviewer" && ARCH_STEP.test(step);
  let wt = null, keep = false;
  const cleanup = () => { if (!keep) removeWorktree(cfg, wt); };
  try {
    if (role === "reviewer") {
      const purpose = regularFiles(cfg.product, base).filter(f => cfg.purpose.some(p => f.path === p || f.path.startsWith(`${p.replace(/\/$/, "")}/`)));
      mkdirSync(join(ws, "purpose"), { recursive: true });
      writeFiles(join(ws, "purpose"), purpose, blobs(cfg.product, purpose.map(f => f.sha)));
      if (isArchReviewer) {
        wt = join(ws, "wt");
        git(cfg.product, "worktree", "add", "-q", "--detach", wt, base);
        const baselineSha = lastOuterBaselineSha(cfg, view, viewPaths);
        const facts = collectArchFacts(cfg.product, base, { baselineSha });
        const factsFile = join(ws, "arch-facts.json");
        writeFileSync(factsFile, `${JSON.stringify({ ...facts, breaches: structuralBreaches(facts) }, null, 2)}\n`);
        chmodSync(factsFile, 0o444);
      }
    } else {
      wt = join(ws, "wt");
      git(cfg.product, "worktree", "add", "-q", "--detach", wt, base);
      for (const cmd of cfg.setup) {
        const r = spawnSync(cmd[0], cmd.slice(1), { cwd: wt, encoding: "utf8", maxBuffer: 1 << 28 });
        if (r.status !== 0) throw new Stop(EXIT.failure, `setup \`${cmd.join(" ")}\` exited ${r.status} in the ${role}'s worktree; no model was called\n${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-2000)}`);
      }
    }
    const owns = cfg.owns[role] ?? [];
    let suiteReceipt = null, suiteHint = null;
    if (!dry && cfg.gates?.suite) {
      const suiteCmd = cfg.gates.suite, suiteInstall = cfg.gates.install ?? "", suiteFormat = cfg.gates.format ?? "auto";
      const ensureSuite = (role === "judge" && !isMetaJudge(role, step)) || (role === "critic" && Array.isArray(dispatchMeta?.files) && dispatchMeta.files.length === 0);
      if (ensureSuite) {
        const staged = stageSuiteWorkspace({ repo: cfg.product, sha: base, command: suiteCmd, install: suiteInstall, format: suiteFormat, ws, mode: "ensure" });
        if (!staged.ok) throw new Stop(EXIT.gate, `pre-${role} suite gate failed on ${base.slice(0, DISPLAY_SHA_LEN)} (${(staged.reasons ?? []).join("; ")}); no ${role} model was called`);
        const rec = staged.receipt;
        suiteReceipt = { tree: rec.tree, sha: rec.sha, green: rec.green, summary: rec.summary, stagedPath: staged.stagedPath, command: suiteCmd };
        suiteHint = `Host-verified ${staged.stagedPath} is staged for HEAD^{tree} ${rec.tree}; verify tree === HEAD^{tree} and do NOT re-run \`${suiteCmd}\` on unchanged wt.`;
      } else if (commits) {
        const staged = stageSuiteWorkspace({ repo: cfg.product, sha: base, command: suiteCmd, install: suiteInstall, format: suiteFormat, ws, mode: "lookup" });
        if (staged.ok && staged.receipt) {
          const rec = staged.receipt;
          suiteReceipt = { tree: rec.tree, sha: rec.sha, green: rec.green, summary: rec.summary, stagedPath: staged.stagedPath, command: suiteCmd };
          suiteHint = `Host-verified ${staged.stagedPath} is staged for base tree ${rec.tree}; do NOT re-run \`${suiteCmd}\` on unchanged wt.`;
        }
      }
    }
    let ssotHint = null;
    if ((role === "actor" || role === "critic" || role === "judge") && Object.hasOwn(cfg, "ssot")) {
      const status = renderSsotStatusMarkdown(cfg, { configFile: cfg.configFile, sha: base });
      if (status) {
        const statusFile = join(ws, "ssot-status.md");
        writeFileSync(statusFile, status.markdown);
        chmodSync(statusFile, 0o444);
        const verb = role === "actor" ? "editing" : role === "critic" ? "reviewing" : "ruling";
        ssotHint = `SSOT status at ${base.slice(0, DISPLAY_SHA_LEN)}: read ssot-status.md before ${verb} (${status.summary}).`;
      }
    }
    const text = prompt({ role, step, round, phase: cfg.phase, ws, view, base, owns, sealed: cfg.sealed, wt: isPreparedRunner(agent.runner) || isArchReviewer ? wt : null, ssotHint, suiteHint });
    writeFileSync(join(ws, "prompt.md"), text);
    if (dry) return { code: EXIT.done, message: `dry run: ${ws} (view ${view.slice(0, DISPLAY_SHA_LEN)}, ${holds.length} records); nothing called or recorded`, ws };

    const ctx = { role, round, step, phase: cfg.phase, task, features, id, record, view, briefs, base, branch, commits, extraKinds, ws, wt, owns, agent,
      ...(dispatchMeta ? { dispatch: dispatchMeta } : {}),
      ...(suiteReceipt ? { suiteReceipt } : {}) };
    if (prepare) {
      const nonce = createHash("sha256").update(`${ws}\n${now().toISOString()}\n${Math.random()}`).digest("hex").slice(0, 16);
      const childPrompt = t3Prompt({ id, nonce, wt, ws, text, runner: agent.runner });
      const manifest = `${JSON.stringify({ version: 2, ...ctx, nonce, preparedAt: now().getTime() }, null, 1)}\n`;
      const snapshot = preparationFile(cfg, ws);
      mkdirSync(dirname(snapshot), { recursive: true, mode: 0o700 });
      writeFileSync(snapshot, JSON.stringify({ manifest: digest(manifest), prompt: digest(childPrompt), task: digest(task), scope: preparationScope(cfg) }),
        { mode: 0o600, flag: "wx" });
      writeFileSync(join(ws, "t3-prompt.md"), childPrompt);
      writeFileSync(join(ws, "call.json"), manifest);
      keep = true;
      const childLabel = agent.runner === "paseo" ? "Paseo child" : "T3 child";
      return { code: EXIT.done, message: `${id} prepared for a ${childLabel} in ${ws}; start it with t3-prompt.md, then: call.mjs <config> record --ws ${ws}`,
        prepared: { id, ws, wt, nonce, prompt: childPrompt, target: { provider: agent.provider, model: agent.model ?? null, effort: agent.effort ?? null, ...(agent.adapter ? { adapter: agent.adapter } : {}) }, ...(suiteReceipt ? { suiteReceipt } : {}) } };
    }
    const confined = role === "reviewer";
    const cwd = confined ? ws : wt;
    const addDirs = confined ? (isArchReviewer && wt ? [wt] : []) : [ws, ...(role === "judge" ? cfg.sealed : [])];
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
    const cliModels = [...new Set(events.map(({ event: e }) =>
      e?.type === "system" && e.subtype === "init" ? e.model
        : e?.type === "assistant" ? e.message?.model : e?.type === "turn_context" ? e.payload?.model : null)
      .filter(m => typeof m === "string" && m.trim()).map(m => m.trim()))];
    const run = { status: r.status, error: r.error ?? null, log: `${r.stdout ?? ""}\n${r.stderr ?? ""}`, events, cwd,
      facts: { runner: agent.runner, model: agent.model ?? null, effort: agent.effort ?? null,
        ...(agent.vendor ? { vendor: agent.vendor } : {}),
        observedModel: cliModels[0] ?? null, ...(cliModels.length ? { observedModels: cliModels } : {}),
        costUsd: events.find(e => e.event.type === "result")?.event.total_cost_usd ?? null, seconds: Math.round((Date.now() - started) / 100) / 10 } };
    keep = true;
    return finish(cfg, ctx, run, { log, now });
  } finally { cleanup(); }
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

function treeAttestedInHandoffs(cfg, tree) {
  if (!gitOk(cfg.records, "cat-file", "-e", `HEAD:${HANDOFFS}`)) return false;
  const shas = new Set();
  for (const h of parseHandoffs(git(cfg.records, "show", `HEAD:${HANDOFFS}`))) {
    if (h.product?.commit) shas.add(h.product.commit);
  }
  for (const sha of shas) {
    if (gitOk(cfg.product, "--no-replace-objects", "cat-file", "-e", `${sha}^{commit}`)
      && git(cfg.product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`) === tree) return true;
  }
  return false;
}

function moveBranch(cfg, name, from, to) {
  return gitOk(cfg.product, "update-ref", `refs/heads/${name}`, to, from);
}

// D-0060, F-0015, design/mandatory-control-plane.md#5
export function cancelCall(cfg, wsDir, { reason, now = () => new Date() } = {}) {
  try {
    const cancelled = cancelPreparedCall({ ws: wsDir, product: cfg.product, reason, now });
    reclaimWorkspacePayloads(cancelled.ws);
    return { code: EXIT.done, message: `${cancelled.id} cancelled (${cancelled.ws}): ${cancelled.cancelReason}`, cancelled };
  } catch (e) {
    if (e instanceof Stop || Number.isInteger(e?.code)) return { code: e.code, message: e.message };
    return { code: EXIT.failure, message: String(e.stack ?? e) };
  }
}

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
    const adapter = resolveAdapter(ctx.agent);
    const runnerPrefix = isPreparedRunner(ctx.agent.runner) ? ctx.agent.runner : "t3";
    const bound = existsSync(binding) ? readFileSync(binding, "utf8") : null;
    if (bound && session && bound !== session) throw new Stop(EXIT.records, "the call is already bound to a different provider session");
    session ??= bound;
    const match = resolveChildSession(ctx.agent, ctx.nonce, ctx.preparedAt, session, transcript);
    const t = transcriptEvents(ctx.id, { ...match, adapter, session });
    if (t.nonAuthoritative || t.truncated)
      throw new Stop(EXIT.records, t.refusalReason ?? `the transcript is not authoritative (${match.file})`);
    if (!t.firstPrompt.includes(expected)) throw new Stop(EXIT.records, `the child's first prompt does not hold t3-prompt.md verbatim: start the child with exactly that text (${match.file})`);
    if (!t.session || t.forked || (session && session !== t.session))
      throw new Stop(EXIT.records, `the transcript is not from the prepared ${runner} child session (${match.file})`);
    const resolvedSession = session ?? match.session ?? t.session;
    if (!bound) {
      mkdirSync(dirname(binding), { recursive: true, mode: 0o700 });
      try { writeFileSync(binding, resolvedSession, { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST" || readFileSync(binding, "utf8") !== resolvedSession) throw error; }
    }
    if (t.status === "pending") throw new Stop(EXIT.failure, `the child's transcript has no terminal event yet; its ${ctx.wt ? "worktree" : "workspace"} is still available`);
    const run = { status: t.status === "failed" ? 1 : 0, error: null, log: t.text, events: t.events, cwd: t.cwd ?? ctx.wt ?? null,
      facts: { runner: `${runnerPrefix}:${runner}`, session: resolvedSession, model: ctx.agent.model ?? null, effort: ctx.agent.effort ?? null,
        ...(ctx.agent.vendor ? { vendor: ctx.agent.vendor } : {}),
        ...(ctx.agent.adapter ? { adapter: ctx.agent.adapter } : {}),
        observedModel: t.observedModel, ...(t.observedModels ? { observedModels: t.observedModels } : {}),
        costUsd: null, seconds: t.seconds } };
    log(`${ctx.id}: recording the ${runnerPrefix === "paseo" ? "Paseo" : "T3"} child's transcript ${match.file}`);
    return finish(cfg, ctx, run, { log, now, reclaim: true });
  } catch (e) {
    if (e instanceof Stop || Number.isInteger(e?.code)) return { code: e.code, message: e.message };
    return { code: EXIT.failure, message: String(e.stack ?? e) };
  }
}

function finish(cfg, ctx, run, { log, now, reclaim = false }) {
  const { role, round, step, phase = cfg.phase, task, features, id, record, view, briefs, base, branch, commits, extraKinds, ws, wt, owns, agent, dispatch = null, suiteReceipt = null } = ctx;
  const confined = role === "reviewer";
  const isArchReviewer = confined && ARCH_STEP.test(step);
  const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
  const visible = confined ? (isArchReviewer && wt ? [ws, wt] : [ws]) : [ws, wt, ...(role === "judge" ? cfg.sealed : [])];
  const audit = auditAccess(visible, run.events, confined
    ? { cwd: run.cwd }
    : { tools: null, cwd: run.cwd, forbidden: role === "judge" ? [cfg.records] : [cfg.records, ...cfg.sealed], stagedSuiteCommand: suiteReceipt?.command ?? null });
  const summary = { violations: audit.violations.length, denied: audit.denied.length, flags: audit.flags.length, unrecognized: audit.unrecognized };
  const reportFile = join(ws, "out", "report.md");
  const report = existsSync(reportFile) ? readFileSync(reportFile, "utf8") : "";
  const archWtMutated = Boolean(isArchReviewer && wt && (git(wt, "rev-parse", "HEAD") !== base || changedPaths(wt).length > 0));
  let failure = audit.violations.length ? [EXIT.violation, `${role} accessed what it may not see: ${audit.violations.slice(0, 3).map(v => `${v.tool} ${v.path}`).join("; ")}`]
    : archWtMutated ? [EXIT.violation, `${step} modified the read-only product worktree`]
    : confined && isPreparedRunner(agent.runner) && (audit.unparsedCalls > 0 || (audit.unrecognized > 0 && audit.toolEvents === 0))
      ? [EXIT.violation, `${role} confinement could not be verified from structured transcript events (${audit.unparsedCalls} unparsed tool calls, ${audit.unrecognized} unrecognized events, ${audit.toolEvents} tool events)`]
    : run.error ? [EXIT.failure, `${role} could not run: ${run.error.message}`]
    : run.status !== 0 ? [EXIT.failure, `${role} exited ${run.status}`]
    : !report.trim() ? [EXIT.failure, `${role} wrote no out/report.md`] : null;
  const designs = new Set(designOutputs(ws, role, parseLayout(layoutText, extraKinds)));
  const outCollected = collectCleanOutFiles(join(ws, "out"), { role });
  const outputs = outCollected.included.filter(([path]) => role === "judge" || path !== "report.md");
  const agentFacts = run.facts;
  const product = { base, commit: base };
  const retry = isPreparedRunner(agent.runner);
  let prose = [];
  if (!failure && commits) {
    const owned = ownedChanges(wt, base, owns);
    if (dispatch) {
      const inPkg = p => (dispatch.files ?? []).some(pat => globMatch(pat, p));
      const allChanged = [...owned.inside, ...owned.outside];
      const peerHits = allChanged.filter(p => !inPkg(p) && (dispatch.peerFiles ?? []).some(pat => globMatch(pat, p)));
      if (peerHits.length) {
        failure = [EXIT.records, `cross-package write violation (${dispatch.plan}/${dispatch.package}): modified peer-owned path(s) ${peerHits.join(", ")}`];
      } else {
        owned.outside = [...owned.outside, ...owned.inside.filter(p => !inPkg(p))];
        owned.inside = owned.inside.filter(inPkg);
      }
    }
    if (!failure) {
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
        const committed = commitOwned(wt, base, owned, `${cfg.commitPrefix ?? "self-loop"}: ${id}`);
        Object.assign(product, { commit: committed.commit, outside: committed.outside.slice(0, 50) });
        if (committed.commit !== base) {
          const committedTree = git(cfg.product, "--no-replace-objects", "rev-parse", `${committed.commit}^{tree}`);
          if (!treeAttestedInHandoffs(cfg, committedTree)) purgeTreeReceipts(cfg.product, committedTree);
        }
      }
    }
  } else if (!failure && wt) Object.assign(product, { headMoved: git(wt, "rev-parse", "HEAD") !== base, changes: changedPaths(wt).slice(0, 50) });

  let done;
  try {
    done = commitRecords(cfg.records, (candidate) => {
      const { files, read, add } = candidate;
      const exists = path => files.has(path) || existsSync(join(cfg.records, path));
      const pruned = parsePruneManifests(files.keys(), read);
      const evDir = role === "judge" ? `sealed/judge/${pad(round)}` : `evidence/${pad(round)}`;
      let attempt = 1;
      while (exists(`${evDir}/${step}-${attempt}-audit.json`)
        || pruned.has(`${evDir}/${step}-${attempt}-audit.json`)
        || pruned.has(`${evDir}/${step}-${attempt}.log.gz`)) attempt++;
      const tag = `${evDir}/${step}-${attempt}`;
      const own = [];
      const put = (path, data, replace = false) => {
        if (!replace && exists(path)) throw new Stop(EXIT.records, `${path} already exists`);
        add(path, data);
        own.push(path);
      };
      put(`${tag}.log.gz`, gzipSync(run.log));
      if (prose.length) put(`${tag}-comments.json`, `${JSON.stringify({ id, role, attempt, base, prose }, null, 1)}\n`);
      const auditPayload = {
        id, role, attempt, exit: run.status, nonce: ctx.nonce ?? null, agent: agentFacts, ...audit,
        ...(outCollected.excludedCount ? { excludedOutPaths: outCollected.excludedPaths, excludedOutCount: outCollected.excludedCount, ...(outCollected.truncated ? { outIngestionTruncated: true } : {}) } : {}),
      };
      put(`${tag}-audit.json`, serializeBoundedAudit(auditPayload, 1048576));
      if (isArchReviewer && existsSync(join(ws, "arch-facts.json"))) put(`${tag}-arch-facts.json`, readFileSync(join(ws, "arch-facts.json")));
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
          ...(designConflicts.length ? { designConflicts } : {}),
          ...(dispatch ? { dispatch: { plan: dispatch.plan, package: dispatch.package, files: dispatch.files } } : {}) });
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
      moved.push(moveBranch(cfg, branch, base, product.commit) ? `${branch} moved to ${product.commit.slice(0, DISPLAY_SHA_LEN)}`
        : `${branch} moved meanwhile, so it was not moved (the commit is ${product.commit})`);
    if (integration) {
      const head = git(cfg.product, "rev-parse", `refs/heads/${integration}`);
      moved.push(!gitOk(cfg.product, "merge-base", "--is-ancestor", head, product.commit)
        ? `${integration} at ${head.slice(0, DISPLAY_SHA_LEN)} was not moved: ${product.commit.slice(0, DISPLAY_SHA_LEN)} does not descend from it (next names both heads)`
        : moveBranch(cfg, integration, head, product.commit) ? `${integration} fast-forwarded to ${product.commit.slice(0, DISPLAY_SHA_LEN)}`
        : `${integration} moved meanwhile, so it was not moved (the commit is ${product.commit})`);
    }
  }
  const manifest = join(ws, "call.json");
  if (existsSync(manifest)) {
    try {
      const saved = JSON.parse(readFileSync(manifest, "utf8"));
      writeFileSync(manifest, `${JSON.stringify({ ...saved, recorded: true, recordedAt: now().toISOString() }, null, 1)}\n`);
    } catch {}
  }
  removeWorktree(cfg, wt);
  if (reclaim) reclaimWorkspacePayloads(ws);
  return { code: EXIT.done, message: `${id} recorded in records ${done.commit.slice(0, DISPLAY_SHA_LEN)}${moved.map(m => `; ${m}`).join("")}`, handoff, ws };
}

function removeWorktree(cfg, wt) {
  if (!wt) return;
  try { spawnSync("git", ["-C", cfg.product, "worktree", "remove", "--force", wt], { stdio: "ignore" }); } catch {}
  try { if (existsSync(wt)) rmSync(wt, { recursive: true, force: true }); } catch {}
  try { spawnSync("git", ["-C", cfg.product, "worktree", "prune"], { stdio: "ignore" }); } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const [configPath, role] = args._;
  let result;
  try {
    if (role === "record") {
      if (!configPath || !args.ws) throw new Stop(EXIT.usage, "node call.mjs <config.json> record --ws <prepared workspace> [--session <provider session ID>] [--transcript <file>]");
      result = recordCall(load(configPath), args.ws, { transcript: args.transcript || null, session: args.session || null, log: m => console.error(m) });
    } else if (role === "cancel") {
      if (!configPath || !args.ws || !args.reason) throw new Stop(EXIT.usage, "node call.mjs <config.json> cancel --ws <prepared workspace> --reason <text>");
      result = cancelCall(load(configPath), args.ws, { reason: args.reason });
    } else {
      if (!configPath || !role || !args.round || !args.task) throw new Stop(EXIT.usage, "node call.mjs <config.json> <role> --round N --task <file> [--step s] [--view rev] [--base rev] [--plan PL-NNNN --package id] [--dry-run | --prepare]");
      if (!existsSync(args.task)) throw new Stop(EXIT.usage, `--task ${args.task} does not exist`);
      result = call(load(configPath), role, { round: Number(args.round), step: args.step || role, task: readFileSync(args.task, "utf8"),
        view: args.view || "HEAD", base: args.base || undefined, dry: "dry-run" in args, prepare: "prepare" in args,
        plan: "plan" in args ? args.plan : null, package: "package" in args ? args.package : null }, { log: m => console.error(m) });
    }
  } catch (e) { result = { code: e instanceof Stop || Number.isInteger(e?.code) ? e.code : EXIT.failure, message: e.message }; }
  if (result.prepared) console.log(JSON.stringify(result.prepared));
  if (result.handoff) console.log(JSON.stringify(result.handoff));
  if (result.cancelled) console.log(JSON.stringify(result.cancelled));
  console.error(result.message);
  process.exitCode = result.code;
}
