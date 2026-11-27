#!/usr/bin/env node
// D-0020, D-0061, D-0064, design/version-tip.md#one-tree-one-suite-run, design/suite-once.md#1
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { cli, need, parseArgs, UsageError } from "./lib/args.mjs";
import { fullSha, ORIGINAL_OBJECTS } from "./lib/ci.mjs";
import { pruneSuiteStore } from "./lib/suite-prune.mjs";
import { tipProblem } from "./lib/tip.mjs";
import { FORMS, parseVersion } from "./lib/version.mjs";

export { pruneSuiteStore };

export const STORE = "self-loop-suite";
export const LOAD_ENV = "SELF_LOOP_LOAD_DIR";

const KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

export function parseSummary(output) {
  const summary = Object.fromEntries(KEYS.map(k => [k, 0]));
  let found = false;
  for (const m of output.matchAll(/^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    summary[m[1]] += Number(m[2]);
    found = true;
  }
  return found ? summary : null;
}

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

export function codeTreeOf(repo, treeish) {
  const root = git(repo, ["ls-tree", "-z", `${treeish}^{tree}`]).split("\0").filter(Boolean);
  const filtered = root.filter(entry => entry.slice(entry.indexOf("\t") + 1) !== "VERSION");
  return sha256(filtered.join("\0"));
}

function versionOfTree(repo, treeish) {
  const r = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, "show", `${treeish}:VERSION`], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function isVersionOnlyTreeDiff(repo, fromTree, toTree) {
  const r = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, "diff-tree", "--no-renames", "--name-only", "-r", "-z", fromTree, toTree], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) return false;
  const changed = r.stdout.split("\0").filter(Boolean);
  return changed.length === 1 && changed[0] === "VERSION";
}

function isVersionOnlyReuseValid(repo, run, full, targetTree, targetCodeTree) {
  if (!run?.tree || run.tree === targetTree) return null;
  const targetVersion = versionOfTree(repo, targetTree);
  if (!parseVersion(targetVersion)) return null;
  let storedCodeTree;
  try { storedCodeTree = codeTreeOf(repo, run.tree); } catch { return null; }
  if (storedCodeTree !== targetCodeTree) return null;
  if (!isVersionOnlyTreeDiff(repo, run.tree, targetTree)) return null;
  if (typeof run.sha === "string" && /^[0-9a-f]{40}$/.test(run.sha) && run.sha !== full) {
    const isAnc = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, "merge-base", "--is-ancestor", run.sha, full], { stdio: "ignore" }).status === 0;
    if (isAnc && tipProblem(repo, run.sha, full) !== null) return null;
  }
  return targetVersion;
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

// R-0008-judge-frame, design/round9-b.md#runtime
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

const CODE_TREE_DIR = ".code-tree";
const normInstall = value => (value ? String(value) : null);
const keyText = key => JSON.stringify([key.repository, key.tree, key.command, key.install ?? null, key.execution ?? null, [key.runtime?.node ?? null, key.runtime?.platform ?? null, key.runtime?.arch ?? null]]);
const codeKeyText = key => JSON.stringify([key.repository, key.codeTree, key.command, key.install ?? null, key.execution ?? null, [key.runtime?.node ?? null, key.runtime?.platform ?? null, key.runtime?.arch ?? null]]);
const keyHashOf = key => sha256(keyText(key));
const codeKeyHashOf = key => sha256(codeKeyText(key));

function storedGreen(dir, key, format) {
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter(n => /^[\w.-]+\.json$/.test(n)).sort().reverse()) {
    try {
      const path = join(dir, name);
      const run = JSON.parse(readFileSync(path, "utf8"));
      if (run.green !== true || !run.key || keyText(run.key) !== keyText(key) || keyText({ ...key, runtime: run.runtime }) !== keyText(key) || run.tree !== key.tree) continue;
      const text = gunzipSync(readFileSync(path.replace(/\.json$/, ".log.gz"))).toString();
      if (sha256(text) !== run.log?.sha256) continue;
      const judged = verdict({ exit: run.exit, output: text, format, installExit: run.installExit });
      if (judged.green) return { path, run, text, judged };
    } catch { continue; }
  }
  return null;
}

