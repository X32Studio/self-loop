// The access audit of one agent call, from its structured tool events. Two tiers, so the gate never kills legitimate
// work:
// - violations (certain, blocking): structured tool fields only. Confined mode (the frame reviewer, backtests): a file
//   tool given a path outside `visible`, or a tool that is not allowed. Worktree mode (critic, actor, judge, who need a
//   shell): a file tool given a path inside a `forbidden` root; other outside paths are flags, since a test run may
//   legitimately leave output in a temporary directory.
//   A file-tool call the permission layer refused (its tool_result is an error) accessed nothing: it is `denied`.
// - flags (screening): shell command text that seems to name an outside path, a parent directory or a forbidden root
//   (text can name paths that are never opened); a log of unknown shape with no recognised tool event.
// Paths are compared canonically: relative paths resolve against the call's working directory, then every path and
// root is resolved through the file system (`/tmp` and `/private/tmp`, symlinked folders), the part that does not exist
// yet (a file about to be written) appended to its deepest existing folder. So the same approved file is never a
// violation however it is spelled, and a symlink inside a visible root that leads outside it is.
// Module: auditAccess(visible, [{ id, event }], options). CLI: node audit-access.mjs <work-dir> (reads logs/*.jsonl).
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const system = /^\/(bin|usr|dev\/null|opt\/homebrew|System|Library\/Developer)(\/|$)/;
export const FILE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"];
const SHELL_TOOLS = ["Bash"];

/** The canonical absolute form of a path: real folders, the not-yet-existing rest appended. */
export function canonical(path) {
  let head = resolve(path);
  const rest = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch {}
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    rest.unshift(basename(head));
    head = parent;
  }
}

/**
 * @param visible one root or several
 * @param options.tools allowed tool names (default: file tools only); null allows every tool
 * @param options.forbidden roots whose access is a violation; when given, other outside paths are only flagged
 * @param options.cwd the call's working directory, for relative paths (default: the first visible root)
 */
export function auditAccess(visible, events, { tools = FILE_TOOLS, forbidden = null, cwd = null } = {}) {
  const roots = [visible].flat().map(canonical);
  const banned = forbidden ? [forbidden].flat().map(canonical) : [];
  const base = cwd ?? [visible].flat()[0];
  const where = p => canonical(resolve(base, String(p).replace(/^~\//, `${process.env.HOME}/`)));
  const within = (list, p) => { const abs = where(p); return list.some(r => abs === r || abs.startsWith(`${r}/`)); };
  const violations = [];
  const denied = [];
  const flags = [];
  const refused = new Set();
  for (const { event } of events)
    if (event.type === "user") for (const part of event.message?.content ?? []) if (part.type === "tool_result" && part.is_error) refused.add(part.tool_use_id);
  const KNOWN = new Set(["assistant", "user", "system", "result", "rate_limit_event", "stream_event", "thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.updated", "item.completed", "error"]);
  let unrecognized = 0, toolEvents = 0, unparsedCalls = 0;
  const screenCommand = (id, command) => {
    for (const match of command.matchAll(/(?:^|[\s'"=])((?:\/|~\/)[^\s'"]*)/g)) {
      const path = match[1];
      if (banned.length && within(banned, path)) flags.push({ id, command, path, forbidden: true });
      else if (!system.test(path) && !within(roots, path)) flags.push({ id, command, path });
    }
    if (/(^|[\s'"/])\.\.(\/|$|[\s'"])/.test(command)) flags.push({ id, command, path: "(parent directory reference)" });
  };
  const filePath = (id, tool, path, rejected) => {
    const record = rejected ? denied : violations;
    if (forbidden) {
      if (within(banned, path)) record.push({ id, tool, path });
      else if (!within(roots, path)) flags.push({ id, tool, path });
    } else if (!within(roots, path)) record.push({ id, tool, path });
  };
  for (const { id, event } of events) {
    if (!KNOWN.has(event.type)) unrecognized++;
    if (event.type === "unparsed_tool_call") unparsedCalls++;
    if (event.type === "assistant") {
      for (const part of event.message?.content ?? []) {
        if (part.type !== "tool_use") continue;
        toolEvents++;
        const record = refused.has(part.id) ? denied : violations;
        if (tools && !tools.includes(part.name)) record.push({ id, tool: part.name, path: "(tool not allowed)" });
        if (SHELL_TOOLS.includes(part.name) && typeof part.input?.command === "string") screenCommand(id, part.input.command);
        for (const key of ["file_path", "path", "notebook_path"]) {
          const value = part.input?.[key];
          if (!value) continue;
          filePath(id, part.name, value, refused.has(part.id));
        }
      }
    }
    if (event.type !== "item.completed") continue;
    if (event.item?.type === "command_execution") { toolEvents++; screenCommand(id, event.item.command); }
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
      for (const path of paths) if (typeof path === "string" && path) filePath(id, "Edit", path, status === "failed");
    }
  }
  if (unparsedCalls) flags.push({ id: events[0]?.id ?? "-", path: "(insufficient evidence)", detail: `${unparsedCalls} tool call record(s) could not be audited` });
  else if (unrecognized && !toolEvents) flags.push({ id: events[0]?.id ?? "-", path: "(insufficient evidence)", detail: `${unrecognized} event(s) of an unknown shape and no recognised tool event` });
  return { violations, denied, flags, unrecognized };
}

/** JSON events from a CLI's stream output (Claude stream-json or Codex --json); other lines are ignored. */
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
