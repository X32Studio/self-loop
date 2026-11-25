// F-0004, F-0008, D-0060
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import * as leadGuardModule from "../lead-guard.mjs";
import { productCode, refusal } from "../lead-guard.mjs";
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