function storedGreenByCodeTree(storeDir, codeKey, repo, full, targetTree, format) {
  const refDir = join(storeDir, CODE_TREE_DIR, codeKeyHashOf(codeKey));
  if (!existsSync(refDir)) return null;
  for (const name of readdirSync(refDir).filter(n => /^[\w.-]+\.json$/.test(n)).sort().reverse()) {
    try {
      const ref = JSON.parse(readFileSync(join(refDir, name), "utf8"));
      const path = ref?.receiptPath;
      if (!path || !existsSync(path)) continue;
      const run = JSON.parse(readFileSync(path, "utf8"));
      if (run.green !== true || !run.key || run.codeTree !== codeKey.codeTree) continue;
      const storedCodeKey = { ...run.key, codeTree: run.codeTree };
      if (codeKeyText(storedCodeKey) !== codeKeyText(codeKey) || codeKeyText({ ...codeKey, runtime: run.runtime }) !== codeKeyText(codeKey)) continue;
      const targetVersion = isVersionOnlyReuseValid(repo, run, full, targetTree, codeKey.codeTree);
      if (!targetVersion) continue;
      const text = gunzipSync(readFileSync(path.replace(/\.json$/, ".log.gz"))).toString();
      if (sha256(text) !== run.log?.sha256) continue;
      const judged = verdict({ exit: run.exit, output: text, format, installExit: run.installExit });
      if (judged.green) return { path, run, text, judged, targetVersion };
    } catch { continue; }
  }
  return null;
}

function store(dir, run, text, storeDir = null, codeKey = null) {
  mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
  writeFileSync(join(dir, `${id}.log.gz`), gzipSync(text));
  const temp = join(dir, `.${id}.tmp`);
  const receiptPath = join(dir, `${id}.json`);
  writeFileSync(temp, `${JSON.stringify(run, null, 1)}\n`);
  renameSync(temp, receiptPath);
  if (storeDir && codeKey && run.codeTree) {
    try {
      const refDir = join(storeDir, CODE_TREE_DIR, codeKeyHashOf(codeKey));
      mkdirSync(refDir, { recursive: true });
      const refTmp = join(refDir, `.${id}.tmp`);
      writeFileSync(refTmp, `${JSON.stringify({ receiptPath, tree: run.tree, codeTree: run.codeTree, sha: run.sha })}\n`);
      renameSync(refTmp, join(refDir, `${id}.json`));
    } catch {}
  }
  return receiptPath;
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

const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const LOCK_POLL_MS = 40, CLAIM_RE = /^g(\d+)\.claim$/;
const tryJson = raw => { try { return JSON.parse(raw); } catch { return null; } };
const validPid = p => (p && Number.isInteger(p.pid) && p.pid > 0 ? p.pid : null);
const isPidAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; }
};
const clearDeadLockfile = (storeDir, keyHash) => {
  const lockPath = join(storeDir, `${keyHash}.lock`);
  try { const pid = validPid(tryJson(readFileSync(lockPath, "utf8"))); if (pid === null || !isPidAlive(pid)) rmSync(lockPath, { force: true }); }
  catch (e) { if (e?.code !== "ENOENT") throw e; }
};
const isClaimAlive = (genDir, gen) => {
  const path = join(genDir, `g${gen}.claim`);
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return false; throw e; }
  const claim = tryJson(raw), pid = validPid(claim);
  if (pid === null || (claim.gen !== undefined && claim.gen !== gen)) throw new Error(`invalid suite claim ${path}`);
  return isPidAlive(pid);
};
const writeDone = (genDir, gen, token, payload) => {
  mkdirSync(genDir, { recursive: true });
  const path = join(genDir, `g${gen}.done.json`), temp = join(genDir, `.g${gen}.${token}.${process.pid}.tmp`);
  try { writeFileSync(temp, `${JSON.stringify(payload, null, 1)}\n`); renameSync(temp, path); return path; }
  catch (e) { rmSync(temp, { force: true }); throw e; }
};

