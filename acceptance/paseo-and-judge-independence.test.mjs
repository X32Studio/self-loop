// F-0008, F-0009, F-0010, D-0016, D-0062, D-0063, R-0044-reviewer-architecture
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { auditAccess } from "../scripts/audit-access.mjs";
import { EXIT } from "../scripts/call.mjs";
import { antigravitySessionState, antigravityTranscript } from "../scripts/lib/antigravity-words.mjs";
import { hasConvergence } from "../scripts/lib/ci.mjs";
import { parseHandoffs } from "../scripts/lib/handoff.mjs";
import { captureOwnerText, isSubstantiveOwnerWord, ownerPrompt } from "../scripts/lib/owner-words.mjs";
import { verifyProvenance, verifyWaveGate } from "../scripts/lib/provenance.mjs";
import { t3Prompt } from "../scripts/lib/t3-child.mjs";
import { blockerState } from "../scripts/lib/blockers.mjs";
import { vendorOfModel, waveIndependenceProblem } from "../scripts/lib/vendor.mjs";
import { closeWindow, openWindow, WindowRefusalError } from "../scripts/lib/window.mjs";
import { BRIEFS, git, isolatedEnv, loopProduct, ownerStore, repo, scripts, temp } from "../scripts/test/helpers.mjs";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
const realTemp = prefix => realpathSync(temp(prefix));
const json = v => JSON.stringify(v, null, 2) + "\n";
const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const mkRepo = (files, dir) => { mkdirSync(dir, { recursive: true }); return repo(files, dir); };
const t3Ag = (model = "gemini-2.5-flash") => ({ runner: "t3", provider: "antigravity", model, effort: "high" });
const userStep = (step_index, content, extra = {}) => ({ step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-26T01:00:00.000Z", content, ...extra });
const escapePaseoXml = (s, single = "&apos;") => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", single);
const wrapUserReq = inner => `<USER_REQUEST>\n${inner}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026-11-26\n</ADDITIONAL_METADATA>`;
const wrapPaseoMsg = (body, { kind = "agent-message", escape = true, single = "&apos;" } = {}) => `<paseo-system version="1" kind="${kind}" source-agent-id="lead-1" message-id="msg-1">\n${escape ? escapePaseoXml(body, single) : body}\n</paseo-system>`;
const put = (root, rel, content) => { const file = join(root, rel); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content); return file; };

function writeSummaryDb(appDir, rows) {
  mkdirSync(appDir, { recursive: true });
  const db = new DatabaseSync(join(appDir, "conversation_summaries.db"));
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_summaries (conversation_id TEXT PRIMARY KEY, workspace_uris TEXT, status TEXT, parent_conversation_id TEXT DEFAULT '', nesting_depth INTEGER DEFAULT 0, killed INTEGER DEFAULT 0, not_fully_idle INTEGER DEFAULT 0)`);
  const stmt = db.prepare(`INSERT OR REPLACE INTO conversation_summaries (conversation_id, workspace_uris, status, parent_conversation_id, nesting_depth, killed, not_fully_idle) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) stmt.run(r.id, JSON.stringify((r.workspaces ?? []).map(w => pathToFileURL(w).href)), r.status ?? "CASCADE_RUN_STATUS_IDLE", r.parent ?? "", r.depth ?? 0, r.killed ?? 0, r.notFullyIdle ?? 0);
  db.close();
}

