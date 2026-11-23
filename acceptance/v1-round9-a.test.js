import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonl, put, skill, status } from "./fixture.mjs";
import { next as nextOf, phase, round6B } from "./round6-b-fixture.mjs";
import { seed, seeded } from "./scenario.mjs";
import { at, headerOf, idleInNext, interventionText, itemsOf, judgeRow, marksPath, mechanisms, mentions, offered, ownerWord, pkg,
  shuffled, wordId, wordsPath } from "./v1-round9-fixture.mjs";

const cadencePredicate = "predicate advancing-round-due (next: \"advancing round due\", scripts/lib/cadence.mjs; F-0011 item 2)";
const COVERAGE = /would have fired|coverage|counterfactual|not raised[- ]first|earlier snapshots/i;
const WORDED = /in words|cannot be checked|unchecked|not computable|uncomputable|awaiting review|not checkable|cannot be computed/i;

function due(text) {
  return /advancing (?:round|review) due(?!\s+at\b)/i.test(text);
}

function cadenceSnapshots(f) {
  const steps = [
    [60, () => f.rows(judgeRow(2, { time: at(60) })), false],
    [120, () => f.rows(judgeRow(3, { time: at(120) })), true],
    [180, () => f.handoffs({ round: 4, step: "reviewer-frame", time: at(170) }, { round: 4, step: "judge-frame", time: at(175) }), false],
    [240, () => f.rows(judgeRow(5, { time: at(240) })), false],
    [300, () => f.rows(judgeRow(6, { time: at(300) })), true],
    [390, () => f.handoffs({ round: 7, step: "reviewer-frame", time: at(380) }, { round: 7, step: "judge-frame", time: at(385) }), false],
  ];
  const fired = steps.map(([when, event], i) => {
    event();
    f.publish(`Snapshot ${i + 1}`, at(when));
    return due(f.next({ when: at(when + 1) }));
  });
  assert.deepEqual(fired, steps.map(([, , expected]) => expected), "the cited predicate does not fire on the snapshots the scenario states");
}

function recordProposal(f) {
  put(f.p.records, "decisions/D-0040.md", "# D-0040 Run an advancing round after each group of adversarial rounds\n\nid: D-0040\nby: lead\nstatus: active\n");
  f.publish("Record the lead's proposal", at(5));
}

function directions(f, entries) {
  put(f.p.records, wordsPath, jsonl(...entries.map(e => e.word)));
  put(f.p.records, marksPath, jsonl(...entries.map(e => ({ id: e.word.id, as: "direction", intervention: e.id, time: at(410) }))));
  for (const e of entries) put(f.p.records, `interventions/${e.id}.md`, interventionText(e.id, [e.word.id], e.disposition));
  f.publish("Record the owner's corrections and their interventions", at(420));
}

const byPredicate = { rung: "screening predicate", carried: cadencePredicate };
const byRecord = { raised: "D-0040", rung: "hard gate", carried: "records-check.mjs raised-first (RECORDS.md, The owner's words)" };

function raisedInHeader(text) {
  const found = [...headerOf(text).matchAll(/raised[ -]?first(?:[ -]?count)?[\s:=]*(unknown|n\/a|\d+)/gi)].map(m => m[1]);
  assert.ok(found.length, headerOf(text));
  return found;
}

function coverageNames(text, id) {
  const lines = text.split("\n");
  return lines.some((line, i) => {
    if (!COVERAGE.test(line)) return false;
    if (line.includes(id)) return true;
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) if (lines[j].includes(id)) return true;
    return false;
  });
}

function falseAlarmCounts(value, found = []) {
  if (Array.isArray(value)) value.forEach(item => falseAlarmCounts(item, found));
  else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) {
    if (/false.?alarm/i.test(key)) {
      if (typeof inner === "number") found.push(inner);
      else if (Array.isArray(inner)) found.push(inner.length);
      else if (inner && typeof inner === "object") for (const leaf of Object.values(inner))
        found.push(typeof leaf === "number" ? leaf : Array.isArray(leaf) ? leaf.length : NaN);
    } else falseAlarmCounts(inner, found);
  }
  return found;
}

test("R9-A1-01 ordered · flow: an intervention says raised-first: no while its cited cadence predicate fires on the snapshot before the word, beside a record claim committed first · loss: wrong-result", t => {
  const f = mechanisms(t, { cadence: 2 });
  recordProposal(f);
  cadenceSnapshots(f);
  const replayed = ownerWord(wordId(1), at(330), "三轮对抗之后要有推进，为什么还在加固？");
  const claimed = ownerWord(wordId(2), at(340), "每三轮对抗之后推进一轮。");
  directions(f, [
    { word: replayed, id: "I-0001", disposition: { raised: "no", ...byPredicate } },
    { word: claimed, id: "I-0002", disposition: byRecord },
  ]);
  const m = f.metrics();
  assert.equal(m.ownerDirections, 2, json(m));
  assert.equal(m.raisedFirst, 1, json(m));
  const replayedEntry = m.directions.find(d => d.id === replayed.id);
  assert.equal(replayedEntry?.raisedFirst, "no", json(m));
  assert.notEqual(replayedEntry?.verified, true, json(m));
  assert.equal(m.directions.find(d => d.id === claimed.id)?.verified, true, json(m));
  const text = f.metricsText();
  assert.ok(coverageNames(text, replayed.id), `no coverage line names ${replayed.id} apart from raised-first:\n${text}`);
  assert.doesNotMatch(text, /verified by predicate/i);
  assert.deepEqual(raisedInHeader(f.next()), ["1"]);
});