function readDone(genDir, gen, keyHash, format) {
  const path = join(genDir, `g${gen}.done.json`);
  let raw;
  try { raw = readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return null; throw e; }
  const p = tryJson(raw);
  if (p?.gen !== gen || p?.key !== keyHash) return null;
  if (p.aborted === true) return { aborted: true, path };
  if (!p.receipt || typeof p.green !== "boolean" || typeof p.text !== "string") return null;
  const v = p.format && p.format !== format
    ? verdict({ exit: p.receipt.exit, output: p.text, format, installExit: p.installExit ?? 0 })
    : { green: p.green, summary: p.receipt.summary, reasons: p.receipt.reasons };
  return { aborted: false, path, receipt: p.receipt, receiptPath: p.receiptPath ?? null, text: p.text, v, raw: p };
}

const maxGenOf = genDir => {
  try { return readdirSync(genDir).reduce((m, n) => { const x = CLAIM_RE.exec(n); return x ? Math.max(m, Number(x[1])) : m; }, 0); }
  catch (e) { if (e?.code === "ENOENT") return 0; throw e; }
};
function tryClaim(genDir, gen, token) {
  const claimPath = join(genDir, `g${gen}.claim`), tmp = join(genDir, `.claim-${process.pid}-${token}.tmp`);
  const payload = `${JSON.stringify({ pid: process.pid, gen, token, startedAt: new Date().toISOString() })}\n`;
  try {
    try { writeFileSync(tmp, payload, { flag: "wx" }); }
    catch (e) { if (e?.code === "ENOENT") { mkdirSync(genDir, { recursive: true }); return null; } throw e; }
    try { linkSync(tmp, claimPath); return true; }
    catch (e) {
      if (e?.code === "EEXIST") return false;
      if (e?.code === "ENOENT") { mkdirSync(genDir, { recursive: true }); return null; }
      throw e;
    }
  } finally { try { rmSync(tmp, { force: true }); } catch {} }
}

function acquireOrJoin(storeDir, tree, keyHash, timeoutMs, format, lookupGreen) {
  const genDir = join(storeDir, ".gen", `${tree}-${keyHash}`), token = randomBytes(8).toString("hex");
  const deadline = Date.now() + Math.max(10_000, timeoutMs);
  mkdirSync(genDir, { recursive: true });
  let enrolledGen = null;
  const resolveDone = d => { const h = d.v.green ? lookupGreen() : null; return h ? { mode: "hit", hit: h } : { mode: "resolved", done: d }; };
  const claimOrEnroll = (gen, prevGen = 0) => {
    const claimed = tryClaim(genDir, gen, token);
    if (claimed === null) return null;
    if (!claimed) { enrolledGen = gen; return null; }
    if (prevGen > 0) {
      const raced = readDone(genDir, prevGen, keyHash, format);
      if (raced && !raced.aborted) {
        try { writeDone(genDir, gen, token, { ...raced.raw, gen, token, key: keyHash, finishedAt: new Date().toISOString() }); } catch {}
        return resolveDone(raced);
      }
    }
    clearDeadLockfile(storeDir, keyHash);
    const isCurrent = () => maxGenOf(genDir) === gen;
    const assertCurrent = phase => { const cur = maxGenOf(genDir); if (cur !== gen) throw new Error(`suite generation g${gen} fenced before ${phase} (current g${cur}) in ${genDir}`); };
    return { mode: "leader", gen, token, isCurrent, assertCurrent, finish: p => writeDone(genDir, gen, token, { gen, token, key: keyHash, ...p, finishedAt: new Date().toISOString() }) };
  };
  for (;;) {
    if (enrolledGen !== null) {
      const done = readDone(genDir, enrolledGen, keyHash, format);
      if (done && !done.aborted) return resolveDone(done);
      if (!done) {
        if (isClaimAlive(genDir, enrolledGen)) {
          if (Date.now() >= deadline) throw new Error(`timed out waiting for suite generation g${enrolledGen} in ${genDir}`);
          Atomics.wait(SLEEP_BUF, 0, 0, LOCK_POLL_MS);
          continue;
        }
        const after = readDone(genDir, enrolledGen, keyHash, format);
        if (after && !after.aborted) return resolveDone(after);
      }
      const next = claimOrEnroll(enrolledGen + 1, enrolledGen);
      if (next) return next;
      continue;
    }
    const hit = lookupGreen();
    if (hit) return { mode: "hit", hit };
    const maxGen = maxGenOf(genDir);
    if (maxGen > 0) {
      const done = readDone(genDir, maxGen, keyHash, format);
      if (!done) { enrolledGen = maxGen; continue; }
      if (!done.aborted && done.v.green) { const h = lookupGreen(); if (h) return { mode: "hit", hit: h }; }
    }
    const next = claimOrEnroll(maxGen + 1);
    if (next) return next;
  }
}

