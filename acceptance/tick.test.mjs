import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { committedAlarms, has, jsonOutput, put, status, world } from "./fixture.mjs";
import { hours, now, product, seed, seeded, shift } from "./scenario.mjs";

const args = ["tick", "--hours", "1", "--json"];

function assertStall(finding, product, since = product.activityAt) {
  assert.ok(finding, `expected a stall for ${product.name}`);
  assert.equal(finding.kind, "stall");
  assert.equal(finding.product, product.name);
  assert.equal(finding.records, product.records);
  assert.equal(finding.phase, product.phase);
  assert.equal(Date.parse(finding.since), Date.parse(since), "the stall identifies the idle period");
}

function assertLedger(w, product, periods) {
  const rows = committedAlarms(w, product);
  assert.deepEqual(rows.map(row => [row.type, row.phase, Date.parse(row.since)]),
    periods.map(since => ["stall", product.phase, Date.parse(since)]),
    `exactly one committed alarm per idle period in ${product.name}'s records`);
  assert.equal(new Set(rows.map(row => row.key)).size, periods.length);
  return rows;
}

function assertStartShows(w, context, idle) {
  const text = status(w.run(["start"], { cwd: context.path }), 0);
  has(text, idle.name);
  has(text, idle.phase);
  assert.match(text, /\bstall alarm\b|\b(?:current|recorded) stall\b|^\s*[-*]?\s*STALL\b/im);
}

test("TICK-01 counts the active product and commits a stall only for the idle one", t => {
  const w = world(t);
  const moving = w.makeProduct(product("working-loop", 0.1));
  const idle = w.makeProduct(product("quiet-loop", 25), 2);
  w.register([idle, moving]);

  const report = jsonOutput(w.run(args), 2);
  assert.equal(report.products, 2);
  assert.equal(report.findings.length, 1);
  assertStall(report.findings[0], idle);
  has(report.findings[0].next, idle.config);
  assertLedger(w, idle, [idle.activityAt]);
  assert.equal(w.git(moving.records, "rev-parse", "HEAD"), moving.head, "active records remain quiet");

  w.register([moving], []);
  const quiet = jsonOutput(w.run(args));
  assert.equal(quiet.products, 1);
  assert.deepEqual(quiet.findings, []);
});

test("TICK-02 distinguishes no loop from unregistered across configured roots", t => {
  const w = world(t);
  const missing = w.makeProduct(product("old-self-loop"));
  const known = w.makeProduct(product("recent-example", 0.1));
  const nestedRoot = join(w.dir, "secondary");
  const unregistered = join(nestedRoot, "team", "forgotten-records");
  const excluded = join(w.dir, "secondary-archive", "excluded-records");
  for (const dir of [unregistered, excluded]) w.repo(dir, { "records.json": "{}\n", "README.md": "# Records\n" });
  w.register([known, missing], [w.projects, nestedRoot]);

  const report = jsonOutput(w.run(args), 2);
  assert.equal(report.products, 2);
  assert.ok(report.findings.some(f => f.kind === "no loop" && f.product === missing.name && f.records === missing.records));
  assert.ok(report.findings.some(f => f.kind === "unregistered" && f.path === unregistered));
  assert.ok(!report.findings.some(f => f.path === excluded || f.product === known.name), JSON.stringify(report.findings));
  assert.equal(w.git(known.records, "rev-parse", "HEAD"), known.head, "recent records remain quiet");
});

test("TICK-03 show is the default and start reads the durable alarm in a fresh command", t => {
  const w = world(t);
  const asking = w.makeProduct(product("lead-context", 0.1));
  const idle = w.makeProduct(product("background-loop", 22), 2);
  w.register([asking, idle]);
  const { findings } = jsonOutput(w.run(args), 2);
  assert.equal(findings.length, 1);
  const [stall] = findings;
  assertStall(stall, idle);
  assert.equal(stall.onStall, "show");
  assert.doesNotMatch(stall.action, /resume unavailable|resum(?:ed|ing) lead/i);
  const [alarm] = assertLedger(w, idle, [idle.activityAt]);
  assert.equal(stall.alarm, alarm.key);
  const head = w.git(idle.records, "rev-parse", "HEAD");

  assertStartShows(w, asking, idle);
  assert.equal(w.git(idle.records, "rev-parse", "HEAD"), head, "start must be read-only");
});

