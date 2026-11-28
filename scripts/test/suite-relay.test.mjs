// F-0016, P-0016, D-0016, D-0061, D-0064, R-0056-judge-frame-velocity
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  discoverSuiteFiles,
  fileCheckpointPath,
  purgeRelayForTree,
  readFileCheckpoint,
  RELAY_DIR,
  relayRuntimeKey,
  relayStoreRoot,
  runSuiteWithRelay,
  verifyFileCheckpoint,
  withGitNoMaintenance,
  writeFileCheckpoint,
} from "../lib/suite-relay.mjs";
import { codeTreeOf, lookupSuiteReceipt, pruneSuiteStore, purgeTreeReceipts, suiteGreen, suiteStore } from "../suite-green.mjs";
import { git, repo, scripts, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("suite-relay-load-");
delete process.env.SELF_LOOP_RELAY_DIR;

function relayFixture({ failBOnRun = 1 } = {}) {
  const stateDir = temp("suite-relay-state-");
  const runsA = join(stateDir, "a.log");
  const runsB = join(stateDir, "b.log");
  const flagB = join(stateDir, "b.fail");
  if (failBOnRun > 0) writeFileSync(flagB, String(failBOnRun));
  const dir = repo({
    VERSION: "1.0.0\n",
    "scripts/test/index.js": 'throw new Error("index.js must not run");\n',
    "scripts/test/a.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { appendFileSync } from "node:fs";',
      'import test from "node:test";',
      `test("a passes", () => { appendFileSync(${JSON.stringify(runsA)}, "a\\n"); assert.equal(1, 1); });`,
      "",
    ].join("\n"),
    "scripts/test/b.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
      'import test from "node:test";',
      `test("b flaky", () => {`,
      `  appendFileSync(${JSON.stringify(runsB)}, "b\\n");`,
      `  if (existsSync(${JSON.stringify(flagB)})) {`,
      `    const left = Number(readFileSync(${JSON.stringify(flagB)}, "utf8"));`,
      `    if (left <= 1) rmSync(${JSON.stringify(flagB)}, { force: true });`,
      `    else writeFileSync(${JSON.stringify(flagB)}, String(left - 1));`,
      `    assert.fail("simulated single-file flake");`,
      `  }`,
      `  assert.equal(2, 2);`,
      `});`,
      "",
    ].join("\n"),
  });
  const countOf = p => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0);
  return { dir, countA: () => countOf(runsA), countB: () => countOf(runsB), flagB };
}

test("discoverSuiteFiles reads committed tree only, excludes index.js, and rejects unsafe flags or shell operators", () => {
  const dir = repo({
    "scripts/test/index.js": "export {};\n",
    "scripts/test/helper.mjs": "export const x = 1;\n",
    "scripts/test/one.test.mjs": 'import test from "node:test"; test("1", () => {});\n',
    "acceptance/sub/two.test.js": 'const test = require("node:test"); test("2", () => {});\n',
    "acceptance/three.test.cjs": 'const test = require("node:test"); test("3", () => {});\n',
  });
  writeFileSync(join(dir, "scripts/test/dirty-only.test.mjs"), 'import test from "node:test"; test("dirty", () => {});\n');
  const tree = git(dir, "rev-parse", "HEAD^{tree}");

  const all = discoverSuiteFiles(dir, tree, "node --test");
  assert.deepEqual(all.map(f => f.relPath), [
    "acceptance/sub/two.test.js",
    "acceptance/three.test.cjs",
    "scripts/test/one.test.mjs",
  ]);
  for (const f of all) assert.match(f.fileBlobSha, /^[0-9a-f]{40}$/);

  const dirs = discoverSuiteFiles(dir, tree, "node --test scripts/test acceptance");
  assert.deepEqual(dirs.map(f => f.relPath), all.map(f => f.relPath));

  const globbed = discoverSuiteFiles(dir, tree, "node --test scripts/test/*.test.mjs");
  assert.deepEqual(globbed.map(f => f.relPath), ["scripts/test/one.test.mjs"]);

  for (const unsafe of [
    "echo ok",
    "node --test --watch",
    "node --test --test-name-pattern=one",
    "node --test scripts/test && echo done",
    "node --test scripts/test; exit 0",
    "node --test scripts/test/index.js",
    "node --test scripts/test/missing.test.mjs",
    "node --test ../escape.test.mjs",
  ]) {
    assert.equal(discoverSuiteFiles(dir, tree, unsafe), null, unsafe);
  }
});

