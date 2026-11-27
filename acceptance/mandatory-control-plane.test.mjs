// D-0060, D-0061, design/mandatory-control-plane.md#5
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { lookupSuiteReceipt, stageSuiteWorkspace, suiteStore } from "../scripts/suite-green.mjs";
import { verifyProvenance } from "../scripts/lib/provenance.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = join(REPO_ROOT, "scripts");
const CALL_CLI = join(SCRIPTS, "call.mjs");
const GUARD_CLI = join(SCRIPTS, "lead-guard.mjs");
const PUSH_CLI = join(SCRIPTS, "gated-push.mjs");
const DISPATCH_CLI = join(SCRIPTS, "dispatch.mjs");
const PLAN_CLI = join(SCRIPTS, "plan.mjs");
const SUITE_CLI = join(SCRIPTS, "suite-green.mjs");
const LOOP_CLI = join(SCRIPTS, "loop.mjs");
const RECORDS_CHECK_CLI = join(SCRIPTS, "records-check.mjs");
const SELF_LOOP_CLI = join(SCRIPTS, "self-loop.mjs");
const WINDOW_CLI = join(SCRIPTS, "window.mjs");

const BRIEFS = {
  shared: "engines/shared.md",
  critic: "engines/critic.md",
  actor: "engines/actor.md",
  judge: "engines/judge.md",
  reviewer: "engines/frame-reviewer.md",
};

function makeDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of [
    "NODE_OPTIONS", "SELF_LOOP_OWNER_STORE", "SELF_LOOP_CONFIG", "NODE_TEST_CONTEXT",
    "GEMINI_HOME", "ANTIGRAVITY_APP_DATA_DIR", "T3CODE_HOME", "ANTIGRAVITY_LS_VERSION",
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "T3CODE_THREAD_ID",
  ]) delete env[k];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "MCP-Critic",
    GIT_AUTHOR_EMAIL: "critic@example.invalid",
    GIT_COMMITTER_NAME: "MCP-Critic",
    GIT_COMMITTER_EMAIL: "critic@example.invalid",
    SELF_LOOP_ADAPTERS: "none",
    LC_ALL: "C",
    TZ: "UTC",
    ...extra,
  };
}

function git(repo, env, ...args) {
  return execFileSync("git", ["-C", repo, "--no-replace-objects", ...args], { encoding: "utf8", env }).trim();
}

function commitAll(repo, env, msg) {
  git(repo, env, "add", "-A");
  git(repo, env, "commit", "-qm", msg);
  return git(repo, env, "rev-parse", "HEAD");
}

function initRepo(t, env, files, prefix) {
  const dir = makeDir(t, prefix);
  git(dir, env, "init", "-q", "-b", "main");
  for (const [k, v] of Object.entries(files)) put(dir, k, v);
  commitAll(dir, env, "init");
  return dir;
}

function runNode(script, args, env, { cwd = REPO_ROOT, input = undefined } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
}

function planText(id, packages, { scope = "v1/mcp", phase = "v1", supersedes = null } = {}) {
  return [
    `# ${id} Plan`,
    `scope: ${scope}`,
    `phase: ${phase}`,
    ...(supersedes ? [`supersedes: ${supersedes}`] : []),
    "",
    ...packages.flatMap(p => [
      `## ${p.id}`,
      `role: ${p.role}`,
      `handoff: ${p.handoff}`,
      `authority: ${p.authority ?? "D-0060"}`,
      `goal: ${p.goal ?? p.id}`,
      `files: ${(p.files ?? []).join(", ")}`,
      `interface: ${p.interface ?? "design/mcp.md#1"}`,
      `acceptance: ${p.acceptance ?? "node --test acceptance/smoke.test.mjs"}`,
      `needs: ${(p.needs ?? []).join(", ")}`,
      ...(p.reviews ? [`reviews: ${p.reviews.join(", ")}`] : []),
      "",
    ]),
  ].join("\n");
}

