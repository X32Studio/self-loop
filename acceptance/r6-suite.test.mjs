import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { output, put, skill, status } from "./fixture.mjs";
import { versionWorld } from "./r6-version-fixture.mjs";

function evidence(prefix) {
  const receipt = JSON.parse(readFileSync(prefix + ".json", "utf8"));
  const log = gunzipSync(readFileSync(prefix + ".log.gz"));
  assert.equal(createHash("sha256").update(log).digest("hex"), receipt.log.sha256);
  assert.equal(log.byteLength, receipt.log.bytes);
  return receipt;
}

test("R6-A25 D-0064 T6 VERSION pre-commit fast-passes while release remeasures and opaque compound suite still remeasures without codeTree reuse", t => {
  const p = versionWorld(t);
  p.hook();
  const tip = p.editTip();
  assert.deepEqual(p.runs(), []);

  status(p.version(["release"]), 0);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/main"), tip);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/tags/v" + p.versions.higher + "^{commit}"), tip);
  assert.ok(p.runs().length > 0 && p.runs().every(v => v === p.versions.higher));

  const prefix = join(p.w.dir, "reused-suite");
  const runsBefore = p.runs().length;
  const result = p.suite(tip, ["--out", prefix]);
  assert.equal(p.runs().length, runsBefore + 1);
  status(result, 0);
  assert.doesNotMatch(output(result), /reused\s+\S+/i);
  assert.ok(p.runs().every(v => v === p.versions.higher));
  const receipt = evidence(prefix);
  assert.equal(receipt.sha, tip);
  assert.equal(receipt.green, true);
  assert.equal(receipt.reusedFrom, undefined);
  assert.equal(receipt.tree, p.w.git(p.product, "rev-parse", `${tip}^{tree}`));
});

test("R6-A26 a VERSION-only child remeasures an opaque compound suite at the same intended tree", t => {
  const p = versionWorld(t);
  const variedPrefix = join(p.w.dir, "varied-suite");
  status(p.suite(p.parent, ["--vary-version", p.versions.higher, "--out", variedPrefix]), 0);
  const varied = evidence(variedPrefix);
  assert.equal(varied.sha, p.parent);
  assert.equal(varied.versionVaried, p.versions.higher);
  assert.ok(p.runs().length > 0);
  assert.ok(p.runs().every(version => version === p.versions.higher));
  assert.equal(readFileSync(join(p.product, "VERSION"), "utf8"), p.versions.parent + "\n");

  const tip = p.editTip();
  const prefix = join(p.w.dir, "tip-suite");
  const runsBefore = p.runs().length;
  status(p.suite(tip, ["--out", prefix]), 0);
  assert.equal(p.runs().length, runsBefore + 1);
  const receipt = evidence(prefix);
  assert.equal(receipt.sha, tip);
  assert.equal(receipt.green, true);
  assert.equal(receipt.reusedFrom, undefined);
  assert.equal(receipt.tree, p.w.git(p.product, "rev-parse", `${tip}^{tree}`));
  assert.ok(p.runs().length > 0);
  assert.ok(p.runs().every(version => version === p.versions.higher));
});

test("R6-A27 a normal parent receipt cannot cover the VERSION-only child's own run", t => {
  const p = versionWorld(t);
  status(p.suite(), 0);
  const tip = p.editTip();
  const result = p.suite(tip);
  status(result, 0);
  assert.deepEqual(p.runs(), [p.versions.parent, p.versions.higher]);
});

test("R6-A28 a green normal parent receipt does not hide a child VERSION rejected by the suite", t => {
  const p = versionWorld(t, { failTip: true });
  status(p.suite(), 0);
  p.editTip();
  const result = p.version(["release"]);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /suite is not green|test.*fail|VERSION is rejected/i);
  assert.equal(p.refs(), "");
  assert.deepEqual(p.runs(), [p.versions.parent, p.versions.higher]);
});

const suiteLeases = p => existsSync(p.load)
  ? readdirSync(p.load).filter(file => /^suite-\d+-\d+\.json$/.test(file)) : [];

for (const [id, fail] of [["29", false], ["30", true]]) {
  test(`R6-A${id} a ${fail ? "failed" : "successful"} suite holds a lease only while running`, async t => {
    const p = versionWorld(t, { pause: true, failTip: fail });
    const sha = fail ? p.editTip() : p.parent;
    const running = p.suiteAsync(sha);
    let result;
    try {
      const deadline = Date.now() + 10_000;
      while (!p.runs().length && Date.now() < deadline) await setTimeout(25);
      assert.equal(p.runs().length, 1, "the suite reached the hold point");
      const names = suiteLeases(p);
      assert.equal(names.length, 1, "exactly one suite lease while the suite is blocked in its test");
      const lease = JSON.parse(readFileSync(join(p.load, names[0]), "utf8"));
      assert.deepEqual([lease.kind, lease.repo, lease.sha], ["suite", p.product, sha]);
      assert.ok(lease.started);
      assert.ok(Number.isSafeInteger(lease.pid) && lease.pid > 0);
      process.kill(lease.pid, 0);
    } finally {
      put(p.w.dir, "continue-suite", "done\n");
      result = await running;
    }
    status(result, fail ? 2 : 0);
    assert.deepEqual(suiteLeases(p), []);
  });
}

