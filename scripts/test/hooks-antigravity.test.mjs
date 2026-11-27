// F-0009, D-0016, D-0052, D-0066, D-0067
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkAntigravityHooks, checkHooks, discoverSkill, installHooks, uninstallHooks } from "../lib/hooks.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, scripts, selfLoop, temp } from "./helpers.mjs";

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

  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(existsSync(file), false);
  assert.ok(JSON.parse(readFileSync(siblingHooks, "utf8"))["self-loop"]);
  assert.equal(git(product, "status", "--porcelain"), "");
  assert.equal(git(sibling, "status", "--porcelain"), "", "sibling worktree stays Git-clean");

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

  assert.equal(runHooks("install").status, 0);
  const appended = Buffer.from("# r\xe9sum\xe9\n/.local", "latin1");
  writeFileSync(exclude, Buffer.concat([readFileSync(exclude), appended]));
  assert.equal(runHooks("uninstall").status, 0);
  assert.equal(
    readFileSync(exclude).toString("hex"),
    Buffer.concat([original, Buffer.from("\n"), appended]).toString("hex"),
  );
});

test("D-0066/D-0067: global install, check, skill discovery, and uninstall cover ANTIGRAVITY_HOME alongside GEMINI_HOME and T3 instances", () => {
  const prod = loopProduct();
  const store = ownerStore([{ name: "paseo-app", records: prod.records }]);
  const gHome = temp("ag-home-gem-");
  const agHome = temp("ag-home-paseo-");
  const t3Home = temp("ag-home-t3-");
  const t3Inst = join(t3Home, "userdata", "providers", "antigravity", "inst1111");
  const t3Hooks = join(t3Inst, "config", "hooks.json");
  mkdirSync(join(agHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(agHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");
  mkdirSync(join(agHome, "config"), { recursive: true });
  writeFileSync(join(agHome, "config", "hooks.json"), JSON.stringify({ "paseo-user": { enabled: true } }, null, 2) + "\n");
  mkdirSync(join(gHome, "config"), { recursive: true });
  writeFileSync(join(gHome, "config", "hooks.json"), JSON.stringify({ "gem-user": { enabled: true } }, null, 2) + "\n");
  mkdirSync(join(t3Inst, "config"), { recursive: true });

  const env = isolatedEnv({ GEMINI_HOME: gHome, ANTIGRAVITY_HOME: agHome, T3CODE_HOME: t3Home });
  const gemHooks = join(gHome, "config", "hooks.json");
  const agHooks = join(agHome, "config", "hooks.json");

  assert.equal(discoverSkill({ env }).discovered, true);
  assert.equal(discoverSkill({ env }).path, join(agHome, "config", "skills", "self-loop", "SKILL.md"));

  const inst = installHooks({ harness: "antigravity", scope: "global", ownerStore: store, scriptsDir: scripts, env });
  assert.deepEqual(inst.targets, [gemHooks, agHooks]);
  assert.ok(JSON.parse(readFileSync(gemHooks, "utf8"))["self-loop"]);
  assert.deepEqual(JSON.parse(readFileSync(gemHooks, "utf8"))["gem-user"], { enabled: true });
  assert.ok(JSON.parse(readFileSync(agHooks, "utf8"))["self-loop"]);
  assert.deepEqual(JSON.parse(readFileSync(agHooks, "utf8"))["paseo-user"], { enabled: true });

  const missingT3 = checkHooks({ harness: "antigravity", scope: "global", ownerStore: store, env });
  assert.equal(missingT3.ok, false);
  assert.ok(missingT3.findings.some(f => f.includes(t3Hooks)));

  installHooks({ harness: "antigravity", target: t3Hooks, ownerStore: store, scriptsDir: scripts, env });
  const healthy = checkHooks({ harness: "antigravity", scope: "global", ownerStore: store, env });
  assert.equal(healthy.ok, true, JSON.stringify(healthy.findings));

  const badAg = JSON.parse(readFileSync(agHooks, "utf8"));
  badAg["self-loop"].PreToolUse[0].matcher = "edit_file";
  writeFileSync(agHooks, JSON.stringify(badAg, null, 2) + "\n");
  const unhealthyAg = checkHooks({ harness: "antigravity", scope: "global", ownerStore: store, env });
  assert.equal(unhealthyAg.ok, false);
  assert.ok(unhealthyAg.findings.some(f => f.includes("ANTIGRAVITY_HOME") && f.includes(agHooks)));

  rmSync(agHooks, { force: true });
  const missingAg = checkHooks({ harness: "antigravity", scope: "global", ownerStore: store, env });
  assert.equal(missingAg.ok, false);
  assert.ok(missingAg.findings.some(f => f.includes("ANTIGRAVITY_HOME") && f.includes(agHooks)));

  installHooks({ harness: "antigravity", scope: "global", ownerStore: store, scriptsDir: scripts, env });
  const uninst = uninstallHooks({ harness: "antigravity", scope: "global", env });
  assert.equal(uninst.removed, true);
  assert.deepEqual(uninst.targets, [gemHooks, agHooks]);
  assert.equal("self-loop" in JSON.parse(readFileSync(gemHooks, "utf8")), false);
  assert.deepEqual(JSON.parse(readFileSync(gemHooks, "utf8"))["gem-user"], { enabled: true });
  assert.equal(existsSync(agHooks), false);

  const sameEnv = isolatedEnv({ GEMINI_HOME: agHome, ANTIGRAVITY_HOME: agHome, T3CODE_HOME: "" });
  const sameInst = installHooks({ harness: "antigravity", scope: "global", ownerStore: store, scriptsDir: scripts, env: sameEnv });
  assert.equal(sameInst.targets, undefined);
  assert.equal(checkHooks({ harness: "antigravity", scope: "global", ownerStore: store, env: sameEnv }).ok, true);
});

test("D-0066/D-0067: checkAntigravityHooks detects and validates standalone ANTIGRAVITY_HOME hooks without GEMINI_HOME", () => {
  const prod = loopProduct();
  const store = ownerStore([{ name: "ag-only", records: prod.records }]);
  const gHome = temp("ag-only-gem-");
  const agHome = temp("ag-only-home-");
  const agHooks = join(agHome, "config", "hooks.json");
  mkdirSync(join(agHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(agHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");

  const env = isolatedEnv({ GEMINI_HOME: gHome, ANTIGRAVITY_HOME: agHome, T3CODE_HOME: "", SELF_LOOP_OWNER_STORE: store });
  assert.equal(checkAntigravityHooks({ env, cwd: prod.product }).detected, false);

  installHooks({ harness: "antigravity", target: agHooks, ownerStore: store, scriptsDir: scripts, env });
  assert.equal(existsSync(join(gHome, "config", "hooks.json")), false);

  const okProbe = checkAntigravityHooks({ env, cwd: prod.product });
  assert.equal(okProbe.detected, true);
  assert.equal(okProbe.healthy, true, JSON.stringify(okProbe.findings));
  assert.equal(okProbe.scope, "global");
  assert.equal(okProbe.target, agHooks);

  const broken = JSON.parse(readFileSync(agHooks, "utf8"));
  broken["self-loop"].enabled = false;
  writeFileSync(agHooks, JSON.stringify(broken, null, 2) + "\n");
  const badProbe = checkAntigravityHooks({ env, cwd: prod.product });
  assert.equal(badProbe.detected, true);
  assert.equal(badProbe.healthy, false);
  assert.ok(badProbe.findings.some(f => f.includes(agHooks)));

  const startRes = selfLoop(["start", "--now", "2026-11-27T01:00:00.000Z"], { cwd: prod.product, env });
  assert.equal(startRes.status, 0, startRes.stderr);
  assert.match(startRes.stdout, /hooks \(antigravity\):/);
});

test("D-0067/D-0069: workspace uninstall removes empty .agents/hooks.json while preserving the .agents directory", () => {
  const { product, file, runHooks } = fixture();
  const agentsDir = join(product, ".agents");
  assert.equal(existsSync(agentsDir), false);

  const inst = runHooks("install");
  assert.equal(inst.status, 0, inst.stderr);
  assert.equal(existsSync(file), true);
  assert.equal(existsSync(agentsDir), true);

  const uninst = runHooks("uninstall");
  assert.equal(uninst.status, 0, uninst.stderr);
  assert.equal(existsSync(file), false);
  assert.equal(existsSync(agentsDir), true, ".agents directory must remain present so live Antigravity CLI sessions do not lose cmd.Dir");
  assert.equal(git(product, "status", "--porcelain"), "");
});

test("D-0067/D-0069: stray non-repo ancestor .git directory does not pollute exclude or fail global checkHooks", () => {
  const prod = loopProduct();
  const store = ownerStore([{ name: "stub-git-app", records: prod.records }]);
  const parent = temp("ag-stray-git-");
  mkdirSync(join(parent, ".git", "info"), { recursive: true });
  const gHome = join(parent, "gem");
  mkdirSync(join(gHome, "config", "skills", "self-loop"), { recursive: true });
  writeFileSync(join(gHome, "config", "skills", "self-loop", "SKILL.md"), "# self-loop\n");
  const env = isolatedEnv({ GEMINI_HOME: gHome, T3CODE_HOME: "", ANTIGRAVITY_HOME: "" });

  const inst = installHooks({ harness: "antigravity", scope: "global", ownerStore: store, scriptsDir: scripts, env });
  assert.equal(inst.exclude.excludeFile, null);
  assert.equal(existsSync(join(parent, ".git", "info", "exclude")), false);
  const checked = checkHooks({ harness: "antigravity", scope: "global", ownerStore: store, env });
  assert.equal(checked.ok, true, JSON.stringify(checked.findings));
});
