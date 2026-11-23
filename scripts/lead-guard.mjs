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
import { ANTIGRAVITY_SHELL_TOOLS, ANTIGRAVITY_WRITE_TOOLS, extractToolPaths, isAntigravityHook, PRE_TOOL_USE_PASSTHROUGH } from "./lib/antigravity.mjs";
import { hasGitPush } from "./lib/git-push-command.mjs";
import { canonical } from "./lib/path-canonical.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", ...ANTIGRAVITY_WRITE_TOOLS]);
const SHELL_TOOLS = new Set(["Bash", ...ANTIGRAVITY_SHELL_TOOLS]);
const GIT_TIMEOUT_MS = 2_000;

export function normalizeHookInput(input, formatFlag = null) {
  if (isAntigravityHook(input, formatFlag)) {
    return {
      format: "antigravity",
      tool: input?.toolCall?.name,
      args: input?.toolCall?.args ?? {},
      cwd: input?.cwd ?? (Array.isArray(input?.workspacePaths) ? input.workspacePaths[0] : null) ?? null,
    };
  }
  return { format: "claude", tool: input?.tool_name, args: input?.tool_input ?? {}, cwd: input?.cwd ?? null };
}

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

export function productCode(top, rel, { timeoutMs = GIT_TIMEOUT_MS } = {}) {
  if (rel.split("/").some(part => part.toLowerCase() === ".git")) return null;
  const git = (...argv) => spawnSync("git", ["-C", top, ...argv], { encoding: "utf8", timeout: timeoutMs });
  const timedOut = r => r.error?.code === "ETIMEDOUT";
  const failed = r => (r.error?.message ?? r.stderr ?? "").trim() || `exit ${r.status}`;
  const listed = git("ls-files", "-z", "--cached", "--", `:(literal,icase)${rel}`);
  if (timedOut(listed)) return `git timed out resolving ${rel}`;
  if (listed.status !== 0) return `Git could not list it: ${failed(listed)}`;
  const entries = listed.stdout.split("\0").filter(Boolean);
  if (entries.some(e => e === rel || e.startsWith(`${rel}/`))) return "tracked by Git";
  if (entries.length) {
    const ic = git("config", "--type=bool", "--get", "core.ignorecase");
    if (timedOut(ic)) return `git timed out resolving ${rel}`;
    if (ic.stdout?.trim() === "true") return "tracked by Git";
  }
  const ignored = git("check-ignore", "-q", "--no-index", "--", `./${rel}`);
  if (timedOut(ignored)) return `git timed out resolving ${rel}`;
  if (ignored.status === 0) return null;
  if (ignored.status === 1) return "untracked and not ignored, so Git would track it";
  return `Git could not tell whether it is ignored: ${failed(ignored)}`;
}

/** The reason to refuse one tool call, or null. */
export function refusal(input, { product, workspaces, allow, format = null, gitTimeoutMs = GIT_TIMEOUT_MS }) {
  const { tool, args, cwd } = normalizeHookInput(input, format);
  if (!WRITE_TOOLS.has(tool) && !SHELL_TOOLS.has(tool)) return null;
  if (WRITE_TOOLS.has(tool)) {
    const files = extractToolPaths(args);
    if (!files.length) return null;
    const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
    const productRepo = commonGitDir(product);
    for (const file of files) {
      const path = canonical(resolve(cwd ?? "/", file));
      if (workspaces.some(w => within(path, w))) continue;
      const repo = commonGitDir(existsSync(path) ? path : dirname(path));
      if (!repo || !productRepo || real(repo.common) !== real(productRepo.common)) continue;
      const rel = relative(repo.top, path).split(sep).join("/");
      if (allow.some(a => (a.endsWith("/") ? rel.startsWith(a) : rel === a))) continue;
      const why = productCode(repo.top, rel, { timeoutMs: gitTimeoutMs });
      if (!why) continue;
      return `${rel} is product code in ${repo.top} (${why}). The lead does not write product code: a self-loop actor does, in its workspace (call.mjs actor --prepare, then record). The lead edits only ${allow.join(", ")} and files Git ignores.`;
    }
    return null;
  }
  if (SHELL_TOOLS.has(tool) && hasGitPush(String(args.command ?? args.CommandLine ?? "")))
    return "A direct git push. Every push goes through gated-push.mjs (suite-green receipt, CI and protected branches checked).";
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const formatFlag = args.harness || args.format || null;
  let isAg = formatFlag === "antigravity";
  try {
    const opts = {
      product: resolve(args.product), workspaces: String(args.workspaces ?? "").split(",").filter(Boolean).map(w => resolve(w)),
      allow: String(args.allow || "docs/,AGENTS.md,CLAUDE.md,README.md").split(",").map(s => s.trim()).filter(Boolean),
      format: formatFlag,
    };
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    isAg = isAntigravityHook(input, formatFlag);
    const reason = refusal(input, opts);
    if (isAg) {
      if (reason) console.log(JSON.stringify({ decision: "deny", reason: `lead-guard: ${reason}` }));
      else if (PRE_TOOL_USE_PASSTHROUGH) console.log(PRE_TOOL_USE_PASSTHROUGH);
    } else if (reason) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `lead-guard: ${reason}` } }));
    }
  } catch (error) {
    if (isAg) {
      console.error(`lead-guard: ${error?.message ?? error}`);
      if (PRE_TOOL_USE_PASSTHROUGH) console.log(PRE_TOOL_USE_PASSTHROUGH);
    }
    /* let the call through; the landing gates still hold */
  }
  process.exitCode = 0;
}