function writeTranscript(appDir, id, rows, name = "transcript_full.jsonl") {
  const file = join(appDir, "brain", id, ".system_generated", "logs", name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rows.map(r => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
  return file;
}

const runNode = (script, args, { env = process.env, input = undefined, cwd = undefined } = {}) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", env, input, cwd });

function makeCallWorld(t, { withReviewer = false } = {}) {
  const dir = realTemp("paseo-call-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const product = mkRepo({ "src/a.js": "export const a = 1;\n", "test/a.test.js": "import test from 'node:test';\n" }, join(dir, "product"));
  git(product, "branch", "loop/v1");
  const sealed = mkRepo({ "case-01.mjs": "export default 1;\n" }, join(dir, "sealed")), briefFiles = Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief.\n`]));
  const plan = ["# PL-0001 Plan", "scope: paseo/r44", "phase: v1", "", "## actor", "role: actor", "handoff: R-0001-actor", "authority: D-0062", "goal: Actor", "files: src/**", "interface: fixed", "acceptance: pass", "needs: ", "", "## critic", "role: critic", "handoff: R-0001-critic", "authority: D-0062", "goal: Critic", "files: test/**", "interface: fixed", "acceptance: pass", "needs: ", "reviews: actor", "", "## judge", "role: judge", "handoff: R-0001-judge", "authority: D-0062", "goal: Judge", "files: ", "interface: fixed", "acceptance: pass", "needs: critic", ""].join("\n");
  const records = mkRepo({ "README.md": "# records\n", "records.json": "{}\n", "purpose/P-0001.md": "# P-0001 Purpose\n", "decisions/D-0062.md": "# D-0062 Policy\n\nid: D-0062\nby: owner\nstatus: active\n", "blueprint/F-0008.md": "# F-0008 Paseo\n\nid: F-0008\nphase: v1\nrequirements: P-0001\n", "metrics/blueprint.jsonl": jsonl({ feature: "F-0008", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "start", evidence: {} }), "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n", "metrics/handoffs.jsonl": jsonl({ id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"], view: "f".repeat(40), attempt: 1, agent: { runner: "antigravity" }, product: null, audit: { violations: 0 } }), "plans/PL-0001.md": plan, ...briefFiles }, join(dir, "records"));
  const workDir = join(dir, "work"), appDir = join(dir, "ag-app"), gHome = join(dir, "ag-gemini"), loadDir = join(dir, "load");
  for (const d of [workDir, appDir, gHome, loadDir]) mkdirSync(d, { recursive: true });
  const cfgPath = join(dir, "loop.json");
  writeFileSync(cfgPath, json({ product, branch: "loop/v1", records, phase: "v1", workDir, briefs: BRIEFS, sealed: [sealed], purpose: ["src/a.js"], owns: { critic: ["test"], actor: ["src"] }, protected: ["main"], agents: { critic: t3Ag("gemini-2.5-flash"), actor: t3Ag("gemini-2.5-flash"), judge: t3Ag("gemini-2.5-pro"), reviewer: withReviewer ? t3Ag("gemini-2.5-pro") : { runner: "cmd", cmd: ["true"] } } }));
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: gHome, T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: loadDir });
  const prepare = (role, taskBody, extra = []) => {
    const tf = join(dir, `task-${role}-${Date.now()}-${Math.random().toString(16).slice(2)}.md`); writeFileSync(tf, taskBody);
    const res = runNode("call.mjs", [cfgPath, role, "--round", "1", "--task", tf, ...extra, "--prepare"], { env });
    assert.equal(res.status, 0, res.stderr + res.stdout); return JSON.parse(res.stdout);
  };
  const record = (ws, session, transcript = null) => runNode("call.mjs", [cfgPath, "record", "--ws", ws, "--session", session, ...(transcript ? ["--transcript", transcript] : [])], { env });
  const handoffs = () => parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")).filter(h => h.step !== "reviewer-frame");
  return { dir, product, records, cfgPath, appDir, env, prepare, record, handoffs };
}

test("[Paseo-01] call.mjs --prepare -> Paseo kind=agent-message unescapes single-pass verbatim and rejects forged/non-agent-message envelopes [loss: wrong-result / disclosure]", t => {
  const w = makeCallWorld(t, { withReviewer: true });
  const prepOk = w.prepare("actor", "features: F-0008\ncheck && <tag attr=\"v\" single='s'> literal &lt;paseo-system&gt; &amp;lt; &amp;amp; </paseo-system>\n", ["--plan", "PL-0001", "--package", "actor"]);
  writeFileSync(join(prepOk.ws, "out", "report.md"), "Actor report.\n");
  writeSummaryDb(w.appDir, [{ id: "conv-ok", workspaces: [prepOk.wt] }]);
  writeTranscript(w.appDir, "conv-ok", [userStep(0, wrapUserReq(wrapPaseoMsg(prepOk.prompt, { kind: "agent-message", escape: true, single: "&#39;" }))), { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model: "gemini-2.5-flash" }]);
  assert.equal(w.record(prepOk.ws, "conv-ok").status, 0);
  assert.deepEqual([w.handoffs().length, w.handoffs()[0].audit.violations], [1, 0]);
  const prepRev = w.prepare("reviewer", "Review plain ASCII task.\nfeatures: none\n");
  assert.equal(/[&<>"]/.test(prepRev.prompt), false);
  writeFileSync(join(prepRev.ws, "out", "report.md"), "VERDICT: CONTINUE\n");
  const mutatedPrompt = prepRev.prompt.replace("Write your report to out/report.md.", "Write your report to out/tampered.md.");
  assert.notEqual(mutatedPrompt, prepRev.prompt);
  for (const [label, step0Content] of [
    ["notif", wrapUserReq(wrapPaseoMsg(prepRev.prompt, { kind: "agent-notification", escape: false }))],
    ["trailing", wrapUserReq(`${wrapPaseoMsg(prepRev.prompt, { escape: false })} trailing`)],
    ["concat", wrapUserReq(`${wrapPaseoMsg("A", { escape: false })}${wrapPaseoMsg(prepRev.prompt, { escape: false })}`)],
    ["unclosed", wrapUserReq(`<paseo-system version="1" kind="agent-message">\n${prepRev.prompt}`)],
    ["mutated", wrapUserReq(wrapPaseoMsg(mutatedPrompt, { escape: false }))],
  ]) {
    const cid = `conv-bad-${label}`;
    writeSummaryDb(w.appDir, [{ id: cid, workspaces: [prepRev.ws] }]);
    const tx = writeTranscript(w.appDir, cid, [userStep(0, step0Content), { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model: "gemini-2.5-pro" }]);
    assert.equal(w.record(prepRev.ws, cid).status, label === "mutated" ? EXIT.records : EXIT.failure, `${label}: expected refusal`);
    assert.equal(w.record(prepRev.ws, cid, tx).status, EXIT.records, `${label} --transcript: expected exit ${EXIT.records}`);
  }
  assert.equal(w.handoffs().length, 1);
});

test("[Paseo-02] lead-guard.mjs and audit-access.mjs gate Paseo create_agent, allow Lead send_agent_prompt, confine Paseo children, and block Paseo MCP in role transcripts [loss: disclosure / false-verdict]", t => {
  const dir = realTemp("paseo-guard-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alpha = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "alpha") }), beta = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "beta") }), storeDir = join(dir, "store");
  mkdirSync(storeDir, { recursive: true });
  const store = ownerStore([{ name: "alpha", records: alpha.records }, { name: "beta", records: beta.records }], { dir: storeDir }), appDir = join(dir, "ag-app");
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: join(dir, "g"), T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: join(dir, "load") });
  const ws = join(alpha.dir, "work", "0001-actor"), wt = join(ws, "wt"), nonce = "a1b2c3d4e5f60718";
  mkdirSync(join(ws, "out"), { recursive: true }); git(alpha.product, "worktree", "add", "-q", "--detach", wt);
  writeFileSync(join(ws, "call.json"), json({ version: 2, role: "actor", round: 1, step: "actor", phase: "v1", id: "R-0001-actor", record: "rounds/0001-actor.md", ws, wt, nonce }));
  const childTx = writeTranscript(appDir, "conv-paseo-child", [userStep(0, wrapUserReq(wrapPaseoMsg(`Act as the actor.\n\nself-loop call R-0001-actor · nonce ${nonce}\n- Your working folder: ${ws}\n- The product worktree: ${wt}\n`)))]);
  writeSummaryDb(appDir, [{ id: "conv-paseo-child", workspaces: [wt] }]);
  const guard = p => runNode("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", store], { env, cwd: dir, input: JSON.stringify(p) });
  const assertDeny = (p, l) => { const r = guard(p); assert.equal(r.status, 0, l); assert.equal(JSON.parse(r.stdout || "{}").decision, "deny", l); };
  const assertAllow = (p, l) => { const r = guard(p); assert.equal(r.status, 0, l); assert.equal(r.stdout.trim(), "", l); };
  for (const tool of ["mcp_paseo_create_agent", "mcp__paseo__create_agent"]) {
    assertDeny({ hookEventName: "PreToolUse", conversationId: "lead-conv", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ initialPrompt: "unprepared prompt" }) } }, `${tool} bad`);
    assertDeny({ hookEventName: "PreToolUse", conversationId: "lead-conv", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ initialPrompt: "" }) } }, `${tool} empty`);
    assertDeny({ hookEventName: "PreToolUse", conversationId: "lead-conv", cwd: alpha.product, toolCall: { name: tool, argumentsJson: "{}" } }, `${tool} missing`);
    assertAllow({ hookEventName: "PreToolUse", conversationId: "lead-conv", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ initialPrompt: `self-loop call R-0001-actor · nonce ${nonce}` }) } }, `${tool} ok`);
  }
  for (const tool of ["mcp_paseo_send_agent_prompt", "mcp__paseo__send_agent_prompt"]) {
    assertAllow({ hookEventName: "PreToolUse", conversationId: "lead-conv", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ agentId: "beta-lead", prompt: "Coordinate." }) } }, tool);
  }
  assertAllow({ hookEventName: "PreToolUse", conversationId: "conv-paseo-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(ws, "out", "report.md"), CodeContent: "ok" }) } }, "child out");
  assertAllow({ hookEventName: "PreToolUse", conversationId: "conv-paseo-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(wt, "src", "a.js"), CodeContent: "ok" }) } }, "child wt");
  assertDeny({ hookEventName: "PreToolUse", conversationId: "conv-paseo-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(alpha.product, "src", "a.js"), CodeContent: "bad" }) } }, "child prod");
  assertDeny({ hookEventName: "PreToolUse", conversationId: "conv-paseo-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(beta.product, "src", "a.js"), CodeContent: "bad" }) } }, "child sib");
  assertDeny({ hookEventName: "PreToolUse", conversationId: "conv-paseo-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(ws, "call.json"), CodeContent: "{}" }) } }, "child call.json");

  const cw = makeCallWorld(t, { withReviewer: true }), prepCritic = cw.prepare("critic", "features: F-0008\nAudit Paseo MCP refusal.\n", ["--plan", "PL-0001", "--package", "critic"]);
  writeFileSync(join(prepCritic.ws, "out", "report.md"), "Critic report.\n");
  writeSummaryDb(cw.appDir, [{ id: "conv-critic-mcp", workspaces: [prepCritic.wt] }]);
  writeTranscript(cw.appDir, "conv-critic-mcp", [userStep(0, wrapUserReq(wrapPaseoMsg(prepCritic.prompt))), { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model: "gemini-2.5-flash", tool_calls: [{ name: "mcp_paseo_create_agent", args: { initialPrompt: "hijack" } }] }, { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: "2026-11-26T01:00:06Z" }, { step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:07Z", model: "gemini-2.5-flash" }]);
  assert.equal(cw.record(prepCritic.ws, "conv-critic-mcp").status, EXIT.violation);
  for (const toolName of ["mcp_paseo_create_agent", "mcp_paseo_send_agent_prompt", "mcp__paseo__list_agents"]) {
    assert.ok(auditAccess([prepCritic.ws], [{ id: "R-0001-role", event: { type: "PLANNER_RESPONSE", tool_calls: [{ name: toolName, args: {} }] } }], { cwd: prepCritic.ws }).violations.some(v => v.tool === toolName));
  }
});

test("[Paseo-03] owner-words filters single/batched <paseo-system> envelopes, keeps Lead sessions open for Step 1+ human turns, and preserves human prose mentioning <paseo-system> [loss: stuck / data]", t => {
  const notifFinished = `<paseo-system version="1" kind="agent-notification" agent-id="a1" status="finished">\nAgent finished.\n</paseo-system>`, notifPerm = `<paseo-system version="1" kind="agent-notification" agent-id="a2" status="permission-required">\nApprove tool.\n</paseo-system>`, notifClosed = `<paseo-system version="1" kind="agent-notification" agent-id="a3" status="closed">\nSession closed.\n</paseo-system>`, leadMsg = `<paseo-system version="1" kind="agent-message" source-agent-id="lead-beta">\nWave status ping.\n</paseo-system>`, batched = `${notifFinished}\n${notifClosed}`;
  for (const sample of [notifFinished, notifPerm, notifClosed, leadMsg, batched]) assert.deepEqual([ownerPrompt(sample), captureOwnerText(sample), isSubstantiveOwnerWord(sample)], [null, null, false]);
  const humanProseA = "<paseo-system> 标签里的通知要过滤", humanProseB = "<paseo-system kind=\"agent-message\">x</paseo-system> 这种要过滤";
  for (const sample of [humanProseA, humanProseB]) assert.deepEqual([ownerPrompt(sample)?.text, captureOwnerText(sample), isSubstantiveOwnerWord(sample)], [sample, sample, true]);
  const dir = realTemp("paseo-words-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prod = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "prod") }), prodStoreDir = join(dir, "store"); mkdirSync(prodStoreDir, { recursive: true });
  const store = ownerStore([{ name: "prod", records: prod.records }], { dir: prodStoreDir }), appDir = join(dir, "ag-app"), env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: join(dir, "g"), T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: join(dir, "load") }), humanTurn = "Keep vendor as the default independence mode.";
  const leadTranscript = writeTranscript(appDir, "lead-paseo-session", [userStep(0, wrapUserReq(leadMsg)), userStep(1, wrapUserReq(batched)), userStep(2, wrapUserReq(humanTurn)), userStep(3, wrapUserReq(humanProseA))]);
  writeSummaryDb(appDir, [{ id: "lead-paseo-session", workspaces: [prod.product] }]);
  assert.deepEqual(antigravityTranscript(leadTranscript).words.map(w => w.text), [humanTurn, humanProseA]);
  assert.equal(runNode("owner-words.mjs", ["sync", "--owner-store", store], { env, cwd: dir }).status, 0);
  const wordsJsonl = readFileSync(join(prod.records, "owner", "words.jsonl"), "utf8");
  assert.ok(/Keep vendor as the default independence mode\./.test(wordsJsonl) && /<paseo-system> 标签里的通知要过滤/.test(wordsJsonl) && !/Wave status ping|Agent finished|Session closed/.test(wordsJsonl));
  const deny = JSON.parse(runNode("lead-guard.mjs", ["--harness", "antigravity", "--owner-store", store], { env, cwd: dir, input: JSON.stringify({ hookEventName: "PreToolUse", conversationId: "lead-paseo-session", transcriptPath: leadTranscript, cwd: prod.product, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(prod.product, "src", "a.js"), CodeContent: "x" }) } }) }).stdout || "{}");
  assert.ok(deny.decision === "deny" && /The lead does not write product code/.test(deny.reason) && !/outside delegated child workspace scope/.test(deny.reason));
});

test("[R44-4-plain+R47-ATK-06] plain Step-0 [lead -> lead] and natural task-file owner prompts stay owner while plain and Paseo-wrapped structural child headers stay confirmed-child [loss: data / disclosure]", t => {
  const dir = realTemp("r47-words-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const prod = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "prod") }), storeDir = join(dir, "store"); mkdirSync(storeDir, { recursive: true });
  const store = ownerStore([{ name: "prod", records: prod.records }], { dir: storeDir }), appDir = join(dir, "ag-app"), appDir2 = join(dir, "ag-app-2"), env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: join(dir, "g"), T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: join(dir, "load") }), ws = join(prod.dir, "work", "0046-actor"), wt = join(ws, "wt"), nonce = "0123456789abcdef";
  mkdirSync(ws, { recursive: true }); git(prod.product, "worktree", "add", "-q", "--detach", wt);
  const ownerWord = "Add a rollback checkpoint before promoting v0.9.3.";
  const leadTx = writeTranscript(appDir, "lead-plain-conv", [userStep(0, wrapUserReq("[lead → lead] Please compare the <paseo-system> example in the migration note with the release checklist.")), userStep(1, wrapUserReq(ownerWord))]);
  const taskFileTx = writeTranscript(appDir2, "owner-task-file", [userStep(0, "Your task is the file /ws/notes.md — please summarize it."), userStep(1, "Also check the release notes.")]);
  assert.equal(antigravitySessionState(taskFileTx, { summary: null }).state, "owner");
  assert.deepEqual(antigravityTranscript(taskFileTx).words.map(w => w.text), ["Your task is the file /ws/notes.md — please summarize it.", "Also check the release notes."]);
  const summaryRows = [{ id: "lead-plain-conv", workspaces: [prod.product] }], childChecks = [];
  for (const [label, body, checkWrapped] of [
    ["anchored-call", t3Prompt({ id: "R-0046-actor", nonce, wt, ws, text: "Close blockers." }), false],
    ["paseo", "Act as the actor.\n\nself-loop call R-0047-actor · nonce 0123456789abcdef\nDo work.", true],
    ["t3-notice", '[T3 Code: the agent in T3 thread "t1" sent this message, not the user.]\nProceed.', true],
    ["delegated-notice", "Delegated task node:delegated-task:1 (actor) [completed]: Done.", true],
    ["delegated-role", "Act as the critic sub-agent for this task.", true],
  ]) {
    const id = `child-${label}`; summaryRows.push({ id, workspaces: [wt] });
    childChecks.push([id, writeTranscript(appDir, id, [userStep(0, wrapUserReq(body)), userStep(1, wrapUserReq("Never capture child turn."))]), true]);
    if (checkWrapped) childChecks.push([`${id}-wrap`, writeTranscript(appDir2, `wrap-${label}`, [userStep(0, wrapPaseoMsg(body, { escape: false }))]), false]);
  }
  writeSummaryDb(appDir, summaryRows);
  assert.deepEqual([antigravitySessionState(leadTx, { conversationId: "lead-plain-conv" }).state, antigravitySessionState(leadTx, { conversationId: "lead-plain-conv" }).agent], ["owner", false]);
  assert.ok(antigravityTranscript(leadTx).words.some(w => w.text === ownerWord));
  assert.equal(runNode("owner-words.mjs", ["sync", "--owner-store", store], { env, cwd: dir }).status, 0);
  const wordsJsonl = readFileSync(join(prod.records, "owner", "words.jsonl"), "utf8");
  assert.ok(/Add a rollback checkpoint before promoting v0\.9\.3\./.test(wordsJsonl) && !/Never capture child turn/.test(wordsJsonl));
  for (const [id, tx, withSummary] of childChecks) {
    const st = antigravitySessionState(tx, withSummary ? { conversationId: id } : { summary: null });
    assert.ok(st.state === "confirmed-child" && st.agent === true && antigravityTranscript(tx).words.length === 0, id);
  }
});

function makePolicyWorld(t, { judgeIndependence = undefined, actorAgent, judgeAgent, modelVendors = undefined } = {}) {
  const dir = realTemp("paseo-policy-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const product = mkRepo({ "README.md": "# Policy\n", "VERSION": "0.1.0\n", "scripts/test/smoke.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n" }, join(dir, "product"));
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/policy.git");
  const addCommit = (p, c, m) => { put(product, p, c); git(product, "add", p); git(product, "commit", "-qm", m); return git(product, "rev-parse", "HEAD"); };
  const mid = addCommit("scripts/feature.mjs", "export const f = 1;\n", "Actor feature 1"), commit = addCommit("scripts/feature2.mjs", "export const f2 = 2;\n", "Actor feature 2");
  git(product, "branch", "-f", "loop/v1", commit);
  const tree = git(product, "rev-parse", `${commit}^{tree}`), loadDir = join(dir, "load"), records = join(dir, "records"), workDir = join(dir, "work"), bin = join(dir, "bin"), storeDir = join(dir, "store");
  for (const d of [loadDir, workDir, storeDir]) mkdirSync(d, { recursive: true });
  const criticObs = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4"] };
  const makeLoopObj = ji => ({
    product, records, workDir, branch: "loop/v1", phase: "v1", briefs: {}, agents: { actor: actorAgent, critic: criticObs, judge: judgeAgent },
    protected: ["main"], gates: { remote: "origin", require: ["github-actions/verify"], suite: "node --test scripts/test/smoke.test.mjs" },
    provenanceBaseline: baseline, ...(ji !== undefined ? { judgeIndependence: ji } : {}), ...(modelVendors ? { modelVendors } : {}),
  });
  const mkH = (id, round, step, role, agent, pBase, pCommit, rec, files, dispatch) => ({ id, time: "2026-11-26T01:00:00Z", phase: "v1", round, step, role, attempt: 1, agent, view: "a".repeat(40), product: { base: pBase, commit: pCommit }, audit: { violations: 0 }, record: rec, files, dispatch });
  const plan = ["# PL-0001 Plan", "scope: policy/v1", "phase: v1", "", "## actor-a", "role: actor", "handoff: R-0002-actor-a", "authority: D-0062", "goal: A", "files: scripts/feature.mjs", "interface: D-0062", "acceptance: pass", "needs: ", "", "## actor-b", "role: actor", "handoff: R-0003-actor-b", "authority: D-0062", "goal: B", "files: scripts/feature2.mjs", "interface: D-0062", "acceptance: pass", "needs: actor-a", "", "## critic", "role: critic", "handoff: R-0003-critic", "authority: D-0062", "goal: C", "files: acceptance/f.test.mjs", "interface: D-0062", "acceptance: pass", "needs: actor-b", "reviews: actor-a, actor-b", "", "## judge", "role: judge", "handoff: R-0004-judge", "authority: D-0062", "goal: J", "files: ", "interface: D-0062", "acceptance: pass", "needs: critic", ""].join("\n");
  mkRepo({
    "README.md": "# Policy records\n", "records.json": "{}\n", "loop.json": json(makeLoopObj(judgeIndependence)),
    "purpose/P-0001.md": "# P-0001 Purpose\n\nstatus: active\n", "decisions/D-0062.md": "# D-0062 Policy\n\nid: D-0062\nby: owner\nstatus: active\n",
    "blueprint/F-0009.md": "# F-0009 Policy\n\nid: F-0009\nphase: v1\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": jsonl({ feature: "F-0009", phase: "v1", status: "done", time: "2026-11-26T02:05:00Z", by: "lead", note: "done", evidence: { round: "R-0004-judge", commit, ci: "evidence/0004/ci.json" } }),
    "plans/PL-0001.md": plan, "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nphase: v1\nrole: reviewer\n",
    "rounds/0002-actor-a.md": "# R-0002-actor-a\n", "rounds/0003-actor-b.md": "# R-0003-actor-b\n",
    "rounds/0003-critic.md": "# R-0003-critic\n", "rounds/0004-judge.md": "# R-0004-judge\n",
    "sealed/judge/0004/judge-1.md": "# R-0004-judge\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n",
    "evidence/0004/suite-1.json": JSON.stringify({ repository: product, sha: commit, tree, green: true }),
    "evidence/0004/ci.json": JSON.stringify({ repository: "example/policy", sha: commit, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }),
    "metrics/handoffs.jsonl": jsonl(
      { id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "t3:codex" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] },
      mkH("R-0002-actor-a", 2, "actor-a", "actor", actorAgent, baseline, mid, "rounds/0002-actor-a.md", ["rounds/0002-actor-a.md"], { plan: "PL-0001", package: "actor-a", files: ["scripts/feature.mjs"] }),
      mkH("R-0003-actor-b", 3, "actor-b", "actor", actorAgent, mid, commit, "rounds/0003-actor-b.md", ["rounds/0003-actor-b.md"], { plan: "PL-0001", package: "actor-b", files: ["scripts/feature2.mjs"] }),
      mkH("R-0003-critic", 3, "critic", "critic", criticObs, commit, commit, "rounds/0003-critic.md", ["rounds/0003-critic.md"], { plan: "PL-0001", package: "critic", files: ["acceptance/f.test.mjs"] }),
      mkH("R-0004-judge", 4, "judge", "judge", judgeAgent, commit, commit, "rounds/0004-judge.md", ["rounds/0004-judge.md", "sealed/judge/0004/judge-1.md"], { plan: "PL-0001", package: "judge", files: [] }),
    ),
    "metrics/trajectory.jsonl": jsonl({ round: 4, phase: "v1", role: "judge", area: "policy", verdict: "CONVERGED", commit, suite: "1/0", ci: "success", ciReceipt: "evidence/0004/ci.json", time: "2026-11-26T02:00:00Z" }),
  }, records);
  assert.equal(runNode("records-check.mjs", ["--repo", records, "--write"]).status, 0);
  git(records, "add", "-A"); git(records, "commit", "-qm", "Init records");
  const { event: win } = openWindow(records, { phase: "v1", startRound: 2, horizon: 2, goal: "Policy gate", invariants: ["Suite green"] });
  chmodSync(put(bin, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\"}'\n"), 0o755);
  const store = ownerStore([{ name: "policy", records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } });
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir, PATH: `${bin}${delimiter}${process.env.PATH}` });
  return {
    product, records, commit, win,
    setPolicy: ji => { writeFileSync(join(records, "loop.json"), json(makeLoopObj(ji))); git(records, "add", "loop.json"); git(records, "commit", "-qm", `Set ji=${String(ji)}`); },
    verifyPush: () => runNode("gated-push.mjs", ["--verify-only", "--repo", product, "--branch", "loop/v1", "--sha", commit, "--owner-store", store], { env }),
    runLoopNext: () => runNode("loop.mjs", ["next", "--config", join(records, "loop.json")], { env }),
    runWindowClose: (cfgArg = null) => runNode("window.mjs", ["close", "--records", records, "--id", win.id, "--verdict", "verified", "--commit", commit, ...(cfgArg ? ["--config", cfgArg] : [])], { env }),
  };
}

test("[Policy-01] judgeIndependence vendor default vs model opt-in and fail-closed validation across provenance, gated-push, loop next, and window close [loss: false-verdict]", t => {
  const neonActor = { runner: "t3:antigravity", model: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", observedModels: ["gemini-2.5-flash"] };
  const carbonJudge = { runner: "t3:antigravity", model: "gemini-2.5-pro", observedModel: "gemini-2.5-pro", observedModels: ["gemini-2.5-pro"] };
  const w = makePolicyWorld(t, { actorAgent: neonActor, judgeAgent: carbonJudge });
  for (const mode of [undefined, "vendor"]) {
    if (mode !== undefined) w.setPolicy(mode);
    assert.deepEqual([verifyProvenance({ repo: w.product, records: w.records, sha: w.commit, branch: "loop/v1" }).ok, w.verifyPush().status, w.runWindowClose().status], [false, 2, 2]);
    assert.throws(() => closeWindow(w.records, { id: w.win.id, commit: w.commit, verdict: "verified" }), WindowRefusalError);
  }
  assert.match(w.runLoopNext().stdout, /judge\/actor independence needs confirmation/);
  w.setPolicy("model");
  assert.deepEqual([verifyProvenance({ repo: w.product, records: w.records, sha: w.commit, branch: "loop/v1" }).ok, w.verifyPush().status, w.runWindowClose(join(w.records, "loop.json")).status], [true, 0, 0]);
  assert.match(w.runLoopNext().stdout, /The recorded convergence checks are satisfied/);
  for (const [label, badJudge] of [
    ["same-model", neonActor],
    ["same-model-case", { ...neonActor, model: "Gemini-2.5-Flash", observedModel: "Gemini-2.5-Flash", observedModels: ["Gemini-2.5-Flash"] }],
    ["empty-observed", { runner: "t3:antigravity", model: "gemini-2.5-pro", observedModel: null, observedModels: [] }],
    ["multi-model", { runner: "t3:antigravity", model: "gemini-2.5-pro", observedModel: "gemini-2.5-pro", observedModels: ["gemini-2.5-pro", "gemini-2.5-flash"] }],
    ["unknown-model", { runner: "t3:antigravity", model: "custom-unknown-model", observedModel: "custom-unknown-model", observedModels: ["custom-unknown-model"] }],
  ]) {
    const bw = makePolicyWorld(t, { judgeIndependence: "model", actorAgent: neonActor, judgeAgent: badJudge });
    assert.deepEqual([verifyProvenance({ repo: bw.product, records: bw.records, sha: bw.commit, branch: "loop/v1" }).ok, bw.verifyPush().status], [false, 2], label);
    assert.throws(() => closeWindow(bw.records, { id: bw.win.id, commit: bw.commit, verdict: "verified" }), WindowRefusalError, `${label}: closeWindow`);
    assert.match(bw.runLoopNext().stdout, /judge\/actor independence needs confirmation/, `${label}: loop next`);
    bw.setPolicy("vendor");
    assert.deepEqual([verifyProvenance({ repo: bw.product, records: bw.records, sha: bw.commit, branch: "loop/v1" }).ok, bw.verifyPush().status], [false, 2], `${label} vendor`);
  }
  for (const invalidPolicy of ["none", "", null, "MODEL", false]) {
    assert.equal(verifyProvenance({ repo: w.product, records: w.records, sha: w.commit, cfg: { provenanceBaseline: null, judgeIndependence: invalidPolicy } }).ok, false);
    assert.equal(verifyWaveGate({ repo: w.product, records: w.records, sha: w.commit, branch: "loop/v1", cfg: { provenanceBaseline: null, judgeIndependence: invalidPolicy } }).ok, false);
    const iw = makePolicyWorld(t, { judgeIndependence: invalidPolicy, actorAgent: neonActor, judgeAgent: carbonJudge });
    assert.ok(iw.verifyPush().status === 2 && iw.runLoopNext().status !== 0 && iw.runWindowClose().status === 2);
  }
});

function setupNoDispute(t, { baseline = true } = {}) {
  const dir = realTemp("paseo-nodisp-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bare = join(dir, "bare.git"), product = join(dir, "product"), records = join(dir, "records"), workDir = join(dir, "work"), agHome = join(dir, "ag-home"), loadDir = join(dir, "load"), storeDir = join(dir, "store");
  for (const d of [bare, workDir, agHome, loadDir, storeDir]) mkdirSync(d, { recursive: true });
  git(bare, "init", "--bare", "-q", "-b", "dev");
  mkRepo({ "README.md": "# App\n", "smoke.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n" }, product);
  git(product, "remote", "add", "origin", bare); git(product, "push", "-q", "origin", "main:dev"); git(product, "branch", "loop/v1");
  const initSha = git(product, "rev-parse", "loop/v1"), briefFiles = Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief.\n`]));
  const cfgObj = { product, records, workDir, branch: "loop/v1", phase: "v1", briefs: BRIEFS, owns: { actor: ["src"], critic: ["acceptance"] }, protected: ["dev", "main"], judgeIndependence: "model", provenanceBaseline: baseline ? initSha : null, gates: { remote: "origin", require: [], suite: "node --test smoke.test.mjs" }, agents: { actor: { runner: "paseo", provider: "better-paseo-antigravity", model: "gemini-2.5-flash" }, critic: { runner: "paseo", provider: "better-paseo-antigravity", model: "gemini-2.5-pro" }, reviewer: t3Ag("gemini-2.5-pro-exp"), judge: { runner: "t3", provider: "codex", model: "gpt-5.4" } } };
  mkRepo({ "README.md": "# Rec\n", "records.json": "{\"extraKinds\":[{\"kind\":\"Plan\",\"path\":\"plans/PL-NNNN.md\",\"changes\":\"immutable\",\"citedAs\":\"PL-NNNN\"}]}\n", "loop.json": json(cfgObj), "purpose/P-0001.md": "# P-0001 Purpose\n\nstatus: active\n", "decisions/D-0064.md": "# D-0064 Policy\n\nid: D-0064\nby: owner\nstatus: active\n", "blueprint/F-0011.md": "# F-0011 Paseo\n\nid: F-0011\nphase: v1\nrequirements: P-0001\n", "metrics/blueprint.jsonl": jsonl({ feature: "F-0011", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "go", evidence: {} }), "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n", ...briefFiles, "metrics/handoffs.jsonl": jsonl({ id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "antigravity" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] }), "plans/PL-0001.md": ["# PL-0001 P", "scope: v1/2", "phase: v1", "", "## actor-a", "role: actor", "handoff: R-0002-actor-a", "authority: D-0064", "goal: a", "files: src/**", "interface: fixed", "acceptance: pass", "needs: ", "", "## critic-a", "role: critic", "handoff: R-0002-critic-a", "authority: D-0064", "goal: c", "files: acceptance/**", "interface: fixed", "acceptance: pass", "needs: actor-a", "reviews: actor-a", ""].join("\n") }, records);
  const store = ownerStore([{ name: "nd", records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } }), env = isolatedEnv({ HOME: dir, ANTIGRAVITY_HOME: agHome, ANTIGRAVITY_APP_DATA_DIR: "", T3CODE_HOME: "", SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir });
  assert.equal(runNode("records-check.mjs", ["--repo", records, "--write"], { env }).status, 0); git(records, "add", "-A"); git(records, "commit", "-qm", "seed");
  put(workDir, "tasks/R-0002-actor-a.md", "features: F-0011\nWrite src/a.js\n"); put(workDir, "tasks/R-0002-critic-a.md", "features: F-0011\nVerify actor-a\n");
  const cfgPath = join(records, "loop.json"), readyA = JSON.parse(runNode("plan.mjs", ["ready", "--records", records, "--plan", "PL-0001", "--json"], { env }).stdout).packages.find(p => p.id === "actor-a");
  assert.match(String(readyA?.command ?? JSON.stringify(readyA)), /--prepare\b/);
  const prepA = JSON.parse(runNode("dispatch.mjs", ["prepare", "--config", cfgPath, "--plan", "PL-0001", "--json"], { env }).stdout).prepared[0];
  put(prepA.wt, "src/a.js", "export const a = 1;\n"); writeFileSync(join(prepA.ws, "out/report.md"), "Done.\n");
  const finishAg = (spec, cid, model) => {
    writeSummaryDb(agHome, [{ id: cid, workspaces: [spec.wt] }]);
    writeTranscript(agHome, cid, [userStep(0, wrapUserReq(wrapPaseoMsg(spec.prompt))), { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: "2026-11-26T01:00:05Z", model }]);
    return runNode("call.mjs", [cfgPath, "record", "--ws", spec.ws], { env });
  };
  assert.equal(finishAg(prepA, "ag-a", "gemini-2.5-flash").status, 0);
  const prepC = JSON.parse(runNode("call.mjs", [cfgPath, "critic", "--round", "2", "--step", "critic-a", "--plan", "PL-0001", "--package", "critic-a", "--task", join(workDir, "tasks/R-0002-critic-a.md"), "--prepare"], { env }).stdout);
  put(prepC.wt, "acceptance/a.test.mjs", "import test from 'node:test';\ntest('a', () => {});\n"); writeFileSync(join(prepC.ws, "out/report.md"), "VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: -\n\nVerified.\n");
  assert.equal(finishAg(prepC, "ag-c", "gemini-2.5-pro").status, 0);
  const hs = parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")), aH = hs.find(h => h.id === "R-0002-actor-a"), cH = hs.find(h => h.id === "R-0002-critic-a");
  return { bare, product, records, store, env, cfgObj, initSha, hs, aH, cH, commit: cH.product.commit };
}