test("cold run -> single-file failure -> relay rerun skips passed files -> green receipt accepted by lookupSuiteReceipt", () => {
  const { dir, countA, countB } = relayFixture({ failBOnRun: 1 });
  const head = git(dir, "rev-parse", "HEAD");
  const command = "node --test scripts/test";

  const first = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(first.green, false);
  assert.equal(countA(), 1);
  assert.equal(countB(), 1);
  assert.deepEqual(first.relay, { enabled: true, totalFiles: 2, relayedCount: 0, executedCount: 2 });
  assert.equal(lookupSuiteReceipt({ repo: dir, sha: head, command, format: "node-test" }), null);

  const second = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(second.green, true, second.text);
  assert.equal(countA(), 1, "passed file A must be relayed, not re-executed");
  assert.equal(countB(), 2, "failed file B must execute on rerun");
  assert.deepEqual(second.relay, { enabled: true, totalFiles: 2, relayedCount: 1, executedCount: 1 });
  assert.deepEqual([second.summary.tests, second.summary.pass, second.summary.fail, second.summary.cancelled], [2, 2, 0, 0]);

  const hit = lookupSuiteReceipt({ repo: dir, sha: head, command, format: "node-test" });
  assert.ok(hit, "synthesized green receipt must re-verify under storedGreen/lookupSuiteReceipt");
  assert.equal(hit.receipt.green, true);
  assert.deepEqual([hit.receipt.summary.tests, hit.receipt.summary.pass, hit.receipt.summary.fail], [2, 2, 0]);

  const third = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(third.green, true);
  assert.ok(third.reusedFrom);
  assert.equal(countA(), 1);
  assert.equal(countB(), 2);
});