function setupWorld(t, opts = {}) {
  const root = makeDir(t, "mcp-world-");
  const home = join(root, "home");
  const codexHome = join(home, ".codex");
  const claudeDir = join(home, ".claude");
  const loadDir = join(root, "load");
  const workDir = join(root, "work");
  const storeDir = join(root, "owner-store");
  const bare = join(root, "origin.git");
  for (const d of [home, codexHome, claudeDir, loadDir, workDir, storeDir, bare]) mkdirSync(d, { recursive: true });

  const env = cleanEnv({
    HOME: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeDir,
    SELF_LOOP_LOAD_DIR: loadDir,
    SELF_LOOP_OWNER_STORE: storeDir,
  });

  git(bare, env, "init", "-q", "--bare");

  const productFiles = {
    "VERSION": "0.9.0\n",
    "README.md": "# MCP Product\n",
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": "export const b = 2;\n",
    "acceptance/smoke.test.mjs": 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("smoke", () => { assert.equal(1, 1); });\n',
    ...(opts.productFiles ?? {}),
  };
  const product = initRepo(t, env, productFiles, "mcp-product-");
  if (opts.withHooks) {
    cpSync(SCRIPTS, join(product, "scripts"), { recursive: true, filter: p => p !== join(SCRIPTS, "test") });
    cpSync(join(REPO_ROOT, ".githooks"), join(product, ".githooks"), { recursive: true });
    chmodSync(join(product, ".githooks", "pre-push"), 0o755);
    chmodSync(join(product, ".githooks", "pre-commit"), 0o755);
    commitAll(product, env, "install hooks and scripts");
  }
  const baseline = git(product, env, "rev-parse", "HEAD");
  git(product, env, "remote", "add", "origin", bare);
  git(product, env, "branch", "-f", "loop/v1", baseline);
  git(product, env, "checkout", "-q", "loop/v1");

  const t3Codex = { runner: "t3", provider: "codex", model: "gpt-5.4" };
  const t3Claude = { runner: "t3", provider: "claude", model: "claude-haiku-5-5" };
  const t3Reviewer = { runner: "t3", provider: "claude", model: "claude-sonnet-4-6" };
  const agents = opts.agents ?? { critic: t3Codex, actor: t3Codex, judge: t3Claude, reviewer: t3Reviewer };

  const records = initRepo(t, env, {
    "README.md": "# MCP Records\n",
    "records.json": "{}\n",
    "purpose/P-0001.md": "# P-0001 Control Plane\n\nstatus: active\n",
    "decisions/D-0060.md": "# D-0060 Owner Decision\n\nid: D-0060\nby: owner\nstatus: active\n",
    "decisions/D-0099.md": "# D-0099 Unbacked Lead Decision\n\nid: D-0099\nby: lead\nstatus: active\n",
    "design/mcp.md": "# MCP Design\n\n## 1\nContract.\n",
    "blueprint/F-0004.md": "# F-0004 Provenance\n\nid: F-0004\nphase: v1\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": JSON.stringify({ feature: "F-0004", phase: "v1", status: "building", time: "2026-11-24T00:00:00Z", by: "lead", note: "start", evidence: {} }) + "\n",
    "metrics/handoffs.jsonl": JSON.stringify({
      id: "R-0001-reviewer-frame", time: "2026-11-24T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer",
      attempt: 1, agent: { runner: "t3:claude", observedModel: "claude-sonnet-4-6", observedModels: ["claude-sonnet-4-6"] },
      view: "f".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"],
    }) + "\n",
    "metrics/trajectory.jsonl": "",
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nFrame.\n",
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief.\n`])),
    ...(opts.recordFiles ?? {}),
  }, "mcp-records-");

  const loopConfig = {
    product,
    records,
    workDir,
    phase: "v1",
    branch: "loop/v1",
    briefs: BRIEFS,
    agents,
    owns: opts.owns ?? { actor: ["src"], critic: ["acceptance"] },
    protected: ["main"],
    gates: { remote: "origin", require: [], suite: opts.suite ?? "node --test acceptance/smoke.test.mjs", format: "node-test" },
    provenanceBaseline: baseline,
    ...(opts.cadence ? { cadence: opts.cadence } : {}),
    ...(opts.extraLoop ?? {}),
  };
  put(records, "loop.json", JSON.stringify(loopConfig, null, 2) + "\n");
  runNode(RECORDS_CHECK_CLI, ["--repo", records, "--write"], env);
  commitAll(records, env, "commit loop.json and index");

  put(storeDir, "README.md", "# Store\n");
  put(storeDir, "products.json", JSON.stringify({
    roots: [root],
    products: [{ name: "mcp", records }],
    maxLoadRatio: 1e9,
    minAvailableMemoryGB: 0,
  }, null, 2) + "\n");
  git(storeDir, env, "init", "-q", "-b", "main");
  commitAll(storeDir, env, "register product");

  const configPath = join(records, "loop.json");
  return { root, env, product, records, bare, workDir, storeDir, codexHome, claudeDir, baseline, configPath, loopConfig };
}

function writeCodexTranscript(codexHome, ws, sid, prompt, cwd, commands = []) {
  const { preparedAt } = JSON.parse(readFileSync(join(ws, "call.json"), "utf8"));
  const now = new Date(preparedAt + 1000);
  const dir = join(codexHome, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString();
  const file = join(dir, `rollout-${sid}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(file, [
    { timestamp: ts, type: "session_meta", payload: { cwd, id: sid } },
    { timestamp: ts, type: "turn_context", payload: { cwd, model: "gpt-5.4" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    ...commands.map(c => ({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/sh", "-c", c], cwd: `file://${cwd}`, exit_code: 0 } } })),
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const sec = Math.ceil((preparedAt + 1000) / 1000);
  utimesSync(file, sec, sec);
  return file;
}

function writeClaudeTranscript(claudeDir, ws, sid, prompt, cwd, model = "claude-haiku-5-5") {
  const { preparedAt } = JSON.parse(readFileSync(join(ws, "call.json"), "utf8"));
  const ts = new Date(preparedAt + 1000).toISOString();
  const dir = join(claudeDir, "projects", "mcp-project");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, [
    { type: "user", sessionId: sid, cwd, timestamp: ts, message: { role: "user", content: prompt } },
    { type: "assistant", sessionId: sid, timestamp: ts, message: { role: "assistant", model, stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
    { type: "result", subtype: "success", sessionId: sid, is_error: false, timestamp: ts },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const sec = Math.ceil((preparedAt + 1000) / 1000);
  utimesSync(file, sec, sec);
  return file;
}

function writeTask(w, name, features = "F-0004") {
  return put(w.workDir, `tasks/${name}.md`, `features: ${features}\n\n# ${name}\n\nDo ${name}.\n`);
}

function commitPlan(w, id, packages, opts = {}) {
  put(w.records, `plans/${id}.md`, planText(id, packages, opts));
  runNode(RECORDS_CHECK_CLI, ["--repo", w.records, "--write"], w.env);
  return commitAll(w.records, w.env, `commit ${id}`);
}

function guardCheck(w, tool, args, harness = "antigravity") {
  const payload = harness === "antigravity"
    ? { hookEventName: "PreToolUse", conversationId: "lead-conv", cwd: w.product, toolCall: { name: tool, args } }
    : { hookEventName: "PreToolUse", cwd: w.product, tool_name: tool, tool_input: args };
  const argv = [...(harness === "antigravity" ? ["--harness", "antigravity"] : []), "--product", w.product, "--workspaces", w.workDir, "--records", w.records];
  const r = runNode(GUARD_CLI, argv, w.env, { input: JSON.stringify(payload) });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test("MCP-01 (D-0060): lead-guard denies nonce-less delegation, workspace writes outside tasks/, hook bypasses, and --base unattested commit laundering; loss: false-verdict/wrong-result", t => {
  const w = setupWorld(t);
  commitPlan(w, "PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", files: ["src/a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", files: ["acceptance/smoke.test.mjs"], needs: ["actor-a"] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", files: [], needs: ["critic-a"] },
  ]);

  for (const [tool, args] of [
    ["delegate_task", { task: "Edit src/a.mjs directly" }],
    ["mcp_t3-code_delegate_task", { task: "Edit src/a.mjs directly" }],
    ["invoke_subagent", { TypeName: "self", Role: "Actor", Prompt: "Edit src/a.mjs" }],
    ["t3_thread_launch", { title: "actor-a", message: "Edit src/a.mjs" }],
    ["mcp_t3-code_t3_thread_launch", { title: "actor-a", message: "Edit src/a.mjs" }],
  ]) {
    const out = guardCheck(w, tool, args, "antigravity");
    assert.equal(out?.decision, "deny", `${tool} must deny without nonce`);
    assert.match(out.reason, /16-hex call\.json nonce/);
  }
  const claudeDeny = guardCheck(w, "Agent", { description: "actor", prompt: "fake nonce deadbeefcafebabe" }, "claude");
  assert.equal(claudeDeny?.hookSpecificOutput?.permissionDecision, "deny");

  const taskFile = writeTask(w, "R-0002-actor-a");
  const prep = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "2", "--step", "actor-a",
    "--plan", "PL-0001", "--package", "actor-a", "--task", taskFile, "--prepare",
  ], w.env);
  assert.equal(prep.status, 0, prep.stderr);
  const prepared = JSON.parse(prep.stdout);

  for (const [tool, args] of [
    ["delegate_task", { task: prepared.prompt }],
    ["invoke_subagent", { TypeName: "self", Role: "Actor", Prompt: prepared.prompt }],
    ["t3_thread_launch", { title: "actor-a", message: prepared.prompt }],
  ]) {
    assert.equal(guardCheck(w, tool, args, "antigravity"), null, `${tool} with live nonce must pass`);
  }

  const writeTasksOk = guardCheck(w, "write_file", { Path: join(w.workDir, "tasks", "R-0002-actor-a.md"), Content: "ok" }, "antigravity");
  assert.equal(writeTasksOk, null);
  for (const badPath of [join(prepared.wt, "src", "x.js"), join(prepared.ws, "call.json"), join(prepared.ws, "out", "report.md")]) {
    const denyWrite = guardCheck(w, "write_file", { Path: badPath, Content: "hack" }, "antigravity");
    assert.equal(denyWrite?.decision, "deny", `must deny write to ${badPath}`);
    assert.match(denyWrite.reason, /tasks/);
  }

  for (const cmd of [
    "git push --no-verify origin loop/v1",
    "git push -n origin loop/v1",
    "git -c core.hooksPath=/dev/null push origin loop/v1",
  ]) {
    const denyPush = guardCheck(w, "run_command", { CommandLine: cmd }, "antigravity");
    assert.equal(denyPush?.decision, "deny", `must deny ${cmd}`);
    assert.match(denyPush.reason, /gated-push\.mjs/);
  }

  put(w.product, "src/laundered.mjs", "export const laundered = true;\n");
  const unattested = commitAll(w.product, w.env, "manual commit outside call.mjs");
  const launder = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "3", "--step", "actor-a",
    "--plan", "PL-0001", "--package", "actor-a", "--base", unattested, "--task", taskFile, "--prepare",
  ], w.env);
  assert.equal(launder.status, 7, launder.stderr);
  assert.match(launder.stderr, /provenance verification/);
  assert.match(launder.stderr, /unattested commit/);

  const cancel = runNode(CALL_CLI, [w.configPath, "cancel", "--ws", prepared.ws, "--reason", "cleanup"], w.env);
  assert.equal(cancel.status, 0, cancel.stderr);
  const replayNonce = guardCheck(w, "delegate_task", { task: prepared.prompt }, "antigravity");
  assert.equal(replayNonce?.decision, "deny");
});

test("MCP-02 (D-0060): call.mjs enforces mandatory --plan/--package on actor, critic, and code judge while exempting reviewer, judge-frame*, and judge-comments*; loss: false-verdict/stuck", t => {
  const w = setupWorld(t);
  const taskFile = writeTask(w, "unplanned");

  for (const [role, step] of [
    ["actor", "actor"],
    ["critic", "critic"],
    ["judge", "judge"],
    ["judge", "judge-final"],
  ]) {
    const refused = runNode(CALL_CLI, [
      w.configPath, role, "--round", "2", "--step", step, "--task", taskFile, "--dry-run",
    ], w.env);
    assert.equal(refused.status, 7, `${role} (${step}): ${refused.stderr}`);
    assert.match(refused.stderr, /requires --plan PL-NNNN --package <id>/);
  }

  const revTask = writeTask(w, "rev-exempt", "none");
  for (const [role, step, tFile] of [
    ["reviewer", "reviewer-architecture", revTask],
    ["reviewer", "reviewer-distill", revTask],
    ["judge", "judge-frame", taskFile],
    ["judge", "judge-comments", taskFile],
    ["judge", "judge-comments-prepush", taskFile],
  ]) {
    const ok = runNode(CALL_CLI, [
      w.configPath, role, "--round", "2", "--step", step, "--task", tFile, "--dry-run",
    ], w.env);
    assert.equal(ok.status, 0, `${role} (${step}) must remain exempt: ${ok.stderr}`);
  }
});

test("MCP-03 (D-0060/D-0061): gated-push and .githooks/pre-push enforce working-branch provenance, allow ci/<handoff-id> pre-judge probes, and auto-resolve cached suite receipts; loss: false-verdict/wrong-result", t => {
  const w = setupWorld(t, { withHooks: true });
  commitPlan(w, "PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", files: ["src/a.mjs"] },
    { id: "actor-b", role: "actor", handoff: "R-0002-actor-b", files: ["src/b.mjs"] },
    { id: "critic-all", role: "critic", handoff: "R-0002-critic", files: ["acceptance/wave.test.mjs"], needs: ["actor-a", "actor-b"], reviews: ["actor-a", "actor-b"] },
    { id: "judge-same", role: "judge", handoff: "R-0002-judge", files: [], needs: ["critic-all"] },
  ]);

  put(w.product, "src/sneaky.mjs", "export const sneaky = 1;\n");
  const unattested = commitAll(w.product, w.env, "unattested manual commit");
  const suiteUnattested = runNode(SUITE_CLI, ["--repo", w.product, "--sha", unattested, "--command", "node --test acceptance/smoke.test.mjs"], w.env);
  assert.equal(suiteUnattested.status, 0, suiteUnattested.stderr);

  const pushUnattested = runNode(PUSH_CLI, ["--repo", w.product, "--branch", "loop/v1", "--sha", unattested], w.env);
  assert.equal(pushUnattested.status, 2);
  assert.match(pushUnattested.stderr, /unattested commit/);

  const verifyUnattested = runNode(PUSH_CLI, ["--verify-only", "--repo", w.product, "--branch", "loop/v1", "--sha", unattested], w.env);
  assert.equal(verifyUnattested.status, 2);

  git(w.product, w.env, "reset", "--hard", w.baseline);

  const prepWave = runNode(DISPATCH_CLI, ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--wave", "0", "--json"], w.env);
  assert.equal(prepWave.status, 0, prepWave.stderr);
  const wave0 = JSON.parse(prepWave.stdout);
  assert.equal(wave0.prepared.length, 2);

  for (const p of wave0.prepared) {
    const file = p.id === "actor-a" ? "src/a.mjs" : "src/b.mjs";
    put(p.wt, file, `export const ${p.id === "actor-a" ? "a" : "b"} = 42;\n`);
    put(p.ws, "out/report.md", `# ${p.handoff}\n\nUpdated ${file}.\n`);
    writeCodexTranscript(w.codexHome, p.ws, `sess-${p.id}`, p.prompt, p.wt);
  }

  const recWave = runNode(DISPATCH_CLI, ["record", "--config", w.configPath, "--plan", "PL-0001", "--wave", "0", "--integrate", "--json"], w.env);
  assert.equal(recWave.status, 0, recWave.stderr);
  const rec0 = JSON.parse(recWave.stdout);
  assert.equal(rec0.recorded.length, 2);
  const mergedSha = rec0.integration.commit;

  const loopNoCritic = runNode(PUSH_CLI, ["--verify-only", "--repo", w.product, "--branch", "loop/v1", "--sha", mergedSha], w.env);
  assert.equal(loopNoCritic.status, 2);
  assert.match(loopNoCritic.stderr, /missing covering critic/);

  const ciNoCritic = runNode(PUSH_CLI, ["--verify-only", "--repo", w.product, "--branch", "ci/R-0002-actor-a", "--sha", mergedSha], w.env);
  assert.equal(ciNoCritic.status, 2);
  assert.match(ciNoCritic.stderr, /missing covering critic/);

  const prepCritic = runNode(DISPATCH_CLI, ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--wave", "1", "--base", mergedSha, "--json"], w.env);
  assert.equal(prepCritic.status, 0, prepCritic.stderr);
  const criticPrep = JSON.parse(prepCritic.stdout).prepared[0];
  put(criticPrep.wt, "acceptance/wave.test.mjs", 'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("wave", () => { assert.equal(1, 1); });\n');
  put(criticPrep.ws, "out/report.md", "# R-0002-critic\n\nAll green.\n");
  writeCodexTranscript(w.codexHome, criticPrep.ws, "sess-critic", criticPrep.prompt, criticPrep.wt);
  const recCritic = runNode(CALL_CLI, [w.configPath, "record", "--ws", criticPrep.ws], w.env);
  assert.equal(recCritic.status, 0, recCritic.stderr);
  const criticSha = JSON.parse(recCritic.stdout).product.commit;

  const missingReceipt = runNode(PUSH_CLI, ["--repo", w.product, "--branch", "ci/R-0002-critic", "--sha", criticSha], w.env);
  assert.equal(missingReceipt.status, 2);
  assert.match(missingReceipt.stderr, /no verified cached green suite receipt/);

  const runSuite = runNode(SUITE_CLI, ["--repo", w.product, "--sha", criticSha, "--command", "node --test acceptance/smoke.test.mjs"], w.env);
  assert.equal(runSuite.status, 0, runSuite.stderr);

  const ciAllowed = runNode(PUSH_CLI, ["--repo", w.product, "--branch", "ci/R-0002-critic", "--sha", criticSha], w.env);
  assert.equal(ciAllowed.status, 0, ciAllowed.stderr);
  assert.equal(git(w.bare, w.env, "rev-parse", "refs/heads/ci/R-0002-critic"), criticSha);

  const loopNoJudge = runNode(PUSH_CLI, ["--repo", w.product, "--branch", "loop/v1", "--sha", criticSha], w.env);
  assert.equal(loopNoJudge.status, 2);
  assert.match(loopNoJudge.stderr, /missing cross-vendor judge/);

  const sameVendorCfg = join(w.root, "same-vendor-loop.json");
  writeFileSync(sameVendorCfg, JSON.stringify({ ...w.loopConfig, agents: { ...w.loopConfig.agents, judge: w.loopConfig.agents.actor } }, null, 2));
  const prepSameJudge = runNode(CALL_CLI, [
    sameVendorCfg, "judge", "--round", "2", "--plan", "PL-0001", "--package", "judge-same",
    "--base", criticSha, "--task", writeTask(w, "R-0002-judge"), "--prepare",
  ], w.env);
  assert.equal(prepSameJudge.status, 0, prepSameJudge.stderr);
  const sameJ = JSON.parse(prepSameJudge.stdout);
  put(sameJ.ws, "out/report.md", "VERDICT: CONVERGED\nACCEPTANCE: pass\n");
  put(sameJ.ws, "out/public.md", "Same vendor.\n");
  writeCodexTranscript(w.codexHome, sameJ.ws, "sess-judge-same", sameJ.prompt, sameJ.wt);
  const recSameJ = runNode(CALL_CLI, [sameVendorCfg, "record", "--ws", sameJ.ws], w.env);
  assert.equal(recSameJ.status, 0, recSameJ.stderr);

  const loopSameVendor = runNode(PUSH_CLI, ["--repo", w.product, "--branch", "loop/v1", "--sha", criticSha], w.env);
  assert.equal(loopSameVendor.status, 2);
  assert.match(loopSameVendor.stderr, /same-vendor judge/);

  commitPlan(w, "PL-0002", [
    { id: "judge-cross", role: "judge", handoff: "R-0003-judge", files: [] },
  ], { supersedes: "PL-0001" });
  const prepCrossJudge = runNode(CALL_CLI, [
    w.configPath, "judge", "--round", "3", "--plan", "PL-0002", "--package", "judge-cross",
    "--base", criticSha, "--task", writeTask(w, "R-0003-judge"), "--prepare",
  ], w.env);
  assert.equal(prepCrossJudge.status, 0, prepCrossJudge.stderr);
  const crossJ = JSON.parse(prepCrossJudge.stdout);
  put(crossJ.ws, "out/report.md", "VERDICT: CONVERGED\nACCEPTANCE: pass\n");
  put(crossJ.ws, "out/public.md", "Cross vendor pass.\n");
  writeClaudeTranscript(w.claudeDir, crossJ.ws, "sess-judge-cross", crossJ.prompt, crossJ.wt);
  const recCrossJ = runNode(CALL_CLI, [w.configPath, "record", "--ws", crossJ.ws], w.env);
  assert.equal(recCrossJ.status, 0, recCrossJ.stderr);

  const loopPass = runNode(PUSH_CLI, ["--repo", w.product, "--branch", "loop/v1", "--sha", criticSha], w.env);
  assert.equal(loopPass.status, 0, loopPass.stderr);
  assert.equal(git(w.bare, w.env, "rev-parse", "refs/heads/loop/v1"), criticSha);

  git(w.product, w.env, "checkout", "-q", criticSha);
  put(w.product, "VERSION", "0.9.1\n");
  put(w.product, "src/hook-bypass.mjs", "export const bypass = 1;\n");
  const hookUnattested = commitAll(w.product, w.env, "unattested commit with version bump");
  git(w.product, w.env, "tag", "-a", "v0.9.1", hookUnattested, "-m", "v0.9.1");
  git(w.product, w.env, "config", "core.hooksPath", ".githooks");
  const directPush = spawnSync("git", ["-C", w.product, "push", "origin", `${hookUnattested}:refs/heads/loop/v1`, "refs/tags/v0.9.1"], { env: w.env, encoding: "utf8" });
  assert.notEqual(directPush.status, 0);
  assert.match(directPush.stderr, /unattested commit/);
});

test("MCP-04 (D-0060): open substantive owner word blocks actor/critic/plan.mjs at 0-turn grace while routine confirmation passes and unbacked by:lead plan authority fails; loss: false-verdict/wrong-result", t => {
  const w = setupWorld(t);
  commitPlan(w, "PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", files: ["src/a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", files: ["acceptance/smoke.test.mjs"], needs: ["actor-a"] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", files: [], needs: ["critic-a"] },
  ]);

  put(w.records, "owner/words.jsonl", JSON.stringify({
    id: "W-aaaa111111", time: "2026-11-24T00:05:00Z", source: "claude", session: "s0", text: "ok", sha256: "1".repeat(64),
  }) + "\n");
  commitAll(w.records, w.env, "routine confirmation word");

  assert.equal(runNode(PLAN_CLI, ["validate", join(w.records, "plans", "PL-0001.md"), "--records", w.records], w.env).status, 0);
  const actorTask = writeTask(w, "R-0002-actor-a");
  assert.equal(runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "2", "--step", "actor-a", "--plan", "PL-0001", "--package", "actor-a", "--task", actorTask, "--dry-run",
  ], w.env).status, 0);

  put(w.records, "owner/words.jsonl", [
    { id: "W-aaaa111111", time: "2026-11-24T00:05:00Z", source: "claude", session: "s0", text: "ok", sha256: "1".repeat(64) },
    { id: "W-bbbb222222", time: "2026-11-24T00:06:00Z", source: "claude", session: "s0", text: "Every push must enforce commit-graph provenance", sha256: "2".repeat(64) },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  commitAll(w.records, w.env, "substantive owner word");

  const planBlocked = runNode(PLAN_CLI, ["validate", join(w.records, "plans", "PL-0001.md"), "--records", w.records], w.env);
  assert.equal(planBlocked.status, 1);
  assert.match(planBlocked.stderr, /W-bbbb222222/);

  for (const [role, step, pkg] of [["actor", "actor-a", "actor-a"], ["critic", "critic-a", "critic-a"]]) {
    const res = runNode(CALL_CLI, [
      w.configPath, role, "--round", "2", "--step", step, "--plan", "PL-0001", "--package", pkg, "--task", actorTask, "--dry-run",
    ], w.env);
    assert.equal(res.status, 7, `${role} must fail with 0-turn grace`);
    assert.match(res.stderr, /0-turn grace/);
    assert.match(res.stderr, /W-bbbb222222/);
  }

  const distillOk = runNode(CALL_CLI, [
    w.configPath, "reviewer", "--round", "2", "--step", "reviewer-distill", "--task", writeTask(w, "distill", "none"), "--dry-run",
  ], w.env);
  assert.equal(distillOk.status, 0, distillOk.stderr);

  put(w.records, "decisions/D-0061.md", "# D-0061 Distilled\n\nid: D-0061\nby: owner\nstatus: active\n\nCites W-bbbb222222.\n");
  runNode(RECORDS_CHECK_CLI, ["--repo", w.records, "--write"], w.env);
  commitAll(w.records, w.env, "distill owner word");

  assert.equal(runNode(PLAN_CLI, ["validate", join(w.records, "plans", "PL-0001.md"), "--records", w.records], w.env).status, 0);

  const badAuthFile = put(w.workDir, "PL-0099.md", planText("PL-0099", [
    { id: "actor-bad", role: "actor", handoff: "R-0003-actor", files: ["src/a.mjs"], authority: "D-0099" },
    { id: "critic-bad", role: "critic", handoff: "R-0003-critic", files: ["acceptance/smoke.test.mjs"], needs: ["actor-bad"] },
    { id: "judge-bad", role: "judge", handoff: "R-0003-judge", files: [], needs: ["critic-bad"] },
  ], { scope: "v1/bad-auth" }));
  const badPlanVal = runNode(PLAN_CLI, ["validate", badAuthFile, "--records", w.records], w.env);
  assert.equal(badPlanVal.status, 1);
  assert.match(badPlanVal.stderr, /D-0099 lacks owner or generation-engine authority/);

  commitPlan(w, "PL-0099", [
    { id: "actor-bad", role: "actor", handoff: "R-0003-actor", files: ["src/a.mjs"], authority: "D-0099" },
    { id: "critic-bad", role: "critic", handoff: "R-0003-critic", files: ["acceptance/smoke.test.mjs"], needs: ["actor-bad"] },
    { id: "judge-bad", role: "judge", handoff: "R-0003-judge", files: [], needs: ["critic-bad"] },
  ], { scope: "v1/bad-auth" });
  const badActor = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "3", "--plan", "PL-0099", "--package", "actor-bad", "--task", actorTask, "--dry-run",
  ], w.env);
  assert.equal(badActor.status, 7);
  assert.match(badActor.stderr, /D-0099 lacks owner or generation-engine authority/);
});

test("MCP-05 (D-0060): call.mjs cancel cleans wt and frees overlap, record --ws auto-discovers session by nonce, and prior-round zombie workspaces expire; loss: stuck/data", t => {
  const w = setupWorld(t);
  commitPlan(w, "PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", files: ["src/a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0002-critic", files: ["acceptance/smoke.test.mjs"], needs: ["actor-a"] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", files: [], needs: ["critic-a"] },
  ]);
  commitPlan(w, "PL-0002", [
    { id: "actor-retry", role: "actor", handoff: "R-0003-actor-a", files: ["src/a.mjs"] },
    { id: "critic-r", role: "critic", handoff: "R-0003-critic", files: ["acceptance/smoke.test.mjs"], needs: ["actor-retry"] },
    { id: "judge-r", role: "judge", handoff: "R-0003-judge", files: [], needs: ["critic-r"] },
  ], { scope: "v1/retry" });

  const prep1 = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "2", "--step", "actor-a",
    "--plan", "PL-0001", "--package", "actor-a", "--task", writeTask(w, "R-0002-actor-a"), "--prepare",
  ], w.env);
  assert.equal(prep1.status, 0, prep1.stderr);
  const p1 = JSON.parse(prep1.stdout);
  assert.equal(existsSync(p1.wt), true);

  const g3Blocked = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "3", "--step", "actor-a",
    "--plan", "PL-0002", "--package", "actor-retry", "--task", writeTask(w, "R-0003-actor-a"), "--prepare",
  ], w.env);
  assert.equal(g3Blocked.status, 7);
  assert.match(g3Blocked.stderr, /G3 live writer overlap/);

  const cancelled = runNode(CALL_CLI, [w.configPath, "cancel", "--ws", p1.ws, "--reason", "aborted"], w.env);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).cancelled, true);
  assert.equal(existsSync(p1.wt), false);
  assert.equal(JSON.parse(readFileSync(join(p1.ws, "call.json"), "utf8")).cancelled, true);
  assert.equal(guardCheck(w, "delegate_task", { task: p1.prompt })?.decision, "deny");

  const recCancelled = runNode(CALL_CLI, [w.configPath, "record", "--ws", p1.ws], w.env);
  assert.equal(recCancelled.status, 7);
  assert.match(recCancelled.stderr, /was cancelled/);

  const prep2 = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "3", "--step", "actor-a",
    "--plan", "PL-0002", "--package", "actor-retry", "--task", writeTask(w, "R-0003-actor-a"), "--prepare",
  ], w.env);
  assert.equal(prep2.status, 0, prep2.stderr);
  const p2 = JSON.parse(prep2.stdout);
  put(p2.wt, "src/a.mjs", "export const a = 99;\n");
  put(p2.ws, "out/report.md", "# R-0003-actor-a\n\nAuto session.\n");
  writeCodexTranscript(w.codexHome, p2.ws, "codex-nonce-auto-01", p2.prompt, p2.wt);

  const recAuto = runNode(CALL_CLI, [w.configPath, "record", "--ws", p2.ws], w.env);
  assert.equal(recAuto.status, 0, recAuto.stderr);
  const h2 = JSON.parse(recAuto.stdout);
  assert.equal(h2.agent.session, "codex-nonce-auto-01");
  assert.equal(JSON.parse(readFileSync(join(p2.ws, "call.json"), "utf8")).recorded, true);

  commitPlan(w, "PL-0003", [
    { id: "actor-z", role: "actor", handoff: "R-0004-actor-z", files: ["src/b.mjs"] },
    { id: "critic-z", role: "critic", handoff: "R-0006-critic", files: ["acceptance/smoke.test.mjs"], needs: ["actor-z"] },
    { id: "judge-z", role: "judge", handoff: "R-0006-judge", files: [], needs: ["critic-z"] },
  ], { scope: "v1/zombie" });
  const prepZombie = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "4", "--step", "actor-z",
    "--plan", "PL-0003", "--package", "actor-z", "--task", writeTask(w, "R-0004-actor-z"), "--prepare",
  ], w.env);
  assert.equal(prepZombie.status, 0, prepZombie.stderr);
  const z = JSON.parse(prepZombie.stdout);

  const nextBefore = runNode(LOOP_CLI, ["next", "--config", w.configPath], w.env);
  assert.equal(nextBefore.status, 0, nextBefore.stderr);
  assert.match(nextBefore.stdout, new RegExp(z.ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  put(w.records, "rounds/0005-reviewer-frame.md", "# R-0005-reviewer-frame\n");
  const prevH = readFileSync(join(w.records, "metrics/handoffs.jsonl"), "utf8");
  put(w.records, "metrics/handoffs.jsonl", prevH + JSON.stringify({
    id: "R-0005-reviewer-frame", time: "2026-11-24T10:00:00Z", phase: "v1", round: 5, step: "reviewer-frame", role: "reviewer",
    record: "rounds/0005-reviewer-frame.md", files: ["rounds/0005-reviewer-frame.md"], view: "f".repeat(40), attempt: 1,
    agent: { runner: "claude" }, product: null, audit: { violations: 0 },
  }) + "\n");
  runNode(RECORDS_CHECK_CLI, ["--repo", w.records, "--write"], w.env);
  commitAll(w.records, w.env, "advance phase round to 5");

  const nextAfter = runNode(LOOP_CLI, ["next", "--config", w.configPath], w.env);
  assert.equal(nextAfter.status, 0, nextAfter.stderr);
  assert.doesNotMatch(nextAfter.stdout, new RegExp(z.ws.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("MCP-06 (D-0061): pre-judge ensure fails fast on red suite, reuses host receipt once-per-tree, and purgeTreeReceipts defeats actor cache pre-poisoning; loss: false-verdict/stuck", t => {
  const counterDir = makeDir(t, "mcp06-counter-");
  const counterFile = join(counterDir, "runs.log");
  const suiteBody = ok => [
    'import assert from "node:assert/strict";',
    'import { appendFileSync } from "node:fs";',
    'import test from "node:test";',
    `test("counted", () => { appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); assert.equal(${ok ? "1, 1" : "1, 2"}); });`,
    "",
  ].join("\n");
  const countRuns = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);

  const w = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": suiteBody(false) },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w, "PL-0001", [
    { id: "judge-red", role: "judge", handoff: "R-0002-judge", files: [] },
  ], { scope: "v1/red" });

  const redJudge = runNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--plan", "PL-0001", "--package", "judge-red",
    "--base", w.baseline, "--task", writeTask(w, "R-0002-judge"), "--prepare",
  ], w.env);
  assert.equal(redJudge.status, 2, redJudge.stderr);
  assert.match(redJudge.stderr, /pre-judge suite gate failed/);
  assert.equal(countRuns(), 1);

  const w2 = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": suiteBody(true) },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w2, "PL-0001", [
    { id: "judge-g1", role: "judge", handoff: "R-0002-judge", files: [] },
    { id: "judge-g2", role: "judge", handoff: "R-0003-judge", files: [] },
  ], { scope: "v1/green" });

  const g1 = runNode(CALL_CLI, [
    w2.configPath, "judge", "--round", "2", "--plan", "PL-0001", "--package", "judge-g1",
    "--base", w2.baseline, "--task", writeTask(w2, "R-0002-judge"), "--prepare",
  ], w2.env);
  assert.equal(g1.status, 0, g1.stderr);
  const pG1 = JSON.parse(g1.stdout);
  const staged = join(pG1.ws, "suite-receipt.json");
  assert.equal(existsSync(staged), true);
  assert.equal(statSync(staged).mode & 0o222, 0);
  const expectedTree = git(w2.product, w2.env, "rev-parse", `${w2.baseline}^{tree}`);
  assert.equal(JSON.parse(readFileSync(staged, "utf8")).tree, expectedTree);
  assert.match(pG1.prompt, /do NOT re-run `node --test acceptance\/smoke\.test\.mjs` on unchanged wt/);
  assert.equal(countRuns(), 2);

  const g2 = runNode(CALL_CLI, [
    w2.configPath, "judge", "--round", "3", "--plan", "PL-0001", "--package", "judge-g2",
    "--base", w2.baseline, "--task", writeTask(w2, "R-0003-judge"), "--prepare",
  ], w2.env);
  assert.equal(g2.status, 0, g2.stderr);
  assert.equal(countRuns(), 2);

  commitPlan(w2, "PL-0002", [
    { id: "actor-poison", role: "actor", handoff: "R-0004-actor", files: ["src/a.mjs"] },
    { id: "critic-poison", role: "critic", handoff: "R-0004-critic", files: ["acceptance/p.test.mjs"], needs: ["actor-poison"] },
    { id: "judge-after", role: "judge", handoff: "R-0004-judge", files: [], needs: ["critic-poison"] },
  ], { scope: "v1/green", supersedes: "PL-0001" });

  const actorPrep = runNode(CALL_CLI, [
    w2.configPath, "actor", "--round", "4", "--plan", "PL-0002", "--package", "actor-poison",
    "--base", w2.baseline, "--task", writeTask(w2, "R-0004-actor"), "--prepare",
  ], w2.env);
  assert.equal(actorPrep.status, 0, actorPrep.stderr);
  const pActor = JSON.parse(actorPrep.stdout);

  put(pActor.wt, "src/a.mjs", "export const a = 777;\n");
  git(pActor.wt, w2.env, "add", "src/a.mjs");
  const nextTree = git(pActor.wt, w2.env, "write-tree");
  git(pActor.wt, w2.env, "reset", "-q");

  const validHit = lookupSuiteReceipt({ repo: w2.product, sha: w2.baseline, command: "node --test acceptance/smoke.test.mjs" });
  const stored = JSON.parse(readFileSync(validHit.receiptPath, "utf8"));
  const forgedKey = { ...stored.key, tree: nextTree };
  const forgedHash = createHash("sha256").update(JSON.stringify([
    forgedKey.repository, forgedKey.tree, forgedKey.command, forgedKey.install ?? null, forgedKey.execution ?? null,
    [forgedKey.runtime?.node ?? null, forgedKey.runtime?.platform ?? null, forgedKey.runtime?.arch ?? null],
  ])).digest("hex");
  const forgedDir = join(suiteStore(w2.product), forgedHash);
  mkdirSync(forgedDir, { recursive: true });
  const fakeLog = "$ node --test acceptance/smoke.test.mjs\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nexit 0\n";
  writeFileSync(join(forgedDir, "999-poison.log.gz"), gzipSync(fakeLog));
  writeFileSync(join(forgedDir, "999-poison.json"), `${JSON.stringify({
    ...stored, tree: nextTree, key: forgedKey, green: true, exit: 0, reasons: [],
    log: { sha256: createHash("sha256").update(fakeLog).digest("hex"), bytes: Buffer.byteLength(fakeLog) },
  }, null, 1)}\n`);

  put(pActor.ws, "out/report.md", "# R-0004-actor\n\nModified src/a.mjs.\n");
  writeCodexTranscript(w2.codexHome, pActor.ws, "sess-actor-poison", pActor.prompt, pActor.wt);
  const recActor = runNode(CALL_CLI, [w2.configPath, "record", "--ws", pActor.ws], w2.env);
  assert.equal(recActor.status, 0, recActor.stderr);
  const actorCommit = JSON.parse(recActor.stdout).product.commit;
  assert.equal(lookupSuiteReceipt({ repo: w2.product, sha: actorCommit, command: "node --test acceptance/smoke.test.mjs" }), null);

  const critPrep = runNode(CALL_CLI, [
    w2.configPath, "critic", "--round", "4", "--plan", "PL-0002", "--package", "critic-poison",
    "--base", actorCommit, "--task", writeTask(w2, "R-0004-critic"), "--prepare",
  ], w2.env);
  assert.equal(critPrep.status, 0, critPrep.stderr);
  const pCrit = JSON.parse(critPrep.stdout);
  put(pCrit.wt, "acceptance/p.test.mjs", 'import test from "node:test";\ntest("p", () => {});\n');
  put(pCrit.ws, "out/report.md", "# R-0004-critic\n\nTested.\n");
  writeCodexTranscript(w2.codexHome, pCrit.ws, "sess-critic-poison", pCrit.prompt, pCrit.wt);
  const recCrit = runNode(CALL_CLI, [w2.configPath, "record", "--ws", pCrit.ws], w2.env);
  assert.equal(recCrit.status, 0, recCrit.stderr);
  const critCommit = JSON.parse(recCrit.stdout).product.commit;

  const afterPrep = runNode(CALL_CLI, [
    w2.configPath, "judge", "--round", "4", "--plan", "PL-0002", "--package", "judge-after",
    "--base", critCommit, "--task", writeTask(w2, "R-0004-judge"), "--prepare",
  ], w2.env);
  assert.equal(afterPrep.status, 0, afterPrep.stderr);
  assert.equal(countRuns(), 3);
});

