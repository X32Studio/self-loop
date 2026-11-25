// F-0008, F-0009, D-0052, D-0060, R-0032-reviewer-architecture
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { auditAccess } from "../scripts/audit-access.mjs";
import { antigravityTranscript } from "../scripts/lib/antigravity-words.mjs";
import { committedWords } from "../scripts/lib/owner-words.mjs";
import { jsonl, options, put, skill, world } from "./fixture.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const GUARD = join(skill, "scripts/lead-guard.mjs");
const AUDIT = join(skill, "scripts/audit-access.mjs");
const OWNER_WORDS = join(skill, "scripts/owner-words.mjs");

const DELEGATION_CASES = [
  { tool: "invoke_subagent", makeArgs: p => ({ TypeName: "self", Role: "Actor", Prompt: p }) },
  { tool: "run_workflow", makeArgs: p => ({ Description: "run", Script: p }) },
  { tool: "swarm", makeArgs: p => ({ action: "add", name: "actor-a", brief: p }) },
  { tool: "delegate_task", makeArgs: p => ({ task: p }) },
  { tool: "t3_thread_launch", makeArgs: p => ({ title: "actor-a", message: p }) },
  { tool: "create_threads", makeArgs: p => ({ threads: [{ title: "actor-a", prompt: p }] }) },
  { tool: "mcp_t3-code_delegate_task", makeArgs: p => ({ task: p }) },
  { tool: "mcp__t3-code__delegate_task", makeArgs: p => ({ task: p }) },
  { tool: "mcp_t3-code_t3_thread_launch", makeArgs: p => ({ title: "actor-a", message: p }) },
  { tool: "mcp__t3-code__t3_thread_launch", makeArgs: p => ({ title: "actor-a", message: p }) },
  { tool: "mcp_t3-code_create_threads", makeArgs: p => ({ threads: [{ title: "actor-a", prompt: p }] }) },
  { tool: "mcp__t3-code__create_threads", makeArgs: p => ({ threads: [{ title: "actor-a", prompt: p }] }) },
  { tool: "Agent", makeArgs: p => ({ description: "actor", prompt: p }) },
  { tool: "spawn_agent", makeArgs: p => ({ message: p }) },
];

function setup(t) {
  const w = world(t);
  const product = w.repo(join(w.dir, "product"), {
    "src/app.mjs": "export const app = 1;\n",
    "src/secret.js": "export const secret = 1;\n",
    "docs/GUIDE.md": "# Guide\n",
    "docs/OK.md": "# OK\n",
    "AGENTS.md": "# Agents\n",
    ".gitignore": "ignored.log\n",
  });
  const head = w.git(product, "rev-parse", "HEAD");
  const workspaces = join(w.dir, "work");
  mkdirSync(workspaces, { recursive: true });
  const env = {
    PATH: process.env.PATH,
    HOME: w.home,
    XDG_CONFIG_HOME: join(w.home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
    LC_ALL: "C",
  };

  const makePrepared = (name, { role = "actor", step = `${role}-a`, nonce, withWorktree = role !== "reviewer", recorded = false, cancelled = false } = {}) => {
    const ws = join(workspaces, name);
    mkdirSync(join(ws, "out"), { recursive: true });
    const wt = role === "reviewer" ? null : join(ws, "wt");
    if (wt && withWorktree) w.git(product, "worktree", "add", "-q", "--detach", wt, head);
    const id = `R-0032-${step}`;
    const prompt = `self-loop call ${id} · nonce ${nonce}\n\nWork in ${wt ?? ws}.\n`;
    writeFileSync(join(ws, "call.json"), `${JSON.stringify({
      version: 2,
      role,
      round: 32,
      step,
      phase: "v1",
      id,
      ws,
      wt,
      nonce,
      ...(recorded ? { recorded: true } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    }, null, 1)}\n`);
    return { ws, wt, id, nonce, prompt };
  };

  const invokeGuard = (payload, extraFlags = ["--harness", "antigravity"]) => spawnSync(
    process.execPath,
    [GUARD, ...extraFlags, "--product", product, "--workspaces", workspaces],
    { ...options, env, cwd: w.outside, input: typeof payload === "string" ? payload : JSON.stringify(payload) }
  );

  const agCall = (toolCall, { cwd = product, includeCwd = true, harnessFlag = true, id = "conv-lead" } = {}) => invokeGuard({
    hookEventName: "PreToolUse",
    ...(id ? { conversationId: id } : {}),
    ...(includeCwd ? { cwd } : {}),
    toolCall,
  }, harnessFlag ? ["--harness", "antigravity"] : []);

  const claudeCall = (tool, toolInput, cwd = product) => invokeGuard(
    { hookEventName: "PreToolUse", cwd, tool_name: tool, tool_input: toolInput },
    []
  );

  return { w, product, workspaces, env, makePrepared, invokeGuard, agCall, claudeCall };
}

function assertAgDeny(res, label, reasonPattern = /^lead-guard:/) {
  assert.equal(res.status, 0, `${label}: expected exit 0, got ${res.status} (${res.stderr})`);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail(`${label}: expected JSON deny on stdout, got ${JSON.stringify(res.stdout)} (${e.message})`);
  }
  assert.equal(parsed?.decision, "deny", label);
  assert.match(String(parsed?.reason ?? ""), reasonPattern, label);
}

