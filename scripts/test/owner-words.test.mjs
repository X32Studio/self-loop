// F-0002, D-0002, D-0006, D-0007, D-0052, R-0032-reviewer-architecture
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { antigravityTranscript } from "../lib/antigravity-words.mjs";
import { appendWords, claudeSessionWords, claudeSlug, codexSessionWords, committedWords, transcriptWords, WORDS } from "../lib/owner-words.mjs";
import { hookWord } from "../owner-words.mjs";
import { sessionOpenWords } from "../word-gate.mjs";
import { openWords } from "../records-check.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, repo, scripts, selfLoop, skill, temp } from "./helpers.mjs";

const project = "/work/example-app";
const claudeRow = (text, extra = {}) => ({ type: "user", cwd: project, sessionId: "s1", timestamp: "2026-11-21T01:00:00Z", promptSource: "sdk", message: { role: "user", content: text }, ...extra });
const codexRows = (meta, texts) => [
  { type: "session_meta", payload: { id: meta.id ?? "c1", cwd: project, ...meta } },
  { type: "response_item", timestamp: "2026-11-21T02:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n</environment_context>" }] } },
  ...texts.map(t => ({ type: "response_item", timestamp: "2026-11-21T02:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } })),
];
const write = (file, rows) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); return file; };
const records = () => repo({ "README.md": "records\n" });

test("Claude: the owner's prompts count; notices, tool results, summaries and agent sessions do not", () => {
  const dir = temp();
  const lead = write(join(dir, "lead.jsonl"), [
    claudeRow("Context handoff (full_thread_summary):\nsummary"),
    claudeRow("实现方用opus 5.5 xhigh，攻击方用gpt 6.2 sol"),
    claudeRow("<task-notification>\n<task-id>x</task-id>", { promptSource: "system", origin: { kind: "task-notification" } }),
    claudeRow("Delegated task node:delegated-task:abc [completed]: done"),
    claudeRow("This session is being continued from a previous conversation", { isCompactSummary: true }),
    { type: "user", sessionId: "s1", toolUseResult: {}, message: { content: [{ type: "tool_result", content: "x" }] } },
    claudeRow("可以"), claudeRow("可以"),
  ]);
  const words = claudeSessionWords(lead);
  assert.deepEqual(words.map(w => w.text), ["实现方用opus 5.5 xhigh，攻击方用gpt 6.2 sol", "可以", "可以"]);
  assert.notEqual(words[1].id, words[2].id, "the same text twice in a session is two words");
  const child = write(join(dir, "child.jsonl"), [claudeRow("Act as the implementation sub-agent for this task.\n\nself-loop call R-0042-actor · nonce n"), claudeRow("继续")]);
  assert.deepEqual(claudeSessionWords(child), [], "a session T3 started for an agent holds no owner words");
  const lead2 = write(join(dir, "lead2.jsonl"), [claudeRow("[lead → agent] do this")]);
  assert.deepEqual(claudeSessionWords(lead2), []);
});

// D-0006
test("Claude slash commands keep the typed arguments, including through capture and sync", () => {
  const r = records(), dir = temp(), fixture = join(scripts, "test/fixtures/d0006-claude-slash.jsonl");
  const args = "检查回归，  保留空格。";
  assert.deepEqual(claudeSessionWords(fixture, [project], { session: "slash-goal" }).map(w => w.text), [args]);
  assert.deepEqual(claudeSessionWords(fixture, [project], { session: "slash-compact" }), []);
  const transcript = join(dir, "slash-goal.jsonl");
  const env = { ...process.env, T3CODE_THREAD_ID: "" };
  const capture = () => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--records", r, "--project", project],
    { input: JSON.stringify({ session_id: "slash-goal", cwd: project, prompt: `/goal ${args}`, prompt_id: "typed", transcript_path: transcript }), encoding: "utf8", env });
  assert.match(capture().stdout, /saved pending transcript/);
  writeFileSync(transcript, readFileSync(fixture));
  assert.deepEqual(sessionOpenWords({ session_id: "slash-goal", cwd: project, transcript_path: transcript },
    { records: r, projects: [project], env }).pending, []);
  assert.deepEqual(committedWords(r).map(w => w.text), [args]);
});

