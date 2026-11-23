#!/usr/bin/env node
// Gate: does the full test suite pass on one exact commit, in a clean checkout? The lead runs it before any push (then
// pushes with gated-push.mjs). The commit is checked out as a fresh detached worktree in a temporary folder, so nothing
// uncommitted, untracked or ignored in the repository's own working tree takes part; an optional install command runs
// first; then the test command. Green only when the command exits 0 and, where node --test output is present (spec or
// TAP summary lines), its summed summary has tests > 0, fail 0 and cancelled 0. `--format node-test` requires that
// summary (a run whose output has none is not green).
// design/version-tip.md#one-tree-one-suite-run
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { fullSha, ORIGINAL_OBJECTS } from "./lib/ci.mjs";
import { FORMS, parseVersion } from "./lib/version.mjs";

export const STORE = "self-loop-suite";
export const LOAD_ENV = "SELF_LOOP_LOAD_DIR";

const KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

/** The node --test summary of an output (spec `ℹ fail 0` or TAP `# fail 0` lines), summed over every run; null if none. */
export function parseSummary(output) {
  const summary = Object.fromEntries(KEYS.map(k => [k, 0]));
  let found = false;
  for (const m of output.matchAll(/^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    summary[m[1]] += Number(m[2]);
    found = true;
  }
  return found ? summary : null;
}

/** The verdict on one run: green, and every reason it is not. */
export function verdict({ exit, output, format = "auto", installExit = 0 }) {
  const reasons = [];
  if (installExit !== 0) reasons.push(`install exited ${installExit}`);
  if (exit !== 0) reasons.push(`the command exited ${exit}`);
  const summary = parseSummary(output);
  if (summary) {
    if (summary.fail) reasons.push(`${summary.fail} test(s) failed`);
    if (summary.cancelled) reasons.push(`${summary.cancelled} test(s) cancelled`);
    if (!summary.tests) reasons.push("no test ran");
  } else if (format === "node-test") reasons.push("no node --test summary in the output");
  return { green: reasons.length === 0, reasons, summary };
}

// NODE_TEST_CONTEXT, set when this runs inside a node --test process, would switch an inner node --test to the
// runner's internal protocol instead of its summary; the command runs as it would from a shell.
const shellEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT"));
const sh = (command, cwd, timeoutMin) => {
  const r = spawnSync("sh", ["-c", command], { cwd, env: shellEnv(), encoding: "utf8", maxBuffer: 1 << 30, timeout: timeoutMin * 60_000 });
  return { exit: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}` };
};

const sha256 = text => createHash("sha256").update(text).digest("hex");
const git = (repo, argv, input) => {
  const r = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, ...argv], { encoding: "utf8", maxBuffer: 1 << 26, input });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr || `exit ${r.status}`).trim()}`);
  return r.stdout.trim();
};
const SYNTHETIC = ["-c", "user.name=suite-green", "-c", "user.email=suite-green@self-loop.invalid"];

export const loadDir = (env = process.env) => (env[LOAD_ENV] ? resolve(env[LOAD_ENV]) : join(homedir(), ".self-loop", "load"));

