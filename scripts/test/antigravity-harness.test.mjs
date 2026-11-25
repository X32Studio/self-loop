// F-0009, D-0060
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { auditAccess } from "../audit-access.mjs";
import { productCode } from "../lead-guard.mjs";
import { antigravityAppDirs, decodeToolCallArgs, extractHookDirs, geminiHome, isAntigravityHook, PRE_TOOL_USE_PASSTHROUGH, unwrapAntigravityUserText } from "../lib/antigravity.mjs";
import { antigravityTranscript } from "../lib/antigravity-words.mjs";
import { ANTIGRAVITY_TEMPLATE, HooksError, renderAntigravityHooks } from "../lib/hooks.mjs";
import { claudeSessionWords, claudeSlug, codexSessionWords, committedWords, pendingOwnerPrompts, transcriptWordsReport } from "../lib/owner-words.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, repo, scripts, temp } from "./helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

function wrapEnvelope(body, { instructions = true, metadata = true, settings = false } = {}) {
  const inner = instructions
    ? `<t3_code_instructions>\n## Mode\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>`
    : body;
  return [
    `<USER_REQUEST>\n${inner}\n</USER_REQUEST>`,
    metadata ? "<ADDITIONAL_METADATA>\nlocal time: 2026-11-23\n</ADDITIONAL_METADATA>" : null,
    settings ? "<USER_SETTINGS_CHANGE>\nModel Selection changed\n</USER_SETTINGS_CHANGE>" : null,
  ].filter(Boolean).join("\n");
}

const writeJsonl = (file, rows) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n"); return file; };
const userStep = (step_index, content, extra = {}) => ({ step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content, ...extra });

function createSummaryDb(appDir, entries) {
  mkdirSync(appDir, { recursive: true });
  const dbPath = join(appDir, "conversation_summaries.db"), db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT DEFAULT '', nesting_depth INTEGER DEFAULT 0, killed INTEGER DEFAULT 0, not_fully_idle INTEGER DEFAULT 0)");
  const insert = db.prepare("INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const e of entries) insert.run(e.id, JSON.stringify((e.workspaces ?? []).map(w => pathToFileURL(w).href)), e.status ?? "CASCADE_RUN_STATUS_IDLE", e.parent ?? "", e.depth ?? 0, e.killed ?? 0, e.notFullyIdle ?? 0);
  db.close();
  return dbPath;
}

function writeAgConversation(appDir, id, rows, { full = true, compact = false } = {}) {
  const logs = join(appDir, "brain", id, ".system_generated", "logs");
  let file = null;
  if (full) file = writeJsonl(join(logs, "transcript_full.jsonl"), rows);
  if (compact) file = writeJsonl(join(logs, "transcript.jsonl"), rows);
  return file;
}

test("AG-GUARD-01: PreToolUse handles Antigravity tool spellings, stdin cwd, and never emits allow", () => {
  const product = repo({ "src/a.js": "x\n", "docs/GUIDE.md": "g\n" });
  writeFileSync(join(product, ".git", "info", "exclude"), "/.agents/hooks.json\n");
  const workspaces = temp("ag-wt-"), wt = join(workspaces, "0001-actor", "wt");
  mkdirSync(join(workspaces, "0001-actor"), { recursive: true });
  git(product, "worktree", "add", "-q", "--detach", wt);
  const runGuard = payload => spawnSync(
    process.execPath,
    [join(scripts, "lead-guard.mjs"), "--harness", "antigravity", "--product", product, "--workspaces", workspaces],
    { input: JSON.stringify(payload), cwd: temp("hook-dir-"), encoding: "utf8" }
  );

  for (const [name, args] of [
    ["write_file", { Path: "src/a.js" }], ["edit_file", { Path: "src/a.js" }],
    ["write_to_file", { TargetFile: "src/new.js" }], ["replace_file_content", { AbsolutePath: join(product, "src/a.js") }],
    ["write_file", { Path: join(wt, "src/a.js") }],
    ["run_command", { CommandLine: "git push origin loop/v1" }], ["shell_exec", { command: "git push origin main" }],
  ]) {
    const res = runGuard({ hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name, args } });
    assert.equal(res.status, 0, name);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "deny", name);
    assert.match(out.reason, /^lead-guard:/, name);
  }

  assert.equal(PRE_TOOL_USE_PASSTHROUGH, "", "cli-1.5.14 probed pass-through must be empty stdout");
  for (const payload of [
    { hookEventName: "PreToolUse", conversationId: "c1", workspacePaths: [product], toolCall: { name: "write_file", args: { Path: "docs/GUIDE.md" } } },
    { hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name: "edit_file", args: { Path: ".agents/hooks.json" } } },
    { hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name: "write_file", args: { Path: join(workspaces, "tasks/R-0001-actor.md") } } },
    { hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name: "run_command", args: { CommandLine: "node scripts/gated-push.mjs --repo ." } } },
    { hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name: "read_file", args: { Path: "src/a.js" } } },
    { hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name: "mcp_t3-code_t3_thread_read", args: { threadId: "t1" } } },
  ]) {
    const res = runGuard(payload);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, PRE_TOOL_USE_PASSTHROUGH);
    assert.doesNotMatch(res.stdout, /"decision"\s*:\s*"allow"/);
  }
});

