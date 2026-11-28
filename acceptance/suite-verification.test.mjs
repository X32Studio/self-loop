import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { has, jsonOutput, output, put, skill, status, world } from "./fixture.mjs";
import { pushWorld } from "./push-world-fixture.mjs";
import { publicationScenario, readJson, runtimeChange, treeOf, versionWorld } from "./version-world-fixture.mjs";

function evidence(prefix) {
  const receipt = JSON.parse(readFileSync(prefix + ".json", "utf8"));
  const log = gunzipSync(readFileSync(prefix + ".log.gz"));
  assert.equal(createHash("sha256").update(log).digest("hex"), receipt.log.sha256);
  assert.equal(log.byteLength, receipt.log.bytes);
  return receipt;
}

const suiteLeases = p => existsSync(p.load)
  ? readdirSync(p.load).filter(file => /^suite-\d+-\d+\.json$/.test(file)) : [];

const directEnv = p => {
  const env = { ...process.env, SELF_LOOP_LOAD_DIR: p.load, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Acceptance", GIT_AUTHOR_EMAIL: "acceptance@example.invalid", GIT_COMMITTER_NAME: "Acceptance", GIT_COMMITTER_EMAIL: "acceptance@example.invalid", LC_ALL: "C", TZ: "UTC" };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  return env;
};

function assertTreeRefusal(resultText, wrong, exact) {
  has(resultText, wrong.tree);
  has(resultText, exact.tree);
}

function repairTip(p) {
  const file = join(p.product, "scripts/test/probe.test.mjs");
  const source = readFileSync(file, "utf8");
  assert.match(source, /assert\.notEqual/);
  put(p.product, "scripts/test/probe.test.mjs", source.replace("assert.notEqual", "assert.equal"));
  p.w.git(p.product, "reset", "--soft", p.parent);
  return p.w.commit(p.product, "Repair the suite for the intended VERSION");
}

function assertRelease(p, tip, branch = "main") {
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/" + branch), tip);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/tags/v" + p.versions.higher + "^{commit}"), tip);
}

function measureReviewTree(p) {
  const tip = p.editTip();
  const exact = jsonOutput(p.suite(tip), 2);
  assert.equal(exact.tree, treeOf(p, tip));
  const reviewed = repairTip(p);
  const wrong = jsonOutput(p.suite(reviewed));
  assert.equal(wrong.tree, treeOf(p, reviewed));
  assert.notEqual(wrong.tree, exact.tree);

  const branch = "release-candidate";
  p.w.git(p.product, "branch", branch, tip);
  p.w.git(p.product, "replace", tip, reviewed);
  assert.equal(p.w.git(p.product, "rev-parse", branch), tip);
  assert.equal(treeOf(p, branch), wrong.tree);
  assert.equal(p.w.git(p.product, "status", "--porcelain"), "");
  const finishReview = () => {
    p.w.git(p.product, "replace", "-d", tip);
    p.w.git(p.product, "branch", "-f", branch, reviewed);
  };
  return { branch, tip, reviewed, wrong, exact, finishReview };
}

