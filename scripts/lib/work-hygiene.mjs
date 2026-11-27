// F-0015, P-0014, P-0015, D-0016, D-0064, D-0069, R-0055-judge-frame-hygiene
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const EXCLUDED_DIR_SEGMENT = /^(?:\.git|tmp|temp|scratch|pg_wal|pg_xact|pg_multixact|pg_logical|pg_replslot|pg_snapshots|pg_stat_tmp|pg_subtrans|pg_tblspc|pg_twophase|node_modules|vendor|\.pnpm|\.yarn|\.venv|venv|__pycache__|\.pytest_cache|\.next|\.nuxt|\.turbo|coverage|dist|build|out-tsc)$/;
const CACHE_SEGMENT = /(?:^|[-_.])cache(?:$|[-_.])/i;
const EXCLUDED_FILE_EXT = /\.(?:wal|shm|sqlite|sqlite3|sqlite-wal|sqlite-shm|db|db-wal|db-shm|ldb|sst|pack|idx|o|a|so|dylib|dll|exe|wasm|pyc|pyo|class|jar|tsbuildinfo|d\.ts|map|tar|tgz|gz|zip|7z|zst)$/i;
const PG_WAL_SEGMENT = /^[0-9A-F]{24}$/;
const SOURCE_EXT = /\.(?:h|hpp|c|cc|cpp|cxx|js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|kt|swift)$/i;
const INVALID_PATH_CHAR = /["\x00-\x1f]/;
const CANONICAL_FILES = new Set(["report.md", "public.md", "decisions.json", "comment-resolutions.json"]);
const CANONICAL_PATTERNS = [/^blueprint\/[^/]+\.md$/, /^design\/[^/]+\.md$/];
const RECLAIM_CHILDREN = [
  "records", "purpose", "out", "wt", "suite.log.gz", "suite-receipt.json",
  "arch-facts.json", "ssot-status.md", "brief.md", "brief-shared.md", "task.md", "t3-prompt.md",
];
const RESERVED_WORK_DIRS = new Set(["tasks", ".prepared"]);

const hasInvalidSegment = name => INVALID_PATH_CHAR.test(name) || name !== name.trim();
const isCanonicalOut = rel => CANONICAL_FILES.has(rel) || CANONICAL_PATTERNS.some(re => re.test(rel));
const isExcludedFile = name => name === ".git" || name === ".DS_Store" || /^LICENSE/i.test(name)
  || EXCLUDED_FILE_EXT.test(name) || PG_WAL_SEGMENT.test(name) || SOURCE_EXT.test(name);

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
  let entries;
  try { entries = readdirSync(target); } catch { return 0; }
  for (const name of entries) total += treeBytes(join(target, name));
  return total;
}

function detectExcludedCluster(dir, entries) {
  let hasDotGit = false, hasHead = false, hasObjects = false, hasRefs = false;
  for (const entry of entries) {
    const name = entry.name;
    if (name === ".git") hasDotGit = true;
    if (name === "PG_VERSION" && entry.isFile()) return true;
    if (name === "pg_wal" && entry.isDirectory()) return true;
    if (name === "HEAD" && entry.isFile()) hasHead = true;
    if (name === "objects" && entry.isDirectory()) hasObjects = true;
    if (name === "refs" && entry.isDirectory()) hasRefs = true;
  }
  if (!hasDotGit && hasHead && hasObjects && hasRefs) return true;
  void dir;
  return false;
}

