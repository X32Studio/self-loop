// D-0061, F-0015, R-0032-reviewer-architecture, R-0041-judge-final, R-0055-judge-frame-alphax, design/suite-once.md#2, design/antigravity-multi-product-hooks.md#1
import { createHash } from "node:crypto";
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
export const MAX_COMMAND_PREVIEW_CHARS = 240;
export const MAX_PATHS_PER_COMMAND = 16;
export const MAX_ORDINARY_FLAGS = 256;
export const MAX_AUDIT_JSON_BYTES = 1048576;

const system = /^\/(bin|usr|dev\/null|opt\/homebrew|System|Library\/Developer)(\/|$)/;
export const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const SHELL_TOOLS = ["Bash"];
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const normCommand = cmd => String(cmd).trim().replace(/\s+/g, " ");
const isTier0Flag = f => Boolean(f && (f.forbidden === true || f.path === "(duplicate suite run)" || f.path === "(insufficient evidence)"));

export const truncateCommandPreview = (command, maxChars = MAX_COMMAND_PREVIEW_CHARS) => {
  const str = String(command ?? "");
  return str.length <= maxChars ? str : `${str.slice(0, maxChars)}… [+${str.length - maxChars} chars]`;
};

export const commandHashOf = command => createHash("sha256").update(String(command ?? "")).digest("hex").slice(0, 16);

function shrinkRecord(entry, cmdMax, pathMax) {
  if (!entry || typeof entry !== "object") return entry;
  const out = { ...entry };
  if (typeof out.command === "string") out.command = truncateCommandPreview(out.command, cmdMax);
  for (const k of ["path", "detail", "target"]) if (typeof out[k] === "string" && out[k].length > pathMax) out[k] = truncateCommandPreview(out[k], pathMax);
  return out;
}