test("R9-A1-02 ordered · flow: two corrections cite the same cadence predicate with no raised-first line, one after it fired and one in a quiet snapshot · loss: wrong-result", t => {
  const f = mechanisms(t, { cadence: 2 });
  cadenceSnapshots(f);
  const quiet = ownerWord(wordId(1), at(270), "为什么不推进新功能？");
  const firing = ownerWord(wordId(2), at(330), "三轮对抗之后要有推进，为什么还在加固？");
  directions(f, [
    { word: quiet, id: "I-0002", disposition: byPredicate },
    { word: firing, id: "I-0001", disposition: byPredicate },
  ]);
  const m = f.metrics();
  assert.equal(m.ownerDirections, 2, json(m));
  assert.equal(m.raisedFirst, 0, json(m));
  for (const word of [quiet, firing]) assert.notEqual(m.directions.find(d => d.id === word.id)?.verified, true, json(m));
  const counts = falseAlarmCounts(m);
  assert.ok(counts.length > 0, `no false-alarm count in ${json(m)}`);
  assert.ok(counts.every(n => n === 1), `false alarms ${counts.join(", ")} in ${json(m)}`);
  const text = f.metricsText();
  assert.ok(coverageNames(text, firing.id), `the firing replay of ${firing.id} is not reported as coverage:\n${text}`);
  assert.deepEqual(raisedInHeader(f.next()), ["0"]);
});

test("R9-A1-03 fresh · flow: lead backfills a seeded mix of record claims, refused credit and predicate-only corrections over the cadence snapshots · loss: wrong-result", t => {
  const f = mechanisms(t, { cadence: 2 });
  recordProposal(f);
  cadenceSnapshots(f);
  const draw = seeded(seed + 91);
  const firing = [...Array.from({ length: 50 }, (_, i) => 125 + i), ...Array.from({ length: 80 }, (_, i) => 305 + i)];
  const quietTimes = [...Array.from({ length: 50 }, (_, i) => 65 + i), ...Array.from({ length: 110 }, (_, i) => 185 + i)];
  const take = pool => pool.splice(draw(pool.length), 1)[0];
  const kinds = ["record", "no-fire", "none-fire", "no-quiet"];
  const plan = [...kinds, ...Array.from({ length: 2 + draw(5) }, () => kinds[draw(kinds.length)])];
  const entries = shuffled(plan, 92).map((kind, i) => {
    const time = kind === "no-quiet" ? take(quietTimes) : take(firing);
    const disposition = kind === "record" ? byRecord : kind === "none-fire" ? byPredicate : { raised: "no", ...byPredicate };
    return { kind, id: `I-${String(i + 1).padStart(4, "0")}`, word: ownerWord(wordId(100 + i), at(time), `Owner correction ${i}.`), disposition };
  });
  directions(f, entries);
  const m = f.metrics();
  const expected = entries.filter(e => e.kind === "record").length;
  assert.equal(m.ownerDirections, entries.length, json(m));
  assert.equal(m.raisedFirst, expected, `${entries.map(e => `${e.word.id} ${e.kind}`).join(", ")}\n${json(m)}`);
  for (const e of entries) assert.equal(m.directions.find(d => d.id === e.word.id)?.verified === true, e.kind === "record", `${e.kind} ${e.word.id}`);
  assert.deepEqual(raisedInHeader(f.next()), [String(expected)]);
});

function wordedListing(text, id) {
  return itemsOf(text).some(item => mentions(item.lines.join("\n"), [id]).length && item.lines.some(line => WORDED.test(line) && line.includes(id))
    || mentions(item.lines.join("\n"), [id]).length && WORDED.test(item.title));
}

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
  const busy = f.next({ when: at(100), load: { cores: 20, load: 15, availableGB: 32 } });
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

const OVERLAPS = [
  [["scripts/lib/plan.mjs"], ["scripts/lib/**"]],
  [["SKILL.md"], ["[A-Z]*.md"]],
  [["acceptance/v1-round9-a.test.js"], ["acceptance/*.test.js"]],
  [["docs/guide/start.md"], ["docs/"]],
];

function holdsBy(text, waiting, holder) {
  return text.split("\n").some(line => mentions(line, [waiting.id, waiting.handoff]).length && mentions(line, [holder.id, holder.handoff]).length);
}

