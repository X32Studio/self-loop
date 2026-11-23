import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { committedAlarms, has, jsonOutput, put, world } from "./fixture.mjs";
import { product, seed, seeded } from "./scenario.mjs";

const tick = ["tick", "--hours", "1", "--json"];
const stall = ["stall", "--all", "--hours", "1", "--json"];

function discoveryRoot(w) {
  const root = join(w.dir, "project archives");
  const depth = 5 + seeded(seed)(4);
  const nested = Array.from({ length: depth }, (_, i) => `team-${i}`);
  w.register([], [root]);
  return { root, nested };
}

test("DISC-01 tick discovers a real unregistered records repository below several normal folder levels", t => {
  const w = world(t);
  const { root, nested } = discoveryRoot(w);
  const recordsFiles = { "records.json": "{}\n", "README.md": "# Team records\n" };
  const shallow = w.repo(join(root, "old-records"), recordsFiles);
  const deep = w.repo(join(root, ...nested, "new-records"), recordsFiles);

  const { products, findings } = jsonOutput(w.run(tick), 2);
  assert.equal(products, 0);
  const found = findings.filter(f => f.kind === "unregistered").map(f => f.path);
  assert.deepEqual(found.sort(), [shallow, deep].sort(), "both Git roots under the configured root are in scope");
});

test("DISC-02 tick skips tracked records fixtures inside an ordinary product checkout", t => {
  const w = world(t);
  const { root, nested } = discoveryRoot(w);
  w.repo(join(root, "product-with-test-data"), {
    "README.md": "# A product with tests\n",
    [join("test", ...nested, "records.json")]: "{}\n",
    "test/records.json": "{}\n",
  });

  const { products, findings } = jsonOutput(w.run(tick));
  assert.equal(products, 0);
  assert.deepEqual(findings, []);
});

function useAbsentBranch(w, item) {
  // A Git ref can disappear after a branch rename while the committed loop configuration still names it.
  const { branch } = JSON.parse(readFileSync(item.config, "utf8"));
  w.git(item.path, "branch", "-m", branch, "loop/renamed");
  return branch;
}

test("CLOCK-01 tick records an established stall even if the integration branch prevents next", t => {
  const w = world(t);
  const item = w.makeProduct(product("stalled-after-branch-rename", 32));
  const branch = useAbsentBranch(w, item);
  w.register([item]);
  const single = jsonOutput(w.run(["stall", "--hours", "1", "--json"], { cwd: item.path }), 2);
  assert.equal(single.stalled, true, "the normal stall entry can still determine the clock");
  assert.deepEqual(committedAlarms(w, item), [], "the manual stall read does not write alarms");

  const { findings } = jsonOutput(w.run(tick), 2);
  const errors = findings.filter(f => f.kind === "error" && f.product === item.name);
  assert.match(errors.map(f => f.detail).join("\n"), /next/i);
  has(errors.map(f => f.detail).join("\n"), branch);
  const alarms = committedAlarms(w, item);
  assert.equal(alarms.length, 1, "the next failure must not suppress the Git commit for the stall");
  const [alarm] = alarms;
  assert.equal(alarm.type, "stall");
  assert.equal(alarm.phase, item.phase);
  assert.equal(Date.parse(alarm.since), Date.parse(item.activityAt));
  const findingsForStall = findings.filter(f => f.kind === "stall" && f.product === item.name);
  assert.equal(findingsForStall.length, 1);
  assert.equal(findingsForStall[0].alarm, alarm.key);
});

test("CLOCK-02 a next error is reported for an active product without creating an alarm", t => {
  const w = world(t);
  const item = w.makeProduct(product("recent-branch-rename", 0.1));
  const branch = useAbsentBranch(w, item);
  w.register([item]);
  const head = w.git(item.records, "rev-parse", "HEAD");

  const { findings } = jsonOutput(w.run(tick), 2);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].product, item.name);
  assert.equal(findings[0].kind, "error");
  has(findings[0].detail, branch);
  assert.equal(w.git(item.records, "rev-parse", "HEAD"), head);
  assert.deepEqual(committedAlarms(w, item), []);
});

test("ISOLATE-01 stall --all reports a broken ledger and continues to the remaining products", t => {
  const w = world(t);
  const broken = w.makeProduct(product("broken-ledger", 1), 1);
  const recent = w.makeProduct(product("news", 0.1), 2);
  const idle = w.makeProduct(product("waiting", 30), 3);
  // A partially appended JSONL row has reached Git; reading the config itself still works.
  put(broken.records, "metrics/trajectory.jsonl", '{"round": 1,\n');
  w.commit(broken.records, "Partial trajectory entry");
  w.register([broken, recent, idle]);

  const results = jsonOutput(w.run(stall), 2);
  assert.equal(results.length, 3);
  const problem = results.find(r => r.product === broken.name);
  assert.ok(problem, "the unreadable product has its own result");
  assert.notEqual(problem.stalled, false, "a read failure is not a quiet clock");
  has(problem.problem ?? problem.error ?? problem.detail, "metrics/trajectory.jsonl");
  for (const [item, stalled] of [[recent, false], [idle, true]]) {
    const row = results.find(r => r.product === item.name);
    assert.ok(row, `the read failure suppressed ${item.name}'s result`);
    assert.equal(row.records, item.records);
    assert.equal(row.stalled, stalled);
    assert.equal(row.phase, item.phase);
  }
});

test("ISOLATE-02 stall --all exits 0 with a result for every healthy active product", t => {
  const w = world(t);
  const products = [w.makeProduct(product("first", 0.3)), w.makeProduct(product("second", 0.25), 2)];
  w.register(products);
  const results = jsonOutput(w.run(stall));
  assert.deepEqual(results.map(r => [r.product, r.records, r.phase, r.stalled]).sort(), products
    .map(item => [item.name, item.records, item.phase, false]).sort());
});
