// F-0009, D-0052, D-0060, R-0032-reviewer-architecture, design/antigravity-harness.md#adapter
import { existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical } from "./path-canonical.mjs";

export const VERIFIED_ANTIGRAVITY_LS_VERSION = "cli-1.5.14";
// F-0009, design/antigravity-harness.md#hooks
export const PRE_TOOL_USE_PASSTHROUGH = "";

export const ANTIGRAVITY_STEP_TYPES = Object.freeze(["USER_INPUT", "PLANNER_RESPONSE", "GENERIC", "SYSTEM_MESSAGE", "CHECKPOINT"]);

export const ANTIGRAVITY_FILE_TOOL_MAP = Object.freeze({
  read_file: { canonical: "Read" },
  write_file: { canonical: "Write" },
  edit_file: { canonical: "Edit" },
  view_file: { canonical: "Read" },
  view_file_outline: { canonical: "Read" },
  view_code_item: { canonical: "Read" },
  write_to_file: { canonical: "Write" },
  replace_file_content: { canonical: "Edit" },
  multi_replace_file_content: { canonical: "Edit" },
  code_action: { canonical: "Edit" },
  file_change: { canonical: "Edit" },
  write_blob: { canonical: "Write" },
  edit_notebook: { canonical: "Edit" },
  list_dir: { canonical: "Glob" },
  list_directory: { canonical: "Glob" },
  find_by_name: { canonical: "Glob" },
  grep_search: { canonical: "Grep" },
  code_search: { canonical: "Grep" },
});

export const ANTIGRAVITY_WRITE_TOOLS = new Set(
  Object.entries(ANTIGRAVITY_FILE_TOOL_MAP)
    .filter(([, spec]) => spec.canonical === "Write" || spec.canonical === "Edit")
    .map(([name]) => name)
);

export const ANTIGRAVITY_SHELL_TOOLS = new Set(["run_command", "shell_exec"]);

export const ANTIGRAVITY_SCALAR_PATH_KEYS = Object.freeze([
  "path", "Path", "file_path", "notebook_path",
  "AbsolutePath", "File", "TargetFile", "DirectoryPath", "SearchPath", "SearchDirectory",
  "worktreePath", "workspaceRoot", "destinationPath",
]);

export const ANTIGRAVITY_ARRAY_PATH_KEYS = Object.freeze(["paths"]);

const ANTIGRAVITY_NATIVE_DELEGATION_TOOLS = new Set([
  "invoke_subagent", "run_workflow", "define_subagent", "swarm", "send_message", "browser_subagent",
]);

// F-0008, F-0009, D-0060, design/mandatory-control-plane.md#2
const T3_DELEGATION_BASES = ["delegate_task", "t3_thread_launch", "create_threads"];
export const ANTIGRAVITY_DELEGATION_TOOLS = new Set([
  "invoke_subagent",
  "run_workflow",
  "swarm",
  ...T3_DELEGATION_BASES.flatMap(base => [base, `mcp_t3-code_${base}`, `mcp__t3-code__${base}`]),
]);

export const T3_MCP_TOOL_PREFIX = /^(?:mcp_t3[-_]code_|mcp__t3[-_]code__)(.+)$/;

// F-0009, design/antigravity-harness.md#audit
const T3_MCP_READ_ONLY_ALLOWLIST = new Set([
  "t3_thread_read", "t3_thread_list", "t3_thread_search", "t3_project_list", "t3_project_read",
  "t3_environment_read", "t3_environment_links", "t3_worktree_status", "t3_worktree_list",
  "list_scheduled_tasks", "orchestrator_capabilities", "pull_request_read", "pull_request_list",
  "ci_logs", "list_issues", "read_issue", "list_thread_pull_requests", "list_thread_issues",
  "read_pull_request_guide", "t3_preview_list", "preview_status", "html_preview",
]);

