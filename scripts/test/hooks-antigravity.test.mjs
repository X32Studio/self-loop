// Regression tests for F-0009 Antigravity hooks Git-clean lifecycle (J2):
// tracked user hooks protection, multi-worktree shared exclude retention, and byte-exact exclude restoration.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, isolatedEnv, loopProduct, selfLoop, temp } from "./helpers.mjs";

function fixture(trackedHooksContent = null) {
  const { product, records } = loopProduct();
  const file = join(product, ".agents", "hooks.json");
  if (trackedHooksContent !== null) {
    mkdirSync(join(product, ".agents"), { recursive: true });
    writeFileSync(file, trackedHooksContent);
    git(product, "add", ".agents/hooks.json");
    git(product, "commit", "-qm", "Add tracked user hooks");
  }
  const exclude = join(product, ".git", "info", "exclude");
  const env = isolatedEnv({ T3CODE_HOME: "" });
  const runHooks = (action, cwd = product, flags = []) =>
    selfLoop(["hooks", action, "--harness", "antigravity", "--config", join(records, "loop.json"), ...flags], { cwd, env });
  return { product, records, file, exclude, env, runHooks };
}

test("J2: workspace install refuses to modify a Git-tracked user .agents/hooks.json and keeps bytes & tree clean", () => {
  const original = '{ "user-linter": { "enabled": true } }\n';
  const { product, file, runHooks } = fixture(original);
  const inst = runHooks("install");
  assert.equal(inst.status, 2);
  assert.match(inst.stderr, /tracked by Git/);
  assert.equal(readFileSync(file, "utf8"), original, "tracked user file bytes stay untouched");
  assert.equal(git(product, "status", "--porcelain"), "", "working tree stays clean");
});

test("J2: install and uninstall restore a user .git/info/exclude with no trailing newline byte for byte", () => {
  const { product, exclude, runHooks } = fixture();
  const original = "# user rule\n/.env";
  writeFileSync(exclude, original);
  const inst = runHooks("install");
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(git(product, "status", "--porcelain"), "");
  const uninst = runHooks("uninstall");
  assert.equal(uninst.status, 0, uninst.stderr);
  assert.equal(readFileSync(exclude, "utf8"), original);
  assert.equal(git(product, "status", "--porcelain"), "");

  // If the user appends a rule after install, uninstall removes only the managed block without merging lines.
  assert.equal(runHooks("install").status, 0);
  writeFileSync(exclude, readFileSync(exclude, "utf8") + "/.local\n");
  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(readFileSync(exclude, "utf8"), "# user rule\n/.env\n/.local\n");
});

test("J2: uninstall in one worktree retains shared info/exclude while sibling worktree keeps hooks, then removes it on last uninstall", () => {
  const { product, file, exclude, runHooks } = fixture();
  const userExclude = "# user rule\n/.env";
  writeFileSync(exclude, userExclude);
  const sibling = temp("ag-wt-sibling-");
  git(product, "worktree", "add", "-q", "--detach", sibling);
  const siblingHooks = join(sibling, ".agents", "hooks.json");

  assert.equal(runHooks("install").status, 0);
  assert.equal(runHooks("install", sibling, ["--target", siblingHooks]).status, 0);
  assert.equal(git(product, "status", "--porcelain"), "");
  assert.equal(git(sibling, "status", "--porcelain"), "");

  // Uninstalling the primary checkout removes its hooks but retains shared exclude for sibling.
  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(existsSync(file), false);
  assert.ok(JSON.parse(readFileSync(siblingHooks, "utf8"))["self-loop"]);
  assert.equal(git(product, "status", "--porcelain"), "");
  assert.equal(git(sibling, "status", "--porcelain"), "", "sibling worktree stays Git-clean");

  // Uninstalling the last remaining worktree removes the managed exclude and restores user exclude bytes.
  assert.equal(runHooks("uninstall", sibling, ["--target", siblingHooks]).status, 0);
  assert.equal(existsSync(siblingHooks), false);
  assert.equal(git(sibling, "status", "--porcelain"), "");
  assert.equal(readFileSync(exclude, "utf8"), userExclude);
});

test("J2: uninstall does not strip a user exclude rule whose preceding comment merely mentions the marker substring", () => {
  const { product, file, exclude, runHooks } = fixture();
  const original = "# User-owned replacement for: # self-loop managed: antigravity hooks\n/.agents/hooks.json\n";
  writeFileSync(exclude, original);
  mkdirSync(join(file, ".."), { recursive: true });
  const user = { "user-linter": { enabled: true } };
  writeFileSync(file, JSON.stringify(user));

  assert.equal(runHooks("install").status, 0);
  assert.equal(readFileSync(exclude, "utf8"), original);
  assert.equal(runHooks("uninstall").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), user);
  assert.equal(readFileSync(exclude, "utf8"), original);
  assert.equal(git(product, "status", "--porcelain"), "");
});

test("J2: sibling worktree whose path ends with trailing whitespace retains shared exclude until last uninstall", () => {
  const { product, file, exclude, runHooks } = fixture();
  const original = "# user rule\n/.env";
  writeFileSync(exclude, original);
  const sibling = join(temp(), "wt-space ");
  const siblingHooks = join(sibling, ".agents", "hooks.json");
  git(product, "worktree", "add", "-q", "--detach", sibling);

  assert.equal(runHooks("install").status, 0);
  assert.equal(runHooks("install", sibling, ["--target", siblingHooks]).status, 0);
  assert.equal(git(sibling, "status", "--porcelain"), "");

  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(siblingHooks), true);
  assert.equal(git(sibling, "status", "--porcelain"), "", "trailing-space sibling stays Git-clean");

  assert.equal(runHooks("uninstall", sibling, ["--target", siblingHooks]).status, 0);
  assert.equal(existsSync(siblingHooks), false);
  assert.equal(git(sibling, "status", "--porcelain"), "");
  assert.equal(readFileSync(exclude, "utf8"), original);
});

test("J2: install and uninstall preserve non-UTF-8 bytes in .git/info/exclude verbatim", () => {
  const { product, exclude, runHooks } = fixture();
  const original = Buffer.from("# caf\xe9\n/.env", "latin1");
  writeFileSync(exclude, original);
  writeFileSync(join(product, ".env"), "ignored\n");
  assert.equal(git(product, "status", "--porcelain"), "");

  assert.equal(runHooks("install").status, 0);
  assert.equal(git(product, "status", "--porcelain"), "");
  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(git(product, "status", "--porcelain"), "");
  assert.equal(readFileSync(exclude).toString("hex"), original.toString("hex"));

  // Non-UTF-8 bytes survive when user appends another rule after install (without trailing newline).
  assert.equal(runHooks("install").status, 0);
  const appended = Buffer.from("# r\xe9sum\xe9\n/.local", "latin1");
  writeFileSync(exclude, Buffer.concat([readFileSync(exclude), appended]));
  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(
    readFileSync(exclude).toString("hex"),
    Buffer.concat([original, Buffer.from("\n"), appended]).toString("hex"),
  );
});