export function suiteGreen({ repo, sha, command, install = null, format = "auto", timeoutMin = 60, varyVersion = null }) {
  repo = resolve(repo);
  install = normInstall(install);
  const full = fullSha(repo, sha);
  if (varyVersion !== null) {
    const parsed = parseVersion(varyVersion);
    if (!parsed) throw new UsageError(`--vary-version "${varyVersion}" is not ${FORMS}`);
    varyVersion = parsed.text;
  }
  const tested = testedCommit(repo, full, varyVersion);
  const codeTree = codeTreeOf(repo, tested.tree);
  const storeDir = suiteStore(repo), execution = executionOf(command, install), runtime = execution?.runtime ?? null;
  const key = { repository: dirname(storeDir), tree: tested.tree, command, install, runtime, execution: execution?.digest ?? null };
  const codeKey = { repository: dirname(storeDir), codeTree, command, install, runtime, execution: execution?.digest ?? null };
  const keyHash = keyHashOf(key), dir = join(storeDir, keyHash), varied = varyVersion === null ? {} : { versionVaried: varyVersion };
  const base = { repository: repo, sha: full, tree: tested.tree, codeTree, ...varied, command, install, runtime };
  const reuseHit = h => ({ ...base, ...(h.targetVersion ? { versionVaried: h.targetVersion } : {}), exit: h.run.exit, summary: h.judged.summary, durationMs: h.run.durationMs, green: true, reasons: [], log: h.run.log, reusedFrom: h.path, text: h.text });
  const fromDone = d => ({ ...base, exit: d.receipt.exit, summary: d.v.summary, durationMs: d.receipt.durationMs, green: d.v.green, reasons: d.v.reasons, log: d.receipt.log, ...(d.v.green ? {} : { reused: true }), reusedFrom: d.v.green ? (d.receiptPath || d.path) : d.path, text: d.text });
  const lookupGreen = () => {
    if (!execution) return null;
    const exact = storedGreen(dir, key, format);
    if (exact) return exact;
    if (varyVersion !== null) return null;
    return storedGreenByCodeTree(storeDir, codeKey, repo, full, tested.tree, format);
  };
  const hit = lookupGreen();
  if (hit) return reuseHit(hit);
  const slot = execution ? acquireOrJoin(storeDir, tested.tree, keyHash, timeoutMin * 60_000, format, lookupGreen) : { mode: "leader", gen: 0, token: null, isCurrent: () => true, assertCurrent: () => {}, finish: null };
  if (slot.mode === "hit") return reuseHit(slot.hit);
  if (slot.mode === "resolved") return fromDone(slot.done);
  let finished = false;
  try {
    const rehit = lookupGreen();
    if (rehit) {
      if (slot.finish && slot.isCurrent()) try { slot.finish({ green: true, receipt: rehit.run, receiptPath: rehit.path, text: rehit.text, format: rehit.run.format ?? format, installExit: rehit.run.installExit ?? 0 }); } catch {}
      finished = true;
      return reuseHit(rehit);
    }
    slot.assertCurrent("execution");
    const started = Date.now(), release = holdLease(repo, full);
    let ran;
    try { ran = runIn(repo, tested.commit, { command, install, timeoutMin, execution }); } finally { release(); }
    const v = verdict({ exit: ran.exit, output: ran.log, format, installExit: ran.installExit });
    const receipt = { ...base, exit: ran.exit, summary: v.summary, durationMs: Date.now() - started, green: v.green, reasons: v.reasons, log: { sha256: sha256(ran.log), bytes: Buffer.byteLength(ran.log) } };
    slot.assertCurrent("publication");
    let receiptPath = null;
    if (v.green) try { receiptPath = store(dir, { ...receipt, key, format, installExit: ran.installExit }, ran.log, storeDir, execution ? codeKey : null); } catch (e) { console.error(`suite-green: the receipt of ${full.slice(0, 7)} was not stored for reuse (${e.message})`); }
    if (receiptPath) try { pruneSuiteStore(repo); } catch {}
    if (slot.finish) try { slot.finish({ green: v.green, receipt, receiptPath, text: ran.log, format, installExit: ran.installExit }); } catch (e) { console.error(`suite-green: generation g${slot.gen} of ${full.slice(0, 7)} was not recorded (${e.message})`); }
    finished = true;
    return { ...receipt, text: ran.log };
  } finally { if (!finished && slot.finish && slot.isCurrent()) try { slot.finish({ aborted: true }); } catch {} }
}

