// End-to-end acceptance tests for F-0009 Antigravity harness runner, cross-vendor independence,
// hook install/check/uninstall, git-clean workspace exclude, and start health visibility:
// AG-T3-01..04, AG-HOOK-01..02, plus R6/R7/R9 coverage.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { EXIT, recordCall } from "../scripts/call.mjs";
import { parseHandoffs } from "../scripts/lib/handoff.mjs";
import { modelVendor } from "../scripts/lib/vendor.mjs";
import { nextLines, recordsOf } from "../scripts/loop.mjs";
import { git, green, isolatedEnv, loopProduct, ownerStore, repo, scripts, selfLoop, setup, temp } from "../scripts/test/helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-ag-");

const t3Ag = (model = "gemini-4-neon-high") => ({ runner: "t3", provider: "antigravity", model, effort: "high" });
const handoffs = records => parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")).filter(h => h.step !== "reviewer-frame");

function wrapPrompt(body) {
  return `<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026-11-23\n</ADDITIONAL_METADATA>`;
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
    stmt.run(r.id, JSON.stringify((r.workspaces ?? []).map(w => pathToFileURL(w).href)), r.status ?? "CASCADE_RUN_STATUS_IDLE", r.parent ?? "", r.depth ?? 0, r.killed ?? 0, r.notFullyIdle ?? 0);
  }
  db.close();
}