export function collectCleanOutFiles(
  outDir,
  { role, maxFiles = 64, maxSingleBytes = 2097152, maxTotalBytes = 10485760 } = {},
) {
  void role;
  if (!outDir || !existsSync(outDir)) {
    return { included: [], excludedPaths: [], excludedCount: 0, truncated: false };
  }
  const canonical = [];
  const ordinary = [];
  const excludedPaths = [];

  function walk(dir, prefix) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (prefix && detectExcludedCluster(dir, entries)) {
      excludedPaths.push(prefix);
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      const rel = `${prefix}${name}`;
      const full = join(dir, name);
      const st = lstatSync(full, { throwIfNoEntry: false });
      if (!st) continue;
      if (hasInvalidSegment(name)) {
        excludedPaths.push(st.isDirectory() ? `${rel}/` : rel);
        continue;
      }
      if (st.isDirectory()) {
        if (EXCLUDED_DIR_SEGMENT.test(name) || CACHE_SEGMENT.test(name)) {
          excludedPaths.push(`${rel}/`);
          continue;
        }
        walk(full, `${rel}/`);
        continue;
      }
      if (!st.isFile()) {
        excludedPaths.push(rel);
        continue;
      }
      if (isCanonicalOut(rel)) {
        canonical.push({ rel, full, size: st.size });
      } else if (isExcludedFile(name)) {
        excludedPaths.push(rel);
      } else {
        ordinary.push({ rel, full, size: st.size });
      }
    }
  }

  walk(outDir, "");
  canonical.sort((a, b) => a.rel.localeCompare(b.rel));
  ordinary.sort((a, b) => a.rel.localeCompare(b.rel));

  const included = [];
  let totalBytes = 0;
  let truncated = false;
  for (const item of canonical) {
    const buf = readFileSync(item.full);
    included.push([item.rel, buf]);
    totalBytes += buf.length;
  }
  for (const item of ordinary) {
    if (item.size > maxSingleBytes || included.length >= maxFiles || totalBytes + item.size > maxTotalBytes) {
      excludedPaths.push(item.rel);
      truncated = true;
      continue;
    }
    const buf = readFileSync(item.full);
    included.push([item.rel, buf]);
    totalBytes += buf.length;
  }
  excludedPaths.sort();
  return { included, excludedPaths, excludedCount: excludedPaths.length, truncated };
}

export function reclaimWorkspacePayloads(wsDir) {
  if (!wsDir || !existsSync(wsDir)) return { reclaimedBytes: 0, keptManifest: false };
  let reclaimedBytes = 0;
  for (const child of RECLAIM_CHILDREN) {
    const target = join(wsDir, child);
    const st = lstatSync(target, { throwIfNoEntry: false });
    if (!st) continue;
    reclaimedBytes += treeBytes(target);
    rmSync(target, { recursive: true, force: true });
  }
  return { reclaimedBytes, keptManifest: existsSync(join(wsDir, "call.json")) };
}

export function cleanWorkDir(
  workDir,
  { maxRound = null, retainRounds = 10, recordedIds = new Set(), apply = false, now = () => Date.now() } = {},
) {
  void now;
  if (!workDir || !existsSync(workDir)) return { candidates: [], removed: [], bytesFreed: 0 };
  const recorded = recordedIds instanceof Set ? recordedIds : new Set(recordedIds ?? []);
  const entries = readdirSync(workDir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !RESERVED_WORK_DIRS.has(e.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  const candidates = [];
  const removed = [];
  let bytesFreed = 0;
  const preparedDir = join(workDir, ".prepared");

  for (const entry of entries) {
    const ws = join(workDir, entry.name);
    const manifest = join(ws, "call.json");
    let candidate = false;
    if (!existsSync(manifest)) {
      candidate = true;
    } else {
      try {
        const ctx = JSON.parse(readFileSync(manifest, "utf8"));
        const isTerminal = ctx?.recorded === true || ctx?.cancelled === true || Boolean(ctx?.id && recorded.has(ctx.id));
        const isExpiredRound = Number.isInteger(maxRound) && Number.isInteger(ctx?.round)
          && ctx.round <= maxRound - retainRounds && !isPidAlive(ctx?.pid);
        candidate = isTerminal || isExpiredRound;
      } catch {
        candidate = true;
      }
    }
    if (!candidate) continue;
    candidates.push(ws);
    if (!apply) continue;
    const base = basename(ws);
    const sidecars = [
      join(preparedDir, `${base}.json`),
      join(preparedDir, `${base}.json.session`),
      join(preparedDir, `${base}.session`),
    ];
    let freed = treeBytes(ws);
    rmSync(ws, { recursive: true, force: true });
    for (const file of sidecars) {
      if (!lstatSync(file, { throwIfNoEntry: false })) continue;
      freed += treeBytes(file);
      rmSync(file, { force: true });
    }
    bytesFreed += freed;
    removed.push(ws);
  }
  return { candidates, removed, bytesFreed };
}