test("a T3 context hand-off: the summary is not the owner's, the message after its last `User message:` line is", () => {
  const dir = temp();
  const handoff = "Context handoff (full_thread_summary):\nProvider context handoff. Thread: t.\n\nUser message:\nquoted earlier\n\nUser message:\n他们的开发不是开放性问题，主要是针对具体feature的开发和验证，提交";
  const lead = write(join(dir, "handoff.jsonl"), [claudeRow(handoff), claudeRow("可以")]);
  assert.deepEqual(claudeSessionWords(lead).map(w => w.text), ["他们的开发不是开放性问题，主要是针对具体feature的开发和验证，提交", "可以"]);
  assert.deepEqual(claudeSessionWords(write(join(dir, "bare.jsonl"), [claudeRow("Context handoff (full_thread_summary):\nsummary only")])), []);
  const codex = write(join(dir, "codex.jsonl"), codexRows({ id: "c9", source: "vscode" }, [handoff]));
  assert.deepEqual(codexSessionWords(codex, [project]).map(w => w.text), ["他们的开发不是开放性问题，主要是针对具体feature的开发和验证，提交"]);
});

test("Codex: only sessions the owner drove inside the project; injected context is not the owner's", () => {
  const dir = temp();
  const owner = write(join(dir, "o.jsonl"), codexRows({ id: "c1", source: "vscode", originator: "T3 Code" }, ["# AGENTS.md instructions for /work", "Name the project example-app"]));
  assert.deepEqual(codexSessionWords(owner, [project]).map(w => w.text), ["Name the project example-app"]);
  for (const meta of [{ thread_source: "subagent" }, { forked_from_id: "c1" }, { parent_thread_id: "c1" }, { source: "exec", originator: "codex_exec" }])
    assert.deepEqual(codexSessionWords(write(join(dir, `${JSON.stringify(meta).length}.jsonl`), codexRows(meta, ["x"])), [project]), [], JSON.stringify(meta));
  assert.deepEqual(codexSessionWords(write(join(dir, "else.jsonl"), codexRows({ cwd: "/elsewhere" }, ["x"])), [project]), []);
});

