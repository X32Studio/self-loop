import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { has, json, jsonOutput, lacks, put, status, writeGh } from "./fixture.mjs";
import { argsFor, batchDraw, greenCheck, hostMeasurement, loopWorld, phase, prepare, record, suggestedHeavy } from "./loop-world-fixture.mjs";
import { now } from "./scenario.mjs";

const GiB = 2 ** 30;
const heavyCallCount = count => new RegExp(
  `(?:\\b${count}\\s+(?:active\\s+)?heavy\\s+calls?\\b|\\bheavy\\s+calls?\\b[^\\n]*\\b${count}\\b|\\bload\\s+${count}\\s*[:/])`, "i");
const heavyCommands = text => text.split("\n").filter(line =>
  /call\.mjs.* (critic|actor|judge) --round |suite-green\.mjs.* --command /.test(line));

function measuredNext(w, p, { load = 0.25, availableBytes = 32 * GiB, entry = "self-loop.mjs" } = {}) {
  const preload = put(w.dir, "measured-host.mjs", `
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
os.cpus = () => Array.from({ length: 10 }, () => ({ model: "Fixture", speed: 2400, times: {} }));
os.availableParallelism = () => 10;
os.loadavg = () => [${load}, 0.02, 0.01];
os.freemem = () => ${availableBytes};
os.totalmem = () => 64 * 2 ** 30;
syncBuiltinESMExports();
`);
  return status(w.run(entry, ["next", "--config", p.config], {
    extraEnv: { NODE_OPTIONS: `--import=${pathToFileURL(join(w.dir, "clock.mjs")).href} --import=${pathToFileURL(preload).href}` },
  }), 0);
}

function suiteLease(w, p, pid, number = 0) {
  return put(w.load, `suite-${pid}-${number}.json`, json({
    kind: "suite", pid, repo: p.product, sha: p.initial, started: now,
  }));
}

async function startCli(w, p, role, tool) {
  const ready = join(w.dir, tool + "-ready");
  const release = join(w.dir, tool + "-release");
  chmodSync(put(w.bin, tool, `#!/usr/bin/env node
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
writeFileSync(${JSON.stringify(ready)}, "");
const timer = setInterval(() => {
  if (!existsSync(${JSON.stringify(release)})) return;
  writeFileSync(join(process.env.SELF_LOOP_WORKSPACE, "out/report.md"), "The fixture role completed.\\n");
  clearInterval(timer);
}, 20);
`), 0o755);
  const result = w.runAsync(argsFor(w, p, role), { entry: "call.mjs", extraEnv: w.extraEnv });
  try {
    for (let tick = 0; tick < 200 && !existsSync(ready); tick++) await delay(25);
    assert.ok(existsSync(ready), `fixture ${tool} reported that it started`);
  } catch (error) {
    put(w.dir, tool + "-release", "");
    await result;
    throw error;
  }
  return () => {
    put(w.dir, tool + "-release", "");
    return result;
  };
}

test("R6-B2-01 next counts work across products and suggests heavy work on a roomy host", async t => {
  const w = loopWorld(t);
  const left = phase(w, "left");
  const right = phase(w, "right", { agents: { actor: { runner: "codex" } } });
  w.register(batchDraw()(2) ? [left, right] : [right, left]);
  const prepared = prepare(w, left, "critic", { round: 3 });
  const finish = await startCli(w, right, "actor", "codex");
  try {
    const repo = w.repo(join(w.outside, "unregistered-suite"), { VERSION: "1.0.0\n" });
    const suite = suiteLease(w, { product: repo, initial: w.git(repo, "rev-parse", "HEAD") }, process.pid);
    const available = measuredNext(w, right);
    assert.match(available, heavyCallCount(3));
    has(available, prepared.id);
    assert.match(available, /running actor call[^\n]*\bpid\b/);
    assert.match(available, /suite[^\n]*\bpid\b/);
    assert.ok(heavyCommands(available).length > 0, available);
    rmSync(suite);
    const afterSuite = measuredNext(w, right, { entry: "loop.mjs" });
    assert.match(afterSuite, heavyCallCount(2));
    assert.ok(heavyCommands(afterSuite).length > 0, afterSuite);
  } finally {
    jsonOutput(await finish());
  }
  jsonOutput(record(w, left, prepared));
  const idle = measuredNext(w, right);
  assert.match(idle, heavyCallCount(0), "recorded attempts and exited CLI calls leave no active heavy work");
});