function assertClaudeDeny(res, label, reasonPattern = /^lead-guard:/) {
  assert.equal(res.status, 0, `${label}: expected exit 0, got ${res.status} (${res.stderr})`);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail(`${label}: expected JSON deny on stdout, got ${JSON.stringify(res.stdout)} (${e.message})`);
  }
  assert.equal(parsed?.hookSpecificOutput?.hookEventName, "PreToolUse", label);
  assert.equal(parsed?.hookSpecificOutput?.permissionDecision, "deny", label);
  assert.match(String(parsed?.hookSpecificOutput?.permissionDecisionReason ?? ""), reasonPattern, label);
}

function assertAllow(res, label) {
  assert.equal(res.status, 0, `${label}: expected exit 0, got ${res.status} (${res.stderr})`);
  assert.equal(res.stdout, "", `${label}: expected empty pass-through stdout, got ${JSON.stringify(res.stdout)}`);
}

test("AG-ARG-01 [toolcall-args, fresh] (loss: false-verdict / stuck): cli-1.5.14 argumentsJson across all 14 delegation tools admits live nonces and denies missing/fabricated/recorded/cancelled", t => {
  const s = setup(t);
  const liveActor = s.makePrepared("0032-actor-live", { role: "actor", step: "actor-a", nonce: "a1b2c3d4e5f60718" });
  const liveReviewer = s.makePrepared("0032-reviewer-live", { role: "reviewer", step: "reviewer-a", nonce: "0123456789abcdef" });
  const rec = s.makePrepared("0032-actor-rec", { nonce: "1111222233334444", recorded: true });
  const canc = s.makePrepared("0032-actor-canc", { nonce: "5555666677778888", cancelled: true });

  assert.equal(DELEGATION_CASES.length, 14);
  for (const { tool, makeArgs } of DELEGATION_CASES) {
    assertAllow(
      s.agCall({ id: "call_1", name: tool, argumentsJson: JSON.stringify(makeArgs(liveActor.prompt)) }),
      `live actor ${tool}`
    );
    assertAllow(
      s.agCall({ id: "call_1", name: tool, argumentsJson: JSON.stringify(makeArgs(liveReviewer.prompt)) }),
      `live reviewer ${tool}`
    );
    for (const [kind, prompt] of [
      ["missing", "Run directly without call.json nonce"],
      ["fabricated", "self-loop call R-0032-actor-a · nonce deadbeefcafebabe"],
      ["recorded", rec.prompt],
      ["cancelled", canc.prompt],
    ]) {
      assertAgDeny(
        s.agCall({ id: "call_1", name: tool, argumentsJson: JSON.stringify(makeArgs(prompt)) }),
        `${kind} ${tool}`
      );
    }
  }

  assertAllow(
    s.agCall({ id: "call_1", name: "mcp_t3-code_delegate_task", argumentsJson: JSON.stringify({ task: liveActor.prompt }) }, { harnessFlag: false }),
    "auto-detect live argumentsJson"
  );
  assertAgDeny(
    s.agCall({ id: "call_1", name: "create_threads", argumentsJson: JSON.stringify({ threads: [{ title: "ok", prompt: liveActor.prompt }, { title: "bad", prompt: "no nonce" }] }) }),
    "mixed create_threads argumentsJson"
  );
});