function writeTranscript(appDir, id, rows, { filename = "transcript_full.jsonl" } = {}) {
  const logs = join(appDir, "brain", id, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, filename);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

async function prepAg(role = "actor", model = "gemini-4-neon-high") {
  const s = await setup({}, {
    agents: {
      critic: t3Ag(model),
      actor: t3Ag(model),
      judge: t3Ag("claude-opus-5-5-high"),
      reviewer: { runner: "cmd", cmd: ["true"] },
    },
  });
  const appDir = temp("ag-app-");
  process.env.ANTIGRAVITY_APP_DATA_DIR = appDir;
  process.env.GEMINI_HOME = temp("ag-gemini-");
  process.env.T3CODE_HOME = "";
  const r = s.run(role, { prepare: true });
  assert.equal(r.code, EXIT.done, r.message);
  return { s, r, appDir };
}

// AG-T3-01 (A14, R9): Synthetic/unobserved failure states + live pending + stale background GENERIC(RUNNING) complete.
test("AG-T3-01 (R9 synthetic unobserved fixtures): failure states, in-flight pending, and stale background RUNNING GENERIC", async () => {
  // (a) Synthetic, unobserved: user-cancelled child (IDLE, not_fully_idle=0, unanswered tool_calls) -> failed.
  {
    const { s, r, appDir } = await prepAg("actor");
    const { ws, wt, prompt } = r.prepared;
    writeFileSync(join(ws, "out/report.md"), "partial\n");
    writeSummaryDb(appDir, [{ id: "conv-cancel", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: 0 }]);
    writeTranscript(appDir, "conv-cancel", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:05Z", model: "gemini-4-neon-high", tool_calls: [{ name: "read_file", args: { Path: join(wt, "src/a.js") } }] },
    ]);
    const rec = recordCall(s.cfg, ws, { session: "conv-cancel" });
    assert.equal(rec.code, EXIT.failure);
    assert.deepEqual(handoffs(s.records), []);
    assert.equal(JSON.parse(git(s.records, "show", "HEAD:evidence/0001/actor-1-audit.json")).exit, 1);
  }

  // (b) Synthetic, unobserved: model-errored child (PLANNER_RESPONSE ERROR) -> failed.
  {
    const { s, r, appDir } = await prepAg("actor");
    const { ws, wt, prompt } = r.prepared;
    writeFileSync(join(ws, "out/report.md"), "partial\n");
    writeSummaryDb(appDir, [{ id: "conv-err", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: 0 }]);
    writeTranscript(appDir, "conv-err", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "ERROR", error: "model failed", created_at: "2026-11-23T01:00:05Z", model: "gemini-4-neon-high" },
    ]);
    const rec = recordCall(s.cfg, ws, { session: "conv-err" });
    assert.equal(rec.code, EXIT.failure);
    assert.deepEqual(handoffs(s.records), []);
  }

  // (c) Synthetic, unobserved: MAX_INVOCATIONS child (IDLE, not_fully_idle=0, unanswered tool_calls) -> failed.
  {
    const { s, r, appDir } = await prepAg("actor");
    const { ws, wt, prompt } = r.prepared;
    writeFileSync(join(ws, "out/report.md"), "partial\n");
    writeSummaryDb(appDir, [{ id: "conv-max", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: 0 }]);
    writeTranscript(appDir, "conv-max", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:05Z", model: "gemini-4-neon-high", tool_calls: [{ name: "run_command", args: { CommandLine: "echo hi" } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:06Z" },
    ]);
    const rec = recordCall(s.cfg, ws, { session: "conv-max" });
    assert.equal(rec.code, EXIT.failure);
    assert.deepEqual(handoffs(s.records), []);
  }

  // (d) Live in-flight child (RUNNING / not_fully_idle=1) -> pending with worktree kept for retry.
  {
    const { s, r, appDir } = await prepAg("actor");
    const { ws, wt, prompt } = r.prepared;
    writeFileSync(join(ws, "out/report.md"), "draft\n");
    writeSummaryDb(appDir, [{ id: "conv-live", workspaces: [wt], status: "CASCADE_RUN_STATUS_RUNNING", notFullyIdle: 1 }]);
    writeTranscript(appDir, "conv-live", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:05Z", model: "gemini-4-neon-high", tool_calls: [{ name: "read_file", args: { Path: join(wt, "src/a.js") } }] },
    ]);
    const rec = recordCall(s.cfg, ws, { session: "conv-live" });
    assert.equal(rec.code, EXIT.failure);
    assert.match(rec.message, /no terminal event yet/);
    assert.ok(existsSync(wt), "worktree kept while pending");
  }

  // (e) Finished child with stale background GENERIC(RUNNING) + final PLANNER_RESPONSE(DONE, no tool_calls) -> complete.
  {
    const { s, r, appDir } = await prepAg("actor");
    const { ws, wt, prompt } = r.prepared;
    writeFileSync(join(wt, "src/a.js"), "export const a = 2;\n");
    writeFileSync(join(ws, "out/report.md"), "actor complete\n");
    writeSummaryDb(appDir, [{ id: "conv-ok", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: 0 }]);
    writeTranscript(appDir, "conv-ok", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high", tool_calls: [{ name: "run_command", args: { CommandLine: "echo ok" } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "RUNNING", created_at: "2026-11-23T01:00:03Z" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:10Z", model: "gemini-4-neon-high", content: "done" },
    ]);
    const rec = recordCall(s.cfg, ws, { session: "conv-ok" });
    assert.equal(rec.code, EXIT.done, rec.message);
    const [h] = handoffs(s.records);
    assert.equal(h.agent.runner, "t3:antigravity");
    assert.deepEqual(h.agent.observedModels, ["gemini-4-neon-high"]);
    assert.equal(h.agent.seconds, 10);
  }
});