test("codeTree change invalidates relay checkpoints and tampered checkpoints fail closed", () => {
  const { dir, countA, countB, flagB } = relayFixture({ failBOnRun: 1 });
  const head = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${head}^{tree}`);
  const codeTree = codeTreeOf(dir, tree);
  const command = "node --test scripts/test";

  const first = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(first.green, false);
  assert.equal(countA(), 1);
  assert.equal(countB(), 1);

  const relayRoot = join(suiteStore(dir), RELAY_DIR, codeTree);
  assert.equal(existsSync(relayRoot), true);

  const files = discoverSuiteFiles(dir, tree, command);
  const fileA = files.find(f => f.relPath === "scripts/test/a.test.mjs");
  const repoCommon = dirname(suiteStore(dir));
  const execDigest = (() => {
    const r = spawnSync("sh", ["-c", "command -v node"], { encoding: "utf8" });
    return spawnSync(process.execPath, ["-e", `import("node:crypto").then(c => import("node:fs").then(f => process.stdout.write(c.createHash("sha256").update(f.readFileSync(f.realpathSync(${JSON.stringify(r.stdout.trim())}))).digest("hex"))))`], { encoding: "utf8" }).stdout;
  })();
  const runtimeKey = relayRuntimeKey({ repository: repoCommon, command, executionDigest: execDigest });
  const cpPathA = fileCheckpointPath(relayStoreRoot(dir, codeTree, runtimeKey), fileA.relPath);
  const cpA = readFileCheckpoint(cpPathA);
  assert.ok(cpA);
  assert.equal(verifyFileCheckpoint(cpA, { repository: repoCommon, codeTree, relPath: fileA.relPath, fileBlobSha: fileA.fileBlobSha, runtimeKey }), true);

  const badSummary = { ...cpA, summary: { ...cpA.summary, pass: 99 } };
  assert.equal(verifyFileCheckpoint(badSummary, { repository: repoCommon, codeTree, relPath: fileA.relPath, fileBlobSha: fileA.fileBlobSha, runtimeKey }), false);
  assert.equal(verifyFileCheckpoint(cpA, { repository: repoCommon, codeTree, relPath: fileA.relPath, fileBlobSha: "0".repeat(40), runtimeKey }), false);
  assert.equal(verifyFileCheckpoint({ ...cpA, tapExcerpt: "" }, { repository: repoCommon, codeTree, relPath: fileA.relPath, fileBlobSha: fileA.fileBlobSha, runtimeKey }), false);

  writeFileCheckpoint(cpPathA, { ...cpA, tapExcerpt: "tampered\n" });
  const afterTamper = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(afterTamper.green, true, afterTamper.text);
  assert.equal(countA(), 2, "tampered checkpoint must force re-execution of file A");
  assert.equal(afterTamper.relay.relayedCount, 0);
  assert.equal(afterTamper.relay.executedCount, 2);

  writeFileSync(flagB, "1");
  writeFileSync(join(dir, "prod.mjs"), "export const v = 2;\n");
  git(dir, "add", "prod.mjs");
  git(dir, "commit", "-qm", "code change");
  const head2 = git(dir, "rev-parse", "HEAD");
  assert.notEqual(codeTreeOf(dir, head2), codeTree);
  const afterCodeChange = suiteGreen({ repo: dir, sha: head2, command, format: "node-test" });
  assert.equal(afterCodeChange.green, false);
  assert.equal(countA(), 3, "codeTree change must invalidate prior relay checkpoints");
  assert.equal(afterCodeChange.relay.relayedCount, 0);
});

test("purgeTreeReceipts removes .relay checkpoints and defeats relay reuse", () => {
  const { dir, countA, countB } = relayFixture({ failBOnRun: 1 });
  const head = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${head}^{tree}`);
  const codeTree = codeTreeOf(dir, tree);
  const command = "node --test scripts/test";

  const first = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(first.green, false);
  assert.equal(existsSync(join(suiteStore(dir), RELAY_DIR, codeTree)), true);

  assert.deepEqual(purgeTreeReceipts(dir, tree), { purged: 0 });
  assert.equal(existsSync(join(suiteStore(dir), RELAY_DIR, codeTree)), false);

  const second = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(second.green, true, second.text);
  assert.equal(countA(), 2, "purged relay checkpoint must not be reused");
  assert.equal(countB(), 2);
  assert.equal(second.relay.relayedCount, 0);
});

test("skipped-test files pass verifyFileCheckpoint and synthesize valid green receipts", () => {
  const dir = repo({
    VERSION: "1.0.0\n",
    "scripts/test/skipped.test.mjs": [
      'import assert from "node:assert/strict";',
      'import test from "node:test";',
      'test("pass one", () => assert.equal(1, 1));',
      'test("skip one", { skip: true }, () => {});',
      "",
    ].join("\n"),
    "scripts/test/only-skip.test.mjs": [
      'import test from "node:test";',
      'test("skip only", { skip: true }, () => {});',
      "",
    ].join("\n"),
  });
  const head = git(dir, "rev-parse", "HEAD");
  const command = "node --test scripts/test";
  const r = suiteGreen({ repo: dir, sha: head, command, format: "node-test" });
  assert.equal(r.green, true, r.text);
  assert.deepEqual([r.summary.tests, r.summary.pass, r.summary.skipped, r.summary.fail, r.summary.cancelled], [3, 1, 2, 0, 0]);
  const hit = lookupSuiteReceipt({ repo: dir, sha: head, command, format: "node-test" });
  assert.ok(hit);
  assert.equal(hit.receipt.summary.skipped, 2);
});

