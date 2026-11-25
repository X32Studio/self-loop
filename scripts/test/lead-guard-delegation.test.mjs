// F-0008, F-0009, D-0060, design/mandatory-control-plane.md#2
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DELEGATION_TOOLS,
  extractDelegationPrompts,
  isDelegationTool,
  liveCallNonces,
  normalizeHookInput,
  refusal,
} from "../lead-guard.mjs";
import { ANTIGRAVITY_DELEGATION_TOOLS } from "../lib/antigravity.mjs";
import { hasGitPush } from "../lib/git-push-command.mjs";
import { git, loopProduct, ownerStore, repo, scripts, temp } from "./helpers.mjs";

function makeFixture() {
  const product = repo({ "src/a.mjs": "export const a = 1;\n", "docs/GUIDE.md": "# Guide\n" });
  const workspaces = temp("guard-ws-");
  const records = temp("guard-rec-");
  const opts = { product, workspaces: [workspaces], allow: ["docs/", "AGENTS.md", "CLAUDE.md", "README.md"], records };
  const prepare = (name, meta) => {
    const ws = join(workspaces, name);
    mkdirSync(ws, { recursive: true });
    let wt = meta.wt;
    if (wt === "make") {
      wt = join(ws, "wt");
      git(product, "worktree", "add", "-q", "--detach", wt);
    }
    writeFileSync(join(ws, "call.json"), JSON.stringify({ ws, ...meta, wt }));
    return { ws, wt, nonce: meta.nonce };
  };
  return { product, workspaces, records, opts, prepare };
}

test("ANTIGRAVITY_DELEGATION_TOOLS and DELEGATION_TOOLS expose canonical delegation set", () => {
  const expectedAg = [
    "delegate_task", "mcp_t3-code_delegate_task", "mcp__t3-code__delegate_task",
    "invoke_subagent", "run_workflow", "swarm",
    "t3_thread_launch", "mcp_t3-code_t3_thread_launch", "mcp__t3-code__t3_thread_launch",
    "create_threads", "mcp_t3-code_create_threads", "mcp__t3-code__create_threads",
  ];
  for (const name of expectedAg) {
    assert.ok(ANTIGRAVITY_DELEGATION_TOOLS.has(name), name);
    assert.ok(DELEGATION_TOOLS.has(name), name);
    assert.equal(isDelegationTool(name), true, name);
  }
  assert.equal(isDelegationTool("Agent"), true);
  assert.equal(isDelegationTool("spawn_agent"), true);
  assert.equal(isDelegationTool("mcp_t3_code_delegate_task"), true);
  assert.equal(isDelegationTool("mcp__t3_code__create_threads"), true);
  assert.equal(isDelegationTool("mcp_t3-code_t3_thread_read"), false);
  assert.equal(isDelegationTool("Read"), false);
  assert.equal(isDelegationTool(""), false);
  assert.equal(isDelegationTool(null), false);
});

test("extractDelegationPrompts collects all prompt fields and rejects ScriptPath or partial threads", () => {
  assert.deepEqual(extractDelegationPrompts("delegate_task", { task: "t1" }), ["t1"]);
  assert.deepEqual(extractDelegationPrompts("Agent", { prompt: "p1" }), ["p1"]);
  assert.deepEqual(extractDelegationPrompts("invoke_subagent", { Prompt: "p2" }), ["p2"]);
  assert.deepEqual(extractDelegationPrompts("spawn_agent", { message: "m1" }), ["m1"]);
  assert.deepEqual(extractDelegationPrompts("swarm", { action: "add", brief: "b1" }), ["b1"]);
  assert.deepEqual(extractDelegationPrompts("run_workflow", { Script: "s1" }), ["s1"]);
  assert.deepEqual(extractDelegationPrompts("run_workflow", { ScriptPath: "/tmp/wf.py" }), []);
  assert.deepEqual(extractDelegationPrompts("run_workflow", { Script: "s1", ScriptPath: "/tmp/wf.py" }), []);
  assert.deepEqual(extractDelegationPrompts("create_threads", { threads: [{ prompt: "a" }, { prompt: "b" }] }), ["a", "b"]);
  assert.deepEqual(extractDelegationPrompts("mcp_t3-code_create_threads", { threads: [{ prompt: "a" }, {}] }), ["a", ""]);
  assert.deepEqual(extractDelegationPrompts("create_threads", { threads: [] }), []);
  assert.deepEqual(extractDelegationPrompts("create_threads", {}), []);
});

