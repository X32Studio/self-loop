#!/usr/bin/env node
// F-0004, F-0008, F-0009, D-0060, design/mandatory-control-plane.md#2
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import {
  ANTIGRAVITY_DELEGATION_TOOLS,
  ANTIGRAVITY_SHELL_TOOLS,
  ANTIGRAVITY_WRITE_TOOLS,
  extractToolPaths,
  isAntigravityHook,
  PRE_TOOL_USE_PASSTHROUGH,
  T3_MCP_TOOL_PREFIX,
} from "./lib/antigravity.mjs";
import { hasGitPush } from "./lib/git-push-command.mjs";
import { canonical } from "./lib/path-canonical.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", ...ANTIGRAVITY_WRITE_TOOLS]);
const SHELL_TOOLS = new Set(["Bash", ...ANTIGRAVITY_SHELL_TOOLS]);
export const DELEGATION_TOOLS = new Set(["Agent", "spawn_agent", ...ANTIGRAVITY_DELEGATION_TOOLS]);
const DELEGATION_PROMPT_KEYS = Object.freeze(["task", "prompt", "Prompt", "message", "brief", "Script"]);
const NONCE_RE = /^[0-9a-f]{16}$/;
const NONCE_TOKEN_RE = /\b[0-9a-f]{16}\b/g;
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
  return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};

const withinStrict = (dir, root) => {
  const r = relative(canonical(root), dir);
  return Boolean(r) && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};

function delegationBase(tool) {
  const m = T3_MCP_TOOL_PREFIX.exec(tool);
  return m ? m[1] : tool;
}

export function isDelegationTool(tool) {
  if (typeof tool !== "string" || !tool) return false;
  if (DELEGATION_TOOLS.has(tool)) return true;
  const base = delegationBase(tool);
  return base !== tool && DELEGATION_TOOLS.has(base);
}

export function extractDelegationPrompts(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const base = delegationBase(tool);
  if (base === "run_workflow" && typeof args.ScriptPath === "string" && args.ScriptPath.trim()) return [];
  if (base === "create_threads" || Array.isArray(args.threads)) {
    if (!Array.isArray(args.threads) || !args.threads.length) return [];
    return args.threads.map(entry => {
      if (!entry || typeof entry !== "object") return "";
      if (typeof entry.prompt === "string") return entry.prompt;
      if (typeof entry.message === "string") return entry.message;
      return "";
    });
  }
  const prompts = [];
  for (const key of DELEGATION_PROMPT_KEYS) {
    if (typeof args[key] === "string") prompts.push(args[key]);
  }
  return prompts;
}

function isLiveCallManifest(meta, expectedWs = null) {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  if (typeof meta.nonce !== "string" || !NONCE_RE.test(meta.nonce)) return false;
  if (meta.recorded === true || meta.cancelled === true) return false;
  if (expectedWs !== null && typeof meta.ws === "string" && canonical(meta.ws) !== canonical(expectedWs)) return false;
  if (meta.wt === null || meta.wt === undefined) return true;
  if (typeof meta.wt !== "string" || !meta.wt) return false;
  return existsSync(meta.wt);
}

export function liveCallNonces(workspaces = [], records = null) {
  const live = new Set();
  for (const root of workspaces) {
    if (!root || !existsSync(root)) continue;
    let entries;
    try { entries = readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const ws = join(root, entry.name);
      const manifest = join(ws, "call.json");
      if (!existsSync(manifest)) continue;
      try {
        const meta = JSON.parse(readFileSync(manifest, "utf8"));
        if (isLiveCallManifest(meta, ws)) live.add(meta.nonce);
      } catch {}
    }
  }
  if (records) {
    const delegationsDir = join(records, "delegations");
    if (existsSync(delegationsDir)) {
      let entries;
      try { entries = readdirSync(delegationsDir, { withFileTypes: true }); } catch { entries = []; }
      for (const entry of entries) {
        if (!entry.isFile() || !/^T-.*\.json$/.test(entry.name)) continue;
        try {
          const meta = JSON.parse(readFileSync(join(delegationsDir, entry.name), "utf8"));
          if (isLiveCallManifest(meta)) live.add(meta.nonce);
        } catch {}
      }
    }
  }
  return live;
}

