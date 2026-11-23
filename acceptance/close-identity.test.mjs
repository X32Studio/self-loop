import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  appendArgs, assertRow, bytes, closingScenario, closingWorld, ledgerPath, noBytes, queriesIn, serveChecks,
} from "./closing-fixture.mjs";
import { has, json, jsonOutput, jsonl, output, put, status, world } from "./fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

/**
 * Two records histories own distinct products with the same ruled and pushed object IDs.
 * Both lists contain a shared check, so only destination and complete per-loop policy distinguish the verdicts.
 */
function twoLoops(t) {
  const w = world(t);
  const spec = closingScenario({ releaseRemote: true });
  const a = closingWorld(w, spec);
  const { ruled, tip } = a;
  const aConfig = join(a.records, "loop.json");
  const aReceipt = a.record("ci-green-in-a");
  const bProduct = join(w.projects, "other product");
  w.git(w.projects, "clone", "-q", "--no-local", a.product, bProduct);
  assert.equal(w.git(bProduct, "rev-parse", "HEAD"), tip);
  const bRepo = spec.destination + "-peer";
  w.git(bProduct, "remote", "set-url", "--push", "origin", "git@github.com:" + bRepo + ".git");
  const bRecords = join(w.projects, "other records");
  const prior = jsonl({
    round: 1, phase: "v1", role: "judge", verdict: "CONTINUE", commit: ruled, suite: "9/1", ci: "failure",
  });
  const file = join(bRecords, ledgerPath);
  const requiredOnlyByB = { id: 3000, name: "Peer approval", status: "completed", conclusion: "failure", app: { slug: "github-actions" } };
  w.repo(bRecords, {
    "records.json": "{}\n",
    "loop.json": json({
      records: bRecords, product: bProduct, phase: "v1", branch: "main", workDir: join(w.dir, "other work"),
      briefs: {}, agents: {}, gates: { require: [...spec.requires, "github-actions/Peer approval"] },
    }),
    [ledgerPath]: prior,
  });
  const setB = conclusion => serveChecks(w, {
    [spec.destination]: { [ruled]: spec.initial, [tip]: spec.initial },
    [bRepo]: {
      [ruled]: [...spec.initial, { ...requiredOnlyByB, conclusion: "success" }],
      [tip]: [{ ...requiredOnlyByB, conclusion }, ...spec.initial],
    },
  });
  setB("failure");
  const append = ({ ledger = file, extra = [], cwd = w.outside, extraEnv = {} } = {}) =>
    w.run([...appendArgs({ ruled, tip, file: ledger }, { round: 2 }), ...extra], {
      entry: "trajectory.mjs", cwd, extraEnv,
    });
  const unchanged = () => {
    assert.ok(bytes(file).equals(Buffer.from(prior)), "B's ledger bytes changed:\n" + bytes(file));
    assert.deepEqual(a.readTrajectory(), noBytes, "A's ledger bytes");
  };
  const readings = () => queriesIn(w).slice(1); // setup's real CI-reader call generated A's historical receipt
  const bReading = { repository: bRepo, sha: tip };
  return { w, a, aConfig, aReceipt, bRecords, bRepo, file, prior, setB, append, unchanged, readings, bReading };
}

test("R5-CI-01 a copied old config and receipt cannot close another loop's red ledger", t => {
  const { aConfig, aReceipt, append, unchanged, readings } = twoLoops(t);
  const result = append({ extra: ["--config", aConfig, "--ci-receipt", aReceipt] });
  unchanged();
  status(result, 64);
  assert.match(output(result), /--(?:config|ci-receipt)/);
  assert.deepEqual(readings(), []);
});

test("R5-CI-02 each removed identity or verdict flag names itself and changes no ledger bytes", t => {
  const { a, aConfig, aReceipt, append, unchanged, readings } = twoLoops(t);
  for (const [flag, value] of [
    ["--config", aConfig], ["--repo", a.product], ["--remote", "release"],
    ["--ci", "success"], ["--ci-receipt", aReceipt],
  ]) {
    const result = append({ extra: [flag, value] });
    status(result, 64);
    has(output(result), flag);
    unchanged();
  }
  assert.deepEqual(readings(), []);
});

test("R5-CI-03 a stale config environment and either cwd in A still read only B's red destination", t => {
  const { a, aConfig, append, unchanged, readings, bReading } = twoLoops(t);
  const extraEnv = { SELF_LOOP_CONFIG: aConfig };
  for (const settings of [{ extraEnv }, { cwd: a.records }, { cwd: a.product, extraEnv }]) {
    status(append(settings), 2);
    unchanged();
  }
  assert.deepEqual(readings(), [bReading, bReading, bReading]);
});

test("R5-CI-04 an A-side ledger symlink follows B's real records for failure and success", t => {
  const { a, aConfig, bRecords, bRepo, file, prior, setB, append, unchanged, readings, bReading } = twoLoops(t);
  const ledger = join(a.records, "metrics", "shortcut.jsonl");
  symlinkSync(file, ledger);
  const settings = { ledger, cwd: a.records, extraEnv: { SELF_LOOP_CONFIG: aConfig } };
  status(append(settings), 2);
  unchanged();

  setB("success");
  status(append(settings), 0);
  assert.deepEqual(bytes(file).subarray(0, Buffer.byteLength(prior)), Buffer.from(prior));
  assertRow(bRecords, { ruled: a.ruled, tip: a.tip, destination: bRepo, round: 2 });
  assert.deepEqual(a.readTrajectory(), noBytes);
  assert.deepEqual(readings(), [bReading, bReading]);
});