test("MCP-07 (D-0060): delta-scoped T3 blocks only hotspot packages when arch review is active and ancestor-extinguished ci-absent clears in loop.mjs and call.mjs; loss: stuck/false-verdict", t => {
  const bigLines = (n, prefix) => Array.from({ length: n }, (_, i) => `export const ${prefix}_${i} = ${i};`).join("\n") + "\n";
  const w = setupWorld(t, {
    cadence: { deliveries: 10, outerGrace: 1 },
    agents: {
      critic: { runner: "t3", provider: "codex", model: "gpt-5.4" },
      actor: { runner: "t3", provider: "codex", model: "gpt-5.4" },
      judge: { runner: "t3", provider: "claude", model: "claude-haiku-5-5" },
      reviewer: { runner: "t3", provider: "claude", model: "claude-sonnet-4-6" },
    },
    productFiles: {
      "src/legacy-big.mjs": bigLines(840, "leg"),
      "src/hotspot.mjs": bigLines(20, "hot"),
      "src/clean.mjs": bigLines(20, "cln"),
    },
  });

  const c1 = w.baseline;
  put(w.product, "src/clean.mjs", bigLines(22, "cln"));
  const c2 = commitAll(w.product, w.env, "advance green descendant");
  put(w.records, "loop.json", JSON.stringify({ ...w.loopConfig, provenanceBaseline: c2 }, null, 2) + "\n");

  put(w.records, "metrics/trajectory.jsonl", [
    { round: 1, phase: "v1", role: "judge", area: "core", verdict: "CONTINUE", commit: c1, ci: "absent", time: "2026-11-24T01:00:00Z" },
    { round: 2, phase: "v1", role: "judge", area: "core", verdict: "CONTINUE", commit: c2, ci: "success", time: "2026-11-24T02:00:00Z" },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  commitAll(w.records, w.env, "trajectory with extinguished ci-absent and c2 baseline");

  const nextClean = runNode(LOOP_CLI, ["next", "--config", w.configPath], w.env);
  assert.equal(nextClean.status, 0, nextClean.stderr);
  assert.doesNotMatch(nextClean.stdout, /ci-absent:v1:1/);

  const prepArch = runNode(CALL_CLI, [
    w.configPath, "reviewer", "--round", "3", "--step", "reviewer-architecture", "--base", c2,
    "--task", writeTask(w, "R-0003-reviewer-architecture", "none"), "--prepare",
  ], w.env);
  assert.equal(prepArch.status, 0, prepArch.stderr);
  const pArch = JSON.parse(prepArch.stdout);
  put(pArch.ws, "out/report.md", "# R-0003-reviewer-architecture\n\nBaseline recorded.\n");
  writeClaudeTranscript(w.claudeDir, pArch.ws, "sess-arch-baseline", pArch.prompt, pArch.ws, "claude-sonnet-4-6");
  const recArch = runNode(CALL_CLI, [w.configPath, "record", "--ws", pArch.ws], w.env);
  assert.equal(recArch.status, 0, recArch.stderr);
  assert.equal(JSON.parse(recArch.stdout).files.some(f => f.endsWith("arch-facts.json")), true);

  commitPlan(w, "PL-0001", [
    { id: "actor-hot", role: "actor", handoff: "R-0004-actor-hot", files: ["src/hotspot.mjs"] },
    { id: "critic-hot", role: "critic", handoff: "R-0004-critic", files: ["acceptance/smoke.test.mjs"], needs: ["actor-hot"] },
    { id: "judge-hot", role: "judge", handoff: "R-0004-judge", files: [], needs: ["critic-hot"] },
  ]);

  const prepHotActor = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "4", "--step", "actor-hot", "--plan", "PL-0001", "--package", "actor-hot",
    "--base", c2, "--task", writeTask(w, "R-0004-actor-hot"), "--prepare",
  ], w.env);
  assert.equal(prepHotActor.status, 0, prepHotActor.stderr);
  const pHot = JSON.parse(prepHotActor.stdout);
  put(pHot.wt, "src/hotspot.mjs", bigLines(830, "hot"));
  put(pHot.ws, "out/report.md", "# R-0004-actor-hot\n\nBloated hotspot.\n");
  writeCodexTranscript(w.codexHome, pHot.ws, "sess-hot-actor", pHot.prompt, pHot.wt);
  const recHot = runNode(CALL_CLI, [w.configPath, "record", "--ws", pHot.ws], w.env);
  assert.equal(recHot.status, 0, recHot.stderr);
  const hotSha = JSON.parse(recHot.stdout).product.commit;

  commitPlan(w, "PL-0002", [
    { id: "actor-clean", role: "actor", handoff: "R-0005-actor-clean", files: ["src/clean.mjs"] },
    { id: "actor-hot-2", role: "actor", handoff: "R-0005-actor-hot", files: ["src/hotspot.mjs"] },
    { id: "critic-2", role: "critic", handoff: "R-0005-critic", files: ["acceptance/smoke.test.mjs"], reviews: ["actor-clean", "actor-hot-2"] },
    { id: "judge-2", role: "judge", handoff: "R-0005-judge", files: [], needs: ["critic-2"] },
  ], { supersedes: "PL-0001" });

  const nextBreach = runNode(LOOP_CLI, ["next", "--config", w.configPath], w.env);
  assert.equal(nextBreach.status, 0, nextBreach.stderr);
  assert.match(nextBreach.stdout, /Outer loop hard-due \(T3\)/);
  assert.match(nextBreach.stdout, /src\/hotspot\.mjs/);
  assert.doesNotMatch(nextBreach.stdout, /src\/legacy-big\.mjs/);

  const blockedAll = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "5", "--step", "actor-clean", "--plan", "PL-0002", "--package", "actor-clean",
    "--base", hotSha, "--task", writeTask(w, "R-0005-actor-clean"), "--dry-run",
  ], w.env);
  assert.equal(blockedAll.status, 7);
  assert.match(blockedAll.stderr, /Outer loop is hard-due/i);

  const prepAsyncArch = runNode(CALL_CLI, [
    w.configPath, "reviewer", "--round", "5", "--step", "reviewer-architecture", "--base", hotSha,
    "--task", writeTask(w, "R-0005-reviewer-architecture", "none"), "--prepare",
  ], w.env);
  assert.equal(prepAsyncArch.status, 0, prepAsyncArch.stderr);

  const cleanAllowed = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "5", "--step", "actor-clean", "--plan", "PL-0002", "--package", "actor-clean",
    "--base", hotSha, "--task", writeTask(w, "R-0005-actor-clean"), "--dry-run",
  ], w.env);
  assert.equal(cleanAllowed.status, 0, cleanAllowed.stderr);

  const hotBlocked = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "5", "--step", "actor-hot", "--plan", "PL-0002", "--package", "actor-hot-2",
    "--base", hotSha, "--task", writeTask(w, "R-0005-actor-hot"), "--dry-run",
  ], w.env);
  assert.equal(hotBlocked.status, 7);
  assert.match(hotBlocked.stderr, /src\/hotspot\.mjs/);

  git(w.product, w.env, "checkout", "-q", "-b", "side-absent", c1);
  put(w.product, "src/side.mjs", "export const side = 1;\n");
  const divergedSha = commitAll(w.product, w.env, "diverged commit");
  const prevT = readFileSync(join(w.records, "metrics/trajectory.jsonl"), "utf8");
  put(w.records, "metrics/trajectory.jsonl", prevT + JSON.stringify({
    round: 3, phase: "v1", role: "judge", area: "side", verdict: "CONTINUE", commit: divergedSha, ci: "absent", time: "2026-11-24T03:00:00Z",
  }) + "\n");
  commitAll(w.records, w.env, "unextinguished non-ancestor ci-absent");

  const nextDiverged = runNode(LOOP_CLI, ["next", "--config", w.configPath], w.env);
  assert.equal(nextDiverged.status, 0, nextDiverged.stderr);
  assert.match(nextDiverged.stdout, /ci-absent:v1:3/);

  const alarmBlocked = runNode(CALL_CLI, [
    w.configPath, "actor", "--round", "5", "--step", "actor-clean", "--plan", "PL-0002", "--package", "actor-clean",
    "--base", hotSha, "--task", writeTask(w, "R-0005-actor-clean"), "--dry-run",
  ], w.env);
  assert.equal(alarmBlocked.status, 7);
  assert.match(alarmBlocked.stderr, /ci-absent:v1:3/);
});

