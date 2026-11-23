// The access audit. Green: the four real backtest runs (their tool events frozen in fixtures/backtest-tool-events.json,
// so the test does not read a live directory). Red: no access outside the working directory is recorded in a real run,
// so the red samples are real event shapes with the path changed (constructed red: see DEBT.md).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { auditAccess, eventsOf } from "../audit-access.mjs";
import { fixtures, redOn, temp } from "./helpers.mjs";

const FROZEN = JSON.parse(readFileSync(join(fixtures, "backtest-tool-events.json"), "utf8"));
const tool = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

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

/** The working directory a run used: the common prefix of its file-tool paths (they were all inside it). */
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
  // red on a8d6043: scripts/test/fixtures/v0.1-red/probes.log@a4db050 lines 18-19 (a refused Read counted as a
  // violation; an unknown event read as clean); fixed in v0.2, so no a4db050 red
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

// ---------- canonical paths (review v0.2 B4) ----------

test("the same approved file spelled /tmp/… or /private/tmp/…, or reached through a symlinked folder, is not a violation", () => {
  assert.deepEqual(redOn("audit-path-alias"), { root: "/private/tmp/…", tmpSpelling: 1, viaSymlinkedRoot: 1 }); // red on a4db050
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
