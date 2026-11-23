import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, json, jsonOutput, output, put, status, world } from "./fixture.mjs";
import { pushWorld } from "./r6-push-fixture.mjs";
import { versionWorld } from "./r6-version-fixture.mjs";
import { publicationScenario, readJson, runtimeChange, serveHosts, treeOf } from "./r7-a-fixture.mjs";

function assertReading(reading, p, host, ci) {
  assert.equal(reading.host ?? reading.hostname, host);
  assert.equal(reading.repository, p.first.slug);
  assert.equal(reading.sha, p.tip);
  assert.equal(reading.ci, ci);
  assert.equal(reading.ok, ci === "success");
}

function diagnose(p, extraEnv, prefix) {
  return p.w.run([
    "--repo", p.product, "--sha", p.tip, "--require", p.close.requires.join(","), "--out", prefix,
  ], { entry: "ci-green.mjs", extraEnv });
}

function refusePush(p, action) {
  const before = p.snapshot();
  const result = action();
  assert.deepEqual(p.snapshot(), before, output(result));
  status(result, 2);
  return output(result);
}

function append(p, verdict, round, extraEnv) {
  return p.append({ verdict, round }, [], { extraEnv });
}

function closingReceipt(p) {
  const row = JSON.parse(p.readTrajectory().toString().trimEnd().split("\n").at(-1));
  const receipt = readJson(join(p.records, row.ciReceipt));
  assert.equal(row.ci, receipt.ci);
  return receipt;
}

test("R7-A01 diagnose two CI hosts with the same slug and SHA · false-verdict", t => {
  const p = pushWorld(t);
  const scenario = publicationScenario();
  const host = serveHosts(p, scenario, p.close.failedRerun, p.close.initial);
  const redPrefix = join(p.w.dir, "public-red");
  const red = jsonOutput(diagnose(p, host.env, redPrefix), 2);
  assert.deepEqual(readJson(redPrefix + ".json"), red);
  assertReading(red, p, scenario.publicHost, "failure");
  assert.equal(red.conclusions[p.close.failedCheck], "failure");

  serveHosts(p, scenario, p.close.successfulRerun, p.close.failedRerun);
  const greenPrefix = join(p.w.dir, "public-green");
  const green = jsonOutput(diagnose(p, host.env, greenPrefix));
  assert.deepEqual(readJson(greenPrefix + ".json"), green);
  assertReading(green, p, scenario.publicHost, "success");
  assert.deepEqual(host.requests().map(request => request.host), [scenario.publicHost, scenario.publicHost]);
});

test("R7-A02 close a round from the destination host's CI · false-verdict", t => {
  const p = pushWorld(t, { publishedRuling: false });
  const scenario = publicationScenario();
  const host = serveHosts(p, scenario, p.close.failedRerun, p.close.initial);
  const before = p.readTrajectory();
  const result = append(p, "CONVERGED", 1, host.env);
  assert.ok(p.readTrajectory().equals(before), output(result));
  status(result, 2);
  has(output(result), p.close.failedCheck);

  serveHosts(p, scenario, p.close.successfulRerun, p.close.failedRerun);
  status(append(p, "CONVERGED", 1, host.env), 0);
  p.row();
  assertReading(closingReceipt(p), p, scenario.publicHost, "success");
  p.w.commit(p.records, "Record convergence from destination CI");
  status(p.promote([], { extraEnv: host.env }), 0);
  p.assertDelivered(p.first);
  assert.deepEqual(host.requests().map(request => request.host), Array(3).fill(scenario.publicHost));
});

test("R7-A03 promote after the destination's failed rerun recovers · false-verdict", t => {
  const p = pushWorld(t);
  const scenario = publicationScenario();
  const host = serveHosts(p, scenario, p.close.failedRerun, p.close.initial);
  const promote = () => p.promote([], { extraEnv: host.env });
  has(refusePush(p, promote), p.close.failedCheck);
  serveHosts(p, scenario, p.close.successfulRerun, p.close.failedRerun);
  status(promote(), 0);
  p.assertDelivered(p.first);
  assert.deepEqual(host.requests().map(request => request.host), [scenario.publicHost, scenario.publicHost]);
});

