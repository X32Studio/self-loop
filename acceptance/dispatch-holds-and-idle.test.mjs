import assert from "node:assert/strict";
import test from "node:test";
import { json, jsonOutput, put } from "./fixture.mjs";
import { at, crowded, idleInNext, itemsOf, judgeRow, mechanisms, mentions, offered, pkg, shuffled } from "./plan-world-fixture.mjs";

const WORDED = /in words|cannot be checked|unchecked|not computable|uncomputable|awaiting review|not checkable|cannot be computed/i;
const letters = (n, width) => Array.from({ length: width }, (_, i) => String.fromCharCode(97 + Math.floor(n / 26 ** (width - 1 - i)) % 26)).join("");

function idleInTick(report, p, ids) {
  const findings = report.findings.filter(f => f.product === p.name || f.records === p.records);
  assert.ok(!findings.some(f => f.kind === "error"), json(report));
  return mentions(JSON.stringify(findings.filter(f => f.kind === "idle")), ids).sort();
}

function flagged(f, ids, expected, options = {}) {
  const want = [...expected].sort();
  const text = f.next(options);
  assert.deepEqual(idleInNext(text, ids), want, text);
  const { code, report } = f.tick(options);
  assert.deepEqual(idleInTick(report, f.p, ids), want, json(report));
  if (want.length) assert.equal(code, 2, json(report));
  return text;
}

function ownerDecidedBehindFrame(f) {
  f.rows(judgeRow(2, { time: at(10), area: "frame" }));
  f.publish("Rule round 2", at(12));
  const frame = pkg("frame", { role: "judge", round: 8, authority: "D-0030", step: "judge-frame" });
  const alpha = pkg("alpha", { round: 8, authority: "D-0031" });
  const bravo = pkg("bravo", { role: "critic", round: 8, authority: "D-0031", files: ["acceptance/bravo/**"] });
  const charlie = pkg("charlie", { round: 8, authority: "D-0030", needs: ["frame"] });
  f.plan("PL-0001", [frame, alpha, bravo, charlie], { scope: "v1/round-8" });
  f.prepare(frame, at(30));
  return ["frame", "alpha", "bravo", "charlie"];
}

function wordedListing(text, id) {
  return itemsOf(text).some(item => mentions(item.lines.join("\n"), [id]).length && item.lines.some(line => WORDED.test(line) && line.includes(id))
    || mentions(item.lines.join("\n"), [id]).length && WORDED.test(item.title));
}

test("R8-A3-01 ordered · flow: lead reconciles a published plan of three authorized packages and starts none of them · loss: stuck", t => {
  const f = mechanisms(t);
  const packages = [pkg("alpha", { round: 8 }), pkg("bravo", { role: "critic", round: 8, authority: "D-0030", files: ["acceptance/bravo/**"] }), pkg("charlie", { role: "judge", round: 8, authority: "D-0030" })];
  f.plan("PL-0001", shuffled(packages, 31), { scope: "v1/round-8" });
  flagged(f, ["alpha", "bravo", "charlie"], ["alpha", "bravo", "charlie"]);
});

test("R8-A3-02 ordered · flow: lead records a hold with its release condition, a hold without one, then revises the plan to move the holds · loss: wrong-result", t => {
  const f = mechanisms(t);
  const ids = ["alpha", "bravo", "charlie"];
  const pending = { hold: "R-0008-judge-frame has not ruled on the derived interface", release: "the R-0008-judge-frame ruling is committed" };
  f.plan("PL-0001", [pkg("alpha", { round: 8, ...pending }), pkg("bravo", { round: 8, hold: "waiting for the frame judge", release: "" }), pkg("charlie", { round: 8 })], { scope: "v1/round-8" });
  flagged(f, ids, ["bravo", "charlie"], { when: at(100) });
  f.plan("PL-0002", [pkg("alpha", { round: 8 }), pkg("bravo", { round: 8, ...pending }), pkg("charlie", { round: 8, hold: "the owner batch on scope is open", release: "the owner's answer to the scope batch is committed" })],
    { supersedes: "PL-0001", when: at(200), scope: "v1/round-8" });
  flagged(f, ids, ["alpha"], { when: at(300) });
});

