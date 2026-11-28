// D-0016, D-0064, F-0016, R-0056-judge-frame-velocity
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { load } from "../call.mjs";
import { leadPatch } from "../lead-patch.mjs";
import { UsageError } from "../lib/args.mjs";
import { main as selfLoopMain } from "../self-loop.mjs";
import { git, repo, scripts, temp } from "./helpers.mjs";

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const worktreeCount = product => git(product, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length;

function makeFixture(extraFiles = {}) {
  const product = repo({
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": "export const b = 2;\n",
    "src/c.mjs": "export const c = 3;\n",
    "src/d.mjs": "export const d = 4;\n",
    ...extraFiles,
  });
  git(product, "checkout", "-qb", "loop/v1");
  const records = repo({ "metrics/handoffs.jsonl": "" });
  const workDir = temp("lp-diff-work-");
  const cfgPath = join(records, "loop.json");
  writeFileSync(cfgPath, JSON.stringify({
    product, records: ".", workDir, branch: "loop/v1", phase: "v1",
    briefs: {}, agents: {}, protected: ["main"],
  }, null, 2) + "\n");
  git(records, "add", "loop.json");
  git(records, "commit", "-qm", "init loop.json");
  const cfg = load(cfgPath);
  const runCli = (args, opts = {}) => spawnSync(process.execPath, [
    join(scripts, "self-loop.mjs"), "patch", "--records", records, ...args,
  ], { encoding: "utf8", ...opts });
  return { product, records, workDir, cfgPath, cfg, runCli };
}

function diffFor(product, mutate) {
  const scratch = temp("lp-diff-gen-");
  git(scratch, "clone", "-q", product, ".");
  git(scratch, "checkout", "-q", "loop/v1");
  mutate(scratch);
  git(scratch, "add", "-A");
  return spawnSync("git", ["-C", scratch, "diff", "--cached", "--binary"], { encoding: "utf8" }).stdout;
}

test("F-0016 A5: --diff <file> applies atomically in isolated worktree, preserves commit subject, disables git auto-maintenance, and ignores verify scratch files", () => {
  const fx = makeFixture();
  const patchDir = temp("lp-patches-");
  const patchRel = "fix.patch";
  const rawDiff = diffFor(fx.product, wt => {
    writeFileSync(join(wt, "src/a.mjs"), "// D-0016\nexport const a = 42;\n");
    writeFileSync(join(wt, "src/added.mjs"), "export const added = true;\n");
  });
  writeFileSync(join(patchDir, patchRel), rawDiff);
  writeFileSync(join(fx.product, "unrelated.tmp"), "keep me\n");

  const envDump = join(patchDir, "verify-env.json");
  const verifyCmd = `node -e 'const fs=require("fs"); fs.writeFileSync("verify-scratch.txt","junk"); fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("GIT_CONFIG_")))));'`;
  const r = fx.runCli(
    ["--diff", patchRel, "--reason", "trim  spacing", "--verify", verifyCmd, "--json"],
    { cwd: patchDir, env: { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" } },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.diffMode, true);
  assert.equal(out.diffSha256, sha256(rawDiff));
  assert.equal(out.handoff.id, "LP-0001");
  assert.equal(out.handoff.role, "lead-patch");
  assert.equal(out.handoff.diffMode, true);
  assert.equal(out.handoff.diffSha256, sha256(rawDiff));
  assert.deepEqual(out.handoff.files, ["src/a.mjs", "src/added.mjs"]);
  assert.equal(git(fx.product, "log", "-1", "--format=%s"), "loop(v1): lead-patch - trim spacing");
  assert.equal(readFileSync(join(fx.product, "src/a.mjs"), "utf8"), "// D-0016\nexport const a = 42;\n");
  assert.equal(readFileSync(join(fx.product, "src/added.mjs"), "utf8"), "export const added = true;\n");
  assert.equal(readFileSync(join(fx.product, "unrelated.tmp"), "utf8"), "keep me\n");
  assert.equal(existsSync(join(fx.product, "verify-scratch.txt")), false);
  assert.equal(git(fx.product, "ls-files", "verify-scratch.txt"), "");
  assert.equal(worktreeCount(fx.product), 1);

  const captured = JSON.parse(readFileSync(envDump, "utf8"));
  assert.equal(captured.GIT_CONFIG_COUNT, "3");
  assert.equal(captured.GIT_CONFIG_KEY_0, "user.useConfigOnly");
  assert.equal(captured.GIT_CONFIG_KEY_1, "gc.auto");
  assert.equal(captured.GIT_CONFIG_VALUE_1, "0");
  assert.equal(captured.GIT_CONFIG_KEY_2, "maintenance.auto");
  assert.equal(captured.GIT_CONFIG_VALUE_2, "false");
});

test("F-0016 A5: --diff - reads stdin via CLI and self-loop.mjs main forwards cwd and stdin", () => {
  const fx = makeFixture();
  const diff1 = diffFor(fx.product, wt => writeFileSync(join(wt, "src/a.mjs"), "export const a = 100;\n"));
  const r = fx.runCli(["--diff", "-", "--reason", "stdin patch", "--verify", "true", "--json"], { input: diff1 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.handoff.id, "LP-0001");
  assert.equal(out.handoff.diffMode, true);
  assert.equal(out.handoff.diffSha256, sha256(diff1));
  assert.equal(readFileSync(join(fx.product, "src/a.mjs"), "utf8"), "export const a = 100;\n");

  const diff2 = diffFor(fx.product, wt => writeFileSync(join(wt, "src/b.mjs"), "export const b = 200;\n"));
  const code = selfLoopMain(
    ["patch", "--records", ".", "--diff", "-", "--reason", "forwarded stdin", "--verify", "true"],
    { cwd: fx.records, stdin: diff2 },
  );
  assert.equal(code, 0);
  assert.equal(readFileSync(join(fx.product, "src/b.mjs"), "utf8"), "export const b = 200;\n");
  assert.equal(worktreeCount(fx.product), 1);
});

test("F-0016 A5: --dry-run validates diff and cleans temporary worktree without touching product or records", () => {
  const fx = makeFixture();
  const baseHead = git(fx.product, "rev-parse", "HEAD");
  const rawDiff = diffFor(fx.product, wt => writeFileSync(join(wt, "src/a.mjs"), "export const a = 9;\n"));
  const r = fx.runCli(["--diff", "-", "--reason", "dry run", "--verify", "true", "--dry-run", "--json"], { input: rawDiff });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.dryRun, true);
  assert.equal(out.diffMode, true);
  assert.equal(out.diffSha256, sha256(rawDiff));
  assert.deepEqual(out.files, ["src/a.mjs"]);
  assert.deepEqual(out.lines, { added: 1, deleted: 1, total: 2 });
  assert.equal(git(fx.product, "rev-parse", "HEAD"), baseHead);
  assert.equal(readFileSync(join(fx.product, "src/a.mjs"), "utf8"), "export const a = 1;\n");
  assert.equal(readFileSync(join(fx.records, "metrics/handoffs.jsonl"), "utf8"), "");
  assert.equal(worktreeCount(fx.product), 1);
});

test("F-0016 A5: T5 bounds (lines, files, binary, symlink, gitlink, prose, disallowed paths, collision, bad diff) refuse BEFORE --verify runs", () => {
  const fx = makeFixture();
  const marker = join(temp("lp-verify-marker-"), "ran");
  const sentinelVerify = `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)},"ran")'`;

  const overLines = diffFor(fx.product, wt => writeFileSync(join(wt, "src/a.mjs"), Array.from({ length: 22 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n"));
  const rLines = leadPatch(fx.cfg, { reason: "too many lines", verify: sentinelVerify, diffText: overLines });
  assert.equal(rLines.ok, false);
  assert.equal(rLines.code, 2);
  assert.match(rLines.message, /exceeds hard cap \(20\)/);

  const overFiles = diffFor(fx.product, wt => {
    for (const f of ["src/a.mjs", "src/b.mjs", "src/c.mjs", "src/d.mjs"]) writeFileSync(join(wt, f), "export const x = 9;\n");
  });
  const rFiles = leadPatch(fx.cfg, { reason: "too many files", verify: sentinelVerify, diffText: overFiles });
  assert.equal(rFiles.ok, false);
  assert.match(rFiles.message, /changed files \(4\) exceeds hard cap \(3\)/);

  const binDiff = diffFor(fx.product, wt => writeFileSync(join(wt, "src/bin.dat"), Buffer.from([0, 1, 2, 3, 255, 0, 42])));
  const rBin = leadPatch(fx.cfg, { reason: "binary", verify: sentinelVerify, diffText: binDiff });
  assert.equal(rBin.ok, false);
  assert.match(rBin.message, /binary file/);

  const symlinkDiff = [
    "diff --git a/src/link b/src/link",
    "new file mode 120000",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/src/link",
    "@@ -0,0 +1 @@",
    "+a.mjs",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const rSym = leadPatch(fx.cfg, { reason: "symlink", verify: sentinelVerify, diffText: symlinkDiff });
  assert.equal(rSym.ok, false);
  assert.match(rSym.message, /disallowed file mode \(000000 -> 120000\)/);

  const gitlinkDiff = [
    "diff --git a/submod b/submod",
    "new file mode 160000",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/submod",
    "@@ -0,0 +1 @@",
    "+Subproject commit 1111111111111111111111111111111111111111",
    "",
  ].join("\n");
  const rSub = leadPatch(fx.cfg, { reason: "gitlink", verify: sentinelVerify, diffText: gitlinkDiff });
  assert.equal(rSub.ok, false);
  assert.equal(rSub.code, 2);

  const proseDiff = diffFor(fx.product, wt => writeFileSync(join(wt, "src/a.mjs"), "// narrative prose comment\nexport const a = 2;\n"));
  const rProse = leadPatch(fx.cfg, { reason: "prose", verify: sentinelVerify, diffText: proseDiff });
  assert.equal(rProse.ok, false);
  assert.match(rProse.message, /prose or pending comment/);

  const sealedDiff = diffFor(fx.product, wt => {
    mkdirSync(join(wt, "sealed"), { recursive: true });
    writeFileSync(join(wt, "sealed/secret.txt"), "nope\n");
  });
  const rSealed = leadPatch(fx.cfg, { reason: "sealed path", verify: sentinelVerify, diffText: sealedDiff });
  assert.equal(rSealed.ok, false);
  assert.match(rSealed.message, /disallowed sealed path/);

  const dotGitDiff = [
    "diff --git a/.git/config b/.git/config",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/.git/config",
    "@@ -0,0 +1 @@",
    "+[core]",
    "",
  ].join("\n");
  assert.equal(leadPatch(fx.cfg, { reason: "git path", verify: sentinelVerify, diffText: dotGitDiff }).ok, false);

  const traversalDiff = [
    "diff --git a/../escape.mjs b/../escape.mjs",
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    "+++ b/../escape.mjs",
    "@@ -0,0 +1 @@",
    "+export const x = 1;",
    "",
  ].join("\n");
  assert.equal(leadPatch(fx.cfg, { reason: "traversal", verify: sentinelVerify, diffText: traversalDiff }).ok, false);

  const modeOnlyDiff = [
    "diff --git a/src/a.mjs b/src/a.mjs",
    "old mode 100644",
    "new mode 100755",
    "",
  ].join("\n");
  const rModeOnly = leadPatch(fx.cfg, { reason: "mode only", verify: sentinelVerify, diffText: modeOnlyDiff });
  assert.equal(rModeOnly.ok, false);
  assert.match(rModeOnly.message, /no changed lines/);

  writeFileSync(join(fx.product, "src/collide.mjs"), "local untracked\n");
  const collideDiff = diffFor(fx.product, wt => writeFileSync(join(wt, "src/collide.mjs"), "export const c = 1;\n"));
  const rCollide = leadPatch(fx.cfg, { reason: "collide", verify: sentinelVerify, diffText: collideDiff });
  assert.equal(rCollide.ok, false);
  assert.match(rCollide.message, /untracked file collision/);
  assert.equal(readFileSync(join(fx.product, "src/collide.mjs"), "utf8"), "local untracked\n");

  const rBad = leadPatch(fx.cfg, { reason: "broken diff", verify: sentinelVerify, diffText: "not a valid unified diff\n" });
  assert.equal(rBad.ok, false);
  assert.match(rBad.message, /git apply failed/);

  assert.equal(existsSync(marker), false, "--verify must never execute when any T5 bound fails");
  assert.equal(worktreeCount(fx.product), 1);
});

test("F-0016 A5: failing --verify, pre-gates (--diff+--files, empty diff, dirty tracked, branch, streak), and records rollback", () => {
  const fx = makeFixture();
  const baseHead = git(fx.product, "rev-parse", "HEAD");
  const goodDiff = diffFor(fx.product, wt => writeFileSync(join(wt, "src/a.mjs"), "export const a = 55;\n"));

  const rFailVerify = fx.runCli(["--diff", "-", "--reason", "bad verify", "--verify", "node -e 'process.exit(7)'"], { input: goodDiff });
  assert.equal(rFailVerify.status, 2);
  assert.match(rFailVerify.stderr, /--verify command exited 7/);
  assert.equal(git(fx.product, "rev-parse", "HEAD"), baseHead);
  assert.equal(worktreeCount(fx.product), 1);

  assert.throws(() => leadPatch(fx.cfg, { reason: "both", verify: "true", diffText: goodDiff, files: ["src/a.mjs"] }), UsageError);
  assert.equal(fx.runCli(["--diff", "-", "--files", "src/a.mjs", "--reason", "both", "--verify", "true"], { input: goodDiff }).status, 64);
  assert.throws(() => leadPatch(fx.cfg, { reason: "empty", verify: "true", diffText: "   \n" }), UsageError);
  assert.equal(fx.runCli(["--diff", "-", "--reason", "empty", "--verify", "true"], { input: "  \n" }).status, 64);
  assert.equal(fx.runCli(["--diff", "/nonexistent/missing.patch", "--reason", "missing", "--verify", "true"]).status, 64);

  const dirtyVerify = `node -e 'require("fs").writeFileSync(${JSON.stringify(join(fx.records, "metrics/handoffs.jsonl"))}, "dirty\\n")'`;
  const rRollback = leadPatch(fx.cfg, { reason: "records fail", verify: dirtyVerify, diffText: goodDiff });
  assert.equal(rRollback.ok, false);
  assert.equal(rRollback.code, 2);
  assert.match(rRollback.message, /records commit failed \(product commit rolled back\)/);
  assert.equal(git(fx.product, "rev-parse", "HEAD"), baseHead);
  assert.equal(git(fx.product, "status", "--porcelain"), "");
  assert.equal(readFileSync(join(fx.product, "src/a.mjs"), "utf8"), "export const a = 1;\n");
  assert.equal(worktreeCount(fx.product), 1);

  git(fx.records, "checkout", "--", "metrics/handoffs.jsonl");
  writeFileSync(join(fx.product, "src/a.mjs"), "export const a = 999;\n");
  const rDirtyProd = leadPatch(fx.cfg, { reason: "dirty prod", verify: "true", diffText: goodDiff });
  assert.equal(rDirtyProd.ok, false);
  assert.match(rDirtyProd.message, /uncommitted tracked changes/);
  git(fx.product, "checkout", "--", "src/a.mjs");

  const d1 = diffFor(fx.product, wt => writeFileSync(join(wt, "src/a.mjs"), "export const a = 11;\n"));
  assert.equal(leadPatch(fx.cfg, { reason: "patch 1", verify: "true", diffText: d1 }).ok, true);
  const d2 = diffFor(fx.product, wt => writeFileSync(join(wt, "src/b.mjs"), "export const b = 22;\n"));
  assert.equal(leadPatch(fx.cfg, { reason: "patch 2", verify: "true", diffText: d2 }).ok, true);
  const d3 = diffFor(fx.product, wt => writeFileSync(join(wt, "src/c.mjs"), "export const c = 33;\n"));
  const rStreak = leadPatch(fx.cfg, { reason: "patch 3", verify: "true", diffText: d3 });
  assert.equal(rStreak.ok, false);
  assert.match(rStreak.message, /consecutive lead-patch limit reached \(2\/2\)/);

  const actorRow = JSON.stringify({
    id: "R-0001-actor", time: "2026-11-28T00:00:00Z", phase: "v1", round: 1, step: "actor", role: "actor",
    record: "rounds/0001-actor.md", files: ["rounds/0001-actor.md"], view: "a".repeat(40), attempt: 1,
    agent: { runner: "codex" }, product: null, audit: { violations: 0 },
  });
  writeFileSync(join(fx.records, "metrics/handoffs.jsonl"), readFileSync(join(fx.records, "metrics/handoffs.jsonl"), "utf8") + actorRow + "\n");
  const rDirtyHandoffs = leadPatch(fx.cfg, { reason: "dirty handoffs", verify: "true", diffText: d3 });
  assert.equal(rDirtyHandoffs.ok, false);
  assert.match(rDirtyHandoffs.message, /uncommitted changes/);
  git(fx.records, "add", "metrics/handoffs.jsonl");
  git(fx.records, "commit", "-qm", "record actor handoff");

  const rAfterActor = leadPatch(fx.cfg, { reason: "patch 3 after actor", verify: "true", diffText: d3 });
  assert.equal(rAfterActor.ok, true);
  assert.equal(rAfterActor.handoff.id, "LP-0003");

  const delDiff = diffFor(fx.product, wt => rmSync(join(wt, "src/d.mjs")));
  const rDel = leadPatch(fx.cfg, { reason: "delete unused", verify: "true", diffText: delDiff });
  assert.equal(rDel.ok, true);
  assert.equal(existsSync(join(fx.product, "src/d.mjs")), false);

  git(fx.product, "checkout", "-q", "main");
  assert.match(leadPatch(fx.cfg, { reason: "protected", verify: "true", diffText: d3 }).message, /protected/);
  git(fx.product, "checkout", "-q", "--detach", "HEAD");
  assert.match(leadPatch(fx.cfg, { reason: "detached", verify: "true", diffText: d3 }).message, /detached/);
});