test("R5-CI-05 a stray green exact-SHA receipt under B evidence cannot authorize B's failure", t => {
  const { aReceipt, bRecords, append, unchanged, readings, bReading } = twoLoops(t);
  const receipt = put(bRecords, "evidence/0002/ci-from-peer.json", bytes(aReceipt));
  const before = bytes(receipt);
  status(append(), 2);
  unchanged();
  assert.deepEqual(bytes(receipt), before);
  assert.deepEqual(readings(), [bReading]);
});

test("R5-CI-06 wrong phases including case mismatch refuse before a read or write", t => {
  const release = closingWorld(world(t), closingScenario(), { edits: {} });
  for (const phase of ["v2", "V1"]) {
    const result = release.append({ phase });
    status(result, 2);
    has(output(result), phase);
    has(output(result), "v1");
    assert.deepEqual(release.readTrajectory(), noBytes);
  }
  assert.deepEqual(release.readQueries(), []);
});

test("R5-CI-07 orphan ledgers cannot close but still record an absent CONTINUE", t => {
  const w = world(t);
  const release = closingWorld(w, closingScenario(), { edits: {} });
  const check = ({ records, file }) => {
    const append = verdict => w.run(appendArgs({ file, ruled: release.ruled }, { verdict }), { entry: "trajectory.mjs" });
    status(append("CONVERGED"), 2);
    assert.deepEqual(bytes(file), noBytes);
    status(append("CONTINUE"), 0);
    assertRow(records, { ruled: release.ruled, verdict: "CONTINUE", ci: "absent" });
  };
  const orphan = join(w.outside, "metrics", "trajectory.jsonl");
  put(w.outside, ledgerPath, "");
  check({ records: w.outside, file: orphan });
  rmSync(join(release.records, "loop.json"));
  assert.ok(!existsSync(join(release.records, "loop.json")));
  check(release);
  assert.deepEqual(release.readQueries(), []);
});

test("R5-CI-08 records-check rejects an altered receipt's SHA or CI word offline", t => {
  const w = world(t);
  const release = closingWorld(w, closingScenario());
  status(release.append(), 0);
  const row = release.row();
  const receipt = join(release.records, row.ciReceipt);
  w.git(release.records, "add", "--", ledgerPath, row.ciReceipt);
  const read = () => w.run(["--repo", release.records, "--write", "--json"], { entry: "records-check.mjs" });
  status(read(), 0);
  w.commit(release.records, "Accept genuine recorded CI");
  const observation = JSON.parse(readFileSync(receipt, "utf8"));
  const before = release.readQueries();
  for (const altered of [{ sha: release.ruled }, { ci: "failure" }]) {
    put(release.records, row.ciReceipt, json({ ...observation, ...altered }));
    const result = read();
    const { failures } = jsonOutput(result, 1);
    assert.ok(failures.some(finding => finding.path === ledgerPath || /ci|receipt/i.test(finding.rule)), output(result));
  }
  assert.deepEqual(release.readQueries(), before);
});

test("R5-CI-09 ci-absent is raised for absent and unknown judged CI only", t => {
  const w = world(t);
  const words = ["absent", "unknown", "success", "failure"];
  const file = put(w.outside, "trajectory.jsonl", jsonl(...words.map((ci, index) => ({
    round: index + 1, phase: "v1", role: "judge", verdict: "CONTINUE", commit: "a".repeat(40), ci,
  })), { round: 5, phase: "v1", role: "actor", verdict: "-", ci: "absent" }));
  const found = jsonOutput(w.run(["alarms", "--file", file, "--json"], { entry: "trajectory.mjs" }));
  assert.deepEqual(found.filter(alarm => alarm.type === "ci-absent").map(alarm => alarm.key).sort(), [
    "ci-absent:v1:1", "ci-absent:v1:2",
  ]);
  assert.ok(found.some(alarm => alarm.key === "ci-not-green:v1:4"), "failure keeps its own alarm");
});

test("R5-CI-10 a noncanonical ledger inside a configured repository cannot receive CONVERGED", t => {
  const w = world(t);
  const release = closingWorld(w, closingScenario(), { edits: {} });
  const other = put(release.records, "metrics/trajectory-copy.jsonl", "");
  const result = w.run(appendArgs({ file: other, ruled: release.ruled }), { entry: "trajectory.mjs" });
  assert.notEqual(result.status, 0, output(result));
  assert.deepEqual(bytes(other), noBytes);
  assert.deepEqual(release.readTrajectory(), noBytes);
});

test("R5-CI-11 empty and high-volume readable snapshots still record one exact verdict per row", t => {
  const spec = closingScenario();
  const release = closingWorld(world(t), spec);
  const draw = seeded(seed);
  const noise = Array.from({ length: 101 + draw(100) }, (_, index) => ({
    id: 10000 + index, name: spec.initial[index % spec.initial.length].name,
    status: "completed", conclusion: "success", app: { slug: "unrelated-app-" + index },
  }));

  release.setRuns([...noise, ...spec.failedRerun]);
  status(release.append(), 2);
  assert.deepEqual(release.readTrajectory(), noBytes);
  release.assertReading(0);

  release.setRuns([]);
  status(release.append({ verdict: "CONTINUE" }), 0);
  release.row({ verdict: "CONTINUE", ci: "absent" });
  release.assertReading(1);

  release.setRuns([...spec.successfulRerun, ...noise.toReversed()]);
  status(release.append({ round: 2 }), 0);
  release.row({ round: 2 });
  release.assertReading(2);
});
