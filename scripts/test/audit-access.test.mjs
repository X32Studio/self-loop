// F-0008, F-0009, F-0010, D-0052, D-0060, D-0061, R-0041-judge-final, R-0042-judge-final
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  auditAccess,
  commandHashOf,
  MAX_AUDIT_JSON_BYTES,
  MAX_COMMAND_PREVIEW_CHARS,
  MAX_ORDINARY_FLAGS,
  MAX_PATHS_PER_COMMAND,
  serializeBoundedAudit,
  truncateCommandPreview,
} from "../audit-access.mjs";
import { fixtures, redOn, temp } from "./helpers.mjs";

const FROZEN = JSON.parse(readFileSync(join(fixtures, "backtest-tool-events.json"), "utf8"));
const tool = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
const agTurn = (toolCalls, extra = {}) => [
  { id: "ag", event: { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: toolCalls, ...extra } },
  ...toolCalls.map(() => ({ id: "ag", event: { type: "GENERIC", status: "DONE" } })),
  { id: "ag", event: { type: "PLANNER_RESPONSE", status: "DONE" } },
];

test("green: the four real backtest runs have no violation under the confined rule", () => {
  let total = 0;
  for (const [run, { auditViolations, events }] of Object.entries(FROZEN.runs)) {
    total += events.length;
    assert.equal(auditViolations, 0, run);
    assert.deepEqual(auditAccess(inferVisible(events), events).violations, [], run);
  }
  assert.equal(Object.keys(FROZEN.runs).length, 4);
  assert.ok(FROZEN.totalEvents > 1000, `${FROZEN.totalEvents} events in the original logs`);
  assert.ok(total > 400, `${total} tool events replayed`);
});

function inferVisible(events) {
  const paths = [];
  for (const { event } of events) for (const part of event.message?.content ?? []) if (part.type === "tool_use") for (const k of ["file_path", "path"]) if (part.input?.[k]?.startsWith("/")) paths.push(part.input[k]);
  if (!paths.length) return "/nonexistent-visible-root";
  let prefix = paths[0];
  for (const p of paths) while (!p.startsWith(prefix)) prefix = prefix.slice(0, prefix.lastIndexOf("/"));
  return /\/visible(\/|$)/.test(prefix) ? prefix.slice(0, prefix.indexOf("/visible") + "/visible".length) : prefix;
}

test("red (constructed from real event shapes): a file tool outside the folder, or a tool not allowed", () => {
  const events = [
    { id: "01", event: tool("Read", { file_path: "/work/visible/snapshots/01/docs/PRODUCT.md" }) },
    { id: "01", event: tool("Read", { file_path: "/work/hidden/keys.md" }) },
    { id: "01", event: tool("Bash", { command: "ls" }) },
  ];
  const { violations } = auditAccess("/work/visible", events);
  assert.deepEqual(violations.map(v => v.path), ["/work/hidden/keys.md", "(tool not allowed)"]);
});

test("worktree mode: only forbidden (sealed) roots are certain; other outside paths and shell text are flags", () => {
  const events = [
    { id: "actor", event: tool("Read", { file_path: "/tmp/test-output/run.log" }) },
    { id: "actor", event: tool("Read", { file_path: "/loop/sealed/case-07.mjs" }) },
    { id: "actor", event: tool("Bash", { command: "cat /loop/sealed/case-08.mjs && npm test" }) },
    { id: "actor", event: { type: "item.completed", item: { type: "command_execution", command: "ls ../other" } } },
  ];
  const { violations, flags } = auditAccess(["/ws", "/ws/wt"], events, { tools: null, forbidden: ["/loop/sealed"] });
  assert.deepEqual(violations.map(v => v.path), ["/loop/sealed/case-07.mjs"]);
  assert.deepEqual(flags.map(f => f.path), ["/tmp/test-output/run.log", "/loop/sealed/case-08.mjs", "(parent directory reference)"]);
  assert.equal(flags[1].forbidden, true);
});

