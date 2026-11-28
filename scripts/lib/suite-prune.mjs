// F-0015, P-0014, D-0016, D-0061, D-0064, D-0069, R-0055-judge-frame-hygiene
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const STORE = "self-loop-suite";
const CODE_TREE_DIR = ".code-tree";
const GEN_DIR = ".gen";
const RELAY_DIR = ".relay";
const CLAIM_RE = /^g(\d+)\.claim$/;
const DONE_RE = /^g(\d+)\.done\.json$/;
const DEAD_CLAIM_MAX_AGE_MS = 3600_000;
const DONE_GEN_MAX_AGE_MS = 24 * 3600_000;

const tryJson = raw => { try { return JSON.parse(raw); } catch { return null; } };
const sha256 = text => createHash("sha256").update(text).digest("hex");

function gitTry(repo, argv) {
  const r = spawnSync("git", ["-C", repo, "--no-replace-objects", ...argv], { encoding: "utf8", maxBuffer: 1 << 26 });
  return r.status === 0 ? r.stdout.trim() : null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e?.code === "EPERM"; }
}

function treeBytes(target) {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  try { for (const name of readdirSync(target)) total += treeBytes(join(target, name)); } catch {}
  return total;
}

function collectPinnedTrees(repo, extra) {
  const pinned = new Set();
  if (extra) for (const t of extra) if (typeof t === "string" && t) pinned.add(t);
  const refs = ["HEAD", "refs/heads/main", "refs/heads/master"];
  const loopRefs = gitTry(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/loop/"]);
  if (loopRefs) refs.push(...loopRefs.split("\n").filter(Boolean));
  for (const ref of refs) {
    const tree = gitTry(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{tree}`]);
    if (!tree) continue;
    pinned.add(tree);
    const listed = gitTry(repo, ["ls-tree", "-z", tree]);
    if (listed !== null) {
      const filtered = listed.split("\0").filter(Boolean).filter(e => e.slice(e.indexOf("\t") + 1) !== "VERSION");
      pinned.add(sha256(filtered.join("\0")));
    }
  }
  return pinned;
}

function shouldRemoveGenDir(genDir, nowMs) {
  let names;
  try { names = readdirSync(genDir); } catch { return false; }
  let maxClaim = 0, maxDone = 0;
  for (const n of names) {
    const c = CLAIM_RE.exec(n);
    if (c) maxClaim = Math.max(maxClaim, Number(c[1]));
    const d = DONE_RE.exec(n);
    if (d) maxDone = Math.max(maxDone, Number(d[1]));
  }
  if (maxClaim > 0 && isPidAlive(tryJson(readFileSync(join(genDir, `g${maxClaim}.claim`), "utf8"))?.pid)) return false;
  if (maxDone > 0 && maxDone >= maxClaim) {
    const st = lstatSync(join(genDir, `g${maxDone}.done.json`), { throwIfNoEntry: false });
    return Boolean(st && nowMs - st.mtimeMs > DONE_GEN_MAX_AGE_MS);
  }
  const st = lstatSync(maxClaim > 0 ? join(genDir, `g${maxClaim}.claim`) : genDir, { throwIfNoEntry: false });
  return Boolean(st && nowMs - st.mtimeMs > DEAD_CLAIM_MAX_AGE_MS);
}

function treeLatestMtimeMs(target) {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return 0;
  let latest = st.mtimeMs;
  if (!st.isDirectory()) return latest;
  try { for (const name of readdirSync(target)) latest = Math.max(latest, treeLatestMtimeMs(join(target, name))); } catch {}
  return latest;
}

export function pruneSuiteStore(
  productRepo,
  {
    maxReceipts = 32, maxBytes = 50 * 1024 * 1024, maxAgeMs = 14 * 86400_000,
    maxRelayTrees = 16, maxRelayBytes = 32 * 1024 * 1024, maxRelayAgeMs = 14 * 86400_000,
    pinnedTrees = null, apply = true, now = () => Date.now(),
  } = {},
) {
  const repo = resolve(productRepo);
  const common = gitTry(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return { removed: [], bytesFreed: 0 };
  const storeDir = join(realpathSync(common), STORE);
  if (!existsSync(storeDir)) return { removed: [], bytesFreed: 0 };

  const pinned = collectPinnedTrees(repo, pinnedTrees);
  const nowMs = now(), pinnedItems = [], unpinnedItems = [], removed = [], removedSet = new Set();
  let bytesFreed = 0;

  for (const sub of readdirSync(storeDir, { withFileTypes: true })) {
    if (!sub.isDirectory() || sub.name === GEN_DIR || sub.name === CODE_TREE_DIR || sub.name === RELAY_DIR || sub.name.startsWith(".")) continue;
    const subDir = join(storeDir, sub.name);
    for (const name of readdirSync(subDir).filter(n => n.endsWith(".json"))) {
      const jsonPath = join(subDir, name), logPath = jsonPath.replace(/\.json$/, ".log.gz");
      const jStat = lstatSync(jsonPath, { throwIfNoEntry: false });
      if (!jStat?.isFile()) continue;
      const lStat = lstatSync(logPath, { throwIfNoEntry: false });
      const run = tryJson(readFileSync(jsonPath, "utf8"));
      const tree = run?.tree ?? run?.key?.tree ?? null, codeTree = run?.codeTree ?? null;
      const item = { jsonPath, logPath: lStat?.isFile() ? logPath : null, subDir, mtimeMs: jStat.mtimeMs, bytes: jStat.size + (lStat?.isFile() ? lStat.size : 0) };
      if ((tree && pinned.has(tree)) || (codeTree && pinned.has(codeTree))) pinnedItems.push(item);
      else unpinnedItems.push(item);
    }
  }

  unpinnedItems.sort((a, b) => b.mtimeMs - a.mtimeMs || b.jsonPath.localeCompare(a.jsonPath));
  let keptUnpinned = 0, keptBytes = pinnedItems.reduce((s, x) => s + x.bytes, 0);
  const touchedDirs = new Set();
  for (const item of unpinnedItems) {
    if (nowMs - item.mtimeMs <= maxAgeMs && keptUnpinned < maxReceipts && keptBytes + item.bytes <= maxBytes) {
      keptUnpinned++;
      keptBytes += item.bytes;
      continue;
    }
    removed.push(item.jsonPath);
    removedSet.add(item.jsonPath);
    if (item.logPath) removed.push(item.logPath);
    bytesFreed += item.bytes;
    touchedDirs.add(item.subDir);
    if (apply) {
      rmSync(item.jsonPath, { force: true });
      if (item.logPath) rmSync(item.logPath, { force: true });
    }
  }
  if (apply) {
    for (const dir of touchedDirs) {
      try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  const codeRoot = join(storeDir, CODE_TREE_DIR);
  if (existsSync(codeRoot)) {
    for (const bucket of readdirSync(codeRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory()) continue;
      const bucketDir = join(codeRoot, bucket.name);
      for (const name of readdirSync(bucketDir).filter(n => n.endsWith(".json"))) {
        const refPath = join(bucketDir, name), target = tryJson(readFileSync(refPath, "utf8"))?.receiptPath;
        if (target && !removedSet.has(target) && existsSync(target)) continue;
        removed.push(refPath);
        bytesFreed += statSync(refPath).size;
        if (apply) rmSync(refPath, { force: true });
      }
      if (apply) try { if (readdirSync(bucketDir).length === 0) rmSync(bucketDir, { recursive: true, force: true }); } catch {}
    }
  }

  const genRoot = join(storeDir, GEN_DIR);
  if (existsSync(genRoot)) {
    for (const sub of readdirSync(genRoot, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const genDir = join(genRoot, sub.name);
      if (!shouldRemoveGenDir(genDir, nowMs)) continue;
      bytesFreed += treeBytes(genDir);
      removed.push(genDir);
      if (apply) rmSync(genDir, { recursive: true, force: true });
    }
  }

  const relayRoot = join(storeDir, RELAY_DIR);
  if (existsSync(relayRoot)) {
    const pinnedRelay = [], unpinnedRelay = [];
    for (const sub of readdirSync(relayRoot, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      const treeDir = join(relayRoot, sub.name);
      const item = { treeDir, bytes: treeBytes(treeDir), mtimeMs: treeLatestMtimeMs(treeDir) };
      if (pinned.has(sub.name)) pinnedRelay.push(item);
      else unpinnedRelay.push(item);
    }
    unpinnedRelay.sort((a, b) => b.mtimeMs - a.mtimeMs || b.treeDir.localeCompare(a.treeDir));
    let keptRelayTrees = 0, keptRelayBytes = pinnedRelay.reduce((s, x) => s + x.bytes, 0);
    for (const item of unpinnedRelay) {
      if (nowMs - item.mtimeMs <= maxRelayAgeMs && keptRelayTrees < maxRelayTrees && keptRelayBytes + item.bytes <= maxRelayBytes) {
        keptRelayTrees++;
        keptRelayBytes += item.bytes;
        continue;
      }
      removed.push(item.treeDir);
      bytesFreed += item.bytes;
      if (apply) rmSync(item.treeDir, { recursive: true, force: true });
    }
  }
  return { removed, bytesFreed };
}