test("R8-A3-03 ordered · flow: lead prepares one package, records another and leaves a third unstarted · loss: wrong-result", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha", { round: 8 }), bravo = pkg("bravo", { round: 8 }), charlie = pkg("charlie", { round: 8 }), delta = pkg("delta", { role: "judge", round: 8, authority: "D-0030" });
  f.plan("PL-0001", [alpha, bravo, charlie, delta], { scope: "v1/round-8" });
  f.prepare(alpha, at(30));
  f.prepare(delta, at(31));
  jsonOutput(f.record(bravo, f.prepare(bravo, at(32)), { start: at(40), when: at(45) }));
  assert.deepEqual(Object.fromEntries([...f.ready("PL-0001", { when: at(50) })].map(([id, row]) => [id, row.status])),
    { alpha: "running", bravo: "done", charlie: "ready", delta: "running" });
  flagged(f, ["alpha", "bravo", "charlie", "delta"], ["charlie"]);
});

test("R8-A3-04 ordered · flow: lead plans packages behind a package dependency and an owner batch, then the host fills and empties and the owner answers · loss: wrong-result", t => {
  const f = mechanisms(t);
  const ids = ["alpha", "bravo", "charlie", "delta"];
  const batch = f.sendBatch(1, at(10));
  f.plan("PL-0001", [pkg("alpha", { round: 8 }), pkg("bravo", { round: 8, needs: ["alpha"] }), pkg("charlie", { round: 8, needs: [batch] }), pkg("delta", { role: "judge", round: 8, authority: "D-0030" })], { scope: "v1/round-8" });
  flagged(f, ids, ["alpha", "delta"], { when: at(100) });
  flagged(f, ids, [], { when: at(110), load: crowded });
  flagged(f, ids, ["alpha", "delta"], { when: at(120) });
  f.answer(batch, at(130), "as-recommended");
  f.publish("Record the owner's answer", at(140));
  flagged(f, ids, ["alpha", "charlie", "delta"], { when: at(150) });
});

test("R8-A3-05 ordered · flow: the advancing round is due and its frame judge is running while two owner-decided packages wait unstarted with no recorded hold · loss: stuck", t => {
  const f = mechanisms(t, { cadence: 1 });
  const ids = ownerDecidedBehindFrame(f);
  const text = flagged(f, ids, ["alpha", "bravo"]);
  assert.match(text, /advancing round due/i);
});

test("R8-A3-06 fresh · flow: lead reads next during a due advancing round while owner-decided packages are ready · loss: stuck", t => {
  const f = mechanisms(t, { cadence: 1 });
  ownerDecidedBehindFrame(f);
  const text = f.next();
  const advancing = itemsOf(text).find(item => /advancing (?:round|review) due/i.test(item.title));
  assert.ok(advancing, text);
  const body = advancing.lines.join("\n");
  assert.doesNotMatch(body, /no critic or actor call runs in it\./i);
  assert.match(body, /parallel|alongside|meanwhile|concurrent/i);
});

test("R8-A3-07 fresh · flow: lead keeps a superseded plan, a second scope and a plan of the previous phase in the records · loss: wrong-result", t => {
  const f = mechanisms(t);
  const ids = ["alpha", "bravo", "charlie", "delta", "echo"];
  f.plan("PL-0001", [pkg("alpha", { round: 8 }), pkg("bravo", { round: 8 })], { when: at(10), scope: "v1/round-8" });
  f.plan("PL-0002", [pkg("alpha", { round: 8 }), pkg("charlie", { round: 8 })], { supersedes: "PL-0001", when: at(20), scope: "v1/round-8" });
  f.plan("PL-0003", [pkg("delta", { round: 8, files: ["docs/delta/**"] })], { scope: "v1/docs", when: at(30) });
  f.plan("PL-0004", [pkg("echo", { round: 3 })], { scope: "v0/round-3", phaseName: "v0", when: at(40) });
  flagged(f, ids, ["alpha", "charlie", "delta"]);
});