test("AG-GUARD-02 (R4, R5, D-0060): malformed stdin and git timeout fail closed with deny; crash emits PRE_TOOL_USE_PASSTHROUGH", () => {
  const product = repo({ "src/a.js": "x\n" }), workspaces = temp("ag-wt-");
  const malformed = spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--harness", "antigravity", "--product", product, "--workspaces", workspaces], { input: "{bad json", encoding: "utf8" });
  assert.equal(malformed.status, 0);
  assert.equal(JSON.parse(malformed.stdout).decision, "deny");
  assert.match(JSON.parse(malformed.stdout).reason, /malformed hook JSON/);
  assert.match(malformed.stderr, /lead-guard:/);

  const crash = spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--harness", "antigravity"], { input: "{}", encoding: "utf8" });
  assert.equal(crash.status, 0);
  assert.equal(crash.stdout, PRE_TOOL_USE_PASSTHROUGH);
  assert.match(crash.stderr, /lead-guard:/);

  const slowBin = temp("slow-git-");
  writeFileSync(join(slowBin, "git"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
  const slowEnv = { ...process.env, PATH: `${slowBin}:${process.env.PATH}` };
  const origPath = process.env.PATH;
  process.env.PATH = slowEnv.PATH;
  try { assert.equal(productCode(product, "src/a.js", { timeoutMs: 80 }), "git timed out resolving src/a.js"); }
  finally { process.env.PATH = origPath; }
  const timedOut = spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--harness", "antigravity", "--product", product, "--workspaces", workspaces], {
    input: JSON.stringify({ hookEventName: "PreToolUse", conversationId: "c1", cwd: product, toolCall: { name: "edit_file", args: { Path: "src/a.js" } } }),
    encoding: "utf8", env: slowEnv,
  });
  assert.equal(timedOut.status, 0);
  assert.equal(JSON.parse(timedOut.stdout).decision, "deny");
  assert.match(JSON.parse(timedOut.stdout).reason, /git timed out resolving src\/a\.js/);
});

test("AG-HOOK-LIFE-01: 0-based PreInvocation fast path, SessionStart empty-cwd, child skip without T3CODE_THREAD_ID, Stop guards & counter key", () => {
  const project = temp("ag-proj-"), records = repo({ "README.md": "# records\n" }), appDir = temp("ag-app-");
  const convId = "conv-lead-1", ownerMsg = "请确保 Antigravity 适配器全链路稳定。";
  const transcript = writeAgConversation(appDir, convId, [userStep(0, wrapEnvelope(ownerMsg))]);
  const env = isolatedEnv({ T3CODE_THREAD_ID: "", TMPDIR: join(records, ".git") });
  const capture = payload => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--harness", "antigravity", "--records", records, "--project", project],
    { input: JSON.stringify(payload), encoding: "utf8", env });

  assert.deepEqual(JSON.parse(capture({ hookEventName: "PreInvocation", conversationId: convId, cwd: project, invocationNum: 0, initialNumSteps: 1, lastUserInput: ownerMsg, transcriptPath: transcript }).stdout), {});
  const commitsAfter0 = git(records, "rev-list", "--count", "HEAD");
  assert.equal(committedWords(records).length, 1);
  for (const [invocationNum, initialNumSteps] of [[1, 6], [2, 8]]) {
    assert.deepEqual(JSON.parse(capture({ hookEventName: "PreInvocation", conversationId: convId, cwd: project, invocationNum, initialNumSteps, lastUserInput: ownerMsg, transcriptPath: transcript }).stdout), {});
  }
  assert.equal(git(records, "rev-list", "--count", "HEAD"), commitsAfter0, "zero extra commits for invocationNum > 0");

  const pendingConv = "conv-pending-0based";
  const pendingFile = join(appDir, "brain", pendingConv, ".system_generated", "logs", "transcript_full.jsonl");
  const inv0 = capture({ hookEventName: "PreInvocation", conversationId: pendingConv, cwd: project, invocationNum: 0, initialNumSteps: 1, lastUserInput: "flush later", transcriptPath: pendingFile });
  assert.match(JSON.parse(inv0.stdout).injectSteps[0].systemMessage.systemMessage, /pending transcript confirmation/);
  assert.equal(pendingOwnerPrompts(records, pendingConv).length, 1);
  const inv1StillPending = capture({ hookEventName: "PreInvocation", conversationId: pendingConv, cwd: project, invocationNum: 1, initialNumSteps: 6, lastUserInput: "flush later", transcriptPath: pendingFile });
  assert.deepEqual(JSON.parse(inv1StillPending.stdout), {}, "post-tool inv 1 emits {} and does not spam injectSteps");
  assert.equal(pendingOwnerPrompts(records, pendingConv).length, 1, "post-tool inv 1 does not duplicate pending file");
  writeAgConversation(appDir, pendingConv, [userStep(0, wrapEnvelope("flush later"), { created_at: new Date().toISOString() })]);
  const inv2Reconcile = capture({ hookEventName: "PreInvocation", conversationId: pendingConv, cwd: project, invocationNum: 2, initialNumSteps: 8, lastUserInput: "flush later", transcriptPath: pendingFile });
  assert.deepEqual(JSON.parse(inv2Reconcile.stdout), {});
  assert.equal(pendingOwnerPrompts(records, pendingConv).length, 0, "post-tool invocation reconciles flushed transcript");

  const startNoCwd = spawnSync(process.execPath, [join(scripts, "self-loop.mjs"), "start", "--hook", "antigravity"],
    { input: JSON.stringify({ hookEventName: "SessionStart", conversationId: convId }), cwd: project, encoding: "utf8", env });
  assert.deepEqual(JSON.parse(startNoCwd.stdout), {});

  const childId = "conv-child-1";
  const childFile = writeAgConversation(appDir, childId, [userStep(0, wrapEnvelope('[T3 Code: the agent in T3 thread "t0" sent this message, not the user.]\n\nAct as the actor sub-agent for this task.\n\nself-loop call R-0001-actor'))]);
  assert.deepEqual(JSON.parse(spawnSync(process.execPath, [join(scripts, "self-loop.mjs"), "start", "--hook", "antigravity"],
    { input: JSON.stringify({ hookEventName: "SessionStart", conversationId: childId, cwd: project, transcriptPath: childFile }), encoding: "utf8", env }).stdout), {});
  assert.deepEqual(JSON.parse(capture({ hookEventName: "PreInvocation", conversationId: childId, cwd: project, invocationNum: 0, initialNumSteps: 1, lastUserInput: wrapEnvelope("follow-up"), transcriptPath: childFile }).stdout), {});
  assert.equal(committedWords(records).length, 2);

  const runStop = payload => spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), "--harness", "antigravity", "--records", records, "--project", project, "--max-blocks", "2"],
    { input: JSON.stringify(payload), encoding: "utf8", env });
  for (const extra of [{ fullyIdle: false }, { continuationActive: true }, { terminationReason: "USER_CANCELED" }, { terminationReason: "ERROR" }, { conversationId: childId, transcriptPath: childFile }]) {
    assert.deepEqual(JSON.parse(runStop({ hookEventName: "Stop", conversationId: convId, cwd: project, transcriptPath: transcript, terminationReason: "NO_TOOL_CALL", ...extra }).stdout), {}, JSON.stringify(extra));
  }
  const stopJson = JSON.parse(runStop({ hookEventName: "Stop", conversationId: convId, cwd: project, transcriptPath: transcript, terminationReason: "NO_TOOL_CALL", fullyIdle: true, continuationActive: false }).stdout);
  assert.equal(stopJson.decision, "continue");
  assert.match(stopJson.reason, /W-[0-9a-f]{10}/);
  const gateDir = join(records, ".git", "self-loop-word-gate");
  assert.ok(readdirSync(gateDir).includes(`${convId}.json`));
  assert.equal(existsSync(join(gateDir, "undefined.json")), false);
});