test("AG-ARG-02 [toolcall-args, fresh] (loss: wrong-result / false-verdict): argumentsJson, string args, and object/string arguments enforce write and shell guards", t => {
  const s = setup(t);
  const actor = s.makePrepared("0032-actor-write", { nonce: "9988776655443322" });
  const encodings = [
    ["argumentsJson", (name, payload) => ({ id: "call_2", name, argumentsJson: JSON.stringify(payload) })],
    ["args-json-string", (name, payload) => ({ id: "call_2", name, args: JSON.stringify(payload) })],
    ["arguments-object", (name, payload) => ({ id: "call_2", name, arguments: payload })],
    ["arguments-json-string", (name, payload) => ({ id: "call_2", name, arguments: JSON.stringify(payload) })],
  ];

  const writeTools = [
    ["write_file", p => ({ Path: p, Content: "x\n" })],
    ["edit_file", p => ({ Path: p, Target: "1", Replacement: "2" })],
    ["write_to_file", p => ({ TargetFile: p, CodeContent: "x\n" })],
    ["replace_file_content", p => ({ AbsolutePath: p, TargetContent: "1", ReplacementContent: "2" })],
  ];

  for (const [enc, buildToolCall] of encodings) {
    for (const [tool, makePayload] of writeTools) {
      for (const [kind, target] of [
        ["product-rel", "src/app.mjs"],
        ["product-abs", join(s.product, "src/app.mjs")],
        ["call-json", join(actor.ws, "call.json")],
        ["actor-wt", join(actor.wt, "src/app.mjs")],
      ]) {
        assertAgDeny(s.agCall(buildToolCall(tool, makePayload(target))), `${enc} ${tool} ${kind}`);
      }
      assertAgDeny(
        s.agCall(buildToolCall(tool, makePayload("src/app.mjs")), { includeCwd: false }),
        `${enc} ${tool} relative-without-cwd`,
        /requires hook cwd/
      );
      for (const [kind, target] of [
        ["tasks", join(s.workspaces, "tasks", "T.md")],
        ["docs", "docs/GUIDE.md"],
        ["gitignored", "ignored.log"],
      ]) {
        assertAllow(s.agCall(buildToolCall(tool, makePayload(target))), `${enc} ${tool} allow ${kind}`);
      }
    }

    for (const [tool, makePayload] of [
      ["run_command", cmd => ({ CommandLine: cmd })],
      ["shell_exec", cmd => ({ command: cmd })],
    ]) {
      assertAgDeny(
        s.agCall(buildToolCall(tool, makePayload("git push --no-verify origin loop/acceptance"))),
        `${enc} ${tool} git-push`
      );
      assertAllow(
        s.agCall(buildToolCall(tool, makePayload("node scripts/gated-push.mjs --repo . --branch loop/acceptance --suite-receipt r.json"))),
        `${enc} ${tool} gated-push`
      );
    }
  }
});

test("AG-ARG-03 [toolcall-args, fresh] (loss: wrong-result / stuck): dual-field empty args non-shadowing, conflicting smuggling denial, and zero-arg read-only allow", t => {
  const s = setup(t);
  const live = s.makePrepared("0032-actor-dual", { nonce: "abcdef1234567890" });

  assertAgDeny(
    s.agCall({ id: "call_a1", name: "write_file", args: {}, argumentsJson: JSON.stringify({ Path: "src/app.mjs" }) }),
    "empty args must not shadow argumentsJson product write",
    /product code/
  );
  assertAgDeny(
    s.agCall({ id: "call_a2", name: "run_command", args: {}, argumentsJson: JSON.stringify({ CommandLine: "git push --no-verify origin main" }) }),
    "empty args must not shadow argumentsJson git push"
  );
  assertAllow(
    s.agCall({ id: "call_a3", name: "mcp_t3-code_delegate_task", args: {}, argumentsJson: JSON.stringify({ task: live.prompt }) }),
    "empty args must not shadow argumentsJson live nonce"
  );
  assertAllow(
    s.agCall({ id: "call_a4", name: "write_file", args: {}, argumentsJson: JSON.stringify({ Path: "docs/GUIDE.md" }) }),
    "empty args with docs write allowed"
  );

  assertAgDeny(
    s.agCall({ id: "call_b1", name: "write_file", args: { Path: "docs/OK.md" }, argumentsJson: JSON.stringify({ Path: "src/secret.js" }) }),
    "conflicting args and argumentsJson",
    /conflicting/i
  );
  assertAgDeny(
    s.agCall({ id: "call_b2", name: "write_file", args: { Path: "docs/OK.md" }, arguments: { Path: "src/secret.js" } }),
    "conflicting args and arguments",
    /conflicting/i
  );
  assertAgDeny(
    s.agCall({ id: "call_b3", name: "run_command", arguments: { CommandLine: "git status" }, argumentsJson: JSON.stringify({ CommandLine: "git push origin main" }) }),
    "conflicting arguments and argumentsJson",
    /conflicting/i
  );
  assertAllow(
    s.agCall({ id: "call_b4", name: "write_file", args: { Path: "docs/OK.md" }, argumentsJson: JSON.stringify({ Path: "docs/OK.md" }) }),
    "identical dual fields allowed"
  );

  assertAllow(s.agCall({ id: "1", name: "mcp_t3-code_preview_status" }), "zero-arg read-only without argumentsJson");
  assertAllow(s.agCall({ id: "2", name: "mcp_t3-code_preview_status", argumentsJson: "{}" }), "zero-arg read-only with empty argumentsJson");
  assertAgDeny(s.agCall({ id: "3", name: "invoke_subagent" }), "zero-arg delegation denied");
});

