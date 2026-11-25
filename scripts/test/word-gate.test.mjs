// F-0002, D-0007, D-0052, R-0032-reviewer-architecture
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { antigravityChildSession, antigravitySessionState } from "../lib/antigravity-words.mjs";
import { appendWords, committedWords, queueOwnerPrompt } from "../lib/owner-words.mjs";
import { sessionOpenWords } from "../word-gate.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, repo, scripts, skill, temp } from "./helpers.mjs";

const project = "/work/example-app";
const word = (id, session, text) => ({ id, time: "2026-11-21T05:26:13Z", source: "claude", session, text, sha256: "x" });

function setup() {
  const r = repo({ "README.md": "records\n" });
  appendWords(r, [word("W-000000000a", "s1", "我们要反向拒绝的就是东西记录在上下文中"), word("W-000000000b", "s1", "按推荐。"), word("W-000000000c", "s0", "older session")]);
  return r;
}
const gate = (r, input, max, projects = project, env = {}) => spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), "--records", r, "--project", projects, ...(max ? ["--max-blocks", String(max)] : [])],
  { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, TMPDIR: join(r, ".git"), T3CODE_THREAD_ID: "", ...env } });

test("blocks the turn while this session's words are open, naming each; other sessions and projects never block", () => {
  const r = setup();
  const out = gate(r, { session_id: "s1", cwd: `${project}/x`, stop_hook_active: false });
  assert.equal(out.status, 0);
  const decision = JSON.parse(out.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /W-000000000a/);
  assert.match(decision.reason, /W-000000000b/);
  assert.doesNotMatch(decision.reason, /W-000000000c/, "an older session's backlog does not hold this turn");
  assert.equal(gate(r, { session_id: "s0x", cwd: project }).stdout, "");
  assert.equal(gate(r, { session_id: "s1", cwd: "/elsewhere" }).stdout, "");
});

test("a word is settled by a record that cites it or by a mark; then the turn may end", () => {
  const r = setup();
  writeFileSync(join(r, "records.json"), JSON.stringify({ extraKinds: [] }));
  git(r, "add", "records.json");
  git(r, "commit", "-qm", "config");
  const purpose = join(r, "purpose");
  spawnSync("mkdir", ["-p", purpose]);
  writeFileSync(join(purpose, "P-0009.md"), "# P-0009 Everything on record\n\nwords: W-000000000a\n");
  git(r, "add", "purpose/P-0009.md");
  git(r, "commit", "-qm", "P-0009");
  const left = JSON.parse(gate(r, { session_id: "s1", cwd: project }).stdout);
  assert.doesNotMatch(left.reason, /W-000000000a/);
  assert.match(left.reason, /W-000000000b/);
  const mark = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "mark", "--records", r, "--id", "W-000000000b", "--as", "routine", "--note", "a go-ahead"], { encoding: "utf8" });
  assert.equal(mark.status, 0, mark.stderr);
  assert.equal(gate(r, { session_id: "s1", cwd: project }).stdout, "");
});

test("never loops forever: after --max-blocks refusals for the same words it lets the turn end; a broken input never traps", () => {
  const r = setup();
  const input = { session_id: "s-loop", cwd: project };
  appendWords(r, [word("W-000000000d", "s-loop", "x")]);
  assert.equal(JSON.parse(gate(r, input, 2).stdout).decision, "block");
  assert.equal(JSON.parse(gate(r, input, 2).stdout).decision, "block");
  const third = gate(r, input, 2);
  assert.deepEqual([third.status, third.stdout], [0, ""]);
  assert.match(third.stderr, /still open after 2 refusals/);
  const broken = spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), "--records", "/nonexistent", "--project", project], { input: "{", encoding: "utf8" });
  assert.deepEqual([broken.status, broken.stdout], [0, ""]);
});

test("Stop counts this session's pending captures even before the transcript exists", () => {
  const r = setup(), input = { session_id: "s-pending", cwd: project };
  queueOwnerPrompt(r, { session: input.session_id, event: "p", text: "capture awaiting transcript" });
  const block = gate(r, input, 1);
  assert.match(JSON.parse(block.stdout).reason, /pending.*capture awaiting transcript/);
  const exhausted = gate(r, input, 1);
  assert.equal(exhausted.stdout, "");
  assert.match(exhausted.stderr, /pending.*after 1 refusals/);
  assert.equal(gate(r, { ...input, session_id: "s-unrelated" }).stdout, "");
});

const ownerWords = (r, ...args) => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), ...args, "--records", r], {
  encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: join(r, ".git", "claude"), CODEX_HOME: join(r, ".git", "codex"),
    GEMINI_HOME: join(r, ".git", "gemini"), ANTIGRAVITY_APP_DATA_DIR: "", T3CODE_HOME: "" },
});
const archivedPrompt = path => JSON.parse(readFileSync(join(dirname(path), "discarded", basename(path)), "utf8"));