test("AG-WORD-01: tail-anchored unwrap preserves quoted tags verbatim and fails closed on broken envelopes", () => {
  for (const body of [
    "  Preserve leading & trailing spaces  ",
    "Quote <ADDITIONAL_METADATA>x</ADDITIONAL_METADATA> in body",
    "Quote <USER_SETTINGS_CHANGE>m</USER_SETTINGS_CHANGE> in body",
    "Quote <runtime_info>r</runtime_info> in body",
    "Quote <user_request>inner</user_request> and </user_request>",
    "Quote <t3_code_instructions>rules</t3_code_instructions> and </USER_REQUEST>",
  ]) {
    assert.equal(unwrapAntigravityUserText(wrapEnvelope(body, { instructions: true, metadata: true, settings: true })), body);
    assert.equal(unwrapAntigravityUserText(wrapEnvelope(body, { instructions: false, metadata: true, settings: false })), body);
  }
  assert.equal(unwrapAntigravityUserText("<USER_REQUEST>\nmissing close tag"), null);
  assert.equal(unwrapAntigravityUserText("<USER_REQUEST>\n<t3_code_instructions>unclosed\n</USER_REQUEST>"), null);
  assert.equal(unwrapAntigravityUserText("<USER_REQUEST>\n<t3_code_instructions>ok</t3_code_instructions>\nraw\n</USER_REQUEST>"), null);
});

