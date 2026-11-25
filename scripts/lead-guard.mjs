#!/usr/bin/env node
// F-0004, F-0008, F-0009, D-0052, D-0060, R-0032-reviewer-architecture, design/mandatory-control-plane.md#2
import "./lib/unbind-git.mjs";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib/args.mjs";
import {
  ANTIGRAVITY_DELEGATION_TOOLS, ANTIGRAVITY_SHELL_TOOLS, ANTIGRAVITY_WRITE_TOOLS,
  decodeToolCallArgs, extractHookDirs, extractToolPaths, isAntigravityHook, PRE_TOOL_USE_PASSTHROUGH, T3_MCP_TOOL_PREFIX,
} from "./lib/antigravity.mjs";
import { hasGitPush } from "./lib/git-push-command.mjs";
import { canonical, commonGitDir } from "./lib/path-canonical.mjs";
import { DEFAULT_HOOK_ALLOW, loadHookStore, real } from "./lib/registry.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", ...ANTIGRAVITY_WRITE_TOOLS]);
const SHELL_TOOLS = new Set(["Bash", ...ANTIGRAVITY_SHELL_TOOLS]);
export const DELEGATION_TOOLS = new Set(["Agent", "spawn_agent", ...ANTIGRAVITY_DELEGATION_TOOLS]);
const DELEGATION_PROMPT_KEYS = Object.freeze(["task", "prompt", "Prompt", "message", "brief", "Script"]);
const NONCE_RE = /^[0-9a-f]{16}$/;
const NONCE_TOKEN_RE = /\b[0-9a-f]{16}\b/g;
const GIT_TIMEOUT_MS = 2_000;
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function normalizeHookInput(input, formatFlag = null) {
  if (isAntigravityHook(input, formatFlag)) {
    const hasToolCall = isPlainObject(input) && Object.hasOwn(input, "toolCall");
    const decoded = hasToolCall ? decodeToolCallArgs(input.toolCall) : { ok: true, present: false, args: {}, error: null };
    const dirs = extractHookDirs(input);
    return { format: "antigravity", tool: isPlainObject(input?.toolCall) ? input.toolCall.name : undefined, args: decoded.args, cwd: dirs[0] ?? null, argError: decoded.ok ? null : decoded.error };
  }
  const rawInput = input?.tool_input;
  let args = {}, argError = null;
  if (rawInput !== undefined) {
    if (isPlainObject(rawInput)) args = rawInput;
    else if (typeof rawInput === "string") {
      try {
        const parsed = JSON.parse(rawInput);
        if (isPlainObject(parsed)) args = parsed;
        else argError = "tool_input must be a plain JSON object";
      } catch { argError = "malformed JSON in tool_input"; }
    } else argError = "tool_input must be a plain JSON object";
  }
  return { format: "claude", tool: input?.tool_name, args, cwd: typeof input?.cwd === "string" && input.cwd ? input.cwd : null, argError };
}

const within = (dir, root) => {
  const r = relative(canonical(root), dir);
  return r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};

const withinStrict = (dir, root) => {
  const r = relative(canonical(root), dir);
  return Boolean(r) && r !== ".." && !r.startsWith(".." + sep) && !isAbsolute(r);
};

function dedupePaths(list) {
  const seen = new Set(), out = [];
  for (const p of list) {
    if (!p) continue;
    const key = canonical(p);
    if (!seen.has(key)) { seen.add(key); out.push(p); }
  }
  return out;
}

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
  if (!isPlainObject(args)) return [];
  const base = delegationBase(tool);
  if (base === "run_workflow" && typeof args.ScriptPath === "string" && args.ScriptPath.trim()) return [];
  if (base === "create_threads" || Array.isArray(args.threads)) {
    if (!Array.isArray(args.threads) || !args.threads.length) return [];
    return args.threads.map(entry => (!entry || typeof entry !== "object" ? "" : typeof entry.prompt === "string" ? entry.prompt : typeof entry.message === "string" ? entry.message : ""));
  }
  const prompts = [];
  for (const key of DELEGATION_PROMPT_KEYS) if (typeof args[key] === "string") prompts.push(args[key]);
  return prompts;
}

function isLiveCallManifest(meta, expectedWs = null) {
  if (!isPlainObject(meta)) return false;
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
      const ws = join(root, entry.name), manifest = join(ws, "call.json");
      if (!existsSync(manifest)) continue;
      try {
        const meta = JSON.parse(readFileSync(manifest, "utf8"));
        if (isLiveCallManifest(meta, ws)) live.add(meta.nonce);
      } catch {}
    }
  }
  for (const rec of (Array.isArray(records) ? records : records ? [records] : [])) {
    if (!rec) continue;
    const delegationsDir = join(rec, "delegations");
    if (!existsSync(delegationsDir)) continue;
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
  return live;
}

