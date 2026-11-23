import assert from "node:assert/strict";
import test from "node:test";
import { has, output, readQueries, status, world } from "./fixture.mjs";
import { closingScenario, closingWorld, noBytes } from "./closing-fixture.mjs";
import { rulingWorld } from "./ruling-fixture.mjs";

test("RULE-01 control: an unchanged ruled tip still passes the real gate", t => {
  const w = world(t);
  const release = rulingWorld(w, {});
  status(release.promote(), 0);
  assert.deepEqual(readQueries(w), [release.tip]);
});

test("RULE-02 VERSION-only tip inherits the ruling and uses CI for the tip", t => {
  const w = world(t);
  const release = rulingWorld(w, { "VERSION": "0.4.4\n" });
  assert.notEqual(release.ruled, release.tip);
  assert.equal(w.git(release.product, "diff", "--name-only", release.ruled + ".." + release.tip), "VERSION");
  const text = status(release.promote(), 0);
  has(text, release.tip.slice(0, 7));
  assert.deepEqual(readQueries(w), [release.tip]);
});

test("RULE-03 green CI cannot admit a tip with VERSION and an unruled code change", t => {
  const w = world(t);
  const release = rulingWorld(w, { "VERSION": "0.4.4\n", "src/result.js": "export const result = 2;\n" });
  assert.equal(w.git(release.product, "diff", "--name-only", release.ruled + ".." + release.tip), "VERSION\nsrc/result.js");
  const result = release.promote();
  status(result, 2);
  assert.match(result.stderr, /judge|ruling|unruled|VERSION/i);
});

test("RULE-04 green CI at the ruled SHA cannot substitute for green CI at a VERSION-only tip", t => {
  const w = world(t);
  const release = rulingWorld(w, { "VERSION": "0.4.4\n" });
  release.prepare({
    [release.ruled]: [release.green],
    [release.tip]: [{ ...release.green, conclusion: "failure" }],
  });
  const result = release.promote();
  status(result, 2);
  assert.deepEqual(readQueries(w), [release.tip]);
  assert.match(result.stderr, /verify.*failure/i);
});

test("RULE-05 the trajectory queries the exact tip and records both SHAs with its green reading", t => {
  const release = closingWorld(world(t), closingScenario());
  status(release.append(), 0);
  release.row();
  release.assertReading(0);
});

test("RULE-06 a green tip that also changes release notes cannot close the earlier ruling", t => {
  const release = closingWorld(world(t), closingScenario(), {
    edits: { VERSION: "0.4.4\n", "docs/release.md": "# Release note\n" },
  });
  const result = release.append();
  status(result, 2);
  assert.match(output(result), /judge|ruling|unruled|VERSION|changed/i);
  assert.deepEqual(release.readTrajectory(), noBytes);
  assert.deepEqual(release.readQueries(), []);
});

test("RULE-07 the removed success word is refused as a usage error before CI", t => {
  const release = closingWorld(world(t), closingScenario());
  const result = release.append({}, ["--ci", "success"]);
  status(result, 64);
  has(output(result), "--ci");
  assert.deepEqual(release.readTrajectory(), noBytes);
  assert.deepEqual(release.readQueries(), []);
});

test("RULE-08 a failed CI check on the exact tip refuses CONVERGED", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.setRuns(spec.failedRerun);
  const result = release.append();
  status(result, 2);
  has(output(result), spec.failedCheck);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(0);
});

test("RULE-09 an earlier judged SHA with green CI cannot substitute for a red pushed SHA", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.record("ci-ruled", { sha: release.ruled });
  release.setRuns(spec.failedRerun);
  const before = release.readQueries().length;
  status(release.append(), 2);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(before);
});

test("RULE-10 CONTINUE records the failed live reading on the pushed SHA", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.setRuns(spec.failedRerun);
  status(release.append({ verdict: "CONTINUE" }), 0);
  release.row({ verdict: "CONTINUE", ci: "failure" });
  release.assertReading(0);
});

test("RULE-11 next prints the new executable append for a judged version tip", t => {
  const release = closingWorld(world(t), closingScenario());
  const command = release.next();
  assert.doesNotMatch(command, /(?:^|\s)--(?:ci(?:-receipt)?|config|repo|remote)(?:\s|=)/);
  const before = release.readQueries().length;
  status(release.suggested(command), 0);
  release.row();
  release.assertReading(before);
});

test("RULE-12 the fetch repository's green CI cannot attest to fork CI for the same SHA", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  release.setRuns(spec.failedRerun);
  const before = release.readQueries().length;
  status(release.append(), 2);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(before);
});