// D-0006
test("Codex prefers user events and excludes hand-off fragments and internal context in every representation", () => {
  const file = join(scripts, "test/fixtures/d0006-codex-handoff.jsonl"), dir = temp();
  const rows = readFileSync(file, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  const expected = ["This thread's goal is already set. Do not call create_goal. Start working on it now: Redacted typed goal.",
    "都换成gpt 继续推进 fast模式"];
  const words = codexSessionWords(file, [project]);
  assert.deepEqual(words.map(w => w.text), expected);
  assert.deepEqual(words.map(w => w.event), ["event_msg-goal-2", "event_msg-owner-8"]);
  const responses = rows.filter(row => row.type !== "event_msg");
  assert.deepEqual(codexSessionWords(write(join(dir, "fallback.jsonl"), responses), [project]).map(w => w.text), expected);
  for (const type of ["user_message", "item_completed"]) {
    const events = responses.map(({ type: rowType, timestamp, payload }) => rowType === "session_meta"
      ? { type: rowType, timestamp, payload }
      : { type: "event_msg", timestamp, payload: type === "user_message"
        ? { type, message: payload.content[0].text }
        : { type, item: { type: "UserMessage", content: payload.content } } });
    assert.deepEqual(codexSessionWords(write(join(dir, `${type}.jsonl`), events), [project]).map(w => w.text), expected);
  }
});

test("append: words are committed alone on HEAD, deduplicated by ID; a staged file never rides along", () => {
  const r = records();
  writeFileSync(join(r, "draft.md"), "lead's draft\n");
  git(r, "add", "draft.md");
  const w = { id: "W-0000000001", time: "t", source: "claude", session: "s", text: "可以", sha256: "x" };
  const first = appendWords(r, [w, w]);
  assert.equal(first.added, 1);
  assert.deepEqual(git(r, "show", "--name-only", "--format=", "HEAD").split("\n"), [WORDS]);
  assert.equal(git(r, "diff", "--cached", "--name-only"), "draft.md", "the lead's staged file stays staged and uncommitted");
  assert.equal(readFileSync(join(r, WORDS), "utf8"), `${JSON.stringify(w)}\n`, "the working file follows the commit");
  assert.equal(git(r, "status", "--porcelain", "--", WORDS), "", "and the index entry too");
  assert.equal(appendWords(r, [w]).added, 0);
  assert.equal(committedWords(r).length, 1);
});

test("hook: records the owner's prompt in the project; skips other projects, agent sessions and notices; never blocks", () => {
  const r = records();
  const dir = temp();
  const input = (prompt, extra = {}) => JSON.stringify({ session_id: "s9", cwd: `${project}/sub`, prompt, ...extra });
  const run = (stdin, env = {}) => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--records", r, "--project", project], { input: stdin, encoding: "utf8", env: { ...process.env, T3CODE_THREAD_ID: "", ...env } });
  const transcript = join(dir, "s9.jsonl"), rows = [];
  const capture = (prompt, promptId) => {
    rows.push(claudeRow(prompt, { sessionId: "s9", cwd: `${project}/sub`, timestamp: new Date().toISOString(), promptId }));
    write(transcript, rows);
    return run(input(prompt, { transcript_path: transcript, prompt_id: promptId }));
  };
  const ok = capture("我希望你有agents.md来强制要求你记录我说的话", "first");
  assert.deepEqual([ok.status, ok.stdout], [0, ""]);
  assert.equal(capture("可以", "second").status, 0);
  assert.equal(capture("可以", "third").status, 0);
  assert.deepEqual(committedWords(r).map(w => w.text), ["我希望你有agents.md来强制要求你记录我说的话", "可以", "可以"]);
  run(JSON.stringify({ session_id: "s9", cwd: "/elsewhere", prompt: "x" }));
  run(input("<task-notification>\n<task-id>1</task-id>"));
  run(input("Act as the review sub-agent for this task.\n\nreview"));
  run(input("继续"), { T3CODE_THREAD_ID: "thread:delegated-task:abc" });
  const child = write(join(dir, "child.jsonl"), [claudeRow("Act as the design sub-agent for this task.\n\nYour task is the file /x")]);
  run(input("继续", { transcript_path: child }));
  assert.equal(committedWords(r).length, 3, "none of those is the owner's");
  const broken = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--records", join(dir, "missing"), "--project", project], { input: input("x"), encoding: "utf8", env: { ...process.env, T3CODE_THREAD_ID: "" } });
  assert.equal(broken.status, 0, "a failure never blocks the owner's prompt");
  assert.match(broken.stdout, /NOT recorded/, "but it is shown to the lead");
});

test("sync finds what the hook recorded under the same IDs, and open lists what no record cites or marks", () => {
  const r = records();
  const home = temp();
  const transcript = join(home, "claude", "projects", claudeSlug(project), "s9.jsonl");
  const rows = ["我希望你有agents.md来强制要求你记录我说的话", "可以", "可以"]
    .map((text, i) => claudeRow(text, { sessionId: "s9", promptId: `event-${i}` }));
  write(transcript, rows.slice(0, 2));
  const input = JSON.stringify({ session_id: "s9", cwd: project, prompt: "可以", transcript_path: transcript, prompt_id: "event-1" });
  const capture = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--records", r, "--project", project],
    { input, env: { ...process.env, T3CODE_THREAD_ID: "" }, encoding: "utf8" });
  assert.deepEqual([capture.status, capture.stdout], [0, ""]);
  write(transcript, rows);
  const found = transcriptWords([project], { claudeHome: join(home, "claude"), codexHome: join(home, "codex") });
  assert.equal(found.length, 3);
  assert.equal(appendWords(r, found).added, 1, "only the second 可以 was missing");
  const [agents] = committedWords(r);
  mkdirSync(join(r, "purpose"));
  writeFileSync(join(r, "purpose/P-0001.md"), `# P-0001\n\nwords: ${agents.id}\n`);
  git(r, "add", "purpose/P-0001.md");
  git(r, "commit", "-qm", "P");
  assert.equal(openWords(r).length, 2, "the cited word is distilled; the two go-aheads are open");
  const cli = (...a) => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), ...a, "--records", r], { encoding: "utf8" });
  assert.equal(cli("open").status, 2);
  for (const w of openWords(r)) assert.equal(cli("mark", "--id", w.id, "--as", "routine", "--note", "a go-ahead").status, 0);
  assert.equal(cli("open").status, 0);
  assert.equal(cli("mark", "--id", agents.id, "--as", "routine", "--note", "x").status, 0, "a cited word may still be marked");
  assert.equal(cli("mark", "--id", "W-ffffffffff", "--as", "routine", "--note", "x").status, 64, "only a recorded word");
});

