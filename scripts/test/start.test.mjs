// start: the one entry point a fresh session of any harness reads first (design §6.2, F-0003). Whatever registered
// product the session runs in, it shows every registered product's committed stall alarm that is still live (the
// alarm's key is the phase and the last recorded activity, the identity `tick` and `next` use), with the action `tick`
// took (`show`, or `resume unavailable`), and it writes nothing (R-0001-judge R1-1).
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { CROWDED, git, isolatedEnv, loopProduct, ownerStore, ROOMY, selfLoop, temp } from "./helpers.mjs";

const NOW = "2026-11-21T12:00:00.000Z";
const hoursBefore = h => new Date(Date.parse(NOW) - h * 3600_000).toISOString();
const entry = (name, records) => ({ name, records });
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The records HEAD and the working tree of each product: what a reader must leave as it was. */
const snapshot = (...products) => products.map(p => `${git(p.records, "rev-parse", "HEAD")} ${git(p.records, "status", "--porcelain")}`);
const ledger = records => {
  try { return git(records, "show", "HEAD:metrics/alarms.jsonl").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
};
/** Record new phase activity: one more blueprint event at `time`. */
function activity(p, time) {
  const file = join(p.records, "metrics/blueprint.jsonl");
  writeFileSync(file, readFileSync(file, "utf8") + JSON.stringify({ feature: "F-0001", phase: "v1", status: "designing", time, by: "lead",
    note: "Resumed", evidence: {} }) + "\n");
  git(p.records, "commit", "-qam", "activity");
}

test("start from any registered product shows every product's live committed stall alarm, with show and resume unavailable, and writes nothing", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const unattended = loopProduct({ activity: hoursBefore(40), loop: { tick: { onStall: "resume" } } });
  const store = ownerStore([entry("lead", lead.records), entry("idle", idle.records), entry("unattended", unattended.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW], { env }).status, 2);
  assert.equal(ledger(idle.records).length, 1);
  const before = snapshot(lead, idle, unattended);

  for (const cwd of [lead.product, join(lead.records, "blueprint"), idle.product]) {
    const start = selfLoop(["start", "--now", NOW], { cwd, env });
    assert.equal(start.status, 0, `${cwd}: ${start.stderr}`);
    assert.match(start.stdout, new RegExp(`STALL idle \\(${escape(idle.records)}\\).*since ${escape(hoursBefore(30))}.*alarm raised ${escape(NOW)}.*onStall show`));
    assert.match(start.stdout, new RegExp(`STALL unattended \\(${escape(unattended.records)}\\).*onStall resume: resume unavailable`));
    assert.doesNotMatch(start.stdout, /STALL lead/);
    assert.match(start.stdout, /1 registered product\(s\) quiet/);
  }
  const fromLead = selfLoop(["start", "--now", NOW], { cwd: lead.product, env }).stdout;
  assert.match(fromLead, new RegExp(`This session: lead · ${escape(lead.records)}`));
  assert.match(fromLead, /Phase v1 · loop\/v1 at [0-9a-f]{40}/, "the session's own next steps follow");
  assert.deepEqual(snapshot(lead, idle, unattended), before, "start commits nothing, appends no alarm and leaves every working tree as it was");

  const json = selfLoop(["start", "--now", NOW, "--json"], { cwd: lead.product, env });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  const stalls = Object.fromEntries(report.findings.filter(f => f.kind === "stall").map(f => [f.product, f]));
  assert.deepEqual(Object.keys(stalls).sort(), ["idle", "unattended"]);
  assert.equal(stalls.idle.raised, NOW);
  assert.equal(stalls.idle.alarm, ledger(idle.records)[0].key, "the alarm shown is the committed one, by its key");
  assert.match(stalls.unattended.action, /resume unavailable/);
  assert.equal(report.session.product, "lead");
  assert.deepEqual(snapshot(lead, idle, unattended), before);
});

