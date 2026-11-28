// F-0004, F-0008, F-0009, D-0052, D-0060
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as leadGuardModule from "../lead-guard.mjs";
import { productCode, refusal } from "../lead-guard.mjs";
import { extractStructuredToolPaths, extractToolPaths } from "../lib/antigravity.mjs";
import { antigravitySessionState } from "../lib/antigravity-words.mjs";
import { commonGitDir } from "../lib/path-canonical.mjs";
import { git, repo, scripts, temp } from "./helpers.mjs";

function setup() {
  const product = repo({ "src/a.js": "x\n", "docs/PRODUCT.md": "p\n", "AGENTS.md": "a\n" });
  const workspaces = temp("loop-work-");
  const wt = join(workspaces, "0042-actor-x", "wt");
  mkdirSync(join(workspaces, "0042-actor-x"), { recursive: true });
  git(product, "worktree", "add", "-q", "--detach", wt);
  const lead = join(temp("lead-"), "rewrite");
  git(product, "worktree", "add", "-q", "--detach", lead);
  const other = repo({ "src/a.js": "y\n" });
  return { product, workspaces, wt, lead, other, opts: { product, workspaces: [workspaces], allow: ["docs/", "AGENTS.md", "CLAUDE.md", "README.md"] } };
}

test("edits: product code in any checkout and role workspaces are refused; docs, rule files, task files and other repositories are not", () => {
  const s = setup();
  const edit = (file, tool = "Edit") => refusal({ tool_name: tool, cwd: s.product, tool_input: { file_path: file } }, s.opts);
  assert.match(edit(join(s.product, "src/a.js")), /src\/a\.js is product code/);
  assert.match(edit(join(s.lead, "src/a.js"), "Write"), /product code/, "a linked worktree of the product too");
  assert.match(edit(join(s.lead, "src/new/b.js"), "Write"), /product code/, "a new file too");
  assert.equal(edit(join(s.product, "docs/PRODUCT.md")), null);
  assert.equal(edit(join(s.lead, "AGENTS.md")), null);
  assert.equal(edit(join(s.workspaces, "tasks/R-0001-actor.md"), "Write"), null, "a task brief under tasks/");
  assert.match(edit(join(s.wt, "src/a.js")), /inside workspace root/, "an actor's workspace is denied");
  assert.equal(edit(join(s.other, "src/a.js")), null, "another repository");
  assert.equal(edit("/tmp/scratch.txt", "Write"), null);
});

test("push: a direct git push is refused, gated-push is not, and other git commands pass", () => {
  const s = setup();
  const bash = command => refusal({ tool_name: "Bash", tool_input: { command } }, s.opts);
  for (const c of ["git push origin loop/a1", "cd x && git -C /r push -u origin b", "git --no-pager push", "GIT_ASKPASS=x git push"]) assert.ok(bash(c), c);
  for (const c of ["node scripts/gated-push.mjs --repo . --branch loop/a1 --suite-receipt r.json", "git log --oneline -3", "git status", "echo push", "git stash push"]) assert.equal(bash(c), null, c);
});

test("CLI: prints a deny decision for a refused call or malformed JSON, nothing otherwise, and never fails", () => {
  const s = setup();
  const run = input => spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--product", s.product, "--workspaces", s.workspaces], { input, encoding: "utf8" });
  const denied = run(JSON.stringify({ tool_name: "Edit", cwd: s.product, tool_input: { file_path: join(s.product, "src/a.js") } }));
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allowed = run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: join(s.product, "src/a.js") } }));
  assert.deepEqual([allowed.status, allowed.stdout], [0, ""]);
  const malformed = run("not json");
  assert.equal(malformed.status, 0);
  assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(malformed.stdout).hookSpecificOutput.permissionDecisionReason, /malformed hook JSON/);
});

test("B21: push must be the git subcommand, even when the line also mentions gated-push", () => {
  const s = setup();
  const bash = command => refusal({ tool_name: "Bash", tool_input: { command } }, s.opts);
  for (const c of [
    "rg 'git push' docs/",
    "printf '%s\\n' 'git push' > docs/example.md",
    "cat <<'DOC' > docs/example.md\ngit push origin main\nDOC\n",
    "echo documented # git push origin main",
    'echo "example; git push origin main"',
    "git --help push",
    "git push --help",
    "command -v git push",
    'git grep "git push" -- docs/',
  ]) assert.equal(bash(c), null, c);
  for (const c of [
    'cd x && git -C "/work tree" push --dry-run',
    'printf "%s" gated-push.mjs; /usr/bin/git push origin main',
    'node scripts/gated-push.mjs || command git push origin main',
    "export A=1\n GIT_ASKPASS=x git -c 'core.sshCommand=ssh -v' 'push' main",
    "git push origin main # gated-push.mjs",
  ]) assert.ok(bash(c), c);
});