test("Stop and sync archive legacy captures that the current prompt hook would reject", () => {
  const r = setup(), input = { session_id: "legacy", cwd: project };
  const legacy = { session: "legacy", event: "report", text: "Delegated task node:delegated-task:abc (Review) [completed]: done" };
  const path = queueOwnerPrompt(r, legacy);
  assert.equal(gate(r, input).stdout, "");
  assert.equal(existsSync(path), false);
  assert.equal(archivedPrompt(path).text, legacy.text);
  assert.match(archivedPrompt(path).note, /capture filter/);
  const lead = queueOwnerPrompt(r, { ...legacy, event: "lead", text: "[lead → agent] do this" });
  const sync = ownerWords(r, "sync", "--project", project);
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(JSON.parse(sync.stdout).pending, []);
  assert.equal(existsSync(lead), false);
  assert.match(archivedPrompt(lead).note, /capture filter/);
});

test("pending --discard archives a selected capture with its reason and stops it blocking", () => {
  const r = setup(), input = { session_id: "discard", cwd: project };
  const prompt = { session: "discard", event: "pending", text: "unmatched hook payload" };
  const path = queueOwnerPrompt(r, prompt), key = basename(path, ".json");
  assert.match(JSON.parse(gate(r, input).stdout).reason, new RegExp(key));
  assert.equal(ownerWords(r, "pending", "--discard", key).status, 64);
  const note = "confirmed duplicate of an earlier capture";
  const discard = ownerWords(r, "pending", "--discard", key, "--note", note);
  assert.equal(discard.status, 0, discard.stderr);
  assert.equal(existsSync(path), false);
  assert.equal(archivedPrompt(path).note, note);
  queueOwnerPrompt(r, prompt);
  assert.equal(gate(r, input).stdout, "");
  assert.equal(existsSync(path), false);
});

test("an exhausted pending capture keeps its budget when a word or a different capture arrives", () => {
  const r = setup(), input = { session_id: "budget", cwd: project };
  queueOwnerPrompt(r, { session: "budget", event: "first", text: "first pending" });
  assert.match(JSON.parse(gate(r, input, 1).stdout).reason, /first pending/);
  assert.equal(gate(r, input, 1).stdout, "");

  const newId = "W-000000000d";
  appendWords(r, [word(newId, "budget", "new owner word")]);
  const wordReason = JSON.parse(gate(r, input, 1).stdout).reason;
  assert.match(wordReason, new RegExp(newId));
  assert.doesNotMatch(wordReason, /first pending/);
  assert.equal(ownerWords(r, "mark", "--id", newId, "--as", "routine", "--note", "a go-ahead").status, 0);
  assert.equal(gate(r, input, 1).stdout, "");

  queueOwnerPrompt(r, { session: "budget", event: "second", text: "second pending" });
  const pendingReason = JSON.parse(gate(r, input, 1).stdout).reason;
  assert.match(pendingReason, /second pending/);
  assert.doesNotMatch(pendingReason, /first pending/);
  assert.equal(gate(r, input, 1).stdout, "");
});

function newWord(r) {
  const transcript = join(r, ".git", "s1.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", sessionId: "s1", cwd: project, promptId: "new", message: { content: "new word" } }));
  return { cwd: project, session_id: "s1", transcript_path: transcript };
}

test("Stop checks the committed words even with a locked records ref", () => {
  const r = setup(), input = newWord(r);
  const ref = git(r, "symbolic-ref", "HEAD");
  writeFileSync(join(r, ".git", ref + ".lock"), "");
  const out = gate(r, input);
  assert.match(JSON.parse(out.stdout).reason, /W-000000000a/);
  assert.match(out.stderr, /sync failed/i);
});

test("Stop uses the capture project list parser and avoids recording delegated threads", () => {
  const r = setup(), input = newWord(r);
  assert.equal(gate(r, input, 3, project, { T3CODE_THREAD_ID: "thread:delegated-task:child" }).stdout, "");
  assert.equal(committedWords(r).length, 3);
  assert.match(JSON.parse(gate(r, input, 3, "/another, " + project).stdout).reason, /new word/);
});

test("D-0007: the arrival and settlement of a new word do not re-arm an exhausted word", () => {
  const r = setup(), input = { session_id: "upgrade-cycle", cwd: project };
  const oldId = "W-31fe7bfa74", newId = "W-18437591dd";
  appendWords(r, [word(oldId, input.session_id, "older unfiled word")]);
  for (let i = 0; i < 3; i++) assert.match(JSON.parse(gate(r, input).stdout).reason, new RegExp(oldId));
  assert.equal(gate(r, input).stdout, "");

  appendWords(r, [word(newId, input.session_id, "new owner word")]);
  const next = JSON.parse(gate(r, input).stdout).reason;
  assert.match(next, new RegExp(newId));
  assert.doesNotMatch(next, new RegExp(oldId));
  assert.equal(ownerWords(r, "mark", "--id", newId, "--as", "routine", "--note", "go-ahead").status, 0);

  const exhausted = gate(r, input);
  assert.equal(exhausted.stdout, "");
  assert.match(exhausted.stderr, new RegExp(oldId + " still open after 3 refusals"));
});