function spawnNode(script, args, env, { cwd = REPO_ROOT } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => { stdout += d; });
    child.stderr.on("data", d => { stderr += d; });
    child.on("error", rejectPromise);
    child.on("close", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
}

function countedSuite(t, prefix, ok, delayMs = 0) {
  const counterDir = makeDir(t, prefix);
  const counterFile = join(counterDir, "runs.log");
  const wait = delayMs > 0 ? `await new Promise(r => setTimeout(r, ${delayMs})); ` : "";
  const body = [
    'import assert from "node:assert/strict";',
    'import { appendFileSync } from "node:fs";',
    'import test from "node:test";',
    `test("counted", async () => { ${wait}appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); assert.equal(${ok ? "1, 1" : "1, 2"}); });`,
    "",
  ].join("\n");
  const count = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);
  return { body, count };
}

function parseWorkflowPushBranches(yml) {
  const lines = yml.split(/\r?\n/);
  const indent = line => line.search(/\S/);
  const cleanItem = s => s.trim().replace(/^(['"])(.*)\1$/, "$2").trim();
  let onIndent = -1, pushIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const ind = indent(raw);
    const trimmed = raw.trim();
    if (onIndent >= 0 && ind <= onIndent) { onIndent = -1; pushIndent = -1; }
    if (pushIndent >= 0 && ind <= pushIndent) pushIndent = -1;
    if (onIndent < 0 && /^on:\s*(?:#.*)?$/.test(trimmed)) { onIndent = ind; continue; }
    if (onIndent >= 0 && pushIndent < 0 && /^push:\s*(?:#.*)?$/.test(trimmed)) { pushIndent = ind; continue; }
    if (pushIndent >= 0) {
      const inline = /^branches:\s*\[([^\]]*)\]\s*(?:#.*)?$/.exec(trimmed);
      if (inline) return inline[1].split(",").map(cleanItem).filter(Boolean);
      if (/^branches:\s*(?:#.*)?$/.test(trimmed)) {
        const branchIndent = ind;
        const items = [];
        for (let j = i + 1; j < lines.length; j++) {
          const sub = lines[j];
          if (!sub.trim() || sub.trim().startsWith("#")) continue;
          if (indent(sub) <= branchIndent) break;
          const m = /^-\s+(.+?)\s*$/.exec(sub.trim());
          if (m) items.push(cleanItem(m[1].replace(/\s+#.*$/, "")));
        }
        return items;
      }
    }
  }
  return [];
}

function matchBranchGlob(pattern, branch) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\0/g, ".*");
  return new RegExp(`^${escaped}$`).test(branch);
}

test("MCP-08 (D-0061/R26-1): planned write-mode critic uses lookup while read-only final critic uses ensure (red refuses exit 2, green stages 0444 receipt once, warm reuses); loss: false-verdict/stuck", t => {
  const redSuite = countedSuite(t, "mcp08-red-", false);
  const wRed = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": redSuite.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(wRed, "PL-0001", [
    { id: "critic-write", role: "critic", handoff: "R-0002-critic-write", files: ["acceptance/x.test.mjs"] },
    { id: "critic-final", role: "critic", handoff: "R-0002-critic-final", files: [] },
    { id: "judge-final", role: "judge", handoff: "R-0002-judge", files: [] },
  ], { scope: "v1/red-critic" });

  const writeRed = runNode(CALL_CLI, [
    wRed.configPath, "critic", "--round", "2", "--step", "critic-write", "--plan", "PL-0001", "--package", "critic-write",
    "--base", wRed.baseline, "--task", writeTask(wRed, "R-0002-critic-write"), "--prepare",
  ], wRed.env);
  assert.equal(writeRed.status, 0, writeRed.stderr);
  assert.equal(redSuite.count(), 0);
  const pWriteRed = JSON.parse(writeRed.stdout);
  assert.equal(existsSync(join(pWriteRed.ws, "suite-receipt.json")), false);
  assert.equal(runNode(CALL_CLI, [wRed.configPath, "cancel", "--ws", pWriteRed.ws, "--reason", "cleanup"], wRed.env).status, 0);

  const finalRed = runNode(CALL_CLI, [
    wRed.configPath, "critic", "--round", "2", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final",
    "--base", wRed.baseline, "--task", writeTask(wRed, "R-0002-critic-final"), "--prepare",
  ], wRed.env);
  assert.equal(finalRed.status, 2, finalRed.stderr);
  assert.equal(finalRed.stdout.trim(), "");
  assert.match(finalRed.stderr, /suite/i);
  assert.equal(redSuite.count(), 1);

  const greenSuite = countedSuite(t, "mcp08-green-", true);
  const wGreen = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": greenSuite.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(wGreen, "PL-0001", [
    { id: "critic-write", role: "critic", handoff: "R-0002-critic-write", files: ["acceptance/x.test.mjs"] },
    { id: "critic-final", role: "critic", handoff: "R-0002-critic-final", files: [] },
    { id: "critic-final-warm", role: "critic", handoff: "R-0003-critic-final", files: [] },
    { id: "judge-final", role: "judge", handoff: "R-0003-judge", files: [] },
  ], { scope: "v1/green-critic" });

  const writeGreen = runNode(CALL_CLI, [
    wGreen.configPath, "critic", "--round", "2", "--step", "critic-write", "--plan", "PL-0001", "--package", "critic-write",
    "--base", wGreen.baseline, "--task", writeTask(wGreen, "R-0002-critic-write"), "--prepare",
  ], wGreen.env);
  assert.equal(writeGreen.status, 0, writeGreen.stderr);
  assert.equal(greenSuite.count(), 0);
  const pWriteGreen = JSON.parse(writeGreen.stdout);
  assert.equal(existsSync(join(pWriteGreen.ws, "suite-receipt.json")), false);
  assert.equal(runNode(CALL_CLI, [wGreen.configPath, "cancel", "--ws", pWriteGreen.ws, "--reason", "cleanup"], wGreen.env).status, 0);

  const finalGreen = runNode(CALL_CLI, [
    wGreen.configPath, "critic", "--round", "2", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final",
    "--base", wGreen.baseline, "--task", writeTask(wGreen, "R-0002-critic-final"), "--prepare",
  ], wGreen.env);
  assert.equal(finalGreen.status, 0, finalGreen.stderr);
  assert.equal(greenSuite.count(), 1);
  const pFinal = JSON.parse(finalGreen.stdout);
  const stagedFinal = join(pFinal.ws, "suite-receipt.json");
  assert.equal(existsSync(stagedFinal), true);
  assert.equal(statSync(stagedFinal).mode & 0o222, 0);
  const expectedTree = git(wGreen.product, wGreen.env, "rev-parse", `${wGreen.baseline}^{tree}`);
  const finalRec = JSON.parse(readFileSync(stagedFinal, "utf8"));
  assert.equal(finalRec.tree, expectedTree);
  assert.equal(finalRec.green, true);
  assert.match(pFinal.prompt, /suite-receipt\.json/);
  assert.match(pFinal.prompt, /do NOT re-run `node --test acceptance\/smoke\.test\.mjs` on unchanged wt/);

  const finalWarm = runNode(CALL_CLI, [
    wGreen.configPath, "critic", "--round", "3", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final-warm",
    "--base", wGreen.baseline, "--task", writeTask(wGreen, "R-0003-critic-final"), "--prepare",
  ], wGreen.env);
  assert.equal(finalWarm.status, 0, finalWarm.stderr);
  assert.equal(greenSuite.count(), 1);
  const pWarm = JSON.parse(finalWarm.stdout);
  assert.equal(JSON.parse(readFileSync(join(pWarm.ws, "suite-receipt.json"), "utf8")).tree, expectedTree);

  const judgeWarm = runNode(CALL_CLI, [
    wGreen.configPath, "judge", "--round", "3", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final",
    "--base", wGreen.baseline, "--task", writeTask(wGreen, "R-0003-judge"), "--prepare",
  ], wGreen.env);
  assert.equal(judgeWarm.status, 0, judgeWarm.stderr);
  assert.equal(greenSuite.count(), 1);
  const pJudgeWarm = JSON.parse(judgeWarm.stdout);
  assert.equal(JSON.parse(readFileSync(join(pJudgeWarm.ws, "suite-receipt.json"), "utf8")).tree, expectedTree);
});

test("MCP-09 (D-0061/R26-2): concurrent host ensure calls on the same cold tree share one suite execution and stale per-key lockfiles recover cleanly; loss: stuck/wrong-result", async t => {
  const slow = countedSuite(t, "mcp09-concurrent-", true, 350);
  const w = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": slow.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w, "PL-0001", [
    { id: "judge-a", role: "judge", handoff: "R-0002-judge-a", files: [] },
    { id: "judge-b", role: "judge", handoff: "R-0002-judge-b", files: [] },
  ], { scope: "v1/concurrent" });

  const taskA = writeTask(w, "R-0002-judge-a");
  const taskB = writeTask(w, "R-0002-judge-b");
  const [resA, resB] = await Promise.all([
    spawnNode(CALL_CLI, [
      w.configPath, "judge", "--round", "2", "--step", "judge-a", "--plan", "PL-0001", "--package", "judge-a",
      "--base", w.baseline, "--task", taskA, "--prepare",
    ], w.env),
    spawnNode(CALL_CLI, [
      w.configPath, "judge", "--round", "2", "--step", "judge-b", "--plan", "PL-0001", "--package", "judge-b",
      "--base", w.baseline, "--task", taskB, "--prepare",
    ], w.env),
  ]);
  assert.equal(resA.status, 0, resA.stderr);
  assert.equal(resB.status, 0, resB.stderr);
  assert.equal(slow.count(), 1);

  const expectedTree = git(w.product, w.env, "rev-parse", `${w.baseline}^{tree}`);
  for (const res of [resA, resB]) {
    const p = JSON.parse(res.stdout);
    const staged = join(p.ws, "suite-receipt.json");
    assert.equal(existsSync(staged), true);
    const rec = JSON.parse(readFileSync(staged, "utf8"));
    assert.equal(rec.green, true);
    assert.equal(rec.tree, expectedTree);
  }

  const stale = countedSuite(t, "mcp09-stale-", true);
  const w2 = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": stale.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  const baseSuite = runNode(SUITE_CLI, ["--repo", w2.product, "--sha", w2.baseline, "--command", "node --test acceptance/smoke.test.mjs"], w2.env);
  assert.equal(baseSuite.status, 0, baseSuite.stderr);
  assert.equal(stale.count(), 1);

  put(w2.product, "src/a.mjs", "export const a = 2;\n");
  const c1 = commitAll(w2.product, w2.env, "cold tree for stale lock");
  const c1Tree = git(w2.product, w2.env, "rev-parse", `${c1}^{tree}`);

  const baseHit = lookupSuiteReceipt({ repo: w2.product, sha: w2.baseline, command: "node --test acceptance/smoke.test.mjs" });
  const baseKey = JSON.parse(readFileSync(baseHit.receiptPath, "utf8")).key;
  const c1Key = { ...baseKey, tree: c1Tree };
  const c1Hash = createHash("sha256").update(JSON.stringify([
    c1Key.repository, c1Key.tree, c1Key.command, c1Key.install ?? null, c1Key.execution ?? null,
    [c1Key.runtime?.node ?? null, c1Key.runtime?.platform ?? null, c1Key.runtime?.arch ?? null],
  ])).digest("hex");

  const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const storeDir = suiteStore(w2.product);
  mkdirSync(storeDir, { recursive: true });
  const lockPath = join(storeDir, `${c1Hash}.lock`);
  writeFileSync(lockPath, `${JSON.stringify({ pid: deadChild.pid, tree: c1Tree, createdAt: "2026-01-01T00:00:00Z" })}\n`);
  assert.equal(existsSync(lockPath), true);

  const prevLoadDir = process.env.SELF_LOOP_LOAD_DIR;
  process.env.SELF_LOOP_LOAD_DIR = w2.env.SELF_LOOP_LOAD_DIR;
  t.after(() => {
    if (prevLoadDir === undefined) delete process.env.SELF_LOOP_LOAD_DIR;
    else process.env.SELF_LOOP_LOAD_DIR = prevLoadDir;
  });

  const wsStale = join(w2.workDir, "stale-lock-ws");
  const recovered = stageSuiteWorkspace({
    repo: w2.product, sha: c1, command: "node --test acceptance/smoke.test.mjs", ws: wsStale, mode: "ensure",
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.reused, false);
  assert.equal(stale.count(), 2);
  assert.equal(existsSync(lockPath), false);
  const stagedStale = join(wsStale, "suite-receipt.json");
  assert.equal(existsSync(stagedStale), true);
  const staleRec = JSON.parse(readFileSync(stagedStale, "utf8"));
  assert.equal(staleRec.green, true);
  assert.equal(staleRec.tree, c1Tree);
});

test("MCP-10 (D-0061/R26-3): real .github/workflows/test.yml subscribes to ci/<handoff-id> push refs alongside main for both required platform checks; loss: false-verdict/stuck", () => {
  const yml = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");
  const branches = parseWorkflowPushBranches(yml);
  assert.equal(branches.some(p => matchBranchGlob(p, "main")), true, `missing main in ${JSON.stringify(branches)}`);
  assert.equal(branches.some(p => matchBranchGlob(p, "ci/R-0026-critic-tb-product")), true, `missing ci/<handoff-id> match in ${JSON.stringify(branches)}`);
  assert.equal(branches.some(p => matchBranchGlob(p, "ci/R-0002-critic")), true, `missing ci/R-0002-critic match in ${JSON.stringify(branches)}`);
  assert.match(yml, /name:\s*unit \(\$\{\{\s*matrix\.os\s*\}\}\)/);
  assert.match(yml, /name:\s*acceptance \(\$\{\{\s*matrix\.os\s*\}\}\)/);
  assert.match(yml, /ubuntu-latest/);
  assert.match(yml, /macos-latest/);
});

test("MCP-11 (D-0061/R26-2): concurrent cold red preparations (critic-final + judge-final) share one failed execution without staging receipts, and a subsequent sequential retry re-executes cleanly; loss: stuck/wrong-result", async t => {
  const red = countedSuite(t, "mcp11-red-", false, 500);
  const w = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": red.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w, "PL-0001", [
    { id: "critic-final", role: "critic", handoff: "R-0002-critic-final", files: [] },
    { id: "judge-final", role: "judge", handoff: "R-0002-judge", files: [] },
  ], { scope: "v1/red-singleflight" });

  const criticTask = writeTask(w, "R-0002-critic-final");
  const judgeTask = writeTask(w, "R-0002-judge");
  const [resCritic, resJudge] = await Promise.all([
    spawnNode(CALL_CLI, [
      w.configPath, "critic", "--round", "2", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final",
      "--base", w.baseline, "--task", criticTask, "--prepare",
    ], w.env),
    spawnNode(CALL_CLI, [
      w.configPath, "judge", "--round", "2", "--plan", "PL-0001", "--package", "judge-final",
      "--base", w.baseline, "--task", judgeTask, "--prepare",
    ], w.env),
  ]);

  assert.equal(resCritic.status, 2, resCritic.stderr);
  assert.equal(resJudge.status, 2, resJudge.stderr);
  assert.equal(resCritic.stdout.trim(), "");
  assert.equal(resJudge.stdout.trim(), "");
  assert.match(resCritic.stderr, /pre-critic suite gate failed/);
  assert.match(resJudge.stderr, /pre-judge suite gate failed/);
  assert.equal(red.count(), 1);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" }), null);

  const wsDirs = () => readdirSync(w.workDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== "tasks").map(d => join(w.workDir, d.name));
  for (const dir of wsDirs()) {
    assert.equal(existsSync(join(dir, "suite-receipt.json")), false);
  }
  assert.deepEqual(readdirSync(suiteStore(w.product)).filter(n => n.endsWith(".lock")), []);

  const retryJudge = runNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--plan", "PL-0001", "--package", "judge-final",
    "--base", w.baseline, "--task", judgeTask, "--prepare",
  ], w.env);
  assert.equal(retryJudge.status, 2, retryJudge.stderr);
  assert.equal(retryJudge.stdout.trim(), "");
  assert.match(retryJudge.stderr, /pre-judge suite gate failed/);
  assert.equal(red.count(), 2);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" }), null);
  for (const dir of wsDirs()) {
    assert.equal(existsSync(join(dir, "suite-receipt.json")), false);
  }
  assert.deepEqual(readdirSync(suiteStore(w.product)).filter(n => n.endsWith(".lock")), []);
});