test("the phase convergence gate requires the committed owner word check to exit zero", () => {
  const row = readFileSync(join(skill, "SKILL.md"), "utf8").split("\n").find(line => line.startsWith("| the phase converged |"));
  const [, , commands, conditions] = row.split("|");
  assert.match(commands, /`owner-words\.mjs open --records <records>`/);
  assert.match(conditions, /owner words.*exit 0/);
});

test("B06: a hook and sync share transcript identity across a missed repeat and a replay", () => {
  const r = records(), home = temp();
  const claudeHome = join(home, "claude"), codexHome = join(home, "codex");
  const transcript = join(claudeHome, "projects", claudeSlug(project), "s1.jsonl");
  const row = (time, uuid) => claudeRow("yes", { cwd: project, timestamp: time, uuid });
  const first = row("2026-11-21T01:01:00Z", "first"), second = row("2026-11-21T01:02:00Z", "second");
  const env = { ...process.env, T3CODE_THREAD_ID: "", CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };
  const capture = () => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--records", r, "--project", project],
    { env, encoding: "utf8", input: JSON.stringify({ session_id: "s1", cwd: project, prompt: "yes", transcript_path: transcript }) });
  write(transcript, [first, second]);
  assert.equal(capture().status, 0);
  assert.deepEqual(committedWords(r).map(w => w.time), [first.timestamp, second.timestamp]);
  appendWords(r, transcriptWords([project], { claudeHome, codexHome }));
  assert.equal(capture().status, 0);
  assert.deepEqual(committedWords(r).map(w => w.time), [first.timestamp, second.timestamp]);
});

test("B07: raw whitespace and prose with a notice-like prefix survive capture and sync", () => {
  const text = "    keep indentation\n", prose = "Caveat: retain the old format.";
  const file = write(join(temp(), "human.jsonl"), [claudeRow(text), claudeRow(prose)]);
  assert.deepEqual(claudeSessionWords(file).map(w => w.text), [text, prose]);
  assert.equal(hookWord({ cwd: project, session_id: "s1", prompt: text }, [project], records(), {}).text, text);
  assert.equal(hookWord({ cwd: project, session_id: "s1", prompt: prose }, [project], records(), {}).text, prose);
});

test("B08: Claude discovery scans nested projects and filters each row by cwd, not the slug", () => {
  const root = temp(), claudeHome = temp(), codexHome = temp();
  const inside = join(root, "app.x"), collision = join(root, "app-x"), nested = join(inside, "src");
  mkdirSync(nested, { recursive: true });
  mkdirSync(collision);
  write(join(claudeHome, "projects", claudeSlug(nested), "nested.jsonl"), [
    claudeRow("nested owner", { cwd: nested }), claudeRow("out of project", { cwd: collision }),
  ]);
  write(join(claudeHome, "projects", claudeSlug(collision), "collision.jsonl"), [claudeRow("collision", { cwd: collision })]);
  assert.deepEqual(transcriptWords([inside, nested], { claudeHome, codexHome }).map(w => w.text), ["nested owner"]);
});

test("B09: Codex skips structured subagents and recovers only the new part of a human fork", () => {
  const codexHome = temp(), claudeHome = temp(), dir = join(codexHome, "archived_sessions");
  write(join(dir, "parent.jsonl"), codexRows({ id: "parent" }, ["inherited"]));
  write(join(dir, "fork.jsonl"), codexRows({ id: "fork", forked_from_id: "parent" }, ["inherited", "human fork instruction"]));
  write(join(dir, "agent.jsonl"), codexRows({ id: "agent", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }, ["agent brief"]));
  assert.deepEqual(new Set(transcriptWords([project], { codexHome, claudeHome }).map(w => w.text)), new Set(["inherited", "human fork instruction"]));
});

test("B10: only citations in distillation records can settle a word", () => {
  const r = records();
  const word = { id: "W-0000000001", time: "t", source: "claude", session: "s", text: "word", sha256: "fixture" };
  appendWords(r, [word]);
  for (const path of ["evidence/0001/list.md", "design/area.md", "rounds/0001-actor.md", "README.md"]) {
    mkdirSync(join(r, path, ".."), { recursive: true });
    writeFileSync(join(r, path), `# Pending\n\nwords: ${word.id}\n`);
    git(r, "add", path);
  }
  git(r, "commit", "-qm", "store reference lists");
  assert.deepEqual(openWords(r).map(w => w.id), [word.id]);
  mkdirSync(join(r, "lessons"));
  writeFileSync(join(r, "lessons/L-0001.md"), `# L-0001\n\nThe owner requested the exact wording (${word.id}).\n`);
  git(r, "add", "lessons");
  git(r, "commit", "-qm", "cite word in a lesson");
  assert.deepEqual(openWords(r), []);
});