test("AG-ARG-04 [toolcall-args, fresh] (loss: wrong-result / false-verdict): malformed toolCall arguments and Claude tool_input fail closed with deny", t => {
  const s = setup(t);
  const badJsonStrings = ["{truncated", "", "null", "[]", "123", '"str"'];
  for (const tool of ["read_file", "write_file"]) {
    for (const key of ["argumentsJson", "args", "arguments"]) {
      for (const bad of badJsonStrings) {
        assertAgDeny(s.agCall({ id: "call_bad", name: tool, [key]: bad }), `${tool} ${key}=${JSON.stringify(bad)}`);
      }
      for (const nonObj of [null, [], 123]) {
        assertAgDeny(s.agCall({ id: "call_bad", name: tool, [key]: nonObj }), `${tool} ${key}=${JSON.stringify(nonObj)}`);
      }
    }
  }

  for (const badToolCall of [null, "bad", []]) {
    assertAgDeny(s.agCall(badToolCall), `harness flag toolCall=${JSON.stringify(badToolCall)}`);
  }
  assertAgDeny(s.agCall(null, { id: null, includeCwd: false, harnessFlag: false }), "auto-detect toolCall=null");
  assertAgDeny(s.agCall("bad", { id: null, includeCwd: false, harnessFlag: false }), "auto-detect toolCall=bad");

  for (const tool of ["Read", "Write"]) {
    for (const badInput of ["{bad", "[]", [], null]) {
      assertClaudeDeny(s.claudeCall(tool, badInput), `claude ${tool} tool_input=${JSON.stringify(badInput)}`);
    }
  }
});

