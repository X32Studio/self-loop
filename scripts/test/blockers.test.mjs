// R-0008-judge-frame, D-0064, D-0067, design/round9-b.md#one-ruling-one-transition
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repo, scripts } from "./helpers.mjs";
import { admit, blockerState, isRuling, readRuling, transition } from "../lib/blockers.mjs";
import { blockerState as driver } from "../loop.mjs";
import { alarms } from "../trajectory.mjs";
const row = (round, fields = {}) => ({ round, phase: "v1", area: "core", role: "judge", verdict: "CONTINUE", ...fields });
const ruling = (name, fields) => readRuling(name, `# Judge\nphase: v1\n\n## Public report\n${fields}\n`);
test("flow: phase resume closes a carried blocker; loss: false-verdict; writer, driver and alarms share terminal precedence", () => {
  for (const terminal of ["closed", "shelved"]) {
    const before = row(1, { opened: "bug:1" });
    const next = row(2, { carried: "bug:1", [terminal]: "bug:1" });
    assert.equal(transition(blockerState([before]), next).get("bug:1").status, terminal);
    assert.deepEqual(driver([before, next]).open, []);
    assert.deepEqual(alarms([before, next]).filter(a => a.type === "partly-closed"), []);
  }
  assert.deepEqual(driver([row(1, { carried: "bug:1" })]).open, ["bug:1 (R-0001)"]);
});
test("flow: multiple structured rulings close one round; loss: wrong-result; latest ruling supplies one complete disposition", () => {
  const first = ruling("first", "OPENED: bug:old\nCLOSED: -");
  const second = ruling("second", "OPENED: bug:new\nCLOSED: bug:old");
  const result = admit(row(2), [first, second], {});
  assert.equal(result.refusal, null);
  assert.deepEqual(result.fields.opened, ["bug:new"]);
  assert.deepEqual(result.fields.closed, ["bug:old"]);
  assert.deepEqual(result.sources, ["second"]);
});
test("flow: historical heading flags and typed prefixes; loss: wrong-result; complete identifiers stay distinct", () => {
  const historical = ruling("old", "### bug:R7-2.long\nflow: resume\nloss: wrong-result");
  assert.equal(admit(row(7), [historical], { opened: ["bug:R7-2.long"] }).refusal, null);
  assert.match(admit(row(7), [historical], { opened: ["bug:R7-2"] }).refusal, /not named/);
});
test("flow: documented punctuation in historical keys; loss: stuck; flags preserve the existing identifier domain", () => {
  const record = ruling("old", "### suite/cache:R7+2\nflow: resume\nloss: stuck");
  assert.equal(admit(row(7), [record], { opened: ["suite/cache:R7+2"] }).refusal, null);
  assert.match(admit(row(7), [record], { opened: ["suite/cache:R7"] }).refusal, /not named/);
});
test("flow: a close command is retried; loss: false-verdict; replay does not invent a second review", () => {
  const first = row(1, { opened: "a:1" });
  assert.deepEqual(alarms([first, { ...first, time: "later" }]).filter(a => a.type === "partly-closed"), []);
  assert.deepEqual(driver([first, first]), driver([first]));
});
test("flow: append a structured carried-and-closed ruling, then resume; loss: false-verdict; all projections consume the derived row", () => {
  const commit = "a".repeat(40);
  const records = repo({ "metrics/.keep": "", "rounds/0001-judge.md": `# Judge\nphase: v1\nproduct: ${commit}\n\n## Public report\nOPENED: -\nCARRIED: bug:1\nCLOSED: bug:1\nSHELVED: -\n` });
  const ledger = join(records, "metrics/trajectory.jsonl");
  const result = spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append", "--file", ledger, "--round", "1", "--phase", "v1", "--role", "judge", "--verdict", "CONTINUE", "--commit", commit], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const written = JSON.parse(readFileSync(ledger, "utf8"));
  assert.equal(written.carried, "bug:1");
  assert.equal(written.closed, "bug:1");
  assert.deepEqual(driver([written]).open, []);
  assert.deepEqual(alarms([written]).filter(a => a.type === "partly-closed"), []);
});
// D-0024, R-0008-judge-frame
test("carried blockers remain open without counting as new partial-closure openings", () => {
  const carried = row(1, { carried: "delivery:inherited" });
  const later = row(2);
  assert.deepEqual(driver([carried, later]).open, ["delivery:inherited (R-0001)"]);
  assert.deepEqual(alarms([carried, later]).filter(a => a.type === "partly-closed"), []);
  const opened = row(1, { opened: "delivery:new", carried: "delivery:inherited" });
  assert.deepEqual(driver([opened, later]).open, ["delivery:new (R-0001)", "delivery:inherited (R-0001)"]);
  assert.deepEqual(alarms([opened, later]).filter(a => a.type === "partly-closed").map(a => a.evidence.stillOpen), [["delivery:new"]]);
  const closed = row(2, { closed: "delivery:new,delivery:inherited" });
  assert.deepEqual(driver([opened, closed]).open, []);
  assert.deepEqual(alarms([opened, closed]).filter(a => a.type === "partly-closed"), []);
});

test("D-0064 T10: isRuling and blockerState track OPENED/CLOSED/SHELVED/CARRIED transitions on role critic rows", () => {
  const criticOpen = { round: 2, phase: "v1", area: "core", role: "critic", verdict: "CONTINUE", opened: "scope:c1", carried: "scope:c0" };
  const criticNoVerdict = { round: 2, phase: "v1", area: "core", role: "critic", verdict: "-", opened: "scope:ignored" };
  const criticClose = { round: 3, phase: "v1", area: "core", role: "critic", verdict: "PASS", closed: "scope:c1", shelved: "scope:c0" };
  assert.equal(isRuling(criticOpen), true);
  assert.equal(isRuling(criticClose), true);
  assert.equal(isRuling(criticNoVerdict), false);

  const st1 = blockerState([criticNoVerdict, criticOpen], { phase: "v1" });
  assert.equal(st1.get("scope:c1")?.status, "open");
  assert.equal(st1.get("scope:c0")?.status, "open");
  assert.equal(st1.has("scope:ignored"), false);
  assert.deepEqual(driver([criticNoVerdict, criticOpen]).open, ["scope:c1 (R-0002)", "scope:c0 (R-0002)"]);

  const st2 = blockerState([criticOpen, criticClose], { phase: "v1" });
  assert.equal(st2.get("scope:c1")?.status, "closed");
  assert.equal(st2.get("scope:c0")?.status, "shelved");
  assert.deepEqual(driver([criticOpen, criticClose]).open, []);
});