test("a pre-transcript hook keeps the raw prompt pending and the stop gate settles its identity after persistence", () => {
  const r = records(), transcript = join(temp(), "s1.jsonl"), text = "    raw prompt\n";
  const input = { session_id: "s1", cwd: project, prompt: text, transcript_path: transcript, prompt_id: "event-1" };
  const capture = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--records", r, "--project", project],
    { input: JSON.stringify(input), env: { ...process.env, T3CODE_THREAD_ID: "" }, encoding: "utf8" });
  assert.equal(capture.status, 0);
  assert.match(capture.stdout, /saved pending transcript/);
  assert.deepEqual(committedWords(r), []);
  write(transcript, [claudeRow(text, { promptId: "event-1" })]);
  const { open } = sessionOpenWords(input, { records: r, projects: [project], env: {} });
  assert.deepEqual(open.map(w => w.text), [text]);
  assert.deepEqual(committedWords(r), open);
});

test("D-0002: the real Claude transcript yields exactly the owner's words", () => {
  const fixture = join(scripts, "test", "fixtures");
  const transcript = join(fixture, "d0002-claude.jsonl");
  const expected = JSON.parse(readFileSync(join(fixture, "d0002-words.json"), "utf8"));
  const rows = readFileSync(transcript, "utf8").trimEnd().split("\n").map(JSON.parse);
  const first = rows[0], last = rows.at(-1), r = records();
  const input = { session_id: first.sessionId, cwd: first.cwd, transcript_path: transcript, prompt: last.message.content, prompt_id: last.promptId };
  const run = (script, args) => spawnSync(process.execPath, [join(scripts, script), ...args, "--records", r, "--project", first.cwd],
    { input: JSON.stringify(input), env: { ...process.env, T3CODE_THREAD_ID: "", TMPDIR: join(r, ".git") }, encoding: "utf8" });
  assert.deepEqual(claudeSessionWords(transcript, [first.cwd]).map(w => w.text), expected);
  assert.equal(run("owner-words.mjs", ["capture"]).status, 0);
  assert.deepEqual(committedWords(r).map(w => w.text), expected);
  const stop = JSON.parse(run("word-gate.mjs", []).stdout);
  assert.equal(stop.decision, "block");
  assert.equal([...stop.reason.matchAll(/W-[0-9a-f]{10} 「/g)].length, expected.length);
});

test("both transcripts keep the owner's quoted delimiter and classify unwrapped notices", () => {
  const hand = "Context handoff (full_thread_summary):\nsummary\n\nUser message:\n";
  const owner = "请保留下面的日志标签。\nUser message:\n例子结束";
  const report = "Delegated task node:delegated-task:review (Title (nested)) [completed]: done";
  const texts = [hand + owner, hand + report, "Context handoff (delta_since_target_last_seen):\nsummary", hand + "  preserve spaces\n"];
  const claude = write(join(temp(), "claude.jsonl"), texts.map(t => claudeRow(t)));
  const codex = write(join(temp(), "codex.jsonl"), codexRows({}, texts));
  for (const words of [claudeSessionWords(claude), codexSessionWords(codex, [project])]) {
    assert.deepEqual(words.map(w => w.text), [owner, "  preserve spaces\n"]);
  }
});

test("a lead's echoed send is excluded once, then the same text from the owner counts", () => {
  const text = "My message";
  const claude = write(join(temp(), "claude.jsonl"), [
    { type: "assistant", sessionId: "s1", message: { content: [{ type: "tool_use", name: "mcp__t3-code__t3_thread_send", input: { message: text } }] } },
    claudeRow(text, { promptId: "echo" }), claudeRow(text, { promptId: "owner" }),
  ]);
  const codexRowsWithSend = codexRows({}, [text, text]);
  codexRowsWithSend.splice(2, 0, { type: "response_item", payload: { type: "function_call", name: "mcp__t3_code__t3_thread_send", arguments: JSON.stringify({ message: text }) } });
  assert.deepEqual(claudeSessionWords(claude).map(w => w.event), ["owner"]);
  assert.deepEqual(codexSessionWords(write(join(temp(), "codex.jsonl"), codexRowsWithSend), [project]).map(w => w.text), [text]);
});