test("AG-WORD-02: DELEGATED_NOTICE colon and period forms yield 0 words across Antigravity, Claude, and Codex", () => {
  const dir = temp("ag-notices-"), project = "/work/example-app";
  const notices = [
    "Delegated task node:delegated-task:abc (Review) in child thread thread:delegated-task:abc [completed]:\ndone",
    "Delegated task node:delegated-task:def (Actor) in child thread thread:delegated-task:def [completed]. Use task_status with taskId to read result.",
    "Delegated task thread:delegated-task:ghi [failed]. Use task_status to inspect.",
    "Delegated task node:delegated-task:jkl [cancelled]. Use task_status.",
    "Delegated task node:delegated-task:mno [interrupted]. Use task_status.",
  ];
  const agFile = writeAgConversation(dir, "conv-notices", [userStep(0, wrapEnvelope("Real owner request")), ...notices.map((n, i) => userStep(i + 1, wrapEnvelope(n)))]);
  assert.deepEqual(antigravityTranscript(agFile, [project], "conv-notices").words.map(w => w.text), ["Real owner request"]);

  const claudeFile = writeJsonl(join(dir, "claude.jsonl"), [
    { type: "user", cwd: project, sessionId: "c1", timestamp: "2026-11-23T01:00:00Z", message: { role: "user", content: "Real owner request" } },
    ...notices.map(n => ({ type: "user", cwd: project, sessionId: "c1", timestamp: "2026-11-23T01:01:00Z", message: { role: "user", content: n } })),
  ]);
  assert.deepEqual(claudeSessionWords(claudeFile, [project]).map(w => w.text), ["Real owner request"]);

  const codexFile = writeJsonl(join(dir, "codex.jsonl"), [
    { type: "session_meta", payload: { id: "x1", cwd: project } },
    { type: "response_item", timestamp: "2026-11-23T01:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Real owner request" }] } },
    ...notices.map(n => ({ type: "response_item", timestamp: "2026-11-23T01:01:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: n }] } })),
  ]);
  assert.deepEqual(codexSessionWords(codexFile, [project]).map(w => w.text), ["Real owner request"]);
});

test("AG-WORD-03: compact middle-truncated USER_INPUT queues pending and never commits truncated text; later full sync reconciles", () => {
  const project = temp("ag-trunc-proj-"), records = repo({ "README.md": "# records\n" }), appDir = temp("ag-trunc-app-");
  const convId = "conv-trunc", fullText = "Alpha section with constraints and Omega conclusion.", ts = "2026-11-23T02:00:00Z";
  createSummaryDb(appDir, [{ id: convId, workspaces: [project] }]);
  const compactFile = writeAgConversation(appDir, convId, [userStep(0, wrapEnvelope("Alpha...Omega."), { created_at: ts, truncated_fields: ["content"] })], { full: false, compact: true });
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: temp("g-"), T3CODE_HOME: "", CLAUDE_CONFIG_DIR: temp("c-"), CODEX_HOME: temp("x-"), T3CODE_THREAD_ID: "" });

  const cap = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--harness", "antigravity", "--records", records, "--project", project],
    { input: JSON.stringify({ hookEventName: "PreInvocation", conversationId: convId, cwd: project, invocationNum: 0, initialNumSteps: 1, lastUserInput: wrapEnvelope(fullText), transcriptPath: compactFile }), encoding: "utf8", env });
  assert.match(JSON.parse(cap.stdout).injectSteps[0].systemMessage.systemMessage, /pending transcript confirmation/);
  assert.deepEqual(committedWords(records), []);
  assert.equal(pendingOwnerPrompts(records, convId).length, 1);

  const syncCompact = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--records", records, "--project", project], { encoding: "utf8", env });
  assert.equal(syncCompact.status, 1);
  assert.equal(JSON.parse(syncCompact.stdout).antigravity.skipped, 1);
  assert.deepEqual(committedWords(records), []);

  writeAgConversation(appDir, convId, [userStep(0, wrapEnvelope(fullText), { created_at: ts })], { full: true });
  const syncFull = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--records", records, "--project", project], { encoding: "utf8", env });
  assert.equal(syncFull.status, 0, syncFull.stderr);
  assert.deepEqual(JSON.parse(syncFull.stdout).pending, []);
  assert.deepEqual(committedWords(records).map(w => [w.source, w.event, w.text]), [["antigravity", "step-0", fullText]]);
});

