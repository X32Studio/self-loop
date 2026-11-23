import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { has, json, jsonOutput, put, status } from "./fixture.mjs";
import { argsFor, batchDraw, phase, prepare, record, round6B } from "./round6-b-fixture.mjs";
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
  const w = round6B(t);
  const left = phase(w, "left");
  const right = phase(w, "right", { agents: { actor: { runner: "codex" } } });
  w.register(batchDraw()(2) ? [left, right] : [right, left]);
  const prepared = prepare(w, left, "critic", { round: 3 });
  const finish = await startCli(w, right, "actor", "codex");
  try {
    const repo = w.repo(join(w.outside, "unregistered-suite"), { "VERSION": "1.0.0\n" });
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
  const w = round6B(t);
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
  const w = round6B(t);
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