export function isDisallowedRoleTool(name) {
  if (typeof name !== "string" || !name) return false;
  if (ANTIGRAVITY_NATIVE_DELEGATION_TOOLS.has(name)) return true;
  const m = T3_MCP_TOOL_PREFIX.exec(name);
  if (m) return !T3_MCP_READ_ONLY_ALLOWLIST.has(m[1]);
  return false;
}

const TOOL_CALL_ARG_KEYS = Object.freeze(["args", "arguments", "argumentsJson"]);
const EMBEDDED_FILE_URL_RE = /file:\/\/[^\s"'<>`]+/gi;
const MAX_ARG_TRAVERSAL_DEPTH = 32;
const COMPACT_TRUNCATED_RE = /\n<truncated \d+ bytes>$/;
const APP_SUBDIRS = ["antigravity-acp", "antigravity", "antigravity-cli", "antigravity-ide"];
const BRACKET_OPENERS = Object.freeze({ ")": "(", "]": "[", "}": "{" });
const isPlainObject = v => v !== null && typeof v === "object" && !Array.isArray(v);

export function geminiHome(env = process.env, home = env?.HOME || homedir()) {
  return env?.GEMINI_HOME !== undefined && env.GEMINI_HOME !== ""
    ? resolve(env.GEMINI_HOME)
    : join(home, ".gemini");
}

function t3Home(env = process.env, home = env?.HOME || homedir()) {
  if (env?.T3CODE_HOME === "") return null;
  return env?.T3CODE_HOME !== undefined ? resolve(env.T3CODE_HOME) : join(home, ".t3");
}

export function t3AntigravityInstances({ env = process.env, home = env?.HOME || homedir() } = {}) {
  const t3 = t3Home(env, home);
  if (!t3) return [];
  const base = join(t3, "userdata", "providers", "antigravity");
  if (!existsSync(base)) return [];
  let entries;
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(e => {
      const root = join(base, e.name);
      return {
        id: e.name,
        root,
        hooksFile: join(root, "config", "hooks.json"),
        appDataDir: join(root, "antigravity-acp"),
      };
    });
}

export function antigravityAppDirs({ env = process.env, home = env?.HOME || homedir() } = {}) {
  const candidates = [];
  if (env?.ANTIGRAVITY_APP_DATA_DIR) candidates.push(resolve(env.ANTIGRAVITY_APP_DATA_DIR));
  const gHome = geminiHome(env, home);
  for (const sub of APP_SUBDIRS) candidates.push(join(gHome, sub));
  for (const inst of t3AntigravityInstances({ env, home })) candidates.push(inst.appDataDir);
  const seen = new Set();
  const out = [];
  for (const dir of candidates) {
    const brain = join(dir, "brain");
    try { if (!statSync(brain).isDirectory()) continue; } catch { continue; }
    const key = canonical(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dir);
  }
  return out;
}

export function resolveAuthoritativeTranscript(file) {
  const abs = resolve(file);
  if (basename(abs) === "transcript.jsonl") {
    const full = join(dirname(abs), "transcript_full.jsonl");
    if (existsSync(full)) return full;
  }
  return abs;
}

export function conversationIdFromPath(file) {
  const abs = resolve(file);
  const logsDir = dirname(abs);
  const sysDir = dirname(logsDir);
  const convDir = dirname(sysDir);
  const brainDir = dirname(convDir);
  if (basename(logsDir) === "logs" && basename(sysDir) === ".system_generated" && basename(brainDir) === "brain") {
    return basename(convDir) || null;
  }
  return null;
}

export function appDirFromTranscriptPath(file) {
  const abs = resolve(file);
  const logsDir = dirname(abs);
  const sysDir = dirname(logsDir);
  const convDir = dirname(sysDir);
  const brainDir = dirname(convDir);
  if (basename(logsDir) === "logs" && basename(sysDir) === ".system_generated" && basename(brainDir) === "brain") {
    return dirname(brainDir);
  }
  return null;
}

function decodeWorkspaceUris(raw) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let uris;
  try { uris = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(uris)) return [];
  return uris.flatMap(u => {
    if (typeof u !== "string" || !u) return [];
    if (u.startsWith("file://")) {
      try { return [fileURLToPath(u)]; } catch { return []; }
    }
    return [u];
  });
}

