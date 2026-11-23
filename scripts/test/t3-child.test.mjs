// A role run as a T3 child thread (runner `t3`): --prepare builds the same workspace as a CLI call and stops before any
// model runs; `record` finds the child's transcript by the nonce in its first prompt, audits it and records the same
// hand-off. Transcripts here are written in the shapes Codex and Claude Code write (lib/t3-child.mjs).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test from "node:test";
import { EXIT, recordCall } from "../call.mjs";
import { transcriptEvents } from "../lib/t3-child.mjs";
import { parseHandoffs } from "../lib/handoff.mjs";
import { git, setup, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");

const codexId = "fixture-codex", claudeId = "fixture-claude";
const t3 = provider => ({ runner: "t3", provider, model: "m", effort: "high" });
const handoffs = records => parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")).filter(h => h.step !== "reviewer-frame");

/** A Codex rollout of a child whose first prompt is `prompt` and which ran `commands` (shell strings) in `cwd`. */
function codexRollout(home, prompt, commands, cwd) {
  const now = new Date();
  const dir = join(home, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString();
  const rows = [
    { timestamp: ts, type: "session_meta", payload: { cwd, id: codexId } },
    { timestamp: ts, type: "turn_context", payload: { cwd, model: "gpt-test" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    ...commands.map(c => ({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", c], cwd: `file://${cwd}`, exit_code: 0 } } })),
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ];
  const file = join(dir, `rollout-${ts.replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

/** A Claude Code session of a child whose first prompt is `prompt` and which used `tools` ({ name, input }). */
function claudeSession(home, prompt, tools, cwd) {
  const dir = join(home, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const rows = [
    { type: "user", cwd, timestamp: ts, sessionId: claudeId, message: { role: "user", content: prompt } },
    ...tools.map((t, i) => ({ type: "assistant", cwd, timestamp: ts, message: { model: "claude-test", content: [{ type: "tool_use", id: `tu${i}`, ...t }] } })),
    { type: "assistant", cwd, timestamp: ts, message: { model: "claude-test", stop_reason: "end_turn", content: [] } },
  ];
  const file = join(dir, `${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

async function prepared(provider = "codex", role = "critic") {
  const s = await setup({}, { agents: { critic: t3(provider), actor: t3(provider), judge: t3(provider), reviewer: { runner: "cmd", cmd: ["true"] } } });
  const homes = { codex: temp("codex-home-"), claude: temp("claude-home-") };
  process.env.CODEX_HOME = homes.codex;
  process.env.CLAUDE_CONFIG_DIR = homes.claude;
  const r = s.run(role, { prepare: true });
  return { s, r, homes };
}

// Linux can give a just-created transcript an mtime earlier than the recorded prepare timestamp.
function coarseMtime(file, ws) {
  const { preparedAt } = JSON.parse(readFileSync(join(ws, "call.json"), "utf8"));
  const seconds = Math.floor((preparedAt - 1) / 1000);
  utimesSync(file, seconds, seconds);
}

test("--prepare builds the workspace and the worktree, writes the child's prompt with its nonce, and calls no model", async () => {
  const { s, r } = await prepared();
  assert.equal(r.code, EXIT.done, r.message);
  const p = r.prepared;
  assert.match(p.prompt, new RegExp(`^self-loop call R-0001-critic · nonce ${p.nonce}`));
  assert.ok(p.prompt.includes(`cd ${p.wt} && ...`), "the child is told to run in the prepared worktree");
  assert.ok(p.prompt.includes(`The product worktree is ${p.wt}, detached at`) && !p.prompt.includes("your current directory"), "no claim that the session starts in it");
  assert.ok(p.prompt.includes("Read brief-shared.md, brief.md and task.md"), "the role prompt follows");
  assert.equal(readFileSync(join(p.ws, "task.md"), "utf8"), "Task for the critic.\nfeatures: F-0001\n");
  assert.deepEqual(JSON.parse(readFileSync(join(p.ws, "call.json"), "utf8")).features, ["F-0001"]);
  assert.deepEqual(p.target, { provider: "codex", model: "m", effort: "high" });
  assert.ok(existsSync(join(p.ws, "call.json")) && existsSync(join(p.wt, "src/a.js")), "workspace and worktree kept for the child");
  assert.equal(git(s.records, "log", "--format=%s", "-1"), "init", "nothing recorded yet");
  assert.deepEqual(s.counts(), {});
});

test("a t3 role is refused without --prepare, --prepare is refused for a CLI role, and the frame reviewer never runs on t3", async () => {
  const { s } = await prepared();
  assert.match(s.run("critic").message, /runs as a T3 child thread: prepare it with --prepare/);
  s.cfg.agents.reviewer = { runner: "cmd", cmd: ["true"] };
  assert.match(s.run("reviewer", { step: "reviewer-frame", prepare: true }).message, /--prepare is only for a role whose runner is t3/);
  s.cfg.agents.reviewer = t3("claude");
  assert.match(s.run("reviewer", { step: "reviewer-frame", prepare: true }).message, /frame reviewer stays on the claude CLI/);
});

test("--prepare rejects missing or unknown feature IDs without a workspace", async () => {
  const s = await setup({}, { agents: { critic: t3("codex") } });
  for (const task of ["No feature field.", "features: F-9999"]) {
    const rejected = s.run("critic", { task, prepare: true });
    assert.equal(rejected.code, EXIT.records, rejected.message);
    assert.match(rejected.message, /features:/);
    assert.equal(rejected.prepared, undefined);
    assert.equal(existsSync(s.cfg.workDir), false);
  }
});

test("record still accepts a legacy prepared context with no features field", async () => {
  const { s, r, homes } = await prepared();
  const { ws, wt, prompt } = r.prepared;
  const callFile = join(ws, "call.json");
  const raw = JSON.parse(readFileSync(callFile, "utf8"));
  delete raw.features;
  raw.version = 1;
  rmSync(join(s.cfg.workDir, ".prepared", basename(ws) + ".json"));
  raw.task = "Legacy task with no feature declaration.\n";
  writeFileSync(callFile, JSON.stringify(raw));
  writeFileSync(join(ws, "task.md"), raw.task);
  writeFileSync(join(ws, "out/report.md"), "legacy report\n");
  codexRollout(homes.codex, prompt, [], wt);
  const recorded = recordCall(s.cfg, ws, { session: codexId });
  assert.equal(recorded.code, EXIT.done, recorded.message);
  assert.equal(Object.hasOwn(handoffs(s.records)[0], "features"), false);
});

test("record: a Codex child's transcript is audited and its work recorded as one hand-off, the owned change committed", async () => {
  const { s, r, homes } = await prepared("codex");
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(wt, "test/b.test.js"), "export const attack = 1;\n");
  writeFileSync(join(ws, "out/report.md"), "critic report from T3\n");
  codexRollout(homes.codex, prompt, [`cd ${wt} && node --test`, "cat /etc/hosts-outside"], "/somewhere/else");
  const done = recordCall(s.cfg, ws, { session: codexId });
  assert.equal(done.code, EXIT.done, done.message);
  const [h] = handoffs(s.records);
  assert.equal(h.agent.runner, "t3:codex");
  assert.deepEqual(h.features, ["F-0001"]);
  assert.equal(h.agent.observedModel, "gpt-test");
  assert.equal(h.product.commit, git(s.product, "rev-parse", "loop/s5"));
  assert.equal(git(s.product, "show", "--name-only", "--format=", "loop/s5"), "test/b.test.js");
  const audit = JSON.parse(readFileSync(join(s.records, h.audit.file), "utf8"));
  assert.ok(audit.flags.some(f => f.path === "/etc/hosts-outside"), "an outside path in a command is screened");
  assert.match(readFileSync(join(s.records, "rounds/0001-critic.md"), "utf8"), /critic report from T3/);
  assert.equal(git(s.product, "worktree", "list").split("\n").length, 1, "worktree removed after recording");
  const again = recordCall(s.cfg, ws, { session: codexId });
  assert.equal(again.code, EXIT.records);
});

test("record finds a Codex child whose rollout T3 moved to archived_sessions", async () => {
  const { s, r, homes } = await prepared("codex");
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "critic report, archived thread\n");
  const file = codexRollout(homes.codex, prompt, [`cd ${wt} && node --test`], "/somewhere/else");
  const archived = join(homes.codex, "archived_sessions");
  mkdirSync(archived, { recursive: true });
  const moved = join(archived, basename(file));
  renameSync(file, moved);
  coarseMtime(moved, ws);
  const done = recordCall(s.cfg, ws, { session: codexId });
  assert.equal(done.code, EXIT.done, done.message);
  assert.equal(handoffs(s.records)[0].agent.runner, "t3:codex");
});

test("record: a Claude child that read the records repository is a violation, and no hand-off is recorded", async () => {
  const { s, r, homes } = await prepared("claude");
  const { ws, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const file = claudeSession(homes.claude, prompt, [{ name: "Read", input: { file_path: join(s.records, "README.md") } }], "/somewhere/else");
  coarseMtime(file, ws);
  const done = recordCall(s.cfg, ws, { session: claudeId });
  assert.equal(done.code, EXIT.violation, done.message);
  assert.deepEqual(handoffs(s.records), []);
});

test("record refuses a child that was not started with the prepared prompt verbatim (the T3 preamble before it is fine)", async () => {
  const { s, r, homes } = await prepared("codex");
  const { ws, prompt, nonce } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const file = codexRollout(homes.codex, `self-loop call R-0001-critic · nonce ${nonce}\n\nDo whatever you like.`, [], "/x");
  coarseMtime(file, ws);
  assert.match(recordCall(s.cfg, ws, { session: codexId }).message, /does not hold t3-prompt\.md verbatim/);
  const other = await prepared("codex");
  writeFileSync(join(other.r.prepared.ws, "out/report.md"), "report\n");
  codexRollout(other.homes.codex, `Act as the critic sub-agent for this task.\n\n${other.r.prepared.prompt}`, [], "/x");
  assert.equal(recordCall(other.s.cfg, other.r.prepared.ws, { session: codexId }).code, EXIT.done);
});

test("record finds the transcript only by the nonce in the child's FIRST prompt; none or two is an error, never a guess", async () => {
  const { s, r, homes } = await prepared("codex");
  const { ws, prompt, nonce } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  claudeSession(homes.claude, "The lead's own session", [{ name: "Bash", input: { command: `echo ${nonce}` } }], "/lead");
  assert.match(recordCall(s.cfg, ws, { session: codexId }).message, /no transcript holds nonce/);
  codexRollout(homes.codex, prompt, [], "/x");
  codexRollout(homes.codex, prompt, [], "/y");
  assert.match(recordCall(s.cfg, ws, { session: codexId }).message, /2 transcripts hold nonce/);
});

const appendRows = (file, rows) => appendFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
const codexMessage = text => ({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const codexEvent = (type, props = {}) => ({ type: "event_msg", payload: { type, ...props } });

test("B12: discovery and explicit parsing skip Codex's injected AGENTS context", async () => {
  const { s, r, homes } = await prepared();
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const file = codexRollout(homes.codex, prompt, [], wt);
  const original = readFileSync(file, "utf8");
  const lines = original.trimEnd().split("\n");
  lines.splice(2, 0, JSON.stringify(codexMessage("# AGENTS.md instructions for fixture")));
  writeFileSync(file, lines.join("\n") + "\n");
  coarseMtime(file, ws);
  assert.equal(transcriptEvents("fixture", { runner: "codex", file }).firstPrompt, prompt);
  assert.match(recordCall(s.cfg, ws).message, /--session/);
  const done = recordCall(s.cfg, ws, { session: codexId });
  assert.equal(done.code, EXIT.done, done.message);
});

test("B13: a prepared Codex call cannot consume a Claude transcript or a Codex fork", async () => {
  const { s, r, homes } = await prepared();
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const wrong = claudeSession(homes.claude, prompt, [], wt);
  assert.equal(recordCall(s.cfg, ws, { session: codexId, transcript: wrong }).code, EXIT.records);
  assert.notEqual(recordCall(s.cfg, ws, { session: codexId }).code, EXIT.done);
  const fork = codexRollout(homes.codex, prompt, [], wt);
  const rows = readFileSync(fork, "utf8").split("\n");
  const meta = JSON.parse(rows[0]);
  Object.assign(meta.payload, { id: "fork", forked_from_id: "original" });
  rows[0] = JSON.stringify(meta);
  writeFileSync(fork, rows.join("\n"));
  assert.equal(recordCall(s.cfg, ws, { session: "fork", transcript: fork }).code, EXIT.records);
  assert.ok(existsSync(wt));
});

test("B14: recording requires the prepared repositories, phase and unchanged task", async () => {
  const { s, r, homes } = await prepared();
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const transcript = codexRollout(homes.codex, prompt, [], wt);
  const other = await setup();
  for (const cfg of [{ ...s.cfg, records: other.records }, { ...s.cfg, product: other.product }, { ...s.cfg, phase: "OTHER" }])
    assert.equal(recordCall(cfg, ws, { session: codexId, transcript }).code, EXIT.records);
  const file = join(ws, "call.json"), raw = JSON.parse(readFileSync(file, "utf8"));
  raw.task = "different task\nfeatures: F-0001\n";
  writeFileSync(file, JSON.stringify(raw));
  writeFileSync(join(ws, "task.md"), raw.task);
  assert.equal(recordCall(s.cfg, ws, { session: codexId, transcript }).code, EXIT.records);
  assert.ok(existsSync(wt));
});

test("B15: an unfinished turn keeps its worktree; a recorded abort is failure evidence", async () => {
  const { s, r, homes } = await prepared();
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const transcript = codexRollout(homes.codex, prompt, [], wt);
  appendRows(transcript, [codexEvent("task_started", { turn_id: "this-turn" })]);
  assert.equal(recordCall(s.cfg, ws, { session: codexId, transcript }).code, EXIT.failure);
  assert.ok(existsSync(wt));
  assert.match(recordCall(s.cfg, ws, { session: "replacement", transcript }).message, /already bound/);
  appendRows(transcript, [codexEvent("turn_aborted", { turn_id: "this-turn" })]);
  assert.equal(recordCall(s.cfg, ws, { session: codexId, transcript }).code, EXIT.failure);
  assert.deepEqual(handoffs(s.records), []);
  assert.equal(JSON.parse(git(s.records, "show", "HEAD:evidence/0001/critic-1-audit.json")).exit, 1);
});

test("B16: Codex correlates function calls by ID and keeps unsupported calls visible", async () => {
  const { s, r, homes } = await prepared();
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const transcript = codexRollout(homes.codex, prompt, [], wt);
  const response = (type, props) => ({ type: "response_item", payload: { type, ...props } });
  appendRows(transcript, [
    response("function_call", { call_id: "one", name: "exec_command", arguments: JSON.stringify({ cmd: "cat /outside/fixture" }) }),
    response("function_call", { call_id: "two", name: "exec_command", arguments: "broken json" }),
    response("function_call_output", { call_id: "two", output: "fixture" }),
    response("function_call_output", { call_id: "one", output: "fixture" }),
  ]);
  const result = recordCall(s.cfg, ws, { session: codexId, transcript });
  assert.equal(result.code, EXIT.done, result.message);
  const audit = JSON.parse(git(s.records, "show", `HEAD:${result.handoff.audit.file}`));
  assert.equal(audit.unrecognized, 1);
  assert.ok(audit.flags.some(f => f.path === "/outside/fixture"));
  assert.ok(audit.flags.some(f => f.path === "(insufficient evidence)"));
});

test("Codex FileChange audits a completed write into the sealed repository like a Claude Edit", async () => {
  const { s, r, homes } = await prepared("codex", "actor");
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const file = codexRollout(homes.codex, prompt, [], wt);
  const target = join(s.sealed, "case-07.mjs");
  appendRows(file, [
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "cell", input: "text(await tools.apply_patch(patch))" } },
    codexEvent("item_completed", { item: { type: "FileChange", id: "change", status: "completed", changes: { [target]: { type: "update" } } } }),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cell", output: "Success." } },
  ]);
  const verdict = recordCall(s.cfg, ws, { session: codexId, transcript: file });
  assert.equal(verdict.code, EXIT.violation, verdict.message);
  assert.deepEqual(handoffs(s.records), []);
});

test("the Codex code-mode wrappers do not generate indistinguishable audit flags for a legitimate move or denied edit", async () => {
  const { s, r, homes } = await prepared("codex", "actor");
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  const file = codexRollout(homes.codex, prompt, [], wt);
  appendRows(file, [
    { type: "response_item", payload: { type: "custom_tool_call", name: "exec", call_id: "cell", input: "text(await tools.apply_patch(patch))" } },
    codexEvent("item_completed", { item: { type: "FileChange", id: "moved", status: "completed",
      changes: { [join(wt, "src/old.js")]: { type: "update", move_path: join(wt, "src/new.js") } } } }),
    codexEvent("item_completed", { item: { type: "FileChange", id: "denied", status: "failed",
      changes: { [join(s.sealed, "case-07.mjs")]: { type: "update" } } } }),
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "cell", output: "Completed." } },
  ]);
  const verdict = recordCall(s.cfg, ws, { session: codexId, transcript: file });
  assert.equal(verdict.code, EXIT.done, verdict.message);
  const [h] = handoffs(s.records);
  assert.deepEqual([h.audit.flags, h.audit.unrecognized, h.audit.denied], [0, 0, 1]);
});

test("two actors on the same design base preserve both proposals and surface the conflict", async () => {
  const { s, r, homes } = await prepared("codex", "actor");
  const second = s.run("actor", { step: "actor-b", prepare: true }).prepared;
  const third = s.run("actor", { step: "actor-c", prepare: true }).prepared;
  const log = [];
  const record = ({ ws, wt, prompt }, text) => {
    writeFileSync(join(ws, "out/report.md"), "report\n");
    mkdirSync(join(ws, "out/design"));
    writeFileSync(join(ws, "out/design/core.md"), text);
    const file = codexRollout(homes.codex, prompt, [], wt);
    return recordCall(s.cfg, ws, { session: codexId, transcript: file, log: m => log.push(m) });
  };
  assert.equal(record(r.prepared, "# A\n").code, EXIT.done);
  const b = record(second, "# B\n");
  assert.equal(b.code, EXIT.done, b.message);
  assert.equal(git(s.records, "show", "HEAD:design/core.md"), "# A");
  assert.equal(git(s.records, "show", "HEAD:evidence/0001/actor-b-1/out/design/core.md"), "# B");
  assert.ok(!b.handoff.files.includes("design/core.md"));
  assert.match(log.join("\n"), /design-conflict.*R-0001-actor/);
  assert.equal(record(third, "# A\n").code, EXIT.done);
  const { check } = await import("../records-check.mjs");
  assert.deepEqual(check(s.records).screening.filter(x => x.rule === "design-conflict").map(x => x.path), ["design/core.md"]);
  const sequential = s.run("actor", { round: 2, prepare: true }).prepared;
  assert.equal(record(sequential, "# A and B\n").code, EXIT.done);
  assert.equal(git(s.records, "show", "HEAD:design/core.md"), "# A and B");
  assert.ok(!check(s.records).screening.some(x => x.rule === "design-conflict"));
});

test("Codex wait calls with outputs are covered while a wait with missing output remains visible", () => {
  const file = codexRollout(temp(), "fixture prompt", [], "/work/example-app");
  const item = (type, props) => ({ type: "response_item", payload: { type, ...props } });
  appendRows(file, [
    item("function_call", { name: "wait", call_id: "function-wait", arguments: '{"cell_id":"fixture"}' }),
    item("function_call_output", { call_id: "function-wait", output: "Script completed" }),
    item("custom_tool_call", { name: "wait", call_id: "custom-wait", input: '{"cell_id":"fixture"}' }),
    item("custom_tool_call_output", { call_id: "custom-wait", output: "Script completed" }),
    item("function_call", { name: "wait", call_id: "incomplete", arguments: '{"cell_id":"fixture"}' }),
  ]);
  const { events } = transcriptEvents("fixture", { runner: "codex", file });
  assert.deepEqual(events.map(({ event }) => event), [{ type: "unparsed_tool_call", call_id: "incomplete" }]);
});
