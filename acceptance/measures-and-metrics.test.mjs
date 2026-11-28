import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonOutput, jsonl, put, skill, status } from "./fixture.mjs";
import { loopWorld, next as nextOf, phase } from "./loop-world-fixture.mjs";
import { at, dispatchPkg, dispatchWorld, headerOf, interventionText, judgeRow, marksPath, mechanisms, ownerWord, pkg, wordId, wordsPath } from "./plan-world-fixture.mjs";
import { now, shift } from "./scenario.mjs";

const LABELS = {
  directions: /owner[ -]?directions?/gi,
  raised: /raised[ -]?first(?:[ -]?count)?/gi,
  precision: /precision(?: of (?:the )?(?:batch )?answers)?/gi,
  critical: /critical[ -]?path(?:[ -]?(?:work|time|duration))?/gi,
  idle: /idle(?:[ -]?dispatchable)?(?:[ -]?time|work|seconds|package-seconds)?/gi,
  waiting: /owner[ -]?wait(?:ing)?(?:[ -]?time)?/gi,
};
const TOKEN = "unknown|n\\/a|-?\\d+(?:\\.\\d+)?%?";

function measureLine(report, label) {
  const line = report.split("\n").find(line => label.test(line));
  assert.ok(line, report);
  return line;
}

function sessionPart(text) {
  const index = text.indexOf("This session:");
  assert.ok(index >= 0, text);
  return text.slice(index);
}

function tokens(header, label) {
  const found = [];
  for (const match of header.matchAll(LABELS[label])) {
    const after = new RegExp(`^[\\s:=]*(${TOKEN})`, "i").exec(header.slice(match.index + match[0].length));
    if (after) found.push(after[1].toLowerCase());
    const before = new RegExp(`(?:^|[\\s(])(${TOKEN})[\\s:]*$`, "i").exec(header.slice(0, match.index));
    if (before) found.push(before[1].toLowerCase());
  }
  return found;
}

function shows(header, label, accepted) {
  const found = tokens(header, label);
  assert.ok(found.some(token => accepted.includes(token)), `${label}: expected one of ${accepted.join(" | ")}, found ${found.join(" | ") || "nothing"} in:\n${header}`);
}

function unknownOnly(header, label) {
  const found = tokens(header, label);
  assert.ok(found.length > 0, `${label}: no figure in:\n${header}`);
  assert.ok(found.every(token => token === "unknown" || token === "n/a"), `${label}: an unknown measure printed as ${found.join(" | ")} in:\n${header}`);
}

function ratioForms(part, whole) {
  if (!whole) return ["unknown", "n/a"];
  const value = part / whole;
  return [`${Math.round(value * 1000) / 10}%`, `${Math.round(value * 100)}%`, String(Math.round(value * 100) / 100), String(Math.round(value * 1000) / 1000)];
}

function headerFixture(t) {
  const f = mechanisms(t);
  put(f.p.records, "decisions/D-0040.md", "# D-0040 Propose dispatch of every independent package\n\nid: D-0040\nby: lead\nstatus: active\n");
  f.publish("Record the proposal", at(5));
  const b1 = f.sendBatch(1, at(10)), b2 = f.sendBatch(2, at(15)), b3 = f.sendBatch(3, at(18));
  f.answer(b1, at(70), "as-recommended");
  f.answer(b2, at(72), "as-recommended");
  f.answer(b3, at(74), "amended");
  f.publish("Record the owner's answers", at(80));
  const words = [1, 2, 3, 4].map(n => ownerWord(wordId(n), at(100 + n * 10), `Owner direction ${n}.`));
  const routine = ownerWord(wordId(9), at(160), "继续");
  put(f.p.records, wordsPath, jsonl(...words, routine));
  put(f.p.records, marksPath, jsonl(...words.map((word, i) => ({ id: word.id, as: "direction", intervention: `I-000${i + 1}`, time: at(170) })),
    { id: routine.id, as: "routine", note: "Go-ahead", time: at(170) }));
  words.forEach((word, i) => put(f.p.records, `interventions/I-000${i + 1}.md`, interventionText(`I-000${i + 1}`, [word.id], {
    raised: i === 0 ? "D-0040" : "no", rung: "screening predicate", carried: "F-0012 A3" })));
  f.publish("Record the directions", at(180));
  f.rows(judgeRow(2, { time: at(190), area: "dispatch", opened: "dispatch:slow-start" }));
  f.publish("Rule round 2", at(195));
  f.plan("PL-0001", [pkg("alpha", { round: 8, needs: [b1] }), pkg("bravo", { round: 8 })], { when: at(200), scope: "v1/round-8" });
  return f;
}

