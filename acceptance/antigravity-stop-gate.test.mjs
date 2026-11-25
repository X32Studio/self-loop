// F-0008, F-0009, F-0010, D-0052, D-0060, R-0036-judge-final
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseShellWords } from "../scripts/lib/hooks.mjs";
import { appendWords, committedWords, queueOwnerPrompt, sha, wordId } from "../scripts/lib/owner-words.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, scripts, selfLoop, temp } from "../scripts/test/helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const realTemp = prefix => realpathSync(temp(prefix));

function wrapEnvelope(body) {
  return [
    "<USER_REQUEST>",
    "<t3_code_instructions>",
    "## Mode",
    "</t3_code_instructions>",
    "",
    `<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>`,
    "</USER_REQUEST>",
    "<ADDITIONAL_METADATA>",
    "2026-11-23",
    "</ADDITIONAL_METADATA>",
  ].join("\n");
}

const userStep = (step_index, content, extra = {}) => ({
  step_index,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: "2026-11-23T01:00:00.000Z",
  ...(content !== undefined ? { content } : {}),
  ...extra,
});

function makeProduct(name) {
  const dir = realTemp(`ag-stop-${name}-`);
  const { product, records } = loopProduct({ activity: "2026-11-23T01:00:00.000Z", dir });
  git(product, "branch", "-f", "loop/v1");
  writeFileSync(join(product, ".git", "info", "exclude"), "/.agents/hooks.json\n");
  return { dir, product, records };
}