// AG-T3-02 & AG-T3-03 (A11, A12): mid-conversation model switch + convergence independence matrix.
test("AG-T3-02 & AG-T3-03: observedModels switch fails closed; convergence matrix enforces cross-vendor independence", async () => {
  // Record a mid-conversation vendor switch on actor and confirm observedModels reaches handoff facts.
  const { s, r, appDir } = await prepAg("actor");
  const { ws, wt, prompt } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "switched actor\n");
  writeSummaryDb(appDir, [{ id: "conv-switch", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: 0 }]);
  writeTranscript(appDir, "conv-switch", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high", tool_calls: [{ name: "read_file", args: { Path: join(wt, "src/a.js") } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:03Z" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:08Z", model: "claude-opus-5-5-high", content: "finished" },
  ]);
  const rec = recordCall(s.cfg, ws, { session: "conv-switch" });
  assert.equal(rec.code, EXIT.done, rec.message);
  const [h] = handoffs(s.records);
  assert.deepEqual(h.agent.observedModels, ["gemini-4-neon-high", "claude-opus-5-5-high"]);
  assert.equal(modelVendor(h.agent), null);

  // Full loop.mjs convergence() matrix:
  const checkConvergence = (actorAgent, judgeAgent) => {
    const product = repo({ "src/a.js": "export const a = 1;\n" });
    git(product, "branch", "loop/v1");
    const sha = git(product, "rev-parse", "loop/v1");
    const files = {
      "README.md": "# records\n",
      "records.json": "{}\n",
      "purpose/P-0001.md": "# P-0001\n",
      "blueprint/F-0001.md": "# F-0001\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n",
      "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n",
      "rounds/0001-actor.md": "# R-0001-actor\n",
      "rounds/0001-judge.md": "# R-0001-judge\n",
      "sealed/judge/0001/judge-1.md": "# R-0001-judge\n\nACCEPTANCE: pass\n",
      "metrics/handoffs.jsonl": [
        { id: "R-0001-reviewer-frame", time: "2026-11-23T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "claude" }, view: "f".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] },
        { id: "R-0001-actor", time: "2026-11-23T00:01:00Z", phase: "v1", round: 1, step: "actor", role: "actor", attempt: 1, agent: actorAgent, view: "f".repeat(40), product: { base: sha, commit: sha }, audit: { violations: 0 }, record: "rounds/0001-actor.md", files: ["rounds/0001-actor.md"] },
        { id: "R-0001-judge", time: "2026-11-23T00:02:00Z", phase: "v1", round: 1, step: "judge", role: "judge", attempt: 1, agent: judgeAgent, view: "f".repeat(40), product: { base: sha, commit: sha }, audit: { violations: 0 }, record: "rounds/0001-judge.md", files: ["rounds/0001-judge.md", "sealed/judge/0001/judge-1.md"] },
      ].map(o => JSON.stringify(o)).join("\n") + "\n",
      "metrics/trajectory.jsonl": JSON.stringify({ round: 1, phase: "v1", role: "judge", area: "core", verdict: "CONVERGED", opened: "-", closed: "-", shelved: "-", carried: "-", suite: "10/0", ci: "success", commit: sha }) + "\n",
      "loop.json": JSON.stringify({ product, branch: "loop/v1", records: ".", workDir: temp("w-"), phase: "v1", briefs: {}, agents: { actor: actorAgent, judge: judgeAgent } }),
    };
    const records = repo(files);
    const cfg = { product, branch: "loop/v1", records, workDir: temp("w-"), phase: "v1", briefs: {}, sealed: [], owns: {}, protected: [], purpose: [], setup: [], agents: { actor: actorAgent, judge: judgeAgent } };
    return nextLines(cfg, join(records, "loop.json"), recordsOf(cfg), { store: { path: ownerStore([]) } });
  };

  const switchedOut = checkConvergence(
    { runner: "t3:antigravity", observedModel: "gemini-4-neon-high", observedModels: ["gemini-4-neon-high", "claude-opus-5-5-high"] },
    { runner: "t3:codex", observedModel: "gpt-6.2-astra" },
  );
  assert.match(switchedOut, /judge\/actor independence needs confirmation/);

  const sameGoogle = checkConvergence(
    { runner: "t3:antigravity", observedModel: "gemini-4-neon-high", observedModels: ["gemini-4-neon-high"] },
    { runner: "t3:antigravity", observedModel: "gemini-4-hydrogen-high", observedModels: ["gemini-4-hydrogen-high"] },
  );
  assert.match(sameGoogle, /judge\/actor independence needs confirmation/);

  const crossVendor = checkConvergence(
    { runner: "t3:antigravity", observedModel: "gemini-4-neon-high", observedModels: ["gemini-4-neon-high"] },
    { runner: "t3:antigravity", observedModel: "claude-opus-5-5-high", observedModels: ["claude-opus-5-5-high"] },
  );
  assert.doesNotMatch(crossVendor, /judge\/actor independence needs confirmation/);

  const sameAnthropic = checkConvergence(
    { runner: "t3:claude", observedModel: "claude-opus-5-5" },
    { runner: "t3:antigravity", observedModel: "claude-opus-5-5-high", observedModels: ["claude-opus-5-5-high"] },
  );
  assert.match(sameAnthropic, /judge\/actor independence needs confirmation/);

  const unknownModel = checkConvergence(
    { runner: "t3:antigravity", observedModel: "auto", observedModels: ["auto"] },
    { runner: "t3:codex", observedModel: "gpt-6.2-astra" },
  );
  assert.match(unknownModel, /judge\/actor independence needs confirmation/);

  // J3: empty observedModels on Antigravity must NOT fall back to configured model for independence.
  const emptyObserved = checkConvergence(
    { runner: "t3:antigravity", model: "gemini-4-neon-high", observedModel: null, observedModels: [] },
    { runner: "t3:codex", observedModel: "gpt-6.2-astra" },
  );
  assert.match(emptyObserved, /judge\/actor independence needs confirmation/);
  const pNoModel = await prepAg("actor", "gemini-4-neon-high");
  writeFileSync(join(pNoModel.r.prepared.ws, "out/report.md"), "done\n");
  const noModelFile = writeTranscript(pNoModel.appDir, "conv-no-model", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: wrapPrompt(pNoModel.r.prepared.prompt) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "done" },
  ]);
  assert.equal(recordCall(pNoModel.s.cfg, pNoModel.r.prepared.ws, { session: "conv-no-model", transcript: noModelFile }).code, EXIT.done);
  const [noModelHandoff] = handoffs(pNoModel.s.records);
  assert.deepEqual(noModelHandoff.agent.observedModels, []);
  assert.equal(noModelHandoff.agent.observedModel, null);
  assert.equal(modelVendor(noModelHandoff.agent), null);
});

