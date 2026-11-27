// F-0008, F-0009, F-0010, D-0052, D-0060
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { parseShellWords } from "../scripts/lib/hooks.mjs";
import { auditAccess } from "../scripts/audit-access.mjs";
import { BRIEFS, git, isolatedEnv, loopProduct, ownerStore, scripts, selfLoop, temp } from "../scripts/test/helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const realTemp = prefix => realpathSync(temp(prefix));

const wrapEnvelope = body => [
  "<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n</t3_code_instructions>",
  `<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026-11-25\n</ADDITIONAL_METADATA>`,
].join("\n\n");

const userStep = (step_index, content, extra = {}) => ({
  step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T01:00:00.000Z",
  ...(content !== undefined ? { content } : {}), ...extra,
});

function makeProduct(name) {
  const dir = realTemp(`ag-child-${name}-`);
  const { product, records } = loopProduct({ activity: "2026-11-25T01:00:00.000Z", dir });
  mkdirSync(join(product, "src"), { recursive: true });
  writeFileSync(join(product, "src", "app.js"), `export const app = "${name}";\n`);
  git(product, "add", "src/app.js");
  git(product, "commit", "-qm", "add app.js");
  git(product, "branch", "-f", "loop/v1");
  const workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  return { dir, product, records, workDir };
}

function setupHarness(prefix, extraNames = []) {
  const alpha = makeProduct("alpha");
  const extras = extraNames.map(makeProduct);
  const store = ownerStore([{ name: "alpha", records: alpha.records }, ...extras.map((p, i) => ({ name: extraNames[i], records: p.records }))], {
    dir: realTemp(`${prefix}-store-`),
  });
  const appDir = realTemp(`${prefix}-app-`);
  const gHome = realTemp(`${prefix}-g-`);
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: gHome, T3CODE_HOME: "", T3CODE_THREAD_ID: "" });
  return { alpha, extras, store, appDir, gHome, env };
}

