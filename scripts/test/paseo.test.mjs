// F-0008, F-0009, F-0010, D-0016, D-0062, D-0066, D-0068, design/paseo-and-judge-policy.md#1
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { auditAccess } from "../audit-access.mjs";
import {
  ANTIGRAVITY_DELEGATION_TOOLS,
  antigravityAppDirs,
  antigravityFirstPrompt,
  isDisallowedRoleTool,
  unwrapAntigravityUserText,
} from "../lib/antigravity.mjs";
import { antigravitySessionState, antigravityTranscript } from "../lib/antigravity-words.mjs";
import {
  captureOwnerText,
  claudeAgentSession,
  claudeSessionWords,
  codexSessionWords,
  isSubstantiveOwnerWord,
  ownerPrompt,
} from "../lib/owner-words.mjs";
import {
  ADAPTERS,
  ANTIGRAVITY_PROVIDERS,
  canonicalProvider,
  isAdapter,
  isAntigravityProvider,
  isPaseoFramed,
  isPaseoSystemEnvelope,
  isPreparedRunner,
  PASEO_MCP_TOOL_PREFIX,
  PREPARED_RUNNERS,
  resolveAdapter,
  unescapePaseoXml,
  unwrapPaseoAgentMessage,
} from "../lib/paseo.mjs";
import { findTranscripts, resolveChildSession, t3Prompt, transcriptEvents } from "../lib/t3-child.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, scripts, temp } from "./helpers.mjs";

const userRow = (step_index, content) => ({
  step_index,
  source: "USER_EXPLICIT",
  type: "USER_INPUT",
  status: "DONE",
  created_at: "2026-11-26T01:00:00.000Z",
  content,
});

const wrapReq = inner => `<USER_REQUEST>\n${inner}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026-11-26\n</ADDITIONAL_METADATA>`;

test("PASEO_MCP_TOOL_PREFIX matches Paseo MCP tool naming variants only", () => {
  for (const name of [
    "mcp_paseo_create_agent",
    "mcp_paseo_send_agent_prompt",
    "mcp_paseo_list_agents",
    "mcp_paseo-mcp_create_agent",
    "mcp__paseo__create_agent",
    "mcp__paseo__list_agents",
  ]) {
    assert.equal(PASEO_MCP_TOOL_PREFIX.test(name), true, name);
    assert.equal(isDisallowedRoleTool(name), true, name);
  }
  for (const name of ["mcp_t3-code_t3_thread_read", "read_file", "paseo_create_agent", ""]) {
    assert.equal(PASEO_MCP_TOOL_PREFIX.test(name), false, name);
  }
  assert.equal(ANTIGRAVITY_DELEGATION_TOOLS.has("create_agent"), true);
  assert.equal(isDisallowedRoleTool("create_agent"), true);
  assert.equal(ANTIGRAVITY_DELEGATION_TOOLS.has("mcp_paseo_create_agent"), true);
  assert.equal(ANTIGRAVITY_DELEGATION_TOOLS.has("mcp__paseo__create_agent"), true);
  assert.equal(ANTIGRAVITY_DELEGATION_TOOLS.has("mcp_paseo_send_agent_prompt"), false);
  assert.equal(ANTIGRAVITY_DELEGATION_TOOLS.has("mcp__paseo__send_agent_prompt"), false);
});

