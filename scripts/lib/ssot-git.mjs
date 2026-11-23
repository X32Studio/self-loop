// F-0014, D-0057: Isolated Git plumbing for SSOT checks.
// Every Git read uses --no-replace-objects, --literal-pathspecs, and core.quotepath=false on an explicit commit SHA.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { globMatch } from "./plan-globs.mjs";

export const GIT_MAX_BUFFER = 1 << 28;
export const CHECK_MAX_BUFFER = 1 << 26;
export const CHECK_TIMEOUT_MS = 10 * 60_000;
export const MAX_CHECK_OUTPUT_CHARS = 4000;
export const SHORT_SHA_LEN = 12;
export const DISPLAY_SHA_LEN = 7;

export class SsotConfigError extends Error {}

export const gitRaw = (repo, argv, opts = {}) =>
  spawnSync("git", ["--literal-pathspecs", "-C", repo, "-c", "core.quotepath=false", "--no-replace-objects", ...argv],
    { encoding: "utf8", maxBuffer: GIT_MAX_BUFFER, ...opts });

export function fullShaNoReplace(repo, rev) {
  const r = gitRaw(repo, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (r.status !== 0) throw new SsotConfigError(`${rev} does not name a commit in ${repo}`);
  return r.stdout.trim();
}

export const isAncestor = (repo, a, b) => a === b || gitRaw(repo, ["merge-base", "--is-ancestor", a, b]).status === 0;

const normalizeOsRoot = p => (process.platform === "darwin" ? p.replace(/^\/(tmp|var)(?=\/|$)/, "/private/$1") : p);

/**
 * Resolve an external SSOT repo strictly relative to `configDir` (the directory holding loop.json).
 * Refuses missing paths, non-directories, non-Git dirs, and symbolic links anywhere along relative or absolute paths.
 */
export function resolveExternalRepo(name, rawPath, configDir) {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(configDir, rawPath);
  let lst;
  try { lst = lstatSync(candidate); } catch { throw new SsotConfigError(`ssot.repos.${name} (${rawPath}) does not exist`); }
  if (lst.isSymbolicLink()) throw new SsotConfigError(`ssot.repos.${name} (${rawPath}) resolves to a symbolic link, which is refused`);
  if (!lst.isDirectory()) throw new SsotConfigError(`ssot.repos.${name} (${rawPath}) is not a directory`);
  const realCandidate = realpathSync(candidate);
  const expected = isAbsolute(rawPath)
    ? normalizeOsRoot(candidate)
    : resolve(realpathSync(configDir), rawPath);
  if (realCandidate !== expected)
    throw new SsotConfigError(`ssot.repos.${name} (${rawPath}) traverses a symbolic link (${realCandidate} != ${expected}), which is refused`);
  const top = gitRaw(realCandidate, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new SsotConfigError(`ssot.repos.${name} (${realCandidate}) is not a Git repository`);
  const gitTop = realpathSync(top.stdout.trim());
  const rel = relative(gitTop, realCandidate).split(sep).join("/");
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
    throw new SsotConfigError(`ssot.repos.${name} escapes its Git repository root`);
  return { name, root: realCandidate, gitTop, prefix: rel };
}

export function assertNoDiskSymlinkEscape(repoRoot, relPath) {
  let cur = repoRoot;
  for (const seg of relPath.split("/")) {
    cur = join(cur, seg);
    const lst = lstatSync(cur, { throwIfNoEntry: false });
    if (!lst) break;
    if (lst.isSymbolicLink()) throw new SsotConfigError(`${relPath} traverses a symbolic link in ${repoRoot}`);
  }
}

export function readCommittedRegularFile(gitTop, sha, treePath) {
  const ls = gitRaw(gitTop, ["ls-tree", "-z", sha, "--", treePath]);
  if (ls.status !== 0) return { ok: false, error: `git ls-tree failed for ${treePath} at ${sha.slice(0, SHORT_SHA_LEN)}: ${ls.stderr.trim()}` };
  const items = ls.stdout.split("\0").filter(Boolean);
  if (items.length !== 1) return { ok: false, error: `${treePath} is missing from commit ${sha.slice(0, SHORT_SHA_LEN)}` };
  const [meta, listed] = items[0].split("\t");
  const [mode, type, blobSha] = meta.split(" ");
  if (listed !== treePath) return { ok: false, error: `${treePath} resolved unexpectedly to ${listed} at ${sha.slice(0, SHORT_SHA_LEN)}` };
  if (type !== "blob" || (mode !== "100644" && mode !== "100755"))
    return { ok: false, error: `${treePath} at ${sha.slice(0, SHORT_SHA_LEN)} is not a regular tracked file (mode ${mode}, type ${type})` };
  const cat = gitRaw(gitTop, ["cat-file", "blob", blobSha]);
  if (cat.status !== 0) return { ok: false, error: `failed reading blob ${blobSha} for ${treePath}: ${cat.stderr.trim()}` };
  return { ok: true, blobSha, content: cat.stdout };
}

export function assertCleanDocInWorktree(gitTop, treePath, label) {
  const bare = gitRaw(gitTop, ["rev-parse", "--is-bare-repository"]);
  if (bare.status === 0 && bare.stdout.trim() === "true") return;
  const st = gitRaw(gitTop, ["status", "--porcelain", "--untracked-files=all", "--", treePath]);
  if (st.status !== 0) throw new SsotConfigError(`cannot inspect working tree status for ${label}: ${st.stderr.trim()}`);
  if (st.stdout.trim())
    throw new SsotConfigError(`cannot attest updated for ${label}: ${treePath} has uncommitted changes in ${gitTop}; commit the document update first`);
}

const matchesWatch = (p, watch, ignore) => watch.some(g => globMatch(g, p)) && !ignore.some(g => globMatch(g, p));

/**
 * Compute watched (non-ignored) changes in `fromSha..toSha` (or up to `toSha` when `fromSha` is null).
 * Uses `-c` (--diff-merges=combined) so ordinary `--no-ff` merges that carry a doc+code commit produce 0 false drift,
 * while side-branch missed docs and evil merges modifying watched files relative to all parents are caught.
 */
export function changedWatchWindow(product, fromSha, toSha, watch, ignore) {
  if (fromSha && fromSha === toSha) return { behindCommits: 0, changedPaths: [] };
  const range = fromSha ? `${fromSha}..${toSha}` : toSha;
  const log = gitRaw(product, ["log", "--no-renames", "-c", "--format=%x00%H", "--name-only", range]);
  if (log.status !== 0) throw new SsotConfigError(`git log ${range} failed: ${log.stderr.trim()}`);
  const commits = new Set(), paths = new Set();
  for (const block of log.stdout.split("\0").filter(Boolean)) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let hit = false;
    for (const file of lines.slice(1)) if (matchesWatch(file, watch, ignore)) { paths.add(file); hit = true; }
    if (hit) commits.add(lines[0]);
  }
  return { behindCommits: commits.size, changedPaths: [...paths].sort() };
}

const cleanEnv = extra => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")), ...extra });

/**
 * Execute an entry's custom `check` command against clean detached worktrees at the committed SHAs.
 * Both the product repo (at `sha`) and any external doc repo (at `docHeadSha`) are checked out cleanly; live dirty
 * working trees are never exposed. Prunes stale worktree registrations before and after execution.
 */
export function runEntryCheck(entry, { product, sha, docGitTop, docHeadSha, docPrefix }) {
  const dir = mkdtempSync(join(tmpdir(), "self-loop-ssot-"));
  const productWt = join(dir, "product");
  const docWtRoot = entry.repo === "product" ? null : join(dir, "doc-repo");
  let addedProduct = false, addedDoc = false;
  try {
    gitRaw(product, ["worktree", "prune"], { stdio: "ignore" });
    const addProd = gitRaw(product, ["worktree", "add", "-q", "--detach", productWt, sha]);
    if (addProd.status !== 0)
      return { entryId: entry.id, kind: "check-failed", doc: entry.doc, command: entry.check, exit: addProd.status ?? -1, detail: `git worktree add failed: ${addProd.stderr.trim()}` };
    addedProduct = true;

    let docRepoEnv = productWt;
    if (docWtRoot) {
      gitRaw(docGitTop, ["worktree", "prune"], { stdio: "ignore" });
      const addDoc = gitRaw(docGitTop, ["worktree", "add", "-q", "--detach", docWtRoot, docHeadSha]);
      if (addDoc.status !== 0)
        return { entryId: entry.id, kind: "check-failed", doc: entry.doc, command: entry.check, exit: addDoc.status ?? -1, detail: `git worktree add failed for ${entry.repo}: ${addDoc.stderr.trim()}` };
      addedDoc = true;
      docRepoEnv = docPrefix ? join(docWtRoot, docPrefix) : docWtRoot;
    }

    const env = cleanEnv({ SELF_LOOP_SSOT_ID: entry.id, SELF_LOOP_SSOT_DOC: entry.doc, SELF_LOOP_SSOT_SHA: sha,
      SELF_LOOP_SSOT_PRODUCT: productWt, SELF_LOOP_SSOT_DOC_REPO: docRepoEnv });
    const r = spawnSync("sh", ["-c", entry.check], { cwd: productWt, env, encoding: "utf8", maxBuffer: CHECK_MAX_BUFFER, timeout: CHECK_TIMEOUT_MS });
    if (r.status !== 0) {
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`.trim();
      return { entryId: entry.id, kind: "check-failed", doc: entry.doc, command: entry.check, exit: r.status ?? -1,
        output: output.slice(0, MAX_CHECK_OUTPUT_CHARS), detail: `check command exited ${r.status ?? -1} for ${entry.id} (${entry.doc})${output ? `: ${output.split("\n")[0]}` : ""}` };
    }
    return null;
  } finally {
    if (addedProduct) gitRaw(product, ["worktree", "remove", "--force", productWt], { stdio: "ignore" });
    gitRaw(product, ["worktree", "prune"], { stdio: "ignore" });
    if (docWtRoot) {
      if (addedDoc) gitRaw(docGitTop, ["worktree", "remove", "--force", docWtRoot], { stdio: "ignore" });
      gitRaw(docGitTop, ["worktree", "prune"], { stdio: "ignore" });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
