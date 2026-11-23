#!/usr/bin/env node
// The lead's guard: a Claude Code `PreToolUse` hook that refuses, before it runs, what the owner's rule forbids the
// lead (owner, 2026-11-21: 「强制你follow self loop的生成引擎和对抗引擎去开发，这是我们的规矩」):
// - editing the product in any checkout of the product repository, except the documents and rule files the lead owns
//   (product code is written by self-loop roles, in their workspaces under --workspaces);
// - pushing with git directly (every push goes through gated-push.mjs, which refuses a red suite or CI).
//
// node lead-guard.mjs --product <repository dir> --workspaces <dir> [--allow docs/,AGENTS.md,CLAUDE.md,README.md]
// Reads the hook's JSON on stdin. Prints a deny decision for a refused call, nothing otherwise. Always exit 0: a guard
// that cannot read its input lets the call through (the landing gates still hold) rather than block the session.
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import { hasGitPush } from "./lib/git-push-command.mjs";
import { canonical } from "./audit-access.mjs";

const within = (dir, root) => {
  const r = relative(canonical(root), dir);
  return r !== ".." && !r.startsWith(".." + sep) && !r.startsWith(sep);
};

/** The common git directory of the checkout holding `path` (a worktree's `.git` file names it), or null. */
export function commonGitDir(path) {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      if (statSync(dotgit).isDirectory()) return { top: dir, common: dotgit };
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"));
      if (!m) return null;
      const gitdir = resolve(dir, m[1].trim());
      const commondir = join(gitdir, "commondir");
      return { top: dir, common: existsSync(commondir) ? resolve(gitdir, readFileSync(commondir, "utf8").trim()) : gitdir };
    }
    if (dirname(dir) === dir) return null;
  }
}

export function productCode(top, rel) {
  if (rel.split("/").some(part => part.toLowerCase() === ".git")) return null;
  const git = (...argv) => spawnSync("git", ["-C", top, ...argv], { encoding: "utf8" });
  const failed = r => (r.error?.message ?? r.stderr ?? "").trim() || `exit ${r.status}`;
  const listed = git("ls-files", "-z", "--cached", "--", `:(literal,icase)${rel}`);
  if (listed.status !== 0) return `Git could not list it: ${failed(listed)}`;
  const entries = listed.stdout.split("\0").filter(Boolean);
  if (entries.some(e => e === rel || e.startsWith(`${rel}/`))) return "tracked by Git";
  if (entries.length && git("config", "--type=bool", "--get", "core.ignorecase").stdout?.trim() === "true") return "tracked by Git";
  const ignored = git("check-ignore", "-q", "--no-index", "--", `./${rel}`);
  if (ignored.status === 0) return null;
  if (ignored.status === 1) return "untracked and not ignored, so Git would track it";
  return `Git could not tell whether it is ignored: ${failed(ignored)}`;
}

/** The reason to refuse one tool call, or null. */
export function refusal(input, { product, workspaces, allow }) {
  const tool = input?.tool_name, args = input?.tool_input ?? {};
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = args.file_path ?? args.notebook_path;
    if (!file) return null;
    const path = canonical(resolve(input.cwd ?? "/", file));
    if (workspaces.some(w => within(path, w))) return null;
    const repo = commonGitDir(existsSync(path) ? path : dirname(path));
    const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
    const productRepo = commonGitDir(product);
    if (!repo || !productRepo || real(repo.common) !== real(productRepo.common)) return null;
    const rel = relative(repo.top, path).split(sep).join("/");
    if (allow.some(a => (a.endsWith("/") ? rel.startsWith(a) : rel === a))) return null;
    const why = productCode(repo.top, rel);
    if (!why) return null;
    return `${rel} is product code in ${repo.top} (${why}). The lead does not write product code: a self-loop actor does, in its workspace (call.mjs actor --prepare, then record). The lead edits only ${allow.join(", ")} and files Git ignores.`;
  }
  if (tool === "Bash" && hasGitPush(String(args.command ?? "")))
    return "A direct git push. Every push goes through gated-push.mjs (suite-green receipt, CI and protected branches checked).";
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const opts = {
      product: resolve(args.product), workspaces: String(args.workspaces ?? "").split(",").filter(Boolean).map(w => resolve(w)),
      allow: String(args.allow || "docs/,AGENTS.md,CLAUDE.md,README.md").split(",").map(s => s.trim()).filter(Boolean),
    };
    const reason = refusal(JSON.parse(readFileSync(0, "utf8") || "{}"), opts);
    if (reason) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `lead-guard: ${reason}` } }));
  } catch { /* let the call through; the landing gates still hold */ }
  process.exitCode = 0;
}
