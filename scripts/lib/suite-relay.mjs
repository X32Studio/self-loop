// F-0016, P-0016, D-0016, D-0061, D-0064, R-0056-judge-frame-velocity
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { UsageError } from "./args.mjs";
import { ORIGINAL_OBJECTS } from "./ci.mjs";

export const RELAY_DIR = ".relay";

const STORE = "self-loop-suite";
const KEYS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHELL_META_RE = /[|&;<>()$`"'\\!\n\r\t]/;
const TARGET_RE = /^[a-zA-Z0-9_./*-]+$/;
const TEST_FILE_RE = /\.test\.(?:js|mjs|cjs)$/;
const IGNORED_DIR_RE = /(?:^|\/)(?:\.git|node_modules)\//;
const SUMMARY_LINE_RE = /^(?:ℹ|#) (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\b.*$/gm;
const MAX_VERBATIM_EXCERPT = 8192;

const sha256 = text => createHash("sha256").update(text).digest("hex");

function git(repo, argv) {
  const r = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr || `exit ${r.status}`).trim()}`);
  return r.stdout;
}

export function parseSummary(output) {
  const summary = Object.fromEntries(KEYS.map(k => [k, 0]));
  let found = false;
  for (const m of output.matchAll(/^(?:ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) {
    summary[m[1]] += Number(m[2]);
    found = true;
  }
  return found ? summary : null;
}

export function withGitNoMaintenance(env = process.env) {
  const out = { ...env };
  const raw = out.GIT_CONFIG_COUNT, parsed = raw !== undefined && raw !== "" ? Number(raw) : 0;
  let idx = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0, gcAuto = null, maintAuto = null;
  for (let i = 0; i < idx; i++) {
    const k = out[`GIT_CONFIG_KEY_${i}`];
    if (typeof k !== "string") continue;
    const low = k.toLowerCase();
    if (low === "gc.auto") gcAuto = out[`GIT_CONFIG_VALUE_${i}`];
    if (low === "maintenance.auto") maintAuto = out[`GIT_CONFIG_VALUE_${i}`];
  }
  if (gcAuto !== "0") { out[`GIT_CONFIG_KEY_${idx}`] = "gc.auto"; out[`GIT_CONFIG_VALUE_${idx}`] = "0"; idx++; }
  if (maintAuto !== "false") { out[`GIT_CONFIG_KEY_${idx}`] = "maintenance.auto"; out[`GIT_CONFIG_VALUE_${idx}`] = "false"; idx++; }
  out.GIT_CONFIG_COUNT = String(idx);
  return out;
}

const childEnvOf = (env = process.env) => withGitNoMaintenance(
  Object.fromEntries(Object.entries(env).filter(([k]) => k !== "NODE_TEST_CONTEXT" && k !== "SELF_LOOP_RELAY_DIR")),
);
const commonDirOf = repo => realpathSync(git(resolve(repo), ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim());
const isTestFile = relPath => !IGNORED_DIR_RE.test(relPath) && relPath.slice(relPath.lastIndexOf("/") + 1) !== "index.js" && TEST_FILE_RE.test(relPath);

export function relayBaseDir(repo, env = process.env) {
  return env.SELF_LOOP_RELAY_DIR ? resolve(env.SELF_LOOP_RELAY_DIR) : join(commonDirOf(repo), STORE, RELAY_DIR);
}

export function relayRuntimeKey({ repository, command, install = null, executionDigest = null, execution = null, varyVersion = null, runtime = null }) {
  const digest = executionDigest ?? execution?.digest ?? null;
  const rt = [runtime?.node ?? process.versions.node, runtime?.platform ?? process.platform, runtime?.arch ?? process.arch];
  return sha256(JSON.stringify([1, repository, command, install ?? null, digest, varyVersion ?? null, rt]));
}

export function relayStoreRoot(repo, codeTree, runtimeKey, env = process.env) {
  return join(relayBaseDir(repo, env), codeTree, runtimeKey);
}

export function fileCheckpointPath(relayDir, relPath) {
  return join(relayDir, `${sha256(relPath).slice(0, 24)}.json`);
}

function checkpointDigest(cp) {
  return sha256(JSON.stringify([
    cp.version, cp.repository, cp.codeTree, cp.relPath, cp.fileBlobSha, cp.runtimeKey,
    cp.exitCode, cp.signal, cp.summary ? KEYS.map(k => cp.summary[k]) : null, cp.tapExcerpt,
  ]));
}

export function readFileCheckpoint(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

export function writeFileCheckpoint(file, cp) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const record = cp.digest ? cp : { ...cp, digest: checkpointDigest(cp) };
  const tmp = join(dir, `.${process.pid}-${randomUUID()}.tmp`);
  try { writeFileSync(tmp, `${JSON.stringify(record, null, 1)}\n`); renameSync(tmp, file); }
  catch (e) { rmSync(tmp, { force: true }); throw e; }
  return record;
}

export function verifyFileCheckpoint(cp, expected) {
  if (!cp || typeof cp !== "object" || Array.isArray(cp) || !expected || typeof expected !== "object") return false;
  if (cp.version !== 1 || cp.exitCode !== 0 || cp.signal !== null) return false;
  if (cp.repository !== expected.repository || cp.relPath !== expected.relPath || typeof cp.relPath !== "string" || !cp.relPath) return false;
  if (!HEX64.test(cp.codeTree ?? "") || cp.codeTree !== expected.codeTree) return false;
  if (!HEX40.test(cp.fileBlobSha ?? "") || cp.fileBlobSha !== expected.fileBlobSha) return false;
  if (!HEX64.test(cp.runtimeKey ?? "") || cp.runtimeKey !== expected.runtimeKey) return false;
  const s = cp.summary;
  if (!s || typeof s !== "object" || KEYS.some(k => !Number.isInteger(s[k]) || s[k] < 0)) return false;
  if (s.tests < 1 || s.fail !== 0 || s.cancelled !== 0 || s.pass + s.skipped + s.todo !== s.tests) return false;
  if (typeof cp.tapExcerpt !== "string" || !cp.tapExcerpt.trim()) return false;
  const parsed = parseSummary(cp.tapExcerpt);
  if (!parsed || KEYS.some(k => parsed[k] !== s[k])) return false;
  return typeof cp.digest === "string" && HEX64.test(cp.digest) && cp.digest === checkpointDigest(cp);
}

function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      if (pattern[i + 2] === "/") { out += "(?:.+/)?"; i += 2; }
      else { out += ".*"; i += 1; }
    } else if (pattern[i] === "*") out += "[^/]*";
    else out += pattern[i].replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

export function discoverSuiteFiles(repo, tree, command) {
  if (typeof command !== "string" || !command.trim() || SHELL_META_RE.test(command)) return null;
  const tokens = command.trim().split(/ +/);
  if (tokens.length < 2 || tokens[0] !== "node" || tokens[1] !== "--test") return null;
  const targets = tokens.slice(2);
  if (targets.some(t => !t || t.startsWith("-") || t.startsWith("/") || t.includes("..") || !TARGET_RE.test(t))) return null;
  const blobs = [], byPath = new Map();
  for (const entry of git(resolve(repo), ["ls-tree", "-r", "-z", tree]).split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [mode, type, blobSha] = entry.slice(0, tab).split(" "), relPath = entry.slice(tab + 1);
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
    blobs.push({ relPath, fileBlobSha: blobSha });
    byPath.set(relPath, blobSha);
  }
  const matched = new Map();
  if (targets.length === 0) {
    for (const b of blobs) if (isTestFile(b.relPath)) matched.set(b.relPath, b.fileBlobSha);
  } else {
    for (const rawTarget of targets) {
      const norm = rawTarget.replace(/^\.\//, "").replace(/\/+$/, "");
      let hits = 0;
      if (norm === "" || norm === ".") {
        for (const b of blobs) if (isTestFile(b.relPath)) { matched.set(b.relPath, b.fileBlobSha); hits++; }
      } else if (norm.includes("*")) {
        const re = globToRegExp(norm);
        for (const b of blobs) if (re.test(b.relPath) && isTestFile(b.relPath)) { matched.set(b.relPath, b.fileBlobSha); hits++; }
      } else if (byPath.has(norm)) {
        if (!isTestFile(norm)) return null;
        matched.set(norm, byPath.get(norm));
        hits = 1;
      } else {
        const prefix = `${norm}/`;
        for (const b of blobs) if (b.relPath.startsWith(prefix) && isTestFile(b.relPath)) { matched.set(b.relPath, b.fileBlobSha); hits++; }
      }
      if (hits === 0) return null;
    }
  }
  if (matched.size === 0) return null;
  return [...matched.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([relPath, fileBlobSha]) => ({ relPath, fileBlobSha }));
}

function deriveCodeTree(repo, tree) {
  try {
    const entries = git(resolve(repo), ["ls-tree", "-z", `${tree}^{tree}`]).split("\0").filter(Boolean);
    return sha256(entries.filter(e => e.slice(e.indexOf("\t") + 1) !== "VERSION").join("\0"));
  } catch { return null; }
}

export function purgeRelayForTree(repo, tree, codeTree = null, env = process.env) {
  const bases = new Set();
  try { bases.add(join(commonDirOf(repo), STORE, RELAY_DIR)); } catch {}
  if (env.SELF_LOOP_RELAY_DIR) bases.add(resolve(env.SELF_LOOP_RELAY_DIR));
  const ids = new Set([tree, codeTree ?? deriveCodeTree(repo, tree)].filter(Boolean));
  let purged = 0;
  for (const base of bases) {
    if (!existsSync(base)) continue;
    for (const id of ids) {
      const target = join(base, id);
      if (!existsSync(target)) continue;
      rmSync(target, { recursive: true, force: true });
      purged++;
    }
  }
  return { purged };
}

function finalizeFileResult(item, meta, exitCode, signal, output) {
  if (exitCode === 0 && signal === null) {
    const summary = parseSummary(output);
    const trimmed = output.trimEnd();
    const tapExcerpt = trimmed.length <= MAX_VERBATIM_EXCERPT ? trimmed : (trimmed.match(SUMMARY_LINE_RE)?.join("\n") ?? "");
    if (summary && tapExcerpt.trim()) {
      const cp = { version: 1, ...meta, relPath: item.relPath, fileBlobSha: item.fileBlobSha, exitCode: 0, signal: null, summary, tapExcerpt };
      cp.digest = checkpointDigest(cp);
      if (verifyFileCheckpoint(cp, { ...meta, relPath: item.relPath, fileBlobSha: item.fileBlobSha })) {
        writeFileCheckpoint(item.cpPath, cp);
        return { relPath: item.relPath, passed: true, cp };
      }
    }
  }
  rmSync(item.cpPath, { force: true });
  return { relPath: item.relPath, passed: false, exitCode: exitCode !== 0 ? exitCode : 1, signal, output };
}

function runOneSync(executable, wt, item, meta, env, timeoutMs) {
  const r = spawnSync(executable, ["--test", item.relPath], { cwd: wt, env, encoding: "utf8", maxBuffer: 1 << 30, timeout: timeoutMs });
  return finalizeFileResult(item, meta, r.status ?? -1, r.signal ?? null, `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`);
}

async function runPoolAsync({ executable, wt, pending, meta, env, concurrency, timeoutMs }) {
  const deadline = Date.now() + timeoutMs, results = new Array(pending.length);
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const idx = cursor++, item = pending[idx], remaining = Math.max(1000, deadline - Date.now());
      results[idx] = await new Promise(done => {
        const child = spawn(executable, ["--test", item.relPath], { cwd: wt, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = "", timedOut = false;
        const timer = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, remaining);
        child.stdout.on("data", d => { out += d; });
        child.stderr.on("data", d => { out += d; });
        child.on("error", err => { clearTimeout(timer); done(finalizeFileResult(item, meta, 1, null, `${out}\n${err.message}`)); });
        child.on("close", (code, sig) => {
          clearTimeout(timer);
          done(finalizeFileResult(item, meta, timedOut ? -1 : (code ?? -1), timedOut ? "SIGKILL" : (sig ?? null), timedOut ? `${out}\nrelay file timed out` : out));
        });
      });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, () => worker()));
  return results;
}

export function runSuiteWithRelay(opts) {
  const { commit, command, install = null, format = "auto", timeoutMin = 60, execution = null, varyVersion = null, noRelay = false, concurrency = null, env = process.env } = opts;
  if (format !== "node-test" || noRelay || env.SELF_LOOP_NO_RELAY === "1" || !execution) return null;
  const repo = resolve(opts.repo), tree = opts.tree ?? git(repo, ["rev-parse", `${commit}^{tree}`]).trim();
  const files = discoverSuiteFiles(repo, tree, command);
  if (!files || files.length === 0) return null;
  const codeTree = opts.codeTree ?? deriveCodeTree(repo, tree), repository = opts.repository ?? commonDirOf(repo);
  const runtimeKey = relayRuntimeKey({ repository, command, install, executionDigest: execution.digest, varyVersion });
  const relayDir = relayStoreRoot(repo, codeTree, runtimeKey, env), meta = { repository, codeTree, runtimeKey };
  const checkpoints = new Map(), relayedSet = new Set(), pending = [], failed = [];
  for (const { relPath, fileBlobSha } of files) {
    const cpPath = fileCheckpointPath(relayDir, relPath), cp = readFileCheckpoint(cpPath);
    if (verifyFileCheckpoint(cp, { ...meta, relPath, fileBlobSha })) { checkpoints.set(relPath, cp); relayedSet.add(relPath); }
    else pending.push({ relPath, fileBlobSha, cpPath });
  }
  if (pending.length > 0) {
    const dir = mkdtempSync(join(tmpdir(), "suite-relay-")), wt = join(dir, "wt");
    try {
      const add = spawnSync("git", ["-C", repo, ORIGINAL_OBJECTS, "worktree", "add", "-q", "--detach", wt, commit], { encoding: "utf8" });
      if (add.status !== 0) throw new UsageError(`git worktree add failed: ${add.stderr}`);
      const cEnv = childEnvOf(env), timeoutMs = timeoutMin * 60_000;
      const defaultConc = Math.max(1, Math.min(availableParallelism() - 1, 8));
      const workers = Math.max(1, Math.min(Number.isInteger(concurrency) && concurrency > 0 ? concurrency : defaultConc, pending.length));
      let results;
      if (workers === 1 || pending.length === 1) {
        results = pending.map(item => runOneSync(execution.executable, wt, item, meta, cEnv, timeoutMs));
      } else {
        const w = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--relay-worker"], {
          input: JSON.stringify({ executable: execution.executable, wt, pending, meta, env: cEnv, concurrency: workers, timeoutMs }),
          encoding: "utf8", maxBuffer: 1 << 30, timeout: timeoutMs + 5000,
        });
        if (w.status !== 0) throw new Error(`suite-relay worker failed: ${(w.stderr || `exit ${w.status}`).trim()}`);
        results = JSON.parse(w.stdout);
      }
      const blobByPath = new Map(pending.map(p => [p.relPath, p.fileBlobSha]));
      for (const res of results) {
        if (res.passed && verifyFileCheckpoint(res.cp, { ...meta, relPath: res.relPath, fileBlobSha: blobByPath.get(res.relPath) })) checkpoints.set(res.relPath, res.cp);
        else failed.push(res);
      }
    } finally {
      spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const relay = { enabled: true, totalFiles: files.length, relayedCount: relayedSet.size, executedCount: pending.length };
  const chunks = [`$ ${command}`];
  for (const { relPath } of files) {
    const cp = checkpoints.get(relPath);
    if (cp) { chunks.push(`# relay ${relPath} (${relayedSet.has(relPath) ? "relayed" : "executed"})`); chunks.push(cp.tapExcerpt.trimEnd()); }
  }
  if (failed.length === 0 && checkpoints.size === files.length) {
    chunks.push("exit 0", "");
    return { log: chunks.join("\n"), exit: 0, installExit: 0, relayDir, relay };
  }
  for (const f of failed) { chunks.push(`# relay failed ${f.relPath} (exit ${f.exitCode})`); if (f.output) chunks.push(f.output.trimEnd()); }
  const exit = failed[0]?.exitCode || 1;
  chunks.push(`exit ${exit}`, "");
  return { log: chunks.join("\n"), exit, installExit: 0, relayDir, failedFiles: failed.map(f => f.relPath), relay };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--relay-worker") {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  runPoolAsync(payload).then(
    results => process.stdout.write(JSON.stringify(results)),
    err => { console.error(err?.stack ?? String(err)); process.exit(1); },
  );
}