test("D-0007: the upgrade keeps the refusals recorded for a legacy set of words", () => {
  const r = setup(), input = { session_id: "s1", cwd: project };
  const dir = join(r, ".git", "self-loop-word-gate");
  mkdirSync(dir);
  writeFileSync(join(dir, "s1.json"), JSON.stringify({ key: "W-000000000a,W-000000000b", blocks: 3 }));
  assert.equal(ownerWords(r, "mark", "--id", "W-000000000a", "--as", "routine", "--note", "go-ahead").status, 0);
  const exhausted = gate(r, input);
  assert.equal(exhausted.stdout, "");
  assert.match(exhausted.stderr, /W-000000000b still open after 3 refusals/);
});

test("D-0007: Stop hints use the owner-words script next to the running release", () => {
  const r = setup();
  const release = join(realpathSync(temp()), "release with spaces"), releaseScripts = join(release, "scripts");
  cpSync(scripts, releaseScripts, { recursive: true, filter: path => path !== join(scripts, "test") });
  cpSync(join(skill, "RECORDS.md"), join(release, "RECORDS.md"));
  const input = { session_id: "s1", cwd: project };
  queueOwnerPrompt(r, { session: "s1", event: "pending", text: "awaiting the transcript" });
  const run = () => spawnSync(process.execPath, [join(releaseScripts, "word-gate.mjs"), "--records", r, "--project", project, "--max-blocks", "1"],
    { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, TMPDIR: join(r, ".git"), T3CODE_THREAD_ID: "" } });

  const blocked = run();
  assert.ok(blocked.stdout, blocked.stderr);
  const hint = JSON.parse(blocked.stdout).reason;
  const command = "node '" + join(releaseScripts, "owner-words.mjs") + "'";
  for (const subcommand of ["mark", "sync", "pending --discard"])
    assert.ok(hint.includes(command + " " + subcommand), hint);
  const exhausted = run();
  assert.equal(exhausted.stdout, "");
  for (const subcommand of ["open", "pending --discard"])
    assert.ok(exhausted.stderr.includes(command + " " + subcommand), exhausted.stderr);
});

test("word-gate accepts prefixed *_NO_TOOL_CALL terminationReason and bounds ambiguous --owner-store refusals", () => {
  const shared = temp("wg-shared-");
  const a = loopProduct({ loop: { projects: [shared] } });
  const b = loopProduct({ loop: { projects: [shared] } });
  const store = ownerStore([{ name: "alpha", records: a.records }, { name: "beta", records: b.records }]);
  appendWords(a.records, [word("W-00000000aa", "conv-pref", "prefixed termination test")]);
  const env = isolatedEnv({ TMPDIR: temp("wg-tmp-"), T3CODE_THREAD_ID: "" });

  const prefixed = spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), "--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"], {
    input: JSON.stringify({ hookEventName: "Stop", conversationId: "conv-pref", cwd: a.product, terminationReason: "TERMINATION_REASON_NO_TOOL_CALL", fullyIdle: true, continuationActive: false }),
    encoding: "utf8", env,
  });
  assert.equal(prefixed.status, 0, prefixed.stderr);
  assert.equal(JSON.parse(prefixed.stdout).decision, "continue");

  const ambig = () => spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), "--harness", "antigravity", "--owner-store", store, "--max-blocks", "1"], {
    input: JSON.stringify({ hookEventName: "Stop", conversationId: "conv-ambig", cwd: shared, terminationReason: "NO_TOOL_CALL", fullyIdle: true, continuationActive: false }),
    encoding: "utf8", env,
  });
  const first = JSON.parse(ambig().stdout);
  assert.equal(first.decision, "continue");
  assert.match(first.reason, /multiple registered products/);
  assert.deepEqual(JSON.parse(ambig().stdout), {});
});