test("AG-WORD-04 (A10, R8): DB failures, missing row, sqlite unavailable, and broken step-0 isolate Claude/Codex and exit 1", () => {
  const project = temp("ag-iso-proj-"), claudeHome = temp("ag-iso-claude-"), codexHome = temp("ag-iso-codex-");
  writeJsonl(join(claudeHome, "projects", claudeSlug(project), "s1.jsonl"), [{ type: "user", cwd: project, sessionId: "s1", timestamp: "2026-11-23T01:00:00Z", promptId: "p1", message: { role: "user", content: "claude survives" } }]);
  writeJsonl(join(codexHome, "archived_sessions", "r1.jsonl"), [{ type: "session_meta", payload: { id: "x1", cwd: project } }, { type: "response_item", timestamp: "2026-11-23T01:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex survives" }] } }]);

  const runSync = appDir => {
    const records = repo({ "README.md": "# records\n" });
    const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: temp("g-"), T3CODE_HOME: "", CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome });
    const res = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--records", records, "--project", project], { encoding: "utf8", env });
    return { res, records, json: JSON.parse(res.stdout) };
  };

  const missingDb = temp("ag-missing-db-");
  writeAgConversation(missingDb, "c-missing", [userStep(0, wrapEnvelope("hi"))]);
  const rMissing = runSync(missingDb);
  assert.equal(rMissing.res.status, 1);
  assert.match(rMissing.json.antigravity.reason, /missing/);
  assert.deepEqual(committedWords(rMissing.records).map(w => w.text), ["claude survives", "codex survives"]);

  const missingRow = temp("ag-missing-row-");
  createSummaryDb(missingRow, [{ id: "other", workspaces: [project] }]);
  writeAgConversation(missingRow, "c-orphan", [userStep(0, wrapEnvelope("hi"))]);
  const rOrphan = runSync(missingRow);
  assert.equal(rOrphan.res.status, 1);
  assert.match(rOrphan.json.antigravity.reason, /missing conversation_summaries\.db row/);
  assert.deepEqual(committedWords(rOrphan.records).map(w => w.text), ["claude survives", "codex survives"]);

  const brokenDir = temp("ag-broken-step0-");
  createSummaryDb(brokenDir, [{ id: "c-broken", workspaces: [project] }]);
  writeAgConversation(brokenDir, "c-broken", [userStep(0, "<USER_REQUEST>\nunclosed"), userStep(2, wrapEnvelope("later"))]);
  const rBroken = runSync(brokenDir);
  assert.equal(rBroken.res.status, 1);
  assert.match(rBroken.json.antigravity.reason, /unparseable first prompt/);
  assert.deepEqual(committedWords(rBroken.records).map(w => w.text), ["claude survives", "codex survives"]);

  const lockedDir = temp("ag-locked-"), lockedDbPath = createSummaryDb(lockedDir, [{ id: "c-locked", workspaces: [project] }]);
  writeAgConversation(lockedDir, "c-locked", [userStep(0, wrapEnvelope("hi"))]);
  const locker = new DatabaseSync(lockedDbPath);
  locker.exec("BEGIN EXCLUSIVE");
  try {
    const rep = transcriptWordsReport([project], { claudeHome, codexHome, env: isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: lockedDir, GEMINI_HOME: temp("g-"), T3CODE_HOME: "" }) });
    assert.equal(rep.antigravity.skipped, 1);
    assert.match(rep.antigravity.reason, /locked|busy/i);
    assert.deepEqual(rep.words.map(w => w.text), ["claude survives", "codex survives"]);
  } finally { locker.exec("ROLLBACK"); locker.close(); }

  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const roDir = temp("ag-ro-"), roDbPath = createSummaryDb(roDir, [{ id: "c-ro", workspaces: [project] }]);
    const w = new DatabaseSync(roDbPath); w.exec("PRAGMA journal_mode=WAL"); w.close();
    writeAgConversation(roDir, "c-ro", [userStep(0, wrapEnvelope("hi"))]);
    chmodSync(roDir, 0o555);
    try {
      const rRo = runSync(roDir);
      assert.equal(rRo.res.status, 1);
      assert.equal(rRo.json.antigravity.skipped, 1);
      assert.deepEqual(committedWords(rRo.records).map(w => w.text), ["claude survives", "codex survives"]);
    } finally { chmodSync(roDir, 0o755); }
  }

  const sq = transcriptWordsReport([project], {
    claudeHome, codexHome,
    env: isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: missingRow, GEMINI_HOME: temp("g-"), T3CODE_HOME: "" }),
    sqliteLoader: () => { throw new Error("ERR_UNKNOWN_BUILTIN_MODULE"); },
  });
  assert.equal(sq.antigravity.skipped, 1);
  assert.match(sq.antigravity.reason, /node:sqlite unavailable/);
  assert.deepEqual(sq.words.map(w => w.text), ["claude survives", "codex survives"]);
});