export function serializeBoundedAudit(audit, maxBytes = MAX_AUDIT_JSON_BYTES) {
  const copy = { ...audit };
  if (Array.isArray(copy.flags)) copy.flags = [...copy.flags.filter(isTier0Flag), ...copy.flags.filter(f => !isTier0Flag(f))];
  const render = (obj, indent) => `${indent ? JSON.stringify(obj, null, indent) : JSON.stringify(obj)}\n`;
  const fits = (obj, indent) => { const s = render(obj, indent); return Buffer.byteLength(s, "utf8") <= maxBytes ? s : null; };
  const initial = fits(copy, 2);
  if (initial) return initial;

  const fitSlice = (assign, total, indent) => {
    let lo = 0, hi = total, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      assign(mid);
      if (fits(copy, indent)) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    assign(best);
    return fits(copy, indent);
  };
  const shrinkAll = (cmdMax, pathMax) => {
    for (const k of ["violations", "denied", "flags", "duplicateSuiteRuns"]) {
      if (Array.isArray(copy[k])) copy[k] = copy[k].map(e => shrinkRecord(e, cmdMax, pathMax));
    }
  };
  copy.truncated = true;
  copy.truncatedCounts = {
    violations: Array.isArray(copy.violations) ? copy.violations.length : 0,
    denied: Array.isArray(copy.denied) ? copy.denied.length : 0,
    flags: Array.isArray(copy.flags) ? copy.flags.length : 0,
    duplicateSuiteRuns: Array.isArray(copy.duplicateSuiteRuns) ? copy.duplicateSuiteRuns.length : 0,
  };
  shrinkAll(MAX_COMMAND_PREVIEW_CHARS, 240);
  let out = fits(copy, 1);
  if (out) return out;
  if (Array.isArray(copy.flags)) {
    const t0 = copy.flags.filter(isTier0Flag), t1 = copy.flags.filter(f => !isTier0Flag(f));
    out = fitSlice(n => { copy.flags = [...t0, ...t1.slice(0, n)]; }, t1.length, 1);
    if (out) return out;
    copy.flags = t0;
  }
  if (Array.isArray(copy.excludedOutPaths)) {
    for (const limit of [32, 8, 0]) {
      copy.excludedOutPaths = copy.excludedOutPaths.slice(0, limit);
      out = fits(copy, 1);
      if (out) return out;
    }
  }
  shrinkAll(120, 120);
  out = fits(copy, 0);
  if (out) return out;
  for (const field of ["denied", "violations", "duplicateSuiteRuns", "flags"]) {
    if (!Array.isArray(copy[field]) || !copy[field].length) continue;
    const items = copy[field];
    out = fitSlice(n => { copy[field] = items.slice(0, n); }, items.length, 0);
    if (out) return out;
    copy[field] = [];
  }
  return render(copy, 0);
}

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
  const violations = [], denied = [], flags = [], duplicateSuiteRuns = [];
  let ordinaryFlags = 0, omittedFlags = 0;
  const pushOrdinary = entry => { if (ordinaryFlags < MAX_ORDINARY_FLAGS) { flags.push(entry); ordinaryFlags++; } else omittedFlags++; };
  const stagedTarget = typeof stagedSuiteCommand === "string" && stagedSuiteCommand.trim() ? normCommand(stagedSuiteCommand) : null;
  let worktreeModified = false;
  const noteWrite = (p, rejected) => {
    if (rejected || !baseCanonical) return;
    const abs = where(p);
    if ((abs === baseCanonical || abs.startsWith(`${baseCanonical}/`)) && abs !== outRoot && !abs.startsWith(`${outRoot}/`)) worktreeModified = true;
  };
  const isDuplicateSuite = command => {
    if (!stagedTarget || worktreeModified) return false;
    const normalized = normCommand(command);
    if (normalized === stagedTarget) return true;
    const cdMatch = /^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)\s*(.+)$/.exec(normalized);
    if (!cdMatch) return false;
    return normCommand(cdMatch[4]) === stagedTarget && within(roots, cdMatch[1] ?? cdMatch[2] ?? cdMatch[3]);
  };
  const refused = new Set();
  for (const { event } of events)
    if (event.type === "user") for (const part of event.message?.content ?? []) if (part.type === "tool_result" && part.is_error) refused.add(part.tool_use_id);
  const KNOWN = new Set(["assistant", "user", "system", "result", "rate_limit_event", "stream_event", "thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error", ...ANTIGRAVITY_STEP_TYPES]);
  let unrecognized = 0, toolEvents = 0, unparsedCalls = 0;
  const screenCommand = (id, command, rejected = false) => {
    const seen = new Set(), matched = [];
    let ordinaryTotal = 0;
    for (const match of command.matchAll(/(?:^|[\s'"=])((?:\/|~\/)[^\s'"]*)/g)) {
      const path = match[1];
      if (seen.has(path)) continue;
      seen.add(path);
      if (banned.length && within(banned, path)) matched.push({ path, forbidden: true });
      else if (!system.test(path) && !within(roots, path)) { matched.push({ path, forbidden: false }); ordinaryTotal++; }
    }
    const truncated = command.length > MAX_COMMAND_PREVIEW_CHARS;
    const capped = ordinaryTotal > MAX_PATHS_PER_COMMAND;
    const preview = truncated ? truncateCommandPreview(command, MAX_COMMAND_PREVIEW_CHARS) : command;
    const cmdMeta = (truncated || capped) ? { commandHash: commandHashOf(command), commandBytes: Buffer.byteLength(command, "utf8") } : null;
    const truncMeta = truncated ? cmdMeta : null;
    const extraOrdinary = capped ? ordinaryTotal - MAX_PATHS_PER_COMMAND : 0;
    const keptLimit = Math.min(ordinaryTotal, MAX_PATHS_PER_COMMAND);
    let ordinarySeen = 0;
    for (const item of matched) {
      if (item.forbidden) flags.push({ id, command: preview, path: item.path, forbidden: true, ...(cmdMeta ?? {}) });
      else if (ordinarySeen < MAX_PATHS_PER_COMMAND) {
        ordinarySeen++;
        pushOrdinary({ id, command: preview, path: item.path, ...(cmdMeta ?? {}), ...(extraOrdinary && ordinarySeen === keptLimit ? { extraPathCount: extraOrdinary } : {}) });
      }
    }
    if (extraOrdinary) omittedFlags += extraOrdinary;
    if (/(^|[\s'"/])\.\.(\/|$|[\s'"])/.test(command)) pushOrdinary({ id, command: preview, path: "(parent directory reference)", ...(truncMeta ?? {}) });
    if (!rejected && isDuplicateSuite(command)) {
      const entry = { id, command: preview, path: "(duplicate suite run)", detail: `re-ran staged suite command "${stagedTarget}" on unchanged worktree`, ...(truncMeta ?? {}) };
      duplicateSuiteRuns.push(entry);
      flags.push(entry);
    }
  };
  const filePath = (id, tool, path, rejected) => {
    const record = rejected ? denied : violations;
    if (forbidden) {
      if (within(banned, path)) record.push({ id, tool, path });
      else if (!within(roots, path)) pushOrdinary({ id, tool, path });
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
        const rejected = (canCreditDenied ? generics[k] : null)?.status === "ERROR";
        const record = rejected ? denied : violations;
        const fileSpec = Object.hasOwn(ANTIGRAVITY_FILE_TOOL_MAP, tc.name) ? ANTIGRAVITY_FILE_TOOL_MAP[tc.name] : null;
        const isShell = ANTIGRAVITY_SHELL_TOOLS.has(tc.name);
        let decodedArgs = decodedTc.args, pathOrUrlDecodeFailed = false, shellDecodeFailed = false;
        if (stepTruncated) {
          decodedArgs = {};
          for (const [key, val] of Object.entries(decodedTc.args)) {
            if (typeof val !== "string") { decodedArgs[key] = val; continue; }
            const decoded = decodeCompactArg(val);
            if (decoded.ok) decodedArgs[key] = decoded.value;
            else if (ANTIGRAVITY_SCALAR_PATH_KEYS.includes(key) || ANTIGRAVITY_ARRAY_PATH_KEYS.includes(key) || (!fileSpec && !isShell && /file:\/\//i.test(val))) pathOrUrlDecodeFailed = true;
            else if (key === "CommandLine" || key === "command") shellDecodeFailed = true;
          }
        }
        if (isDisallowedRoleTool(tc.name)) record.push({ id, tool: tc.name, path: "(delegation/disallowed tool not allowed in role audit)" });
        if (tools && !tools.includes(tc.name) && !(fileSpec && tools.includes(fileSpec.canonical))) record.push({ id, tool: tc.name, path: "(tool not allowed)" });
        const paths = (fileSpec || isShell) ? extractStructuredToolPaths(decodedArgs) : extractToolPaths(decodedArgs);
        for (const p of paths) {
          filePath(id, tc.name, p, rejected);
          if (fileSpec && WRITE_TOOLS.has(fileSpec.canonical)) noteWrite(p, rejected);
        }
        if (pathOrUrlDecodeFailed) { unparsedCalls++; record.push({ id, tool: tc.name, path: "(truncated/unparseable tool argument)" }); }
        else if (fileSpec && paths.length === 0) { unparsedCalls++; if (stepTruncated) record.push({ id, tool: tc.name, path: "(truncated/unparseable tool argument)" }); }
        if (isShell) {
          const cmd = decodedArgs.CommandLine ?? decodedArgs.command;
          if (shellDecodeFailed || typeof cmd !== "string" || !cmd) { unparsedCalls++; if (stepTruncated) record.push({ id, tool: tc.name, path: "(truncated/unparseable tool argument)" }); }
          else screenCommand(id, cmd, rejected);
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
        unrecognized++; unparsedCalls++; continue;
      }
      toolEvents++;
      for (const path of new Set(entries.flatMap(([path, change]) => [path, change?.move_path]))) if (typeof path === "string" && path) {
        filePath(id, "Edit", path, status === "failed");
        noteWrite(path, status === "failed");
      }
    }
  }
  if (unparsedCalls) flags.push({ id: events[0]?.id ?? "-", path: "(insufficient evidence)", detail: `${unparsedCalls} tool call record(s) could not be audited` });
  else if (unrecognized && !toolEvents) flags.push({ id: events[0]?.id ?? "-", path: "(insufficient evidence)", detail: `${unrecognized} event(s) of an unknown shape and no recognised tool event` });
  return { violations, denied, flags, duplicateSuiteRuns, unrecognized, unparsedCalls, toolEvents, ...(omittedFlags ? { omittedFlags } : {}) };
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
  process.stdout.write(serializeBoundedAudit({ violations, flags }));
  process.exitCode = violations.length ? 3 : 0;
}
