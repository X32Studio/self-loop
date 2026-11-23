import assert from "node:assert/strict";
import { join, relative } from "node:path";
import test from "node:test";
import { bytes, closingScenario, closingWorld, noBytes } from "./closing-fixture.mjs";
import { has, output, put, status, world } from "./fixture.mjs";

const unreadable = /could not read|cannot read|unreadable|unavailable|unknown/i;

function preparedClose(t, options) {
  const w = world(t);
  const spec = closingScenario({ releaseRemote: true });
  const release = closingWorld(w, spec, options);
  release.record("ci-before-rerun");
  return { w, spec, release };
}

test("RULE-19 the copied close refuses a red rerun the records have never seen", t => {
  const { spec, release } = preparedClose(t);
  const command = release.next();
  release.setRuns(spec.failedRerun);
  const before = release.readQueries().length;
  const result = release.suggested(command);
  status(result, 2);
  has(output(result), spec.failedCheck);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(before);
});

test("RULE-20 the copied close still succeeds after an unrecorded green rerun", t => {
  const { spec, release } = preparedClose(t);
  const command = release.next();
  release.setRuns(spec.successfulRerun);
  const before = release.readQueries().length;
  status(release.suggested(command), 0);
  release.row();
  release.assertReading(before);
});

test("RULE-21 unreadable CI refuses CONVERGED even with a green receipt on disk", t => {
  const { release } = preparedClose(t);
  const command = release.next();
  release.setRuns(null);
  const before = release.readQueries().length;
  const result = release.suggested(command);
  status(result, 2);
  has(output(result), "ci-green.mjs");
  assert.match(output(result), unreadable);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(before);
});

const feature = "F-0001";
const round = "R-0001-judge";

function preparedBlueprint(w, release) {
  const { records } = release;
  put(records, "purpose/P-0001.md", "# P-0001 Release only on green CI\n\nstatus: active\n");
  put(records, "blueprint/F-0001.md", "# F-0001 Release checks\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n");
  const set = (state, args = []) => w.run([
    "set", "--records", records, "--feature", feature, "--status", state, "--by", "lead", "--note", "Release acceptance",
    ...args,
  ], { entry: "blueprint.mjs" });
  status(set("building"), 0);
  w.commit(records, "Record feature in progress");
  const read = () => bytes(join(records, "metrics", "blueprint.jsonl"));
  const prior = read();
  const event = () => {
    const ledger = read();
    assert.deepEqual(ledger.subarray(0, prior.length), prior);
    return JSON.parse(ledger.subarray(prior.length));
  };
  return { set, read, prior, event };
}

function preparedBaseline(t) {
  const { w, spec, release } = preparedClose(t);
  const blueprint = preparedBlueprint(w, release);
  const receipt = release.record("ci-baseline", { sha: release.ruled, directory: "evidence/blueprint" });
  const evidence = {
    acceptance: "README.md#Acceptance@" + release.ruled,
    commit: release.ruled, ci: relative(release.records, receipt),
  };
  const args = Object.entries(evidence).flatMap(([key, value]) => ["--" + key, value]);
  return { w, spec, release, ...blueprint, evidence, args };
}

test("RULE-22 baseline done re-reads the destination and refuses a red rerun", t => {
  const { spec, release, set, args, read, prior } = preparedBaseline(t);
  release.setRuns(spec.failedRerun, release.ruled);
  const before = release.readQueries().length;
  const result = set("done", args);
  status(result, 2);
  has(output(result), spec.failedCheck);
  assert.deepEqual(read(), prior);
  release.assertReading(before, release.ruled);
});

test("RULE-23 baseline done succeeds when the same destination reruns green", t => {
  const { spec, release, set, args, event, evidence } = preparedBaseline(t);
  release.setRuns(spec.successfulRerun, release.ruled);
  const before = release.readQueries().length;
  status(set("done", args), 0);
  assert.deepEqual([event().status, event().evidence], ["done", evidence]);
  release.assertReading(before, release.ruled);
});