test("R6-B2-02 next excludes stale work and compares available bytes with the GiB floor", t => {
  const w = loopWorld(t);
  const left = phase(w, "left");
  const right = phase(w, "right");
  const draw = batchDraw(2);
  const live = 1 + draw(2);
  w.register([left, right]);
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(dead.status, 0);
  assert.throws(() => process.kill(dead.pid, 0), { code: "ESRCH" });
  for (let i = 0, count = 12 + draw(45); i < count; i++) suiteLease(w, right, dead.pid, i);
  put(w.load, `call-${dead.pid}-0.json`, json({ kind: "call", pid: dead.pid, role: "judge", records: right.records }));
  const abandoned = prepare(w, right, "actor", { round: 20 });
  w.git(right.product, "worktree", "remove", abandoned.wt);
  for (let i = 0; i < live; i++) prepare(w, left, "critic", { round: 2 + i });
  const available = measuredNext(w, right, { availableBytes: 16 * GiB });
  assert.match(available, heavyCallCount(live));
  assert.match(available, /lost its worktree/);
  assert.ok(heavyCommands(available).length > 0, available);
  const lowMemory = measuredNext(w, right, { availableBytes: 16 * GiB - 1 });
  assert.match(lowMemory, heavyCallCount(live));
  assert.deepEqual(heavyCommands(lowMemory), [], lowMemory);
});

test("R6-B2-03 a live reviewer stays outside the count and busy CPU leaves recording available", async t => {
  const w = loopWorld(t);
  const left = phase(w, "left");
  const right = phase(w, "right");
  w.register([left, right]);
  const finish = await startCli(w, left, "reviewer", "claude");
  try {
    const idle = measuredNext(w, right);
    assert.match(idle, heavyCallCount(0));
    assert.ok(heavyCommands(idle).length > 0, idle);
    const work = prepare(w, right, "actor");
    const available = measuredNext(w, right, { load: 7 });
    assert.match(available, heavyCallCount(1));
    assert.ok(heavyCommands(available).length > 0, available);
    const busy = measuredNext(w, right, { load: 7.01 });
    assert.match(busy, heavyCallCount(1));
    assert.deepEqual(heavyCommands(busy), [], busy);
    has(busy, work.id);
    assert.match(busy, /call\.mjs.* record --ws /);
  } finally {
    status(await finish(), 0);
  }
});

const draw = batchDraw(570);
const cores = 10 * (1 + draw(3));
const headroom = (1 + draw(5)) / 8;
const belowBothMemoryUnits = 1.25 + headroom;
const defaultLimit = cores * 0.7;
const defaultMemory = 16;
const measurements = [
  ["01", "just below the default one-minute load limit", { cores, load: defaultLimit - 0.01, availableGB: 20 }, true],
  ["02", "exactly at the default load limit with 16 GiB available", { cores, load: defaultLimit, availableGB: defaultMemory }, true],
  ["03", "just above the default one-minute load limit", { cores, load: defaultLimit + 0.01, availableGB: 20 }, false],
  ["04", "below the default available memory floor", { cores, load: 0.25, availableGB: defaultMemory - belowBothMemoryUnits }, false],
  ["05", "just above the default available memory floor", { cores, load: 0.25, availableGB: defaultMemory + headroom }, true],
  ["06", "available memory above the floor with only 8 GiB immediately free",
    { cores, load: 0.25, availableGB: defaultMemory + headroom, freeGB: 8 }, true],
  ["10", "available memory below the floor with only 8 GiB immediately free",
    { cores, load: 0.25, availableGB: defaultMemory - headroom, freeGB: 8 }, false],
];

function configure(w, store, products, thresholds) {
  const path = "products.json";
  const registry = JSON.parse(readFileSync(join(store, path), "utf8"));
  put(store, path, json({
    ...registry,
    products: products.map(({ name, records }) => ({ name, records })),
    ...thresholds,
  }));
  w.commit(store, "Configure capacity for the registered products");
}