test("R8-A3-08 fresh · flow: lead publishes a plan for an owner-decided package and never writes its task · loss: stuck", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha", { round: 8 }), bravo = pkg("bravo", { round: 8 }), charlie = pkg("charlie", { round: 8, hold: "the derived interface waits for its ruling", release: "R-0008-judge-frame is committed" });
  f.plan("PL-0001", [alpha, bravo, charlie], { tasks: [bravo, charlie], scope: "v1/round-8" });
  flagged(f, ["alpha", "bravo", "charlie"], ["alpha", "bravo"]);
});

const A_STATES = ["unstarted", "started", "done", "held"];
const B_STATES = ["unstarted", "held"];

function progressOracle(cases, { holds = true, satisfied = ["done"] } = {}) {
  return cases.flatMap(c => [
    ...(c.a === "unstarted" || (!holds && c.a === "held") ? [c.ids[0]] : []),
    ...((c.b === "unstarted" || (!holds && c.b === "held")) && (!c.needs || satisfied.includes(c.a)) ? [c.ids[1]] : []),
  ]).sort();
}

test("R8-A5-05 ordered · flow: lead reconciles every state pair of a package and its dependant, bound 2 packages x 4 states x 2 holds x 2 edges · loss: stuck", t => {
  const f = mechanisms(t);
  const cases = [];
  for (const a of A_STATES) for (const b of B_STATES) for (const needs of [false, true]) {
    const tag = letters(cases.length, 2);
    cases.push({ a, b, needs, ids: [`q${tag}a`, `q${tag}b`] });
  }
  const correct = progressOracle(cases);
  for (const defect of [{ holds: false }, { satisfied: [] }, { satisfied: ["done", "started"] }])
    assert.notDeepEqual(progressOracle(cases, defect), correct, `the bound does not reach ${JSON.stringify(defect)}`);
  const hold = { hold: "an unrelated owner-only choice is open", release: "the owner's answer is committed" };
  const packages = cases.flatMap(c => [
    pkg(c.ids[0], { round: 8, ...(c.a === "held" ? hold : {}) }),
    pkg(c.ids[1], { round: 8, needs: c.needs ? [c.ids[0]] : [], ...(c.b === "held" ? hold : {}) }),
  ]);
  f.plan("PL-0001", shuffled(packages, 55), { scope: "v1/round-8" });
  let second = 60;
  for (const c of cases) {
    if (c.a === "started") f.prepare(packages.find(p => p.id === c.ids[0]), at(second++));
    if (c.a === "done") {
      const item = packages.find(p => p.id === c.ids[0]);
      jsonOutput(f.record(item, f.prepare(item, at(second++)), { start: at(second), when: at(second++) }));
    }
  }
  const statuses = f.ready("PL-0001", { when: at(890) });
  for (const c of cases) {
    const want = { unstarted: "ready", started: "running", done: "done" }[c.a];
    if (want) assert.equal(statuses.get(c.ids[0]).status, want, json(statuses.get(c.ids[0])));
    if (c.b === "unstarted") assert.equal(statuses.get(c.ids[1]).status, c.needs && c.a !== "done" ? "waiting" : "ready", json(statuses.get(c.ids[1])));
  }
  flagged(f, cases.flatMap(c => c.ids), correct, { when: at(900) });
});

