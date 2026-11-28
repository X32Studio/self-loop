import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { json, jsonOutput, output } from "./fixture.mjs";
import { handoffs } from "./loop-world-fixture.mjs";
import { at, dispatchPkg, dispatchWorld, mechanisms, pkg, refusal, shuffled } from "./plan-world-fixture.mjs";
import { now, shift } from "./scenario.mjs";

const actorFiles = {
  a: ["scripts/owner-words.mjs", "scripts/lib/owner-words.mjs", "scripts/lib/owner-metrics.mjs", "scripts/records-check.mjs"],
  b: ["scripts/decisions.mjs"],
  c: ["scripts/loop.mjs", "scripts/lib/cadence.mjs"],
  d: ["scripts/plan.mjs", "scripts/lib/plan.mjs", "SKILL.md", "RECORDS.md"],
};
const directions = { a: "D-0030", b: "D-0031", c: "D-0032", d: "R-0008-judge-frame-dispatch" };
const room = { cores: 20, load: 0.25, availableGB: 32 };
const wavePaths = {
  "actor-a": ["scripts/lib/ci.mjs", "scripts/lib/check-runs.mjs", "scripts/lib/ci-receipt.mjs",
    "scripts/suite-green.mjs", "scripts/version-gate.mjs", "scripts/gated-push.mjs", "scripts/ci-green.mjs",
    "scripts/lib/version.mjs", ".githooks/*"],
  "actor-b": ["scripts/lib/comments.mjs", "scripts/loop.mjs", "scripts/self-loop.mjs", "scripts/call.mjs",
    "scripts/lib/registry.mjs", "scripts/lib/thresholds.mjs", "scripts/lib/start.mjs"],
  "actor-c": ["scripts/trajectory.mjs", "RECORDS.md", "assets/brief-judge.md", "DEBT.md"],
  "critic-a": ["acceptance/version-release-gate.test.mjs"],
  "critic-b": ["acceptance/comment-directives.test.mjs"],
  "critic-c": ["acceptance/trajectory-and-blockers.test.mjs"],
};
const launchClocks = {
  "actor-a": 0, "critic-b": 2_200, "critic-c": 10_400,
  "actor-c": 20_400, "critic-a": 20_800, "actor-b": 23_100,
};

function states(rows, expected) {
  assert.deepEqual(Object.fromEntries([...rows].map(([key, row]) => [key, row.status ?? row.state])), expected);
}

function waits(row, dependency) {
  assert.match(json(row), dependency);
  const hold = row.waiting ?? row.hold ?? row.holds ?? row.reason ?? row.waitsFor;
  const release = row.release ?? row.releases ?? row.releasedBy ?? row.unblocksWhen ?? row.until;
  assert.ok(hold || release, json(row));
  assert.ok(release || /release|unblock|until|when|after/i.test(json(hold)), json(row));
  assert.ok(!(row.command ?? row.prepare), json(row));
}

function tree(root) {
  const entries = {};
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isSymbolicLink()) entries[key] = "link " + readlinkSync(path);
      else if (entry.isDirectory()) {
        entries[key] = "dir";
        walk(path);
      } else entries[key] = "file " + createHash("sha256").update(readFileSync(path)).digest("hex");
    }
  };
  if (existsSync(root)) walk(root);
  return entries;
}