test("B22: configuring the product with a linked checkout protects code in every checkout", () => {
  const s = setup(), opts = { ...s.opts, product: s.lead };
  const edit = file => refusal({ tool_name: "Write", cwd: s.lead, tool_input: { file_path: file } }, opts);
  assert.match(edit(join(s.product, "src/a.js")), /product code/);
  assert.match(edit(join(s.lead, "src/new.js")), /product code/);
  assert.match(edit(join(s.wt, "src/a.js")), /inside workspace root/);
  assert.equal(edit(join(s.workspaces, "tasks/R-0001-actor.md")), null);
  assert.equal(edit(join(s.product, "docs/PRODUCT.md")), null);
});

test("D-0007: replay recorded pushes and text-only mentions from here-document commands", () => {
  const { opts } = setup();
  const cases = JSON.parse(readFileSync(new URL("./fixtures/d0007-lead-guard-replay.json", import.meta.url)));
  for (const { session, time, refuse, lines } of cases) {
    const result = refusal({ tool_name: "Bash", tool_input: { command: lines.join("\n") } }, opts);
    assert.equal(Boolean(result), refuse, session + " " + time);
  }
});

test("D-0007: here-document targets are redirects and bodies are consumed in shell order", () => {
  const { opts } = setup();
  const bash = command => refusal({ tool_name: "Bash", tool_input: { command } }, opts);
  const withBodies = "cat 3<<-'FIRST' <<SE\\COND\n\tFIRST suffix\ngit push inside first\n\tFIRST\ngit push inside second\nSECOND\n";
  assert.equal(bash(withBodies), null);
  assert.match(bash(withBodies + "git push origin main"), /direct git push/);
  assert.match(bash("cat <<'END'; git push origin main\ntext\nEND"), /direct git push/);
  assert.match(bash("2<<42 git push origin main\ntext\n42"), /direct git push/);
  const continued = "cat <<EOF\ntext\\\nEOF\ngit push still inside\nEO\\\nF\n";
  assert.equal(bash(continued), null);
  assert.match(bash(continued + "git push origin main"), /direct git push/);
});

test("D-0019 item 2: the lead's own harness file, ignored by the checkout's exclude file, is editable; product code stays refused", () => {
  const s = setup();
  writeFileSync(join(s.product, ".git", "info", "exclude"), "/.env\n/.claude/\n/AGENTS.local.md\n/AGENTS.md\n");
  mkdirSync(join(s.product, ".claude"));
  writeFileSync(join(s.product, ".claude", "settings.local.json"), "{}\n");
  const opts = { ...s.opts, allow: ["docs/", "AGENTS.md", "CLAUDE.md", "README.md", "VERSION"] };
  const edit = (file, tool = "Edit") => refusal({ tool_name: tool, cwd: s.product, tool_input: { file_path: file } }, opts);
  assert.equal(edit(".claude/settings.local.json"), null);
  assert.equal(edit(".claude/hooks/new.json", "Write"), null);
  assert.equal(edit(".env", "Write"), null);
  assert.match(edit("src/a.js"), /src\/a\.js is product code .*\(tracked by Git\)/);
  assert.match(edit("src/b.js", "Write"), /src\/b\.js is product code .*Git would track it/);
  assert.match(edit("VERSIONS", "Write"), /would track it/);
  assert.equal(edit("VERSION", "Write"), null);
});

test("Git decides: an ignored file a checkout's index tracks stays product code there, and nothing under .git is", () => {
  const s = setup();
  writeFileSync(join(s.product, ".git", "info", "exclude"), "/local/\n");
  mkdirSync(join(s.product, "local"));
  writeFileSync(join(s.product, "local", "kept.js"), "x\n");
  git(s.product, "add", "-f", "local/kept.js");
  const edit = (cwd, file) => refusal({ tool_name: "Edit", cwd, tool_input: { file_path: file } }, s.opts);
  assert.match(edit(s.product, "local/kept.js"), /tracked by Git/);
  assert.equal(edit(s.product, "local/other.js"), null);
  assert.equal(edit(s.lead, "local/kept.js"), null, "the linked checkout's index does not hold it");
  assert.equal(edit(s.product, ".git/info/exclude"), null);
  assert.equal(edit(s.lead, ".git"), null);
  assert.equal(productCode(s.product, ".GIT/config"), null);
});

