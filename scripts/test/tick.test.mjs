// tick: stall and next over every registered product, unregistered records found under the registry's roots, and stall
// alarms as durable lines in each product's records (I-0001; REQUIREMENTS item 4; D-0003 item 1).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { discoverRecords } from "../lib/registry.mjs";
import { CROWDED, git, isolatedEnv, loopProduct, ownerStore, repo, ROOMY, scripts, selfLoop, temp } from "./helpers.mjs";

const NOW = "2026-11-21T12:00:00.000Z";
const hoursBefore = h => new Date(Date.parse(NOW) - h * 3600_000).toISOString();
const entry = (name, records) => ({ name, records });
const alarms = records => {
  try { return git(records, "show", "HEAD:metrics/alarms.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
const tick = (store, ...args) => selfLoop(["tick", "--json", "--now", NOW, ...args], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
const findings = result => JSON.parse(result.stdout).findings;
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("tick names only the idle product and commits its stall alarm in that product's records", () => {
  const active = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("active", active.records), entry("idle", idle.records)]);
  const activeHead = git(active.records, "rev-parse", "HEAD"), idleHead = git(idle.records, "rev-parse", "HEAD");
  const first = tick(store, "--hours", "12");
  assert.equal(first.status, 2, first.stderr);
  assert.doesNotMatch(first.stdout, /"active"/);
  const [stall] = findings(first);
  assert.equal(findings(first).length, 1, first.stdout);
  assert.equal(stall.kind, "stall");
  assert.equal(stall.product, "idle");
  assert.equal(stall.since, hoursBefore(30));
  assert.equal(stall.recorded, true);
  assert.equal(stall.onStall, "show");
  assert.equal(git(active.records, "rev-parse", "HEAD"), activeHead, "an active product's records are untouched");
  assert.equal(git(idle.records, "rev-parse", "HEAD^"), idleHead, "one commit on top of the records HEAD");
  assert.equal(git(idle.records, "status", "--porcelain"), "", "the working tree follows the commit");
  const [line] = alarms(idle.records);
  assert.equal(line.type, "stall");
  assert.equal(line.phase, "v1");
  assert.equal(line.since, hoursBefore(30));
  assert.equal(line.key, stall.alarm);
  assert.deepEqual(line.unsettled, ["F-0001"]);
  assert.equal(line.time, NOW);

  const again = tick(store, "--hours", "12");
  assert.equal(again.status, 2);
  assert.equal(findings(again)[0].recorded, false, "the same stall is one alarm");
  assert.equal(alarms(idle.records).length, 1);

  writeFileSync(join(idle.records, "metrics/blueprint.jsonl"), JSON.stringify({ feature: "F-0001", phase: "v1", status: "building",
    time: hoursBefore(30), by: "lead", note: "Work started", evidence: {} }) + "\n" + JSON.stringify({ feature: "F-0001", phase: "v1",
    status: "designing", time: hoursBefore(20), by: "lead", note: "Back to design", evidence: {} }) + "\n");
  git(idle.records, "commit", "-qam", "activity, then idle again");
  const later = tick(store, "--hours", "12");
  assert.equal(findings(later)[0].since, hoursBefore(20));
  assert.equal(alarms(idle.records).length, 2, "a new idle period is a new alarm");
  const quiet = tick(store, "--hours", "48");
  assert.equal(quiet.status, 0, quiet.stdout);
  assert.deepEqual(findings(quiet), []);
});

test("the alarm commit keeps the generated index true and the records check green", () => {
  const idle = loopProduct({ activity: hoursBefore(30) });
  const check = (...args) => spawnSync(process.execPath, [join(scripts, "records-check.mjs"), "--repo", idle.records, "--json", ...args], { encoding: "utf8" });
  assert.equal(check("--write").status, 0);
  git(idle.records, "add", "-A");
  git(idle.records, "commit", "-qm", "generated views");
  const store = ownerStore([entry("idle", idle.records)]);
  assert.equal(tick(store, "--hours", "12").status, 2);
  assert.match(git(idle.records, "show", "--stat", "HEAD"), /INDEX\.md[\s\S]*metrics\/alarms\.jsonl/);
  const result = check();
  assert.deepEqual(JSON.parse(result.stdout).failures, []);
  assert.equal(result.status, 0);
  assert.match(git(idle.records, "show", "HEAD:INDEX.md"), /metrics\/alarms\.jsonl/);
});

test("tick reports records under the roots that are unregistered or have no loop, and registered products with no loop", () => {
  const root = temp("self-loop-roots-");
  const registered = loopProduct({ activity: hoursBefore(1), dir: join(root, "registered") });
  const noLoop = loopProduct({ loopJson: false, dir: join(root, "before-loop") });
  const stray = join(root, "group", "stray-records");
  mkdirSync(stray, { recursive: true });
  repo({ "records.json": "{}\n", "README.md": "# stray\n" }, stray);
  const fixtureProduct = join(root, "some-product");
  mkdirSync(fixtureProduct);
  repo({ "test/fixtures/records.json": "{}\n", "src/x.js": "x\n" }, fixtureProduct);
  const plain = join(root, "notes");
  mkdirSync(plain);
  writeFileSync(join(plain, "records.json"), "{}\n");
  const missing = join(root, "deleted-records");
  const store = ownerStore([entry("registered", registered.records), entry("old", noLoop.records), entry("gone", missing)], { roots: [root] });
  const result = tick(store);
  assert.equal(result.status, 2, result.stderr);
  const found = findings(result).map(f => `${f.kind} ${f.product ?? f.path}`).sort();
  assert.deepEqual(found, ["missing gone", "no loop old", `no loop ${stray}`, `unregistered ${stray}`].sort(), result.stdout);
  assert.doesNotMatch(result.stdout, /"registered"/);
  const text = selfLoop(["tick", "--now", NOW], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /UNREGISTERED .*stray-records/);
  assert.match(text.stdout, /NO LOOP old/);
});

test("onStall resume without a run-lead capability reports resume unavailable and shows the stall", () => {
  const idle = loopProduct({ activity: hoursBefore(30), loop: { tick: { onStall: "resume", stallHours: 6 } } });
  const broken = loopProduct({ activity: hoursBefore(30), loop: { tick: { onStall: "page-me" } } });
  const store = ownerStore([entry("idle", idle.records), entry("broken", broken.records)]);
  const result = tick(store);
  assert.equal(result.status, 2, result.stderr);
  const byProduct = Object.fromEntries(findings(result).map(f => [f.product, f]));
  assert.equal(byProduct.idle.kind, "stall");
  assert.equal(byProduct.idle.threshold, 6, "loop.json tick.stallHours sets the product's threshold");
  assert.equal(byProduct.idle.onStall, "resume");
  assert.match(byProduct.idle.action, /resume unavailable/);
  assert.match(alarms(idle.records)[0].action, /resume unavailable/);
  assert.equal(byProduct.broken.kind, "error");
  assert.match(byProduct.broken.detail, /onStall/);
  const text = selfLoop(["tick", "--now", NOW], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
  assert.match(text.stdout, /resume unavailable/);
});

test("next shows a recorded stall alarm until activity resumes", () => {
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("idle", idle.records)]);
  assert.equal(tick(store, "--hours", "12").status, 2);
  const config = join(idle.records, "loop.json");
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const shown = selfLoop(["next", "--config", config], { env });
  assert.equal(shown.status, 0, shown.stderr);
  assert.match(shown.stdout, new RegExp(`stall alarm.*since ${hoursBefore(30).replace(/[.]/g, "\\.")}`));
  writeFileSync(join(idle.records, "metrics/blueprint.jsonl"), JSON.stringify({ feature: "F-0001", phase: "v1", status: "building",
    time: hoursBefore(30), by: "lead", note: "Work started", evidence: {} }) + "\n" + JSON.stringify({ feature: "F-0001", phase: "v1",
    status: "designing", time: hoursBefore(1), by: "lead", note: "Resumed", evidence: {} }) + "\n");
  git(idle.records, "commit", "-qam", "resumed");
  assert.doesNotMatch(selfLoop(["next", "--config", config], { env }).stdout, /stall alarm/);
});

test("three concurrent ticks lose no alarm line and write none twice", async () => {
  const one = loopProduct({ activity: hoursBefore(30) });
  const two = loopProduct({ activity: hoursBefore(40) });
  const store = ownerStore([entry("one", one.records), entry("two", two.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const runs = await Promise.all([1, 2, 3].map(() => new Promise(resolve => {
    const child = spawn(process.execPath, [join(scripts, "self-loop.mjs"), "tick", "--json", "--now", NOW, "--hours", "12"], { env });
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => resolve({ code, out, err }));
  })));
  for (const run of runs) assert.equal(run.code, 2, run.err);
  for (const records of [one.records, two.records]) {
    assert.equal(alarms(records).length, 1, records);
    assert.equal(git(records, "status", "--porcelain"), "");
  }
  const recorded = runs.flatMap(run => JSON.parse(run.out).findings).filter(f => f.recorded);
  assert.equal(recorded.length, 2, "each stall was written by exactly one run");
});

test("a copied records repository is read and written where it is registered, never where its loop.json points", () => {
  const live = loopProduct({ activity: hoursBefore(30) });
  const copy = join(temp("self-loop-copy-"), "records");
  git(live.dir, "clone", "-q", live.records, copy);
  const config = JSON.parse(git(copy, "show", "HEAD:loop.json"));
  config.records = live.records;
  writeFileSync(join(copy, "loop.json"), JSON.stringify(config));
  git(copy, "commit", "-qam", "loop.json names the original records");
  const liveHead = git(live.records, "rev-parse", "HEAD");
  const result = tick(ownerStore([entry("copy", copy)]), "--hours", "12");
  assert.equal(result.status, 2, result.stderr);
  assert.equal(findings(result)[0].records, copy);
  assert.equal(alarms(copy).length, 1);
  assert.equal(git(live.records, "rev-parse", "HEAD"), liveHead, "the original records are untouched");
});

test("an empty registry ticks quietly", () => {
  const result = tick(ownerStore([]));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { time: NOW, ownerStore: JSON.parse(result.stdout).ownerStore, products: 0, findings: [] });
});

test("discovery finds a records repository at any depth under a root and nested in a code repository, and tells test data apart", () => {
  const root = temp("self-loop-roots-");
  const deep = join(root, "clients", "acme", "team", "service", "records");
  mkdirSync(deep, { recursive: true });
  repo({ "records.json": "{}\n", "loop.json": "{}\n" }, deep);
  // An ordinary code repository: its tracked test fixtures are not repositories; a records repository of its own nested
  // in it is one.
  const code = join(root, "app");
  mkdirSync(code);
  repo({ "src/x.js": "x\n", "test/fixtures/records/records.json": "{}\n", "test/fixtures/records/loop.json": "{}\n" }, code);
  const nested = join(code, "records");
  mkdirSync(nested);
  repo({ "records.json": "{}\n" }, nested);
  const registered = loopProduct({ activity: hoursBefore(1), dir: join(root, "registered") });
  // The registered loop's own work folder holds role workspaces and their probes, never a product.
  const probe = join(registered.dir, "work", "0001-critic-abc", "out", "probe-records");
  mkdirSync(probe, { recursive: true });
  repo({ "records.json": "{}\n" }, probe);
  const hidden = join(root, ".cache", "records");
  mkdirSync(hidden, { recursive: true });
  repo({ "records.json": "{}\n" }, hidden);
  const store = ownerStore([entry("registered", registered.records)], { roots: [root] });
  const result = tick(store);
  assert.equal(result.status, 2, result.stderr);
  const found = findings(result);
  assert.deepEqual(found.filter(f => f.kind === "unregistered").map(f => f.path).sort(), [deep, nested].sort(), result.stdout);
  assert.deepEqual(found.filter(f => f.kind === "no loop").map(f => f.path), [nested]);
  assert.equal(found.length, 3, result.stdout);
});

test("a root that is itself an ordinary repository is searched, and a root that cannot be searched is reported", () => {
  const root = temp("self-loop-roots-");
  repo({ "README.md": "# projects, versioned\n" }, root);
  const stray = join(root, "stray-records");
  mkdirSync(stray);
  repo({ "records.json": "{}\n", "loop.json": "{}\n" }, stray);
  const gone = join(root, "..", `${basename(root)}-no-such-root`);
  const store = ownerStore([], { roots: [root, gone] });
  const result = tick(store);
  assert.equal(result.status, 2, result.stderr);
  const found = findings(result);
  assert.deepEqual(found.filter(f => f.kind === "unregistered").map(f => f.path), [stray], result.stdout);
  const rootError = found.find(f => f.kind === "error" && f.path === resolve(gone));
  assert.ok(rootError, `a configured root that cannot be searched is reported, not skipped:\n${result.stdout}`);
  assert.match(rootError.detail, /root/);
  assert.equal(found.length, 2, result.stdout);
});

test("a search that reaches its folder bound says so instead of missing records silently, after the shallow levels", () => {
  const root = temp("self-loop-roots-");
  for (const name of ["a", "b", "c"]) mkdirSync(join(root, name, "inner", "deeper"), { recursive: true });
  const shallow = join(root, "z-records");
  mkdirSync(shallow);
  repo({ "records.json": "{}\n" }, shallow);
  const { unregistered, problems } = discoverRecords({ products: [], roots: [root] }, { limit: 6 });
  assert.deepEqual(unregistered, [{ path: shallow, loop: false }], "the first level is read before any deeper one");
  assert.equal(problems.length, 1);
  assert.equal(problems[0].path, root);
  assert.match(problems[0].detail, /stopped after 6 folders/);
  const all = discoverRecords({ products: [], roots: [root] });
  assert.deepEqual(all, { unregistered: [{ path: shallow, loop: false }], problems: [] });
});

test("tick records a stall its records decide even when next cannot be computed, and reports next's failure", () => {
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("idle", idle.records)]);
  rmSync(idle.product, { recursive: true, force: true }); // the product checkout is gone: the integration head cannot be read
  const result = tick(store, "--hours", "12");
  assert.equal(result.status, 2, result.stderr);
  const byKind = Object.fromEntries(findings(result).map(f => [f.kind, f]));
  assert.deepEqual(Object.keys(byKind).sort(), ["error", "stall"], result.stdout);
  assert.equal(byKind.stall.recorded, true);
  assert.equal(byKind.stall.next, null);
  assert.match(byKind.error.detail, /next failed/);
  assert.equal(alarms(idle.records).length, 1, "the durable alarm does not depend on next");
  const text = selfLoop(["tick", "--now", NOW, "--hours", "12"], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) });
  assert.match(text.stdout, /STALL idle .*already recorded/);
  assert.match(text.stdout, /ERROR idle .*next failed/);
});