test("upgrading from trimmed words preserves old IDs and records a later repetition verbatim", () => {
  const r = records(), t = "2026-11-21T01:00:00Z";
  const file = write(join(temp(), "legacy.jsonl"), [claudeRow("reply", { timestamp: t })]);
  const [old] = claudeSessionWords(file);
  appendWords(r, [old]);
  write(file, [
    claudeRow("reply\n", { timestamp: t, promptId: "one" }),
    claudeRow("  reply", { timestamp: "2026-11-21T01:01:00Z", promptId: "two" }),
  ]);
  assert.equal(appendWords(r, claudeSessionWords(file)).added, 1);
  assert.deepEqual(committedWords(r).map(w => [w.id, w.text]), [[old.id, "reply"], [claudeSessionWords(file)[1].id, "  reply"]]);
});

test("D-0007: standalone Claude interruption notices are never recorded as owner words", () => {
  const dir = temp();
  const notices = ["[Request interrupted by user]", "[Request interrupted by user for tool use]"];
  const genuine = "Can you explain " + notices[0] + "?";
  const transcript = write(join(dir, "interrupted.jsonl"), [
    ...notices.map((text, i) => claudeRow(text, { promptSource: undefined, promptId: "notice-" + i,
      message: { role: "user", content: [{ type: "text", text }] } })),
    claudeRow(genuine),
    claudeRow("/goal " + notices[0]),
  ]);
  assert.deepEqual(claudeSessionWords(transcript).map(w => w.text), [genuine, "/goal " + notices[0]]);
  for (const prompt of notices)
    assert.equal(hookWord({ prompt, cwd: project, session_id: "s1" }, [project], dir, {}), null);
  const codexTranscript = write(join(dir, "codex.jsonl"), codexRows({}, [notices[0]]));
  assert.deepEqual(codexSessionWords(codexTranscript, [project]).map(w => w.text), [notices[0]]);
});

test("T3 agent relays and child-thread completions are notices in every transcript representation", () => {
  const dir = temp();
  const notices = [
    "[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]\n\nA tool delivered this update.",
    "[T3 Code: this message came through T3 Code's tools, not from the user typing in this chat.]\r\n\r\nAnother tool update.",
    '[T3 Code: the agent in T3 thread "thread:delegated-task:sample" sent this message, not the user.]\n\nReady for review.',
    '[T3 Code: the agent in T3 thread "mcp:launch:sample" on linked environment "remote-sample" sent this message, not the user.]\r\n\r\nReady for review.',
    'Delegated task node:delegated-task:sample (Review (nested title)) in child thread thread:delegated-task:sample [completed]:\nReport available.',
    'Delegated task thread:delegated-task:sample in child thread thread:delegated-task:sample [failed]:\nProvider unavailable.',
    'Delegated task node:delegated-task:sample (Remote review) [cancelled]:\nCancelled.',
  ];
  const quoted = 'Please explain this notification:\n' + notices[0];
  const inline = notices[0].split('\n')[0] + ' is the header I want you to explain.';
  const quotedAgent = 'Explain this agent notice:\n' + notices[2];
  const texts = ['Keep this exact request.  ', ...notices, quoted, inline, quotedAgent, 'Keep this exact request.  '];
  const expected = [texts[0], quoted, inline, quotedAgent, texts.at(-1)];
  assert.deepEqual(claudeSessionWords(write(join(dir, 'lead.jsonl'), texts.map(t => claudeRow(t)))).map(w => w.text), expected);
  const baseline = codexSessionWords(write(join(dir, 'baseline.jsonl'), codexRows({ id: 'notice-session' }, expected)), [project]);
  for (const representation of ['response_item', 'user_message', 'item_completed']) {
    const rows = codexRows({ id: 'notice-session' }, texts).map(row => {
      if (row.type === 'session_meta' || representation === 'response_item') return row;
      const payload = representation === 'user_message'
        ? { type: 'user_message', message: row.payload.content[0].text }
        : { type: 'item_completed', item: { type: 'UserMessage', content: row.payload.content } };
      return { type: 'event_msg', timestamp: row.timestamp, payload };
    });
    const words = codexSessionWords(write(join(dir, representation + '.jsonl'), rows), [project]);
    assert.deepEqual(words.map(w => w.text), expected, representation);
    assert.deepEqual(words.map(w => w.id), baseline.map(w => w.id), 'Notices do not renumber repeated owner requests.');
  }
  const r = records();
  for (const prompt of notices) assert.equal(hookWord({ session_id: 'notice-hook', cwd: project, prompt }, [project], r, {}), null);
  assert.equal(hookWord({ session_id: 'notice-hook', cwd: project, prompt: quoted }, [project], r, {}).text, quoted);
});