test("liveCallNonces accepts live actor, confined reviewer, and records delegations, and rejects dead manifests", () => {
  const f = makeFixture();
  const liveActor = f.prepare("0020-actor-live", { nonce: "0123456789abcdef", wt: "make" });
  const liveRev = f.prepare("0020-reviewer-live", { nonce: "fedcba9876543210", wt: null });
  f.prepare("0020-recorded", { nonce: "1111111111111111", wt: "make", recorded: true });
  f.prepare("0020-cancelled", { nonce: "2222222222222222", wt: "make", cancelled: true });
  const missingWt = f.prepare("0020-missing-wt", { nonce: "3333333333333333", wt: "make" });
  git(f.product, "worktree", "remove", "--force", missingWt.wt);
  rmSync(missingWt.wt, { recursive: true, force: true });
  f.prepare("0020-short-nonce", { nonce: "0123456789abcd", wt: null });
  f.prepare("0020-wrong-ws", { nonce: "4444444444444444", wt: null, ws: "/tmp/other" });
  mkdirSync(join(f.workspaces, "0020-corrupt"), { recursive: true });
  writeFileSync(join(f.workspaces, "0020-corrupt", "call.json"), "{bad");
  mkdirSync(join(f.records, "delegations"), { recursive: true });
  writeFileSync(join(f.records, "delegations", "T-0001.json"), JSON.stringify({ nonce: "aaaa1111bbbb2222", wt: null }));
  writeFileSync(join(f.records, "delegations", "T-0002.json"), JSON.stringify({ nonce: "cccc3333dddd4444", wt: null, recorded: true }));

  const live = liveCallNonces([f.workspaces], f.records);
  assert.deepEqual([...live].sort(), [liveActor.nonce, "aaaa1111bbbb2222", liveRev.nonce].sort());
});

test("refusal enforces whole-token live nonce matching across delegation tools", () => {
  const f = makeFixture();
  const live = f.prepare("0020-actor-a", { nonce: "a1b2c3d4e5f60718", wt: "make" });

  assert.equal(refusal({ tool_name: "delegate_task", tool_input: { task: `self-loop call R-0020-actor-a · nonce ${live.nonce}` } }, f.opts), null);
  assert.match(refusal({ tool_name: "delegate_task", tool_input: { task: `nonce ${live.nonce}deadbeef` } }, f.opts), /call\.mjs|dispatch\.mjs/);
  assert.match(refusal({ tool_name: "delegate_task", tool_input: { task: `nonce ${live.nonce.slice(0, 14)}` } }, f.opts), /call\.mjs|dispatch\.mjs/);
  assert.match(refusal({ tool_name: "create_threads", tool_input: { threads: [{ prompt: live.nonce }, { prompt: "no nonce" }] } }, f.opts), /call\.mjs|dispatch\.mjs/);
  assert.equal(refusal({ tool_name: "create_threads", tool_input: { threads: [{ prompt: `a ${live.nonce}` }, { prompt: `b ${live.nonce}` }] } }, f.opts), null);
});