let leases = 0;
function holdLease(repo, sha) {
  const dir = loadDir();
  const name = `suite-${process.pid}-${++leases}`;
  const file = join(dir, `${name}.json`), temp = join(dir, `.${name}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, `${JSON.stringify({ kind: "suite", pid: process.pid, repo, sha, started: new Date().toISOString() })}\n`);
    renameSync(temp, file);
  } catch (e) {
    console.error(`suite-green: no suite lease in ${dir}, so this run is not counted in the host load (${e.message})`);
    rmSync(temp, { force: true });
  }
  return () => rmSync(file, { force: true });
}

export function withVersion(repo, commit, version) {
  const root = git(repo, ["ls-tree", "-z", `${commit}^{tree}`]).split("\0").filter(Boolean);
  const current = root.find(entry => entry.slice(entry.indexOf("\t") + 1) === "VERSION");
  const mode = current?.split(" ")[0] ?? "100644";
  if (!["100644", "100755"].includes(mode)) throw new UsageError(`VERSION in ${commit.slice(0, 7)} is not a regular file`);
  const blob = git(repo, ["hash-object", "-w", "--stdin"], `${version}\n`);
  const entries = [...root.filter(entry => entry !== current), `${mode} blob ${blob}\tVERSION`];
  return git(repo, ["mktree", "-z"], `${entries.join("\0")}\0`);
}

function testedCommit(repo, full, varyVersion) {
  if (varyVersion === null) return { commit: full, tree: git(repo, ["rev-parse", `${full}^{tree}`]) };
  const tree = withVersion(repo, full, varyVersion);
  const commit = git(repo, [...SYNTHETIC, "commit-tree", tree, "-p", full, "-m", `suite-green: ${full} with VERSION ${varyVersion}`]);
  return { commit, tree };
}

export function suiteStore(repo) {
  return join(realpathSync(git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])), STORE);
}

// R-0008-judge-frame proposal 1; design/round9-b.md#runtime
function executionOf(command, install) {
  if (install || !/^node --test(?: [a-zA-Z0-9_./=-]+)*$/.test(command) || process.env.NODE_OPTIONS) return null;
  const resolved = spawnSync("sh", ["-c", "command -v node"], { env: shellEnv(), encoding: "utf8" });
  try {
    const executable = realpathSync(resolved.stdout.trim());
    if (executable !== realpathSync(process.execPath)) return null;
    return { executable, args: command.split(" ").slice(1), digest: sha256(readFileSync(executable)),
      runtime: { node: process.version, platform: process.platform, arch: process.arch } };
  } catch { return null; }
}

const keyText = key => JSON.stringify([key.repository, key.tree, key.command, key.install ?? null, key.execution ?? null, [key.runtime?.node ?? null, key.runtime?.platform ?? null, key.runtime?.arch ?? null]]);
const keyDir = (store, key) => join(store, sha256(keyText(key)));

function storedGreen(dir, key, format) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter(n => /^[\w.-]+\.json$/.test(n)).sort().reverse()) {
    try {
      const path = join(dir, name);
      const run = JSON.parse(readFileSync(path, "utf8"));
      if (!run.key || keyText(run.key) !== keyText(key) || keyText({ ...key, runtime: run.runtime }) !== keyText(key) || run.tree !== key.tree) continue;
      const text = gunzipSync(readFileSync(path.replace(/\.json$/, ".log.gz"))).toString();
      if (sha256(text) !== run.log?.sha256) continue;
      const judged = verdict({ exit: run.exit, output: text, format, installExit: run.installExit });
      if (judged.green) return { path, run, text, judged };
    } catch { continue; }
  }
  return null;
}

function store(dir, run, text) {
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
  writeFileSync(join(dir, `${id}.log.gz`), gzipSync(text));
  const temp = join(dir, `.${id}.tmp`);
  writeFileSync(temp, `${JSON.stringify(run, null, 1)}\n`);
  renameSync(temp, join(dir, `${id}.json`));
  return join(dir, `${id}.json`);
}

function runIn(repo, commit, { command, install, timeoutMin, execution }) {
  const dir = mkdtempSync(join(tmpdir(), "suite-green-"));
  const wt = join(dir, "wt");
  let log = "", exit = -1, installExit = 0;
  try {
    const add = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, "worktree", "add", "-q", "--detach", wt, commit], { encoding: "utf8" });
    if (add.status !== 0) throw new UsageError(`git worktree add failed: ${add.stderr}`);
    if (install) {
      const r = sh(install, wt, timeoutMin);
      installExit = r.exit;
      log += `$ ${install}\n${r.output}\nexit ${r.exit}\n`;
    }
    if (installExit === 0) {
      const direct = execution && spawnSync(execution.executable, execution.args, { cwd: wt, env: shellEnv(), encoding: "utf8", maxBuffer: 1 << 30, timeout: timeoutMin * 60_000 });
      const r = direct ? { exit: direct.status ?? -1, output: `${direct.stdout ?? ""}${direct.stderr ?? ""}` } : sh(command, wt, timeoutMin);
      exit = r.exit;
      log += `$ ${command}\n${r.output}\nexit ${r.exit}\n`;
    }
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
    rmSync(dir, { recursive: true, force: true });
  }
  return { log, exit, installExit };
}

export function suiteGreen({ repo, sha, command, install = null, format = "auto", timeoutMin = 60, varyVersion = null }) {
  repo = resolve(repo);
  const full = fullSha(repo, sha);
  if (varyVersion !== null) {
    const parsed = parseVersion(varyVersion);
    if (!parsed) throw new UsageError(`--vary-version "${varyVersion}" is not ${FORMS}`);
    varyVersion = parsed.text;
  }
  const tested = testedCommit(repo, full, varyVersion);
  const storeDir = suiteStore(repo);
  const execution = executionOf(command, install);
  const runtime = execution?.runtime ?? null;
  const key = { repository: dirname(storeDir), tree: tested.tree, command, install, runtime, execution: execution?.digest ?? null };
  const dir = keyDir(storeDir, key);
  const varied = varyVersion === null ? {} : { versionVaried: varyVersion };
  const hit = execution ? storedGreen(dir, key, format) : null;
  if (hit) {
    return { repository: repo, sha: full, tree: tested.tree, ...varied, command, install, runtime, exit: hit.run.exit, summary: hit.judged.summary,
      durationMs: hit.run.durationMs, green: true, reasons: [], log: hit.run.log, reusedFrom: hit.path, text: hit.text };
  }
  const started = Date.now();
  const release = holdLease(repo, full);
  let ran;
  try { ran = runIn(repo, tested.commit, { command, install, timeoutMin, execution }); }
  finally { release(); }
  const v = verdict({ exit: ran.exit, output: ran.log, format, installExit: ran.installExit });
  const receipt = { repository: repo, sha: full, tree: tested.tree, ...varied, command, install, runtime, exit: ran.exit, summary: v.summary,
    durationMs: Date.now() - started, green: v.green, reasons: v.reasons, log: { sha256: sha256(ran.log), bytes: Buffer.byteLength(ran.log) } };
  try { store(dir, { ...receipt, key, format, installExit: ran.installExit }, ran.log); }
  catch (e) { console.error(`suite-green: the receipt of ${full.slice(0, 7)} was not stored for reuse (${e.message})`); }
  return { ...receipt, text: ran.log };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  need(args, "repo", "sha", "command");
  const format = args.format || "auto";
  if (!["auto", "node-test"].includes(format)) throw new UsageError("--format must be auto or node-test");
  if (args.out && (existsSync(`${args.out}.json`) || existsSync(`${args.out}.log.gz`))) throw new UsageError(`${args.out}.json or .log.gz exists; evidence is never overwritten`);
  let receipt;
  if ("vary-version" in args) need(args, "vary-version");
  try {
    receipt = suiteGreen({ repo: args.repo, sha: args.sha, command: args.command, install: args.install || null, format,
      timeoutMin: Number(args["timeout-min"] || 60), varyVersion: args["vary-version"] ?? null });
  }
  catch (e) { throw e instanceof UsageError ? e : new UsageError(e.message); }
  const { text, ...shown } = receipt;
  if (shown.reusedFrom) console.error(`reused ${shown.reusedFrom}`);
  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(`${args.out}.log.gz`, gzipSync(text));
    writeFileSync(`${args.out}.json`, `${JSON.stringify(shown, null, 1)}\n`);
  }
  console.log(JSON.stringify(shown, null, 2));
  return receipt.green ? 0 : 2;
});