test("AG-ARG-05 [audit-access & owner-words, fresh] (loss: disclosure / wrong-result): audit-access and antigravity-words screen argumentsJson consistently", t => {
  const w = world(t);
  const ws = join(w.dir, "ws");
  const sealed = join(w.dir, "sealed");
  const outsideSecret = join(w.dir, "outside-secret.mjs");
  const sealedFile = join(sealed, "case.mjs");
  put(ws, "brief.md", "brief\n");
  put(sealed, "case.mjs", "export default 1;\n");
  writeFileSync(outsideSecret, "export default 2;\n");

  const cliAudit = (name, rows) => {
    const work = join(w.dir, `audit-${name}`);
    rmSync(work, { recursive: true, force: true });
    put(work, "visible/brief.md", "brief\n");
    put(work, "logs/run.jsonl", jsonl(...rows));
    const res = spawnSync(process.execPath, [AUDIT, work], { ...options, env: { PATH: process.env.PATH, HOME: w.home } });
    return { res, json: JSON.parse(res.stdout) };
  };

  const cliReadSealed = cliAudit("read-sealed", [
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", argumentsJson: JSON.stringify({ Path: outsideSecret }) }] },
    { type: "GENERIC", status: "DONE" },
    { type: "PLANNER_RESPONSE", status: "DONE" },
  ]);
  assert.equal(cliReadSealed.res.status, 3);
  assert.ok(cliReadSealed.json.violations.some(v => v.tool === "read_file" && v.path === outsideSecret));

  const cliDelegation = cliAudit("delegation", [
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "invoke_subagent", argumentsJson: JSON.stringify({ Prompt: "read secret" }) }] },
    { type: "GENERIC", status: "DONE" },
    { type: "PLANNER_RESPONSE", status: "DONE" },
  ]);
  assert.equal(cliDelegation.res.status, 3);
  assert.ok(cliDelegation.json.violations.some(v => v.tool === "invoke_subagent"));

  const cliMalformed = cliAudit("malformed", [
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", argumentsJson: "{bad" }] },
    { type: "GENERIC", status: "DONE" },
    { type: "PLANNER_RESPONSE", status: "DONE" },
  ]);
  assert.equal(cliMalformed.res.status, 3);
  assert.ok(cliMalformed.json.violations.some(v => v.tool === "read_file" && v.path === "(truncated/unparseable tool argument)"));
  assert.ok(cliMalformed.json.flags.some(f => f.path === "(insufficient evidence)"));

  const cliClean = cliAudit("clean", [
    { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", argumentsJson: JSON.stringify({ Path: "brief.md" }) }] },
    { type: "GENERIC", status: "DONE" },
    { type: "PLANNER_RESPONSE", status: "DONE" },
  ]);
  assert.equal(cliClean.res.status, 0, cliClean.res.stderr);
  assert.deepEqual(cliClean.json.violations, []);
  assert.deepEqual(cliClean.json.flags, []);

  const sealedAudit = auditAccess([ws], [
    { id: "r", event: { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", argumentsJson: JSON.stringify({ Path: sealedFile }) }] } },
    { id: "r", event: { type: "GENERIC", status: "DONE" } },
    { id: "r", event: { type: "PLANNER_RESPONSE", status: "DONE" } },
  ], { tools: null, forbidden: [sealed], cwd: ws });
  assert.equal(sealedAudit.violations.length, 1);
  assert.equal(sealedAudit.violations[0].path, sealedFile);

  const malformedAudit = auditAccess([ws], [
    { id: "r", event: { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "read_file", argumentsJson: "{bad" }] } },
    { id: "r", event: { type: "GENERIC", status: "DONE" } },
    { id: "r", event: { type: "PLANNER_RESPONSE", status: "DONE" } },
  ], { tools: null, forbidden: [sealed], cwd: ws });
  assert.ok(malformedAudit.violations.some(v => v.path === "(truncated/unparseable tool argument)"));
  assert.ok(malformedAudit.unparsedCalls > 0);

  const appDir = join(w.dir, "ag-app");
  const project = join(w.dir, "proj");
  const records = w.repo(join(w.dir, "records"), { "README.md": "# records\n" });
  const convId = "conv-send";
  mkdirSync(project, { recursive: true });
  mkdirSync(appDir, { recursive: true });
  const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, status TEXT,
    parent_conversation_id TEXT DEFAULT '', nesting_depth INTEGER DEFAULT 0,
    killed INTEGER DEFAULT 0, not_fully_idle INTEGER DEFAULT 0
  )`);
  db.prepare(`INSERT INTO conversation_summaries (conversation_id, workspace_uris, status) VALUES (?, ?, ?)`)
    .run(convId, JSON.stringify([pathToFileURL(project).href]), "CASCADE_RUN_STATUS_IDLE");
  db.close();

  const wrap = body => `<USER_REQUEST>\n${body}\n</USER_REQUEST>`;
  const rows = [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T03:00:00Z", content: wrap("initial prompt") },
    { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T03:00:05Z", tool_calls: [{ name: "mcp_t3-code_t3_thread_send", argumentsJson: JSON.stringify({ message: "echoed via argumentsJson" }) }] },
    { step_index: 4, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T03:00:07Z", content: wrap("echoed via argumentsJson") },
    { step_index: 6, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T03:00:09Z", content: wrap("echoed via argumentsJson") },
    { step_index: 8, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T03:00:11Z", tool_calls: [{ name: "mcp_t3-code_t3_thread_send", argumentsJson: "{bad" }] },
    { step_index: 10, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T03:00:12Z", content: wrap("after malformed send") },
  ];
  const transcriptFile = put(appDir, `brain/${convId}/.system_generated/logs/transcript_full.jsonl`, jsonl(...rows));

  const parsed = antigravityTranscript(transcriptFile, [project], convId);
  assert.deepEqual(parsed.words.map(item => [item.event, item.text]), [
    ["step-0", "initial prompt"],
    ["step-6", "echoed via argumentsJson"],
    ["step-10", "after malformed send"],
  ]);
  assert.deepEqual(parsed.echoes.map(item => [item.event, item.text]), [
    ["step-4", "echoed via argumentsJson"],
  ]);

  const syncEnv = {
    PATH: process.env.PATH,
    HOME: w.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: join(w.dir, "empty-gemini"),
    T3CODE_HOME: "",
    CLAUDE_CONFIG_DIR: join(w.dir, "empty-claude"),
    CODEX_HOME: join(w.dir, "empty-codex"),
    T3CODE_THREAD_ID: "",
    LC_ALL: "C",
  };
  const syncRes = spawnSync(process.execPath, [OWNER_WORDS, "sync", "--records", records, "--project", project], { ...options, env: syncEnv });
  assert.equal(syncRes.status, 0, syncRes.stderr);
  assert.deepEqual(committedWords(records).map(item => [item.event, item.text]), [
    ["step-0", "initial prompt"],
    ["step-6", "echoed via argumentsJson"],
    ["step-10", "after malformed send"],
  ]);
});