test("pathnames are taken literally: glob characters and a leading colon name one file", () => {
  const s = setup();
  writeFileSync(join(s.product, ".gitignore"), "/src/\\[ab\\].js\n/:notes.md\n");
  git(s.product, "add", ".gitignore");
  git(s.product, "commit", "-q", "-m", "ignore literal names");
  assert.equal(productCode(s.product, "src/[ab].js"), null);
  assert.equal(productCode(s.product, ":notes.md"), null);
  assert.equal(productCode(s.product, "src/a.js"), "tracked by Git");
  assert.match(productCode(s.product, "src/[cd].js"), /would track it/);
});

test("with core.ignorecase a case variant of a tracked file is the tracked file", () => {
  const s = setup();
  git(s.product, "config", "core.ignorecase", "true");
  writeFileSync(join(s.product, ".gitignore"), "/SRC/\n");
  assert.equal(productCode(s.product, "SRC/A.js"), "tracked by Git");
  git(s.product, "config", "core.ignorecase", "false");
  assert.equal(productCode(s.product, "SRC/A.js"), null);
});

test("CLI: a Git that cannot answer refuses the edit and names why; unreadable input fails closed with deny", () => {
  const s = setup();
  const run = input => spawnSync(process.execPath, [join(scripts, "lead-guard.mjs"), "--product", s.product, "--workspaces", s.workspaces],
    { input, encoding: "utf8", env: { PATH: "/nonexistent" } });
  const denied = run(JSON.stringify({ tool_name: "Write", cwd: s.product, tool_input: { file_path: "src/new.js" } }));
  const reason = JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /src\/new\.js is product code .*Git could not list it/);
  const truncated = run("{truncated");
  assert.equal(truncated.status, 0);
  assert.equal(JSON.parse(truncated.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(truncated.stdout).hookSpecificOutput.permissionDecisionReason, /malformed hook JSON/);
});

test("commonGitDir lives solely in lib/path-canonical.mjs and is not re-exported by lead-guard.mjs", () => {
  const s = setup();
  assert.equal("commonGitDir" in leadGuardModule, false);
  assert.ok(commonGitDir(s.product)?.top);
});