// AG-T3-04 + AG-AUDIT-01/02/03 via call.mjs record: confined reviewer on t3:antigravity succeeds (t3:codex exit 64); tampered/wrong-session/handoff/compact/delegation refused.
test("AG-T3-04 + record refusals: confined reviewer on t3:antigravity (t3:codex exit 64); tampered, wrong session, handoff, compact, and delegation calls refused", async () => {
  const sCodexRev = await setup({}, { frame: false, agents: { reviewer: { runner: "t3", provider: "codex", model: "gpt-5.4" } } });
  assert.equal(sCodexRev.run("reviewer", { step: "reviewer-frame", prepare: true }).code, EXIT.usage);

  const sRev = await setup({}, { frame: false, agents: { reviewer: t3Ag() } });
  const rev = sRev.run("reviewer", { step: "reviewer-frame", prepare: true });
  assert.equal(rev.code, EXIT.done, rev.message);
  assert.equal(rev.prepared.wt, null);
  writeFileSync(join(rev.prepared.ws, "out/report.md"), "frame report\n");
  const revAppDir = temp("ag-rev-app-");
  process.env.ANTIGRAVITY_APP_DATA_DIR = revAppDir;
  process.env.GEMINI_HOME = temp("ag-rev-gemini-");
  process.env.T3CODE_HOME = "";
  const revOkFile = writeTranscript(revAppDir, "conv-rev-ok", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(rev.prepared.prompt) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:01Z", model: "gemini-4-neon-high",
      tool_calls: [{ name: "read_file", args: { Path: join(rev.prepared.ws, "brief.md") } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:02Z" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:03Z", model: "gemini-4-neon-high" },
  ]);
  assert.equal(recordCall(sRev.cfg, rev.prepared.ws, { session: "conv-rev-ok", transcript: revOkFile }).code, EXIT.done);

  // Tampered first prompt, wrong --session, Context handoff first prompt -> refused with worktree kept.
  const { s, r, appDir } = await prepAg("actor");
  const { ws, wt, prompt, nonce } = r.prepared;
  writeFileSync(join(ws, "out/report.md"), "report\n");
  writeSummaryDb(appDir, [
    { id: "conv-tamper", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE" },
    { id: "conv-handoff", workspaces: [wt], status: "CASCADE_RUN_STATUS_IDLE" },
  ]);
  const tamperFile = writeTranscript(appDir, "conv-tamper", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(`self-loop call R-0001-actor · nonce ${nonce}\n\ntampered`) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high" },
  ]);
  assert.equal(recordCall(s.cfg, ws, { session: "conv-tamper", transcript: tamperFile }).code, EXIT.records);
  assert.ok(existsSync(wt));

  const handoffFile = writeTranscript(appDir, "conv-handoff", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(`Context handoff (full_thread_summary):\nsummary\n\nUser message:\n${prompt}`) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high" },
  ]);
  assert.equal(recordCall(s.cfg, ws, { session: "conv-handoff", transcript: handoffFile }).code, EXIT.records);
  assert.ok(existsSync(wt));

  const validFile = writeTranscript(appDir, "conv-real", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high" },
  ]);
  assert.equal(recordCall(s.cfg, ws, { session: "wrong-session", transcript: validFile }).code, EXIT.records);
  assert.ok(existsSync(wt));

  // Compact transcript refused with EXIT.records (AG-AUDIT-01).
  const compactFile = writeTranscript(appDir, "conv-compact", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(prompt) },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", truncated_fields: ["tool_calls"], created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high", tool_calls: [{ name: "read_file", args: { Path: JSON.stringify(join(s.sealed, "case-07.mjs")) } }] },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:03Z" },
    { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:04Z", model: "gemini-4-neon-high" },
  ], { filename: "transcript.jsonl" });
  assert.equal(recordCall(s.cfg, ws, { session: "conv-compact", transcript: compactFile }).code, EXIT.records);
  assert.deepEqual(handoffs(s.records), []);

  // Delegation tool / schedule_task / html_preview sealed path / embedded file:// HTML / deep nested file:// refused with EXIT.violation (AG-AUDIT-02, AG-AUDIT-03, R6, B1).
  for (const makeTc of [
    () => ({ name: "invoke_subagent", args: { Prompt: "read sealed" } }),
    () => ({ name: "mcp_t3-code_schedule_task", args: { prompt: "read sealed" } }),
    p2 => ({ name: "mcp_t3-code_html_preview", args: { path: join(p2.s.sealed, "case-07.mjs") } }),
    p2 => ({ name: "mcp_t3-code_html_preview", args: { html: `<iframe src="${pathToFileURL(join(p2.s.sealed, "case-07.mjs")).href}"></iframe>` } }),
    p2 => ({ name: "mcp_t3-code_t3_thread_read", args: { payload: { resources: [{ uri: pathToFileURL(join(p2.s.sealed, "case-07.mjs")).href }] } } }),
  ]) {
    const p2 = await prepAg("actor");
    const tc = makeTc(p2);
    writeFileSync(join(p2.r.prepared.ws, "out/report.md"), "report\n");
    writeSummaryDb(p2.appDir, [{ id: "conv-viol", workspaces: [p2.r.prepared.wt], status: "CASCADE_RUN_STATUS_IDLE" }]);
    const violFile = writeTranscript(p2.appDir, "conv-viol", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(p2.r.prepared.prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high", tool_calls: [tc] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:03Z" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:04Z", model: "gemini-4-neon-high" },
    ]);
    const vRes = recordCall(p2.s.cfg, p2.r.prepared.ws, { session: "conv-viol", transcript: violFile });
    assert.equal(vRes.code, EXIT.violation, JSON.stringify(tc));
    assert.deepEqual(handoffs(p2.s.records), []);
  }

  // B1 positive control + parenthesized sealed directory end-to-end record test.
  {
    const parenDir = join(temp("ag-paren-"), "sealed(cases)");
    mkdirSync(parenDir, { recursive: true });
    const parenSealed = repo({ "case.mjs": "export default 1;\n" }, parenDir);
    const sParen = await setup({}, {
      sealed: [parenSealed],
      agents: { critic: t3Ag(), actor: t3Ag(), judge: t3Ag("claude-opus-5-5-high"), reviewer: { runner: "cmd", cmd: ["true"] } },
    });
    const appDir2 = temp("ag-app-paren-");
    process.env.ANTIGRAVITY_APP_DATA_DIR = appDir2;
    process.env.GEMINI_HOME = temp("ag-gemini-paren-");
    process.env.T3CODE_HOME = "";
    const pViol = sParen.run("actor", { prepare: true });
    writeFileSync(join(pViol.prepared.ws, "out/report.md"), "report\n");
    writeSummaryDb(appDir2, [{ id: "conv-paren-viol", workspaces: [pViol.prepared.wt], status: "CASCADE_RUN_STATUS_IDLE" }]);
    const violFile = writeTranscript(appDir2, "conv-paren-viol", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(pViol.prepared.prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high", tool_calls: [{ name: "mcp_t3-code_html_preview", args: { html: `<iframe src="${pathToFileURL(join(parenSealed, "case.mjs")).href}"></iframe>` } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:03Z" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:04Z", model: "gemini-4-neon-high" },
    ]);
    assert.equal(recordCall(sParen.cfg, pViol.prepared.ws, { session: "conv-paren-viol", transcript: violFile }).code, EXIT.violation);
    assert.deepEqual(handoffs(sParen.records), []);

    const pOk = sParen.run("actor", { round: 2, prepare: true });
    writeFileSync(join(pOk.prepared.ws, "out/report.md"), "safe preview report\n");
    writeSummaryDb(appDir2, [{ id: "conv-html-ok", workspaces: [pOk.prepared.wt], status: "CASCADE_RUN_STATUS_IDLE" }]);
    const okFile = writeTranscript(appDir2, "conv-html-ok", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-23T01:00:00Z", content: wrapPrompt(pOk.prepared.prompt) },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:02Z", model: "gemini-4-neon-high", tool_calls: [{ name: "mcp_t3-code_html_preview", args: { html: '<div class="chart">safe preview</div>' } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-23T01:00:03Z" },
      { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-23T01:00:04Z", model: "gemini-4-neon-high" },
    ]);
    const okRes = recordCall(sParen.cfg, pOk.prepared.ws, { session: "conv-html-ok", transcript: okFile });
    assert.equal(okRes.code, EXIT.done, okRes.message);
    assert.equal(handoffs(sParen.records).length, 1);
  }
});

