// Automatic records writers build from a single parent, then retry their entire append if the parent moved.
import { spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdtempSync, openSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, regularFiles, run } from "./git-plumbing.mjs";

export class RecordsConflict extends Error {}

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

// Take Git's own index lock only for publication. A concurrent plain git commit must not see a new HEAD and
// an older version of an appended file in the index. Keep every unrelated index entry and working file.
function publish(repo, tmp, branch, head, commit, message, paths) {
  const index = git(repo, "rev-parse", "--path-format=absolute", "--git-path", "index");
  const lock = index + ".lock";
  lockIndex(lock);
  let locked = true;
  try {
    if (git(repo, "symbolic-ref", "HEAD") !== branch) throw new RecordsConflict("the records checkout changed branches");
    if (git(repo, "rev-parse", "HEAD") !== head) return false;
    const changes = git(repo, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--", ...paths);
    if (changes) throw new RecordsConflict(`records paths have uncommitted changes; commit or discard them first:\n${changes}`);

    const stage = join(tmp, "published-index");
    if (existsSync(index)) copyFileSync(index, stage);
    const env = { ...process.env, GIT_INDEX_FILE: stage };
    const update = (...args) => run("git", ["-C", repo, ...args], { env });
    update("reset", "-q", commit, "--", ...paths);
    copyFileSync(stage, lock);

    const moved = spawnSync("git", ["-C", repo, "update-ref", "-m", message, "HEAD", commit, head], { encoding: "utf8" });
    if (moved.status !== 0) {
      if (git(repo, "rev-parse", "HEAD") !== head) return false;
      throw new Error(`git update-ref: ${moved.error ?? moved.stderr}`);
    }
    try {
      update("restore", "--source", commit, "--worktree", "--", ...paths);
    } catch (error) {
      console.error(`records commit ${commit} published; could not update the working files: ${error.message}`);
    } finally {
      renameSync(lock, index);
      locked = false;
    }
    return true;
  } finally { if (locked) rmSync(lock, { force: true }); }
}

/** Build additions/replacements in a private index. The callback may run again on a new parent. */
export function commitRecords(repo, build, { attempts = 5 } = {}) {
  repo = resolve(repo);
  const branch = git(repo, "symbolic-ref", "HEAD");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const snapshot = recordsSnapshot(repo);
    const tmp = mkdtempSync(join(tmpdir(), "self-loop-index-"));
    const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
    const g = (...args) => run("git", ["-C", repo, ...args], { encoding: "utf8", env }).trim();
    const paths = new Set();
    try {
      g("read-tree", snapshot.head);
      const add = (path, bytes) => {
        const blob = run("git", ["-C", repo, "hash-object", "-w", "--stdin"], { encoding: "utf8", input: bytes }).trim();
        g("update-index", "--add", "--cacheinfo", `100644,${blob},${path}`);
        paths.add(path);
      };
      const { message, value } = build({ ...snapshot, add, tree: () => g("write-tree") });
      if (!paths.size) return { commit: snapshot.head, value };
      const commit = git(repo, "commit-tree", g("write-tree"), "-p", snapshot.head, "-m", message);
      if (publish(repo, tmp, branch, snapshot.head, commit, message, [...paths])) return { commit, value };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  throw new Error(`${repo}: the branch kept moving; records not committed after ${attempts} attempts`);
}