function startNode(script, args, env, { cwd = REPO_ROOT, nodeArgs = [] } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, script, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  const done = new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitUntil(pred, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function scriptedSuite(t, prefix, { failRuns = [], delayMs = 0 } = {}) {
  const counterDir = makeDir(t, prefix);
  const counterFile = join(counterDir, "runs.log");
  const wait = delayMs > 0 ? `await new Promise(r => setTimeout(r, ${delayMs})); ` : "";
  const body = [
    'import assert from "node:assert/strict";',
    'import { appendFileSync, readFileSync } from "node:fs";',
    'import test from "node:test";',
    `const failRuns = new Set(${JSON.stringify(failRuns)});`,
    `test("counted", async () => { appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); const n = readFileSync(${JSON.stringify(counterFile)}, "utf8").split("\\n").filter(Boolean).length; ${wait}assert.equal(failRuns.has(n), false); });`,
    "",
  ].join("\n");
  const count = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);
  return { body, count };
}

test("MCP-12 (D-0061/R26-2): concurrent SIGKILL recovery elects one recovery leader without destroying a live lock, keeps batch red verdict consistent, and allows sequential retry; loss: false-verdict/stuck", async t => {
  const suite = scriptedSuite(t, "mcp12-sigkill-", { failRuns: [2], delayMs: 450 });
  const w = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": suite.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w, "PL-0001", [
    { id: "judge-init", role: "judge", handoff: "R-0002-judge-init", files: [] },
    { id: "critic-final", role: "critic", handoff: "R-0002-critic-final", files: [] },
    { id: "judge-final", role: "judge", handoff: "R-0002-judge-final", files: [] },
  ], { scope: "v1/sigkill-recovery" });

  const g1 = startNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-init", "--plan", "PL-0001", "--package", "judge-init",
    "--base", w.baseline, "--task", writeTask(w, "R-0002-judge-init"), "--prepare",
  ], w.env);
  await waitUntil(() => suite.count() >= 1);
  g1.child.kill("SIGKILL");
  const g1Res = await g1.done;
  assert.equal(g1Res.signal, "SIGKILL");

  const criticTask = writeTask(w, "R-0002-critic-final");
  const judgeTask = writeTask(w, "R-0002-judge-final");
  const [resCritic, resJudge] = await Promise.all([
    spawnNode(CALL_CLI, [
      w.configPath, "critic", "--round", "2", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final",
      "--base", w.baseline, "--task", criticTask, "--prepare",
    ], w.env),
    spawnNode(CALL_CLI, [
      w.configPath, "judge", "--round", "2", "--step", "judge-final", "--plan", "PL-0001", "--package", "judge-final",
      "--base", w.baseline, "--task", judgeTask, "--prepare",
    ], w.env),
  ]);

  assert.deepEqual([resCritic.status, resJudge.status], [2, 2], `${resCritic.stderr}\n${resJudge.stderr}`);
  assert.equal(resCritic.stdout.trim(), "");
  assert.equal(resJudge.stdout.trim(), "");
  assert.match(resCritic.stderr, /pre-critic suite gate failed/);
  assert.match(resJudge.stderr, /pre-judge suite gate failed/);
  assert.equal(suite.count(), 2);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" }), null);

  const wsDirs = () => readdirSync(w.workDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== "tasks").map(d => join(w.workDir, d.name));
  for (const dir of wsDirs()) {
    assert.equal(existsSync(join(dir, "suite-receipt.json")), false);
  }
  assert.deepEqual(readdirSync(suiteStore(w.product)).filter(n => n.endsWith(".lock")), []);

  const retryJudge = runNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-final", "--plan", "PL-0001", "--package", "judge-final",
    "--base", w.baseline, "--task", judgeTask, "--prepare",
  ], w.env);
  assert.equal(retryJudge.status, 0, retryJudge.stderr);
  assert.equal(suite.count(), 3);
  const pRetry = JSON.parse(retryJudge.stdout);
  const stagedRetry = join(pRetry.ws, "suite-receipt.json");
  assert.equal(existsSync(stagedRetry), true);
  assert.equal(statSync(stagedRetry).mode & 0o222, 0);
  const expectedTree = git(w.product, w.env, "rev-parse", `${w.baseline}^{tree}`);
  const retryRec = JSON.parse(readFileSync(stagedRetry, "utf8"));
  assert.equal(retryRec.green, true);
  assert.equal(retryRec.tree, expectedTree);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" })?.receipt?.tree, expectedTree);
});