test("R7-A04 diagnose and publish with an unsupported push host · false-verdict", t => {
  const p = pushWorld(t);
  const scenario = publicationScenario();
  const host = serveHosts(p, scenario, p.close.initial, p.close.failedRerun);
  const setDestination = url => p.w.git(p.product, "remote", "set-url", "--push", p.close.remote, url);
  setDestination(`git@${scenario.mirrorHost}:${p.first.slug}.git`);

  const before = p.readTrajectory();
  const refused = p.append({ round: 2 });
  assert.ok(p.readTrajectory().equals(before), output(refused));
  status(refused, 2);
  has(output(refused), scenario.mirrorHost);
  status(p.append({ round: 2, verdict: "CONTINUE" }), 0);
  assert.deepEqual(p.readTrajectory().subarray(0, before.length), before);
  const prefix = join(p.w.dir, "unsupported");
  const unknown = jsonOutput(diagnose(p, {}, prefix), 2);
  assert.deepEqual(readJson(prefix + ".json"), unknown);
  has(refusePush(p, () => p.promote()), scenario.mirrorHost);
  assert.deepEqual(host.requests(), []);
  for (const reading of [unknown, closingReceipt(p)]) {
    assert.equal(reading.ci, "unknown");
    assert.equal(reading.ok, false);
    assert.equal(reading.sha, p.tip);
    const identity = JSON.stringify(reading);
    has(identity, scenario.mirrorHost);
    has(identity, p.first.slug);
  }

  setDestination(p.first.url);
  assertReading(jsonOutput(diagnose(p, {}, join(p.w.dir, "supported"))), p, scenario.publicHost, "success");
  status(p.append({ round: 3 }), 0);
  assertReading(closingReceipt(p), p, scenario.publicHost, "success");
  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

function assertTreeRefusal(resultText, wrong, exact) {
  has(resultText, wrong.tree);
  has(resultText, exact.tree);
}

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
  assertTreeRefusal(refusePush(p, () => p.promote([], { suiteReceipt: wrongFile + ".json" })), wrong, good);

  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

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

test("R7-A11 promote through the Git remote named with dots and a slash · false-verdict", t => {
  const p = pushWorld(t, { publishedRuling: false });
  const { configuredRemote, unknownRemote } = publicationScenario();
  const missing = p.diagnose(unknownRemote);
  status(missing, 2);
  has(output(missing), unknownRemote);

  p.w.git(p.product, "remote", "add", configuredRemote, p.first.url);
  assert.equal(p.w.git(p.product, "remote", "get-url", "--push", "--all", "--", configuredRemote), p.first.url);
  p.configure(configuredRemote);
  assert.equal(jsonOutput(p.diagnose(configuredRemote)).repository, p.first.slug);
  status(p.append(), 0);
  p.row();
  p.w.commit(p.records, "Record convergence through configured remote");
  status(p.promote(), 0);
  p.assertDelivered(p.first);
});

for (const [id, key] of [["12", "protected"], ["13", "gates.require"]]) {
  test(`R7-A${id} migrate an omitted ${key} to an explicit empty list · false-verdict`, t => {
    const p = pushWorld(t, { publishedRuling: false });
    const config = readJson(p.config);
    const checks = config.gates.require;
    const configured = key === "protected" ? config : config.gates;
    const field = key === "protected" ? key : "require";
    const write = () => {
      put(p.records, "loop.json", json(config));
      p.w.commit(p.records, `Set publication policy for ${key}`);
    };

    p.serve(p.close.failedRerun);
    delete configured[field];
    write();
    const text = refusePush(p, () => p.promote());
    has(text, "loop.json");
    if (key === "protected") has(text, key);
    else assert.match(text, /gates[\s\S]*\brequire\b|\brequire\b[\s\S]*gates/);
    assert.match(text, /add|set|declare|configure|explicit/i);

    configured[field] = [];
    write();
    if (key === "gates.require") {
      assert.match(refusePush(p, () => p.promote()), /judge|converg/i);
      configured[field] = checks;
      write();
      p.serve();
      status(p.append(), 0);
      p.w.commit(p.records, "Record convergence before retiring the required checks");
      p.serve(p.close.failedRerun);
      configured[field] = [];
      write();
    }
    const beforeQueries = p.readQueries();
    status(p.promote(), 0);
    p.assertDelivered(p.first);
    assert.deepEqual(p.readQueries(), beforeQueries);
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