function launch(w, p, measurement, flags = ["--config", p.config]) {
  return status(w.run("self-loop.mjs", ["next", ...flags], {
    cwd: p.product, extraEnv: hostMeasurement(w, measurement),
  }), 0);
}

function assertsCapacity(text, allowed) {
  const commands = suggestedHeavy(text);
  assert.equal(commands.length > 0, allowed, text);
  if (allowed) {
    for (const required of [/call\.mjs.* critic --round /, /suite-green\.mjs.* --command /]) {
      assert.ok(commands.some(line => required.test(line)), text);
    }
  }
}

for (const [id, label, measurement, allowed] of measurements) {
  test(`R7-B6-${id} next bases heavy work on ${label}`, t => {
    const w = loopWorld(t);
    const p = phase(w);
    w.register([p]);
    assertsCapacity(launch(w, p, measurement), allowed);
  });
}

test("R7-B6-07 a roomy host still suggests heavy work when the live call count exceeds the legacy limit", t => {
  const w = loopWorld(t);
  const current = phase(w, "current");
  const other = phase(w, "other");
  configure(w, w.owner, [current, other], { heavyBudget: 1 });
  const active = prepare(w, other, "actor");
  put(w.load, `suite-${process.pid}-0.json`, json({
    kind: "suite", pid: process.pid, repo: current.product, sha: current.initial, started: now,
  }));
  const text = launch(w, current, { cores: 10, load: 0.25, availableGB: 32 }, []);
  assertsCapacity(text, true);
  has(text, active.id);
  assert.match(text, /\bsuite\b[^\n]*\bpid\b/i);
  assert.match(text, /(?:\b2\s+heavy\s+calls\b|\bheavy\s+calls\b[^\n]*\b2\b|\bload\s+2\s*[:/])/i);
});

test("R7-B6-08 owner registry thresholds each override the defaults", t => {
  const w = loopWorld(t);
  const p = phase(w);
  configure(w, w.owner, [p], { maxLoadRatio: 0.5, minAvailableMemoryGB: 8 });
  const scenarios = [
    [{ cores: 8, load: 4, availableGB: 8 }, true],
    [{ cores: 8, load: 4.01, availableGB: 16 }, false],
    [{ cores: 8, load: 0.25, availableGB: 8 - belowBothMemoryUnits }, false],
  ];
  for (const [measurement, allowed] of scenarios) assertsCapacity(launch(w, p, measurement, []), allowed);
});

test("R7-B6-09 busy host still offers record and live CI while new heavy work waits", t => {
  const w = loopWorld(t);
  const p = phase(w);
  w.register([p]);
  const active = prepare(w, p, "actor");
  writeGh(w, { [p.initial]: [{ ...greenCheck, status: "in_progress", conclusion: null }] });
  const text = launch(w, p, { cores: 10, load: 7.25, availableGB: 32 });
  assert.deepEqual(suggestedHeavy(text), [], text);
  has(text, active.id);
  assert.match(text, /call\.mjs.* record --ws /);
  assert.match(text, /ci-green\.mjs.* --sha /);
});

test("R7-B7-01 start and direct next see the same explicit owner store despite a different environment store", t => {
  const w = loopWorld(t);
  const current = phase(w, "current");
  const other = phase(w, "other");
  w.register([current]);
  const explicit = w.repo(join(w.dir, "alternate-owner"), {
    "README.md": "# Other owner store\n",
    "products.json": json({ products: [], roots: [w.projects] }),
  });
  configure(w, explicit, [current, other], {});
  const active = prepare(w, other, "actor");
  const measurement = { cores: 8, load: 4, availableGB: 20 };
  const flags = ["--config", current.config, "--owner-store", explicit];
  const report = jsonOutput(w.run("self-loop.mjs", ["start", "--json", ...flags], {
    cwd: current.product, extraEnv: hostMeasurement(w, measurement),
  }));
  const direct = launch(w, current, measurement, flags);
  assert.equal(report.ownerStore, explicit);
  assert.equal(report.products, 2);
  assert.equal(report.session.error, null);
  for (const text of [direct, report.session.next]) {
    has(text, active.id);
    assertsCapacity(text, true);
  }
  const ambient = launch(w, current, measurement);
  lacks(ambient, active.id);
  assertsCapacity(ambient, true);
});