test("MCP-13 (D-0061/R26-2): overlapping staggered multi-caller red batch preserves leader red handoff across lock transition and allows sequential retry; loss: false-verdict/stuck", async t => {
  const suite = scriptedSuite(t, "mcp13-handoff-", { failRuns: [1], delayMs: 350 });
  const w = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": suite.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w, "PL-0001", [
    { id: "critic-final", role: "critic", handoff: "R-0002-critic-final", files: [] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge-a", files: [] },
    { id: "judge-b", role: "judge", handoff: "R-0002-judge-b", files: [] },
  ], { scope: "v1/red-handoff" });

  const criticTask = writeTask(w, "R-0002-critic-final");
  const judgeATask = writeTask(w, "R-0002-judge-a");
  const judgeBTask = writeTask(w, "R-0002-judge-b");

  const pCritic = spawnNode(CALL_CLI, [
    w.configPath, "critic", "--round", "2", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final",
    "--base", w.baseline, "--task", criticTask, "--prepare",
  ], w.env);
  const pJudgeA = spawnNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-a", "--plan", "PL-0001", "--package", "judge-a",
    "--base", w.baseline, "--task", judgeATask, "--prepare",
  ], w.env);
  await new Promise(r => setTimeout(r, 270));
  const pJudgeB = spawnNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-b", "--plan", "PL-0001", "--package", "judge-b",
    "--base", w.baseline, "--task", judgeBTask, "--prepare",
  ], w.env);

  const [resCritic, resJudgeA, resJudgeB] = await Promise.all([pCritic, pJudgeA, pJudgeB]);
  assert.deepEqual([resCritic.status, resJudgeA.status, resJudgeB.status], [2, 2, 2], `${resCritic.stderr}\n${resJudgeA.stderr}\n${resJudgeB.stderr}`);
  assert.equal(resCritic.stdout.trim(), "");
  assert.equal(resJudgeA.stdout.trim(), "");
  assert.equal(resJudgeB.stdout.trim(), "");
  assert.match(resCritic.stderr, /pre-critic suite gate failed/);
  assert.match(resJudgeA.stderr, /pre-judge suite gate failed/);
  assert.match(resJudgeB.stderr, /pre-judge suite gate failed/);
  assert.equal(suite.count(), 1);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" }), null);

  const wsDirs = () => readdirSync(w.workDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== "tasks").map(d => join(w.workDir, d.name));
  for (const dir of wsDirs()) {
    assert.equal(existsSync(join(dir, "suite-receipt.json")), false);
  }
  assert.deepEqual(readdirSync(suiteStore(w.product)).filter(n => n.endsWith(".lock")), []);

  const retryJudge = runNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-a", "--plan", "PL-0001", "--package", "judge-a",
    "--base", w.baseline, "--task", judgeATask, "--prepare",
  ], w.env);
  assert.equal(retryJudge.status, 0, retryJudge.stderr);
  assert.equal(suite.count(), 2);
  const pRetry = JSON.parse(retryJudge.stdout);
  const stagedRetry = join(pRetry.ws, "suite-receipt.json");
  assert.equal(existsSync(stagedRetry), true);
  assert.equal(statSync(stagedRetry).mode & 0o222, 0);
  const expectedTree = git(w.product, w.env, "rev-parse", `${w.baseline}^{tree}`);
  const retryRec = JSON.parse(readFileSync(stagedRetry, "utf8"));
  assert.equal(retryRec.green, true);
  assert.equal(retryRec.tree, expectedTree);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" })?.receipt?.tree, expectedTree);
});