test("R9-A3-01 fresh · flow: lead publishes two current plans in different scopes whose packages write the same files · loss: wrong-result", t => {
  const f = mechanisms(t);
  const draw = seeded(seed + 31);
  const [left, right] = OVERLAPS[draw(OVERLAPS.length)];
  const [calm, quiet] = [["unaffected/bravo/**"], ["unaffected/delta/**"]];
  const alpha = pkg("alpha", { files: left }), bravo = pkg("bravo", { files: calm });
  const charlie = pkg("charlie", { files: right }), delta = pkg("delta", { files: quiet });
  f.plan("PL-0001", shuffled([alpha, bravo], 32), { when: at(20) });
  f.plan("PL-0002", shuffled([charlie, delta], 33), { scope: "v1/docs", when: at(25) });
  const text = f.next({ when: at(100) });
  for (const item of [bravo, delta]) assert.ok(offered(text, item), `${item.id} writes disjoint files and is not offered:\n${text}`);
  const pair = [alpha, charlie].filter(item => offered(text, item));
  assert.equal(pair.length, 1, `${left} and ${right} overlap; offered: ${pair.map(item => item.id).join(", ") || "none"}\n${text}`);
  const [first] = pair, second = first === alpha ? charlie : alpha;
  assert.ok(holdsBy(text, second, first), `${second.id} waits without naming ${first.id}:\n${text}`);
});

test("R9-A3-02 ordered · flow: lead plans two scopes with disjoint writers, then starts and records one of two overlapping writers · loss: wrong-result", t => {
  const f = mechanisms(t);
  const alpha = pkg("alpha", { files: ["scripts/lib/plan.mjs"] }), bravo = pkg("bravo", { files: ["src/bravo/**"] });
  const charlie = pkg("charlie", { files: ["scripts/other/**"] }), delta = pkg("delta", { files: ["docs/**"] });
  f.plan("PL-0001", [alpha, bravo], { when: at(20) });
  f.plan("PL-0002", [charlie, delta], { scope: "v1/docs", when: at(25) });
  const apart = f.next({ when: at(60) });
  for (const item of [alpha, bravo, charlie, delta]) assert.ok(offered(apart, item), `${item.id}:\n${apart}`);
  const overlapping = pkg("echo", { files: ["scripts/lib/**"] });
  const g = mechanisms(t);
  g.plan("PL-0001", [alpha, bravo], { when: at(20) });
  g.plan("PL-0002", [overlapping, delta], { scope: "v1/docs", when: at(25) });
  const running = g.prepare(alpha, at(30));
  const held = g.next({ when: at(60) });
  assert.ok(!offered(held, overlapping), held);
  assert.ok(holdsBy(held, overlapping, alpha), held);
  status(g.record(alpha, running, { start: at(70), when: at(80) }), 0);
  const after = g.next({ when: at(100) });
  assert.ok(offered(after, overlapping), after);
});

function ownerWaiting(text, plan) {
  const line = headerOf(text).split("\n").find(l => l.includes(plan) && /owner wait/i.test(l));
  assert.ok(line, headerOf(text));
  const m = /owner wait(?:ing)?(?:[ -]?time)?[\s:=]*(unknown|n\/a|-?\d+(?:\.\d+)?)\s*(s\b|sec|ms)?/i.exec(line);
  assert.ok(m, line);
  return m[1] === "unknown" || m[1] === "n/a" ? m[1] : Number(m[1]) / (m[2] === "ms" ? 1000 : 1);
}

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
    assert.notEqual(shown, 0, `owner waiting printed as 0 s while ${"B-0001"} is unanswered`);
  }
});

test("R9-A5-01 ordered · flow: lead counts prose comments in a tree holding the shipped planner files · loss: false-verdict", t => {
  const w = round6B(t);
  const files = Object.fromEntries(["scripts/lib/plan.mjs", "scripts/plan.mjs", "scripts/test/plan.test.mjs"]
    .map(path => [path, readFileSync(join(skill, path), "utf8")]));
  const p = phase(w, "planner", { files });
  w.register([p]);
  const text = nextOf(w, p);
  const line = text.split("\n").find(l => /prose comments? at/i.test(l));
  assert.ok(line, text);
  assert.match(line, /:\s*0\b/, `the shipped planner files hold prose comments (D-0016):\n${line}`);
});

test("R9-A2-03 ordered · flow: unattended heartbeat reconciles a worded hold on successive ticks beside a computed hold · loss: stuck", t => {
  const f = mechanisms(t);
  f.plan("PL-0001", [pkg("alpha", {hold:"release review", release:"after the release review agrees"}), pkg("bravo", {hold:"frame review", release:"R-0009-judge-frame"})]);
  for (const when of [at(100),at(200)]) {
    const text = json(f.tick({when}).report);
    assert.ok(text.includes('alpha'), text);
    assert.match(text, /unchecked|awaiting.review|cannot.be.checked|release.in.words/i);
  }
});
