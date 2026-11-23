import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import { output, put, status } from "./fixture.mjs";
import { versionWorld } from "./r6-version-fixture.mjs";

function evidence(prefix) {
  const receipt = JSON.parse(readFileSync(prefix + ".json", "utf8"));
  const log = gunzipSync(readFileSync(prefix + ".log.gz"));
  assert.equal(createHash("sha256").update(log).digest("hex"), receipt.log.sha256);
  assert.equal(log.byteLength, receipt.log.bytes);
  return receipt;
}

test("R6-A25 opaque compound suite is remeasured across commit release and push hooks", t => {
  const p = versionWorld(t);
  p.hook();
  const tip = p.editTip();
  assert.ok(p.runs().length > 0);
  assert.ok(p.runs().every(version => version === p.versions.higher));

  status(p.version(["release"]), 0);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/main"), tip);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/tags/v" + p.versions.higher + "^{commit}"), tip);
  assert.ok(p.runs().length > 0);
  assert.ok(p.runs().every(version => version === p.versions.higher));

  const prefix = join(p.w.dir, "reused-suite");
  const runsBefore = p.runs().length;
  const result = p.suite(tip, ["--out", prefix]);
  assert.equal(p.runs().length, runsBefore + 1);
  status(result, 0);
  assert.doesNotMatch(output(result), /reused\s+\S+/i);
  assert.ok(p.runs().length > 0);
  assert.ok(p.runs().every(version => version === p.versions.higher));
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