// D-0061, D-0064, design/suite-once.md#1
export function lookupSuiteReceipt({ repo, sha, command, install = "", runtime = null, format = "auto" }) {
  repo = resolve(repo);
  const norm = normInstall(install), full = fullSha(repo, sha), tree = git(repo, ["rev-parse", `${full}^{tree}`]), execution = executionOf(command, norm);
  if (!execution) return null;
  const codeTree = codeTreeOf(repo, tree);
  const effectiveRuntime = runtime ?? execution.runtime, storeDir = suiteStore(repo);
  const key = { repository: dirname(storeDir), tree, command, install: norm, runtime: effectiveRuntime, execution: execution.digest };
  const exact = storedGreen(join(storeDir, keyHashOf(key)), key, format);
  const codeKey = { repository: dirname(storeDir), codeTree, command, install: norm, runtime: effectiveRuntime, execution: execution.digest };
  const hit = exact ?? storedGreenByCodeTree(storeDir, codeKey, repo, full, tree, format);
  if (!hit) return null;
  const receipt = {
    repository: repo, sha: full, tree, codeTree,
    ...(hit.targetVersion ? { versionVaried: hit.targetVersion } : {}),
    command, install: norm, runtime: effectiveRuntime,
    exit: hit.run.exit, summary: hit.judged.summary, durationMs: hit.run.durationMs,
    green: true, reasons: [], log: hit.run.log, reusedFrom: hit.path,
  };
  return { receipt, receiptPath: hit.path, logPath: hit.path.replace(/\.json$/, ".log.gz") };
}