function ownerWaiting(text, plan) {
  const line = headerOf(text).split("\n").find(l => l.includes(plan) && /owner wait/i.test(l));
  assert.ok(line, headerOf(text));
  const m = /owner wait(?:ing)?(?:[ -]?time)?[\s:=]*(unknown|n\/a|-?\d+(?:\.\d+)?)\s*(s\b|sec|ms)?/i.exec(line);
  assert.ok(m, line);
  return m[1] === "unknown" || m[1] === "n/a" ? m[1] : Number(m[1]) / (m[2] === "ms" ? 1000 : 1);
}

test("R8-D3-01 ordered · flow: lead measures a completed timed fork and join with a delayed hand-off and an overlapping owner wait · loss: wrong-result", t => {
  const x = dispatchWorld(t);
  const stamp = seconds => shift(now, seconds * 1_000);
  const batch = x.sendBatch(stamp(5));
  const actor = dispatchPkg("actor-a", { files: ["scripts/owner-words.mjs", "scripts/lib/owner-words.mjs", "scripts/lib/owner-metrics.mjs", "scripts/records-check.mjs"] });
  const peer = dispatchPkg("actor-b", { files: ["scripts/decisions.mjs"] });
  const judge = dispatchPkg("judge-integration", { needs: [actor.id, peer.id, batch] });
  x.plan([actor, peer, judge], { at: stamp(10) });
  const a = x.prepare(actor, { at: stamp(10) });
  const b = x.prepare(peer, { at: stamp(10) });
  x.answer(stamp(28));
  x.checkAndCommit("Record the timed owner answer", stamp(29));
  for (const [item, prepared, start, end, recorded] of [[actor, a, 13, 43, 96], [peer, b, 14, 64, 100]]) {
    jsonOutput(x.record(item, prepared, { start: stamp(start), end: stamp(end), at: stamp(recorded) }));
  }
  const j = x.prepare(judge, { at: stamp(101) });
  jsonOutput(x.record(judge, j, { start: stamp(102), end: stamp(119), at: stamp(122),
    publicReport: "VERDICT: CONVERGED\n\nACCEPTANCE: pass\n" }));
  const report = status(x.runPlan(["measure", "--records", x.p.records, "--plan", "PL-0001"], { at: stamp(130) }), 0);
  assert.match(measureLine(report, /critical[- ]path/i), /\b67(?:\.0+)?\s*(?:s\b|sec|$)|\b67000\s*ms|\b0?0:01:07\b|\b1\s*m\s+7\s*s\b/i);
  assert.match(measureLine(report, /owner wait/i), /\b23(?:\.0+)?\s*(?:s\b|sec|$)|\b23000\s*ms|\b0?0:00:23\b/i);
  assert.match(measureLine(report, /idle dispatchable|dispatchable.*idle|runnable.*unstarted/i), /unknown|unavailable|missing|unverified/i);
});

test("R8-A4-01 ordered · flow: lead reads next and start after a phase with four directions, three labelled answers and a plan behind an answered batch · loss: wrong-result", t => {
  const f = headerFixture(t);
  const m = f.metrics(at(600));
  const measured = jsonOutput(f.w.run("plan.mjs", ["measure", "--records", f.p.records, "--plan", "PL-0001", "--json"], { at: at(600), cwd: f.p.records }));
  assert.equal(m.ownerDirections, 4, json(m));
  assert.equal(m.raisedFirst, 1, json(m));
  assert.equal(measured.criticalPath.seconds, null, json(measured));
  assert.ok(Number.isFinite(measured.ownerWaiting.seconds) && measured.ownerWaiting.seconds > 0, json(measured));
  for (const text of [f.next(), sessionPart(f.start())]) {
    const header = headerOf(text);
    shows(header, "directions", [String(m.ownerDirections)]);
    shows(header, "raised", [String(m.raisedFirst)]);
    shows(header, "precision", ratioForms(m.answersByOutcome["as-recommended"], m.answeredWithOutcome));
    unknownOnly(header, "critical");
    unknownOnly(header, "idle");
    shows(header, "waiting", [String(measured.ownerWaiting.seconds)]);
    assert.match(header, /returns per area[^\n]*\n[^\n]*dispatch: round 2 opened 1/i);
  }
});