test("Antigravity confirmed-child PreToolUse scopes writes to own bound out/ and writer wt/ while failing closed everywhere else", () => {
  const s = setup();
  const appDir = temp("lg-child-app-");
  const wrap = body => `<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>\n</USER_REQUEST>`;
  const step0 = (content, extra = {}) => ({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T01:00:00Z", ...(content !== undefined ? { content } : {}), ...extra });
  const writeTx = (id, name, rows) => {
    const dir = join(appDir, "brain", id, ".system_generated", "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, rows.map(r => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n");
    return file;
  };
  const prep = (name, { role, nonce, withWt = true, recorded = false, cancelled = false }) => {
    const ws = join(s.workspaces, name);
    mkdirSync(join(ws, "out"), { recursive: true });
    let wt = null;
    if (withWt) {
      wt = join(ws, "wt");
      git(s.product, "worktree", "add", "-q", "--detach", wt);
    }
    writeFileSync(join(ws, "call.json"), JSON.stringify({
      ws, wt, role, nonce,
      ...(recorded ? { recorded: true } : {}),
      ...(cancelled ? { cancelled: true } : {}),
    }));
    const prompt = `Act as the test sub-agent for this task.\n\nself-loop call R-0039-${name} · nonce ${nonce}`;
    return { ws, wt, nonce, prompt };
  };

  const reviewer = prep("0039-rev", { role: "reviewer", nonce: "aaaa1111bbbb2222", withWt: true });
  const judge = prep("0039-judge", { role: "judge", nonce: "cccc3333dddd4444", withWt: true });
  const actor = prep("0039-actor", { role: "actor", nonce: "eeee5555ffff6666", withWt: true });
  const critic = prep("0039-critic", { role: "critic", nonce: "1111aaaa2222bbbb", withWt: true });
  const recorded = prep("0039-rec", { role: "actor", nonce: "3333cccc4444dddd", withWt: true, recorded: true });
  const cancelled = prep("0039-can", { role: "actor", nonce: "5555eeee6666ffff", withWt: true, cancelled: true });
  const symlinkOutCall = prep("0039-sym-out", { role: "actor", nonce: "7777888899990000", withWt: true });
  rmSync(join(symlinkOutCall.ws, "out"), { recursive: true, force: true });
  symlinkSync(s.product, join(symlinkOutCall.ws, "out"));

  symlinkSync(s.product, join(actor.wt, "escape-prod"));
  symlinkSync(join(actor.ws, "call.json"), join(actor.ws, "out", "escape-call.json"));

  const revTx = writeTx("c-rev", "transcript_full.jsonl", [step0(wrap(reviewer.prompt))]);
  const judgeTx = writeTx("c-judge", "transcript_full.jsonl", [step0(wrap(judge.prompt))]);
  const actorTx = writeTx("c-actor", "transcript_full.jsonl", [step0(wrap(actor.prompt))]);
  const criticTx = writeTx("c-critic", "transcript_full.jsonl", [step0(wrap(critic.prompt))]);
  const recTx = writeTx("c-rec", "transcript_full.jsonl", [step0(wrap(recorded.prompt))]);
  const canTx = writeTx("c-can", "transcript_full.jsonl", [step0(wrap(cancelled.prompt))]);
  const ambigTx = writeTx("c-ambig", "transcript_full.jsonl", [step0(wrap(`${actor.prompt}\n${critic.prompt}`))]);
  const truncTx = writeTx("c-trunc", "transcript.jsonl", [step0(wrap(actor.prompt), { truncated_fields: ["content"] })]);
  const corruptTx = writeTx("c-corrupt", "transcript_full.jsonl", ['{"step_index":0,"type":"USER_INPUT"']);
  const ownerTx = writeTx("c-owner", "transcript_full.jsonl", [step0(wrap(`Inspect nonce ${actor.nonce}`))]);
  const symOutTx = writeTx("c-sym-out", "transcript_full.jsonl", [step0(wrap(symlinkOutCall.prompt))]);

  assert.equal(antigravitySessionState(actorTx).firstPrompt, actor.prompt);
  assert.equal(antigravitySessionState(truncTx).firstPrompt, null);
  assert.equal(antigravitySessionState(truncTx, { summary: { nesting_depth: 1 } }).firstPrompt, null);
  assert.equal(antigravitySessionState(corruptTx).firstPrompt, null);

  const agOpts = { ...s.opts, format: "antigravity" };
  const agWrite = (tx, target, cwd = s.product) => refusal({
    hookEventName: "PreToolUse",
    conversationId: "c-test",
    transcriptPath: tx,
    cwd,
    toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: target, Content: "x" }) },
  }, agOpts);

  for (const [tx, call] of [[revTx, reviewer], [judgeTx, judge]]) {
    assert.equal(agWrite(tx, join(call.ws, "out", "report.md")), null);
    assert.equal(agWrite(tx, join(call.ws, "out", "design", "note.md")), null);
    assert.ok(agWrite(tx, join(call.wt, "src", "a.js")));
    assert.ok(agWrite(tx, join(call.ws, "call.json")));
    assert.ok(agWrite(tx, join(s.workspaces, "tasks", "R-0039.md")));
    assert.ok(agWrite(tx, join(actor.ws, "out", "report.md")));
    assert.ok(agWrite(tx, join(s.product, "src", "a.js")));
    assert.ok(agWrite(tx, join(s.product, "docs", "PRODUCT.md")));
  }

  for (const [tx, call] of [[actorTx, actor], [criticTx, critic]]) {
    assert.equal(agWrite(tx, join(call.ws, "out", "report.md")), null);
    assert.equal(agWrite(tx, join(call.wt, "src", "a.js")), null);
    assert.equal(agWrite(tx, "src/new.js", call.wt), null);
    assert.ok(agWrite(tx, join(call.wt, ".git")));
    assert.ok(agWrite(tx, join(call.wt, ".git", "config")));
    assert.ok(agWrite(tx, join(call.ws, "call.json")));
    assert.ok(agWrite(tx, join(s.workspaces, "tasks", "R-0039.md")));
    assert.ok(agWrite(tx, join(s.product, "src", "a.js")));
    assert.ok(agWrite(tx, join(s.product, "docs", "PRODUCT.md")));
    assert.ok(refusal({
      hookEventName: "PreToolUse",
      conversationId: "c-test",
      transcriptPath: tx,
      cwd: call.wt,
      toolCall: { name: "run_command", argumentsJson: JSON.stringify({ CommandLine: "git push origin main" }) },
    }, agOpts));
  }

  assert.ok(agWrite(actorTx, join(actor.wt, "escape-prod", "src", "a.js")));
  assert.ok(agWrite(actorTx, join(actor.ws, "out", "escape-call.json")));
  assert.ok(agWrite(symOutTx, join(symlinkOutCall.ws, "out", "src", "a.js")));
  assert.ok(agWrite(actorTx, join(critic.wt, "src", "a.js")));

  for (const [tx, call] of [
    [recTx, recorded],
    [canTx, cancelled],
    [ambigTx, actor],
    [truncTx, actor],
    [corruptTx, actor],
    [ownerTx, actor],
    [join(appDir, "missing.jsonl"), actor],
  ]) {
    assert.ok(agWrite(tx, join(call.ws, "out", "report.md")));
    assert.ok(agWrite(tx, join(call.wt, "src", "a.js")));
  }

  assert.ok(refusal({
    tool_name: "Write",
    cwd: s.product,
    transcriptPath: actorTx,
    tool_input: { file_path: join(actor.ws, "out", "report.md") },
  }, { ...s.opts, format: "claude" }));
});