function loadSqlite() {
  return createRequire(import.meta.url)("node:sqlite");
}

export function readConversationSummaries(appDir, { sqliteLoader = loadSqlite } = {}) {
  const dbPath = join(appDir, "conversation_summaries.db");
  if (!existsSync(dbPath)) return { state: "unavailable", reason: "conversation_summaries.db missing" };
  let sqlite;
  try { sqlite = sqliteLoader(); }
  catch { return { state: "unavailable", reason: "node:sqlite unavailable (requires Node >= 22.13)" }; }
  if (!sqlite?.DatabaseSync) return { state: "unavailable", reason: "node:sqlite unavailable (requires Node >= 22.13)" };
  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true, timeout: 5000 });
    const rawRows = db.prepare("SELECT * FROM conversation_summaries").all();
    const rows = new Map();
    for (const row of rawRows) {
      if (typeof row?.conversation_id !== "string" || !row.conversation_id) continue;
      rows.set(row.conversation_id, {
        conversation_id: row.conversation_id,
        workspaces: decodeWorkspaceUris(row.workspace_uris),
        status: row.status ?? "",
        parent_conversation_id: row.parent_conversation_id ?? "",
        nesting_depth: Number(row.nesting_depth ?? 0),
        killed: Number(row.killed ?? 0),
        not_fully_idle: Number(row.not_fully_idle ?? 0),
        source: row.source ?? "",
        agent_name: row.agent_name ?? "",
        last_user_input_step_index: row.last_user_input_step_index ?? null,
        app_data_dir: row.app_data_dir ?? "",
        group_id: row.group_id ?? "",
      });
    }
    return {
      state: "ok",
      rows,
      get(id) {
        return rows.has(id) ? { state: "ok", summary: rows.get(id) } : { state: "missing-row" };
      },
    };
  } catch (error) {
    return { state: "unavailable", reason: error?.message ?? String(error) };
  } finally {
    try { db?.close(); } catch {}
  }
}

// F-0009, design/antigravity-harness.md#envelope
export function unwrapAntigravityUserText(raw) {
  if (typeof raw !== "string") return null;
  if (!raw.startsWith("<USER_REQUEST>") && !raw.startsWith("<t3_code_instructions>")) return raw;
  let s = raw.trimEnd();
  if (s.startsWith("<USER_REQUEST>")) {
    for (;;) {
      let cut = false;
      for (const tag of ["USER_SETTINGS_CHANGE", "ADDITIONAL_METADATA"]) {
        const close = `</${tag}>`;
        const open = `<${tag}>`;
        if (s.endsWith(close)) {
          const idx = s.lastIndexOf(open);
          if (idx !== -1) {
            s = s.slice(0, idx).trimEnd();
            cut = true;
            break;
          }
        }
      }
      if (!cut) break;
    }
    const closeReq = "</USER_REQUEST>";
    if (!s.endsWith(closeReq)) return null;
    s = s.slice("<USER_REQUEST>".length, -closeReq.length);
    s = s.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  }
  if (s.startsWith("<t3_code_instructions>")) {
    const endInstr = s.indexOf("</t3_code_instructions>");
    if (endInstr === -1) return null;
    s = s.slice(endInstr + "</t3_code_instructions>".length).replace(/^(?:\r?\n)+/, "");
    const trimmed = s.trimEnd();
    if (trimmed.endsWith("</runtime_info>")) {
      const idx = trimmed.lastIndexOf("<runtime_info>");
      if (idx !== -1) s = trimmed.slice(0, idx).replace(/\r?\n$/, "");
    }
    const req = s.trimEnd();
    if (!req.startsWith("<user_request>") || !req.endsWith("</user_request>")) return null;
    s = req.slice("<user_request>".length, -"</user_request>".length);
    s = s.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  }
  return s;
}