function untouched(x) {
  return {
    work: tree(x.p.workDir),
    head: x.w.git(x.p.records, "rev-parse", "HEAD"),
    status: x.w.git(x.p.records, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"),
    worktrees: x.w.git(x.p.product, "worktree", "list", "--porcelain"),
  };
}

function startable(rows) {
  return Object.fromEntries([...rows].map(([id, row]) => [id, row.command ? "command" : row.status]));
}

test("R8-D2-01 ordered · flow: lead runs the normal prepare commands for a round-seven six-call wave under measured headroom · loss: false-verdict", t => {
  const x = dispatchWorld(t);
  const wave = shuffled(Object.keys(launchClocks).map(id => dispatchPkg(id, {
    round: 8, authority: "D-0028",
    files: wavePaths[id],
  })), 702);
  x.plan(wave, { round: 8 });
  const before = untouched(x);
  const ready = x.ready();
  states(ready, Object.fromEntries(wave.map(p => [p.id, "ready"])));
  assert.deepEqual(untouched(x), before, "ready started preparing calls itself");
  for (const item of wave) {
    x.prepare(item, { row: ready.get(item.id), at: shift(now, launchClocks[item.id]) });
  }
  states(x.ready({ at: shift(now, 30_000) }), Object.fromEntries(wave.map(p => [p.id, "running"])));
});

test("R8-D2-02 ordered · flow: lead checks dispatch across the load and memory boundary while the same package remains authorized · loss: false-verdict", t => {
  const x = dispatchWorld(t);
  const actor = dispatchPkg("actor-d", { authority: directions.d, files: actorFiles.d });
  x.plan([actor]);
  for (const [host, evidence] of [
    [{ ...room, load: 14.01 }, /load|capacity/i],
    [{ ...room, load: 14, availableGB: 15.75 }, /memory|capacity/i],
  ]) {
    const rows = x.ready({ host });
    states(rows, { "actor-d": "waiting" });
    waits(rows.get(actor.id), evidence);
  }
  states(x.ready({ host: { ...room, load: 14, availableGB: 16 } }), { "actor-d": "ready" });
});

test("R8-D2-03 ordered · flow: lead reconciles settled round-eight actors, a pending frame ruling, and deferred hardening · loss: false-verdict", t => {
  const x = dispatchWorld(t);
  const judge = dispatchPkg("judge-frame");
  const hardeningReview = dispatchPkg("judge-hardening", { needs: [judge.id] });
  const hardening = dispatchPkg("critic-hardening", { files: ["acceptance/round-close.test.mjs"], needs: [hardeningReview.id] });
  const actors = Object.keys(actorFiles).map(key => dispatchPkg(`actor-${key}`, { authority: directions[key], files: actorFiles[key] }));
  const critic = dispatchPkg("critic-d", { authority: directions.d, files: ["acceptance/dispatch-lifecycle.test.mjs"], feature: "F-0012" });
  const newInterface = dispatchPkg("actor-derived", { files: ["scripts/facts.mjs"], needs: [judge.id] });
  x.plan(shuffled([...actors, judge, hardeningReview, critic, newInterface, hardening], 8));
  const base = Object.fromEntries([...actors, critic].map(p => [p.id, "ready"]));
  const before = x.ready();
  states(before, { ...base, [judge.id]: "ready", [hardeningReview.id]: "waiting",
    [hardening.id]: "waiting", [newInterface.id]: "waiting" });
  waits(before.get(newInterface.id), /judge-frame/i);
  waits(before.get(hardening.id), /judge-hardening/i);
  const prepared = x.prepare(judge, { row: before.get(judge.id) });
  states(x.ready(), { ...base, [judge.id]: "running", [hardeningReview.id]: "waiting",
    [hardening.id]: "waiting", [newInterface.id]: "waiting" });
  jsonOutput(x.record(judge, prepared, { publicReport: "VERDICT: AMEND\n\nAdmit the derived interface. Round-close hardening remains deferred.\n" }));
  states(x.ready(), { ...base, [judge.id]: "done", [hardeningReview.id]: "ready",
    [hardening.id]: "waiting", [newInterface.id]: "ready" });
});

test("R8-D2-04 fresh · flow: lead restarts after a live preparation and a failed child, then records a successful retry · loss: stuck", t => {
  const x = dispatchWorld(t);
  const actor = dispatchPkg("actor-a", { files: actorFiles.a });
  const judge = dispatchPkg("judge-integration", { needs: [actor.id] });
  x.plan([actor, judge]);
  const initial = x.ready();
  const first = x.prepare(actor, { row: initial.get(actor.id) });
  const active = { [actor.id]: "running", [judge.id]: "waiting" };
  states(x.ready(), active);
  refusal(x.record(actor, first, { terminal: "pending" }), /no terminal event/i);
  states(x.ready(), active);
  const lost = x.record(actor, first, { terminal: "failed" });
  refusal(lost, /exited|failed/i);
  assert.ok(!x.w.git(x.p.records, "show", `HEAD:${handoffs}`).includes(actor.handoff), "a failed attempt became a completed hand-off");
  const retry = x.ready();
  states(retry, { [actor.id]: "ready", [judge.id]: "waiting" });
  const second = x.prepare(actor, { row: retry.get(actor.id) });
  assert.notEqual(first.ws, second.ws);
  jsonOutput(x.record(actor, second));
  states(x.ready(), { [actor.id]: "done", [judge.id]: "ready" });
});

test("R8-D2-05 ordered · flow: lead revises the derived interface after recording two independent actors · loss: wrong-result", t => {
  const x = dispatchWorld(t);
  const actor = dispatchPkg("actor-a", { files: actorFiles.a });
  const peer = dispatchPkg("actor-b", { authority: directions.b, files: actorFiles.b });
  const judge = dispatchPkg("judge-integration", { needs: [actor.id, peer.id] });
  x.plan([actor, peer, judge]);
  for (const item of [actor, peer]) jsonOutput(x.record(item, x.prepare(item)));
  states(x.ready(), { [actor.id]: "done", [peer.id]: "done", [judge.id]: "ready" });
  const redo = dispatchPkg(actor.id, { files: actor.files, step: "actor-aa", goal: "Rebuild the count",
    contract: "Count accepted directions rather than all captured messages" });
  x.plan([redo, peer, judge], { id: "PL-0002", supersedes: "PL-0001" });
  const revised = x.ready({ id: "PL-0002" });
  states(revised, { [actor.id]: "ready", [peer.id]: "done", [judge.id]: "waiting" });
  const prepared = x.prepare(redo, { row: revised.get(actor.id) });
  assert.match(readFileSync(join(prepared.ws, "task.md"), "utf8"), /Count accepted directions/);
  jsonOutput(x.record(redo, prepared));
  states(x.ready({ id: "PL-0002" }), { [actor.id]: "done", [peer.id]: "done", [judge.id]: "ready" });
});

test("R8-D2-06 fresh · flow: a lead receives an owner answer while requesting dispatch before and after committing it · loss: false-verdict", t => {
  const x = dispatchWorld(t);
  const batch = x.sendBatch(shift(now, -10_000));
  const review = dispatchPkg("actor-b", { authority: directions.b, files: actorFiles.b, needs: [batch] });
  const independent = dispatchPkg("actor-c", { authority: directions.c, files: actorFiles.c });
  x.plan([review, independent]);
  x.answer(shift(now, 1_000));
  x.w.git(x.p.records, "add", "owner/answers.jsonl");
  const before = x.ready({ at: shift(now, 2_000) });
  states(before, { [review.id]: "waiting", [independent.id]: "ready" });
  waits(before.get(review.id), /B-0001/);
  x.checkAndCommit("Record the delivered owner answer", shift(now, 3_000));
  states(x.ready({ at: shift(now, 4_000) }), { [review.id]: "ready", [independent.id]: "ready" });
});

test("R8-D2-07 fresh · flow: a lead replans a file already owned by an in-flight actor while unrelated work can start · loss: wrong-result", t => {
  const x = dispatchWorld(t);
  const old = dispatchPkg("actor-d", { authority: directions.d, files: actorFiles.d });
  const independent = dispatchPkg("actor-c", { authority: directions.c, files: actorFiles.c });
  x.plan([old, independent]);
  const active = x.prepare(old, { row: x.ready().get(old.id) });
  const next = dispatchPkg(old.id, { authority: directions.d, step: "actor-dd", files: old.files, contract: "Keep a revision's plan records immutable" });
  x.plan([next, independent], { id: "PL-0002", supersedes: "PL-0001" });
  const held = x.ready({ id: "PL-0002" });
  states(held, { [next.id]: "waiting", [independent.id]: "ready" });
  waits(held.get(next.id), /actor-d|plan\.mjs/);
  jsonOutput(x.record(old, active));
  states(x.ready({ id: "PL-0002" }), { [next.id]: "ready", [independent.id]: "ready" });
});

test("R8-A5-04 ordered · flow: lead prepares, revises the plan around a live attempt, loses the attempt, retries and records it, bound 3 packages x 4 events · loss: wrong-result", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha", { round: 8 }), bravo = pkg("bravo", { round: 8 }), charlie = pkg("charlie", { round: 8 });
  f.plan("PL-0001", [alpha, bravo], { when: at(10), scope: "v1/round-8" });
  assert.deepEqual(startable(f.ready("PL-0001", { when: at(20) })), { alpha: "command", bravo: "command" });
  const first = f.prepare(alpha, at(30));
  assert.deepEqual(startable(f.ready("PL-0001", { when: at(40) })), { alpha: "running", bravo: "command" });
  f.plan("PL-0002", [alpha, bravo, charlie], { supersedes: "PL-0001", when: at(50), scope: "v1/round-8" });
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(60) })), { alpha: "running", bravo: "command", charlie: "command" });
  const lost = f.record(alpha, first, { start: at(70), when: at(80), terminal: "failed" });
  assert.ok(lost.status > 0, output(lost));
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(90) })), { alpha: "command", bravo: "command", charlie: "command" });
  const second = f.prepare(alpha, at(100));
  assert.notEqual(second.ws, first.ws);
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(110) })), { alpha: "running", bravo: "command", charlie: "command" });
  jsonOutput(f.record(alpha, second, { start: at(120), when: at(130) }));
  assert.deepEqual(startable(f.ready("PL-0002", { when: at(140) })), { alpha: "done", bravo: "command", charlie: "command" });
});