test("R8-A4-02 ordered · flow: lead starts a session on a phase with a frame but no direction, no labelled answer and no plan · loss: wrong-result", t => {
  const f = mechanisms(t);
  const batch = f.sendBatch(1, at(10));
  f.answer(batch, at(20));
  f.publish("Record an unlabelled answer", at(30));
  const m = f.metrics(at(600));
  assert.equal(m.ownerDirections, 0, json(m));
  assert.equal(m.precision, null, json(m));
  for (const text of [f.next(), sessionPart(f.start())]) {
    const header = headerOf(text);
    shows(header, "directions", ["0"]);
    shows(header, "raised", ["0"]);
    unknownOnly(header, "precision");
    shows(header, "waiting", ["10"]);
    for (const label of ["critical", "idle"]) {
      const found = tokens(header, label);
      assert.ok(found.length > 0 && found.every(token => token === "unknown"), `${label}: ${found.join(" | ") || "nothing"} in:\n${header}`);
    }
  }
});

test("R9-A4-01 ordered · flow: lead reads the measures while a package waits on an unanswered owner batch, then after the answer · loss: wrong-result", t => {
  const f = mechanisms(t);
  const batch = f.sendBatch(1, at(10));
  f.plan("PL-0001", [pkg("alpha", { needs: [batch] }), pkg("bravo")], { when: at(20) });
  const waiting = ownerWaiting(f.next({ when: at(600) }), "PL-0001");
  assert.ok(typeof waiting === "number" && Math.abs(waiting - 590) <= 1, `owner waiting ${waiting}, expected 590 s accrued from the send`);
  const measured = f.measure("PL-0001", at(600)).ownerWaiting.seconds;
  assert.ok(typeof measured === "number" && Math.abs(measured - 590) <= 1, `plan.mjs measure: ${measured}`);
  f.answer(batch, at(700), "as-recommended");
  f.publish("Record the owner's answer", at(705));
  const answered = f.measure("PL-0001", at(800)).ownerWaiting.seconds;
  assert.ok(typeof answered === "number" && Math.abs(answered - 690) <= 1, `after the answer: ${answered}`);
  assert.equal(ownerWaiting(f.next({ when: at(800) }), "PL-0001"), answered);
});

test("R9-A4-02 fresh · flow: lead plans packages that name no batch while the phase's owner batch is still unanswered · loss: wrong-result", t => {
  const f = mechanisms(t);
  f.sendBatch(1, at(10));
  f.plan("PL-0001", [pkg("alpha"), pkg("bravo")], { when: at(20) });
  for (const when of [at(300), at(600)]) {
    const shown = ownerWaiting(f.next({ when }), "PL-0001");
    assert.notEqual(shown, 0, `owner waiting printed as 0 s while B-0001 is unanswered`);
  }
});

test("R9-A5-01 ordered · flow: lead counts prose comments in a tree holding the shipped planner files · loss: false-verdict", t => {
  const w = loopWorld(t);
  const files = Object.fromEntries(["scripts/lib/plan.mjs", "scripts/plan.mjs", "scripts/test/plan.test.mjs"]
    .map(path => [path, readFileSync(join(skill, path), "utf8")]));
  const p = phase(w, "planner", { files });
  w.register([p]);
  const text = nextOf(w, p);
  const line = text.split("\n").find(l => /prose comments? at/i.test(l));
  assert.ok(line, text);
  assert.match(line, /:\s*0\b/, `the shipped planner files hold prose comments (D-0016):\n${line}`);
});
