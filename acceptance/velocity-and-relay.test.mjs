// F-0016, P-0016, D-0016, D-0063, D-0064, D-0069, R-0056-judge-frame-velocity
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { refusal } from "../scripts/lead-guard.mjs";
import { isAncestorFast } from "../scripts/lib/provenance.mjs";
import { pruneSuiteStore } from "../scripts/lib/suite-prune.mjs";
import { indexOfTree } from "../scripts/records-check.mjs";
import { lookupSuiteReceipt } from "../scripts/suite-green.mjs";

const ACCEPTANCE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(ACCEPTANCE_DIR);
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");

function makeTmp(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEnv(t, extra = {}) {
  const home = makeTmp(t, "vel-home-");
  const load = makeTmp(t, "vel-load-");
  const env = {
    ...process.env,
    HOME: home,
    SELF_LOOP_LOAD_DIR: load,
    SELF_LOOP_OWNER_STORE: join(home, "owner-store"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Critic",
    GIT_AUTHOR_EMAIL: "critic@example.invalid",
    GIT_COMMITTER_NAME: "Critic",
    GIT_COMMITTER_EMAIL: "critic@example.invalid",
    ...extra,
  };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  if (!("SELF_LOOP_RELAY_DIR" in extra)) delete env.SELF_LOOP_RELAY_DIR;
  if (!("SELF_LOOP_NO_RELAY" in extra)) delete env.SELF_LOOP_NO_RELAY;
  return env;
}

function git(repo, env, ...argv) {
  const r = spawnSync("git", ["-C", repo, ...argv], { encoding: "utf8", env });
  assert.equal(r.status, 0, `git ${argv.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function makeRepo(t, env, files, branch = "main") {
  const dir = makeTmp(t, "vel-repo-");
  git(dir, env, "init", "-q", "-b", branch);
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  git(dir, env, "add", "-A");
  git(dir, env, "commit", "-qm", "init");
  return dir;
}

function runNode(scriptPath, args, env, { cwd = REPO_ROOT, input = undefined } = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], { cwd, env, encoding: "utf8", input });
}

test("F-0016 P1/P2: acceptance/index.js and legacy round suites are deleted, run.mjs runs parallel without index.js, and CI workflow preserves MCP-10 + --relay", t => {
  assert.equal(existsSync(join(ACCEPTANCE_DIR, "index.js")), false);
  const files = readdirSync(ACCEPTANCE_DIR);
  const legacy = files.filter(f => /^(?:r6-|r7-|round6-|round7-|v1-round).+\.test\.m?js$/.test(f));
  assert.deepEqual(legacy, []);
  const yml = readFileSync(join(REPO_ROOT, ".github", "workflows", "test.yml"), "utf8");
  assert.match(yml, /branches:\s*\[main,\s*'ci\/\*\*'\]/);
  assert.match(yml, /ubuntu-latest/);
  assert.match(yml, /macos-latest/);
  assert.match(yml, /gc\.auto\s+0/);
  assert.match(yml, /maintenance\.auto\s+false/);
  assert.match(yml, /SELF_LOOP_RELAY_DIR/);
  assert.match(yml, /node scripts\/suite-green\.mjs --repo \. --sha HEAD --command "node --test acceptance" --format node-test --relay/);
  const smoke = runNode(join(ACCEPTANCE_DIR, "run.mjs"), ["--seeds", "101", "--test-name-pattern=REG-01"], makeEnv(t));
  assert.equal(smoke.status, 0, smoke.stdout + smoke.stderr);
  assert.match(smoke.stdout, /\|\s*REG-01\b.*\|\s*ok\b.*\|\s*yes\s*\|/);
});

test("F-0016 P1/P2: suite-green.mjs --relay resumes from .relay/ checkpoints on single-file recovery and emits re-verifiable green receipt", t => {
  const env = makeEnv(t);
  const state = makeTmp(t, "vel-relay-state-");
  const countA = join(state, "a.count");
  const countB = join(state, "b.count");
  const failFlag = join(state, "b.fail");
  writeFileSync(failFlag, "1");
  const product = makeRepo(t, env, {
    VERSION: "1.0.0\n",
    "scripts/test/a.test.mjs": `import assert from "node:assert/strict";\nimport { appendFileSync } from "node:fs";\nimport test from "node:test";\ntest("a", () => { appendFileSync(${JSON.stringify(countA)}, "1\\n"); assert.equal(1, 1); });\n`,
    "scripts/test/b.test.mjs": `import assert from "node:assert/strict";\nimport { appendFileSync, existsSync, rmSync } from "node:fs";\nimport test from "node:test";\ntest("b", () => { appendFileSync(${JSON.stringify(countB)}, "1\\n"); if (existsSync(${JSON.stringify(failFlag)})) { rmSync(${JSON.stringify(failFlag)}); assert.fail("flake"); } assert.equal(2, 2); });\n`,
    "scripts/test/c.test.mjs": `import test from "node:test";\ntest("c skip", { skip: true }, () => {});\n`,
  });
  const head = git(product, env, "rev-parse", "HEAD");
  const args = ["--repo", product, "--sha", head, "--command", "node --test scripts/test", "--format", "node-test", "--relay"];
  const r1 = runNode(join(SCRIPTS_DIR, "suite-green.mjs"), args, env);
  assert.equal(r1.status, 2, r1.stderr);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.green, false);
  assert.deepEqual(j1.relay, { enabled: true, totalFiles: 3, relayedCount: 0, executedCount: 3 });
  assert.equal(readFileSync(countA, "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(countB, "utf8").trim().split("\n").length, 1);
  const commonGit = realpathSync(git(product, env, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const relayRoot = join(commonGit, "self-loop-suite", ".relay", j1.codeTree);
  assert.equal(existsSync(relayRoot), true);
  assert.equal(lookupSuiteReceipt({ repo: product, sha: head, command: "node --test scripts/test", format: "node-test" }), null);

  const r2 = runNode(join(SCRIPTS_DIR, "suite-green.mjs"), args, env);
  assert.equal(r2.status, 0, r2.stderr);
  const j2 = JSON.parse(r2.stdout);
  assert.equal(j2.green, true);
  assert.deepEqual(j2.relay, { enabled: true, totalFiles: 3, relayedCount: 2, executedCount: 1 });
  assert.equal(readFileSync(countA, "utf8").trim().split("\n").length, 1);
  assert.equal(readFileSync(countB, "utf8").trim().split("\n").length, 2);
  const prevLoad = process.env.SELF_LOOP_LOAD_DIR;
  process.env.SELF_LOOP_LOAD_DIR = env.SELF_LOOP_LOAD_DIR;
  try {
    const hit = lookupSuiteReceipt({ repo: product, sha: head, command: "node --test scripts/test", format: "node-test" });
    assert.ok(hit);
    assert.equal(hit.receipt.green, true);
    assert.equal(hit.receipt.summary.tests, 3);
    assert.equal(hit.receipt.summary.skipped, 1);
  } finally {
    if (prevLoad === undefined) delete process.env.SELF_LOOP_LOAD_DIR;
    else process.env.SELF_LOOP_LOAD_DIR = prevLoad;
  }
});

test("F-0016 P1/P2: relay fails closed on checkpoint tamper, codeTree/blob/command/varyVersion change, dirty worktree, --no-relay, and suite-prune", t => {
  const relayExt = makeTmp(t, "vel-ext-relay-");
  const env = makeEnv(t, { SELF_LOOP_RELAY_DIR: relayExt });
  const state = makeTmp(t, "vel-inv-state-");
  const runsA = join(state, "a.count");
  const failB = join(state, "b.fail");
  writeFileSync(failB, "1");
  const product = makeRepo(t, env, {
    VERSION: "1.0.0\n",
    "lib.mjs": "export const val = 'committed';\n",
    "scripts/test/a.test.mjs": `import assert from "node:assert/strict";\nimport { appendFileSync } from "node:fs";\nimport test from "node:test";\nimport { val } from "../../lib.mjs";\ntest("a", () => { appendFileSync(${JSON.stringify(runsA)}, "1\\n"); assert.equal(val, "committed"); });\n`,
    "scripts/test/b.test.mjs": `import assert from "node:assert/strict";\nimport { existsSync, rmSync } from "node:fs";\nimport test from "node:test";\ntest("b", () => { if (existsSync(${JSON.stringify(failB)})) { rmSync(${JSON.stringify(failB)}); assert.fail("fail"); } });\n`,
  });
  const countA = () => (existsSync(runsA) ? readFileSync(runsA, "utf8").trim().split("\n").filter(Boolean).length : 0);
  const head1 = git(product, env, "rev-parse", "HEAD");
  const cmdAll = "node --test scripts/test";

  const first = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", head1, "--command", cmdAll, "--format", "node-test", "--relay"], env).stdout);
  assert.equal(first.green, false);
  assert.equal(countA(), 1);

  const rtDirs = readdirSync(join(relayExt, first.codeTree));
  const cpFiles = readdirSync(join(relayExt, first.codeTree, rtDirs[0]));
  assert.equal(cpFiles.length, 1);
  const cpPath = join(relayExt, first.codeTree, rtDirs[0], cpFiles[0]);
  const cpObj = JSON.parse(readFileSync(cpPath, "utf8"));
  writeFileSync(cpPath, JSON.stringify({ ...cpObj, tapExcerpt: "tampered\n" }));
  writeFileSync(failB, "1");
  const afterTamper = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", head1, "--command", cmdAll, "--format", "node-test", "--relay"], env).stdout);
  assert.equal(afterTamper.green, false);
  assert.equal(afterTamper.relay.relayedCount, 0);
  assert.equal(countA(), 2);

  const varied = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", head1, "--command", cmdAll, "--format", "node-test", "--relay", "--vary-version", "1.1.0"], env).stdout);
  assert.equal(varied.green, true);
  assert.equal(varied.relay.relayedCount, 0);
  assert.equal(countA(), 3);

  const singleCmd = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", head1, "--command", "node --test scripts/test/a.test.mjs", "--format", "node-test", "--relay"], env).stdout);
  assert.equal(singleCmd.green, true);
  assert.equal(singleCmd.relay.relayedCount, 0);
  assert.equal(countA(), 4);

  writeFileSync(join(product, "lib.mjs"), "export const val = 'dirty-uncommitted';\n");
  writeFileSync(join(product, "scripts/test/dirty.test.mjs"), "import test from 'node:test'; test('dirty', () => { throw new Error('must not run'); });\n");
  const noRelay = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", head1, "--command", "node --test scripts/test/a.test.mjs", "--format", "node-test", "--no-relay"], env).stdout);
  assert.equal(noRelay.green, true);
  assert.ok(noRelay.reusedFrom);
  git(product, env, "checkout", "--", "lib.mjs");
  rmSync(join(product, "scripts/test/dirty.test.mjs"));

  writeFileSync(join(product, "scripts/test/a.test.mjs"), `import assert from "node:assert/strict";\nimport { appendFileSync } from "node:fs";\nimport test from "node:test";\nimport { val } from "../../lib.mjs";\ntest("a blob mutated", () => { appendFileSync(${JSON.stringify(runsA)}, "1\\n"); assert.equal(val, "committed"); });\n`);
  git(product, env, "add", "scripts/test/a.test.mjs");
  git(product, env, "commit", "-qm", "mutate test blob");
  const headBlob = git(product, env, "rev-parse", "HEAD");
  const testBlobChanged = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", headBlob, "--command", "node --test scripts/test/a.test.mjs", "--format", "node-test", "--relay"], env).stdout);
  assert.equal(testBlobChanged.green, true);
  assert.equal(testBlobChanged.relay.relayedCount, 0);
  assert.equal(countA(), 5);

  writeFileSync(join(product, "lib.mjs"), "export const val = 'committed-v2';\n");
  git(product, env, "add", "lib.mjs");
  git(product, env, "commit", "-qm", "code change");
  const head2 = git(product, env, "rev-parse", "HEAD");
  const codeChanged = JSON.parse(runNode(join(SCRIPTS_DIR, "suite-green.mjs"), ["--repo", product, "--sha", head2, "--command", cmdAll, "--format", "node-test", "--relay"], env).stdout);
  assert.equal(codeChanged.green, false);
  assert.notEqual(codeChanged.codeTree, first.codeTree);
  assert.equal(codeChanged.relay.relayedCount, 0);

  const commonGit = realpathSync(git(product, env, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const staleRelay = join(commonGit, "self-loop-suite", ".relay", "a".repeat(64), "0".repeat(64));
  mkdirSync(staleRelay, { recursive: true });
  const staleFile = join(staleRelay, "stale.json");
  writeFileSync(staleFile, "{}");
  const oldSec = Math.floor((Date.now() - 20 * 86400_000) / 1000);
  utimesSync(staleFile, oldSec, oldSec);
  utimesSync(staleRelay, oldSec, oldSec);
  utimesSync(dirname(staleRelay), oldSec, oldSec);
  const pruned = pruneSuiteStore(product, { apply: true });
  assert.ok(pruned.removed.includes(dirname(staleRelay)));
  assert.equal(existsSync(dirname(staleRelay)), false);
  assert.ok(existsSync(join(commonGit, "self-loop-suite")));
});

test("F-0016 P3: self-loop.mjs patch --diff applies via file and stdin under unweakened lead-guard and preserves branch on rejections", t => {
  const env = makeEnv(t);
  const product = makeRepo(t, env, {
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": "export const b = 2;\n",
    "src/c.mjs": "export const c = 3;\n",
    "src/d.mjs": "export const d = 4;\n",
  });
  git(product, env, "checkout", "-qb", "loop/v1");
  const records = makeRepo(t, env, { "metrics/handoffs.jsonl": "" });
  const workDir = makeTmp(t, "vel-lp-work-");
  writeFileSync(join(records, "loop.json"), JSON.stringify({
    product, records: ".", workDir, branch: "loop/v1", phase: "v1", briefs: {}, agents: {}, protected: ["main"],
  }, null, 2) + "\n");
  git(records, env, "add", "loop.json");
  git(records, env, "commit", "-qm", "loop");

  assert.match(refusal({ tool_name: "Edit", cwd: product, tool_input: { file_path: join(product, "src/a.mjs") } }, { product, workspaces: [workDir] }) ?? "", /product code/);
  assert.equal(refusal({ tool_name: "Write", cwd: product, tool_input: { file_path: join(workDir, "tasks/fix.patch") } }, { product, workspaces: [workDir] }), null);
  assert.equal(refusal({ tool_name: "Bash", cwd: product, tool_input: { command: `node ${join(SCRIPTS_DIR, "self-loop.mjs")} patch --records ${records} --diff - --reason ok --verify true` } }, { product, workspaces: [workDir] }), null);
  assert.match(refusal({ tool_name: "Bash", cwd: product, tool_input: { command: `node ${join(SCRIPTS_DIR, "self-loop.mjs")} patch --diff - && git push` } }, { product, workspaces: [workDir] }) ?? "", /git push/);

  const mkDiff = mutate => {
    const sc = makeTmp(t, "vel-diff-");
    git(sc, env, "clone", "-q", product, ".");
    git(sc, env, "checkout", "-q", "loop/v1");
    mutate(sc);
    git(sc, env, "add", "-A");
    return spawnSync("git", ["-C", sc, "diff", "--cached", "--binary"], { encoding: "utf8", env }).stdout;
  };
  const runPatch = (args, input) => runNode(join(SCRIPTS_DIR, "self-loop.mjs"), ["patch", "--records", records, ...args], env, { input });

  const patchFile = join(workDir, "tasks", "one.patch");
  mkdirSync(dirname(patchFile), { recursive: true });
  const d1 = mkDiff(sc => writeFileSync(join(sc, "src/a.mjs"), "export const a = 10;\n"));
  writeFileSync(patchFile, d1);
  const ok1 = runPatch(["--diff", patchFile, "--reason", "first patch", "--verify", "node -e 'process.exit(0)'", "--json"]);
  assert.equal(ok1.status, 0, ok1.stderr);
  const j1 = JSON.parse(ok1.stdout);
  assert.equal(j1.handoff.id, "LP-0001");
  assert.equal(j1.handoff.diffSha256, sha256(d1));
  assert.equal(git(product, env, "log", "-1", "--format=%s"), "loop(v1): lead-patch - first patch");

  const d2 = mkDiff(sc => writeFileSync(join(sc, "src/b.mjs"), "export const b = 20;\n"));
  const ok2 = runPatch(["--diff", "-", "--reason", "stdin patch", "--verify", "true", "--json"], d2);
  assert.equal(ok2.status, 0, ok2.stderr);
  assert.equal(JSON.parse(ok2.stdout).handoff.id, "LP-0002");

  const headBeforeReject = git(product, env, "rev-parse", "HEAD");
  const d3 = mkDiff(sc => writeFileSync(join(sc, "src/c.mjs"), "export const c = 30;\n"));
  assert.equal(runPatch(["--diff", "-", "--reason", "3rd consecutive", "--verify", "true"], d3).status, 2);

  const recLines = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8");
  writeFileSync(join(records, "metrics/handoffs.jsonl"), recLines + JSON.stringify({
    id: "R-0001-actor", time: "2026-11-28T00:00:00Z", phase: "v1", round: 1, step: "actor", role: "actor",
    record: "rounds/0001-actor.md", files: ["rounds/0001-actor.md"], view: "a".repeat(40), attempt: 1,
    agent: { runner: "codex" }, product: null, audit: { violations: 0 },
  }) + "\n");
  git(records, env, "add", "metrics/handoffs.jsonl");
  git(records, env, "commit", "-qm", "reset streak");

  const rejections = [
    ["lines>20", mkDiff(sc => writeFileSync(join(sc, "src/a.mjs"), Array.from({ length: 22 }, (_, i) => `export const x${i}=${i};`).join("\n") + "\n")), "true"],
    ["files>3", mkDiff(sc => { for (const f of ["src/a.mjs", "src/b.mjs", "src/c.mjs", "src/d.mjs"]) writeFileSync(join(sc, f), "export const z=9;\n"); }), "true"],
    ["prose", mkDiff(sc => writeFileSync(join(sc, "src/a.mjs"), "// narrative comment\nexport const a = 1;\n")), "true"],
    ["symlink", "diff --git a/src/l b/src/l\nnew file mode 120000\nindex 0000000..e69de29\n--- /dev/null\n+++ b/src/l\n@@ -0,0 +1 @@\n+a.mjs\n\\ No newline at end of file\n", "true"],
    ["binary", mkDiff(sc => writeFileSync(join(sc, "src/bin.dat"), Buffer.from([0, 1, 2, 255, 0]))), "true"],
    ["fail-verify", d3, "node -e 'process.exit(9)'"],
  ];
  for (const [label, diff, vCmd] of rejections) {
    const r = runPatch(["--diff", "-", "--reason", label, "--verify", vCmd], diff);
    assert.equal(r.status, 2, `${label}: expected exit 2, got ${r.status}`);
    assert.equal(git(product, env, "rev-parse", "HEAD"), headBeforeReject, `${label}: HEAD mutated`);
    assert.equal(git(product, env, "status", "--porcelain"), "", `${label}: product dirty`);
    assert.equal(git(product, env, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree ")).length, 1);
  }
  git(product, env, "checkout", "-q", "main");
  assert.equal(runPatch(["--diff", "-", "--reason", "protected", "--verify", "true"], d3).status, 2);
});

test("F-0016 P4: provenance.mjs DAG serves queries in < 2 git spawns with unreachable commit-tree fallback and records-check --write matches --staged", t => {
  const env = makeEnv(t);
  const r = makeRepo(t, env, { "a.txt": "0\n" });
  const c0 = git(r, env, "rev-parse", "HEAD");
  writeFileSync(join(r, "a.txt"), "1\n");
  git(r, env, "add", "a.txt");
  git(r, env, "commit", "-qm", "c1");
  const c1 = git(r, env, "rev-parse", "HEAD");
  git(r, env, "checkout", "-qb", "side", c0);
  writeFileSync(join(r, "b.txt"), "b\n");
  git(r, env, "add", "b.txt");
  git(r, env, "commit", "-qm", "b1");
  const b1 = git(r, env, "rev-parse", "HEAD");
  git(r, env, "merge", "-q", "--no-edit", c1);
  const m1 = git(r, env, "rev-parse", "HEAD");
  const orphan = git(r, env, "commit-tree", git(r, env, "rev-parse", `${c0}^{tree}`), "-m", "orphan");
  const unreach = git(r, env, "commit-tree", git(r, env, "rev-parse", `${c0}^{tree}`), "-p", c1, "-m", "unreachable");

  const realGit = spawnSync("which", ["git"], { encoding: "utf8", env }).stdout.trim();
  const spyBin = makeTmp(t, "vel-git-spy-");
  const callsLog = join(spyBin, "calls.log");
  const spyGit = join(spyBin, "git");
  writeFileSync(spyGit, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const origPath = process.env.PATH;
  process.env.PATH = `${spyBin}:${origPath}`;
  try {
    for (let i = 0; i < 4; i++) {
      assert.equal(isAncestorFast(r, c0, m1), true);
      assert.equal(isAncestorFast(r, c1, m1), true);
      assert.equal(isAncestorFast(r, b1, m1), true);
      assert.equal(isAncestorFast(r, b1, c1), false);
    }
    const calls = readFileSync(callsLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(calls.length < 2, `expected < 2 git calls, got ${calls.length}`);
  } finally {
    process.env.PATH = origPath;
  }
  assert.equal(isAncestorFast(r, c0, unreach), true);
  assert.equal(isAncestorFast(r, c1, unreach), true);
  assert.equal(isAncestorFast(r, b1, unreach), false);
  assert.equal(isAncestorFast(r, c0, orphan), false);

  const rec = makeRepo(t, env, {
    "README.md": "# r\n",
    "decisions/D-0001.md": "# D-0001 One\n\nby: owner\nstatus: active\n",
    "decisions/D-0002.md": "# D-0002 Two\n\nby: owner\nsupersedes: D-0001\nstatus: active\n",
    "evidence/0009/actor-c-1/out/context-read.txt": "quoted:\nsupersedes: D-0001\nsupersedes: D-0002\n",
  });
  const writeRes = runNode(join(SCRIPTS_DIR, "records-check.mjs"), ["--repo", rec, "--write"], env);
  assert.equal(writeRes.status, 0, writeRes.stdout + writeRes.stderr);
  const idx = readFileSync(join(rec, "INDEX.md"), "utf8");
  assert.match(idx, /\| D-0001 \| `decisions\/D-0001\.md` \| D-0001 One \| superseded by D-0002 \|/);
  assert.doesNotMatch(idx, /superseded by evidence\//);
  git(rec, env, "add", "INDEX.md");
  const stagedRes = runNode(join(SCRIPTS_DIR, "records-check.mjs"), ["--repo", rec, "--staged"], env);
  assert.equal(stagedRes.status, 0, stagedRes.stdout + stagedRes.stderr);
  git(rec, env, "commit", "-qm", "sync");
  assert.equal(indexOfTree(rec, "HEAD"), idx);
});

test("F-0016 P5: GLOSSARY.md, SKILL.md, init.mjs/example owns.actor, and changed deliverables hold 0 D-0069 leaks", t => {
  const env = makeEnv(t);
  const glossary = readFileSync(join(REPO_ROOT, "GLOSSARY.md"), "utf8");
  const skill = readFileSync(join(REPO_ROOT, "SKILL.md"), "utf8");
  for (const term of ["Public Seam", "Deep Module", "Suite Relay Checkpoint", "Dual-Axis Review", "Bounded Lead Micro-Patch"]) {
    assert.ok(glossary.includes(term), `GLOSSARY.md missing ${term}`);
  }
  assert.ok(skill.includes("GLOSSARY.md") && skill.includes("patch") && skill.includes("--diff") && skill.includes("--relay"));
  const example = JSON.parse(readFileSync(join(REPO_ROOT, "assets/self-loop.example.json"), "utf8"));
  assert.ok(example.owns.actor.includes("GLOSSARY.md"));
  const p = makeRepo(t, env, { "src/index.js": "export const ok = true;\n" });
  const initRes = runNode(join(SCRIPTS_DIR, "self-loop.mjs"), ["init", "--json"], env, { cwd: p });
  assert.equal(initRes.status, 0, initRes.stderr);
  const loopCfg = JSON.parse(readFileSync(join(JSON.parse(initRes.stdout).records, "loop.json"), "utf8"));
  assert.ok(loopCfg.owns.actor.includes("GLOSSARY.md"));
  const leakRe = /\/Users\/|\/home\/|\boutlit\b|\boutis\b|\bgpt-6\b|\bgemini-4\b/i;
  for (const rel of ["GLOSSARY.md", "SKILL.md", "assets/brief-critic.md", "assets/brief-actor.md", "assets/brief-frame-reviewer.md", "assets/reference-cli-and-gates.md", "scripts/lib/suite-relay.mjs", "scripts/lead-patch.mjs"]) {
    const body = readFileSync(join(REPO_ROOT, rel), "utf8");
    assert.doesNotMatch(body, leakRe, `D-0069 leak in ${rel}`);
  }
});
