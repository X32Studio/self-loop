// R-0008-judge, design/heartbeat-holds.md#validation
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { RELEASE_IN_WORDS } from "../lib/plan.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, ROOMY, selfLoop } from "./helpers.mjs";

const NOW = "2026-11-21T12:00:00.000Z";
function fixture() {
  const lead = loopProduct({ activity: NOW });
  const other = loopProduct({ activity: NOW });
  mkdirSync(join(other.records, "plans"));
  mkdirSync(join(other.records, "decisions"));
  writeFileSync(join(other.records, "decisions/D-0001.md"), "# D-0001 Build the packages\n");
  const section = (id, release) => [`## ${id}`, "authority: D-0001", `goal: Deliver ${id}`, `files: src/${id}/`,
    "interface: fixed contract", "needs: ", "role: actor", "acceptance: cases pass", `handoff: R-0001-actor-${id}`,
    ...(release ? ["hold: wait for approval", `release: ${release}`] : []), ""];
  writeFileSync(join(other.records, "plans/PL-0001.md"), ["# PL-0001 Dispatch", "scope: v1/work", "phase: v1", "",
    ...section("worded", "after P-0001 is recorded"), ...section("computed", "P-0099"),
    ...section("released", "P-0001"), ...section("free")].join("\n"));
  git(other.records, "add", "-A");
  git(other.records, "commit", "-qm", "plan");
  const store = ownerStore([{ name: "lead", records: lead.records }, { name: "other", records: other.records }], { bound: ROOMY });
  return { lead, other, env: isolatedEnv({ SELF_LOOP_OWNER_STORE: store }) };
}
const snapshot = p => [git(p.records, "rev-parse", "HEAD"), git(p.records, "status", "--porcelain")];
function assertFindings(report, other) {
  const screened = report.findings.filter(f => f.kind === "unchecked-release");
  assert.equal(screened.length, 1, JSON.stringify(report.findings));
  assert.equal(screened[0].product, "other");
  assert.equal(screened[0].records, other.records);
  assert.equal(screened[0].phase, "v1");
  assert.deepEqual(screened[0].packages, [{ id: "worded", plan: "PL-0001", handoff: "R-0001-actor-worded",
    hold: "wait for approval", release: "after P-0001 is recorded", review: RELEASE_IN_WORDS }]);
  assert.deepEqual(report.findings.filter(f => f.kind === "idle").flatMap(f => f.packages.map(p => p.id)), ["released", "free"]);
  assert.ok(report.findings.every(f => ["idle", "unchecked-release"].includes(f.kind)), JSON.stringify(report.findings));
}

for (const command of ["tick", "start"]) test(`${command} exposes unchecked releases for another registered product on every reconciliation without changing computed holds or idle findings`, () => {
  const { lead, other, env } = fixture();
  const before = [snapshot(lead), snapshot(other)];
  for (let read = 0; read < 2; read++) {
    const result = selfLoop([command, "--now", NOW, "--json"], { env, cwd: lead.product });
    assert.equal(result.status, command === "tick" ? 2 : 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assertFindings(report, other);
    if (command === "start") {
      assert.equal(report.session.product, "lead");
      assert.equal(report.findings.find(f => f.kind === "unchecked-release").loop, join(other.records, "loop.json"));
    }
  }
  const text = selfLoop([command, "--now", NOW], { env, cwd: lead.product });
  assert.equal(text.status, command === "tick" ? 2 : 0, text.stderr);
  const line = text.stdout.split("\n").find(l => l.startsWith("UNCHECKED RELEASE "));
  assert.ok(line, text.stdout);
  assert.match(line, /other .*worded \(PL-0001, R-0001-actor-worded\).*after P-0001 is recorded.*release in words: cannot be checked/);
  assert.doesNotMatch(line, /\b(idle|unstarted|dispatch)\b/i);
  assert.match(text.stdout, /1 registered product\(s\) quiet/);
  if (command === "start") assert.ok(text.stdout.includes(`next --config ${join(other.records, "loop.json")}`));
  assert.deepEqual([snapshot(lead), snapshot(other)], before);

  writeFileSync(join(other.records, "plans/PL-0001.md"), ["# PL-0001 Dispatch", "scope: v1/work", "phase: v1", "",
    "## worded", "authority: D-0001", "goal: Deliver worded", "files: src/worded/", "interface: fixed contract",
    "needs: ", "role: actor", "acceptance: cases pass", "handoff: R-0001-actor-worded", "hold: wait for approval", "release: P-0099", ""].join("\n"));
  git(other.records, "commit", "-qam", "make the release computable");
  const resolved = selfLoop([command, "--now", NOW, "--json"], { env, cwd: lead.product });
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(JSON.parse(resolved.stdout).findings, []);
});

for (const command of ["tick", "start"]) test(`${command} reports a worded release even with no idle or stalled packages`, () => {
  const { lead, other, env } = fixture();
  const plan = join(other.records, "plans/PL-0001.md");
  writeFileSync(plan, readFileSync(plan, "utf8").split("## computed")[0]);
  git(other.records, "commit", "-qam", "only the worded wait remains");
  const result = selfLoop([command, "--now", NOW, "--json"], { env, cwd: lead.product });
  assert.equal(result.status, command === "tick" ? 2 : 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).findings.map(f => [f.kind, f.product]), [["unchecked-release", "other"]]);
});
