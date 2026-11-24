import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { options, put, skill, world } from "./fixture.mjs";

const GUARD = join(skill, "scripts/lead-guard.mjs");

const DELEGATION_CASES = [
  { tool: "mcp_t3-code_delegate_task", makeArgs: p => ({ task: p }) },
  { tool: "mcp__t3-code__delegate_task", makeArgs: p => ({ task: p }) },
  { tool: "delegate_task", makeArgs: p => ({ task: p }) },
  { tool: "Agent", makeArgs: p => ({ description: "actor", prompt: p }) },
  { tool: "spawn_agent", makeArgs: p => ({ message: p }) },
  { tool: "invoke_subagent", makeArgs: p => ({ TypeName: "self", Role: "Actor", Prompt: p }) },
  { tool: "run_workflow", makeArgs: p => ({ Description: "run", Script: p }) },
  { tool: "swarm", makeArgs: p => ({ action: "add", name: "actor-a", brief: p }) },
  { tool: "t3_thread_launch", makeArgs: p => ({ title: "actor-a", message: p }) },
  { tool: "mcp_t3-code_t3_thread_launch", makeArgs: p => ({ title: "actor-a", message: p }) },
  { tool: "mcp__t3-code__t3_thread_launch", makeArgs: p => ({ title: "actor-a", message: p }) },
  { tool: "create_threads", makeArgs: p => ({ threads: [{ title: "actor-a", prompt: p }] }) },
  { tool: "mcp_t3-code_create_threads", makeArgs: p => ({ threads: [{ title: "actor-a", prompt: p }] }) },
  { tool: "mcp__t3-code__create_threads", makeArgs: p => ({ threads: [{ title: "actor-a", prompt: p }] }) },
];