test("start shows a committed alarm while its idle period lasts, whatever threshold raised it, and drops it when activity resumes", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const short = loopProduct({ activity: hoursBefore(3) });
  const store = ownerStore([entry("lead", lead.records), entry("short", short.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW, "--hours", "2"], { env }).status, 2);
  assert.equal(ledger(short.records).length, 1);
  // The default threshold (12 h) would not call 3 h a stall; the committed alarm of this idle period is still live.
  const live = selfLoop(["start", "--now", NOW], { cwd: lead.product, env });
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, new RegExp(`STALL short .*since ${escape(hoursBefore(3))}.*alarm raised ${escape(NOW)}`));
  activity(short, hoursBefore(0.5));
  const resumed = selfLoop(["start", "--now", NOW], { cwd: lead.product, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.doesNotMatch(resumed.stdout, /STALL short/, "an alarm of an idle period that ended is not live");
  assert.match(resumed.stdout, /2 registered product\(s\) quiet/);
});

test("start shows a stall no tick has recorded, says so, and still records nothing", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("lead", lead.records), entry("idle", idle.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const before = snapshot(lead, idle);
  const start = selfLoop(["start", "--now", NOW], { cwd: lead.product, env });
  assert.equal(start.status, 0, start.stderr);
  assert.match(start.stdout, /STALL idle .*no alarm recorded/);
  assert.match(start.stdout, /heartbeat/);
  assert.deepEqual(snapshot(lead, idle), before);
  assert.deepEqual(ledger(idle.records), []);
});

test("start outside every registered product, or with no registry, shows what it can and exits 0", () => {
  const idle = loopProduct({ activity: hoursBefore(30) });
  const old = loopProduct({ loopJson: false });
  const store = ownerStore([entry("idle", idle.records), entry("old", old.records), entry("gone", join(temp(), "deleted"))]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW], { env }).status, 2);
  const outside = selfLoop(["start", "--now", NOW], { cwd: temp(), env });
  assert.equal(outside.status, 0, outside.stderr);
  assert.match(outside.stdout, /STALL idle .*alarm raised/);
  assert.match(outside.stdout, /NO LOOP old/);
  assert.match(outside.stdout, /MISSING gone/);
  assert.match(outside.stdout, /no registered product contains/);

  const noStore = isolatedEnv({ SELF_LOOP_OWNER_STORE: join(temp(), "nowhere") });
  const alone = selfLoop(["start", "--now", NOW, "--config", join(idle.records, "loop.json")], { cwd: temp(), env: noStore });
  assert.equal(alone.status, 0, alone.stderr);
  assert.match(alone.stdout, /no product registry/);
  assert.match(alone.stdout, /Phase v1 · loop\/v1/);
  assert.match(alone.stdout, /stall alarm raised/, "the configured product's own next shows its alarm");

  assert.equal(selfLoop(["start", "--now", "yesterday"], { env }).status, 64);
});

test("start keeps a product's live alarm visible when its next steps cannot be computed", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const idle = loopProduct({ activity: hoursBefore(30) });
  const store = ownerStore([entry("lead", lead.records), entry("idle", idle.records)]);
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  assert.equal(selfLoop(["tick", "--now", NOW], { env }).status, 2);
  rmSync(idle.product, { recursive: true, force: true });
  for (const cwd of [lead.product, idle.records]) {
    const start = selfLoop(["start", "--now", NOW], { cwd, env });
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /STALL idle .*alarm raised/);
  }
  const own = selfLoop(["start", "--now", NOW], { cwd: idle.records, env });
  assert.match(own.stdout, /This session: idle[\s\S]*next failed: /);
});

test("start --owner-store runs the session's next with that store, whatever SELF_LOOP_OWNER_STORE names", () => {
  const lead = loopProduct({ activity: hoursBefore(1) });
  const crowded = ownerStore([entry("lead", lead.records)], { bound: CROWDED });
  const roomy = ownerStore([entry("lead", lead.records)], { bound: ROOMY });
  const host = line => line.split("\n").find(l => l.startsWith("Host "));
  const flagged = selfLoop(["start", "--now", NOW, "--owner-store", crowded], { cwd: lead.product, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: roomy }) });
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.match(flagged.stdout, new RegExp(`owner store ${escape(crowded)}`));
  assert.match(host(flagged.stdout), new RegExp(`^Host over the bound: .*bound from ${escape(join(crowded, "products.json"))} minAvailableMemoryGB`));
  const reversed = selfLoop(["start", "--now", NOW, "--owner-store", roomy], { cwd: lead.product, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: crowded }) });
  assert.match(host(reversed.stdout), new RegExp(`^Host within the bound: .*bound from ${escape(join(roomy, "products.json"))} maxLoadRatio, minAvailableMemoryGB`));
});