function promptContainsLiveNonce(text, liveNonces) {
  if (typeof text !== "string" || !text || !liveNonces.size) return false;
  for (const match of text.matchAll(NONCE_TOKEN_RE)) {
    if (liveNonces.has(match[0])) return true;
  }
  return false;
}

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

export function refusal(input, { product, workspaces = [], allow = [], records = null, format = null, gitTimeoutMs = GIT_TIMEOUT_MS }) {
  const { tool, args, cwd } = normalizeHookInput(input, format);
  if (isDelegationTool(tool)) {
    const liveNonces = liveCallNonces(workspaces, records);
    const prompts = extractDelegationPrompts(tool, args);
    if (!prompts.length || !prompts.every(p => promptContainsLiveNonce(p, liveNonces))) {
      return `${tool} requires a live, unrecorded 16-hex call.json nonce in every prompt/task. Prepare the role call first with call.mjs <role> --prepare or dispatch.mjs prepare.`;
    }
    return null;
  }
  if (WRITE_TOOLS.has(tool)) {
    const files = extractToolPaths(args);
    if (!files.length) return null;
    const real = p => { try { return realpathSync(p); } catch { return resolve(p); } };
    const productRepo = commonGitDir(product);
    for (const file of files) {
      const path = canonical(resolve(cwd ?? "/", file));
      if (workspaces.some(w => withinStrict(path, join(w, "tasks")))) continue;
      const workspace = workspaces.find(w => within(path, w));
      if (workspace) {
        const relWs = relative(canonical(workspace), path).split(sep).join("/") || ".";
        return `${relWs} is inside workspace root ${workspace}. The lead may write only under ${join(workspace, "tasks")}/, never inside role workspaces, worktrees, call.json, or out/.`;
      }
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

function emitDeny(isAg, reason) {
  const full = `lead-guard: ${reason}`;
  if (isAg) console.log(JSON.stringify({ decision: "deny", reason: full }));
  else console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: full } }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const formatFlag = args.harness || args.format || null;
  let isAg = formatFlag === "antigravity";
  try {
    const raw = readFileSync(0, "utf8");
    let input = {};
    if (raw.trim()) {
      try {
        input = JSON.parse(raw);
      } catch (error) {
        if (isAg) console.error(`lead-guard: ${error?.message ?? error}`);
        emitDeny(isAg, `malformed hook JSON on stdin (${error?.message ?? error})`);
        process.exitCode = 0;
        input = null;
      }
      if (input !== null && (!input || typeof input !== "object" || Array.isArray(input))) {
        emitDeny(isAg, "malformed hook JSON on stdin (expected object)");
        process.exitCode = 0;
        input = null;
      }
    }
    if (input !== null) {
      const opts = {
        product: resolve(args.product),
        workspaces: String(args.workspaces ?? "").split(",").filter(Boolean).map(w => resolve(w)),
        allow: String(args.allow || "docs/,AGENTS.md,CLAUDE.md,README.md").split(",").map(s => s.trim()).filter(Boolean),
        records: args.records ? resolve(args.records) : null,
        format: formatFlag,
      };
      isAg = isAntigravityHook(input, formatFlag);
      const reason = refusal(input, opts);
      if (reason) emitDeny(isAg, reason);
      else if (isAg && PRE_TOOL_USE_PASSTHROUGH) console.log(PRE_TOOL_USE_PASSTHROUGH);
    }
  } catch (error) {
    if (isAg) {
      console.error(`lead-guard: ${error?.message ?? error}`);
      if (PRE_TOOL_USE_PASSTHROUGH) console.log(PRE_TOOL_USE_PASSTHROUGH);
    }
  }
  process.exitCode = 0;
}