// AG-HOOK-01 (A8, A2, R7, B4): global install, T3 instance coverage check, version drift, GEMINI_HOME="", missing-skill finding & start advisory.
test("AG-HOOK-01 (A8, A2, R7, B4): global install, uncovered T3 instance, runtime version drift, GEMINI_HOME='', missing skill finding, start visibility", () => {
  const prod = loopProduct({ activity: "2026-11-23T01:00:00.000Z" });
  const store = ownerStore([{ name: "p1", records: prod.records }]);
  const gHome = temp("ag-g-");
  const t3Dir = temp("ag-t3-");
  const instA = join(t3Dir, "userdata", "providers", "antigravity", "aaaa1111");
  const instB = join(t3Dir, "userdata", "providers", "antigravity", "bbbb2222");
  mkdirSync(join(instA, "config"), { recursive: true });
  mkdirSync(join(instB, "config"), { recursive: true });

  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, GEMINI_HOME: gHome, T3CODE_HOME: t3Dir });
  const instGlobal = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--config", join(prod.records, "loop.json")], { env });
  assert.equal(instGlobal.status, 0, instGlobal.stderr);
  assert.ok(existsSync(join(gHome, "config", "hooks.json")));

  // Install into instA only; instB remains uncovered.
  const instOne = selfLoop(["hooks", "install", "--harness", "antigravity", "--target", join(instA, "config", "hooks.json"), "--config", join(prod.records, "loop.json")], { env });
  assert.equal(instOne.status, 0, instOne.stderr);

  const checkDrift = selfLoop(
    ["hooks", "check", "--harness", "antigravity", "--scope", "global", "--config", join(prod.records, "loop.json"), "--json"],
    { env: { ...env, ANTIGRAVITY_LS_VERSION: "cli-9.9.9" } }
  );
  assert.equal(checkDrift.status, 2);
  const report = JSON.parse(checkDrift.stdout);
  assert.ok(report.findings.some(f => f.includes("bbbb2222")), report.findings.join("\n"));
  assert.ok(report.findings.some(f => f.includes("cli-9.9.9")), report.findings.join("\n"));
  assert.ok(report.findings.some(f => f.includes("self-loop/SKILL.md")), report.findings.join("\n"));

  // start surfaces advisory line when T3 instance is uncovered and skill is missing, and leaves non-Antigravity start unchanged.
  const startWithAg = selfLoop(["start", "--now", "2026-11-23T02:00:00.000Z"], { cwd: prod.product, env });
  assert.equal(startWithAg.status, 0);
  assert.match(startWithAg.stdout, /hooks \(antigravity\):.*bbbb2222/);
  assert.match(startWithAg.stdout, /hooks \(antigravity\):.*self-loop\/SKILL\.md/);

  const startWithoutAg = selfLoop(["start", "--now", "2026-11-23T02:00:00.000Z"], { cwd: prod.product, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
  assert.equal(startWithoutAg.status, 0);
  assert.doesNotMatch(startWithoutAg.stdout, /hooks \(antigravity\)/);

  // R7 + B4: GEMINI_HOME="" resolves identically to ${HOME}/.gemini; check fails without skill and passes once skill exists.
  const r7Env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, GEMINI_HOME: "", T3CODE_HOME: "" });
  const r7Install = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--config", join(prod.records, "loop.json")], { env: r7Env });
  assert.equal(r7Install.status, 0, r7Install.stderr);
  assert.ok(existsSync(join(r7Env.HOME, ".gemini", "config", "hooks.json")));
  const r7NoSkill = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global", "--config", join(prod.records, "loop.json")], { env: r7Env });
  assert.equal(r7NoSkill.status, 2);
  assert.match(r7NoSkill.stdout, /self-loop\/SKILL\.md/);
  const globalSkill = join(r7Env.HOME, ".gemini", "config", "skills", "self-loop", "SKILL.md");
  mkdirSync(join(globalSkill, ".."), { recursive: true });
  writeFileSync(globalSkill, "# self-loop\n");
  const r7Check = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "global", "--config", join(prod.records, "loop.json")], { env: r7Env });
  assert.equal(r7Check.status, 0, r7Check.stdout + r7Check.stderr);
});