test("RULE-24 unreadable destination CI cannot mark a baseline done", t => {
  const { release, set, args, read, prior } = preparedBaseline(t);
  release.setRuns(null, release.ruled);
  const before = release.readQueries().length;
  const result = set("done", args);
  status(result, 2);
  assert.match(output(result), unreadable);
  assert.deepEqual(read(), prior);
  release.assertReading(before, release.ruled);
});

test("RULE-25 CONTINUE records unknown when CI is unreadable despite an older green", t => {
  const { release } = preparedClose(t, { verdict: "CONTINUE" });
  release.setRuns(null);
  const before = release.readQueries().length;
  const result = release.append({ verdict: "CONTINUE" });
  status(result, 0);
  assert.match(output(result), unreadable);
  release.row({ verdict: "CONTINUE", ci: "unknown" });
  release.assertReading(before);
});

test("RULE-26 a non-done blueprint event with prior evidence needs no new reading", t => {
  const { w, release } = preparedClose(t);
  const { set, event } = preparedBlueprint(w, release);
  const receipt = release.record("ci-ruled", { sha: release.ruled });
  const evidence = { round, commit: release.ruled, ci: relative(release.records, receipt) };
  const args = Object.entries(evidence).flatMap(([key, value]) => ["--" + key, value]);
  release.setRuns(null, release.ruled);
  const before = release.readQueries();
  status(set("designing", args), 0);
  assert.deepEqual([event().status, event().evidence], ["designing", evidence]);
  assert.deepEqual(release.readQueries(), before);
});

test("RULE-27 exact ruled SHA also needs green live CI without a version tip", t => {
  const { spec, release } = preparedClose(t, { edits: {} });
  release.setRuns(spec.failedRerun);
  const before = release.readQueries().length;
  const result = release.append();
  status(result, 2);
  has(output(result), spec.failedCheck);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(before, release.ruled);
});

test("RULE-28 round-backed done keeps the ruled SHA and the pushed tip's historical CI receipt", t => {
  const w = world(t);
  const spec = closingScenario({ releaseRemote: true });
  const release = closingWorld(w, spec);
  const { set, event } = preparedBlueprint(w, release);
  const handoff = JSON.parse(w.git(release.records, "show", "HEAD:metrics/handoffs.jsonl"));
  assert.deepEqual([handoff.id, handoff.role, handoff.product.base], [round, "judge", release.ruled]);
  status(release.append(), 0);
  const row = release.row();
  release.assertReading(0);
  release.setRuns(spec.failedRerun);
  const readings = release.readQueries();
  status(set("done", ["--round", round]), 0);
  assert.deepEqual([event().status, event().evidence], ["done", {
    round, commit: release.ruled, tip: release.tip, ci: row.ciReceipt,
  }]);
  status(w.run(["status", "--records", release.records, "--phase", "v1"], { entry: "blueprint.mjs" }), 0);
  assert.deepEqual(release.readQueries(), readings);
});

test("RULE-29 green CI with a CONTINUE ruling cannot mark a feature done", t => {
  const w = world(t);
  const release = closingWorld(w, closingScenario(), { verdict: "CONTINUE" });
  const { set, read, prior } = preparedBlueprint(w, release);
  status(release.append({ verdict: "CONTINUE" }), 0);
  release.row({ verdict: "CONTINUE" });
  const result = set("done", ["--round", round]);
  status(result, 2);
  assert.deepEqual(read(), prior);
});

test("RULE-30 round-backed done rejects caller-supplied commit or CI", t => {
  const w = world(t);
  const release = closingWorld(w, closingScenario());
  const { set, read, prior } = preparedBlueprint(w, release);
  for (const [flag, value] of [["--commit", release.tip], ["--ci", "evidence/0001/unused.json"]]) {
    const result = set("done", ["--round", round, flag, value]);
    status(result, 64);
    assert.deepEqual(read(), prior);
  }
});

test("RULE-31 baseline done refuses a receipt outside its records", t => {
  const { w, release, set, read, prior, evidence } = preparedBaseline(t);
  const outside = put(w.outside, "baseline.json", bytes(join(release.records, evidence.ci)));
  const result = set("done", ["--acceptance", evidence.acceptance, "--commit", evidence.commit,
    "--ci", relative(release.records, outside)]);
  status(result, 2);
  assert.deepEqual(read(), prior);
});