test("AG-WORD-05 (N6, N1): repeated text across turns gets distinct step-N IDs; narrow T3 MCP send echo suppression", () => {
  const project = temp("ag-rep-proj-"), records = repo({ "README.md": "# records\n" }), appDir = temp("ag-rep-app-"), convId = "conv-repeat";
  createSummaryDb(appDir, [{ id: convId, workspaces: [project] }]);
  const rows = [
    userStep(0, wrapEnvelope("继续"), { created_at: "2026-11-23T03:00:00Z" }),
    { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T03:00:10Z", tool_calls: [{ name: "mcp_t3-code_t3_thread_send", args: { message: "echoed" } }] },
    userStep(6, wrapEnvelope("echoed"), { created_at: "2026-11-23T03:00:12Z" }),
    { step_index: 8, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T03:00:20Z", tool_calls: [{ name: "mcp_other_t3_thread_send", args: { message: "not-echo" } }] },
    userStep(10, wrapEnvelope("not-echo"), { created_at: "2026-11-23T03:00:22Z" }),
    userStep(12, wrapEnvelope("继续"), { created_at: "2026-11-23T03:01:00Z" }),
  ];
  const file = writeAgConversation(appDir, convId, [rows[0]]);
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: temp("g-"), T3CODE_HOME: "", CLAUDE_CONFIG_DIR: temp("c-"), CODEX_HOME: temp("x-"), T3CODE_THREAD_ID: "" });

  const cap = p => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "capture", "--harness", "antigravity", "--records", records, "--project", project],
    { input: JSON.stringify(p), encoding: "utf8", env });
  assert.deepEqual(JSON.parse(cap({ hookEventName: "PreInvocation", conversationId: convId, cwd: project, invocationNum: 0, initialNumSteps: 1, lastUserInput: "继续", transcriptPath: file }).stdout), {});
  assert.match(JSON.parse(cap({ hookEventName: "PreInvocation", conversationId: convId, cwd: project, invocationNum: 0, initialNumSteps: 13, lastUserInput: "继续", transcriptPath: file }).stdout).injectSteps[0].systemMessage.systemMessage, /pending transcript confirmation/);
  const nowMs = Math.floor(Date.now() / 1_000) * 1_000;
  const freshRow0 = userStep(0, wrapEnvelope("继续"), { created_at: new Date(nowMs - 1_000).toISOString() });
  writeAgConversation(appDir, convId, [freshRow0]);
  assert.deepEqual(JSON.parse(cap({ hookEventName: "PreInvocation", conversationId: convId, cwd: project, invocationNum: 1, initialNumSteps: 13, lastUserInput: "继续", transcriptPath: file }).stdout), {});
  assert.deepEqual(committedWords(records).map(w => w.event), ["step-0"]);
  assert.equal(pendingOwnerPrompts(records, convId).length, 1, "turn-2 pending stays while only turn-1 step-0 is on disk");

  const rowsNear = [freshRow0, rows[1], rows[2], rows[3], rows[4], userStep(12, wrapEnvelope("继续"), { created_at: new Date(nowMs).toISOString() })];
  writeAgConversation(appDir, convId, rowsNear);
  const sync = spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), "sync", "--records", records, "--project", project], { encoding: "utf8", env });
  assert.equal(sync.status, 0, sync.stderr);
  assert.equal(pendingOwnerPrompts(records, convId).length, 0, "turn-2 pending cleared unambiguously by step-12 anchor");
  const words = committedWords(records);
  assert.deepEqual(words.map(w => [w.event, w.text]), [["step-0", "继续"], ["step-10", "not-echo"], ["step-12", "继续"]]);
  assert.notEqual(words[0].id, words[2].id);
});