test("TICK-04 resume without run-lead remains visible from a fresh start in another product", t => {
  const w = world(t);
  const idle = w.makeProduct(product("unattended", 21, { onStall: "resume" }));
  const asking = w.makeProduct(product("lead-context", 0.2), 2);
  w.register([idle, asking]);
  const { findings } = jsonOutput(w.run(args), 2);
  assert.equal(findings.length, 1);
  const [stall] = findings;
  assertStall(stall, idle);
  assert.equal(stall.onStall, "resume");
  assert.match(stall.action, /resume unavailable/i);
  const [alarm] = assertLedger(w, idle, [idle.activityAt]);
  assert.equal(stall.alarm, alarm.key);
  assert.match(alarm.action, /resume unavailable/i);
  const head = w.git(idle.records, "rev-parse", "HEAD");

  assertStartShows(w, asking, idle);
  assert.equal(w.git(idle.records, "rev-parse", "HEAD"), head);
});

test("TICK-05 concurrent ticks record each product's distinct idle periods once and keep staged work", async t => {
  const w = world(t);
  const idle = w.makeProduct(product("synchronized", 48, { phase: "shared-phase" }));
  const peer = w.makeProduct(product("parallel", 48, { phase: idle.phase }), 2);
  w.register([peer, idle]);
  put(idle.records, "README.md", "# Staged lead edit\n");
  w.git(idle.records, "add", "README.md");
  const staged = w.git(idle.records, "diff", "--cached", "--", "README.md");
  assert.ok(staged, "the fixture starts with a staged edit");

  const jitter = seeded(seed);
  const times = Array.from({ length: 3 }, (_, i) => shift(now, (i * 5 + jitter(4)) * 1_000));
  const ticks = await Promise.all(times.map(at => w.runAsync([...args, "--now", at])));
  for (const tick of ticks) {
    const { findings } = jsonOutput(tick, 2);
    assert.equal(findings.length, 2);
    for (const item of [idle, peer]) assertStall(findings.find(f => f.product === item.name), item);
  }
  const [earlier] = assertLedger(w, peer, [peer.activityAt]);
  assertLedger(w, idle, [idle.activityAt]);

  const resumedAt = shift(now, hours(1));
  const event = status(w.run([
    "set", "--records", peer.records, "--feature", peer.feature, "--status", "designing",
    "--by", "lead", "--note", "Design resumed after the alarm",
  ], { entry: "blueprint.mjs", at: resumedAt }), 0);
  assert.equal(JSON.parse(event).time, resumedAt);
  w.commit(peer.records, "Record resumed design work", resumedAt);
  const recent = jsonOutput(w.run([...args, "--now", resumedAt]), 2);
  assert.equal(recent.findings.length, 1);
  assertStall(recent.findings[0], idle);

  const later = shift(resumedAt, hours(2));
  const { findings } = jsonOutput(w.run([...args, "--now", later]), 2);
  assert.equal(findings.length, 2);
  assertStall(findings.find(f => f.product === peer.name), peer, resumedAt);
  const [original] = assertLedger(w, peer, [peer.activityAt, resumedAt]);
  assert.deepEqual(original, earlier, "the previous period's alarm remains intact");
  assertLedger(w, idle, [idle.activityAt]);

  const heads = [idle, peer].map(item => w.git(item.records, "rev-parse", "HEAD"));
  const retry = jsonOutput(w.run([...args, "--now", shift(later, 60_000)]), 2);
  assert.equal(retry.findings.length, 2);
  assert.deepEqual([idle, peer].map(item => w.git(item.records, "rev-parse", "HEAD")), heads, "retry commits neither alarm again");
  assert.equal(w.git(idle.records, "diff", "--cached", "--", "README.md"), staged);
  assert.equal(w.git(idle.records, "diff", "--name-only", idle.head + "..HEAD", "--", "README.md"), "");
});