test("[D0064-T10+D0066] better-paseo-antigravity prepare/record via ANTIGRAVITY_HOME and no-dispute Critic PASS/CONVERGED push cleanly while same-model, disputed, failing, and stale-base refuse [loss: false-verdict / stuck]", t => {
  const { bare, product, records, store, env, initSha, hs, aH, cH, commit } = setupNoDispute(t);
  assert.deepEqual([aH.agent.runner, aH.agent.observedModels, cH.agent.runner, cH.agent.observedModels, cH.audit.violations, hs.some(h => h.role === "judge")], ["paseo:better-paseo-antigravity", ["gemini-2.5-flash"], "paseo:better-paseo-antigravity", ["gemini-2.5-pro"], 0, false]);
  assert.equal(runNode("suite-green.mjs", ["--repo", product, "--sha", commit, "--command", "node --test smoke.test.mjs"], { env }).status, 0);
  const pushRes = runNode("gated-push.mjs", ["--repo", product, "--branch", "dev", "--sha", commit, "--owner-store", store], { env });
  assert.ok(pushRes.status === 0 && git(bare, "rev-parse", "refs/heads/dev") === commit, pushRes.stderr + pushRes.stdout);
  const vPush = mutateFn => {
    const saved = git(records, "show", "HEAD:metrics/handoffs.jsonl"), savedDoc = readFileSync(join(records, cH.record), "utf8");
    mutateFn(); git(records, "add", "-A"); git(records, "commit", "-qm", "mutate");
    const r = runNode("gated-push.mjs", ["--verify-only", "--repo", product, "--branch", "dev", "--sha", commit, "--owner-store", store], { env });
    put(records, "metrics/handoffs.jsonl", saved); put(records, cH.record, savedDoc); git(records, "add", "-A"); git(records, "commit", "-qm", "restore");
    return r;
  };
  assert.equal(vPush(() => put(records, cH.record, readFileSync(join(records, cH.record), "utf8").replace("VERDICT: PASS", "VERDICT: CONVERGED"))).status, 0);
  for (const [label, fn] of [
    ["same-model", () => put(records, "metrics/handoffs.jsonl", jsonl(...hs.map(h => h.id === cH.id ? { ...h, agent: { ...h.agent, model: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", observedModels: ["gemini-2.5-flash"] } } : h)))],
    ["disputed", () => put(records, cH.record, readFileSync(join(records, cH.record), "utf8").replace("DISPUTES: -", "DISPUTES: D1"))],
    ["failing", () => put(records, cH.record, readFileSync(join(records, cH.record), "utf8").replace("VERDICT: PASS", "VERDICT: CONTINUE").replace("OPENED: -", "OPENED: BUG-1"))],
    ["stale-base", () => put(records, "metrics/handoffs.jsonl", jsonl(...hs.map(h => h.id === cH.id ? { ...h, product: { ...h.product, base: initSha } } : h)))],
  ]) assert.notEqual(vPush(fn).status, 0, `${label} must refuse`);
});

test("[CRITIC-BASE-01] fresh · flow: writing critic (commit !== base) cannot converge or push its pre-critic actor base SHA when provenanceBaseline is null · loss: false-verdict / data", t => {
  const { product, records, store, env, cfgObj, cH } = setupNoDispute(t, { baseline: false });
  assert.notEqual(cH.product.base, cH.product.commit);
  assert.equal(hasConvergence(product, records, cH.product.base, cfgObj), false, "writing critic base must not converge without critic commit");
  assert.equal(runNode("suite-green.mjs", ["--repo", product, "--sha", cH.product.base, "--command", "node --test smoke.test.mjs"], { env }).status, 0);
  assert.notEqual(runNode("gated-push.mjs", ["--repo", product, "--branch", "dev", "--sha", cH.product.base, "--owner-store", store], { env }).status, 0, "must refuse pushing actor base omitting critic commit");
});

test("[D0068-EXT-01] fresh · flow: arbitrary providers (opencode/pi) + adapter generic (record --transcript --session), router models, extended families, custom modelVendors, agent.vendor fallback, and judgeIndependence session · loss: false-verdict / stuck", t => {
  const dir = realTemp("d0068-ext-"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const product = mkRepo({ "src/a.js": "export const a = 1;\n", "acceptance/s.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n" }, join(dir, "product"));
  git(product, "branch", "loop/v1");
  const initSha = git(product, "rev-parse", "loop/v1"), records = join(dir, "records"), workDir = join(dir, "work"), loadDir = join(dir, "load"), storeDir = join(dir, "store");
  for (const d of [workDir, loadDir, storeDir]) mkdirSync(d, { recursive: true });
  const briefFiles = Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n`]));
  const cfg = { product, records, workDir, branch: "loop/v1", phase: "v1", briefs: BRIEFS, owns: { actor: ["src"], critic: ["acceptance"] }, protected: ["main"], judgeIndependence: "vendor", provenanceBaseline: initSha, agents: { actor: { runner: "t3", provider: "opencode", adapter: "generic", model: "openrouter/kimi-k2" }, critic: { runner: "t3", provider: "pi", adapter: "generic", model: "openrouter/grok-3" }, judge: { runner: "t3", provider: "opencode", adapter: "generic", model: "deepseek-r1" }, reviewer: { runner: "cmd", cmd: ["true"] } } };
  const plan = ["# PL-0001 P", "scope: v1/2", "phase: v1", "", "## actor-a", "role: actor", "handoff: R-0002-actor", "authority: D-0068", "goal: a", "files: src/**", "interface: fixed", "acceptance: pass", "needs: ", "", "## critic-a", "role: critic", "handoff: R-0002-critic", "authority: D-0068", "goal: c", "files: acceptance/**", "interface: fixed", "acceptance: pass", "needs: actor-a", "reviews: actor-a", ""].join("\n");
  mkRepo({ "README.md": "# Rec\n", "records.json": "{\"extraKinds\":[{\"kind\":\"Plan\",\"path\":\"plans/PL-NNNN.md\",\"changes\":\"immutable\",\"citedAs\":\"PL-NNNN\"}]}\n", "loop.json": json(cfg), "purpose/P-0001.md": "# P-0001 Purpose\n\nstatus: active\n", "decisions/D-0068.md": "# D-0068 Policy\n\nid: D-0068\nby: owner\nstatus: active\n", "blueprint/F-0011.md": "# F-0011 Paseo\n\nid: F-0011\nphase: v1\nrequirements: P-0001\n", "metrics/blueprint.jsonl": jsonl({ feature: "F-0011", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "go", evidence: {} }), "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n", "metrics/handoffs.jsonl": jsonl({ id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "cmd" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] }), "plans/PL-0001.md": plan, ...briefFiles }, records);
  const env = isolatedEnv({ HOME: dir, ANTIGRAVITY_HOME: "", ANTIGRAVITY_APP_DATA_DIR: "", T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: loadDir });
  const chk0 = runNode("records-check.mjs", ["--repo", records, "--write"], { env });
  assert.equal(chk0.status, 0, chk0.stderr + chk0.stdout);
  git(records, "add", "-A"); git(records, "commit", "-qm", "seed");
  const cfgPath = join(records, "loop.json"), taskFile = put(workDir, "tasks/R-0002-actor.md", "features: F-0011\nWrite a.js\n");
  const prepRes = runNode("call.mjs", [cfgPath, "actor", "--round", "2", "--plan", "PL-0001", "--package", "actor-a", "--task", taskFile, "--prepare"], { env });
  assert.equal(prepRes.status, 0, prepRes.stderr + prepRes.stdout);
  const prep = JSON.parse(prepRes.stdout);
  assert.notEqual(runNode("call.mjs", [cfgPath, "record", "--ws", prep.ws], { env }).status, 0);
  put(prep.wt, "src/a.js", "export const a = 2;\n"); writeFileSync(join(prep.ws, "out/report.md"), "Done.\n");
  const txA = put(dir, "tx-actor.jsonl", jsonl({ type: "user", sessionId: "gen-sess-a", content: prep.prompt }, { type: "assistant", model: "openrouter/kimi-k2", status: "completed" }));
  const recA = runNode("call.mjs", [cfgPath, "record", "--ws", prep.ws, "--transcript", txA, "--session", "gen-sess-a"], { env });
  assert.equal(recA.status, 0, recA.stderr + recA.stdout);
  const aH = parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")).find(h => h.id === "R-0002-actor");
  assert.deepEqual([aH.agent.runner, aH.agent.adapter, aH.agent.observedModel], ["t3:opencode", "generic", "openrouter/kimi-k2"]);

  assert.deepEqual(["deepseek-r1", "minimax-m1", "kimi-k2", "mixtral-8x7b", "openrouter/gemini-2.5-pro-exp"].map(m => vendorOfModel(m)), ["deepseek", "minimax", "moonshot", "mistral", "google"]);
  assert.equal(vendorOfModel("acme-large", { "acme-": "acme" }), "acme");
  const baseH = { id: "H1", role: "actor", product: { base: initSha, commit: aH.product.commit }, record: aH.record };
  const sessOk = { ...cfg, judgeIndependence: "session" };
  assert.equal(verifyProvenance({ repo: product, records, sha: aH.product.commit, cfg: sessOk }).ok, true);
  assert.equal(waveIndependenceProblem({ policy: "session", actors: [{ ...baseH, agent: { runner: "t3:pi", model: "custom-x", vendor: "omega", session: "s1" } }], judge: { id: "J", role: "judge", agent: { runner: "t3:pi", model: "custom-x", vendor: "omega", session: "s2" } } }), null);
  assert.notEqual(waveIndependenceProblem({ policy: "session", actors: [{ ...baseH, agent: { runner: "t3:pi", model: "custom-x", session: "s1" } }], judge: { id: "J", role: "judge", agent: { runner: "t3:pi", model: "custom-x", session: "s1" } } }), null);
  assert.equal(waveIndependenceProblem({ policy: "vendor", modelVendors: { "acme-": "acme" }, actors: [{ ...baseH, agent: { runner: "t3:pi", model: "unlisted", vendor: "omega" } }], judge: { id: "J", role: "judge", agent: { runner: "t3:pi", model: "acme-1" } } }), null);
});

test("[D0068-SWEEP-01] fresh · flow: Horizontal Sweep of router-prefix model equality, digit-suffixed families, dispatch adapter lookup, and modelVendors config propagation · loss: false-verdict / stuck", async t => {
  await t.test("model independence rejects router-prefixed equivalent models", t2 => {
    const bw = makePolicyWorld(t2, {
      judgeIndependence: "model",
      actorAgent: { runner: "t3:opencode", model: "openrouter/gemini-2.5-pro-exp", observedModel: "openrouter/gemini-2.5-pro-exp", observedModels: ["openrouter/gemini-2.5-pro-exp"] },
      judgeAgent: { runner: "t3:antigravity", model: "gemini-2.5-pro-exp", observedModel: "gemini-2.5-pro-exp", observedModels: ["gemini-2.5-pro-exp"] },
    });
    assert.equal(verifyProvenance({ repo: bw.product, records: bw.records, sha: bw.commit, branch: "loop/v1" }).ok, false, "router prefix must not bypass same-model independence");
  });

  await t.test("digit-suffixed model families resolve vendors", () => {
    assert.deepEqual(["openrouter/qwen3-coder", "qwen2.5-coder", "llama3-70b", "glm4-plus", "grok3"].map(m => vendorOfModel(m)), ["alibaba", "alibaba", "meta", "zhipu", "xai"]);
  });

  await t.test("dispatch.mjs record honors explicit w.agent.adapter for custom providers", t2 => {
    const dir = realTemp("disp-adapter-"); t2.after(() => rmSync(dir, { recursive: true, force: true }));
    const product = mkRepo({ "src/a.js": "export const a = 1;\n" }, join(dir, "product")), records = join(dir, "records"), workDir = join(dir, "work"), codexHome = join(dir, "codex"), loadDir = join(dir, "load"), storeDir = join(dir, "store");
    for (const d of [workDir, codexHome, loadDir, storeDir]) mkdirSync(d, { recursive: true });
    git(product, "branch", "loop/v1");
    const briefFiles = Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n`]));
    const cfg = { product, records, workDir, branch: "loop/v1", phase: "v1", briefs: BRIEFS, owns: { actor: ["src"], critic: ["acceptance"] }, protected: ["main"], agents: { actor: { runner: "t3", provider: "custom-router", adapter: "codex", model: "gpt-5.4" }, critic: { runner: "cmd", cmd: ["true"] }, judge: { runner: "cmd", cmd: ["true"] } } };
    const plan = ["# PL-0001 P", "scope: v1/2", "phase: v1", "", "## actor-a", "role: actor", "handoff: R-0002-actor-a", "authority: D-0068", "goal: a", "files: src/**", "interface: fixed", "acceptance: pass", "needs: ", "", "## critic-a", "role: critic", "handoff: R-0002-critic-a", "authority: D-0068", "goal: c", "files: acceptance/**", "interface: fixed", "acceptance: pass", "needs: actor-a", "reviews: actor-a", ""].join("\n");
    mkRepo({ "README.md": "# R\n", "records.json": "{\"extraKinds\":[{\"kind\":\"Plan\",\"path\":\"plans/PL-NNNN.md\",\"changes\":\"immutable\",\"citedAs\":\"PL-NNNN\"}]}\n", "loop.json": json(cfg), "purpose/P-0001.md": "# P-0001\n", "decisions/D-0068.md": "# D-0068\n\nid: D-0068\nby: owner\nstatus: active\n", "blueprint/F-0011.md": "# F-0011 Adapter\n\nid: F-0011\nphase: v1\nrequirements: P-0001\n", "metrics/blueprint.jsonl": jsonl({ feature: "F-0011", phase: "v1", status: "building", time: "2026-11-26T00:00:00Z", by: "lead", note: "go", evidence: {} }), "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n", "metrics/handoffs.jsonl": jsonl({ id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "cmd" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] }), "plans/PL-0001.md": plan, ...briefFiles }, records);
    const store = ownerStore([{ name: "disp", records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } });
    const env = isolatedEnv({ HOME: dir, CODEX_HOME: codexHome, ANTIGRAVITY_HOME: "", ANTIGRAVITY_APP_DATA_DIR: "", T3CODE_HOME: "", SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir });
    const rc0 = runNode("records-check.mjs", ["--repo", records, "--write"], { env });
    assert.equal(rc0.status, 0, rc0.stderr + rc0.stdout);
    git(records, "add", "-A"); git(records, "commit", "-qm", "seed");
    put(workDir, "tasks/R-0002-actor-a.md", "features: F-0011\nWrite a.js\n");
    const cfgPath = join(records, "loop.json"), prepRes = runNode("dispatch.mjs", ["prepare", "--config", cfgPath, "--plan", "PL-0001", "--json"], { env });
    assert.equal(prepRes.status, 0, prepRes.stderr + prepRes.stdout);
    const prep = JSON.parse(prepRes.stdout).prepared[0];
    put(prep.wt, "src/a.js", "export const a = 2;\n"); writeFileSync(join(prep.ws, "out/report.md"), "Done.\n");
    const { preparedAt } = JSON.parse(readFileSync(join(prep.ws, "call.json"), "utf8")), now = new Date(preparedAt + 1000), ts = now.toISOString(), pad = n => String(n).padStart(2, "0");
    const roll = put(join(codexHome, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())), `rollout-${prep.nonce}.jsonl`, jsonl({ timestamp: ts, type: "session_meta", payload: { cwd: prep.wt, id: "cx-1" } }, { timestamp: ts, type: "turn_context", payload: { cwd: prep.wt, model: "gpt-5.4" } }, { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prep.prompt }] } }, { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } }));
    const sec = Math.ceil((preparedAt + 1000) / 1000); utimesSync(roll, sec, sec);
    const recRes = runNode("dispatch.mjs", ["record", "--config", cfgPath, "--plan", "PL-0001", "--json"], { env });
    assert.equal(recRes.status, 0, recRes.stderr + recRes.stdout);
    const rec = JSON.parse(recRes.stdout), row = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).find(h => h.id === "R-0002-actor-a");
    assert.equal(rec.recorded.length, 1, JSON.stringify(rec));
    assert.equal(rec.recorded[0].session, "cx-1");
    assert.equal(row?.agent?.adapter, "codex");
  });

  await t.test("gated-push and window close propagate modelVendors from loop.json and --config", t2 => {
    const aAg = { runner: "t3:pi", model: "custom-alpha", observedModels: ["custom-alpha"] }, jAg = { runner: "t3:opencode", model: "custom-beta", observedModels: ["custom-beta"] };
    const pw = makePolicyWorld(t2, { judgeIndependence: "vendor", modelVendors: { "custom-alpha": "alpha", "custom-beta": "beta" }, actorAgent: aAg, judgeAgent: jAg });
    assert.deepEqual([pw.verifyPush().status, pw.runWindowClose().status], [0, 0], "gated-push and window close must read modelVendors from loop.json");
    const ext = makePolicyWorld(t2, { judgeIndependence: "vendor", actorAgent: aAg, judgeAgent: jAg }), extCfg = join(ext.product, "../ext-loop.json");
    writeFileSync(extCfg, json({ ...JSON.parse(readFileSync(join(ext.records, "loop.json"), "utf8")), modelVendors: { "custom-alpha": "alpha", "custom-beta": "beta" } }));
    assert.equal(ext.runWindowClose(extCfg).status, 0, "window.mjs close --config must forward modelVendors");
  });
});