test("owner-words sync --owner-store syncs every registered product and rejects --records combination", () => {
  const shared = temp("ow-mp-shared-");
  const a = loopProduct({ loop: { projects: [shared] } }), b = loopProduct({ loop: { projects: [shared] } });
  const bWt = temp("ow-mp-b-wt-");
  git(b.product, "worktree", "add", "-q", "--detach", bWt);
  const aChildWt = join(a.dir, "work", "0001-actor", "wt");
  mkdirSync(join(a.dir, "work", "0001-actor"), { recursive: true });
  git(a.product, "worktree", "add", "-q", "--detach", aChildWt);
  const store = ownerStore([{ name: "alpha", records: a.records }, { name: "beta", records: b.records }]);
  const claudeHome = temp("ow-mp-claude-"), codexHome = temp("ow-mp-codex-");
  write(join(claudeHome, "projects", claudeSlug(a.product), "s1.jsonl"), [claudeRow("alpha sync word", { cwd: a.product })]);
  write(join(claudeHome, "projects", claudeSlug(bWt), "s2.jsonl"), [claudeRow("beta worktree word", { sessionId: "s2", cwd: bWt })]);
  write(join(claudeHome, "projects", claudeSlug(aChildWt), "s3.jsonl"), [claudeRow("child skip word", { sessionId: "s3", cwd: aChildWt })]);
  write(join(codexHome, "archived_sessions", "r1.jsonl"), codexRows({ id: "cx-b", cwd: bWt }, ["codex beta worktree word"]));
  const env = isolatedEnv({ CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, GEMINI_HOME: temp("g-"), ANTIGRAVITY_APP_DATA_DIR: "", T3CODE_HOME: "" });
  const res = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--owner-store", store], { encoding: "utf8", env });
  assert.equal(res.status, 0, res.stderr);
  const reports = JSON.parse(res.stdout);
  assert.deepEqual(reports.map(r => r.product), ["alpha", "beta"]);
  assert.deepEqual(reports.map(r => r.unresolved), [[], []]);
  assert.deepEqual(committedWords(a.records).map(w => w.text), ["alpha sync word"]);
  assert.deepEqual(committedWords(b.records).map(w => w.text).sort(), ["beta worktree word", "codex beta worktree word"]);

  write(join(claudeHome, "projects", claudeSlug(shared), "s-ambig.jsonl"), [claudeRow("shared ambig word", { sessionId: "s-ambig", cwd: shared })]);
  const ambigRes = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--owner-store", store], { encoding: "utf8", env });
  assert.equal(ambigRes.status, 1, ambigRes.stdout + ambigRes.stderr);
  const ambigReports = JSON.parse(ambigRes.stdout);
  assert.equal(ambigReports[0].unresolved.length, 1);
  assert.equal(ambigReports[1].unresolved.length, 1);
  assert.deepEqual(ambigReports[0].unresolved[0].products, ["alpha", "beta"]);
  assert.match(ambigRes.stderr, /ambiguous.*s-ambig.*alpha.*beta/);
  assert.deepEqual(committedWords(a.records).map(w => w.text), ["alpha sync word"]);
  assert.deepEqual(committedWords(b.records).map(w => w.text).sort(), ["beta worktree word", "codex beta worktree word"]);

  const conflict = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--owner-store", store, "--records", a.records], { encoding: "utf8", env });
  assert.equal(conflict.status, 64);
  const badCap = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--harness", "antigravity", "--owner-store", store, "--records", a.records], { input: JSON.stringify({ conversationId: "c1", cwd: a.product }), encoding: "utf8", env });
  assert.equal(badCap.status, 0);
  assert.match(JSON.parse(badCap.stdout).injectSteps[0].systemMessage.systemMessage, /NOT recorded/);
});