test("MCP-14 (D-0061/R26-2): normal-entry call.mjs --prepare does not mistake a SIGSTOP-paused live g1 claimant (>600ms) for dead, shares single red verdict [2,2], and retries cleanly; loss: false-verdict/wrong-result", async t => {
  const suite = scriptedSuite(t, "mcp14-sigstop-", { failRuns: [1], delayMs: 250 });
  const w = setupWorld(t, {
    productFiles: { "acceptance/smoke.test.mjs": suite.body },
    suite: "node --test acceptance/smoke.test.mjs",
  });
  commitPlan(w, "PL-0001", [
    { id: "critic-final", role: "critic", handoff: "R-0002-critic-final", files: [] },
    { id: "judge-final", role: "judge", handoff: "R-0002-judge-final", files: [] },
  ], { scope: "v1/sigstop-claim" });

  const preloadDir = makeDir(t, "mcp14-preload-");
  const preloadPath = join(preloadDir, "pause-claim.mjs");
  writeFileSync(preloadPath, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const targetRe = /[/\\\\]g1\\.claim$/;',
    "const origOpen = fs.openSync;",
    "const origLink = fs.linkSync;",
    "let stopped = false;",
    "const pauseOnce = () => {",
    "  if (stopped) return;",
    "  stopped = true;",
    '  process.kill(process.pid, "SIGSTOP");',
    "};",
    "fs.openSync = function (path, flags, ...rest) {",
    "  const res = origOpen.call(this, path, flags, ...rest);",
    '  const isExcl = (typeof flags === "string" && flags.includes("x")) || (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0);',
    '  if (typeof path === "string" && targetRe.test(path) && isExcl) pauseOnce();',
    "  return res;",
    "};",
    "fs.linkSync = function (existingPath, newPath) {",
    "  const res = origLink.call(this, existingPath, newPath);",
    '  if (typeof newPath === "string" && targetRe.test(newPath)) pauseOnce();',
    "  return res;",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const preloadUrl = pathToFileURL(preloadPath).href;

  const criticTask = writeTask(w, "R-0002-critic-final");
  const judgeTask = writeTask(w, "R-0002-judge-final");
  const caller1 = startNode(CALL_CLI, [
    w.configPath, "critic", "--round", "2", "--step", "critic-final", "--plan", "PL-0001", "--package", "critic-final",
    "--base", w.baseline, "--task", criticTask, "--prepare",
  ], w.env, { nodeArgs: ["--import", preloadUrl] });
  t.after(() => { try { caller1.child.kill("SIGCONT"); } catch {} });

  const storeDir = suiteStore(w.product);
  const genRoot = join(storeDir, ".gen");
  const findGenDir = () => {
    if (!existsSync(genRoot)) return null;
    const hit = readdirSync(genRoot).find(n => existsSync(join(genRoot, n, "g1.claim")));
    return hit ? join(genRoot, hit) : null;
  };
  await waitUntil(() => {
    if (caller1.child.exitCode !== null) throw new Error(`caller1 exited early with ${caller1.child.exitCode}`);
    if (!findGenDir()) return false;
    const st = spawnSync("ps", ["-o", "state=", "-p", String(caller1.child.pid)], { encoding: "utf8" });
    return st.status === 0 && /^T/.test(st.stdout.trim());
  });
  const genDir = findGenDir();
  assert.ok(genDir);
  assert.equal(suite.count(), 0);

  const caller2 = startNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-final", "--plan", "PL-0001", "--package", "judge-final",
    "--base", w.baseline, "--task", judgeTask, "--prepare",
  ], w.env);
  await new Promise(r => setTimeout(r, 700));
  const g2DuringStop = existsSync(join(genDir, "g2.claim"));

  caller1.child.kill("SIGCONT");
  const [res1, res2] = await Promise.all([caller1.done, caller2.done]);

  assert.deepEqual([res1.status, res2.status], [2, 2], `${res1.stderr}\n${res2.stderr}`);
  assert.equal(g2DuringStop, false);
  assert.equal(existsSync(join(genDir, "g2.claim")), false);
  assert.equal(res1.stdout.trim(), "");
  assert.equal(res2.stdout.trim(), "");
  assert.match(res1.stderr, /pre-critic suite gate failed/);
  assert.match(res2.stderr, /pre-judge suite gate failed/);
  assert.equal(suite.count(), 1);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" }), null);

  const wsDirs = () => readdirSync(w.workDir, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== "tasks").map(d => join(w.workDir, d.name));
  for (const dir of wsDirs()) {
    assert.equal(existsSync(join(dir, "suite-receipt.json")), false);
  }
  assert.deepEqual(readdirSync(storeDir).filter(n => n.endsWith(".lock")), []);

  const retryJudge = runNode(CALL_CLI, [
    w.configPath, "judge", "--round", "2", "--step", "judge-final", "--plan", "PL-0001", "--package", "judge-final",
    "--base", w.baseline, "--task", judgeTask, "--prepare",
  ], w.env);
  assert.equal(retryJudge.status, 0, retryJudge.stderr);
  assert.equal(suite.count(), 2);
  const pRetry = JSON.parse(retryJudge.stdout);
  const stagedRetry = join(pRetry.ws, "suite-receipt.json");
  assert.equal(existsSync(stagedRetry), true);
  assert.equal(statSync(stagedRetry).mode & 0o222, 0);
  const expectedTree = git(w.product, w.env, "rev-parse", `${w.baseline}^{tree}`);
  const retryRec = JSON.parse(readFileSync(stagedRetry, "utf8"));
  assert.equal(retryRec.green, true);
  assert.equal(retryRec.tree, expectedTree);
  assert.equal(lookupSuiteReceipt({ repo: w.product, sha: w.baseline, command: "node --test acceptance/smoke.test.mjs" })?.receipt?.tree, expectedTree);
});

