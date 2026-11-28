import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { has, jsonOutput, options, put, skill, status, world } from "./fixture.mjs";

function setup(t, files = {}) {
  const w = world(t);
  const product = w.repo(join(w.dir, "product"), { "src/main.js": "export {};\n", ...files });
  const workspaces = join(w.dir, "roles");
  const argv = [join(skill, "scripts/lead-guard.mjs"),
    "--product", product, "--workspaces", workspaces, "--allow", "guide/,PROJECT.md"];
  const env = {
    PATH: process.env.PATH,
    HOME: w.home,
    XDG_CONFIG_HOME: join(w.home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(w.home, ".gitconfig"),
    LC_ALL: "C",
  };
  const guard = input => spawnSync(process.execPath, argv, { ...options, env, cwd: w.outside, input });
  const edit = (cwd, file, tool = "Edit") => guard(JSON.stringify({
    cwd, tool_name: tool, tool_input: { file_path: file },
  }));
  return { w, product, workspaces, guard, edit };
}

function allow(result) {
  assert.equal(status(result, 0), "");
}

function deny(result, subject) {
  const { hookEventName, permissionDecision, permissionDecisionReason } = jsonOutput(result).hookSpecificOutput;
  assert.equal(hookEventName, "PreToolUse");
  assert.equal(permissionDecision, "deny");
  has(permissionDecisionReason, subject);
}

test("R6-C-G01 info/exclude keeps the lead's local hook editable", t => {
  const { w, product, edit } = setup(t);
  put(product, ".git/info/exclude", "/.claude/settings.local.json\n");
  put(product, ".claude/settings.local.json", "{}\n");
  put(product, ".claude/settings.json", "{}\n");
  deny(edit(product, ".claude/settings.json"), ".claude/settings.json");
  allow(edit(product, ".claude/settings.local.json"));
});

test("R6-C-G02 gitignore applies on the first write to a local-only folder", t => {
  const { product, edit } = setup(t, { ".gitignore": "/.local/harness/\n" });
  deny(edit(product, ".local/release/config.json", "Write"), ".local/release/config.json");
  allow(edit(product, ".local/harness/new/config.json", "Write"));
});

test("R6-C-G03 a user-wide excludesFile can keep harness preferences editable", t => {
  const { w, product, edit } = setup(t);
  const excludes = put(w.home, "Git settings/global excludes", "settings.local.json\n");
  w.git(product, "config", "--file", join(w.home, ".gitconfig"), "core.excludesFile", excludes);
  put(product, ".claude/settings.local.json", "{}\n");
  deny(edit(product, ".claude/settings.json", "Write"), ".claude/settings.json");
  allow(edit(product, ".claude/settings.local.json"));
});

test("R6-C-G04 tracked and trackable product files stay protected", t => {
  const { w, product, edit } = setup(t);
  put(product, ".gitignore", "/src/main.js\n");
  w.commit(product, "Ignore local copies of the tracked entry point");
  deny(edit(product, "src/main.js"), "src/main.js");
  deny(edit(product, "src/new file.js", "Write"), "src/new file.js");
  put(product, "src/draft.js", "export {};\n");
  deny(edit(product, "src/draft.js"), "src/draft.js");
  allow(edit(product, "guide/readme.md", "Write"));
});

test("R6-C-G05 the edited checkout's index decides whether an ignored file is tracked", t => {
  const { w, product, edit } = setup(t, { ".gitignore": "/.claude/settings.local.json\n" });
  const linked = join(w.dir, "other-checkout");
  const file = ".claude/settings.local.json";
  w.git(product, "worktree", "add", "-q", "--detach", linked);
  put(product, file, "{}\n");
  w.git(product, "add", "-f", "--", file);
  put(linked, file, "{}\n");
  deny(edit(product, file), file);
  deny(edit(linked, "src/main.js"), "src/main.js");
  allow(edit(linked, file));
});

test("R6-C-G06 allow paths and workspace tasks pass while child worktrees deny", t => {
  const { w, product, workspaces, edit } = setup(t, { "PROJECT.md": "# Project\n" });
  const actor = join(workspaces, "actor", "wt");
  put(workspaces, "tasks/R-0001-actor.md", "Implement accepted changes.\n");
  w.git(product, "worktree", "add", "-q", "--detach", actor);
  allow(edit(product, "guide/new.md", "Write"));
  allow(edit(product, "PROJECT.md"));
  allow(edit(workspaces, "tasks/R-0001-actor.md", "Write"));
  deny(edit(actor, "src/main.js"), "inside workspace root");
  deny(edit(product, "guide-extra/new.md", "Write"), "guide-extra/new.md");
  deny(edit(product, "src/main.js"), "src/main.js");
});

test("R6-C-G07 direct push denial and fail-closed malformed hook input", t => {
  const { guard } = setup(t);
  const bash = command => guard(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  deny(bash("git push origin loop/v1"), "direct git push");
  allow(bash("git status"));
  deny(guard("{truncated"), "malformed hook JSON");
});