test("antigravityTranscript refuses step 1+ admission when step 0 is truncated, missing, or corrupt, while admitting step-0 SYSTEM_MESSAGE sessions", () => {
  const dir = temp("ow-ag-admit-");
  const u = (step_index, content, extra = {}) => ({ step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content, ...extra });

  const trunc = write(join(dir, "trunc", ".system_generated", "logs", "transcript.jsonl"), [
    u(0, "cut...", { truncated_fields: ["content"] }),
    u(1, "step-1 must not be admitted"),
  ]);
  const rTrunc = antigravityTranscript(trunc, null, "conv-trunc");
  assert.deepEqual(rTrunc.words, []);
  assert.equal(rTrunc.unresolved, true);

  const missing0 = write(join(dir, "miss0", ".system_generated", "logs", "transcript_full.jsonl"), [
    u(1, "step-1 without step-0"),
  ]);
  const rMiss0 = antigravityTranscript(missing0, null, "conv-miss0");
  assert.deepEqual(rMiss0.words, []);
  assert.equal(rMiss0.unresolved, true);

  const corruptFile = join(dir, "corrupt", ".system_generated", "logs", "transcript_full.jsonl");
  mkdirSync(join(corruptFile, ".."), { recursive: true });
  writeFileSync(corruptFile, `{"step_index":0,"type":"USER_INPUT"\n${JSON.stringify(u(1, "step-1 after corrupt line"))}\n`);
  const rCorrupt = antigravityTranscript(corruptFile, null, "conv-corrupt");
  assert.deepEqual(rCorrupt.words, []);
  assert.equal(rCorrupt.unresolved, true);

  const withSys0 = write(join(dir, "sys0", ".system_generated", "logs", "transcript_full.jsonl"), [
    { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", status: "DONE", content: "session start" },
    u(1, "Genuine owner word after step-0 system message"),
  ]);
  const rSys0 = antigravityTranscript(withSys0, null, "conv-sys0");
  assert.equal(rSys0.unresolved, false);
  assert.deepEqual(rSys0.words.map(w => w.text), ["Genuine owner word after step-0 system message"]);
});

test("SessionStart --hook antigravity deduplicates init --register by canonical records dir, flags dual-config conflict, and selects standalone local .self-loop", () => {
  const store = ownerStore([], { dir: temp("ss-dedup-store-") });
  const env = isolatedEnv({ GEMINI_HOME: temp("ss-dedup-g-"), T3CODE_HOME: "", T3CODE_THREAD_ID: "", SELF_LOOP_OWNER_STORE: store });
  const regLocal = repo({ "src/a.js": "export const a = 1;\n" }, temp("ss-reg-local-"));
  assert.equal(selfLoop(["init", "--local-exclude", "--register", "--name", "reg-local", "--owner-store", store], { cwd: regLocal, env }).status, 0);
  const localOnly = repo({ "src/b.js": "export const b = 2;\n" }, temp("ss-local-only-"));
  assert.equal(selfLoop(["init", "--local-exclude", "--name", "local-only"], { cwd: localOnly, env }).status, 0);
  const dual = loopProduct();
  assert.equal(selfLoop(["registry", "add", "--owner-store", store, "--name", "dual", "--records", dual.records], { env }).status, 0);
  assert.equal(selfLoop(["init", "--local-exclude"], { cwd: dual.product, env }).status, 0);

  const runHook = payload => spawnSync(process.execPath, [join(scripts, "self-loop.mjs"), "start", "--hook", "antigravity", "--owner-store", store], {
    input: JSON.stringify(payload), encoding: "utf8", env,
  });

  const regMsg = JSON.parse(runHook({ hookEventName: "SessionStart", conversationId: "s1", workspacePaths: [pathToFileURL(regLocal).href] }).stdout).injectSteps[0].systemMessage.systemMessage;
  assert.match(regMsg, /This session: reg-local · /);
  assert.match(regMsg, /Phase v1 · loop\/v1/);

  const localMsg = JSON.parse(runHook({ hookEventName: "SessionStart", conversationId: "s2", workspacePaths: [pathToFileURL(localOnly).href] }).stdout).injectSteps[0].systemMessage.systemMessage;
  assert.ok(localMsg.includes(join(localOnly, ".self-loop", "loop.json")), localMsg);
  assert.match(localMsg, /Phase v1 · loop\/v1/);

  const dualMsg = JSON.parse(runHook({ hookEventName: "SessionStart", conversationId: "s3", cwd: dual.product }).stdout).injectSteps[0].systemMessage.systemMessage;
  assert.match(dualMsg, /This session: workspace .* matches multiple products:.*dual.*in-repo/);
  assert.doesNotMatch(dualMsg, /Phase v1 · /);
});