test("[D0064-T10-DOWNSTREAM] ordered · flow: Horizontal Sweep of no-dispute Critic across window.mjs close, blockers/loop.mjs, PASS ciReceipt records-check, and blueprint done --round · loss: stuck / false-verdict", async t => {
  const { product, records, env, initSha, commit } = setupNoDispute(t), tree = git(product, "rev-parse", `${commit}^{tree}`), bin = join(product, "../bin");
  chmodSync(put(bin, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\"}'\n"), 0o755);
  git(product, "remote", "set-url", "origin", "https://github.com/example/nd.git");
  const envGh = { ...env, PATH: `${bin}${delimiter}${env.PATH}` }, cfgObj = JSON.parse(readFileSync(join(records, "loop.json"), "utf8"));
  cfgObj.gates = { remote: "origin", require: ["github-actions/verify"], suite: "node --test smoke.test.mjs" };
  writeFileSync(join(records, "loop.json"), json(cfgObj));
  assert.equal(runNode("suite-green.mjs", ["--repo", product, "--sha", commit, "--command", "node --test smoke.test.mjs"], { env: envGh }).status, 0);
  put(records, "evidence/0002/suite-1.json", JSON.stringify({ repository: product, sha: commit, tree, green: true }));
  git(records, "add", "-A"); git(records, "commit", "-qm", "Stage suite evidence");
  const t1 = runNode("trajectory.mjs", ["append", "--file", join(records, "metrics/trajectory.jsonl"), "--round", "2", "--phase", "v1", "--role", "critic", "--commit", commit, "--area", "nd", "--verdict", "PASS", "--suite", "1/0"], { env: envGh });
  assert.equal(t1.status, 0, t1.stderr + t1.stdout);
  git(records, "add", "-A"); git(records, "commit", "-qm", "Append critic PASS row");
  const { event: win } = openWindow(records, { phase: "v1", startRound: 2, horizon: 3, goal: "Critic downstream checks", invariants: ["Suite green"] });

  await t.test("window.mjs close accepts independent no-dispute Critic PASS", () => {
    const res = runNode("window.mjs", ["close", "--records", records, "--id", win.id, "--verdict", "verified", "--commit", commit, "--config", join(records, "loop.json")], { env: envGh });
    assert.equal(res.status, 0, res.stderr + res.stdout);
  });

  put(records, "rounds/0003-critic.md", "# R-0003-critic\n\nphase: v1\n\n## Report\n\nVERDICT: CONTINUE\nACCEPTANCE: fail\nDISPUTES: -\nOPENED: scope:b1\n");
  put(records, "metrics/handoffs.jsonl", git(records, "show", "HEAD:metrics/handoffs.jsonl") + "\n" + JSON.stringify({ id: "R-0003-critic", time: "2026-11-26T01:30:00Z", phase: "v1", round: 3, step: "critic", role: "critic", attempt: 1, agent: { runner: "paseo:better-paseo-antigravity", model: "gemini-2.5-pro", observedModel: "gemini-2.5-pro", observedModels: ["gemini-2.5-pro"] }, view: git(records, "rev-parse", "HEAD"), product: { base: initSha, commit }, audit: { violations: 0 }, record: "rounds/0003-critic.md", files: ["rounds/0003-critic.md"] }) + "\n");
  git(records, "add", "-A"); git(records, "commit", "-qm", "Stage contradicting critic ruling");
  const t2 = runNode("trajectory.mjs", ["append", "--file", join(records, "metrics/trajectory.jsonl"), "--round", "3", "--phase", "v1", "--role", "critic", "--commit", commit, "--area", "nd", "--verdict", "CONTINUE", "--suite", "1/0", "--opened", "scope:b1"], { env: envGh });
  assert.equal(t2.status, 0, t2.stderr + t2.stdout);
  git(records, "add", "-A"); git(records, "commit", "-qm", "Append critic CONTINUE row");
  const { event: win2 } = openWindow(records, { phase: "v1", startRound: 2, horizon: 3, goal: "Contradicted critic check", invariants: ["Suite green"] });

  await t.test("window.mjs close rejects Critic PASS contradicted by later CONTINUE on same commit", () => {
    const st = JSON.parse(runNode("window.mjs", ["status", "--records", records, "--json"], { env: envGh }).stdout);
    assert.equal(st.criticConverged, null, JSON.stringify(st));
    const res = runNode("window.mjs", ["close", "--records", records, "--id", win2.id, "--verdict", "verified", "--commit", commit, "--config", join(records, "loop.json")], { env: envGh });
    assert.notEqual(res.status, 0, `expected refusal when contradicted by CONTINUE, got ${res.stdout} ${res.stderr}`);
  });

  await t.test("blockers.mjs tracks OPENED blockers from role critic trajectory rows", () => {
    const rows = readFileSync(join(records, "metrics/trajectory.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
    assert.equal(blockerState(rows, { phase: "v1" }).get("scope:b1")?.status, "open");
  });

  await t.test("blueprint.mjs set --status done --round accepts independent no-dispute Critic convergence", () => {
    const bpRes = runNode("blueprint.mjs", ["set", "--records", records, "--feature", "F-0011", "--status", "done", "--round", "R-0002-critic-a", "--by", "lead", "--note", "Critic converged"], { env: envGh });
    assert.equal(bpRes.status, 0, bpRes.stderr + bpRes.stdout);
  });

  await t.test("records-check validates tampered ciReceipt on PASS trajectory rows", () => {
    runNode("records-check.mjs", ["--repo", records, "--write"], { env: envGh });
    git(records, "add", "-A"); git(records, "commit", "-qm", "Sync index before tamper");
    const row2 = JSON.parse(readFileSync(join(records, "metrics/trajectory.jsonl"), "utf8").trim().split("\n")[0]);
    put(records, row2.ciReceipt, JSON.stringify({ repository: "example/nd", sha: "0".repeat(40), ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }));
    git(records, "add", row2.ciReceipt); git(records, "commit", "-qm", "Tamper PASS ciReceipt sha");
    const chk = runNode("records-check.mjs", ["--repo", records, "--json"], { env: envGh });
    const failures = JSON.parse(chk.stdout).failures ?? [];
    assert.ok(chk.status !== 0 && failures.some(f => f.rule === "trajectory"), `records-check must flag tampered PASS ciReceipt, got ${chk.stdout}`);
  });
});