function writeTranscript(appDir, id, name, rows) {
  const logs = join(appDir, "brain", id, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, name);
  const body = rows.map(r => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
  writeFileSync(file, body);
  return file;
}

function writeSummaryDb(appDir, rows) {
  mkdirSync(appDir, { recursive: true });
  const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (
    conversation_id TEXT PRIMARY KEY,
    workspace_uris TEXT,
    status TEXT,
    parent_conversation_id TEXT DEFAULT '',
    nesting_depth INTEGER DEFAULT 0,
    killed INTEGER DEFAULT 0,
    not_fully_idle INTEGER DEFAULT 0
  )`);
  const stmt = db.prepare(`INSERT OR REPLACE INTO conversation_summaries
    (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    stmt.run(
      r.id,
      JSON.stringify((r.workspaces ?? []).map(w => pathToFileURL(w).href)),
      r.status ?? "CASCADE_RUN_STATUS_IDLE",
      r.parent ?? "",
      r.depth ?? 0,
      r.killed ?? 0,
      r.notFullyIdle ?? 0,
    );
  }
  db.close();
}

function installStopCommand({ scope, store, config, gHome, env }) {
  const args = scope === "global"
    ? ["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store]
    : ["hooks", "install", "--harness", "antigravity", "--scope", "workspace", "--config", config];
  const inst = selfLoop(args, { cwd: realTemp("ag-stop-inst-"), env });
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const hooksFile = scope === "global"
    ? join(gHome, "config", "hooks.json")
    : join(JSON.parse(readFileSync(config, "utf8")).product, ".agents", "hooks.json");
  const cmd = parseShellWords(JSON.parse(readFileSync(hooksFile, "utf8"))["self-loop"].Stop[0].command);
  return (payload, cwd = realTemp("ag-stop-hook-cwd-")) => spawnSync(cmd[0], cmd.slice(1), {
    input: JSON.stringify(payload),
    cwd,
    encoding: "utf8",
    env,
  });
}

function commitOwnerWord(records, session, text, event = "step-0") {
  const id = wordId(session, text, 0);
  appendWords(records, [{
    id,
    time: "2026-11-23T01:00:00.000Z",
    source: "antigravity",
    session,
    event,
    text,
    sha256: sha(text),
  }]);
  return id;
}

function unresolvedVariants(appDir, prefix, product, unverifiedFollowUp) {
  return [
    {
      label: "truncated envelope without closing tag",
      convId: `${prefix}-unclosed`,
      rows: [
        userStep(0, "<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n<truncated 1200 bytes>"),
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
    {
      label: "truncated_fields content omitted",
      convId: `${prefix}-omitted`,
      rows: [
        userStep(0, undefined, { truncated_fields: ["content"] }),
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
    {
      label: "partial corrupt JSONL line",
      convId: `${prefix}-parse-error`,
      rows: [
        '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<truncated',
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
    {
      label: "truncated_fields with string content",
      convId: `${prefix}-trunc-str`,
      rows: [
        userStep(0, wrapEnvelope("Alpha...<truncated 1200 bytes>"), { truncated_fields: ["content"] }),
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
    {
      label: "missing step-0 before step-1",
      convId: `${prefix}-no-step0`,
      rows: [
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
  ].map(v => ({
    ...v,
    transcriptPath: writeTranscript(appDir, v.convId, "transcript.jsonl", v.rows),
    workspaces: [product],
  }));
}

test("AG-STOP-01: global --owner-store Stop enforces open committed words and pending prompts on unresolved transcripts without admitting unverified words", () => {
  const alpha = makeProduct("alpha");
  const store = ownerStore([{ name: "alpha", records: alpha.records }], { dir: realTemp("ag-stop1-store-") });
  const gHome = realTemp("ag-stop1-g-");
  const appDir = realTemp("ag-stop1-app-");
  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: gHome,
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    TMPDIR: realTemp("ag-stop1-tmp-"),
  });

  const runGlobalStop = installStopCommand({ scope: "global", store, gHome, env });
  const unverifiedFollowUp = "Unverified step-1 prompt that must NOT enter ledger";
  const cases = unresolvedVariants(appDir, "conv-g", alpha.product, unverifiedFollowUp);
  const pendingConv = "conv-g-pending";
  const pendingTx = writeTranscript(appDir, pendingConv, "transcript.jsonl", [
    userStep(0, "<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n<truncated 900 bytes>"),
    userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
  ]);
  writeSummaryDb(appDir, [
    ...cases.map(c => ({ id: c.convId, workspaces: c.workspaces })),
    { id: pendingConv, workspaces: [alpha.product] },
  ]);

  const expectedIds = [];
  for (const c of cases) {
    const id = commitOwnerWord(alpha.records, c.convId, `Verified open owner word (${c.label})`);
    expectedIds.push(id);
    const res = runGlobalStop({
      hookEventName: "Stop",
      conversationId: c.convId,
      transcriptPath: c.transcriptPath,
      cwd: alpha.product,
      continuationActive: false,
      fullyIdle: true,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(res.status, 0, `${c.label}: stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "continue", `${c.label}: expected decision "continue", got ${res.stdout}`);
    assert.ok(out.reason.includes(id), `${c.label}: expected ${id} in reason:\n${out.reason}`);
  }

  queueOwnerPrompt(alpha.records, {
    source: "antigravity",
    session: pendingConv,
    event: "step-0",
    time: "2026-11-23T01:00:00.000Z",
    text: "Pending owner directive awaiting transcript confirmation",
  });
  const pendingRes = runGlobalStop({
    hookEventName: "Stop",
    conversationId: pendingConv,
    transcriptPath: pendingTx,
    cwd: alpha.product,
    continuationActive: false,
    fullyIdle: true,
    terminationReason: "NO_TOOL_CALL",
  });
  assert.equal(pendingRes.status, 0, `pending: stderr=${pendingRes.stderr}`);
  const pendingOut = JSON.parse(pendingRes.stdout);
  assert.equal(pendingOut.decision, "continue", `pending: expected decision "continue", got ${pendingRes.stdout}`);
  assert.match(pendingOut.reason, /Pending owner directive awaiting transcript confirmation/);

  const committed = committedWords(alpha.records);
  assert.deepEqual(committed.map(w => w.id), expectedIds);
  assert.equal(committed.some(w => w.text === unverifiedFollowUp), false);
});

test("AG-STOP-02: scoped --records --project Stop enforces open committed words and pending prompts on unresolved transcripts without admitting unverified words", () => {
  const alpha = makeProduct("alpha");
  const gHome = realTemp("ag-stop2-g-");
  const appDir = realTemp("ag-stop2-app-");
  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: gHome,
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    TMPDIR: realTemp("ag-stop2-tmp-"),
  });

  const runScopedStop = installStopCommand({
    scope: "workspace",
    config: join(alpha.records, "loop.json"),
    gHome,
    env,
  });
  const unverifiedFollowUp = "Unverified scoped step-1 prompt that must NOT enter ledger";
  const cases = unresolvedVariants(appDir, "conv-s", alpha.product, unverifiedFollowUp);
  const pendingConv = "conv-s-pending";
  const pendingTx = writeTranscript(appDir, pendingConv, "transcript.jsonl", [
    userStep(0, undefined, { truncated_fields: ["content"] }),
    userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
  ]);
  writeSummaryDb(appDir, [
    ...cases.map(c => ({ id: c.convId, workspaces: c.workspaces })),
    { id: pendingConv, workspaces: [alpha.product] },
  ]);

  const expectedIds = [];
  for (const c of cases) {
    const id = commitOwnerWord(alpha.records, c.convId, `Scoped verified open word (${c.label})`);
    expectedIds.push(id);
    const res = runScopedStop({
      hookEventName: "Stop",
      conversationId: c.convId,
      transcriptPath: c.transcriptPath,
      cwd: alpha.product,
      continuationActive: false,
      fullyIdle: true,
      terminationReason: "NO_TOOL_CALL",
    });
    assert.equal(res.status, 0, `${c.label}: stderr=${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.decision, "continue", `${c.label}: expected decision "continue", got ${res.stdout}`);
    assert.ok(out.reason.includes(id), `${c.label}: expected ${id} in reason:\n${out.reason}`);
  }

  queueOwnerPrompt(alpha.records, {
    source: "antigravity",
    session: pendingConv,
    event: "step-0",
    time: "2026-11-23T01:00:00.000Z",
    text: "Scoped pending owner directive awaiting transcript confirmation",
  });
  const pendingRes = runScopedStop({
    hookEventName: "Stop",
    conversationId: pendingConv,
    transcriptPath: pendingTx,
    cwd: alpha.product,
    continuationActive: false,
    fullyIdle: true,
    terminationReason: "NO_TOOL_CALL",
  });
  assert.equal(pendingRes.status, 0, `pending: stderr=${pendingRes.stderr}`);
  const pendingOut = JSON.parse(pendingRes.stdout);
  assert.equal(pendingOut.decision, "continue", `pending: expected decision "continue", got ${pendingRes.stdout}`);
  assert.match(pendingOut.reason, /Scoped pending owner directive awaiting transcript confirmation/);

  const committed = committedWords(alpha.records);
  assert.deepEqual(committed.map(w => w.id), expectedIds);
  assert.equal(committed.some(w => w.text === unverifiedFollowUp), false);
});

test("AG-STOP-03: confirmed delegated child with complete transcript_full.jsonl skips cleanly with {} even when alpha has open owner words", () => {
  const alpha = makeProduct("alpha");
  const store = ownerStore([{ name: "alpha", records: alpha.records }], { dir: realTemp("ag-stop3-store-") });
  const gHome = realTemp("ag-stop3-g-");
  const appDir = realTemp("ag-stop3-app-");
  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: gHome,
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    TMPDIR: realTemp("ag-stop3-tmp-"),
  });

  const runGlobalStop = installStopCommand({ scope: "global", store, gHome, env });
  const runScopedStop = installStopCommand({ scope: "workspace", config: join(alpha.records, "loop.json"), gHome, env });

  const ownerWordId = commitOwnerWord(alpha.records, "conv-owner-open", "Open owner word in alpha ledger");

  const childSpecs = [
    {
      label: "isLeadPrompt child",
      convId: "conv-child-lead",
      step0: "Act as the test sub-agent for this task.\n\nself-loop call R-0001-actor · nonce aaaa1111bbbb2222",
    },
    {
      label: "DELEGATED_NOTICE child",
      convId: "conv-child-delegated",
      step0: "Delegated task node:delegated-task:abc (Actor) in child thread thread:delegated-task:abc [completed]: done",
    },
    {
      label: "T3_AGENT_NOTICE child",
      convId: "conv-child-t3",
      step0: '[T3 Code: the agent in T3 thread "t0" sent this message, not the user.]\n\nPlease review the patch.',
    },
  ];

  const txs = childSpecs.map(spec => {
    const file = writeTranscript(appDir, spec.convId, "transcript_full.jsonl", [
      userStep(0, wrapEnvelope(spec.step0)),
      userStep(1, wrapEnvelope("Follow-up prompt inside confirmed child session"), { created_at: "2026-11-23T01:01:00.000Z" }),
    ]);
    commitOwnerWord(alpha.records, spec.convId, `Ledger word tagged to ${spec.convId}`);
    return { ...spec, transcriptPath: file };
  });
  writeSummaryDb(appDir, txs.map(c => ({ id: c.convId, workspaces: [alpha.product] })));

  for (const c of txs) {
    const payload = {
      hookEventName: "Stop",
      conversationId: c.convId,
      transcriptPath: c.transcriptPath,
      cwd: alpha.product,
      continuationActive: false,
      fullyIdle: true,
      terminationReason: "NO_TOOL_CALL",
    };
    for (const [mode, runner] of [["global", runGlobalStop], ["scoped", runScopedStop]]) {
      const res = runner(payload);
      assert.equal(res.status, 0, `${mode} ${c.label}: stderr=${res.stderr}`);
      assert.deepEqual(JSON.parse(res.stdout), {}, `${mode} ${c.label}: expected {}, got ${res.stdout}`);
    }
  }

  const committed = committedWords(alpha.records);
  assert.ok(committed.some(w => w.id === ownerWordId));
  assert.equal(committed.some(w => w.text === "Follow-up prompt inside confirmed child session"), false);
});

test("AG-STOP-04: --max-blocks 2 bounds Stop refusals under unresolved transcript reads across global and scoped modes", () => {
  const alpha = makeProduct("alpha");
  const store = ownerStore([{ name: "alpha", records: alpha.records }], { dir: realTemp("ag-stop4-store-") });
  const appDir = realTemp("ag-stop4-app-");
  const env = isolatedEnv({
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    GEMINI_HOME: realTemp("ag-stop4-g-"),
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    TMPDIR: realTemp("ag-stop4-tmp-"),
  });

  const unverifiedFollowUp = "Unverified step-1 under bounded Stop";
  const modes = [
    {
      label: "global --owner-store",
      convId: "conv-bound-global",
      args: ["--harness", "antigravity", "--owner-store", store, "--max-blocks", "2"],
      rows: [
        userStep(0, "<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n<truncated 1200 bytes>"),
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
    {
      label: "scoped --records --project",
      convId: "conv-bound-scoped",
      args: ["--harness", "antigravity", "--records", alpha.records, "--project", alpha.product, "--max-blocks", "2"],
      rows: [
        userStep(0, undefined, { truncated_fields: ["content"] }),
        userStep(1, wrapEnvelope(unverifiedFollowUp), { created_at: "2026-11-23T01:01:00.000Z" }),
      ],
    },
  ];

  const txPaths = modes.map(m => ({
    ...m,
    transcriptPath: writeTranscript(appDir, m.convId, "transcript.jsonl", m.rows),
    wordId: commitOwnerWord(alpha.records, m.convId, `Bounded open word (${m.label})`),
  }));
  writeSummaryDb(appDir, txPaths.map(m => ({ id: m.convId, workspaces: [alpha.product] })));

  for (const m of txPaths) {
    const invoke = () => spawnSync(process.execPath, [join(scripts, "word-gate.mjs"), ...m.args], {
      input: JSON.stringify({
        hookEventName: "Stop",
        conversationId: m.convId,
        transcriptPath: m.transcriptPath,
        cwd: alpha.product,
        continuationActive: false,
        fullyIdle: true,
        terminationReason: "NO_TOOL_CALL",
      }),
      cwd: realTemp("ag-stop4-cwd-"),
      encoding: "utf8",
      env,
    });

    for (const attempt of [1, 2]) {
      const res = invoke();
      assert.equal(res.status, 0, `${m.label} attempt ${attempt}: stderr=${res.stderr}`);
      const out = JSON.parse(res.stdout);
      assert.equal(out.decision, "continue", `${m.label} attempt ${attempt}: got ${res.stdout}`);
      assert.ok(out.reason.includes(m.wordId), `${m.label} attempt ${attempt}: ${out.reason}`);
    }

    const third = invoke();
    assert.equal(third.status, 0, `${m.label} attempt 3: stderr=${third.stderr}`);
    assert.deepEqual(JSON.parse(third.stdout), {}, `${m.label} attempt 3: expected release {}`);
    assert.match(third.stderr, new RegExp(`${m.wordId} still open after 2 refusals`), `${m.label} attempt 3 stderr`);
  }

  const committed = committedWords(alpha.records);
  assert.deepEqual(committed.map(w => w.id), txPaths.map(m => m.wordId));
  assert.equal(committed.some(w => w.text === unverifiedFollowUp), false);
});
