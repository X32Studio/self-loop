// F-0010, F-0015, D-0016, R-0055-judge-frame-hygiene
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { git, regularFiles, run } from "./git-plumbing.mjs";

const INVALID_PATH_RE = /["\x00-\x1f]|^\s|\s$/;
const PATHSPEC_BYTE_LIMIT = 64 * 1024;

export class RecordsConflict extends Error {}

function assertValidRecordPath(relPath) {
  if (typeof relPath !== "string" || !relPath || INVALID_PATH_RE.test(relPath) || relPath.startsWith("/") || relPath.split("/").includes("..")) {
    throw new Error(`invalid records path: ${JSON.stringify(relPath)}`);
  }
}

function chunkPaths(paths, maxBytes = PATHSPEC_BYTE_LIMIT) {
  const chunks = [];
  let cur = [], bytes = 0;
  for (const p of paths) {
    const len = Buffer.byteLength(p, "utf8") + 1;
    if (cur.length && bytes + len > maxBytes) { chunks.push(cur); cur = []; bytes = 0; }
    cur.push(p);
    bytes += len;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function dirtyChangesFor(repo, allPaths) {
  const totalBytes = allPaths.reduce((n, p) => n + Buffer.byteLength(p, "utf8") + 1, 0);
  if (totalBytes <= PATHSPEC_BYTE_LIMIT && allPaths.length <= 200) {
    return git(repo, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ...allPaths);
  }
  const wanted = new Set(allPaths);
  const raw = run("git", ["-C", repo, "--no-optional-locks", "status", "--porcelain", "-z", "--untracked-files=all", "--ignored=matching"], { encoding: "utf8" });
  const tokens = raw.split("\0");
  const hits = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    const orig = (xy[0] === "R" || xy[0] === "C") ? tokens[++i] : null;
    const matched = wanted.has(p) || (orig && wanted.has(orig))
      || (p.endsWith("/") && allPaths.some(ap => ap.startsWith(p)));
    if (matched) hits.push(`${xy} ${p}`);
  }
  return hits.join("\n");
}

function restoreWorkTree(repo, commit, added, removed, env) {
  for (const chunk of chunkPaths(added)) {
    run("git", ["-C", repo, "restore", "--source", commit, "--worktree", "--", ...chunk], { env });
  }
  const repoRoot = resolve(repo);
  for (const relPath of removed) {
    const full = join(repoRoot, relPath);
    rmSync(full, { force: true });
    let dir = dirname(full);
    while (dir !== repoRoot && dir.startsWith(`${repoRoot}/`)) {
      try { rmdirSync(dir); } catch { break; }
      dir = dirname(dir);
    }
  }
}

export function recordsSnapshot(repo, head = git(repo, "rev-parse", "HEAD")) {
  const files = new Map(regularFiles(repo, head).map(file => [file.path, file.sha]));
  const read = path => files.has(path)
    ? run("git", ["-C", repo, "cat-file", "blob", files.get(path)], { encoding: "utf8" })
    : "";
  return { head, files, read };
}

export const appendJsonLines = (old, rows) => old + (old && !old.endsWith("\n") ? "\n" : "")
  + rows.map(row => JSON.stringify(row) + "\n").join("");

function lockIndex(path) {
  const deadline = Date.now() + 5_000;
  const wait = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try { return closeSync(openSync(path, "wx")); }
    catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(wait, 0, 0, 20);
    }
  }
}

function publish(repo, tmp, branch, head, commit, message, added, removed) {
  const index = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const lock = index + ".lock";
  lockIndex(lock);
  let locked = true;
  try {
    if (git(repo, "symbolic-ref", "HEAD") !== branch) throw new RecordsConflict("the records checkout changed branches");
    if (git(repo, "rev-parse", "HEAD") !== head) return false;
    const allPaths = [...added, ...removed];
    const changes = dirtyChangesFor(repo, allPaths);
    if (changes) throw new RecordsConflict(`records paths have uncommitted changes; commit or discard them first:\n${changes}`);

    const stage = join(tmp, "published-index");
    if (existsSync(index)) copyFileSync(index, stage);
    const env = { ...process.env, GIT_INDEX_FILE: stage };
    const update = (...args) => run("git", ["-C", repo, ...args], { env });
    if (removed.length) {
      run("git", ["-C", repo, "update-index", "--force-remove", "-z", "--stdin"], { env, input: `${removed.join("\0")}\0` });
    }
    for (const chunk of chunkPaths(added)) {
      update("reset", "-q", commit, "--", ...chunk);
    }
    copyFileSync(stage, lock);

    const moved = spawnSync("git", ["-C", repo, "update-ref", "-m", message, "HEAD", commit, head], { encoding: "utf8" });
    if (moved.status !== 0) {
      if (git(repo, "rev-parse", "HEAD") !== head) return false;
      throw new Error(`git update-ref: ${moved.error ?? moved.stderr}`);
    }
    try {
      restoreWorkTree(repo, commit, added, removed, env);
    } catch (error) {
      console.error(`records commit ${commit} published; could not update the working files: ${error.message}`);
    } finally {
      renameSync(lock, index);
      locked = false;
    }
    return true;
  } finally { if (locked) rmSync(lock, { force: true }); }
}

export function commitRecords(repo, build, { attempts = 5 } = {}) {
  repo = resolve(repo);
  const branch = git(repo, "symbolic-ref", "HEAD");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = recordsSnapshot(repo);
    const tmp = mkdtempSync(join(tmpdir(), "self-loop-index-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const g = (...args) => run("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
    const added = new Set();
    const removed = new Set();
    const pendingRemovals = new Set();
    const flushRemovals = () => {
      if (!pendingRemovals.size) return;
      run("git", ["-C", repo, "update-index", "--force-remove", "-z", "--stdin"], {
        env,
        input: `${[...pendingRemovals].join("\0")}\0`,
      });
      pendingRemovals.clear();
    };
    try {
      g("read-tree", snapshot.head);
      const add = (path, bytes) => {
        assertValidRecordPath(path);
        pendingRemovals.delete(path);
        removed.delete(path);
        const blob = run("git", ["-C", repo, "hash-object", "-w", "--stdin"], { encoding: "utf8", input: bytes }).trim();
        g("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
        added.add(path);
      };
      const remove = path => {
        assertValidRecordPath(path);
        if (!snapshot.files.has(path) && !added.has(path)) return;
        added.delete(path);
        removed.add(path);
        pendingRemovals.add(path);
      };
      const tree = () => { flushRemovals(); return g("write-tree"); };
      const { message, value } = build({ ...snapshot, add, remove, tree });
      flushRemovals();
      if (!added.size && !removed.size) return { commit: snapshot.head, value };
      const commit = git(repo, "commit-tree", g("write-tree"), "-p", snapshot.head, "-m", message);
      if (publish(repo, tmp, branch, snapshot.head, commit, message, [...added], [...removed])) return { commit, value };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  throw new Error(`${repo}: the branch kept moving; records not committed after ${attempts} attempts`);
}