export function antigravityFirstPrompt(rows) {
  const first = rows.find(r => r?.type === "USER_INPUT" && r.source === "USER_EXPLICIT" && typeof r.content === "string");
  if (!first) return "";
  return unwrapAntigravityUserText(first.content) ?? "";
}

// F-0009, design/antigravity-harness.md#status
export function antigravityStatus(rows, summary = null) {
  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]?.type === "USER_INPUT" && rows[i].source === "USER_EXPLICIT") { lastUserIdx = i; break; }
  }
  const afterUser = lastUserIdx >= 0 ? rows.slice(lastUserIdx + 1) : rows;
  if (Boolean(summary?.killed)
    || afterUser.some(r => r?.type === "PLANNER_RESPONSE" && (["ERROR", "CANCELED", "CANCELLED"].includes(r.status) || Boolean(r.error)))) {
    return "failed";
  }
  if (summary?.status === "CASCADE_RUN_STATUS_RUNNING" || Boolean(summary?.not_fully_idle)) return "pending";
  let lastPlanner = null;
  for (let i = afterUser.length - 1; i >= 0; i--) {
    if (afterUser[i]?.type === "PLANNER_RESPONSE") { lastPlanner = afterUser[i]; break; }
  }
  if (lastPlanner && lastPlanner.status === "DONE" && !(Array.isArray(lastPlanner.tool_calls) && lastPlanner.tool_calls.length > 0)) {
    return "complete";
  }
  if (summary?.status === "CASCADE_RUN_STATUS_IDLE" && !summary?.not_fully_idle
    && (!lastPlanner || (Array.isArray(lastPlanner.tool_calls) && lastPlanner.tool_calls.length > 0))) {
    return "failed";
  }
  return "pending";
}

export function isAntigravityHook(input, harnessFlag = null) {
  if (harnessFlag === "antigravity") return true;
  if (harnessFlag === "claude") return false;
  return input?.hookEventName === "SessionStart"
    || input?.hookEventName === "PreInvocation"
    || (input?.hookEventName === "PreToolUse" && ("conversationId" in input || "toolCall" in input))
    || (input?.hookEventName === "Stop" && ("conversationId" in input || "terminationReason" in input || "continuationActive" in input || "fullyIdle" in input))
    || typeof input?.conversationId === "string"
    || Boolean(isPlainObject(input) && "toolCall" in input);
}

// F-0008, F-0009, D-0052, D-0060, R-0032-reviewer-architecture
export function decodeToolCallArgs(toolCall) {
  if (toolCall === undefined) return { ok: true, present: false, args: {}, error: null };
  if (!isPlainObject(toolCall)) {
    return { ok: false, present: true, args: {}, error: "malformed toolCall (expected plain JSON object)" };
  }
  const carriers = TOOL_CALL_ARG_KEYS.filter(key => Object.hasOwn(toolCall, key) && toolCall[key] !== undefined);
  if (!carriers.length) return { ok: true, present: false, args: {}, error: null };
  const merged = {};
  for (const key of carriers) {
    const raw = toolCall[key];
    let parsed;
    if (isPlainObject(raw)) {
      parsed = raw;
    } else if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); }
      catch (err) { return { ok: false, present: true, args: {}, error: `malformed JSON in toolCall.${key} (${err.message})` }; }
      if (!isPlainObject(parsed)) {
        return { ok: false, present: true, args: {}, error: `toolCall.${key} must decode to a plain JSON object` };
      }
    } else {
      return { ok: false, present: true, args: {}, error: `toolCall.${key} must be a plain JSON object or JSON object string` };
    }
    for (const [prop, val] of Object.entries(parsed)) {
      if (Object.hasOwn(merged, prop) && JSON.stringify(merged[prop]) !== JSON.stringify(val)) {
        return { ok: false, present: true, args: {}, error: `conflicting values for "${prop}" across toolCall argument fields` };
      }
      Object.defineProperty(merged, prop, { value: val, enumerable: true, writable: true, configurable: true });
    }
  }
  return { ok: true, present: true, args: merged, error: null };
}