test("antigravitySessionState and Stop separate confirmed-child, unresolved, and owner transcripts", () => {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const appDir = temp("wg-ag-states-"), prod = loopProduct(), store = ownerStore([{ name: "alpha", records: prod.records }]);
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, TMPDIR: temp("wg-ag-tmp-"), T3CODE_THREAD_ID: "", T3CODE_HOME: "" });
  const wrap = body => `<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>\n</USER_REQUEST>`;
  const step = (step_index, content, extra = {}) => ({ step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", ...(content !== undefined ? { content } : {}), ...extra });
  const writeTx = (id, name, rows) => {
    const dir = join(appDir, "brain", id, ".system_generated", "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, rows.map(r => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
    return file;
  };
  const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
  db.exec("CREATE TABLE conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT DEFAULT '', nesting_depth INTEGER DEFAULT 0)");
  const ins = db.prepare("INSERT INTO conversation_summaries (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth) VALUES (?, ?, ?, ?, ?)");
  ins.run("c-db-child", JSON.stringify([pathToFileURL(prod.product).href]), "CASCADE_RUN_STATUS_IDLE", "parent-root", 1);
  ins.run("c-unresolved", JSON.stringify([pathToFileURL(prod.product).href]), "CASCADE_RUN_STATUS_IDLE", "", 0);
  ins.run("c-owner", JSON.stringify([pathToFileURL(prod.product).href]), "CASCADE_RUN_STATUS_IDLE", "", 0);
  db.close();

  const childLeadTx = writeTx("c-lead-child", "transcript_full.jsonl", [step(0, wrap("Act as the actor sub-agent for this task.\n\nself-loop call R-0001-actor"))]);
  const dbChildTx = writeTx("c-db-child", "transcript_full.jsonl", [step(0, wrap("Subagent task without lead markers"))]);
  const unclosedTx = writeTx("c-unresolved", "transcript.jsonl", [step(0, "<USER_REQUEST>\n<truncated 800 bytes>"), step(1, wrap("Unverified step-1"))]);
  const corruptTx = writeTx("c-corrupt", "transcript.jsonl", ['{"step_index":0,"type":"USER_INPUT"', step(1, wrap("Unverified after corrupt"))]);
  const ownerTx = writeTx("c-owner", "transcript_full.jsonl", [step(0, wrap("Verified owner prompt"))]);

  assert.equal(antigravitySessionState(childLeadTx).state, "confirmed-child");
  assert.equal(antigravityChildSession(childLeadTx), true);
  assert.equal(antigravitySessionState(dbChildTx).state, "confirmed-child");
  assert.equal(antigravityChildSession(dbChildTx), true);
  assert.equal(antigravitySessionState(null, { summary: { nesting_depth: 1 } }).state, "confirmed-child");

  for (const [label, tx] of [["unclosed", unclosedTx], ["corrupt", corruptTx], ["unreadable-dir", appDir]]) {
    const st = antigravitySessionState(tx);
    assert.equal(st.state, "unresolved", label);
    assert.equal(st.unresolved, true, label);
    assert.equal(st.agent, false, label);
    assert.equal(antigravityChildSession(tx), false, label);
  }

  assert.equal(antigravitySessionState(ownerTx).state, "owner");
  assert.equal(antigravityChildSession(ownerTx), false);
  assert.equal(antigravitySessionState(join(appDir, "missing.jsonl")).state, "owner");

  appendWords(prod.records, [
    { ...word("W-0000000011", "c-unresolved", "Committed owner word"), source: "antigravity" },
    { ...word("W-0000000012", "c-db-child", "Tagged to db child"), source: "antigravity" },
  ]);
  queueOwnerPrompt(prod.records, { source: "antigravity", session: "c-unresolved", event: "step-0", time: "2026-11-23T01:00:00Z", text: "Pending owner prompt" });

  const openRes = sessionOpenWords(
    { hookEventName: "Stop", conversationId: "c-unresolved", transcriptPath: unclosedTx, cwd: prod.product, continuationActive: false, fullyIdle: true, terminationReason: "NO_TOOL_CALL" },
    { records: prod.records, projects: [prod.product], env, harness: "antigravity" }
  );
  assert.deepEqual(openRes.open.map(w => w.id), ["W-0000000011"]);
  assert.equal(openRes.pending.length, 1);
  assert.equal(committedWords(prod.records).some(w => w.text === "Unverified step-1"), false);

  const runStop = (extraArgs, payload) => spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), "--harness", "antigravity", ...extraArgs], { input: JSON.stringify(payload), encoding: "utf8", env });
  const dbChildGlobal = runStop(["--owner-store", store], { hookEventName: "Stop", conversationId: "c-db-child", transcriptPath: dbChildTx, cwd: prod.product, continuationActive: false, fullyIdle: true, terminationReason: "NO_TOOL_CALL" });
  assert.deepEqual(JSON.parse(dbChildGlobal.stdout), {});

  const ownerStop = runStop(["--owner-store", store], { hookEventName: "Stop", conversationId: "c-owner", transcriptPath: ownerTx, cwd: prod.product, continuationActive: false, fullyIdle: true, terminationReason: "NO_TOOL_CALL" });
  assert.equal(JSON.parse(ownerStop.stdout).decision, "continue");
  assert.ok(committedWords(prod.records).some(w => w.text === "Verified owner prompt"));
});