test("AG-AUDIT-01..05 (A5, A6, A7, R6): compact decode, T3 MCP allowlist, path screening, strict GENERIC pairing, CANCELED/RUNNING", () => {
  const ws = temp("ag-audit-ws-"), sealed = temp("ag-audit-sealed-"), sealedFile = join(sealed, "case.mjs");
  const audit = evs => auditAccess([ws], evs.map(event => ({ id: "r", event })), { tools: null, forbidden: [sealed], cwd: ws });

  const compactAudit = audit([
    { type: "PLANNER_RESPONSE", status: "DONE", truncated_fields: ["tool_calls"], tool_calls: [{ name: "read_file", args: { Path: JSON.stringify(sealedFile) } }] },
    { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" },
  ]);
  assert.equal(compactAudit.violations.length, 1);
  assert.equal(compactAudit.violations[0].path, sealedFile);
  assert.ok(compactAudit.flags.some(f => f.path === "(insufficient evidence)"));

  for (const name of [
    "invoke_subagent", "run_workflow", "define_subagent", "swarm", "send_message", "browser_subagent",
    "mcp_t3-code_delegate_task", "mcp_t3-code_t3_thread_launch", "mcp_t3-code_create_threads",
    "mcp_t3-code_t3_thread_send", "mcp_t3-code_schedule_task", "mcp_t3-code_run_scheduled_task_now",
    "mcp_t3-code_t3_queue", "mcp_t3-code_t3_worktree_handoff", "mcp_t3-code_t3_thread_transfer",
    "mcp_t3-code_t3_pending_request", "mcp_t3-code_future_tool", "mcp__t3-code__schedule_task", "mcp__t3_code__schedule_task",
  ]) {
    const a = audit([{ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name, args: {} }] }, { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" }]);
    assert.ok(a.violations.some(v => v.tool === name), `expected violation for ${name}`);
  }
  assert.deepEqual(audit([
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "mcp_t3-code_t3_thread_read", args: { threadId: "t1" } }, { name: "mcp_t3-code_html_preview", args: { path: join(ws, "ok.html") } }] },
    { type: "GENERIC", status: "DONE" }, { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" },
  ]).violations, []);

  for (const [name, args] of [
    ["mcp_t3-code_html_preview", { path: join(sealed, "x.html") }],
    ["mcp_t3-code_html_preview", { html: `<iframe src="${pathToFileURL(sealedFile).href}"></iframe>` }],
    ["mcp_t3-code_html_preview", { html: `<style>body{background:url(${pathToFileURL(sealedFile).href});}</style>` }],
    ["mcp_t3-code_preview_act", { paths: [join(sealed, "a")] }],
    ["mcp_t3-code_t3_project_create", { workspaceRoot: sealed }],
    ["mcp_t3-code_t3_thread_read", { url: pathToFileURL(sealedFile).href }],
    ["mcp_t3-code_t3_thread_read", { payload: { resources: [{ uri: pathToFileURL(sealedFile).href }] } }],
  ]) {
    const a = audit([{ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name, args }] }, { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" }]);
    assert.ok(a.violations.some(v => v.path.includes(sealed)), `expected sealed path violation for ${name}`);
  }
  const parenSealed = join(temp("ag-audit-paren-"), "sealed(cases)");
  const parenFile = join(parenSealed, "case.mjs");
  const parenAudit = evs => auditAccess([ws], evs.map(event => ({ id: "r", event })), { tools: null, forbidden: [parenSealed], cwd: ws });
  for (const html of [
    `<iframe src="${pathToFileURL(parenFile).href}"></iframe>`,
    `<style>div{background:url(${pathToFileURL(parenFile).href});}</style>`,
  ]) {
    const a = parenAudit([{ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "mcp_t3-code_html_preview", args: { html } }] }, { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" }]);
    assert.ok(a.violations.some(v => v.path === parenFile), `expected exact paren sealed path for ${html}`);
  }
  assert.deepEqual(audit([
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "mcp_t3-code_html_preview", args: { html: '<div class="ok"><a href="https://example.com">safe</a></div>' } }] },
    { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" },
  ]).violations, [], "benign HTML without file:// passes cleanly");

  for (const args of [
    { path: `"/sealed/long\n<truncated 123 bytes>` },
    { html: `"<iframe src=\\"file:///sealed/case.mjs\n<truncated 123 bytes>` },
  ]) {
    const a = audit([
      { type: "PLANNER_RESPONSE", status: "DONE", truncated_fields: ["tool_calls"], tool_calls: [{ name: "mcp_t3-code_html_preview", args }] },
      { type: "GENERIC", status: "DONE" }, { type: "PLANNER_RESPONSE", status: "DONE" },
    ]);
    assert.equal(a.violations.length, 1);
    assert.equal(a.violations[0].tool, "mcp_t3-code_html_preview");
    assert.ok(a.flags.some(f => f.path === "(insufficient evidence)"));
  }

  const shifted = audit([
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "ask_question", args: {} }, { name: "read_file", args: { Path: sealedFile } }, { name: "read_file", args: { Path: join(ws, "ok.txt") } }] },
    { type: "GENERIC", status: "DONE" }, { type: "GENERIC", status: "ERROR" }, { type: "PLANNER_RESPONSE", status: "DONE" },
  ]);
  assert.deepEqual([shifted.violations.length, shifted.denied.length], [1, 0]);
  assert.ok(shifted.flags.some(f => f.path === "(insufficient evidence)"));

  const properlyDenied = audit([{ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", args: { Path: sealedFile } }] }, { type: "GENERIC", status: "ERROR" }, { type: "PLANNER_RESPONSE", status: "DONE" }]);
  assert.deepEqual([properlyDenied.violations.length, properlyDenied.denied.length], [0, 1]);

  const tailDenied = audit([{ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", args: { Path: sealedFile } }] }, { type: "GENERIC", status: "ERROR" }]);
  assert.deepEqual([tailDenied.violations.length, tailDenied.denied.length], [1, 0]);
  assert.ok(tailDenied.flags.some(f => f.path === "(insufficient evidence)"));

  for (const status of ["CANCELED", "RUNNING"]) {
    const a = audit([{ type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", args: { Path: sealedFile } }] }, { type: "GENERIC", status }, { type: "PLANNER_RESPONSE", status: "DONE" }]);
    assert.deepEqual([a.violations.length, a.denied.length], [1, 0], status);
  }
});

test("R7 & B5: single geminiHome resolver and single-source assets/antigravity/hooks.json template rendering", () => {
  const fakeHome = temp("r7-home-"), env = { HOME: fakeHome, GEMINI_HOME: "", T3CODE_HOME: "", ANTIGRAVITY_APP_DATA_DIR: "" };
  const expected = join(fakeHome, ".gemini");
  assert.equal(geminiHome(env), expected);
  const appDir = join(expected, "antigravity-acp");
  mkdirSync(join(appDir, "brain"), { recursive: true });
  assert.deepEqual(antigravityAppDirs({ env }), [appDir]);

  const customTpl = join(temp("b5-tpl-"), "hooks.json");
  const tpl = JSON.parse(readFileSync(ANTIGRAVITY_TEMPLATE, "utf8"));
  tpl["self-loop"].SessionStart[0].timeout = 22;
  tpl["self-loop"].SessionStart[0].command += " --hours 6";
  writeFileSync(customTpl, JSON.stringify(tpl, null, 2));
  const dirWithSpaces = join(temp("b5 space's-"), "prod");
  const rendered = renderAntigravityHooks({
    cfg: { product: dirWithSpaces, records: join(dirWithSpaces, "rec"), workDir: join(dirWithSpaces, "work") },
    scriptsDir: join(dirWithSpaces, "scripts"),
    templatePath: customTpl,
  });
  assert.equal(rendered["self-loop"].SessionStart[0].timeout, 22);
  assert.match(rendered["self-loop"].SessionStart[0].command, /--hours 6$/);
  assert.match(rendered["self-loop"].PreToolUse[0].hooks[0].command, /b5 space'\\''s-|b5 space'"'"'s-/);
});

test("decodeToolCallArgs and extractHookDirs decode cli-1.5.14 argumentsJson and fail closed on corruption/smuggling", () => {
  assert.deepEqual(decodeToolCallArgs(undefined), { ok: true, present: false, args: {}, error: null });
  assert.deepEqual(decodeToolCallArgs({ name: "preview_status" }), { ok: true, present: false, args: {}, error: null });
  assert.deepEqual(decodeToolCallArgs({ name: "write_file", argumentsJson: '{"Path":"src/a.js"}' }), { ok: true, present: true, args: { Path: "src/a.js" }, error: null });
  assert.deepEqual(decodeToolCallArgs({ name: "write_file", args: {}, argumentsJson: '{"Path":"src/a.js"}' }), { ok: true, present: true, args: { Path: "src/a.js" }, error: null });
  assert.deepEqual(decodeToolCallArgs({ name: "write_file", args: { Path: "a" }, arguments: '{"Path":"a"}' }), { ok: true, present: true, args: { Path: "a" }, error: null });
  assert.equal(decodeToolCallArgs({ name: "write_file", args: { Path: "a" }, argumentsJson: '{"Path":"b"}' }).ok, false);
  for (const bad of [null, "bad", []]) assert.equal(decodeToolCallArgs(bad).ok, false);
  for (const bad of ["", "{bad", "null", "[]", "123", '"s"', null, []]) {
    assert.equal(decodeToolCallArgs({ name: "read_file", argumentsJson: bad }).ok, false, JSON.stringify(bad));
  }
  assert.equal(isAntigravityHook({ toolCall: null }), true);
  assert.equal(isAntigravityHook({ toolCall: "bad" }), true);
  const p = temp("ag-uri-");
  assert.deepEqual(extractHookDirs({ cwd: p, workspacePaths: [pathToFileURL(p).href, "/tmp/other"] }), [p, "/tmp/other"]);
});

test("renderAntigravityHooks and SessionStart support --owner-store multi-product mode and fail closed on broken store", () => {
  const a = loopProduct(), b = loopProduct(), bWt = temp("ag-ss-b-wt-");
  git(b.product, "worktree", "add", "-q", "--detach", bWt);
  const store = ownerStore([{ name: "alpha", records: a.records }, { name: "beta", records: b.records }]);
  const rendered = renderAntigravityHooks({ ownerStore: store, scriptsDir: scripts });
  for (const cmd of [rendered["self-loop"].SessionStart[0].command, rendered["self-loop"].PreInvocation[0].command, rendered["self-loop"].PreToolUse[0].hooks[0].command, rendered["self-loop"].Stop[0].command]) {
    assert.match(cmd, /--owner-store/);
  }
  const hybrid = renderAntigravityHooks({ cfg: { product: a.product, records: a.records, workDir: join(a.dir, "work") }, ownerStore: store, scriptsDir: scripts });
  assert.match(hybrid["self-loop"].SessionStart[0].command, /--owner-store/);
  assert.match(hybrid["self-loop"].PreToolUse[0].hooks[0].command, /--product/);
  assert.throws(() => renderAntigravityHooks({ ownerStore: temp("broken-store-"), scriptsDir: scripts }), HooksError);

  const env = isolatedEnv({ GEMINI_HOME: temp("ag-ss-g-"), T3CODE_HOME: "", T3CODE_THREAD_ID: "" });
  const runHook = (extraArgs, payload) => spawnSync(process.execPath, [join(scripts, "self-loop.mjs"), "start", "--hook", "antigravity", ...extraArgs], { input: JSON.stringify(payload), encoding: "utf8", env });
  const badEmpty = runHook(["--owner-store", ""], { hookEventName: "SessionStart", conversationId: "s-empty", cwd: a.product });
  assert.equal(badEmpty.status, 0);
  assert.match(JSON.parse(badEmpty.stdout).injectSteps[0].systemMessage.systemMessage, /--owner-store requires/);
  const explicitCfg = runHook(["--config", join(a.records, "loop.json")], { hookEventName: "SessionStart", conversationId: "s-cfg", cwd: temp("ag-ss-unreg-") });
  assert.equal(explicitCfg.status, 0);
  assert.match(JSON.parse(explicitCfg.stdout).injectSteps[0].systemMessage.systemMessage, /Phase v1 · loop\/v1/);
  const wtHook = runHook(["--owner-store", store], { hookEventName: "SessionStart", conversationId: "s-wt", workspacePaths: [pathToFileURL(bWt).href] });
  assert.equal(wtHook.status, 0);
  assert.match(JSON.parse(wtHook.stdout).injectSteps[0].systemMessage.systemMessage, /This session: beta · /);
});