// AG-HOOK-02 (A9, A1, B4): workspace install stays git-clean, idempotent, version-gate safe, preserves other keys & excludes.
test("AG-HOOK-02 (A9, A1, B4): workspace install is git-clean, idempotent, preserves custom hooks/excludes, checks skill & matcher, uninstalls cleanly", () => {
  const prod = loopProduct({ activity: "2026-11-23T01:00:00.000Z" });
  writeFileSync(join(prod.product, "VERSION"), "0.1.0\n");
  git(prod.product, "add", "VERSION");
  git(prod.product, "commit", "-qm", "version");
  git(prod.product, "branch", "-f", "loop/v1");
  const excludeFile = join(prod.product, ".git", "info", "exclude");
  writeFileSync(excludeFile, "# user rule\n/.env\n");
  mkdirSync(join(prod.product, ".agents"), { recursive: true });
  const hooksFile = join(prod.product, ".agents", "hooks.json");
  writeFileSync(hooksFile, JSON.stringify({ "custom-linter": { enabled: true } }, null, 2) + "\n");

  const env = isolatedEnv({ T3CODE_HOME: "" });
  const cfgPath = join(prod.records, "loop.json");
  const first = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "workspace", "--config", cfgPath], { env });
  assert.equal(first.status, 0, first.stderr);
  const bytes1 = readFileSync(hooksFile, "utf8");
  assert.equal(git(prod.product, "status", "--porcelain"), "", "working tree stays clean");
  assert.deepEqual(JSON.parse(bytes1)["custom-linter"], { enabled: true });

  // Second install is byte-identical.
  const second = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "workspace", "--config", cfgPath], { env });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readFileSync(hooksFile, "utf8"), bytes1);

  // version-gate.mjs release clean-tree check (line 123-124) does not refuse for dirty tree, and tip exits 0.
  const relCheck = spawnSync(process.execPath, [join(scripts, "version-gate.mjs"), "release", "--branch", "loop/v1"], { cwd: prod.product, encoding: "utf8", env });
  assert.doesNotMatch(relCheck.stderr, /the working tree is not clean/);
  const tip = spawnSync(process.execPath, [join(scripts, "version-gate.mjs"), "tip", "--version", "0.1.1"], { cwd: prod.product, encoding: "utf8", env });
  assert.equal(tip.status, 0, tip.stderr);

  // B4: without skill, hooks check exits 2 naming self-loop/SKILL.md; once skill exists, hooks check exits 0.
  const missingSkillCheck = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "workspace", "--config", cfgPath], { env });
  assert.equal(missingSkillCheck.status, 2);
  assert.match(missingSkillCheck.stdout, /self-loop\/SKILL\.md/);

  const globalSkill = join(env.HOME, ".agents", "skills", "self-loop", "SKILL.md");
  mkdirSync(join(globalSkill, ".."), { recursive: true });
  writeFileSync(globalSkill, "# self-loop\n");
  const okCheck = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "workspace", "--config", cfgPath], { env });
  assert.equal(okCheck.status, 0, okCheck.stdout + okCheck.stderr);

  // Corrupt matcher away from "*" -> hooks check fails (exit 2).
  const corrupted = JSON.parse(bytes1);
  corrupted["self-loop"].PreToolUse[0].matcher = "run_command|edit_file";
  writeFileSync(hooksFile, JSON.stringify(corrupted, null, 2) + "\n");
  const badCheck = selfLoop(["hooks", "check", "--harness", "antigravity", "--scope", "workspace", "--config", cfgPath], { env });
  assert.equal(badCheck.status, 2);
  assert.match(badCheck.stdout, /matcher "\*"/);

  // Uninstall removes only "self-loop" and only the managed exclude pair.
  const uninst = selfLoop(["hooks", "uninstall", "--harness", "antigravity", "--scope", "workspace", "--config", cfgPath], { env });
  assert.equal(uninst.status, 0, uninst.stderr);
  const after = JSON.parse(readFileSync(hooksFile, "utf8"));
  assert.equal("self-loop" in after, false);
  assert.deepEqual(after["custom-linter"], { enabled: true });
  assert.equal(readFileSync(excludeFile, "utf8"), "# user rule\n/.env\n");

  // J2: clean repo with no pre-existing .agents/hooks.json stays Git-clean across install -> uninstall.
  const cleanProd = loopProduct({ activity: "2026-11-23T01:00:00.000Z" });
  const cleanCfg = join(cleanProd.records, "loop.json");
  assert.equal(existsSync(join(cleanProd.product, ".agents", "hooks.json")), false);
  assert.equal(selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "workspace", "--config", cleanCfg], { env }).status, 0);
  assert.equal(git(cleanProd.product, "status", "--porcelain"), "");
  assert.equal(selfLoop(["hooks", "uninstall", "--harness", "antigravity", "--scope", "workspace", "--config", cleanCfg], { env }).status, 0);
  assert.equal(existsSync(join(cleanProd.product, ".agents", "hooks.json")), false);
  assert.equal(existsSync(join(cleanProd.product, ".agents")), false);
  assert.equal(git(cleanProd.product, "status", "--porcelain"), "");
});