export function extractHookDirs(input) {
  const raw = [input?.cwd, ...(Array.isArray(input?.workspacePaths) ? input.workspacePaths : [])];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item) continue;
    let dir = item;
    if (/^file:\/\//i.test(dir)) {
      try { dir = fileURLToPath(dir); } catch {}
    }
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(dir);
  }
  return out;
}

function trimFileUrlTail(raw) {
  let s = raw.trim();
  for (;;) {
    if (s.endsWith(",") || s.endsWith(";")) { s = s.slice(0, -1); continue; }
    const last = s.at(-1);
    const opener = BRACKET_OPENERS[last];
    if (opener) {
      let opens = 0, closes = 0;
      for (const ch of s) {
        if (ch === opener) opens++;
        else if (ch === last) closes++;
      }
      if (closes > opens) { s = s.slice(0, -1); continue; }
    }
    break;
  }
  return s;
}

function decodeFileUrl(value) {
  const cleaned = trimFileUrlTail(value);
  if (!/^file:\/\//i.test(cleaned)) return null;
  try { return fileURLToPath(cleaned); } catch { return cleaned.replace(/^file:\/\//i, ""); }
}

function collectFileUrls(value, out, depth = 0, seen = new WeakSet()) {
  if (value == null || depth > MAX_ARG_TRAVERSAL_DEPTH) return;
  if (typeof value === "string") {
    if (!/file:\/\//i.test(value)) return;
    for (const match of value.matchAll(EMBEDDED_FILE_URL_RE)) {
      const decoded = decodeFileUrl(match[0]);
      if (decoded) out.add(decoded);
    }
    return;
  }
  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectFileUrls(item, out, depth + 1, seen);
    return;
  }
  for (const v of Object.values(value)) collectFileUrls(v, out, depth + 1, seen);
}

function decodeStructuredPath(value) {
  const trimmed = value.trim();
  if (!/^file:\/\//i.test(trimmed)) return value;
  try { return fileURLToPath(trimmed); } catch { return trimmed.replace(/^file:\/\//i, ""); }
}

export function extractStructuredToolPaths(args) {
  if (!isPlainObject(args)) return [];
  const found = new Set();
  for (const key of ANTIGRAVITY_SCALAR_PATH_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.trim()) {
      const decoded = decodeStructuredPath(v);
      if (decoded) found.add(decoded);
    }
  }
  for (const key of ANTIGRAVITY_ARRAY_PATH_KEYS) {
    const v = args[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item.trim()) {
          const decoded = decodeStructuredPath(item);
          if (decoded) found.add(decoded);
        }
      }
    }
  }
  return [...found];
}

export function extractToolPaths(args) {
  if (!isPlainObject(args)) return [];
  const found = new Set(extractStructuredToolPaths(args));
  collectFileUrls(args, found);
  return [...found];
}

export function decodeCompactArg(raw) {
  if (typeof raw !== "string") return { ok: true, truncated: false, value: raw };
  if (COMPACT_TRUNCATED_RE.test(raw)) return { ok: false, truncated: true, value: null };
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"')) return { ok: false, truncated: true, value: null };
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === "string" ? { ok: true, truncated: false, value: parsed } : { ok: false, truncated: false, value: null };
    } catch { return { ok: false, truncated: false, value: null }; }
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? { ok: true, truncated: false, value: parsed } : { ok: false, truncated: false, value: null };
    } catch { return { ok: false, truncated: false, value: null }; }
  }
  return { ok: true, truncated: false, value: raw };
}