test("CLI supports --relay, --no-relay, SELF_LOOP_NO_RELAY=1, and SELF_LOOP_RELAY_DIR", () => {
  const { dir, countA, countB } = relayFixture({ failBOnRun: 1 });
  const head = git(dir, "rev-parse", "HEAD");
  const relayDir = temp("ext-relay-");
  const runCli = (extraArgs, extraEnv = {}) => spawnSync(
    process.execPath,
    [join(scripts, "suite-green.mjs"), "--repo", dir, "--sha", head, "--command", "node --test scripts/test/a.test.mjs scripts/test/b.test.mjs", "--format", "node-test", ...extraArgs],
    { encoding: "utf8", env: { ...process.env, ...extraEnv } },
  );

  const badFlags = runCli(["--relay", "--no-relay"]);
  assert.equal(badFlags.status, 64);

  const disabled = runCli(["--no-relay"]);
  assert.equal(disabled.status, 2);
  const parsedDisabled = JSON.parse(disabled.stdout);
  assert.equal(parsedDisabled.relay, undefined);

  const envDisabled = runCli([], { SELF_LOOP_NO_RELAY: "1" });
  assert.equal(envDisabled.status, 0, envDisabled.stderr);
  assert.equal(JSON.parse(envDisabled.stdout).relay, undefined);

  const { dir: dir2, countA: cA2, countB: cB2 } = relayFixture({ failBOnRun: 1 });
  const head2 = git(dir2, "rev-parse", "HEAD");
  const r1 = spawnSync(
    process.execPath,
    [join(scripts, "suite-green.mjs"), "--repo", dir2, "--sha", head2, "--command", "node --test scripts/test", "--format", "node-test", "--relay"],
    { encoding: "utf8", env: { ...process.env, SELF_LOOP_RELAY_DIR: relayDir } },
  );
  assert.equal(r1.status, 2);
  assert.equal(cA2(), 1);
  assert.equal(cB2(), 1);
  assert.equal(existsSync(join(relayDir, codeTreeOf(dir2, head2))), true);

  const r2 = spawnSync(
    process.execPath,
    [join(scripts, "suite-green.mjs"), "--repo", dir2, "--sha", head2, "--command", "node --test scripts/test", "--format", "node-test", "--relay"],
    { encoding: "utf8", env: { ...process.env, SELF_LOOP_RELAY_DIR: relayDir } },
  );
  assert.equal(r2.status, 0, r2.stderr);
  const parsed2 = JSON.parse(r2.stdout);
  assert.deepEqual(parsed2.relay, { enabled: true, totalFiles: 2, relayedCount: 1, executedCount: 1 });
  assert.equal(cA2(), 1);
  assert.equal(cB2(), 2);

  purgeRelayForTree(dir2, git(dir2, "rev-parse", `${head2}^{tree}`), codeTreeOf(dir2, head2), { ...process.env, SELF_LOOP_RELAY_DIR: relayDir });
  assert.equal(existsSync(join(relayDir, codeTreeOf(dir2, head2))), false);
  assert.ok(countA() >= 0 && countB() >= 0);
});

test("withGitNoMaintenance appends gc.auto=0 and maintenance.auto=false without clobbering existing GIT_CONFIG_COUNT", () => {
  const merged = withGitNoMaintenance({
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "init.defaultBranch",
    GIT_CONFIG_VALUE_0: "main",
  });
  assert.equal(merged.GIT_CONFIG_COUNT, "3");
  assert.equal(merged.GIT_CONFIG_KEY_0, "init.defaultBranch");
  assert.equal(merged.GIT_CONFIG_VALUE_0, "main");
  assert.equal(merged.GIT_CONFIG_KEY_1, "gc.auto");
  assert.equal(merged.GIT_CONFIG_VALUE_1, "0");
  assert.equal(merged.GIT_CONFIG_KEY_2, "maintenance.auto");
  assert.equal(merged.GIT_CONFIG_VALUE_2, "false");

  const idempotent = withGitNoMaintenance(merged);
  assert.equal(idempotent.GIT_CONFIG_COUNT, "3");
});