test("a call the permission layer refused is a denied attempt, not an access; an unknown log is insufficient evidence", () => {
  const events = [
    { id: "r", event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/outside/keys.md" } }] } } },
    { id: "r", event: { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Permission denied" }] } } },
  ];
  const audit = auditAccess("/inside", events);
  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.denied.map(d => d.path), ["/outside/keys.md"]);
  const unknown = auditAccess("/inside", [{ id: "r", event: { type: "unknown-schema", success: true } }]);
  assert.deepEqual(unknown.flags.map(f => f.path), ["(insufficient evidence)"]);
});

test("the same approved file spelled /tmp/… or /private/tmp/…, or reached through a symlinked folder, is not a violation", () => {
  assert.deepEqual(redOn("audit-path-alias"), { root: "/private/tmp/…", tmpSpelling: 1, viaSymlinkedRoot: 1 });
  const ws = mkdtempSync("/tmp/self-loop-audit-");
  writeFileSync(join(ws, "brief.md"), "brief\n");
  const real = realpathSync(ws);
  const link = join(temp(), "ws");
  symlinkSync(real, link);
  const read = p => ({ id: "r", event: tool("Read", { file_path: p }) });
  for (const [root, path] of [[real, join(ws, "brief.md")], [ws, join(real, "brief.md")], [real, join(link, "brief.md")], [link, join(real, "out/report.md")]])
    assert.deepEqual(auditAccess(root, [read(path)]).violations, [], `${root} ${path}`);
});

test("a relative path resolves against the call's working directory; a symlink inside the root that leads outside is a violation", () => {
  const ws = temp();
  const wt = join(ws, "wt");
  mkdirSync(wt);
  const outside = temp();
  writeFileSync(join(outside, "keys.md"), "k\n");
  symlinkSync(outside, join(ws, "escape"));
  const read = p => ({ id: "r", event: tool("Read", { file_path: p }) });
  assert.deepEqual(auditAccess([ws], [read("brief.md")], { cwd: ws }).violations, []);
  assert.equal(auditAccess([ws], [read("../keys.md")], { cwd: ws }).violations.length, 1);
  assert.deepEqual(auditAccess([ws, wt], [read("../records/x.md")], { cwd: wt, tools: null, forbidden: [outside] }).violations, [], "../records from wt is inside ws");
  assert.equal(auditAccess([ws, wt], [read("../../" + outside.split("/").pop() + "/keys.md")], { cwd: wt, tools: null, forbidden: [outside] }).violations.length, 1);
  assert.equal(auditAccess([ws], [read(join(ws, "escape/keys.md"))]).violations.length, 1, "lexically inside, really outside");
});

test("confined mode reports unparsedCalls/toolEvents and blocks non-file, MCP, and implicit-cwd tools", () => {
  const ws = temp("audit-confined-ws-"), outside = temp("audit-confined-out-");
  writeFileSync(join(ws, "brief.md"), "brief\n");
  writeFileSync(join(outside, "secret.md"), "secret\n");
  symlinkSync(outside, join(ws, "link-out"));

  const cleanAg = auditAccess([ws], agTurn([
    { name: "read_file", args: { Path: join(ws, "brief.md") } },
    { name: "write_file", args: { Path: join(ws, "out/report.md"), Content: "ok" } },
  ]), { cwd: outside });
  assert.deepEqual(cleanAg.violations, []);
  assert.equal(cleanAg.unparsedCalls, 0);
  assert.equal(cleanAg.toolEvents, 2);

  for (const name of ["run_command", "shell_exec", "search_web", "invoke_subagent", "mcp_t3-code_delegate_task", "mcp_t3-code_t3_thread_read"]) {
    const res = auditAccess([ws], agTurn([{ name, args: {} }]), { cwd: ws });
    assert.ok(res.violations.some(v => v.tool === name), `confined Antigravity must block ${name}`);
  }
  for (const name of ["Bash", "WebSearch", "mcp__t3-code__t3_thread_read", "mcp_t3-code_t3_thread_read"]) {
    const res = auditAccess([ws], [{ id: "cl", event: tool(name, {}) }], { cwd: ws });
    assert.ok(res.violations.some(v => v.tool === name), `confined Claude must block ${name}`);
  }

  const relAndLink = auditAccess([ws], agTurn([
    { name: "read_file", args: { Path: "secret.md" } },
    { name: "read_file", args: { Path: join(ws, "link-out/secret.md") } },
  ]), { cwd: outside });
  assert.equal(relAndLink.violations.length, 2);
  assert.equal(auditAccess([ws], [{ id: "cl", event: tool("Glob", { pattern: "*.md" }) }], { cwd: outside }).violations.length, 1);
  assert.equal(auditAccess([ws], [{ id: "cl", event: tool("Glob", { pattern: "*.md" }) }], { cwd: ws }).violations.length, 0);

  const unpaired = auditAccess([ws], [
    { id: "ag", event: { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", args: { Path: join(ws, "brief.md") } }] } },
  ], { cwd: ws });
  assert.ok(unpaired.unparsedCalls > 0);
  const unknownOnly = auditAccess([ws], [{ id: "u", event: { type: "OPAQUE_UNKNOWN" } }], { cwd: ws });
  assert.equal(unknownOnly.unrecognized, 1);
  assert.equal(unknownOnly.toolEvents, 0);
});

test("structured file-tool targets ignore embedded file:// URIs in Antigravity and Claude content while keeping negative controls", () => {
  const ws = temp("audit-struct-ws-");
  const wt = join(ws, "wt");
  const forbidden = temp("audit-struct-forbidden-");
  const outside = temp("audit-struct-outside-");
  mkdirSync(join(ws, "out"), { recursive: true });
  mkdirSync(join(wt, "src"), { recursive: true });
  const report = join(ws, "out", "report.md");
  const wtFile = join(wt, "src", "foo.mjs");
  const forbiddenFile = join(forbidden, "secret.mjs");
  const outsideFile = join(outside, "note.txt");
  const forbiddenUri = pathToFileURL(forbiddenFile).href;
  const outsideUri = pathToFileURL(outsideFile).href;
  const wtUri = pathToFileURL(wtFile).href;
  const body = `See [secret](${forbiddenUri}), [outside](${outsideUri}), and [wt](${wtUri}).\n`;

  const agConfined = auditAccess([ws], agTurn([
    { name: "write_file", args: { Path: report, Content: body } },
    { name: "edit_file", args: { Path: report, Target: forbiddenUri, Replacement: outsideUri } },
    { name: "write_to_file", args: { TargetFile: report, CodeContent: body } },
    { name: "replace_file_content", args: { TargetFile: report, TargetContent: forbiddenUri, ReplacementContent: outsideUri } },
    { name: "multi_replace_file_content", args: { TargetFile: report, ReplacementChunks: [{ TargetContent: "a", ReplacementContent: body }] } },
    { name: "grep_search", args: { SearchPath: ws, Query: forbiddenUri } },
  ]), { cwd: outside });
  assert.deepEqual(agConfined.violations, []);
  assert.deepEqual(agConfined.flags, []);

  const agActor = auditAccess([ws, wt], [
    ...agTurn([
      { name: "write_file", args: { Path: report, Content: body } },
      { name: "run_command", args: { CommandLine: "node --test" } },
      { name: "write_file", args: { Path: wtFile, Content: body } },
      { name: "edit_file", args: { Path: wtFile, Target: forbiddenUri, Replacement: outsideUri } },
      { name: "run_command", args: { CommandLine: `echo "${forbiddenUri}"` } },
    ]),
  ], { tools: null, forbidden: [forbidden], cwd: wt, stagedSuiteCommand: "node --test" });
  assert.deepEqual(agActor.violations, []);
  assert.equal(agActor.duplicateSuiteRuns.length, 1, "embedded wt file:// in out/report.md must not falsely mark worktree modified");
  assert.deepEqual(agActor.flags.map(f => f.path), ["(duplicate suite run)"]);

  const claudeConfined = auditAccess([ws], [
    { id: "cl", event: tool("Write", { file_path: report, content: body }) },
    { id: "cl", event: tool("Edit", { file_path: report, old_string: forbiddenUri, new_string: outsideUri }) },
    { id: "cl", event: tool("Grep", { path: ws, pattern: forbiddenUri }) },
  ], { cwd: outside });
  assert.deepEqual(claudeConfined.violations, []);
  assert.deepEqual(claudeConfined.flags, []);

  const claudeActor = auditAccess([ws, wt], [
    { id: "cl", event: tool("Write", { file_path: report, content: body }) },
    { id: "cl", event: tool("Bash", { command: "node --test" }) },
    { id: "cl", event: tool("MultiEdit", { file_path: wtFile, edits: [{ old_string: "a", new_string: body }] }) },
    { id: "cl", event: tool("NotebookEdit", { notebook_path: join(wt, "nb.ipynb"), new_source: body }) },
    { id: "cl", event: tool("Bash", { command: `echo "${forbiddenUri}"` }) },
  ], { tools: null, forbidden: [forbidden], cwd: wt, stagedSuiteCommand: "node --test" });
  assert.deepEqual(claudeActor.violations, []);
  assert.equal(claudeActor.duplicateSuiteRuns.length, 1, "Claude report write with embedded wt file:// must not suppress duplicate suite detection");
  assert.deepEqual(claudeActor.flags.map(f => f.path), ["(duplicate suite run)"]);

  for (const [label, tc, expectedPath] of [
    ["ag raw Path", { name: "read_file", args: { Path: forbiddenFile } }, forbiddenFile],
    ["ag file:// Path", { name: "write_file", args: { Path: forbiddenUri, Content: "x" } }, forbiddenFile],
    ["ag file:// TargetFile", { name: "write_to_file", args: { TargetFile: outsideUri, CodeContent: "x" } }, outsideFile],
    ["ag non-file open_url", { name: "open_url", args: { url: forbiddenUri } }, forbiddenFile],
  ]) {
    const res = auditAccess([ws], agTurn([tc]), { cwd: ws });
    assert.ok(res.violations.some(v => v.tool === tc.name && v.path === expectedPath), `confined ${label} must violate`);
  }
  const agNonFileWorktree = auditAccess([ws, wt], agTurn([{ name: "open_url", args: { url: forbiddenUri } }]), { tools: null, forbidden: [forbidden], cwd: wt });
  assert.ok(agNonFileWorktree.violations.some(v => v.tool === "open_url" && v.path === forbiddenFile));

  for (const [label, name, input, expectedPath] of [
    ["claude raw file_path", "Write", { file_path: forbiddenFile, content: "x" }, forbiddenFile],
    ["claude file:// file_path", "Edit", { file_path: forbiddenUri, old_string: "a", new_string: "b" }, forbiddenFile],
    ["claude non-file WebFetch", "WebFetch", { url: forbiddenUri }, forbiddenFile],
  ]) {
    const res = auditAccess([ws], [{ id: "cl", event: tool(name, input) }], { cwd: ws });
    assert.ok(res.violations.some(v => v.tool === name && v.path === expectedPath), `confined ${label} must violate`);
    const wtRes = auditAccess([ws, wt], [{ id: "cl", event: tool(name, input) }], { tools: null, forbidden: [forbidden], cwd: wt });
    assert.ok(wtRes.violations.some(v => v.tool === name && v.path === expectedPath), `worktree ${label} must violate`);
  }
});

test("stepTruncated compact arg decoding fails closed on truncated structured paths and non-file URLs but not on truncated file-tool bodies", () => {
  const ws = temp("audit-trunc-ws-");
  const report = join(ws, "out", "report.md");
  const truncBody = auditAccess([ws], agTurn([
    { name: "write_file", args: { Path: JSON.stringify(report), Content: `"see file:///forbidden/secret.mjs\n<truncated 120 bytes>` } },
    { name: "edit_file", args: { Path: JSON.stringify(report), Replacement: `"link file:///tmp/outside.txt\n<truncated 40 bytes>` } },
  ], { truncated_fields: ["tool_calls"] }), { cwd: ws });
  assert.deepEqual(truncBody.violations, []);
  assert.ok(truncBody.flags.some(f => f.path === "(insufficient evidence)"));

  const truncPath = auditAccess([ws], agTurn([
    { name: "write_file", args: { Path: `"/forbidden/long\n<truncated 50 bytes>`, Content: JSON.stringify("ok") } },
  ], { truncated_fields: ["tool_calls"] }), { cwd: ws });
  assert.ok(truncPath.violations.some(v => v.tool === "write_file" && v.path === "(truncated/unparseable tool argument)"));

  const truncNonFileUrl = auditAccess([ws], agTurn([
    { name: "mcp_t3-code_html_preview", args: { html: `"<iframe src=\\"file:///forbidden/case.mjs\n<truncated 80 bytes>` } },
  ], { truncated_fields: ["tool_calls"] }), { tools: null, forbidden: ["/forbidden"], cwd: ws });
  assert.ok(truncNonFileUrl.violations.some(v => v.tool === "mcp_t3-code_html_preview" && v.path === "(truncated/unparseable tool argument)"));
});

test("Antigravity view_file_outline and view_code_item admit in-scope structured paths while failing closed on out-of-scope, missing-target, and opaque tools", () => {
  const ws = temp("audit-reader-ws-");
  const wt = join(ws, "wt");
  const forbidden = temp("audit-reader-forbidden-");
  const outside = temp("audit-reader-outside-");
  mkdirSync(join(ws, "out"), { recursive: true });
  mkdirSync(join(ws, "records"), { recursive: true });
  mkdirSync(wt, { recursive: true });
  const briefFile = join(ws, "brief.md");
  const taskFile = join(ws, "task.md");
  const indexFile = join(ws, "records", "INDEX.md");
  const forbiddenFile = join(forbidden, "secret.mjs");
  const outsideFile = join(outside, "other.js");
  const forbiddenUri = pathToFileURL(forbiddenFile).href;
  const outsideUri = pathToFileURL(outsideFile).href;

  const inScope = auditAccess([ws], agTurn([
    { name: "view_file_outline", args: { AbsolutePath: briefFile } },
    { name: "view_code_item", args: { File: taskFile, NodePaths: [forbiddenUri, outsideUri, "Task"] } },
    { name: "view_code_item", args: { AbsolutePath: indexFile, NodePaths: [`See ${forbiddenUri}`] } },
    { name: "view_code_item", args: { File: pathToFileURL(briefFile).href, NodePaths: ["Brief"] } },
  ]), { cwd: outside });
  assert.deepEqual(inScope.violations, []);
  assert.deepEqual(inScope.flags, []);
  assert.equal(inScope.unparsedCalls, 0);
  assert.equal(inScope.toolEvents, 4);

  for (const [label, tc, expectedPath] of [
    ["view_file_outline plain AbsolutePath", { name: "view_file_outline", args: { AbsolutePath: forbiddenFile } }, forbiddenFile],
    ["view_file_outline file:// AbsolutePath", { name: "view_file_outline", args: { AbsolutePath: outsideUri } }, outsideFile],
    ["view_code_item plain File", { name: "view_code_item", args: { File: forbiddenFile, NodePaths: ["app"] } }, forbiddenFile],
    ["view_code_item file:// File", { name: "view_code_item", args: { File: forbiddenUri, NodePaths: ["app"] } }, forbiddenFile],
    ["view_code_item plain AbsolutePath", { name: "view_code_item", args: { AbsolutePath: outsideFile, NodePaths: ["app"] } }, outsideFile],
    ["view_code_item file:// AbsolutePath", { name: "view_code_item", args: { AbsolutePath: forbiddenUri, NodePaths: ["app"] } }, forbiddenFile],
  ]) {
    const confinedRes = auditAccess([ws], agTurn([tc]), { cwd: ws });
    assert.ok(confinedRes.violations.some(v => v.tool === tc.name && v.path === expectedPath), `confined ${label} must violate`);
  }

  for (const [label, tc] of [
    ["worktree view_file_outline forbidden AbsolutePath", { name: "view_file_outline", args: { AbsolutePath: forbiddenFile } }],
    ["worktree view_code_item forbidden File", { name: "view_code_item", args: { File: forbiddenUri, NodePaths: ["app"] } }],
  ]) {
    const wtRes = auditAccess([ws, wt], agTurn([tc]), { tools: null, forbidden: [forbidden], cwd: wt });
    assert.ok(wtRes.violations.some(v => v.tool === tc.name && v.path === forbiddenFile), `${label} must violate`);
  }

  for (const [label, tc] of [
    ["view_file_outline missing structured path", { name: "view_file_outline", args: { Offset: 0 } }],
    ["view_code_item missing structured path", { name: "view_code_item", args: { NodePaths: ["app"] } }],
  ]) {
    const missingRes = auditAccess([ws], agTurn([tc]), { cwd: ws });
    assert.equal(missingRes.unparsedCalls, 1, `${label} must increment unparsedCalls`);
    assert.ok(missingRes.flags.some(f => f.path === "(insufficient evidence)"), `${label} must emit insufficient evidence flag`);
  }

  const truncFileKey = auditAccess([ws], agTurn([
    { name: "view_code_item", args: { File: `"/forbidden/secret\n<truncated 30 bytes>`, NodePaths: JSON.stringify(["app"]) } },
  ], { truncated_fields: ["tool_calls"] }), { cwd: ws });
  assert.ok(truncFileKey.violations.some(v => v.tool === "view_code_item" && v.path === "(truncated/unparseable tool argument)"));

  const opaque = auditAccess([ws], agTurn([
    { name: "opaque_custom_tool", args: { Path: briefFile } },
  ]), { cwd: ws });
  assert.ok(opaque.violations.some(v => v.tool === "opaque_custom_tool" && v.path === "(tool not allowed)"));
});

test("F-0015 A1/A2: 34 KB x 1,032-path command stays bounded, preserves Tier-0 forbidden/duplicate/insufficient flags, and compacts <= 1 MiB", () => {
  assert.equal(truncateCommandPreview("echo hi"), "echo hi");
  const longText = "x".repeat(300);
  assert.equal(truncateCommandPreview(longText), `${"x".repeat(MAX_COMMAND_PREVIEW_CHARS)}… [+60 chars]`);
  assert.match(commandHashOf(longText), /^[0-9a-f]{16}$/);

  const ws = temp("audit-bound-ws-");
  const wt = join(ws, "wt");
  const forbidden = temp("audit-bound-sealed-");
  mkdirSync(wt, { recursive: true });
  const sealedTarget = join(forbidden, "secret-case.mjs");

  const paths = Array.from({ length: 1032 }, (_, idx) => `/outside/workspace/package-${idx}/src/file-${idx}.ts`);
  const hugeCmd = `node -e "${paths.join(" ")} ${sealedTarget}"`;
  assert.ok(Buffer.byteLength(hugeCmd, "utf8") > 34_000);

  const res = auditAccess([ws, wt], [
    { id: "actor", event: tool("Bash", { command: hugeCmd }) },
  ], { tools: null, forbidden: [forbidden], cwd: wt });

  const ordinary = res.flags.filter(f => !f.forbidden);
  const tier0 = res.flags.filter(f => f.forbidden === true);
  assert.equal(ordinary.length, MAX_PATHS_PER_COMMAND);
  assert.equal(tier0.length, 1);
  assert.equal(tier0[0].path, sealedTarget);
  assert.equal(ordinary.at(-1).extraPathCount, 1032 - MAX_PATHS_PER_COMMAND);
  assert.equal(res.omittedFlags, 1032 - MAX_PATHS_PER_COMMAND);
  assert.equal(Object.hasOwn(res.flags, "overflowCount"), false);
  assert.equal(ordinary[0].command, truncateCommandPreview(hugeCmd));
  assert.equal(ordinary[0].commandHash, commandHashOf(hugeCmd));
  assert.equal(ordinary[0].commandBytes, Buffer.byteLength(hugeCmd, "utf8"));

  const serialized = serializeBoundedAudit({ id: "R-0062-actor", role: "actor", attempt: 1, exit: 0, nonce: "abc123", agent: { runner: "paseo" }, ...res });
  assert.ok(Buffer.byteLength(serialized, "utf8") < 32_768);
  const parsed = JSON.parse(serialized);
  assert.equal(parsed.flags[0].forbidden, true);
  assert.equal(parsed.nonce, "abc123");
  assert.equal(parsed.omittedFlags, 1032 - MAX_PATHS_PER_COMMAND);

  const floodEvents = [];
  for (let c = 0; c < 20; c++) {
    const chunk = Array.from({ length: 16 }, (_, k) => `/flood/c${c}/f${k}.txt`).join(" ");
    floodEvents.push({ id: "actor", event: tool("Bash", { command: `echo ${chunk}` }) });
  }
  floodEvents.push({ id: "actor", event: tool("Bash", { command: "node --test" }) });
  floodEvents.push({ id: "actor", event: tool("Bash", { command: `cat ${sealedTarget}` }) });
  floodEvents.push({ id: "actor", event: { type: "unparsed_tool_call" } });

  const flooded = auditAccess([ws, wt], floodEvents, { tools: null, forbidden: [forbidden], cwd: wt, stagedSuiteCommand: "node --test" });
  assert.equal(flooded.flags.filter(f => !f.forbidden && f.path !== "(duplicate suite run)" && f.path !== "(insufficient evidence)").length, MAX_ORDINARY_FLAGS);
  assert.equal(flooded.omittedFlags, 320 - MAX_ORDINARY_FLAGS);
  assert.ok(flooded.flags.some(f => f.forbidden === true && f.path === sealedTarget));
  const dupFlag = flooded.flags.find(f => f.path === "(duplicate suite run)");
  assert.ok(dupFlag);
  assert.equal(flooded.duplicateSuiteRuns[0], dupFlag);
  assert.ok(flooded.flags.some(f => f.path === "(insufficient evidence)"));

  const shortRes = auditAccess([ws, wt], [
    { id: "actor", event: tool("Bash", { command: "cat /outside/one.txt" }) },
  ], { tools: null, forbidden: [forbidden], cwd: wt });
  assert.deepEqual(shortRes.flags, [{ id: "actor", command: "cat /outside/one.txt", path: "/outside/one.txt" }]);
  assert.equal("omittedFlags" in shortRes, false);

  const giantAudit = {
    id: "R-0062-actor", role: "actor", attempt: 1, exit: 0, nonce: "n-1",
    agent: { runner: "paseo", model: "gemini-2.5-flash" },
    unrecognized: 0, unparsedCalls: 0, toolEvents: 5, omittedFlags: 900, excludedOutCount: 120,
    violations: [], denied: [], duplicateSuiteRuns: [],
    excludedOutPaths: Array.from({ length: 100 }, (_, i) => `out/cache/file-${i}.bin`),
    flags: [
      ...Array.from({ length: 120 }, (_, i) => ({ id: "actor", command: "a".repeat(20_000), path: `/outside/p-${i}.txt` })),
      { id: "actor", command: `cat ${sealedTarget}`, path: sealedTarget, forbidden: true },
    ],
  };
  const compact1m = serializeBoundedAudit(giantAudit, MAX_AUDIT_JSON_BYTES);
  assert.ok(compact1m.endsWith("\n"));
  assert.ok(Buffer.byteLength(compact1m, "utf8") <= MAX_AUDIT_JSON_BYTES);
  const parsed1m = JSON.parse(compact1m);
  assert.equal(parsed1m.id, "R-0062-actor");
  assert.equal(parsed1m.nonce, "n-1");
  assert.equal(parsed1m.excludedOutCount, 120);
  assert.equal(parsed1m.truncated, true);
  assert.deepEqual(parsed1m.truncatedCounts, { violations: 0, denied: 0, flags: 121, duplicateSuiteRuns: 0 });
  assert.equal(parsed1m.flags[0].forbidden, true);
  assert.equal(parsed1m.flags[0].path, sealedTarget);

  const tight = serializeBoundedAudit(giantAudit, 2048);
  assert.ok(Buffer.byteLength(tight, "utf8") <= 2048);
  const parsedTight = JSON.parse(tight);
  assert.equal(parsedTight.id, "R-0062-actor");
  assert.equal(parsedTight.truncated, true);
  assert.equal(parsedTight.flags[0].forbidden, true);
});