export function purgeTreeReceipts(repo, tree) {
  const storeDir = suiteStore(resolve(repo));
  if (!existsSync(storeDir)) return { purged: 0 };
  let purged = 0;
  for (const sub of readdirSync(storeDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = join(storeDir, sub.name);
    if (sub.name === ".gen") { for (const e of readdirSync(subDir)) if (e.startsWith(`${tree}-`)) rmSync(join(subDir, e), { recursive: true, force: true }); continue; }
    if (sub.name === CODE_TREE_DIR) {
      for (const bucket of readdirSync(subDir, { withFileTypes: true })) {
        if (!bucket.isDirectory()) continue;
        const bucketDir = join(subDir, bucket.name);
        for (const entry of readdirSync(bucketDir).filter(n => n.endsWith(".json"))) {
          const refPath = join(bucketDir, entry), ref = tryJson(readFileSync(refPath, "utf8"));
          if (!ref || ref.tree === tree) rmSync(refPath, { force: true });
        }
        if (readdirSync(bucketDir).length === 0) rmSync(bucketDir, { recursive: true, force: true });
      }
      continue;
    }
    for (const entry of readdirSync(subDir).filter(n => n.endsWith(".json"))) {
      const jsonPath = join(subDir, entry), run = tryJson(readFileSync(jsonPath, "utf8"));
      if (!run || (run.tree !== tree && run.key?.tree !== tree)) continue;
      rmSync(jsonPath, { force: true }); rmSync(jsonPath.replace(/\.json$/, ".log.gz"), { force: true });
      purged++;
    }
    if (readdirSync(subDir).length === 0) rmSync(subDir, { recursive: true, force: true });
  }
  return { purged };
}

const writeEvidence = (prefix, receipt, gzBuf) => { mkdirSync(dirname(resolve(prefix)), { recursive: true }); writeFileSync(`${prefix}.log.gz`, gzBuf); writeFileSync(`${prefix}.json`, `${JSON.stringify(receipt, null, 1)}\n`); };
const writeReadOnly = (path, data) => { rmSync(path, { force: true }); writeFileSync(path, data); chmodSync(path, 0o444); };

export function stageSuiteWorkspace({ repo, sha, command, install = "", ws, mode = "lookup", format = "auto", outPrefix = null }) {
  if (!["lookup", "ensure"].includes(mode)) throw new UsageError(`mode must be lookup or ensure (got ${mode})`);
  const norm = normInstall(install), wsDir = resolve(ws), stagedPath = join(wsDir, "suite-receipt.json"), stagedLog = join(wsDir, "suite.log.gz");
  const stageGreen = (receipt, gz, reused) => { mkdirSync(wsDir, { recursive: true }); writeReadOnly(stagedPath, `${JSON.stringify(receipt, null, 1)}\n`); writeReadOnly(stagedLog, gz); return { ok: true, reused, receipt, stagedPath }; };
  const hit = lookupSuiteReceipt({ repo, sha, command, install: norm, format });
  if (hit) { const gz = readFileSync(hit.logPath); if (outPrefix) writeEvidence(outPrefix, hit.receipt, gz); return stageGreen(hit.receipt, gz, true); }
  if (mode === "lookup") return { ok: true, reused: false, receipt: null, stagedPath: null };
  const { text, ...receipt } = suiteGreen({ repo, sha, command, install: norm, format }), gz = gzipSync(text);
  if (outPrefix) writeEvidence(outPrefix, receipt, gz);
  if (!receipt.green) { rmSync(stagedPath, { force: true }); rmSync(stagedLog, { force: true }); return { ok: false, reused: Boolean(receipt.reusedFrom), receipt, reasons: receipt.reasons }; }
  return stageGreen(receipt, gz, Boolean(receipt.reusedFrom));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli(() => {
  const args = parseArgs(process.argv.slice(2));
  need(args, "repo", "sha", "command");
  const format = args.format || "auto";
  if (!["auto", "node-test"].includes(format)) throw new UsageError("--format must be auto or node-test");
  if (args.out && (existsSync(`${args.out}.json`) || existsSync(`${args.out}.log.gz`))) throw new UsageError(`${args.out}.json or .log.gz exists; evidence is never overwritten`);
  if ("vary-version" in args) need(args, "vary-version");
  let receipt;
  try { receipt = suiteGreen({ repo: args.repo, sha: args.sha, command: args.command, install: args.install || null, format, timeoutMin: Number(args["timeout-min"] || 60), varyVersion: args["vary-version"] ?? null }); }
  catch (e) { throw e instanceof UsageError ? e : new UsageError(e.message); }
  const { text, ...shown } = receipt;
  if (shown.reusedFrom) console.error(`reused ${shown.reusedFrom}`);
  if (args.out) writeEvidence(args.out, shown, gzipSync(text));
  console.log(JSON.stringify(shown, null, 2));
  return receipt.green ? 0 : 2;
});