test("R9-A2-01 ordered · flow: lead holds packages on a worded release, a batch ID and a record ID, then the owner answers and the frame ruling lands · loss: stuck", t => {
  const f = mechanisms(t);
  const batch = f.sendBatch(1, at(10));
  const ids = ["alpha", "bravo", "charlie", "delta"];
  f.plan("PL-0001", [
    pkg("alpha", { hold: "the owner's scope answer is open", release: "after the owner answers the scope batch" }),
    pkg("bravo", { hold: "the owner's scope answer is open", release: batch }),
    pkg("charlie", { hold: "the frame ruling is pending", release: "R-0009-judge-frame" }),
    pkg("delta"),
  ], { when: at(20) });
  const first = f.next({ when: at(100) });
  assert.deepEqual(idleInNext(first, ids), ["delta"], first);
  assert.ok(wordedListing(first, "alpha"), `the worded hold of alpha is silent:\n${first}`);
  for (const id of ["bravo", "charlie"]) assert.ok(!wordedListing(first, id), `${id} holds on a computed release:\n${first}`);
  f.answer(batch, at(130), "as-recommended");
  f.handoffs({ round: 9, step: "judge-frame", time: at(140) });
  f.publish("Record the owner's answer and the frame ruling", at(150));
  const second = f.next({ when: at(200) });
  assert.deepEqual(idleInNext(second, ids), ["bravo", "charlie", "delta"], second);
  for (const id of ["bravo", "charlie", "delta"]) assert.ok(offered(second, pkg(id)), `${id} is released but no start command is offered:\n${second}`);
  assert.ok(wordedListing(second, "alpha"), `the worded hold of alpha went silent after its condition was met:\n${second}`);
  put(f.p.records, "decisions/D-0041.md", "# D-0041 Keep the release notes short\n\nid: D-0041\nby: lead\nstatus: active\n");
  f.publish("An unrelated decision", at(250));
  const third = f.next({ when: at(300) });
  assert.ok(wordedListing(third, "alpha"), `the worded hold of alpha is not listed on a later reconciliation:\n${third}`);
});

test("R9-A2-02 fresh · flow: lead writes a release that joins a record ID with words, an ISO time and capacity, and the conditions come true · loss: stuck", t => {
  const f = mechanisms(t);
  const ids = ["echo", "foxtrot", "golf"];
  const until = at(250);
  f.plan("PL-0001", [
    pkg("echo", { hold: "the frame ruling and the owner's agreement", release: "R-0009-judge-frame, and the owner agrees" }),
    pkg("foxtrot", { hold: "the release window opens later", release: until }),
    pkg("golf", { hold: "the host is busy with suites", release: "capacity" }),
  ], { when: at(20) });
  const busy = f.next({ when: at(100), load: crowded });
  assert.deepEqual(idleInNext(busy, ids), [], busy);
  assert.ok(wordedListing(busy, "echo"), busy);
  for (const id of ["foxtrot", "golf"]) assert.ok(!wordedListing(busy, id), `${id}:\n${busy}`);
  f.handoffs({ round: 9, step: "judge-frame", time: at(140) });
  f.publish("Record the frame ruling", at(150));
  const free = f.next({ when: at(300) });
  assert.deepEqual(idleInNext(free, ids), ["foxtrot", "golf"], free);
  assert.ok(wordedListing(free, "echo"), `a release that is partly words was treated as computed:\n${free}`);
  assert.ok(!offered(free, pkg("echo")), free);
});

test("R9-A2-03 ordered · flow: unattended heartbeat reconciles a worded hold on successive ticks beside a computed hold · loss: stuck", t => {
  const f = mechanisms(t);
  f.plan("PL-0001", [pkg("alpha", { hold: "release review", release: "after the release review agrees" }), pkg("bravo", { hold: "frame review", release: "R-0009-judge-frame" })]);
  for (const when of [at(100), at(200)]) {
    const text = json(f.tick({ when }).report);
    assert.ok(text.includes("alpha"), text);
    assert.match(text, /unchecked|awaiting.review|cannot.be.checked|release.in.words/i);
  }
});
