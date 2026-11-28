import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { appendArgs, assertRow, serveChecks } from "./closing-fixture.mjs";
import { has, json, jsonOutput, output, put, status } from "./fixture.mjs";
import { pushWorld } from "./push-world-fixture.mjs";
import { publicationScenario, readJson, serveHosts, versionWorld } from "./version-world-fixture.mjs";

function tipSha(result) {
  const sha = output(result).match(/\b[0-9a-f]{40}\b/g)?.at(-1);
  assert.ok(sha, output(result));
  return sha;
}

function assertTip(p, sha, parent) {
  assert.equal(p.w.git(p.product, "show", "-s", "--format=%P", sha), parent);
  assert.equal(p.w.git(p.product, "diff", "--name-only", parent, sha), "VERSION");
  const result = p.w.runGit(p.product, "show", sha + ":VERSION");
  assert.equal(status(result, 0), p.versions.higher + "\n");
}

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

function closingReceipt(p) {
  const row = JSON.parse(p.readTrajectory().toString().trimEnd().split("\n").at(-1));
  const receipt = readJson(join(p.records, row.ciReceipt));
  assert.equal(row.ci, receipt.ci);
  return receipt;
}

test("R6-A19 pre-push refuses a fan-out before updating either remote repository", t => {
  const p = versionWorld(t);
  p.hook();
  const mirror = p.addRemote("secondary");
  p.w.git(p.product, "remote", "set-url", "--push", "origin", p.bare);
  p.w.git(p.product, "remote", "set-url", "--add", "--push", "origin", mirror);
  p.w.git(p.product, "tag", "v" + p.versions.parent);
  const push = () => p.w.runGit(p.product, "push", "--atomic", "origin", "main", "v" + p.versions.parent);
  const attempts = [push(), p.version(["release"]), p.version(["reconcile"])];
  assert.deepEqual([p.refs(), p.refs(mirror)], ["", ""], output(attempts[0]));
  for (const result of attempts) {
    assert.notEqual(result.status, 0);
    has(output(result), p.bare);
    has(output(result), mirror);
  }
  p.w.git(p.product, "config", "--unset-all", "remote.origin.pushurl");
  status(push(), 0);
  status(p.version(["release"]), 0);
  status(p.version(["reconcile"]), 0);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/main"), p.parent);
  assert.equal(p.refs(mirror), "");
});

test("R6-A20 a single explicit push URL remains valid through the Git hook", t => {
  const p = versionWorld(t);
  p.hook();
  const direct = p.addRemote("standalone");
  const tag = "v" + p.versions.parent;
  p.w.git(p.product, "tag", tag);
  status(p.w.runGit(p.product, "push", "--atomic", direct, "main", tag), 0);
  assert.equal(p.w.git(direct, "rev-parse", "refs/heads/main"), p.parent);
  assert.equal(p.w.git(direct, "rev-parse", "refs/tags/" + tag + "^{commit}"), p.parent);
  assert.equal(p.refs(), "");
});

test("R6-A21 tip fast-forwards a named branch without touching a staged and dirty checkout", t => {
  const p = versionWorld(t);
  p.w.git(p.product, "branch", "round/candidate");
  put(p.product, "rules.txt", "Committed before the ruling\n");
  const ruled = p.w.commit(p.product, "Prepare reviewed product");
  put(p.product, "README.md", "# Staged version\n");
  p.w.git(p.product, "add", "README.md");
  put(p.product, "README.md", "# Owner draft\n");
  put(p.product, "VERSION", "local draft\n");
  const before = p.state();
  const result = p.version(["tip", "--version", p.versions.higher, "--on", ruled, "--branch", "round/candidate"]);
  assert.deepEqual(p.state(), before);
  status(result, 0);
  const sha = tipSha(result);
  assertTip(p, sha, ruled);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/round/candidate"), sha);

  const clean = join(p.w.dir, "clean");
  p.w.git(p.product, "worktree", "add", "-q", "--detach", clean, sha);
  status(p.version(["release", "--branch", "round/candidate"], clean), 0);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/round/candidate"), sha);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/tags/v" + p.versions.higher + "^{commit}"), sha);
});

test("R6-A22 tip returns its commit without replacing a branch that advanced beyond its base", t => {
  const p = versionWorld(t);
  put(p.product, "rules.txt", "Work already on this branch\n");
  const advanced = p.w.commit(p.product, "Continue development");
  const before = p.state();
  const result = p.version(["tip", "--version", p.versions.higher, "--on", p.parent]);
  assert.deepEqual(p.state(), before);
  status(result, 2);
  const sha = tipSha(result);
  assertTip(p, sha, p.parent);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/main"), advanced);

  const retry = p.version(["tip", "--version", p.versions.higher, "--on", advanced]);
  status(retry, 0);
  assertTip(p, tipSha(retry), advanced);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/main"), tipSha(retry));
});

test("R6-A23 malformed or non-increasing versions preserve the branch and the checkout", t => {
  const p = versionWorld(t);
  const before = p.state();
  for (const [versions, code] of [[p.versions.invalid, 64], [[p.versions.parent, p.versions.lower], 2]]) {
    for (const version of versions) {
      const result = p.version(["tip", "--version", version]);
      assert.deepEqual(p.state(), before);
      status(result, code);
      assert.match(output(result), /version/i);
    }
  }
  const result = p.version(["tip", "--version", p.versions.higher]);
  status(result, 0);
  const sha = tipSha(result);
  assertTip(p, sha, p.parent);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/main"), sha);
  assert.deepEqual(p.state(), { ...before, head: sha });
});

test("R6-A24 a generated VERSION tip can close a round judged on its parent", t => {
  const p = pushWorld(t, { publishedRuling: false, edits: {} });
  const requested = "0.4.4-v1.6";
  const result = p.w.run(["tip", "--version", requested], { entry: "version-gate.mjs", cwd: p.product });
  status(result, 0);
  const tip = tipSha(result);
  const { slug } = p.first;
  serveChecks(p.w, { [slug]: { [tip]: p.close.initial } });
  const appendRes = p.w.run(appendArgs({ file: p.file, ruled: p.ruled, tip }), { entry: "trajectory.mjs" });
  status(appendRes, 0);
  assertRow(p.records, { ruled: p.ruled, tip, destination: slug });
});

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
  const result = p.append({ verdict: "CONVERGED", round: 1 }, [], { extraEnv: host.env });
  assert.ok(p.readTrajectory().equals(before), output(result));
  status(result, 2);
  has(output(result), p.close.failedCheck);

  serveHosts(p, scenario, p.close.successfulRerun, p.close.failedRerun);
  status(p.append({ verdict: "CONVERGED", round: 1 }, [], { extraEnv: host.env }), 0);
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

for (const missing of [true, false]) {
  test(`R9-B2-${missing ? "01" : "02"} ordered · flow: maintainer promotes with ${missing ? "a historical tree-less" : "an exact tree"} suite receipt · loss: false-verdict`, t => {
    const p = pushWorld(t);
    if (missing) {
      const receipt = JSON.parse(readFileSync(p.receipt, "utf8"));
      delete receipt.tree;
      const old = put(p.w.dir, "historical-receipt.json", json(receipt));
      const before = p.snapshot();
      status(p.promote([], { suiteReceipt: old }), 2);
      assert.deepEqual(p.snapshot(), before);
    }
    status(p.promote(), 0);
    p.assertDelivered(p.first);
  });
}