test("MCP-15 (D-0064/T5): self-loop.mjs patch commits bounded LP-NNNN fixes, updates records index, resets streak after actor handoff, keeps window.mjs open working, and blocks protected push until convergence; loss: false-verdict/stuck", async t => {
  const w = setupWorld(t);
  runNode(RECORDS_CHECK_CLI, ["--repo", w.records, "--write"], w.env);
  if (git(w.records, w.env, "status", "--porcelain=v1")) commitAll(w.records, w.env, "ensure clean index baseline");
  put(w.product, "src/a.mjs", "export const a = 10;\n");

  const dry = runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--reason", "Dry run fix", "--verify", "node --test acceptance/smoke.test.mjs", "--dry-run", "--json",
  ], w.env);
  assert.equal(dry.status, 0, dry.stderr + dry.stdout);
  const dryJson = JSON.parse(dry.stdout);
  assert.deepEqual([dryJson.ok, dryJson.dryRun, dryJson.files, dryJson.lines.total], [true, true, ["src/a.mjs"], 2]);
  assert.notEqual(git(w.product, w.env, "status", "--porcelain=v1"), "");

  const lp1 = runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--reason", "Update exported constant a", "--verify", "node --test acceptance/smoke.test.mjs", "--json",
  ], w.env);
  assert.equal(lp1.status, 0, lp1.stderr + lp1.stdout);
  const p1 = JSON.parse(lp1.stdout);
  assert.deepEqual([p1.ok, p1.handoff.id, p1.handoff.role, p1.handoff.product.base, p1.handoff.verify.exit, p1.handoff.audit.violations], [
    true, "LP-0001", "lead-patch", w.baseline, 0, 0,
  ]);
  assert.equal(git(w.product, w.env, "status", "--porcelain=v1"), "");
  assert.equal(git(w.product, w.env, "rev-parse", "HEAD"), p1.handoff.product.commit);

  await t.test("records-check passes without index-drift after lead-patch", () => {
    const recChk = runNode(RECORDS_CHECK_CLI, ["--repo", w.records, "--json"], w.env);
    assert.deepEqual([recChk.status, JSON.parse(recChk.stdout).failures], [0, []]);
  });

  const prov = verifyProvenance({ repo: w.product, records: w.records, sha: p1.handoff.product.commit, branch: "loop/v1", mode: "base" });
  assert.deepEqual([prov.unattested, prov.waveGate.missing.includes("provenance")], [[], false], prov.reasons?.join("; "));
  assert.equal(runNode(SUITE_CLI, ["--repo", w.product, "--sha", p1.handoff.product.commit, "--command", "node --test acceptance/smoke.test.mjs", "--format", "node-test"], w.env).status, 0);
  assert.equal(runNode(PUSH_CLI, ["--verify-only", "--repo", w.product, "--branch", "main", "--sha", p1.handoff.product.commit, "--owner-store", w.storeDir], w.env).status, 2);

  await t.test("window.mjs open omitting --start-round succeeds with round-less lead-patch entries", () => {
    const winOpen = runNode(WINDOW_CLI, ["open", "--records", w.records, "--phase", "v1", "--horizon", "2", "--goal", "Default startRound after LP", "--invariant", "Smoke tests stay green", "--json"], w.env);
    assert.equal(winOpen.status, 0, winOpen.stderr + winOpen.stdout);
  });

  put(w.product, "src/a.mjs", "export const a = 20;\n");
  put(w.product, "src/b.mjs", Array.from({ length: 25 }, (_, i) => `export const b${i} = ${i};`).join("\n") + "\n");
  const lp2 = runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--files", "src/a.mjs", "--reason", "Selective a.mjs patch", "--verify", "node --test acceptance/smoke.test.mjs", "--json",
  ], w.env);
  assert.equal(lp2.status, 0, lp2.stderr + lp2.stdout);
  assert.equal(JSON.parse(lp2.stdout).handoff.id, "LP-0002");
  assert.match(git(w.product, w.env, "status", "--porcelain=v1"), /src\/b\.mjs/);
  git(w.product, w.env, "checkout", "--", "src/b.mjs");

  put(w.product, "src/a.mjs", "export const a = 30;\n");
  const lp3Denied = runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--reason", "Third consecutive patch", "--verify", "node --test acceptance/smoke.test.mjs", "--json",
  ], w.env);
  assert.equal(lp3Denied.status, 2);
  assert.match(lp3Denied.stdout + lp3Denied.stderr, /consecutive lead-patch limit reached \(2\/2\)/);
  git(w.product, w.env, "checkout", "--", "src/a.mjs");

  put(w.records, "plans/PL-0001.md", planText("PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", files: ["src/a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", files: ["acceptance/**"], needs: ["actor-a"], reviews: ["actor-a"] },
  ]));
  const actorTask = writeTask(w, "R-0002-actor-a");
  const criticTask = writeTask(w, "R-0002-critic-a");
  assert.ok(actorTask && criticTask);
  commitAll(w.records, w.env, "add PL-0001 for streak reset");
  const prepA = JSON.parse(runNode(DISPATCH_CLI, ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"], w.env).stdout).prepared[0];
  put(prepA.wt, "src/a.mjs", "export const a = 31;\n");
  put(prepA.ws, "out/report.md", "# R-0002-actor-a\n\nReset.\n");
  writeCodexTranscript(w.codexHome, prepA.ws, `sess-${prepA.nonce}`, prepA.prompt, prepA.wt);
  assert.equal(runNode(DISPATCH_CLI, ["record", "--config", w.configPath, "--plan", "PL-0001", "--json"], w.env).status, 0);
  const shaA = git(w.product, w.env, "rev-parse", "loop/v1");
  git(w.product, w.env, "checkout", "-q", "loop/v1");
  assert.notEqual(shaA, p1.handoff.product.commit);

  put(w.product, "src/a.mjs", "export const a = 32;\n");
  const lp3AfterReset = runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--reason", "Patch allowed after actor reset", "--verify", "node --test acceptance/smoke.test.mjs", "--json",
  ], w.env);
  assert.equal(lp3AfterReset.status, 0, lp3AfterReset.stderr + lp3AfterReset.stdout);
  assert.equal(JSON.parse(lp3AfterReset.stdout).handoff.id, "LP-0003");
});

test("MCP-16 (D-0064/T5): self-loop.mjs patch enforces line/file caps, D-0016 prose ban, verify gate, branch guard, binary file refusal, and detached HEAD refusal; loss: false-verdict", t => {
  const w = setupWorld(t);
  const runPatch = (extra = []) => runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--reason", "Check guard", "--verify", "node --test acceptance/smoke.test.mjs", ...extra, "--json",
  ], w.env);
  const resetDirty = () => { git(w.product, w.env, "checkout", "--", "."); git(w.product, w.env, "clean", "-fdq"); };

  put(w.product, "src/a.mjs", Array.from({ length: 22 }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n");
  const overLines = runPatch();
  assert.equal(overLines.status, 2);
  assert.match(overLines.stdout + overLines.stderr, /exceeds hard cap \(20\)/);
  resetDirty();

  for (const name of ["a", "b", "c", "d"]) put(w.product, `src/${name}.mjs`, `export const ${name} = 99;\n`);
  const overFiles = runPatch();
  assert.equal(overFiles.status, 2);
  assert.match(overFiles.stdout + overFiles.stderr, /exceeds hard cap \(3\)/);
  resetDirty();

  put(w.product, "src/a.mjs", "// Explain why constant changed.\nexport const a = 2;\n");
  const proseErr = runPatch();
  assert.equal(proseErr.status, 2);
  assert.match(proseErr.stdout + proseErr.stderr, /added prose.*D-0016/);
  resetDirty();

  put(w.product, "src/a.mjs", "export const a = 2;\n");
  const badVerify = runNode(SELF_LOOP_CLI, [
    "patch", "--records", w.records, "--reason", "Failing verify", "--verify", "node -e 'process.exit(4)'", "--json",
  ], w.env);
  assert.equal(badVerify.status, 2);
  assert.match(badVerify.stdout + badVerify.stderr, /--verify command exited 4/);

  put(w.product, "src/blob.bin", Buffer.from([0, 1, 2, 3]));
  const binErr = runPatch(["--files", "src/blob.bin"]);
  assert.equal(binErr.status, 2);
  assert.match(binErr.stdout + binErr.stderr, /binary file/);
  resetDirty();

  git(w.product, w.env, "checkout", "-q", "main");
  put(w.product, "src/a.mjs", "export const a = 2;\n");
  const protErr = runPatch();
  assert.equal(protErr.status, 2);
  assert.match(protErr.stdout + protErr.stderr, /protected/);
  resetDirty();

  git(w.product, w.env, "checkout", "-q", "--detach", w.baseline);
  put(w.product, "src/a.mjs", "export const a = 2;\n");
  const detErr = runPatch();
  assert.equal(detErr.status, 2);
  assert.match(detErr.stdout + detErr.stderr, /HEAD is detached/);
});