function promptContainsLiveNonce(text, liveNonces) {
  if (typeof text !== "string" || !text || !liveNonces.size) return false;
  for (const match of text.matchAll(NONCE_TOKEN_RE)) if (liveNonces.has(match[0])) return true;
  return false;
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

export function refusal(input, { product = null, workspaces = [], allow = null, records = null, ownerStore = null, format = null, gitTimeoutMs = GIT_TIMEOUT_MS } = {}) {
  const { tool, args, cwd, argError } = normalizeHookInput(input, format);
  if (argError) return argError;
  const allProducts = [], rawWorkspaces = [...workspaces], rawRecords = Array.isArray(records) ? [...records] : records ? [records] : [];
  const explicitAllow = Array.isArray(allow) ? allow : null;
  if (ownerStore !== null && ownerStore !== undefined) {
    const loaded = loadHookStore(ownerStore, { defaultAllow: explicitAllow ?? DEFAULT_HOOK_ALLOW });
    if (!loaded.ok) return loaded.error;
    for (const p of loaded.products) allProducts.push(explicitAllow ? { ...p, allow: explicitAllow } : p);
    rawWorkspaces.push(...loaded.workspaces);
    rawRecords.push(...loaded.recordsDirs);
  }
  if (product) {
    const prodRepo = commonGitDir(product);
    allProducts.push({ name: null, product, repoCommon: prodRepo ? real(prodRepo.common) : null, allow: explicitAllow ?? [...DEFAULT_HOOK_ALLOW] });
  }
  const allWorkspaces = dedupePaths(rawWorkspaces), allRecords = dedupePaths(rawRecords);
  if (isDelegationTool(tool)) {
    const liveNonces = liveCallNonces(allWorkspaces, allRecords), prompts = extractDelegationPrompts(tool, args);
    if (!prompts.length || !prompts.every(p => promptContainsLiveNonce(p, liveNonces))) {
      return `${tool} requires a live, unrecorded 16-hex call.json nonce in every prompt/task. Prepare the role call first with call.mjs <role> --prepare or dispatch.mjs prepare.`;
    }
    return null;
  }
  if (WRITE_TOOLS.has(tool)) {
    const files = extractToolPaths(args);
    if (!files.length) return null;
    for (const file of files) {
      if (!isAbsolute(file) && !cwd) return `relative write path "${file}" requires hook cwd`;
      const path = canonical(resolve(cwd ?? "/", file));
      const containingWs = allWorkspaces.filter(w => within(path, w));
      if (containingWs.length > 0) {
        if (containingWs.every(w => withinStrict(path, join(w, "tasks")))) continue;
        const ws = containingWs.find(w => !withinStrict(path, join(w, "tasks")));
        const relWs = relative(canonical(ws), path).split(sep).join("/") || ".";
        return `${relWs} is inside workspace root ${ws}. The lead may write only under ${join(ws, "tasks")}/, never inside role workspaces, worktrees, call.json, or out/.`;
      }
      const repo = commonGitDir(existsSync(path) ? path : dirname(path));
      const targetProd = repo ? allProducts.find(p => p.repoCommon && real(repo.common) === p.repoCommon) : null;
      if (!targetProd) continue;
      const rel = relative(repo.top, path).split(sep).join("/");
      if (targetProd.allow.some(a => (a.endsWith("/") ? rel.startsWith(a) : rel === a))) continue;
      const why = productCode(repo.top, rel, { timeoutMs: gitTimeoutMs });
      if (!why) continue;
      return `${rel} is product code in ${repo.top} (${why}). The lead does not write product code: a self-loop actor does, in its workspace (call.mjs actor --prepare, then record). The lead edits only ${targetProd.allow.join(", ")} and files Git ignores.`;
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
      try { input = JSON.parse(raw); }
      catch (error) {
        if (isAg) console.error(`lead-guard: ${error?.message ?? error}`);
        emitDeny(isAg, `malformed hook JSON on stdin (${error?.message ?? error})`);
        input = null;
      }
      if (input !== null && !isPlainObject(input)) {
        emitDeny(isAg, "malformed hook JSON on stdin (expected object)");
        input = null;
      }
    }
    if (input !== null) {
      const hasOwnerStore = "owner-store" in args;
      const opts = {
        ownerStore: hasOwnerStore ? args["owner-store"] : null,
        product: hasOwnerStore ? (args.product ? resolve(args.product) : null) : resolve(args.product),
        workspaces: String(args.workspaces ?? "").split(",").filter(Boolean).map(w => resolve(w)),
        allow: args.allow ? String(args.allow).split(",").map(s => s.trim()).filter(Boolean) : null,
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