test("Antigravity bound child refuses all out-of-scope targets exhaustively without falling through to lead policy", () => {
  const s = setup();
  writeFileSync(join(s.product, ".git", "info", "exclude"), "/.env\n");
  const records = temp("lg-child-rec-");
  const external = temp("lg-child-ext-");
  const appDir = temp("lg-child-exh-app-");
  const wrap = body => `<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n</t3_code_instructions>\n\n<user_request>\n${body}\n</user_request><runtime_info>info</runtime_info>\n</USER_REQUEST>`;
  const writeTx = (id, body) => {
    const dir = join(appDir, "brain", id, ".system_generated", "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "transcript_full.jsonl");
    writeFileSync(file, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T01:00:00Z", content: wrap(body) }) + "\n");
    return file;
  };
  const prep = (name, role, nonce) => {
    const ws = join(s.workspaces, name);
    mkdirSync(join(ws, "out"), { recursive: true });
    const wt = join(ws, "wt");
    git(s.product, "worktree", "add", "-q", "--detach", wt);
    writeFileSync(join(ws, "call.json"), JSON.stringify({ ws, wt, role, nonce }));
    const tx = writeTx(`c-${name}`, `Act as the test sub-agent for this task.\n\nself-loop call R-0040-${name} · nonce ${nonce}`);
    return { ws, wt, tx };
  };

  const rev = prep("0040-rev", "reviewer", "1010202030304040");
  const judge = prep("0040-judge", "judge", "5050606070708080");
  const actor = prep("0040-actor", "actor", "a0a0b0b0c0c0d0d0");
  const critic = prep("0040-critic", "critic", "e0e0f0f011223344");
  const ownerTx = writeTx("c-owner", "Update docs and dispatch the next task");
  const agOpts = { ...s.opts, records, format: "antigravity" };
  const agWrite = (tx, target, cwd = s.product) => refusal({
    hookEventName: "PreToolUse",
    conversationId: "c-exh",
    ...(tx ? { transcriptPath: tx } : {}),
    ...(cwd !== null ? { cwd } : {}),
    toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: target, Content: "x" }) },
  }, agOpts);

  const leadAllowedTargets = [
    join(s.workspaces, "tasks", "hijack.md"),
    join(records, "rounds", "0040-fake.md"),
    join(s.product, "docs", "PRODUCT.md"),
    join(s.product, "README.md"),
    join(s.product, ".env"),
    join(external, "escape.txt"),
    "/tmp/lead-guard-child-escape.txt",
  ];

  for (const target of leadAllowedTargets) {
    assert.equal(agWrite(ownerTx, target), null, `owner lead allows ${target}`);
    assert.equal(agWrite(null, target), null, `no-transcript lead allows ${target}`);
  }
  assert.match(agWrite(ownerTx, join(s.product, "src", "a.js")), /product code/);
  assert.match(agWrite(ownerTx, join(actor.ws, "out", "report.md")), /inside workspace root/);

  for (const child of [rev, judge]) {
    assert.equal(agWrite(child.tx, join(child.ws, "out", "report.md")), null);
    assert.match(agWrite(child.tx, "out/report.md", null), /requires hook cwd/);
    for (const target of [...leadAllowedTargets, join(child.wt, "src", "a.js")]) {
      const denied = agWrite(child.tx, target);
      assert.ok(denied, `denied ${target}`);
      assert.match(denied, /outside delegated child workspace scope/);
      const granted = denied.split("write only under ")[1] ?? "";
      assert.ok(granted.includes("/out/"), denied);
      assert.equal(granted.includes("/wt/"), false, denied);
    }
  }

  for (const child of [actor, critic]) {
    assert.equal(agWrite(child.tx, join(child.ws, "out", "report.md")), null);
    assert.equal(agWrite(child.tx, join(child.wt, "src", "a.js")), null);
    assert.match(agWrite(child.tx, "src/a.js", null), /requires hook cwd/);
    for (const target of [...leadAllowedTargets, join(child.wt, ".git", "config")]) {
      const denied = agWrite(child.tx, target);
      assert.ok(denied, `denied ${target}`);
      assert.match(denied, /outside delegated child workspace scope/);
      const granted = denied.split("write only under ")[1] ?? "";
      assert.ok(granted.includes("/out/"), denied);
      assert.ok(granted.includes("/wt/"), denied);
    }
  }
});