test("R6-A31 the same tree needs a fresh suite receipt when the install command changes", t => {
  const p = versionWorld(t);
  status(p.suite(), 0);
  const second = p.suite(p.parent, ["--install", "node -e 'process.exit(3)'"]);
  status(second, 2);
  assert.match(output(second), /install exited 3/);
  assert.deepEqual(p.runs(), [p.versions.parent]);
});

const directEnv = p => {
  const env = { ...process.env, SELF_LOOP_LOAD_DIR: p.load, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.invalid", GIT_COMMITTER_NAME: "Acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.invalid", LC_ALL: "C", TZ: "UTC" };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
};

test("R6-A32 fresh · flow: D-0064 T6 pre-commit fast-passes VERSION and docs/*.md commits with zero suite runs while still running and failing closed on code/test changes · loss: false-verdict / stuck", t => {
  const p = versionWorld(t);
  p.hook();
  const env = directEnv(p);
  const commit = msg => spawnSync("git", ["-C", p.product, "commit", "-m", msg], { encoding: "utf8", env });

  put(p.product, "VERSION", p.versions.higher + "\n");
  p.w.git(p.product, "add", "VERSION");
  const verCommit = commit("Bump VERSION only");
  assert.equal(verCommit.status, 0, verCommit.stderr + verCommit.stdout);
  assert.match(verCommit.stdout + verCommit.stderr, /pre-commit: fast-pass \(VERSION\/docs-only\)/);
  assert.deepEqual(p.runs(), []);

  put(p.product, "docs/guide.md", "# Guide\n\nRelease notes.\n");
  put(p.product, "README.md", "# Version example\n\nUpdated.\n");
  p.w.git(p.product, "add", "docs/guide.md", "README.md");
  const docsCommit = commit("Docs update only");
  assert.equal(docsCommit.status, 0, docsCommit.stderr + docsCommit.stdout);
  assert.match(docsCommit.stdout + docsCommit.stderr, /pre-commit: fast-pass \(VERSION\/docs-only\)/);
  assert.deepEqual(p.runs(), []);

  const tipBeforeBroken = p.w.git(p.product, "rev-parse", "HEAD");
  put(p.product, "VERSION", "9.9.9\n");
  put(p.product, "scripts/test/probe.test.mjs", 'import assert from "node:assert/strict";\nimport { appendFileSync } from "node:fs";\nimport test from "node:test";\ntest("broken", () => { appendFileSync(' + JSON.stringify(p.log) + ', "9.9.9\\n"); assert.fail("broken"); });\n');
  p.w.git(p.product, "add", "VERSION", "scripts/test/probe.test.mjs");
  const brokenCommit = commit("Broken code alongside VERSION");
  assert.notEqual(brokenCommit.status, 0);
  assert.match(brokenCommit.stderr, /staged skill tests failed/);
  assert.equal(p.w.git(p.product, "rev-parse", "HEAD"), tipBeforeBroken);
  assert.deepEqual(p.runs(), ["9.9.9"]);
});

test("R6-A33 fresh · flow: D-0064 T6 pure node-test command reuses codeTree receipt on VERSION-only bump and misses cache when code or test files change · loss: false-verdict", t => {
  const p = versionWorld(t);
  const env = directEnv(p);
  const runPureSuite = (sha, prefix) => spawnSync(process.execPath, [
    join(skill, "scripts", "suite-green.mjs"),
    "--repo", p.product, "--sha", sha, "--command", "node --test scripts/test/probe.test.mjs", "--format", "node-test", "--out", prefix,
  ], { encoding: "utf8", env });

  const basePrefix = join(p.w.dir, "pure-base");
  const r1 = runPureSuite(p.parent, basePrefix);
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  assert.deepEqual(p.runs(), [p.versions.parent]);

  const tip = p.editTip();
  const reusePrefix = join(p.w.dir, "pure-reuse");
  const r2 = runPureSuite(tip, reusePrefix);
  assert.equal(r2.status, 0, r2.stderr + r2.stdout);
  assert.deepEqual(p.runs(), [p.versions.parent]);
  const reuseReceipt = evidence(reusePrefix);
  assert.equal(reuseReceipt.sha, tip);
  assert.equal(reuseReceipt.green, true);
  assert.ok(reuseReceipt.reusedFrom && existsSync(reuseReceipt.reusedFrom));
  assert.equal(JSON.parse(readFileSync(reuseReceipt.reusedFrom, "utf8")).sha, p.parent);

  put(p.product, "scripts/test/probe.test.mjs", 'import assert from "node:assert/strict";\nimport { appendFileSync } from "node:fs";\nimport test from "node:test";\ntest("broken after bump", () => { appendFileSync(' + JSON.stringify(p.log) + ', "broken\\n"); assert.fail("fail"); });\n');
  const brokenSha = p.w.commit(p.product, "Break test file");
  const missPrefix = join(p.w.dir, "pure-miss");
  const r3 = runPureSuite(brokenSha, missPrefix);
  assert.equal(r3.status, 2);
  assert.deepEqual(p.runs(), [p.versions.parent, "broken"]);
});