test("D-0066: single-source Paseo runner/provider helpers, ANTIGRAVITY_HOME discovery, and better-paseo-antigravity transcripts", t => {
  assert.deepEqual(PREPARED_RUNNERS, ["t3", "paseo"]);
  assert.equal(Object.isFrozen(PREPARED_RUNNERS), true);
  assert.equal(isPreparedRunner("t3"), true);
  assert.equal(isPreparedRunner("paseo"), true);
  for (const r of ["claude", "codex", "cmd", "", null, undefined]) assert.equal(isPreparedRunner(r), false, String(r));

  assert.deepEqual(ANTIGRAVITY_PROVIDERS, ["antigravity", "better-paseo-antigravity"]);
  assert.equal(Object.isFrozen(ANTIGRAVITY_PROVIDERS), true);
  assert.equal(isAntigravityProvider("antigravity"), true);
  assert.equal(isAntigravityProvider("better-paseo-antigravity"), true);
  for (const p of ["codex", "claude", "paseo", "", null, undefined]) assert.equal(isAntigravityProvider(p), false, String(p));

  assert.equal(canonicalProvider("antigravity"), "antigravity");
  assert.equal(canonicalProvider("better-paseo-antigravity"), "antigravity");
  assert.equal(canonicalProvider("codex"), "codex");
  assert.equal(canonicalProvider("claude"), "claude");
  for (const p of ["paseo", "gemini", "", null, undefined]) assert.equal(canonicalProvider(p), null, String(p));

  assert.match(t3Prompt({ id: "R-0052-actor", nonce: "0123456789abcdef", wt: "/wt", ws: "/ws", text: "Go.", runner: "paseo" }), /You run as a Paseo child agent/);
  assert.match(t3Prompt({ id: "R-0052-actor", nonce: "0123456789abcdef", wt: "/wt", ws: "/ws", text: "Go.", runner: "t3" }), /You run as a T3 child thread/);

  const dir = realpathSync(temp("paseo-ag-home-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const directHome = join(dir, "ag-direct");
  const subHome = join(dir, "ag-sub");
  mkdirSync(join(directHome, "brain"), { recursive: true });
  mkdirSync(join(subHome, "antigravity-acp", "brain"), { recursive: true });
  const fakeHome = join(dir, "empty-home");
  mkdirSync(fakeHome, { recursive: true });
  assert.deepEqual(antigravityAppDirs({ env: { HOME: fakeHome, ANTIGRAVITY_HOME: directHome, T3CODE_HOME: "" }, home: fakeHome }), [directHome]);
  assert.deepEqual(antigravityAppDirs({ env: { HOME: fakeHome, ANTIGRAVITY_HOME: subHome, T3CODE_HOME: "" }, home: fakeHome }), [join(subHome, "antigravity-acp")]);

  const nonce = "fedcba9876543210";
  const prompt = t3Prompt({ id: "R-0052-actor", nonce, wt: "/wt", ws: "/ws", text: "Implement.", runner: "paseo" });
  const tx = join(subHome, "antigravity-acp", "brain", "conv-bpa", ".system_generated", "logs", "transcript_full.jsonl");
  mkdirSync(dirname(tx), { recursive: true });
  const ts = "2026-11-27T01:00:00.000Z";
  writeFileSync(tx, [
    userRow(0, wrapReq(`<paseo-system version="1" kind="agent-message">\n${prompt.replace(/&/g, "&amp;")}\n</paseo-system>`)),
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", model: "gemini-2.5-flash", created_at: ts, tool_calls: [] },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const saved = { ANTIGRAVITY_HOME: process.env.ANTIGRAVITY_HOME, ANTIGRAVITY_APP_DATA_DIR: process.env.ANTIGRAVITY_APP_DATA_DIR, GEMINI_HOME: process.env.GEMINI_HOME, T3CODE_HOME: process.env.T3CODE_HOME };
  process.env.ANTIGRAVITY_HOME = subHome;
  delete process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.GEMINI_HOME = join(dir, "g-empty");
  process.env.T3CODE_HOME = "";
  try {
    const matches = findTranscripts("better-paseo-antigravity", nonce, Date.now() - 60_000);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].session, "conv-bpa");
    assert.equal(matches[0].file, tx);
    const ev = transcriptEvents("R-0052-actor", matches[0]);
    assert.equal(ev.status, "complete");
    assert.equal(ev.firstPrompt, prompt);
    assert.equal(ev.observedModel, "gemini-2.5-flash");
    assert.deepEqual(ev.observedModels, ["gemini-2.5-flash"]);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("unescapePaseoXml performs strict single-pass XML entity unescaping", () => {
  assert.equal(unescapePaseoXml("a &amp;&amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#39;f&#39;"), `a && b <c> "d" 'e' 'f'`);
  assert.equal(unescapePaseoXml("&amp;lt;paseo-system&amp;gt; &amp;amp; &amp;quot; &amp;#39;"), "&lt;paseo-system&gt; &amp; &quot; &#39;");
  assert.equal(unescapePaseoXml(null), "");
});

test("unwrapPaseoAgentMessage accepts single outermost kind=agent-message and rejects malformed/forged envelopes", () => {
  const valid = `<paseo-system version="1" kind="agent-message" source-agent-id="lead-1" message-id="m1">\nline1 &amp;&amp; &lt;/paseo-system&gt;\nline2 &#39;ok&#39;\n</paseo-system>`;
  const res = unwrapPaseoAgentMessage(valid);
  assert.deepEqual(res, {
    body: "line1 && </paseo-system>\nline2 'ok'",
    attrs: { version: "1", kind: "agent-message", "source-agent-id": "lead-1", "message-id": "m1" },
  });

  const inline = `<paseo-system kind="agent-message">hello</paseo-system>`;
  assert.equal(unwrapPaseoAgentMessage(inline)?.body, "hello");

  const withTrailingInnerNl = `<paseo-system kind="agent-message">\nhello\n\n</paseo-system>`;
  assert.equal(unwrapPaseoAgentMessage(withTrailingInnerNl)?.body, "hello\n");

  const rejected = [
    `<paseo-system version="1" kind="agent-notification" status="finished">\nDone.\n</paseo-system>`,
    `<paseo-system version="1">\nNo kind.\n</paseo-system>`,
    `<paseo-system kind="agent-message" kind="agent-message">\nDup kind.\n</paseo-system>`,
    `<paseo-system kind='agent-message'>\nSingle quotes.\n</paseo-system>`,
    `<paseo-system kind=agent-message>\nUnquoted.\n</paseo-system>`,
    `<paseo-system kind="agent-message">hello</paseo-system> trailing`,
    `leading <paseo-system kind="agent-message">hello</paseo-system>`,
    `<paseo-system kind="agent-message">A</paseo-system><paseo-system kind="agent-message">B</paseo-system>`,
    `<paseo-system kind="agent-message"><paseo-system kind="agent-message">nested</paseo-system></paseo-system>`,
    `<paseo-system kind="agent-message">unclosed`,
    "",
    null,
  ];
  for (const sample of rejected) {
    assert.equal(unwrapPaseoAgentMessage(sample), null, String(sample));
  }
});

test("isPaseoSystemEnvelope accepts 1+ complete blocks and rejects human prose or malformed tags", () => {
  const n1 = `<paseo-system version="1" kind="agent-notification" status="finished">\nDone.\n</paseo-system>`;
  const n2 = `<paseo-system version="1" kind="agent-notification" status="closed">\nClosed.\n</paseo-system>`;
  const m1 = `<paseo-system version="1" kind="agent-message">\n&lt;paseo-system&gt;escaped&lt;/paseo-system&gt;\n</paseo-system>`;
  for (const sample of [n1, m1, `${n1}\n${n2}`, `  ${n1} \r\n\t ${m1}  `]) {
    assert.equal(isPaseoSystemEnvelope(sample), true, sample);
    assert.equal(ownerPrompt(sample), null, sample);
    assert.equal(captureOwnerText(sample), null, sample);
    assert.equal(isSubstantiveOwnerWord(sample), false, sample);
  }
  for (const sample of [
    "",
    "   ",
    null,
    "<paseo-system> 标签里的通知要过滤",
    `<paseo-system kind="agent-message">x</paseo-system> 这种要过滤`,
    `prefix ${n1}`,
    `${n1} middle ${n2}`,
    `<paseo-system kind="agent-message"><paseo-system>nested</paseo-system></paseo-system>`,
    `<paseo-system kind="agent-message">unclosed`,
    `<paseo-system kind='agent-message'>bad quotes</paseo-system>`,
  ]) {
    assert.equal(isPaseoSystemEnvelope(sample), false, String(sample));
  }
});

test("isPaseoFramed detects start-of-message protocol framing while antigravityFirstPrompt preserves plain prompts mentioning </paseo-system>", () => {
  for (const framed of [
    `<paseo-system version="1" kind="agent-message">x</paseo-system>`,
    `  <paseo-system kind="agent-notification">x</paseo-system>`,
    `<PASEO-SYSTEM>x</paseo-system>`,
    `<paseo-system kind="agent-message">unclosed`,
    `<paseo-system>a</paseo-system> trailing`,
  ]) {
    assert.equal(isPaseoFramed(framed), true, framed);
  }
  for (const plain of [
    "",
    null,
    "plain direct prompt",
    "Context note: handle </paseo-system> closing tags safely.\n\nself-loop call R-0001-actor",
    "self-loop call R-0001-actor\nNote about </paseo-system>.",
    `leading <paseo-system version="1" kind="agent-message">\nplain prompt\n</paseo-system>`,
    `<paseo-system-extra>not paseo</paseo-system-extra>`,
  ]) {
    assert.equal(isPaseoFramed(plain), false, String(plain));
  }

  const msg = `<paseo-system version="1" kind="agent-message">\nself-loop call R-0001-actor &amp;&amp; &lt;ok&gt;\n</paseo-system>`;
  assert.equal(unwrapAntigravityUserText(wrapReq(msg)), msg);
  assert.equal(antigravityFirstPrompt([userRow(0, wrapReq(msg))]), "self-loop call R-0001-actor && <ok>");

  for (const bad of [
    `<paseo-system version="1" kind="agent-notification">\nplain prompt\n</paseo-system>`,
    `<paseo-system version="1" kind="agent-message">\nplain prompt\n</paseo-system> extra`,
    `<paseo-system version="1" kind="agent-message">A</paseo-system><paseo-system version="1" kind="agent-message">B</paseo-system>`,
    `<paseo-system version="1" kind="agent-message">\nunclosed`,
  ]) {
    assert.equal(antigravityFirstPrompt([userRow(0, wrapReq(bad))]), "", bad);
  }
  for (const plain of [
    "plain direct prompt",
    "Context note: handle </paseo-system> closing tags safely.\n\nself-loop call R-0001-actor · nonce 0123456789abcdef",
    "self-loop call R-0001-actor · nonce 0123456789abcdef\nNote about </paseo-system>.",
    `leading <paseo-system version="1" kind="agent-message">\nplain prompt\n</paseo-system>`,
  ]) {
    assert.equal(antigravityFirstPrompt([userRow(0, wrapReq(plain))]), plain, plain);
  }
});

test("antigravitySessionState and Claude/Codex transcripts distinguish Paseo child vs Lead-to-Lead envelopes", t => {
  const dir = temp("paseo-sessions-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writeJsonl = (rel, rows) => {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    return file;
  };

  const childMsg = `<paseo-system version="1" kind="agent-message" source-agent-id="lead">\nAct as the actor.\n\nself-loop call R-0001-actor · nonce a1b2c3d4e5f60718\n</paseo-system>`;
  const childFile = writeJsonl("brain/c-child/.system_generated/logs/transcript_full.jsonl", [userRow(0, wrapReq(childMsg))]);
  const childState = antigravitySessionState(childFile, { summary: null });
  assert.equal(childState.state, "confirmed-child");
  assert.match(childState.firstPrompt, /self-loop call R-0001-actor · nonce a1b2c3d4e5f60718/);
  assert.deepEqual(antigravityTranscript(childFile).words, []);

  const leadMsg = `<paseo-system version="1" kind="agent-message" source-agent-id="lead-beta">\nPeer sync.\n</paseo-system>`;
  const notifMsg = `<paseo-system version="1" kind="agent-notification" status="finished">\nDone.\n</paseo-system>`;
  const leadFile = writeJsonl("brain/c-lead/.system_generated/logs/transcript_full.jsonl", [
    userRow(0, wrapReq(leadMsg)),
    userRow(1, wrapReq(notifMsg)),
    userRow(2, wrapReq("Keep default vendor policy.")),
  ]);
  assert.equal(antigravitySessionState(leadFile, { summary: null }).state, "owner");
  assert.deepEqual(antigravityTranscript(leadFile).words.map(w => w.text), ["Keep default vendor policy."]);

  const leadQuoteMsg = `<paseo-system version="1" kind="agent-message" source-agent-id="lead-beta">\nLead coordination update:\nself-loop call R-0044-actor · nonce 0123456789abcdef\nPlease review status.\n</paseo-system>`;
  const leadQuoteFile = writeJsonl("brain/c-lead-quote/.system_generated/logs/transcript_full.jsonl", [
    userRow(0, wrapReq(leadQuoteMsg)),
    userRow(1, wrapReq("Owner follow-up after quoted call.")),
  ]);
  assert.equal(antigravitySessionState(leadQuoteFile, { summary: null }).state, "owner");
  assert.deepEqual(antigravityTranscript(leadQuoteFile).words.map(w => w.text), ["Owner follow-up after quoted call."]);

  const leadDiscussMsg = `<paseo-system version="1" kind="agent-message" source-agent-id="lead-beta">\nself-loop call R-0044-actor is still running.\n</paseo-system>`;
  const leadDiscussFile = writeJsonl("brain/c-lead-discuss/.system_generated/logs/transcript_full.jsonl", [
    userRow(0, wrapReq(leadDiscussMsg)),
    userRow(1, wrapReq("Owner follow-up after discussion.")),
  ]);
  assert.equal(antigravitySessionState(leadDiscussFile, { summary: null }).state, "owner");
  assert.deepEqual(antigravityTranscript(leadDiscussFile).words.map(w => w.text), ["Owner follow-up after discussion."]);

  const anchoredChildMsg = `<paseo-system version="1" kind="agent-message" source-agent-id="lead">\nself-loop call R-0044-actor · nonce 0123456789abcdef\n\nYou run as a T3 child thread.\n</paseo-system>`;
  const anchoredChildFile = writeJsonl("brain/c-anchored-child/.system_generated/logs/transcript_full.jsonl", [
    userRow(0, wrapReq(anchoredChildMsg)),
    userRow(1, wrapReq("Should not capture.")),
  ]);
  const anchoredState = antigravitySessionState(anchoredChildFile, { summary: null });
  assert.equal(anchoredState.state, "confirmed-child");
  assert.equal(anchoredState.agent, true);
  assert.deepEqual(antigravityTranscript(anchoredChildFile).words, []);

  const dbChildPlain = writeJsonl("brain/c-db-plain/.system_generated/logs/transcript_full.jsonl", [
    userRow(0, wrapReq("Context: </paseo-system> note\nself-loop call R-0044-actor · nonce 0123456789abcdef")),
  ]);
  const dbChildState = antigravitySessionState(dbChildPlain, { summary: { parent_conversation_id: "lead-1", nesting_depth: 1 } });
  assert.equal(dbChildState.state, "confirmed-child");
  assert.match(dbChildState.firstPrompt, /<\/paseo-system>/);

  const proj = join(dir, "proj");
  mkdirSync(proj, { recursive: true });
  const claudeFile = writeJsonl("claude-lead.jsonl", [
    { type: "user", sessionId: "s1", cwd: proj, timestamp: "2026-11-26T01:00:00Z", uuid: "u1", message: { content: leadMsg } },
    { type: "user", sessionId: "s1", cwd: proj, timestamp: "2026-11-26T01:01:00Z", uuid: "u2", message: { content: "Owner turn in Claude." } },
  ]);
  assert.equal(claudeAgentSession(claudeFile), false);
  assert.deepEqual(claudeSessionWords(claudeFile, [proj]).map(w => w.text), ["Owner turn in Claude."]);

  const codexFile = writeJsonl("codex-lead.jsonl", [
    { type: "session_meta", payload: { id: "cx1", cwd: proj } },
    { type: "event_msg", timestamp: "2026-11-26T01:00:00Z", payload: { type: "user_message", id: "e1", message: leadMsg } },
    { type: "event_msg", timestamp: "2026-11-26T01:01:00Z", payload: { type: "user_message", id: "e2", message: "Owner turn in Codex." } },
  ]);
  assert.deepEqual(codexSessionWords(codexFile, [proj]).map(w => w.text), ["Owner turn in Codex."]);
});

test("lead-guard.mjs gates Paseo create_agent via initialPrompt, allows Lead send_agent_prompt, and confines Paseo children", t => {
  const dir = realpathSync(temp("paseo-guard-unit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const alpha = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "alpha") });
  const beta = loopProduct({ activity: "2026-11-26T00:00:00Z", dir: join(dir, "beta") });
  const storeDir = join(dir, "store");
  mkdirSync(storeDir, { recursive: true });
  const store = ownerStore([{ name: "alpha", records: alpha.records }, { name: "beta", records: beta.records }], { dir: storeDir });
  const appDir = join(dir, "ag-app");
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: join(dir, "g"), T3CODE_HOME: "", SELF_LOOP_LOAD_DIR: join(dir, "load") });
  const ws = join(alpha.dir, "work", "0001-actor");
  const wt = join(ws, "wt");
  mkdirSync(join(ws, "out"), { recursive: true });
  git(alpha.product, "worktree", "add", "-q", "--detach", wt);
  const nonce = "a1b2c3d4e5f60718";
  writeFileSync(join(ws, "call.json"), JSON.stringify({
    version: 2, role: "actor", round: 1, step: "actor", phase: "v1", id: "R-0001-actor", record: "rounds/0001-actor.md", ws, wt, nonce,
  }, null, 2) + "\n");
  const childPrompt = `Act as the actor.\n\nself-loop call R-0001-actor · nonce ${nonce}\n- Your working folder: ${ws}\n- The product worktree: ${wt}\n`;
  const childTx = join(appDir, "brain", "conv-child", ".system_generated", "logs", "transcript_full.jsonl");
  mkdirSync(dirname(childTx), { recursive: true });
  writeFileSync(childTx, JSON.stringify(userRow(0, wrapReq(`<paseo-system version="1" kind="agent-message">\n${childPrompt}\n</paseo-system>`))) + "\n");

  const guard = payload => spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--harness", "antigravity", "--owner-store", store], {
    encoding: "utf8", env, cwd: dir, input: JSON.stringify(payload),
  });
  for (const tool of ["create_agent", "mcp_paseo_create_agent", "mcp__paseo__create_agent"]) {
    assert.equal(JSON.parse(guard({ hookEventName: "PreToolUse", conversationId: "lead", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ initialPrompt: "no nonce" }) } }).stdout).decision, "deny");
    assert.equal(guard({ hookEventName: "PreToolUse", conversationId: "lead", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ initialPrompt: `self-loop call R-0001-actor · nonce ${nonce}` }) } }).stdout.trim(), "");
  }
  for (const tool of ["mcp_paseo_send_agent_prompt", "mcp__paseo__send_agent_prompt"]) {
    assert.equal(guard({ hookEventName: "PreToolUse", conversationId: "lead", cwd: alpha.product, toolCall: { name: tool, argumentsJson: JSON.stringify({ agentId: "beta", prompt: "ping" }) } }).stdout.trim(), "");
  }
  assert.equal(guard({ hookEventName: "PreToolUse", conversationId: "conv-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(ws, "out", "report.md"), CodeContent: "ok" }) } }).stdout.trim(), "");
  assert.equal(guard({ hookEventName: "PreToolUse", conversationId: "conv-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(wt, "src", "a.js"), CodeContent: "ok" }) } }).stdout.trim(), "");
  assert.equal(JSON.parse(guard({ hookEventName: "PreToolUse", conversationId: "conv-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(alpha.product, "src", "a.js"), CodeContent: "bad" }) } }).stdout).decision, "deny");
  assert.equal(JSON.parse(guard({ hookEventName: "PreToolUse", conversationId: "conv-child", transcriptPath: childTx, cwd: wt, toolCall: { name: "write_to_file", argumentsJson: JSON.stringify({ TargetFile: join(ws, "call.json"), CodeContent: "{}" }) } }).stdout).decision, "deny");

  for (const toolName of ["create_agent", "mcp_paseo_create_agent", "mcp_paseo_send_agent_prompt", "mcp__paseo__list_agents"]) {
    const aud = auditAccess([ws], [{ id: "R-0001-role", event: { type: "PLANNER_RESPONSE", tool_calls: [{ name: toolName, args: {} }] } }], { cwd: ws });
    assert.ok(aud.violations.some(v => v.tool === toolName), toolName);
  }
});

test("plain Antigravity [lead -> lead] stays owner while structural child headers match identically across plain and Paseo turns", t => {
  const dir = temp("paseo-plain-struct-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writeTx = (id, rows) => {
    const file = join(dir, "brain", id, ".system_generated", "logs", "transcript_full.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    return file;
  };
  const leadTx = writeTx("plain-lead", [
    userRow(0, wrapReq("[lead → lead] Compare migration notes with release checklist.")),
    userRow(1, wrapReq("Capture this genuine owner instruction.")),
  ]);
  assert.equal(antigravitySessionState(leadTx, { summary: null }).state, "owner");
  assert.equal(antigravitySessionState(leadTx, { summary: null }).agent, false);
  assert.ok(antigravityTranscript(leadTx).words.some(w => w.text === "Capture this genuine owner instruction."));

  const headers = [
    ["t3-call", t3Prompt({ id: "R-0046-actor", nonce: "0123456789abcdef", wt: "/wt", ws: "/ws", text: "Do task." })],
    ["t3-notice", '[T3 Code: the agent in T3 thread "t1" sent this message, not the user.]\nProceed.'],
    ["delegated-notice", "Delegated task node:delegated-task:1 (actor) [completed]: Done."],
    ["delegated-role", "Act as the actor sub-agent for this task."],
  ];
  for (const [label, body] of headers) {
    const plainTx = writeTx(`plain-${label}`, [userRow(0, wrapReq(body)), userRow(1, wrapReq("Child turn"))]);
    const paseoTx = writeTx(`paseo-${label}`, [userRow(0, wrapReq(`<paseo-system version="1" kind="agent-message">\n${body}\n</paseo-system>`)), userRow(1, wrapReq("Child turn"))]);
    assert.equal(antigravitySessionState(plainTx, { summary: null }).state, "confirmed-child", `plain ${label}`);
    assert.equal(antigravitySessionState(paseoTx, { summary: null }).state, "confirmed-child", `paseo ${label}`);
    assert.equal(antigravityTranscript(plainTx).words.length, 0, `plain ${label} words`);
    assert.equal(antigravityTranscript(paseoTx).words.length, 0, `paseo ${label} words`);
  }
});

test("transcriptEvents collects complete multi-turn distinct observedModels for Codex and Claude", t => {
  const dir = temp("multi-obs-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const writeJsonl = (name, rows) => {
    const file = join(dir, name);
    writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
    return file;
  };
  const ts = "2026-11-26T01:00:00.000Z";
  const codexMulti = writeJsonl("codex-multi.jsonl", [
    { timestamp: ts, type: "session_meta", payload: { id: "cx-1", cwd: "/wt" } },
    { timestamp: ts, type: "turn_context", payload: { model: "gpt-5.4" } },
    { timestamp: ts, type: "turn_context", payload: { model: "gpt-5.4" } },
    { timestamp: ts, type: "turn_context", payload: { model: "gpt-5.4-pro" } },
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ]);
  const cm = transcriptEvents("R-0046-judge", { runner: "codex", file: codexMulti });
  assert.equal(cm.observedModel, "gpt-5.4");
  assert.deepEqual(cm.observedModels, ["gpt-5.4", "gpt-5.4-pro"]);

  const codexEmpty = writeJsonl("codex-empty.jsonl", [
    { timestamp: ts, type: "session_meta", payload: { id: "cx-2", cwd: "/wt" } },
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ]);
  const ce = transcriptEvents("R-0046-judge", { runner: "codex", file: codexEmpty });
  assert.equal(ce.observedModel, null);
  assert.equal(ce.observedModels, undefined);

  const claudeMulti = writeJsonl("claude-multi.jsonl", [
    { type: "system", subtype: "init", model: "claude-opus-4-6", timestamp: ts },
    { type: "user", sessionId: "cl-1", cwd: "/wt", timestamp: ts, message: { role: "user", content: "Hi" } },
    { type: "assistant", sessionId: "cl-1", cwd: "/wt", timestamp: ts, message: { model: "claude-opus-4-6", content: [] } },
    { type: "assistant", sessionId: "cl-1", cwd: "/wt", timestamp: ts, message: { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [] } },
  ]);
  const clm = transcriptEvents("R-0046-judge", { runner: "claude", file: claudeMulti });
  assert.equal(clm.observedModel, "claude-opus-4-6");
  assert.deepEqual(clm.observedModels, ["claude-opus-4-6", "claude-sonnet-5-5"]);
});

test("D-0068: ADAPTERS, resolveAdapter, and generic transcript recording support arbitrary providers", t => {
  assert.deepEqual(ADAPTERS, ["antigravity", "claude", "codex", "generic"]);
  assert.equal(Object.isFrozen(ADAPTERS), true);
  for (const a of ADAPTERS) assert.equal(isAdapter(a), true, a);
  assert.equal(isAdapter("bogus"), false);

  assert.equal(resolveAdapter("antigravity"), "antigravity");
  assert.equal(resolveAdapter("better-paseo-antigravity"), "antigravity");
  assert.equal(resolveAdapter("custom-antigravity-plugin"), "antigravity");
  assert.equal(resolveAdapter("claude"), "claude");
  assert.equal(resolveAdapter("claudeAgent"), "claude");
  assert.equal(resolveAdapter("codex"), "codex");
  assert.equal(resolveAdapter("paseo-codex"), "codex");
  for (const p of ["pi", "cursor", "opencode", "gemini-cli", "grok", "my-custom-provider"]) {
    assert.equal(resolveAdapter(p), "generic", p);
  }
  assert.equal(resolveAdapter({ provider: "pi", adapter: "claude" }), "claude");
  assert.equal(resolveAdapter({ provider: "pi", adapter: "generic" }), "generic");
  assert.equal(resolveAdapter({ provider: "pi", adapter: "invalid" }), null);
  for (const empty of ["", "   ", null, undefined, {}]) assert.equal(resolveAdapter(empty), null, JSON.stringify(empty));

  const dir = temp("generic-tx-");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const nonce = "a1b2c3d4e5f60708";
  const prompt = t3Prompt({ id: "R-0053-actor", nonce, wt: "/wt", ws: "/ws", text: "Build feature.", runner: "paseo" });

  assert.deepEqual(findTranscripts("pi", nonce, Date.now() - 60_000), []);
  assert.throws(() => resolveChildSession("pi", nonce, Date.now() - 60_000), /generic adapter.*--transcript/);

  const jsonlFile = join(dir, "pi.jsonl");
  writeFileSync(jsonlFile, [
    { role: "user", sessionId: "pi-sess-1", cwd: "/wt", timestamp: "2026-11-27T01:00:00Z", content: prompt },
    { role: "assistant", model: "openrouter/gemini-2.5-pro-exp", timestamp: "2026-11-27T01:00:10Z", content: "Done." },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  const resolved = resolveChildSession({ provider: "pi" }, nonce, Date.now() - 60_000, null, jsonlFile);
  assert.equal(resolved.adapter, "generic");
  const ev = transcriptEvents("R-0053-actor", resolved);
  assert.equal(ev.session, "pi-sess-1");
  assert.equal(ev.status, "complete");
  assert.equal(ev.firstPrompt, prompt);
  assert.equal(ev.observedModel, "openrouter/gemini-2.5-pro-exp");
  assert.deepEqual(ev.observedModels, ["openrouter/gemini-2.5-pro-exp"]);
  assert.equal(ev.cwd, "/wt");

  const plainFile = join(dir, "plain.txt");
  writeFileSync(plainFile, `${prompt}\n\nAssistant: finished.\n`);
  const plainEv = transcriptEvents("R-0053-actor", { runner: "cursor", file: plainFile, session: "cursor-sess-9" });
  assert.equal(plainEv.session, "cursor-sess-9");
  assert.equal(plainEv.status, "complete");
  assert.equal(plainEv.firstPrompt.includes(prompt), true);
  assert.equal(plainEv.observedModel, null);

  const failedFile = join(dir, "failed.jsonl");
  writeFileSync(failedFile, [
    { role: "user", session_id: "op-fail", content: prompt },
    { type: "error", message: "boom" },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(transcriptEvents("R-0053-actor", { runner: "opencode", file: failedFile }).status, "failed");
});