test("structured write destination extraction ignores embedded body file:// URIs while enforcing structured targets and fail-closed missing paths", () => {
  const s = setup();
  const records = temp("lg-wt-rec-"), external = temp("lg-wt-ext-"), appDir = temp("lg-wt-app-");
  const recFile = join(records, "rounds", "0040.md"), extFile = join(external, "outside.txt"), prodSrc = join(s.product, "src", "a.js");
  const recUri = pathToFileURL(recFile).href, extUri = pathToFileURL(extFile).href, srcUri = pathToFileURL(prodSrc).href;
  const body = `See [round](${recUri}), [src](${srcUri}), and ${extUri}\n`;

  assert.deepEqual(extractStructuredToolPaths({ Path: "/ws/out/report.md", Content: body }), ["/ws/out/report.md"]);
  assert.deepEqual(extractStructuredToolPaths({ TargetFile: recUri, CodeContent: extUri }), [recFile]);
  assert.deepEqual(extractStructuredToolPaths({ file_path: prodSrc, Target: recUri, Replacement: extUri }), [prodSrc]);
  assert.deepEqual(extractStructuredToolPaths({
    TargetFile: "/ws/wt/src/a.js",
    TargetContent: recUri,
    ReplacementContent: extUri,
    ReplacementChunks: [{ TargetContent: srcUri, ReplacementContent: extUri }],
  }), ["/ws/wt/src/a.js"]);
  assert.deepEqual(extractStructuredToolPaths({ Path: "/ws/out/report.md", paths: [extUri] }), ["/ws/out/report.md", extFile]);
  assert.deepEqual(extractStructuredToolPaths({ Content: body }), []);
  assert.deepEqual(extractStructuredToolPaths({ Path: "" }), []);
  assert.deepEqual(extractStructuredToolPaths({ Path: "   " }), []);
  assert.deepEqual(extractStructuredToolPaths({ Path: "file://" }), ["/"]);
  const auditPaths = extractToolPaths({ Path: "/ws/out/report.md", Content: body });
  assert.ok(auditPaths.includes("/ws/out/report.md") && auditPaths.includes(recFile) && auditPaths.includes(prodSrc) && auditPaths.includes(extFile));

  const wrap = text => `<USER_REQUEST>\n<t3_code_instructions>\n## Mode\n</t3_code_instructions>\n\n<user_request>\n${text}\n</user_request><runtime_info>info</runtime_info>\n</USER_REQUEST>`;
  const writeTx = (id, text) => {
    const dir = join(appDir, "brain", id, ".system_generated", "logs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "transcript_full.jsonl");
    writeFileSync(file, JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-25T01:00:00Z", content: wrap(text) }) + "\n");
    return file;
  };
  const prep = (name, role, nonce) => {
    const ws = join(s.workspaces, name), wt = join(ws, "wt");
    mkdirSync(join(ws, "out"), { recursive: true });
    git(s.product, "worktree", "add", "-q", "--detach", wt);
    writeFileSync(join(ws, "call.json"), JSON.stringify({ ws, wt, role, nonce }));
    return { ws, wt, tx: writeTx(`c-${name}`, `Act as the test sub-agent for this task.\n\nself-loop call R-0041-${name} · nonce ${nonce}`) };
  };
  const actor = prep("0041-actor", "actor", "1234abcd5678ef90");
  const rev = prep("0041-rev", "reviewer", "90ef7856cdab3412");
  const ownerTx = writeTx("c-owner", "Update docs with links");
  const agOpts = { ...s.opts, records, format: "antigravity" };
  const callWrite = (tx, name, args) => refusal({
    hookEventName: "PreToolUse",
    conversationId: "c-wt",
    transcriptPath: tx,
    cwd: s.product,
    toolCall: { name, argumentsJson: JSON.stringify(args) },
  }, agOpts);

  const actorWtFile = join(actor.wt, "src", "a.js"), actorOut = join(actor.ws, "out", "report.md"), revOut = join(rev.ws, "out", "report.md");
  for (const [name, args] of [
    ["write_file", { Path: actorOut, Content: body }],
    ["write_file", { Path: actorWtFile, Content: body }],
    ["edit_file", { Path: actorWtFile, Target: recUri, Replacement: extUri }],
    ["write_to_file", { TargetFile: actorWtFile, CodeContent: body }],
    ["replace_file_content", { TargetFile: actorWtFile, TargetContent: recUri, ReplacementContent: extUri }],
    ["multi_replace_file_content", { TargetFile: actorWtFile, ReplacementChunks: [{ TargetContent: "x", ReplacementContent: body }] }],
  ]) assert.equal(callWrite(actor.tx, name, args), null, `actor allows ${name}`);
  assert.equal(callWrite(rev.tx, "write_file", { Path: revOut, Content: body }), null);
  assert.equal(callWrite(ownerTx, "write_file", { Path: join(s.product, "docs", "PRODUCT.md"), Content: body }), null);

  for (const [label, tx, name, args] of [
    ["actor Path outside", actor.tx, "write_file", { Path: recFile, Content: "x" }],
    ["actor file:// Path outside", actor.tx, "write_file", { Path: extUri, Content: "x" }],
    ["actor file:// TargetFile outside", actor.tx, "replace_file_content", { TargetFile: recUri, TargetContent: "a", ReplacementContent: "b" }],
    ["actor file:// paths outside", actor.tx, "write_file", { Path: actorOut, paths: [extUri], Content: "x" }],
    ["reviewer file:// Path wt", rev.tx, "write_file", { Path: pathToFileURL(join(rev.wt, "src", "a.js")).href, Content: "x" }],
    ["reviewer Path outside", rev.tx, "edit_file", { file_path: prodSrc, Target: "a", Replacement: "b" }],
    ["actor missing destination", actor.tx, "write_file", { Content: body }],
    ["actor bare file:// destination", actor.tx, "write_file", { Path: "file://", Content: "x" }],
    ["owner missing destination", ownerTx, "write_file", { Content: "x" }],
  ]) assert.ok(callWrite(tx, name, args), `expected deny for ${label}`);
});

test("D-0064 T5: lead-guard allows self-loop.mjs patch / lead-patch.mjs commands while blocking direct product edits and git push", () => {
  const s = setup();
  const bash = command => refusal({ tool_name: "Bash", tool_input: { command } }, s.opts);
  assert.equal(bash('node scripts/self-loop.mjs patch --records /tmp/rec --reason "typo" --verify "node --test"'), null);
  assert.equal(bash('node scripts/lead-patch.mjs --records /tmp/rec --reason "typo" --verify "node --test"'), null);
  assert.ok(bash('node scripts/self-loop.mjs patch --records /tmp/rec --reason "x" --verify "true" && git push origin main'));
  assert.match(refusal({ tool_name: "Edit", cwd: s.product, tool_input: { file_path: join(s.product, "src/a.js") } }, s.opts), /product code/);
});

test("D-0064 T5: self-loop.mjs patch enforces <=20 lines, <=3 files, <=2 consecutive, 0 prose comments, verify exit 0, and working branch", () => {
  const product = repo({
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": "export const b = 2;\n",
    "src/c.mjs": "export const c = 3;\n",
    "src/d.mjs": "export const d = 4;\n",
  });
  git(product, "checkout", "-qb", "loop/v1");
  const records = repo({
    "metrics/handoffs.jsonl": "",
  });
  const workDir = temp("lp-work-");
  writeFileSync(join(records, "loop.json"), JSON.stringify({
    product, records: ".", workDir, branch: "loop/v1", phase: "v1",
    briefs: {}, agents: {}, protected: ["main"],
  }, null, 2) + "\n");
  git(records, "add", "loop.json");
  git(records, "commit", "-qm", "init loop.json");

  const runPatch = (...extra) => spawnSync(process.execPath, [
    join(scripts, "self-loop.mjs"), "patch", "--records", records, ...extra,
  ], { encoding: "utf8" });

  assert.equal(runPatch("--reason", "empty", "--verify", "true").status, 2);

  writeFileSync(join(product, "src/a.mjs"), "export const a = 10;\n");
  const dry = runPatch("--reason", "dry check", "--verify", "node -e 'process.exit(0)'", "--dry-run", "--json");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8"), "");

  const badVerify = runPatch("--reason", "failing verify", "--verify", "node -e 'process.exit(3)'");
  assert.equal(badVerify.status, 2);
  assert.match(badVerify.stderr, /--verify command exited 3/);

  writeFileSync(join(product, "src/a.mjs"), "// prose explanation comment\nexport const a = 10;\n");
  const proseRefused = runPatch("--reason", "with prose", "--verify", "true");
  assert.equal(proseRefused.status, 2);
  assert.match(proseRefused.stderr, /prose or pending comment/);

  writeFileSync(join(product, "src/a.mjs"), Array.from({ length: 22 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
  const overLines = runPatch("--reason", "too many lines", "--verify", "true");
  assert.equal(overLines.status, 2);
  assert.match(overLines.stderr, /exceeds hard cap \(20\)/);

  writeFileSync(join(product, "src/a.mjs"), "export const a = 11;\n");
  writeFileSync(join(product, "src/b.mjs"), "export const b = 22;\n");
  writeFileSync(join(product, "src/c.mjs"), "export const c = 33;\n");
  writeFileSync(join(product, "src/d.mjs"), "export const d = 44;\n");
  const overFiles = runPatch("--reason", "too many files", "--verify", "true");
  assert.equal(overFiles.status, 2);
  assert.match(overFiles.stderr, /changed files \(4\) exceeds hard cap \(3\)/);

  const p1 = runPatch("--reason", "first patch", "--verify", "true", "--files", "src/a.mjs", "--json");
  assert.equal(p1.status, 0, p1.stderr);
  const res1 = JSON.parse(p1.stdout);
  assert.equal(res1.handoff.role, "lead-patch");
  assert.equal(res1.handoff.audit.violations, 0);
  assert.equal(res1.handoff.verify.exit, 0);
  assert.deepEqual(res1.handoff.files, ["src/a.mjs"]);
  assert.match(git(product, "log", "-1", "--format=%s"), /loop\(v1\): lead-patch - first patch/);

  const p2 = runPatch("--reason", "second patch", "--verify", "true", "--files", "src/b.mjs", "--json");
  assert.equal(p2.status, 0, p2.stderr);

  const p3 = runPatch("--reason", "third patch", "--verify", "true", "--files", "src/c.mjs");
  assert.equal(p3.status, 2);
  assert.match(p3.stderr, /consecutive lead-patch limit reached \(2\/2\)/);

  git(product, "checkout", "-q", "main");
  const onProtected = runPatch("--reason", "wrong branch", "--verify", "true");
  assert.equal(onProtected.status, 2);
  assert.match(onProtected.stderr, /protected/);
});

test("F-0016 A5: lead-guard denies direct edit_file on tracked product code while permitting self-loop.mjs patch --diff end-to-end", () => {
  const product = repo({ "src/a.mjs": "export const a = 1;\n" });
  git(product, "checkout", "-qb", "loop/v1");
  const records = repo({ "metrics/handoffs.jsonl": "" });
  const workspaces = temp("lg-e2e-work-");
  writeFileSync(join(records, "loop.json"), JSON.stringify({
    product, records: ".", workDir: workspaces, branch: "loop/v1", phase: "v1",
    briefs: {}, agents: {}, protected: ["main"],
  }, null, 2) + "\n");
  git(records, "add", "loop.json");
  git(records, "commit", "-qm", "init loop.json");

  const agOpts = { product, workspaces: [workspaces], allow: ["docs/", "AGENTS.md", "CLAUDE.md", "README.md"], format: "antigravity" };
  const editDenied = refusal({
    hookEventName: "PreToolUse",
    conversationId: "lead-session",
    cwd: product,
    toolCall: { name: "edit_file", argumentsJson: JSON.stringify({ Path: join(product, "src/a.mjs"), Target: "a = 1", Replacement: "a = 2" }) },
  }, agOpts);
  assert.match(editDenied, /src\/a\.mjs is product code/);

  const patchPath = join(workspaces, "tasks", "micro.patch");
  const writePatchAllowed = refusal({
    hookEventName: "PreToolUse",
    conversationId: "lead-session",
    cwd: product,
    toolCall: { name: "write_file", argumentsJson: JSON.stringify({ Path: patchPath, Content: "diff\n" }) },
  }, agOpts);
  assert.equal(writePatchAllowed, null);

  mkdirSync(join(workspaces, "tasks"), { recursive: true });
  writeFileSync(patchPath, [
    "diff --git a/src/a.mjs b/src/a.mjs",
    "--- a/src/a.mjs",
    "+++ b/src/a.mjs",
    "@@ -1 +1 @@",
    "-export const a = 1;",
    "+export const a = 2;",
    "",
  ].join("\n"));

  const cmd = `node ${join(scripts, "self-loop.mjs")} patch --records ${records} --diff ${patchPath} --reason "micro fix" --verify "true"`;
  const runAllowed = refusal({
    hookEventName: "PreToolUse",
    conversationId: "lead-session",
    cwd: product,
    toolCall: { name: "run_command", argumentsJson: JSON.stringify({ CommandLine: cmd }) },
  }, agOpts);
  assert.equal(runAllowed, null);
  assert.ok(refusal({
    hookEventName: "PreToolUse",
    conversationId: "lead-session",
    cwd: product,
    toolCall: { name: "run_command", argumentsJson: JSON.stringify({ CommandLine: `${cmd} && git push origin loop/v1` }) },
  }, agOpts));

  const res = spawnSync(process.execPath, [
    join(scripts, "self-loop.mjs"), "patch", "--records", records, "--diff", patchPath,
    "--reason", "micro fix", "--verify", "true", "--json",
  ], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.handoff.id, "LP-0001");
  assert.equal(parsed.handoff.diffMode, true);
  assert.match(parsed.handoff.diffSha256, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(join(product, "src/a.mjs"), "utf8"), "export const a = 2;\n");
  assert.equal(git(product, "log", "-1", "--format=%s"), "loop(v1): lead-patch - micro fix");
});