test("a product whose records cannot be read hides no other product from stall --all, next --all or tick", () => {
  const active = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const broken = loopProduct({ activity: hoursBefore(2) });
  writeFileSync(join(broken.records, "metrics/trajectory.jsonl"), "{ not a row\n");
  git(broken.records, "add", "-A");
  git(broken.records, "commit", "-qm", "a malformed trajectory line");
  const unborn = loopProduct({ activity: hoursBefore(2) });
  rmSync(join(unborn.records, ".git"), { recursive: true, force: true }); // loop.json is there, the records repository is not
  const store = ownerStore([entry("broken", broken.records), entry("unborn", unborn.records), entry("active", active.records), entry("idle", idle.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });

  const stall = selfLoop(["stall", "--all", "--now", NOW, "--hours", "12", "--json"], { env });
  assert.equal(stall.status, 2, stall.stderr);
  const rows = Object.fromEntries(JSON.parse(stall.stdout).map(r => [r.product, r]));
  assert.equal(rows.active.stalled, false);
  assert.equal(rows.idle.stalled, true);
  for (const name of ["broken", "unborn"]) {
    assert.equal(rows[name].stalled, null);
    assert.match(rows[name].problem, /^error: /);
  }
  assert.match(rows.broken.problem, /trajectory/);
  const text = selfLoop(["stall", "--all", "--now", NOW, "--hours", "12"], { env });
  assert.equal(text.status, 2);
  assert.match(text.stdout, /^active: Phase v1: active/m);
  assert.match(text.stdout, /^idle: Phase v1: STALL/m);
  assert.match(text.stdout, /^broken: error: /m);

  const next = selfLoop(["next", "--all"], { env });
  assert.equal(next.status, 1);
  assert.match(next.stdout, /== active[\s\S]*Phase v1/);
  assert.match(next.stdout, /== idle[\s\S]*Phase v1/);

  const ticked = tick(store, "--hours", "12");
  const kinds = findings(ticked).map(f => `${f.kind} ${f.product}`).sort();
  assert.deepEqual(kinds, ["error broken", "error unborn", "stall idle"], ticked.stdout);
  assert.equal(alarms(idle.records).length, 1);
});

test("tick --owner-store runs each stalled product's next with that store, whatever SELF_LOOP_OWNER_STORE names", () => {
  const idle = loopProduct({ activity: hoursBefore(30) });
  const crowded = ownerStore([entry("idle", idle.records)], { bound: CROWDED });
  const roomy = ownerStore([entry("idle", idle.records)], { bound: ROOMY });
  const host = text => text.split("\n").find(line => line.startsWith("  Host "));
  const flagged = selfLoop(["tick", "--now", NOW, "--owner-store", crowded], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: roomy }) });
  assert.equal(flagged.status, 2, flagged.stderr);
  assert.match(flagged.stdout, new RegExp(`owner store ${escape(crowded)}`));
  assert.match(host(flagged.stdout), new RegExp(`^  Host over the bound: .*bound from ${escape(join(crowded, "products.json"))} minAvailableMemoryGB`));
  const reversed = selfLoop(["tick", "--now", NOW, "--owner-store", roomy], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: crowded }) });
  assert.equal(reversed.status, 2, reversed.stderr);
  assert.match(host(reversed.stdout), new RegExp(`^  Host within the bound: .*bound from ${escape(join(roomy, "products.json"))} maxLoadRatio, minAvailableMemoryGB`));
});

test("A3 heartbeat: an idle package finding names each package with its plan and hand-off (flow: the heartbeat runs while the lead holds settled work unstarted; loss: stuck, nobody but the owner sees idle dispatchable work)", async () => {
  const { findingLine } = await import("../lib/tick.mjs");
  const line = findingLine({ kind: "idle", product: "p", records: "/r", phase: "v1", packages: [{ id: "alpha", plan: "PL-0001", handoff: "R-0008-actor-alpha", steps: [] }] });
  assert.equal(line, "IDLE p (/r): phase v1, 1 package(s) ready by the plan with no start and no recorded hold (A3, screening): alpha (PL-0001, R-0008-actor-alpha); start each, or record its hold and release in a revision of its plan");
});