function setup(t) {
  const w = world(t);
  const product = w.repo(join(w.dir, "product"), {
    "src/a.mjs": "export const a = 1;\n",
    "scripts/foo.mjs": "export const foo = 1;\n",
    "docs/GUIDE.md": "# Guide\n",
    "AGENTS.md": "# Agents\n",
    "VERSION": "0.8.0\n",
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
    LC_ALL: "C",
  };

  const makePrepared = (name, {
    root = workspaces,
    role = "actor",
    round = 20,
    step = `${role}-a`,
    nonce,
    withWorktree = role !== "reviewer",
    recorded = false,
    cancelled = false,
    omitCallJson = false,
  }) => {
    const ws = join(root, name);
    mkdirSync(join(ws, "out"), { recursive: true });
    let wt = null;
    if (role === "reviewer") {
      mkdirSync(join(ws, "purpose"), { recursive: true });
      mkdirSync(join(ws, "records"), { recursive: true });
    } else if (withWorktree) {
      wt = join(ws, "wt");
      w.git(product, "worktree", "add", "-q", "--detach", wt, head);
    } else {
      wt = join(ws, "wt");
    }
    const id = `R-${String(round).padStart(4, "0")}-${step}`;
    const prompt = `self-loop call ${id} · nonce ${nonce}\n\nWork in ${wt ?? ws}.\n`;
    writeFileSync(join(ws, "t3-prompt.md"), prompt);
    if (!omitCallJson) {
      const ctx = {
        version: 2,
        role,
        round,
        step,
        phase: "v1",
        task: "features: F-0008\n",
        features: ["F-0008"],
        id,
        record: `rounds/${String(round).padStart(4, "0")}-${step}.md`,
        view: head,
        briefs: ["engines/shared.md", `engines/${role}.md`],
        base: head,
        branch: "loop/v1",
        commits: role === "critic" || role === "actor",
        extraKinds: [],
        ws,
        wt: role === "reviewer" ? null : wt,
        owns: role === "actor" ? ["scripts/"] : [],
        agent: { runner: "t3", provider: "antigravity", model: "gemini-4-hydrogen" },
        nonce,
        preparedAt: 1795518506000,
        ...(recorded ? { recorded: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
      };
      writeFileSync(join(ws, "call.json"), `${JSON.stringify(ctx, null, 1)}\n`);
    }
    return { ws, wt, id, nonce, prompt };
  };

  const invoke = (rawInput, harness = "claude") => {
    const argv = [
      GUARD,
      ...(harness === "antigravity" ? ["--harness", "antigravity"] : []),
      "--product", product,
      "--workspaces", workspaces,
    ];
    return spawnSync(process.execPath, argv, { ...options, env, cwd: w.outside, input: rawInput });
  };

  const claude = (tool, toolInput, cwd = product) =>
    invoke(JSON.stringify({ hookEventName: "PreToolUse", cwd, tool_name: tool, tool_input: toolInput }), "claude");

  const ag = (tool, args, cwd = product) =>
    invoke(JSON.stringify({ hookEventName: "PreToolUse", conversationId: "conv-lead", cwd, toolCall: { name: tool, args } }), "antigravity");

  return { w, product, head, workspaces, makePrepared, invoke, claude, ag };
}

function assertClaudeDeny(res, label) {
  assert.equal(res.status, 0, `${label}: expected exit 0, got ${res.status} (${res.stderr})`);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail(`${label}: expected JSON deny on stdout, got ${JSON.stringify(res.stdout)} (${e.message})`);
  }
  const out = parsed?.hookSpecificOutput;
  assert.equal(out?.hookEventName, "PreToolUse", label);
  assert.equal(out?.permissionDecision, "deny", label);
  assert.match(String(out?.permissionDecisionReason ?? ""), /^lead-guard:/, label);
}

function assertAgDeny(res, label) {
  assert.equal(res.status, 0, `${label}: expected exit 0, got ${res.status} (${res.stderr})`);
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch (e) {
    assert.fail(`${label}: expected JSON deny on stdout, got ${JSON.stringify(res.stdout)} (${e.message})`);
  }
  assert.equal(parsed?.decision, "deny", label);
  assert.match(String(parsed?.reason ?? ""), /^lead-guard:/, label);
}

function assertAllow(res, label) {
  assert.equal(res.status, 0, `${label}: expected exit 0, got ${res.status} (${res.stderr})`);
  assert.equal(res.stdout, "", `${label}: expected empty pass-through stdout, got ${JSON.stringify(res.stdout)}`);
}

test("DG-01 [delegation, fresh] (loss: false-verdict): raw delegation tools without nonce are denied in Claude and Antigravity", t => {
  const s = setup(t);
  const rawPrompt = "Implement scripts/foo.mjs directly without call.mjs --prepare.";
  for (const { tool, makeArgs } of DELEGATION_CASES) {
    assertClaudeDeny(s.claude(tool, makeArgs(rawPrompt)), `claude no-nonce ${tool}`);
    assertAgDeny(s.ag(tool, makeArgs(rawPrompt)), `antigravity no-nonce ${tool}`);
  }
  assertClaudeDeny(s.claude("run_workflow", { Description: "bypass", ScriptPath: "/tmp/wf.py" }), "claude run_workflow ScriptPath");
  assertAgDeny(s.ag("run_workflow", { Description: "bypass", ScriptPath: "/tmp/wf.py" }), "antigravity run_workflow ScriptPath");
});

test("DG-02 [delegation, fresh] (loss: false-verdict): fabricated 16-hex nonce, prefix nonce, multi-thread partial nonce, and outside-workspaces call.json are denied", t => {
  const s = setup(t);
  const live = s.makePrepared("0020-actor-a-live", { nonce: "a1b2c3d4e5f60718" });
  const rogue = s.makePrepared("rogue-ws", { root: join(s.w.outside, "rogue"), nonce: "cafebabe12345678" });

  const badPrompts = [
    ["fabricated-16hex", "self-loop call R-0020-actor-a · nonce deadbeef01234567\nEdit scripts/foo.mjs."],
    ["truncated-prefix", `self-loop call R-0020-actor-a · nonce ${live.nonce.slice(0, 14)}\nEdit scripts/foo.mjs.`],
    ["outside-workspaces", `self-loop call R-0020-actor-a · nonce ${rogue.nonce}\nEdit scripts/foo.mjs.`],
  ];
  for (const [kind, badPrompt] of badPrompts) {
    for (const { tool, makeArgs } of DELEGATION_CASES) {
      assertClaudeDeny(s.claude(tool, makeArgs(badPrompt)), `claude ${kind} ${tool}`);
      assertAgDeny(s.ag(tool, makeArgs(badPrompt)), `antigravity ${kind} ${tool}`);
    }
  }

  for (const tool of ["create_threads", "mcp_t3-code_create_threads", "mcp__t3-code__create_threads"]) {
    const mixed = {
      threads: [
        { title: "legit", prompt: live.prompt },
        { title: "smuggled", prompt: "Bypass task without nonce" },
      ],
    };
    assertClaudeDeny(s.claude(tool, mixed), `claude mixed-threads ${tool}`);
    assertAgDeny(s.ag(tool, mixed), `antigravity mixed-threads ${tool}`);
  }
});

test("DG-03 [delegation, fresh] (loss: false-verdict): nonces from recorded, cancelled, or missing-call.json workspaces are denied", t => {
  const s = setup(t);
  const recClean = s.makePrepared("0020-actor-rec-clean", { nonce: "1010101010101010", withWorktree: false, recorded: true });
  const recFlag = s.makePrepared("0020-actor-rec-flag", { nonce: "2020202020202020", withWorktree: true, recorded: true });
  const cancelledClean = s.makePrepared("0020-actor-cancel-clean", { nonce: "3030303030303030", withWorktree: false, cancelled: true });
  const cancelledFlag = s.makePrepared("0020-actor-cancel-flag", { nonce: "4040404040404040", withWorktree: true, cancelled: true });
  const noManifest = s.makePrepared("0020-actor-no-manifest", { nonce: "5050505050505050", withWorktree: true, omitCallJson: true });
  const goneWt = s.makePrepared("0020-actor-gone-wt", { nonce: "6060606060606060", withWorktree: true });
  s.w.git(s.product, "worktree", "remove", "--force", goneWt.wt);
  rmSync(goneWt.wt, { recursive: true, force: true });

  const deadCases = [
    ["recorded-no-wt", recClean.prompt],
    ["recorded-flag", recFlag.prompt],
    ["cancelled-no-wt", cancelledClean.prompt],
    ["cancelled-flag", cancelledFlag.prompt],
    ["missing-call-json", noManifest.prompt],
    ["missing-wt", goneWt.prompt],
  ];

  for (const [kind, prompt] of deadCases) {
    for (const { tool, makeArgs } of DELEGATION_CASES) {
      assertClaudeDeny(s.claude(tool, makeArgs(prompt)), `claude ${kind} ${tool}`);
      assertAgDeny(s.ag(tool, makeArgs(prompt)), `antigravity ${kind} ${tool}`);
    }
  }
});

test("DG-04 [delegation, fresh] (loss: stuck): live unrecorded call.json nonce allows all delegation tools in Claude and Antigravity", t => {
  const s = setup(t);
  const liveActor = s.makePrepared("0020-actor-a-live", { role: "actor", step: "actor-a", nonce: "1122334455667788" });
  const liveReviewer = s.makePrepared("0020-reviewer-frame-live", { role: "reviewer", step: "reviewer-frame", nonce: "abcdef0123456789" });

  for (const { tool, makeArgs } of DELEGATION_CASES) {
    assertAllow(s.claude(tool, makeArgs(liveActor.prompt)), `claude live actor ${tool}`);
    assertAllow(s.ag(tool, makeArgs(liveActor.prompt)), `antigravity live actor ${tool}`);
  }
  assertAllow(s.claude("Agent", { description: "reviewer", prompt: liveReviewer.prompt }), "claude live reviewer");
  assertAllow(s.ag("invoke_subagent", { TypeName: "self", Role: "Reviewer", Prompt: liveReviewer.prompt }), "antigravity live reviewer");
});

test("DG-05 [workspace-writes, fresh] (loss: wrong-result): --workspaces write pass-through allows <workDir>/tasks/ only and denies wt, manual worktrees, call.json, and out/report.md", t => {
  const s = setup(t);
  const actor = s.makePrepared("0020-actor-a-abc", { nonce: "778899aabbccddee" });
  const manualWt = join(s.workspaces, "wt-manual");
  s.w.git(s.product, "worktree", "add", "-q", "--detach", manualWt, s.head);

  assertAllow(s.claude("Write", { file_path: join(s.workspaces, "tasks", "R-0020-actor-a.md"), content: "features: F-0008\n" }), "claude tasks write");
  assertAllow(s.ag("write_file", { Path: join(s.workspaces, "tasks", "R-0020-actor-a.md"), Content: "features: F-0008\n" }), "ag tasks write_file");
  assertAllow(s.ag("write_file", { Path: join(s.workspaces, "tasks", "wave1", "R-0020-actor-a.md"), Content: "features: F-0008\n" }), "ag nested tasks write_file");

  const forbidden = [
    ["actor-wt-new", join(actor.wt, "scripts/foo.mjs")],
    ["actor-wt-tracked", join(actor.wt, "src/a.mjs")],
    ["manual-wt-new", join(manualWt, "scripts/foo.mjs")],
    ["manual-wt-tracked", join(manualWt, "src/a.mjs")],
    ["call-json", join(actor.ws, "call.json")],
    ["out-report", join(actor.ws, "out/report.md")],
    ["tasks-traversal", join(s.workspaces, "tasks", "..", "0020-actor-a-abc", "call.json")],
    ["tasks-sibling-prefix", join(s.workspaces, "tasks-evil", "payload.md")],
  ];

  for (const [kind, target] of forbidden) {
    assertClaudeDeny(s.claude("Write", { file_path: target, content: "x\n" }), `claude Write ${kind}`);
    assertClaudeDeny(s.claude("Edit", { file_path: target, old_string: "a", new_string: "b" }), `claude Edit ${kind}`);
    assertAgDeny(s.ag("write_file", { Path: target, Content: "x\n" }), `ag write_file ${kind}`);
    assertAgDeny(s.ag("edit_file", { Path: target, Target: "a", Replacement: "b" }), `ag edit_file ${kind}`);
  }
  assertAgDeny(s.ag("write_to_file", { TargetFile: pathToFileURL(join(actor.ws, "out/report.md")).href }), "ag file:// out/report.md");
});

test("DG-06 [shell-push, fresh] (loss: false-verdict / stuck): git push hook-bypass flags are denied while read-only and gated commands pass", t => {
  const s = setup(t);
  const deniedCmds = [
    "git push --no-verify origin loop/v1",
    "git -c core.hooksPath=/dev/null push origin loop/v1",
    "git -c core.hooksPath=/tmp/empty push -n origin loop/v1",
    "git -c core.hooksPath=/dev/null --no-pager push --no-verify origin loop/v1",
    "git --exec-path=/usr/lib/git-core push --no-verify origin loop/v1",
    `cd /tmp && git -C ${s.product} -c core.hooksPath=/dev/null push origin loop/v1`,
  ];
  for (const cmd of deniedCmds) {
    assertClaudeDeny(s.claude("Bash", { command: cmd }), `claude Bash ${cmd}`);
    assertAgDeny(s.ag("run_command", { CommandLine: cmd }), `ag run_command ${cmd}`);
    assertAgDeny(s.ag("shell_exec", { command: cmd }), `ag shell_exec ${cmd}`);
  }

  const allowedCmds = [
    "git status",
    "git log --oneline -5",
    "node scripts/self-loop.mjs next",
    "node scripts/gated-push.mjs --repo . --branch loop/v1 --suite-receipt receipt.json",
    "rg 'core.hooksPath' docs/",
    "git -c core.hooksPath=/dev/null status",
  ];
  for (const cmd of allowedCmds) {
    assertAllow(s.claude("Bash", { command: cmd }), `claude allow ${cmd}`);
    assertAllow(s.ag("run_command", { CommandLine: cmd }), `ag allow ${cmd}`);
  }
});

test("DG-07 [fail-closed, fresh] (loss: wrong-result): corrupt or truncated hook stdin emits deny rather than silent pass-through", t => {
  const s = setup(t);
  for (const corrupt of ["{not-json", "{truncated"]) {
    assertAgDeny(s.invoke(corrupt, "antigravity"), `ag corrupt ${corrupt}`);
    assertClaudeDeny(s.invoke(corrupt, "claude"), `claude corrupt ${corrupt}`);
  }
});
