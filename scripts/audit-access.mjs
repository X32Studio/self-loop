// D-0061, R-0032-reviewer-architecture, R-0041-judge-final, design/suite-once.md#2, design/antigravity-multi-product-hooks.md#1
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANTIGRAVITY_ARRAY_PATH_KEYS,
  ANTIGRAVITY_FILE_TOOL_MAP,
  ANTIGRAVITY_SCALAR_PATH_KEYS,
  ANTIGRAVITY_SHELL_TOOLS,
  ANTIGRAVITY_STEP_TYPES,
  decodeCompactArg,
  decodeToolCallArgs,
  extractStructuredToolPaths,
  extractToolPaths,
  isDisallowedRoleTool,
} from "./lib/antigravity.mjs";
import { canonical } from "./lib/path-canonical.mjs";

export { canonical };

const system = /^\/(bin|usr|dev\/null|opt\/homebrew|System|Library\/Developer)(\/|$)/;
export const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const SHELL_TOOLS = ["Bash"];
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const normCommand = cmd => String(cmd).trim().replace(/\s+/g, " ");

export function auditAccess(visible, events, { tools = FILE_TOOLS, forbidden = null, cwd = undefined, stagedSuiteCommand = null } = {}) {
  const roots = [visible].flat().map(canonical);
  const banned = forbidden ? [forbidden].flat().map(canonical) : [];
  const unknownCwd = cwd === null;
  const base = cwd === undefined ? [visible].flat()[0] : cwd;
  const baseCanonical = !unknownCwd && base ? canonical(base) : null;
  const outRoot = join(roots[0], "out");
  const isAbsOrHome = p => { const s = String(p); return isAbsolute(s) || s.startsWith("~/"); };
  const where = p => canonical(resolve(base, String(p).replace(/^~\//, `${process.env.HOME}/`)));
  const within = (list, p) => {
    if (unknownCwd && !isAbsOrHome(p)) return false;
    const abs = unknownCwd ? canonical(String(p).replace(/^~\//, `${process.env.HOME}/`)) : where(p);
    return list.some(r => abs === r || abs.startsWith(`${r}/`));
  };
  const violations = [];
  const denied = [];
  const flags = [];
  const duplicateSuiteRuns = [];
  const stagedTarget = typeof stagedSuiteCommand === "string" && stagedSuiteCommand.trim() ? normCommand(stagedSuiteCommand) : null;
  let worktreeModified = false;
  const noteWrite = (p, rejected) => {
    if (rejected || !baseCanonical) return;
    const abs = where(p);
    if ((abs === baseCanonical || abs.startsWith(`${baseCanonical}/`)) && abs !== outRoot && !abs.startsWith(`${outRoot}/`)) {
      worktreeModified = true;
    }
  };
  const isDuplicateSuite = command => {
    if (!stagedTarget || worktreeModified) return false;
    const normalized = normCommand(command);
    if (normalized === stagedTarget) return true;
    const cdMatch = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/.exec(normalized);
    if (!cdMatch) return false;
    const cdTarget = cdMatch[1] ?? cdMatch[2] ?? cdMatch[3];
    return normCommand(cdMatch[4]) === stagedTarget && within(roots, cdTarget);
  };
  const refused = new Set();
  for (const { event } of events)
    if (event.type === "user") for (const part of event.message?.content ?? []) if (part.type === "tool_result" && part.is_error) refused.add(part.tool_use_id);
  const KNOWN = new Set(["assistant", "user", "system", "result", "rate_limit_event", "stream_event", "thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error", ...ANTIGRAVITY_STEP_TYPES]);
  let unrecognized = 0, toolEvents = 0, unparsedCalls = 0;
  const screenCommand = (id, command, rejected = false) => {
    for (const match of command.matchAll(/(?:^|[\s'"=])((?:\/|~\/)[^\s'"]*)/g)) {
      const path = match[1];
      if (banned.length && within(banned, path)) flags.push({ id, command, path, forbidden: true });
      else if (!system.test(path) && !within(roots, path)) flags.push({ id, command, path });
    }
    if (/(^|[\s'"/])\.\.(\/|$|[\s'"])/.test(command)) flags.push({ id, command, path: "(parent directory reference)" });
    if (!rejected && isDuplicateSuite(command)) {
      const entry = { id, command, path: "(duplicate suite run)", detail: `re-ran staged suite command "${stagedTarget}" on unchanged worktree` };
      duplicateSuiteRuns.push(entry);
      flags.push(entry);
    }
  };
  const filePath = (id, tool, path, rejected) => {
    const record = rejected ? denied : violations;
    if (forbidden) {
      if (within(banned, path)) record.push({ id, tool, path });
      else if (!within(roots, path)) flags.push({ id, tool, path });
    } else if (!within(roots, path)) record.push({ id, tool, path });
  };
  for (let i = 0; i < events.length; i++) {
    const { id, event } = events[i];
    if (!KNOWN.has(event.type)) unrecognized++;
    if (event.type === "unparsed_tool_call") unparsedCalls++;
    if (event.type === "assistant") {
      for (const part of event.message?.content ?? []) {
        if (part.type !== "tool_use") continue;
        toolEvents++;
        const rejected = refused.has(part.id);
        const record = rejected ? denied : violations;
        if (isDisallowedRoleTool(part.name)) record.push({ id, tool: part.name, path: "(delegation/disallowed tool not allowed in role audit)" });
        if (tools && !tools.includes(part.name)) record.push({ id, tool: part.name, path: "(tool not allowed)" });
        const isShell = SHELL_TOOLS.includes(part.name);
        const isFile = FILE_TOOLS.includes(part.name) || WRITE_TOOLS.has(part.name);
        if (isShell && typeof part.input?.command === "string") screenCommand(id, part.input.command, rejected);
        const paths = (isFile || isShell) ? extractStructuredToolPaths(part.input) : extractToolPaths(part.input);
        for (const value of paths) {
          filePath(id, part.name, value, rejected);
          if (WRITE_TOOLS.has(part.name)) noteWrite(value, rejected);
        }
        if (tools && !forbidden && isFile && paths.length === 0) filePath(id, part.name, ".", rejected);
      }
    }
    if (event.type === "PLANNER_RESPONSE" && Array.isArray(event.tool_calls)) {
      const stepTruncated = Array.isArray(event.truncated_fields) && event.truncated_fields.includes("tool_calls");
      if (stepTruncated) unparsedCalls++;
      const generics = [];
      let hasFollowingTurnStep = false;
      for (let j = i + 1; j < events.length && events[j].id === id; j++) {
        const nextType = events[j].event?.type;
        if (nextType === "GENERIC") { generics.push(events[j].event); continue; }
        if (nextType === "SYSTEM_MESSAGE" || nextType === "CHECKPOINT") continue;
        if (nextType === "PLANNER_RESPONSE" || nextType === "USER_INPUT") hasFollowingTurnStep = true;
        break;
      }
      const canCreditDenied = generics.length === event.tool_calls.length && hasFollowingTurnStep;
      if (!canCreditDenied && event.tool_calls.length > 0) unparsedCalls++;
      for (const [k, tc] of event.tool_calls.entries()) {
        const decodedTc = decodeToolCallArgs(tc);
        if (!tc || typeof tc.name !== "string" || !tc.name || !decodedTc.ok || !decodedTc.present) {
          unparsedCalls++;
          if (stepTruncated || !decodedTc.ok) violations.push({ id, tool: tc?.name ?? "(unknown)", path: "(truncated/unparseable tool argument)" });
          continue;
        }
        toolEvents++;
        const outcome = canCreditDenied ? generics[k] : null;
        const rejected = outcome?.status === "ERROR";
        const record = rejected ? denied : violations;
        const fileSpec = Object.hasOwn(ANTIGRAVITY_FILE_TOOL_MAP, tc.name) ? ANTIGRAVITY_FILE_TOOL_MAP[tc.name] : null;
        const isShell = ANTIGRAVITY_SHELL_TOOLS.has(tc.name);
        let decodedArgs = decodedTc.args;
        let pathOrUrlDecodeFailed = false;
        let shellDecodeFailed = false;
        if (stepTruncated) {
          decodedArgs = {};
          for (const [key, val] of Object.entries(decodedTc.args)) {
            if (typeof val === "string") {
              const decoded = decodeCompactArg(val);
              if (decoded.ok) decodedArgs[key] = decoded.value;
              else if (ANTIGRAVITY_SCALAR_PATH_KEYS.includes(key) || ANTIGRAVITY_ARRAY_PATH_KEYS.includes(key) || (!fileSpec && !isShell && /file:\/\//i.test(val))) {
                pathOrUrlDecodeFailed = true;
              } else if (key === "CommandLine" || key === "command") {
                shellDecodeFailed = true;
              }
            } else {
              decodedArgs[key] = val;
            }
          }
        }
        if (isDisallowedRoleTool(tc.name)) record.push({ id, tool: tc.name, path: "(delegation/disallowed tool not allowed in role audit)" });
        if (tools && !tools.includes(tc.name) && !(fileSpec && tools.includes(fileSpec.canonical))) {
          record.push({ id, tool: tc.name, path: "(tool not allowed)" });
        }
        const paths = (fileSpec || isShell) ? extractStructuredToolPaths(decodedArgs) : extractToolPaths(decodedArgs);
        for (const p of paths) {
          filePath(id, tc.name, p, rejected);
          if (fileSpec && WRITE_TOOLS.has(fileSpec.canonical)) noteWrite(p, rejected);
        }
        if (pathOrUrlDecodeFailed) {
          unparsedCalls++;
          record.push({ id, tool: tc.name, path: "(truncated/unparseable tool argument)" });
        } else if (fileSpec && paths.length === 0) {
          unparsedCalls++;
          if (stepTruncated) record.push({ id, tool: tc.name, path: "(truncated/unparseable tool argument)" });
        }
        if (isShell) {
          const cmd = decodedArgs.CommandLine ?? decodedArgs.command;
          if (shellDecodeFailed || typeof cmd !== "string" || !cmd) {
            unparsedCalls++;
            if (stepTruncated) record.push({ id, tool: tc.name, path: "(truncated/unparseable tool argument)" });
          } else {
            screenCommand(id, cmd, rejected);
          }
        }
      }
    }
    if (event.type !== "item.completed") continue;
    if (event.item?.type === "command_execution") { toolEvents++; screenCommand(id, event.item.command, false); }
    if (event.item?.type === "file_change") {
      const { changes, status } = event.item;
      const entries = Array.isArray(changes) ? changes.map(change => [change?.path, change])
        : changes && typeof changes === "object" ? Object.entries(changes) : [];
      if (!entries.length || entries.some(([path]) => typeof path !== "string" || !path) || !["completed", "failed"].includes(status)) {
        unrecognized++;
        unparsedCalls++;
        continue;
      }
      toolEvents++;
      const paths = new Set(entries.flatMap(([path, change]) => [path, change?.move_path]));
      for (const path of paths) if (typeof path === "string" && path) {
        filePath(id, "Edit", path, status === "failed");
        noteWrite(path, status === "failed");
      }
    }
  }
  if (unparsedCalls) flags.push({ id: events[0]?.id ?? "-", path: "(insufficient evidence)", detail: `${unparsedCalls} tool call record(s) could not be audited` });
  else if (unrecognized && !toolEvents) flags.push({ id: events[0]?.id ?? "-", path: "(insufficient evidence)", detail: `${unrecognized} event(s) of an unknown shape and no recognised tool event` });
  return { violations, denied, flags, duplicateSuiteRuns, unrecognized, unparsedCalls, toolEvents };
}

export function eventsOf(id, text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try { events.push({ id, event: JSON.parse(line) }); } catch {}
  }
  return events;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const work = resolve(process.argv[2]);
  const events = [];
  for (const file of readdirSync(join(work, "logs")).filter(f => f.endsWith(".jsonl")))
    events.push(...eventsOf(file.replace(/\.jsonl$/, ""), readFileSync(join(work, "logs", file), "utf8")));
  const { violations, flags } = auditAccess(join(work, "visible"), events);
  console.log(JSON.stringify({ violations, flags }, null, 2));
  process.exitCode = violations.length ? 3 : 0;
}