function makeCallWorkspace(prod, name, { role, step = role, round = 39, nonce, withWorktree = true, recorded = false, cancelled = false }) {
  const ws = join(prod.workDir, name);
  mkdirSync(join(ws, "out"), { recursive: true });
  mkdirSync(join(ws, "records"), { recursive: true });
  writeFileSync(join(ws, "records", "INDEX.md"), "# Index\n");
  writeFileSync(join(ws, "brief.md"), `# ${role} brief\n`);
  writeFileSync(join(ws, "brief-shared.md"), "# shared brief\n");
  writeFileSync(join(ws, "task.md"), `# Task ${name}\n`);
  const wt = withWorktree ? join(ws, "wt") : null;
  if (wt) git(prod.product, "worktree", "add", "-q", "--detach", wt);
  const id = `R-${String(round).padStart(4, "0")}-${step}`;
  const manifest = {
    version: 2, role, round, step, phase: "v1", id, record: `rounds/${String(round).padStart(4, "0")}-${step}.md`,
    ws, wt, nonce, ...(recorded ? { recorded: true } : {}), ...(cancelled ? { cancelled: true } : {}),
  };
  writeFileSync(join(ws, "call.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  const step0 = [
    "Act as the test sub-agent for this task.", "", `self-loop call ${id} · nonce ${nonce}`, "",
    `- Your working folder: ${ws}`, wt ? `- The product worktree: ${wt}` : `- Confined reviewer mode: ${ws}`,
  ].join("\n");
  return { ws, wt, id, nonce, step0 };
}

function writeTranscript(appDir, id, name, rows) {
  const logs = join(appDir, "brain", id, ".system_generated", "logs");
  mkdirSync(logs, { recursive: true });
  const file = join(logs, name);
  writeFileSync(file, rows.map(r => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return file;
}

function writeSummaryDb(appDir, rows) {
  mkdirSync(appDir, { recursive: true });
  const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT DEFAULT '', nesting_depth INTEGER DEFAULT 0, killed INTEGER DEFAULT 0, not_fully_idle INTEGER DEFAULT 0)`);
  const stmt = db.prepare("INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) stmt.run(r.id, JSON.stringify((r.workspaces ?? []).map(w => pathToFileURL(w).href)), "CASCADE_RUN_STATUS_IDLE", r.parent ?? "", r.depth ?? 0, 0, 0);
  db.close();
}

function installGlobalHook(store, gHome, env, prefix) {
  const inst = selfLoop(["hooks", "install", "--harness", "antigravity", "--scope", "global", "--owner-store", store], { cwd: realTemp(`${prefix}-inst-`), env });
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  const cmd = parseShellWords(JSON.parse(readFileSync(join(gHome, "config", "hooks.json"), "utf8"))["self-loop"].PreToolUse[0].hooks[0].command);
  const hookCwd = realTemp(`${prefix}-hook-cwd-`);
  return payload => spawnSync(cmd[0], cmd.slice(1), { input: JSON.stringify(payload), cwd: hookCwd, encoding: "utf8", env });
}

function runGuard(store, payload, env) {
  return spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--harness", "antigravity", "--owner-store", store], {
    input: JSON.stringify(payload), cwd: realTemp("ag-child-hook-cwd-"), encoding: "utf8", env,
  });
}

const hookPayload = ({ conversationId, transcriptPath, cwd, name, args }) => ({
  hookEventName: "PreToolUse", conversationId, ...(transcriptPath !== undefined ? { transcriptPath } : {}), cwd,
  toolCall: { id: "call_1", name, argumentsJson: JSON.stringify(args) },
});

function assertDeny(res, label) {
  assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
  let out;
  try { out = JSON.parse(res.stdout); }
  catch { assert.fail(`${label}: expected JSON deny on stdout, got ${JSON.stringify(res.stdout)} (stderr=${res.stderr})`); }
  assert.equal(out?.decision, "deny", `${label}: ${res.stdout}`);
  assert.match(String(out?.reason ?? ""), /^lead-guard:/, `${label}: ${res.stdout}`);
}

function assertAllow(res, label) {
  assert.equal(res.status, 0, `${label}: exit ${res.status}, stderr=${res.stderr}`);
  assert.equal(res.stdout, "", `${label}: expected empty pass-through, got ${JSON.stringify(res.stdout)}`);
}

const writeArgs = (path, content = "# output\n") => ({ Path: path, Content: content, Overwrite: true });
const editArgs = (path, Target = "export const app", Replacement = "export const app") => ({ Path: path, Target, Replacement });

test("AG-CHILD-01: confirmed reviewer and judge children can write own out/ while wt/, metadata, sibling workspaces, and product repo are denied", () => {
  const { alpha, store, appDir, env } = setupHarness("ag-child1");
  const rev = makeCallWorkspace(alpha, "0039-reviewer-architecture", { role: "reviewer", step: "reviewer-architecture", nonce: "a1a1b2b2c3c3d4d4", withWorktree: true });
  const revFrame = makeCallWorkspace(alpha, "0039-reviewer-frame", { role: "reviewer", step: "reviewer-frame", nonce: "b2b2c3c3d4d4e5e5", withWorktree: false });
  const judge = makeCallWorkspace(alpha, "0039-judge", { role: "judge", step: "judge", nonce: "e5e5f6f607071818", withWorktree: true });
  const sibling = makeCallWorkspace(alpha, "0039-actor-sibling", { role: "actor", step: "actor", nonce: "9999000011112222", withWorktree: true });

  const revTx = writeTranscript(appDir, "conv-rev", "transcript_full.jsonl", [userStep(0, wrapEnvelope(rev.step0))]);
  const revFrameTx = writeTranscript(appDir, "conv-rev-frame", "transcript_full.jsonl", [userStep(0, wrapEnvelope(revFrame.step0))]);
  const judgeTx = writeTranscript(appDir, "conv-judge", "transcript_full.jsonl", [userStep(0, wrapEnvelope(judge.step0))]);
  writeSummaryDb(appDir, ["conv-rev", "conv-rev-frame", "conv-judge"].map(id => ({ id, workspaces: [alpha.product], parent: "conv-lead", depth: 1 })));
  for (const [label, convId, tx, call] of [["reviewer-architecture", "conv-rev", revTx, rev], ["reviewer-frame", "conv-rev-frame", revFrameTx, revFrame], ["judge", "conv-judge", judgeTx, judge]]) {
    const callWrite = target => runGuard(store, hookPayload({ conversationId: convId, transcriptPath: tx, cwd: alpha.product, name: "write_file", args: writeArgs(target) }), env);
    assertAllow(callWrite(join(call.ws, "out", "report.md")), `${label} out/report.md`);
    for (const [sub, target] of [
      ["wt/src/app.js", join(call.wt ?? join(call.ws, "wt"), "src", "app.js")],
      ["call.json", join(call.ws, "call.json")],
      ["records/INDEX.md", join(call.ws, "records", "INDEX.md")],
      ["task.md", join(call.ws, "task.md")],
      ["sibling out/report.md", join(sibling.ws, "out", "report.md")],
      ["product src/app.js", join(alpha.product, "src", "app.js")],
    ]) assertDeny(callWrite(target), `${label} denied ${sub}`);
  }
});

test("AG-CHILD-02: confirmed critic and actor children can write own out/ and wt/ while escaping paths, git push, and unattested delegation are denied", () => {
  const { alpha, store, appDir, env } = setupHarness("ag-child2");
  const actor = makeCallWorkspace(alpha, "0039-actor", { role: "actor", step: "actor", nonce: "1122334455667788", withWorktree: true });
  const critic = makeCallWorkspace(alpha, "0039-critic", { role: "critic", step: "critic", nonce: "8877665544332211", withWorktree: true });
  const sibling = makeCallWorkspace(alpha, "0039-other", { role: "actor", step: "actor-b", nonce: "abcdef0123456789", withWorktree: true });

  const actorTx = writeTranscript(appDir, "conv-actor", "transcript_full.jsonl", [userStep(0, wrapEnvelope(actor.step0))]);
  const criticTx = writeTranscript(appDir, "conv-critic", "transcript_full.jsonl", [userStep(0, wrapEnvelope(critic.step0))]);
  writeSummaryDb(appDir, ["conv-actor", "conv-critic"].map(id => ({ id, workspaces: [alpha.product], parent: "conv-lead", depth: 1 })));
  for (const [label, convId, tx, call] of [["actor", "conv-actor", actorTx, actor], ["critic", "conv-critic", criticTx, critic]]) {
    const callTool = (cwd, name, args) => runGuard(store, hookPayload({ conversationId: convId, transcriptPath: tx, cwd, name, args }), env);
    assertAllow(callTool(alpha.product, "write_file", writeArgs(join(call.ws, "out", "report.md"))), `${label} write out/report.md`);
    assertAllow(callTool(alpha.product, "edit_file", editArgs(join(call.ws, "out", "report.md"))), `${label} edit out/report.md`);
    assertAllow(callTool(alpha.product, "write_file", writeArgs(join(call.wt, "src", "app.js"))), `${label} write wt/src/app.js`);
    assertAllow(callTool(alpha.product, "write_file", writeArgs(join(call.wt, "src", "new-feature.js"))), `${label} write untracked wt/src/new-feature.js`);
    assertAllow(callTool(alpha.product, "edit_file", editArgs(join(call.wt, "src", "app.js"))), `${label} edit wt/src/app.js`);

    for (const [sub, target] of [
      ["call.json", join(call.ws, "call.json")],
      ["records/INDEX.md", join(call.ws, "records", "INDEX.md")],
      ["brief.md", join(call.ws, "brief.md")],
      ["sibling wt/src/app.js", join(sibling.wt, "src", "app.js")],
      ["product src/app.js", join(alpha.product, "src", "app.js")],
    ]) assertDeny(callTool(alpha.product, "write_file", writeArgs(target)), `${label} denied ${sub}`);

    assertDeny(callTool(call.wt, "run_command", { CommandLine: "git push origin main" }), `${label} denied git push`);
    assertDeny(callTool(alpha.product, "mcp_t3-code_delegate_task", { task: "unattested sub-delegation" }), `${label} denied delegate_task without nonce`);
  }
});

test("AG-CHILD-03: owner, unresolved, truncated, corrupt, missing transcript, and nonce-quoting owner sessions fail closed", () => {
  const { alpha, store, appDir, env } = setupHarness("ag-child3");
  const actor = makeCallWorkspace(alpha, "0039-actor", { role: "actor", step: "actor", nonce: "2468135790abcdef", withWorktree: true });

  const ownerTx = writeTranscript(appDir, "conv-owner", "transcript_full.jsonl", [userStep(0, wrapEnvelope("Fix the bug in app.js"))]);
  const ownerQuoteTx = writeTranscript(appDir, "conv-owner-quote", "transcript_full.jsonl", [
    userStep(0, wrapEnvelope(`Check workspace status for nonce ${actor.nonce} before continuing`)),
  ]);
  const truncTx = writeTranscript(appDir, "conv-trunc", "transcript.jsonl", [
    userStep(0, "<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n<truncated 1200 bytes>", { truncated_fields: ["content"] }),
  ]);
  const corruptTx = writeTranscript(appDir, "conv-corrupt", "transcript_full.jsonl", [
    '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"<truncated',
  ]);
  const missingTx = join(appDir, "brain", "conv-missing", ".system_generated", "logs", "transcript_full.jsonl");
  writeSummaryDb(appDir, ["conv-owner", "conv-owner-quote", "conv-trunc", "conv-corrupt", "conv-missing"].map(id => ({ id, workspaces: [alpha.product] })));

  for (const [label, convId, tx] of [
    ["owner session", "conv-owner", ownerTx],
    ["owner quoting live nonce", "conv-owner-quote", ownerQuoteTx],
    ["truncated compact transcript", "conv-trunc", truncTx],
    ["corrupt jsonl transcript", "conv-corrupt", corruptTx],
    ["missing transcript path", "conv-missing", missingTx],
    ["omitted transcript path", "conv-omitted", undefined],
  ]) {
    assertDeny(runGuard(store, hookPayload({ conversationId: convId, transcriptPath: tx, cwd: alpha.product, name: "write_file", args: writeArgs(join(actor.ws, "out", "report.md")) }), env), `${label} out/report.md`);
    assertDeny(runGuard(store, hookPayload({ conversationId: convId, transcriptPath: tx, cwd: alpha.product, name: "write_file", args: writeArgs(join(actor.wt, "src", "app.js")) }), env), `${label} wt/src/app.js`);
  }
});

test("AG-CHILD-04: confirmed child with recorded, cancelled, or unmatched step-0 nonce fails closed", () => {
  const { alpha, store, appDir, env } = setupHarness("ag-child4");
  const recorded = makeCallWorkspace(alpha, "0039-actor-rec", { role: "actor", step: "actor", nonce: "1111222233334444", withWorktree: true, recorded: true });
  const cancelled = makeCallWorkspace(alpha, "0039-actor-can", { role: "actor", step: "actor-b", nonce: "5555666677778888", withWorktree: true, cancelled: true });
  const live = makeCallWorkspace(alpha, "0039-actor-live", { role: "actor", step: "actor-c", nonce: "9999aaaabbbbcccc", withWorktree: true });

  const recTx = writeTranscript(appDir, "conv-rec", "transcript_full.jsonl", [userStep(0, wrapEnvelope(recorded.step0))]);
  const canTx = writeTranscript(appDir, "conv-can", "transcript_full.jsonl", [userStep(0, wrapEnvelope(cancelled.step0))]);
  const noNonceTx = writeTranscript(appDir, "conv-no-nonce", "transcript_full.jsonl", [
    userStep(0, wrapEnvelope("Act as the test sub-agent for this task.\n\nself-loop call R-0039-actor-c without nonce")),
    userStep(1, wrapEnvelope(`Follow-up mentioning ${live.nonce}`), { created_at: "2026-11-25T01:01:00.000Z" }),
  ]);
  const staleNonceTx = writeTranscript(appDir, "conv-stale-nonce", "transcript_full.jsonl", [
    userStep(0, wrapEnvelope("Act as the test sub-agent for this task.\n\nself-loop call R-0039-actor-c · nonce deadbeefcafebabe")),
  ]);
  writeSummaryDb(appDir, ["conv-rec", "conv-can", "conv-no-nonce", "conv-stale-nonce"].map(id => ({ id, workspaces: [alpha.product], parent: "conv-lead", depth: 1 })));

  for (const [label, convId, tx, call] of [
    ["recorded call.json", "conv-rec", recTx, recorded],
    ["cancelled call.json", "conv-can", canTx, cancelled],
    ["no step-0 nonce", "conv-no-nonce", noNonceTx, live],
    ["unmatched step-0 nonce", "conv-stale-nonce", staleNonceTx, live],
  ]) {
    for (const [sub, target] of [
      ["out/report.md", join(call.ws, "out", "report.md")],
      ["wt/src/app.js", join(call.wt, "src", "app.js")],
      ["product src/app.js", join(alpha.product, "src", "app.js")],
    ]) assertDeny(runGuard(store, hookPayload({ conversationId: convId, transcriptPath: tx, cwd: alpha.product, name: "write_file", args: writeArgs(target) }), env), `${label} denied ${sub}`);
  }
});

test("AG-CHILD-05: multi-product owner-store scopes confirmed actor to bound workspace and blocks traversal and symlink escapes", () => {
  const { alpha, extras: [beta], store, appDir, env } = setupHarness("ag-child5", ["beta"]);
  const alphaActor = makeCallWorkspace(alpha, "0039-actor", { role: "actor", step: "actor", nonce: "aa11bb22cc33dd44", withWorktree: true });
  const betaActor = makeCallWorkspace(beta, "0039-actor", { role: "actor", step: "actor", nonce: "ee55ff6677889900", withWorktree: true });

  symlinkSync(beta.product, join(alphaActor.wt, "escape-beta"));
  symlinkSync(join(alphaActor.ws, "call.json"), join(alphaActor.ws, "out", "escape-call.json"));

  const alphaTx = writeTranscript(appDir, "conv-alpha-actor", "transcript_full.jsonl", [userStep(0, wrapEnvelope(alphaActor.step0))]);
  writeSummaryDb(appDir, [{ id: "conv-alpha-actor", workspaces: [alpha.product], parent: "conv-lead", depth: 1 }]);

  const callWrite = target => runGuard(store, hookPayload({ conversationId: "conv-alpha-actor", transcriptPath: alphaTx, cwd: alpha.product, name: "write_file", args: writeArgs(target) }), env);
  assertAllow(callWrite(join(alphaActor.ws, "out", "report.md")), "alpha actor own out/report.md");
  assertAllow(callWrite(join(alphaActor.wt, "src", "app.js")), "alpha actor own wt/src/app.js");

  const traverseBetaWt = join(alphaActor.wt, relative(alphaActor.wt, join(betaActor.wt, "src", "app.js")));
  for (const [label, target] of [
    ["out/../call.json traversal", join(alphaActor.ws, "out", "..", "call.json")],
    ["wt/../../betaWs/wt traversal", traverseBetaWt],
    ["wt symlink to beta product", join(alphaActor.wt, "escape-beta", "src", "app.js")],
    ["out symlink to call.json", join(alphaActor.ws, "out", "escape-call.json")],
    ["beta ws out/report.md", join(betaActor.ws, "out", "report.md")],
    ["beta wt src/app.js", join(betaActor.wt, "src", "app.js")],
    ["beta product src/app.js", join(beta.product, "src", "app.js")],
    ["alpha product src/app.js", join(alpha.product, "src", "app.js")],
  ]) assertDeny(callWrite(target), `alpha actor denied ${label}`);
});

test("AG-CHILD-06: bound child refuses all writes outside granted role dirs including lead-allowed tasks, records, product docs, and external paths", () => {
  const { alpha, store, appDir, env } = setupHarness("ag-child6");
  const outsideDir = realTemp("ag-child6-outside-");
  const rev = makeCallWorkspace(alpha, "0040-reviewer", { role: "reviewer", step: "reviewer-architecture", round: 40, nonce: "1020304050607080", withWorktree: true });
  const actor = makeCallWorkspace(alpha, "0040-actor", { role: "actor", step: "actor", round: 40, nonce: "8070605040302010", withWorktree: true });
  const revTx = writeTranscript(appDir, "conv-rev-6", "transcript_full.jsonl", [userStep(0, wrapEnvelope(rev.step0))]);
  const actorTx = writeTranscript(appDir, "conv-actor-6", "transcript_full.jsonl", [userStep(0, wrapEnvelope(actor.step0))]);
  const ownerTx = writeTranscript(appDir, "conv-owner-6", "transcript_full.jsonl", [userStep(0, wrapEnvelope("Update docs and dispatch next task"))]);
  writeSummaryDb(appDir, [["conv-rev-6", 1], ["conv-actor-6", 1], ["conv-owner-6", 0]].map(([id, depth]) => ({ id, workspaces: [alpha.product], parent: "conv-lead", depth })));

  const callWrite = (convId, tx, target) => runGuard(store, hookPayload({ conversationId: convId, transcriptPath: tx, cwd: alpha.product, name: "write_file", args: writeArgs(target) }), env);
  assertAllow(callWrite("conv-rev-6", revTx, join(rev.ws, "out", "report.md")), "reviewer out/report.md");
  assertAllow(callWrite("conv-actor-6", actorTx, join(actor.ws, "out", "report.md")), "actor out/report.md");
  assertAllow(callWrite("conv-actor-6", actorTx, join(actor.wt, "src", "app.js")), "actor wt/src/app.js");
  for (const [label, target] of [
    ["lead workDir/tasks/next.md", join(alpha.workDir, "tasks", "next.md")],
    ["lead product/docs/guide.md", join(alpha.product, "docs", "guide.md")],
    ["lead outsideDir/lead-note.txt", join(outsideDir, "lead-note.txt")],
  ]) assertAllow(callWrite("conv-owner-6", ownerTx, target), label);

  for (const [roleLabel, convId, tx] of [["reviewer", "conv-rev-6", revTx], ["actor", "conv-actor-6", actorTx]]) {
    for (const [sub, target] of [
      ["workDir/tasks/hijack.md", join(alpha.workDir, "tasks", "hijack.md")],
      ["records/rounds/0001-fake.md", join(alpha.records, "rounds", "0001-fake.md")],
      ["product/docs/README.md", join(alpha.product, "docs", "README.md")],
      ["product/README.md", join(alpha.product, "README.md")],
      ["outsideDir/escape.txt", join(outsideDir, "escape.txt")],
    ]) assertDeny(callWrite(convId, tx, target), `${roleLabel} denied ${sub}`);
  }
});

test("AG-CHILD-07: installed global PreToolUse allows embedded file:// URIs in write content while refusing out-of-scope structured destinations", () => {
  const { alpha, store, appDir, gHome, env } = setupHarness("ag-child7");
  const outsideDir = realTemp("ag-child7-outside-");
  const runInstalled = installGlobalHook(store, gHome, env, "ag-child7");

  const actor = makeCallWorkspace(alpha, "0041-actor", { role: "actor", step: "actor", round: 41, nonce: "1234567890abcdef", withWorktree: true });
  const rev = makeCallWorkspace(alpha, "0041-reviewer", { role: "reviewer", step: "reviewer-architecture", round: 41, nonce: "fedcba0987654321", withWorktree: true });
  const actorTx = writeTranscript(appDir, "conv-actor-7", "transcript_full.jsonl", [userStep(0, wrapEnvelope(actor.step0))]);
  const revTx = writeTranscript(appDir, "conv-rev-7", "transcript_full.jsonl", [userStep(0, wrapEnvelope(rev.step0))]);
  const ownerTx = writeTranscript(appDir, "conv-owner-7", "transcript_full.jsonl", [userStep(0, wrapEnvelope("Update docs with file:// links"))]);
  writeSummaryDb(appDir, [["conv-actor-7", 1], ["conv-rev-7", 1], ["conv-owner-7", 0]].map(([id, depth]) => ({ id, workspaces: [alpha.product], parent: "conv-lead", depth })));

  const recUri = pathToFileURL(join(alpha.records, "rounds", "0001.md")).href;
  const docUri = pathToFileURL(join(alpha.product, "docs", "foo.md")).href;
  const scriptUri = pathToFileURL(join(alpha.product, "scripts", "foo.mjs")).href;
  const extUri = "file:///tmp/outside.txt";
  const body = `See [round](${recUri}), [doc](${docUri}), [script](${scriptUri}), and ${extUri}.\n`;
  const actorSample = join(actor.wt, "src", "sample.mjs");

  const callInstalled = (convId, tx, name, args) => runInstalled(hookPayload({ conversationId: convId, transcriptPath: tx, cwd: alpha.product, name, args }));

  assertAllow(callInstalled("conv-actor-7", actorTx, "write_file", writeArgs(actorSample, body)), "actor write_file wt/src/sample.mjs with embedded file:// URIs");
  assertAllow(callInstalled("conv-actor-7", actorTx, "write_file", writeArgs(join(actor.ws, "out", "report.md"), body)), "actor write_file out/report.md with embedded file:// URIs");
  assertAllow(callInstalled("conv-actor-7", actorTx, "edit_file", editArgs(actorSample, `// ${recUri}`, `// ${docUri} ${extUri}`)), "actor edit_file wt/src/sample.mjs with embedded file:// URIs");
  assertAllow(callInstalled("conv-actor-7", actorTx, "write_to_file", { TargetFile: actorSample, CodeContent: body }), "actor write_to_file wt/src/sample.mjs with embedded file:// URIs");
  assertAllow(callInstalled("conv-actor-7", actorTx, "replace_file_content", { TargetFile: actorSample, TargetContent: `// ${recUri}`, ReplacementContent: `// ${scriptUri} ${extUri}` }), "actor replace_file_content wt/src/sample.mjs with embedded file:// URIs");
  assertAllow(callInstalled("conv-actor-7", actorTx, "multi_replace_file_content", {
    TargetFile: actorSample,
    ReplacementChunks: [{ TargetContent: "const a = 1;", ReplacementContent: `// ${recUri} ${extUri}\nconst a = 2;` }],
  }), "actor multi_replace_file_content wt/src/sample.mjs with embedded file:// URIs");
  assertAllow(callInstalled("conv-rev-7", revTx, "write_file", writeArgs(join(rev.ws, "out", "report.md"), `See [notes](${scriptUri}) and [round](${recUri}) and ${extUri}.\n`)), "reviewer write_file out/report.md with embedded file:// links");
  assertAllow(callInstalled("conv-owner-7", ownerTx, "write_file", writeArgs(join(alpha.product, "docs", "guide.md"), `Ref [app](${pathToFileURL(join(alpha.product, "src", "app.js")).href})\n`)), "owner write_file docs/guide.md with embedded file:// link");

  const tasksTarget = join(alpha.workDir, "tasks", "hijack.md");
  const recordsTarget = join(alpha.records, "rounds", "0001.md");
  const scriptsTarget = join(alpha.product, "scripts", "foo.mjs");
  const outsideTarget = join(outsideDir, "outside.txt");
  for (const [roleLabel, convId, tx, safeTarget] of [["actor", "conv-actor-7", actorTx, actorSample], ["reviewer", "conv-rev-7", revTx, join(rev.ws, "out", "report.md")]]) {
    for (const [caseLabel, name, args] of [
      ["Path records", "write_file", writeArgs(recordsTarget)],
      ["Path tasks", "write_file", writeArgs(tasksTarget)],
      ["Path scripts", "write_file", writeArgs(scriptsTarget)],
      ["Path outside", "write_file", writeArgs(outsideTarget)],
      ["Path /tmp", "write_file", writeArgs("/tmp/ag-child7-outside.txt")],
      ["TargetFile records", "write_to_file", { TargetFile: recordsTarget, CodeContent: "x\n" }],
      ["file_path scripts", "edit_file", { file_path: scriptsTarget, Target: "a", Replacement: "b" }],
      ["file:// Path tasks", "write_file", writeArgs(pathToFileURL(tasksTarget).href)],
      ["file:// TargetFile records", "replace_file_content", { TargetFile: pathToFileURL(recordsTarget).href, TargetContent: "a", ReplacementContent: "b" }],
      ["file:// paths array outside", "write_file", { Path: safeTarget, Content: "x\n", paths: [pathToFileURL(outsideTarget).href] }],
    ]) assertDeny(callInstalled(convId, tx, name, args), `${roleLabel} denied ${caseLabel}`);
  }
  assertDeny(callInstalled("conv-rev-7", revTx, "write_file", writeArgs(join(rev.wt, "src", "sample.mjs"))), "reviewer denied wt/src/sample.mjs");
});

function setupReviewerHarness(prefix, round) {
  const ctx = setupHarness(prefix);
  mkdirSync(join(ctx.alpha.records, "engines"), { recursive: true });
  for (const rel of [BRIEFS.shared, BRIEFS.reviewer]) writeFileSync(join(ctx.alpha.records, rel), `# ${rel}\n`);
  const loopPath = join(ctx.alpha.records, "loop.json");
  const loopCfg = JSON.parse(readFileSync(loopPath, "utf8"));
  loopCfg.agents.reviewer = { runner: "t3", provider: "antigravity", model: "gemini-2.5-pro" };
  writeFileSync(loopPath, `${JSON.stringify(loopCfg, null, 2)}\n`);
  git(ctx.alpha.records, "add", BRIEFS.shared, BRIEFS.reviewer, "loop.json");
  git(ctx.alpha.records, "commit", "-qm", "configure antigravity reviewer");

  const runInstalled = installGlobalHook(ctx.store, ctx.gHome, ctx.env, prefix);
  const taskFile = join(realTemp(`${prefix}-task-`), "task.md");
  writeFileSync(taskFile, "# Diagnosis task\n\nfeatures: none\n");
  const runCall = (...args) => spawnSync(process.execPath, [join(scripts, "call.mjs"), loopPath, ...args], { cwd: ctx.alpha.product, encoding: "utf8", env: ctx.env });
  const prepStep = step => {
    const res = runCall("reviewer", "--round", String(round), "--step", step, "--task", taskFile, "--prepare");
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const prep = JSON.parse(res.stdout);
    assert.equal(prep.wt, null, `${step} must be confined with wt: null`);
    return prep;
  };
  const completeRows = (prompt, calls) => [
    userStep(0, wrapEnvelope(`[T3 Code: the agent in T3 thread "0dda5e1c-c733-4d0a-8128-bb21179d5a29" sent this message, not the user.]\n\nAct as the test sub-agent for this task.\n\n${prompt}`)),
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T01:00:02.000Z", model: "gemini-2.5-pro", tool_calls: calls.map((c, i) => ({ id: `call_${i + 1}`, name: c.name, argumentsJson: JSON.stringify(c.args) })) },
    ...calls.map((_, i) => ({ step_index: i + 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-25T01:00:03.000Z" })),
    { step_index: calls.length + 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-25T01:00:05.000Z", model: "gemini-2.5-pro", content: "done" },
  ];
  return { ...ctx, runInstalled, runCall, prepStep, completeRows };
}

test("AG-CHILD-08: end-to-end confined reviewer prepare -> installed PreToolUse -> call.mjs record admits embedded file:// URIs while blocking forbidden structured and URL-tool targets", () => {
  const { alpha, appDir, runInstalled, runCall, prepStep, completeRows } = setupReviewerHarness("ag-child8", 42);
  const scriptsPath = join(alpha.product, "scripts", "foo.mjs");
  const scriptUri = pathToFileURL(scriptsPath).href;
  const recUri = pathToFileURL(join(alpha.records, "rounds", "0001.md")).href;
  const extUri = "file:///tmp/outside.txt";
  const reportBody = `# Diagnosis\n\nSee [script](${scriptUri}), [round](${recUri}), and ${extUri}.\n`;

  writeSummaryDb(appDir, ["conv-rev-ok", "conv-rev-bad-read", "conv-rev-bad-write", "conv-rev-bad-url"].map(id => ({ id, workspaces: [alpha.product] })));

  const okPrep = prepStep("reviewer-diagnosis");
  const reportFile = join(okPrep.ws, "out", "report.md");
  const okRows = completeRows(okPrep.prompt, [{ name: "write_file", args: writeArgs(reportFile, reportBody) }]);
  const okTx = writeTranscript(appDir, "conv-rev-ok", "transcript_full.jsonl", [okRows[0]]);
  assertAllow(runInstalled(hookPayload({ conversationId: "conv-rev-ok", transcriptPath: okTx, cwd: alpha.product, name: "write_file", args: writeArgs(reportFile, reportBody) })), "hook allows report.md with embedded file:// URIs");
  writeFileSync(reportFile, reportBody);
  writeTranscript(appDir, "conv-rev-ok", "transcript_full.jsonl", okRows);
  const okRec = runCall("record", "--ws", okPrep.ws, "--session", "conv-rev-ok");
  assert.equal(okRec.status, 0, okRec.stdout + okRec.stderr);
  const handoff = JSON.parse(okRec.stdout);
  assert.equal(handoff.audit.violations, 0);
  assert.equal(handoff.audit.flags, 0);
  const okAudit = JSON.parse(git(alpha.records, "show", `HEAD:${handoff.audit.file}`));
  assert.deepEqual(okAudit.violations, []);
  assert.deepEqual(okAudit.flags, []);

  for (const [step, convId, name, args] of [
    ["reviewer-diagnosis-b", "conv-rev-bad-read", "read_file", { Path: scriptsPath }],
    ["reviewer-diagnosis-c", "conv-rev-bad-write", "write_file", writeArgs(scriptUri, "x\n")],
    ["reviewer-diagnosis-d", "conv-rev-bad-url", "open_url", { url: scriptUri }],
  ]) {
    const badPrep = prepStep(step);
    writeFileSync(join(badPrep.ws, "out", "report.md"), "# Diagnosis\n");
    const rows = completeRows(badPrep.prompt, [{ name, args }]);
    writeTranscript(appDir, convId, "transcript_full.jsonl", rows);
    const badRec = runCall("record", "--ws", badPrep.ws, "--session", convId);
    assert.equal(badRec.status, 6, `${step}: expected exit 6, got ${badRec.status} (${badRec.stdout}${badRec.stderr})`);
    const badAudit = JSON.parse(git(alpha.records, "show", `HEAD:evidence/0042/${step}-1-audit.json`));
    assert.ok(badAudit.violations.some(v => v.tool === name && v.path === scriptsPath), `${step}: expected ${name} violation on ${scriptsPath}`);
    if (name === "open_url") {
      const nonConfined = auditAccess([badPrep.ws], rows.map(event => ({ id: convId, event })), { tools: null, cwd: alpha.product });
      assert.ok(nonConfined.violations.some(v => v.tool === "open_url" && v.path === scriptsPath), "non-file URL tool must still trigger violation under tools: null");
    }
  }
});

test("AG-CHILD-09: confined Antigravity reviewer admits in-scope view_file_outline and view_code_item while refusing out-of-scope, missing-target, and opaque tools", () => {
  const { alpha, appDir, runCall, prepStep, completeRows } = setupReviewerHarness("ag-child9", 43);
  const outOfScopeFile = join(alpha.product, "src", "app.js");
  writeSummaryDb(appDir, [
    "conv-rev9-ok", "conv-rev9-outline-out", "conv-rev9-item-file-out", "conv-rev9-item-abs-out",
    "conv-rev9-outline-missing", "conv-rev9-item-missing", "conv-rev9-opaque",
  ].map(id => ({ id, workspaces: [alpha.product] })));

  const okPrep = prepStep("reviewer-diagnosis");
  const reportFile = join(okPrep.ws, "out", "report.md");
  writeFileSync(reportFile, "# Diagnosis\n\nInspected brief and task.\n");
  writeTranscript(appDir, "conv-rev9-ok", "transcript_full.jsonl", completeRows(okPrep.prompt, [
    { name: "view_file_outline", args: { AbsolutePath: join(okPrep.ws, "brief.md") } },
    { name: "view_code_item", args: { File: join(okPrep.ws, "task.md"), NodePaths: ["Task"] } },
    { name: "view_code_item", args: { AbsolutePath: join(okPrep.ws, "records", "INDEX.md"), NodePaths: ["Index"] } },
    { name: "write_file", args: writeArgs(reportFile, "# Diagnosis\n\nInspected brief and task.\n") },
  ]));
  const okRec = runCall("record", "--ws", okPrep.ws, "--session", "conv-rev9-ok");
  assert.equal(okRec.status, 0, okRec.stdout + okRec.stderr);
  const handoff = JSON.parse(okRec.stdout);
  assert.equal(handoff.audit.violations, 0);
  assert.equal(handoff.audit.flags, 0);
  const okAudit = JSON.parse(git(alpha.records, "show", `HEAD:${handoff.audit.file}`));
  assert.deepEqual(okAudit.violations, []);
  assert.deepEqual(okAudit.flags, []);

  for (const [step, convId, name, argsFn, expectedPath] of [
    ["reviewer-diagnosis-b", "conv-rev9-outline-out", "view_file_outline", () => ({ AbsolutePath: outOfScopeFile }), outOfScopeFile],
    ["reviewer-diagnosis-c", "conv-rev9-item-file-out", "view_code_item", () => ({ File: outOfScopeFile, NodePaths: ["app"] }), outOfScopeFile],
    ["reviewer-diagnosis-d", "conv-rev9-item-abs-out", "view_code_item", () => ({ AbsolutePath: outOfScopeFile, NodePaths: ["app"] }), outOfScopeFile],
    ["reviewer-diagnosis-e", "conv-rev9-outline-missing", "view_file_outline", () => ({ Offset: 0 }), null],
    ["reviewer-diagnosis-f", "conv-rev9-item-missing", "view_code_item", () => ({ NodePaths: ["app"] }), null],
    ["reviewer-diagnosis-g", "conv-rev9-opaque", "opaque_custom_tool", ws => ({ Path: join(ws, "brief.md") }), "(tool not allowed)"],
  ]) {
    const badPrep = prepStep(step);
    writeFileSync(join(badPrep.ws, "out", "report.md"), "# Diagnosis\n");
    writeTranscript(appDir, convId, "transcript_full.jsonl", completeRows(badPrep.prompt, [{ name, args: argsFn(badPrep.ws) }]));
    const badRec = runCall("record", "--ws", badPrep.ws, "--session", convId);
    assert.equal(badRec.status, 6, `${step}: expected exit 6, got ${badRec.status} (${badRec.stdout}${badRec.stderr})`);
    const badAudit = JSON.parse(git(alpha.records, "show", `HEAD:evidence/0043/${step}-1-audit.json`));
    if (expectedPath === null) assert.ok(badAudit.unparsedCalls > 0 || badAudit.violations.some(v => v.tool === name), `${step}: missing structured path must fail closed`);
    else assert.ok(badAudit.violations.some(v => v.tool === name && v.path === expectedPath), `${step}: expected ${name} violation on ${expectedPath}`);
  }
});