test("pruneSuiteStore bounds .relay/<codeTree> by age, count, and bytes while preserving pinned trees", () => {
  const dir = repo({ "t.test.mjs": 'import test from "node:test"; test("ok", () => {});\n' });
  const headCodeTree = codeTreeOf(dir, "HEAD");
  const relayRoot = join(suiteStore(dir), RELAY_DIR);
  const nowMs = Date.now();

  const seedRelayTree = (id, ageMs, payloadBytes = 128) => {
    const rtDir = join(relayRoot, id, "0".repeat(64));
    mkdirSync(rtDir, { recursive: true });
    const file = join(rtDir, "cp.json");
    writeFileSync(file, JSON.stringify({ pad: "x".repeat(payloadBytes) }));
    const sec = Math.floor((nowMs - ageMs) / 1000);
    utimesSync(file, sec, sec);
    utimesSync(rtDir, sec, sec);
    utimesSync(join(relayRoot, id), sec, sec);
    return join(relayRoot, id);
  };

  const pinnedHead = seedRelayTree(headCodeTree, 30 * 86400_000);
  const freshKeep = seedRelayTree("1".repeat(64), 1000);
  const excessTree = seedRelayTree("2".repeat(64), 2000);
  const expiredTree = seedRelayTree("3".repeat(64), 20 * 86400_000);

  const dry = pruneSuiteStore(dir, { maxRelayTrees: 1, maxRelayAgeMs: 14 * 86400_000, apply: false, now: () => nowMs });
  assert.ok(dry.removed.includes(excessTree));
  assert.ok(dry.removed.includes(expiredTree));
  assert.equal(dry.removed.includes(pinnedHead), false);
  assert.equal(existsSync(excessTree), true);

  const applied = pruneSuiteStore(dir, { maxRelayTrees: 1, maxRelayAgeMs: 14 * 86400_000, apply: true, now: () => nowMs });
  assert.ok(applied.bytesFreed > 0);
  assert.equal(existsSync(pinnedHead), true);
  assert.equal(existsSync(freshKeep), true);
  assert.equal(existsSync(excessTree), false);
  assert.equal(existsSync(expiredTree), false);

  const bigTree = seedRelayTree("4".repeat(64), 500, 4096);
  const byteTrimmed = pruneSuiteStore(dir, { maxRelayTrees: 16, maxRelayBytes: 2048, apply: true, now: () => nowMs });
  assert.ok(byteTrimmed.removed.includes(bigTree));
  assert.equal(existsSync(bigTree), false);
  assert.equal(existsSync(pinnedHead), true);
});

test("runSuiteWithRelay returns null when ineligible so suite-green falls back transparently", () => {
  const dir = repo({ "t.test.mjs": 'import test from "node:test"; test("ok", () => {});\n' });
  const head = git(dir, "rev-parse", "HEAD");
  assert.equal(runSuiteWithRelay({ repo: dir, commit: head, command: "node --test", format: "auto", execution: { executable: process.execPath, digest: "a".repeat(64) } }), null);
  assert.equal(runSuiteWithRelay({ repo: dir, commit: head, command: "node --test", format: "node-test", noRelay: true, execution: { executable: process.execPath, digest: "a".repeat(64) } }), null);
  assert.equal(runSuiteWithRelay({ repo: dir, commit: head, command: "node --test", format: "node-test", execution: null }), null);
});

test("relay ignores dirty working tree bytes and isolates --vary-version checkpoints", () => {
  const dir = repo({
    VERSION: "1.0.0\n",
    "lib.mjs": "export const val = 'committed';\n",
    "scripts/test/check.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { readFileSync } from "node:fs";',
      'import test from "node:test";',
      'import { val } from "../../lib.mjs";',
      'test("committed", () => { assert.equal(val, "committed"); assert.equal(readFileSync("VERSION", "utf8").trim(), "1.0.0"); });',
      "",
    ].join("\n"),
  });
  writeFileSync(join(dir, "lib.mjs"), "export const val = 'dirty';\n");
  writeFileSync(join(dir, "scripts/test/untracked.test.mjs"), 'import test from "node:test"; test("bad", () => { throw new Error("dirty"); });\n');
  const head = git(dir, "rev-parse", "HEAD");
  const ok = suiteGreen({ repo: dir, sha: head, command: "node --test scripts/test", format: "node-test" });
  assert.equal(ok.green, true, ok.text);
  assert.deepEqual(ok.relay, { enabled: true, totalFiles: 1, relayedCount: 0, executedCount: 1 });

  const varied = suiteGreen({ repo: dir, sha: head, command: "node --test scripts/test", format: "node-test", varyVersion: "2.0.0" });
  assert.equal(varied.green, false);
  assert.equal(varied.relay.relayedCount, 0);
});