function assertReviewRefusal(result, p, runsBefore, wrong, exact) {
  const text = output(result);
  if (text.includes(wrong.tree)) {
    status(result, 2);
    assertTreeRefusal(text, wrong, exact);
  } else {
    assert.ok([1, 2].includes(result.status), text);
    assert.match(text, /suite.*(?:not green|failed)/i);
    assert.deepEqual(p.runs().slice(runsBefore), [p.versions.higher]);
  }
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

test("R7-A05 hand the protected push a green receipt measured at a different VERSION · false-verdict", t => {
  const p = pushWorld(t);
  const { variedVersion } = publicationScenario();
  const suite = (sha, prefix, vary) => jsonOutput(p.w.run([
    "--repo", p.product, "--sha", sha, "--out", prefix, "--command",
    "node --input-type=module -e 'import assert from \"node:assert/strict\"; import { result } from \"./src/result.js\"; assert.equal(result, 1)'",
    ...(vary ? ["--vary-version", vary] : []),
  ], { entry: "suite-green.mjs" }));
  const wrongFile = join(p.w.dir, "wrong-version-suite");
  const wrong = suite(p.tip, wrongFile, variedVersion);
  const good = readJson(p.receipt);
  assert.equal(wrong.sha, p.tip);
  assert.equal(wrong.green, true);
  assert.equal(good.tree, treeOf(p, p.tip));
  assert.notEqual(wrong.tree, good.tree);
  const before = p.snapshot();
  const res = p.promote([], { suiteReceipt: wrongFile + ".json" });
  assert.deepEqual(p.snapshot(), before, output(res));
  status(res, 2);
  assertTreeRefusal(output(res), wrong, good);

  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

test("R7-A06 release while local review still shows another tree for the candidate · false-verdict", t => {
  const p = versionWorld(t, { failTip: true });
  const { branch, reviewed, wrong, exact, finishReview } = measureReviewTree(p);
  const release = () => p.version(["release", "--branch", branch]);
  const before = p.refs();
  const runsBefore = p.runs().length;
  const result = release();
  assert.equal(p.refs(), before, output(result));
  assertReviewRefusal(result, p, runsBefore, wrong, exact);
  assert.equal(p.w.git(p.product, "tag", "--list"), "");

  finishReview();
  status(release(), 0);
  assertRelease(p, reviewed, branch);
});

test("R7-A07 push a tag while local review still shows another tree for the candidate · false-verdict", t => {
  const p = versionWorld(t, { failTip: true });
  const { branch, tip, reviewed, wrong, exact, finishReview } = measureReviewTree(p);
  const ref = "refs/heads/" + branch;
  const tag = "refs/tags/v" + p.versions.higher;
  p.w.git(p.product, "tag", "v" + p.versions.higher, tip);
  const before = p.refs();
  p.hook();
  const push = () => p.w.runGit(p.product, "push", "--atomic", "origin", branch, tag);
  const attempted = push();
  assert.equal(p.refs(), before, output(attempted));
  assert.notEqual(attempted.status, 0, output(attempted));

  const zero = "0".repeat(tip.length);
  const updates = [`${ref} ${tip} ${ref} ${zero}`, `${tag} ${tip} ${tag} ${zero}`].join("\n");
  const runsBefore = p.runs().length;
  const result = p.w.runSuggested('printf "%s\\n" "$PUSH_UPDATE" | .githooks/pre-push origin "$PUSH_URL"', {
    cwd: p.product,
    extraEnv: { PUSH_UPDATE: updates, PUSH_URL: p.bare },
  });
  assertReviewRefusal(result, p, runsBefore, wrong, exact);

  finishReview();
  p.w.git(p.product, "tag", "-f", "v" + p.versions.higher, reviewed);
  status(push(), 0);
  assertRelease(p, reviewed, branch);
});

for (const [id, dimension] of [["08", "node"], ["09", "platform"], ["10", "arch"]]) {
  test(`R7-A${id} request the same suite after changing runtime ${dimension} · false-verdict`, t => {
    const w = world(t);
    const { original, changed, env } = runtimeChange(w, dimension);
    const log = join(w.dir, "runtime-runs");
    const product = w.repo(join(w.dir, "runtime-product"), {
      "probe.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
test("the runtime supported by this release", () => {
  const runtime = { node: process.versions.node, platform: process.platform, arch: process.arch };
  appendFileSync(${JSON.stringify(log)}, JSON.stringify(runtime) + "\\n");
  assert.deepEqual(runtime, ${JSON.stringify(original)});
});
`,
    });
    const sha = w.git(product, "rev-parse", "HEAD");
    const run = extraEnv => w.run([
      "--repo", product, "--sha", sha, "--command", "node --test probe.test.mjs", "--format", "node-test",
    ], { entry: "suite-green.mjs", extraEnv });
    const first = jsonOutput(run());
    const repeated = jsonOutput(run());
    assert.equal(repeated.green, true);
    assert.equal(repeated.reusedFrom, undefined);
    const red = jsonOutput(run(env), 2);
    assert.equal(red.green, false);
    assert.equal(red.reusedFrom, undefined);
    assert.deepEqual(readFileSync(log, "utf8").trimEnd().split("\n").map(line => JSON.parse(line)), [original, original, changed]);
    for (const [receipt, runtime] of [[first, original], [repeated, original], [red, changed]]) {
      const named = receipt.runtime ?? receipt;
      const node = named.node ?? named.nodeVersion ?? named.version;
      if (node == null) {
        assert.equal(receipt.reusedFrom, undefined);
        continue;
      }
      assert.equal(String(node).replace(/^v/, ""), runtime.node);
      assert.equal(named.platform, runtime.platform);
      assert.equal(named.arch ?? named.architecture, runtime.arch);
    }
  });
}

test("R7-A14 release and hook remeasure an opaque suite while preserving the exact VERSION-only tree · false-verdict", t => {
  const p = versionWorld(t);
  const measured = jsonOutput(p.suite(p.parent, ["--vary-version", p.versions.higher]));
  const tip = p.editTip();
  assert.equal(measured.tree, treeOf(p, tip));
  assert.equal(measured.versionVaried, p.versions.higher);
  p.hook();

  status(p.version(["release"]), 0);
  assertRelease(p, tip);
  assert.ok(p.runs().length > 1);
  assert.ok(p.runs().every(version => version === p.versions.higher));
});

for (const launcher of [true, false]) {
  test(`R9-B3-${launcher ? "01" : "02"} ordered · flow: same-tree suite ${launcher ? "launcher selects its runtime from external state" : "direct node run has an established unchanged runtime"} · loss: false-verdict`, t => {
    const w = world(t), log = join(w.dir, "executions");
    const selected = put(w.dir, "selected.cjs", "");
    const repo = w.repo(join(w.dir, "runtime"), {
      "probe.test.mjs": `import test from "node:test";\nimport assert from "node:assert/strict";\nimport {appendFileSync} from "node:fs";\ntest("runtime", () => {appendFileSync(${JSON.stringify(log)}, process.version+"\\n"); assert.equal(process.version, ${JSON.stringify(process.version)});});\n`,
      "launch.sh": `exec node --require ${JSON.stringify(selected)} --test probe.test.mjs\n`,
    });
    const run = () => w.run(["--repo", repo, "--sha", "HEAD", "--command", launcher ? "sh launch.sh" : "node --test probe.test.mjs", "--format", "node-test"], { entry: "suite-green.mjs", extraEnv: { NODE_OPTIONS: "" } });
    assert.equal(jsonOutput(run()).green, true);
    if (launcher) {
      put(w.dir, "selected.cjs", "Object.defineProperty(process, 'version', {value:'v26.0.0'});\n");
      const result = jsonOutput(run(), 2);
      assert.equal(result.green, false);
      assert.equal(result.reusedFrom, undefined);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);
    } else {
      assert.ok(jsonOutput(run()).reusedFrom);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1);
    }
  });
}