test("refusal narrows --workspaces writes strictly to <w>/tasks/ and defeats traversal, symlinks, and file URLs", () => {
  const f = makeFixture();
  const actor = f.prepare("0020-actor-a", { nonce: "1122334455667788", wt: "make" });
  mkdirSync(join(f.workspaces, "tasks"), { recursive: true });
  const escapeLink = join(f.workspaces, "tasks", "escape.json");
  symlinkSync(join(actor.ws, "call.json"), escapeLink);

  const write = (file, tool = "Write") => refusal({ tool_name: tool, cwd: f.product, tool_input: { file_path: file } }, f.opts);
  assert.equal(write(join(f.workspaces, "tasks", "R-0020-actor-a.md")), null);
  assert.equal(write(join(f.workspaces, "tasks", "nested", "R-0020-actor-a.md")), null);
  assert.match(write(join(f.workspaces, "tasks")), /tasks\//);
  assert.match(write(escapeLink), /tasks\//);
  assert.match(write(join(actor.ws, "call.json")), /tasks\//);
  assert.match(write(join(actor.ws, "out", "report.md")), /tasks\//);
  assert.match(write(join(actor.wt, "src", "a.mjs")), /tasks\//);
  assert.match(write(join(f.workspaces, "tasks", "..", "0020-actor-a", "call.json")), /tasks\//);
  assert.match(write(join(f.workspaces, "tasks-evil", "x.md")), /tasks\//);
  assert.match(refusal({
    hookEventName: "PreToolUse",
    conversationId: "c1",
    cwd: f.product,
    toolCall: { name: "write_to_file", args: { TargetFile: pathToFileURL(join(actor.ws, "out", "report.md")).href } },
  }, { ...f.opts, format: "antigravity" }), /tasks\//);
});

test("hasGitPush catches hook-bypass flags and global options with zero false kills", () => {
  for (const cmd of [
    "git push --no-verify origin loop/v1",
    "git push -n origin loop/v1",
    "git -c core.hooksPath=/dev/null push origin loop/v1",
    "git -ccore.hooksPath=/dev/null push origin loop/v1",
    "git -c core.hooksPath=/tmp/empty push -n origin loop/v1",
    "git --exec-path=/usr/lib/git-core push --no-verify origin loop/v1",
    "git --no-lazy-fetch --attr-source=HEAD push origin loop/v1",
    "git -C/tmp/repo -c core.hooksPath=/dev/null push origin loop/v1",
  ]) assert.equal(hasGitPush(cmd), true, cmd);

  for (const cmd of [
    "git status",
    "git log --oneline -5",
    "git -c core.hooksPath=/dev/null status",
    "git --exec-path push",
    "node scripts/self-loop.mjs next",
    "node scripts/gated-push.mjs --repo . --branch loop/v1",
    "rg 'core.hooksPath' docs/",
  ]) assert.equal(hasGitPush(cmd), false, cmd);
});

test("CLI fails closed on malformed or non-object stdin in both Claude and Antigravity formats", () => {
  const f = makeFixture();
  const run = (input, extra = []) => spawnSync(
    process.execPath,
    [join(scripts, "lead-guard.mjs"), ...extra, "--product", f.product, "--workspaces", f.workspaces],
    { input, encoding: "utf8" }
  );
  for (const bad of ["{not-json", "{truncated", "[]", '"str"', "123"]) {
    const claude = run(bad);
    assert.equal(claude.status, 0, bad);
    assert.equal(JSON.parse(claude.stdout).hookSpecificOutput.permissionDecision, "deny", bad);
    const ag = run(bad, ["--harness", "antigravity"]);
    assert.equal(ag.status, 0, bad);
    assert.equal(JSON.parse(ag.stdout).decision, "deny", bad);
  }
  assert.equal(run("").stdout, "");
  assert.equal(run("   ", ["--harness", "antigravity"]).stdout, "");
});

test("normalizeHookInput, multi-records liveCallNonces, and ownerStore refusal enforce fail-closed rules", () => {
  assert.match(normalizeHookInput({ hookEventName: "PreToolUse", toolCall: { name: "read_file", argumentsJson: "{bad" } }).argError, /malformed JSON/);
  assert.match(normalizeHookInput({ tool_name: "Write", tool_input: "{bad" }).argError, /malformed JSON/);
  assert.equal(normalizeHookInput({ tool_name: "Write", tool_input: JSON.stringify({ file_path: "a.js" }) }).args.file_path, "a.js");

  const a = loopProduct(), b = loopProduct();
  mkdirSync(join(a.records, "delegations"), { recursive: true });
  mkdirSync(join(b.records, "delegations"), { recursive: true });
  writeFileSync(join(a.records, "delegations", "T-0001.json"), JSON.stringify({ nonce: "aaaa1111bbbb2222", wt: null }));
  writeFileSync(join(b.records, "delegations", "T-0002.json"), JSON.stringify({ nonce: "cccc3333dddd4444", wt: null }));
  assert.deepEqual([...liveCallNonces([], [a.records, b.records])].sort(), ["aaaa1111bbbb2222", "cccc3333dddd4444"]);

  const store = ownerStore([{ name: "alpha", records: a.records }, { name: "beta", records: b.records }]);
  assert.equal(refusal({ hookEventName: "PreToolUse", cwd: a.product, toolCall: { name: "delegate_task", argumentsJson: JSON.stringify({ task: "nonce cccc3333dddd4444" }) } }, { ownerStore: store, format: "antigravity" }), null);
  assert.match(refusal({ hookEventName: "PreToolUse", toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: "src/a.js" }) } }, { ownerStore: store, format: "antigravity" }), /requires hook cwd/);
});
