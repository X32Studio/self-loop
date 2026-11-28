import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonl, put, status, world, writeGh } from "./fixture.mjs";
import { argsFor, greenCheck, hostMeasurement, phase } from "./loop-world-fixture.mjs";
import { at, headerOf, interventionText, judgeRow, marksPath, mechanisms, ownerWord, shuffled, wordId, wordsPath } from "./plan-world-fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const clock = "2026-11-22T00:00:00.000Z";
const handoffsPath = "metrics/handoffs.jsonl";
const trajectoryPath = "metrics/trajectory.jsonl";
const convergence = /recorded convergence checks are satisfied/i;
const cadenceDue = /advancing round due/i;
const cadencePredicate = "predicate advancing-round-due (next: \"advancing round due\", scripts/lib/cadence.mjs; F-0011 item 2)";
const COVERAGE = /would have fired|coverage|counterfactual|not raised[- ]first|earlier snapshots/i;

const roundClose = [
  { round: 5, area: "round-close", time: "2026-11-21T18:50:34Z",
    opened: "tip-ci-evidence:R5-1", closed: "tip-ci-evidence:R1-5" },
  { round: 6, area: "round-close", time: "2026-11-21T20:40:15Z",
    opened: "ci-host-binding:R6-1,suite-evidence:R6-2,suite-evidence:R6-3,comment-admission:R6-4,comment-admission:R6-5,remote-admission:R6-6,protection-migration:R6-7",
    closed: "tip-ci-evidence:R5-1" },
  { round: 7, area: "round-close", time: "2026-11-21T23:14:24Z",
    opened: "blocker-disposition:R7-1,blocker-key-admission:R7-2,ci-host-binding:R7-3",
    closed: "ci-host-binding:R6-1,remote-admission:R6-6,protection-migration:R6-7" },
];

function roundCase(id, label, flow, loss, body) {
  test(`${id} [${label}] flow: ${flow} | loss: ${loss}`, body);
}

function check(w, records, ...args) {
  return w.run(["--repo", records, ...args], { entry: "records-check.mjs", at: clock });
}

function publish(w, records, message) {
  w.git(records, "add", "-A");
  status(check(w, records, "--write"), 0);
  return w.commit(records, message, clock);
}

function handoff(w, p, { round, step, phase: phaseName = "v1", time = clock, product = null, report = "" }) {
  const number = String(round).padStart(4, "0");
  const id = `R-${number}-${step}`;
  const record = `rounds/${number}-${step}.md`;
  const role = step.split("-")[0];
  const runner = role === "actor" ? "t3:codex" : "claude";
  put(p.records, record, `# ${id}\n\nphase: ${phaseName}\nrole: ${role}\n\n${report}\n`);
  return { id, round, phase: phaseName, role, step, time, product, record, attempt: 1,
    files: [record], view: w.git(p.records, "rev-parse", "HEAD"),
    audit: { violations: 0 }, agent: { runner, model: `fixture-${runner}` } };
}

function appendHandoffs(w, p, entries) {
  const contents = readFileSync(join(p.records, handoffsPath), "utf8");
  put(p.records, handoffsPath, contents + jsonl(...entries.map(entry => handoff(w, p, entry))));
}

function cadenceWorld(t, { adversarial } = {}) {
  const w = world(t, { clock });
  const p = phase({ ...w, run: (entry, args) => w.run(args, { entry }) }, "cadence", { files: {
    "smoke.test.mjs": 'import test from "node:test";\ntest("smoke", () => {});\n',
  } });
  if (adversarial !== undefined) {
    const cfg = JSON.parse(readFileSync(p.config, "utf8"));
    put(p.records, "loop.json", json({ ...cfg, cadence: { adversarial } }));
  }
  w.register([p]);
  writeGh(w, { [p.initial]: [greenCheck] });
  const measured = hostMeasurement(w, { cores: 8, load: 0.25, availableGB: 32 });
  const next = () => status(w.run(["next", "--config", p.config], { entry: "loop.mjs", extraEnv: measured, at: clock }), 0);
  const rows = [];
  const save = (entries = [], handoffs = []) => {
    appendHandoffs(w, p, handoffs);
    for (const fields of entries) {
      const role = fields.role ?? "judge";
      rows.push({ role, phase: "v1", verdict: "CONTINUE", commit: p.initial, ci: "success",
        suite: "1/0", time: clock, ...fields });
    }
    if (rows.length) put(p.records, trajectoryPath, jsonl(...rows));
    publish(w, p.records, "Replay phase activity");
    return next();
  };
  return { w, p, next, save };
}

function shellWords(line) {
  const words = [];
  let word = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") {
      let end = line.indexOf("'", i + 1);
      if (end < 0) end = line.length;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      word ??= "";
      for (i++; i < line.length && line[i] !== '"'; i++) {
        if (line[i] === "\\" && /["\\$`]/.test(line[i + 1] ?? "")) i++;
        word += line[i];
      }
    } else if (c === "\\") {
      word = (word ?? "") + (line[i + 1] ?? "");
      i++;
    } else if (/\s/.test(c)) {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? "") + c;
  }
  if (word !== null) words.push(word);
  return words;
}

function callLine(line) {
  const words = shellWords(line);
  const index = words.findIndex(word => /(?:^|\/)call\.mjs$/.test(word));
  if (index < 0) return null;
  const [, role, ...rest] = words.slice(index + 1);
  const flag = name => rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined;
  return { role, step: flag("--step") ?? role, round: flag("--round") };
}

function assertDue(text, expectedRounds) {
  const lines = text.split("\n");
  const firstLine = lines.findIndex(line => cadenceDue.test(line));
  assert.ok(firstLine >= 0, text);
  const end = lines.findIndex((line, i) => i > firstLine && /^\s*- /u.test(line));
  const block = lines.slice(firstLine, end < 0 ? undefined : end).join("\n");
  assert.match(block, new RegExp(`\\b${expectedRounds.length}\\b`));
  for (const round of expectedRounds) assert.match(block, new RegExp(`\\b0*${round}\\b`));
  const calls = lines.map(callLine);
  const steps = ["reviewer-frame-blind", "reviewer-frame", "judge-frame"].map(step =>
    calls.findIndex((call, i) => i > firstLine && call?.step === step));
  assert.ok(steps[0] > firstLine && steps[1] > steps[0] && steps[2] > steps[1], text);
  const worker = calls.findIndex(call => ["critic", "actor"].includes(call?.role) && call.round !== undefined);
  assert.ok(worker < 0 || worker > steps[2], text);
  return block;
}

const due = text => /advancing (?:round|review) due(?!\s+at\b)/i.test(text);

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

roundCase("R8-G2-01", "ordered",
  "The lead reopens next after the three judged round-close rulings and must see the advancing work first", "wrong-result", t => {
    const s = cadenceWorld(t);
    assert.doesNotMatch(s.save(roundClose.slice(0, 2)), cadenceDue);
    assertDue(s.save(roundClose.slice(2)), [5, 6, 7]);
  });

roundCase("R8-G2-02", "fresh",
  "The lead follows next after a partial advancing round and then files the independent judge hand-off", "false-verdict", t => {
    const s = cadenceWorld(t);
    const partial = s.save(roundClose, [
      { round: 8, step: "reviewer-frame-followup" },
      { round: 9, step: "judge-frame" },
    ]);
    const resumed = s.save([], [{ round: 8, step: "judge-frame" }]);
    assert.doesNotMatch(resumed, cadenceDue);
    assert.match(resumed, /open blockers:[^\n]*blocker-disposition:R7-1/i);
    assert.match(partial, cadenceDue);
    const later = [11, 13, 15].map(round => ({ round, area: `feature-${round}` }));
    assert.doesNotMatch(s.save(later.slice(0, 2)), cadenceDue);
    assertDue(s.save(later.slice(2)), [11, 13, 15]);
  });

roundCase("R8-G2-03", "fresh",
  "The lead uses a larger cadence and a migrated trajectory that also includes activity outside the window", "false-verdict", t => {
    const draw = seeded(seed + 806);
    const firstRound = 11 + draw(11);
    const threshold = 12 + draw(21);
    const s = cadenceWorld(t, { adversarial: threshold });
    const current = Array.from({ length: threshold }, (_, index) => ({ round: firstRound + 2 * index, area: `area-${index}` }));
    const unrelated = [
      { round: 7, phase: "v0", area: "round-close" },
      { round: 9, role: "actor", verdict: "-", area: "round-close" },
    ];
    assert.doesNotMatch(s.save([...unrelated, ...current.slice(0, -1)]), cadenceDue);
    assertDue(s.save(current.slice(-1)), current.map(row => row.round));
  });

roundCase("R8-G2-04", "ordered",
  "The lead checks diminishing returns across areas before deciding whether to leave round-close", "wrong-result", t => {
    const s = cadenceWorld(t);
    const text = s.save([
      { ...roundClose[0], area: "watch" },
      ...roundClose.slice(1),
    ]);
    for (const area of ["watch", "round-close"]) assert.match(text, new RegExp(`\\b${area}\\b`));
    const lines = text.split("\n");
    for (const row of roundClose) {
      const opened = row.opened.split(",");
      const closed = row.closed.split(",");
      const candidates = lines.filter(line => new RegExp(`\\b0*${row.round}\\b`).test(line));
      const found = candidates.some(line => {
        const show = (label, sign, keys) => {
          const total = keys.length;
          const count = new RegExp(`(?:\\b${label}\\w*\\s*[:=]?\\s*${total}\\b|\\b${total}\\s+${label}\\w*\\b|\\${sign}\\s*${total}\\b)`, "i");
          return count.test(line) || keys.every(key => line.includes(key));
        };
        return show("open", "+", opened) && show("clos", "-", closed);
      });
      assert.ok(found, `missing opened and closed blockers for round ${row.round} in:\n${text}`);
    }
  });

roundCase("R8-G2-05", "ordered",
  "The lead asks next whether an otherwise converged phase can close and still runs a legitimate critic dry run", "false-verdict", t => {
    const s = cadenceWorld(t);
    const { w, p } = s;
    put(p.records, "decisions/D-0001.md", "# D-0001 Retire F-0003\n\nid: D-0001\n");
    publish(w, p.records, "Record the blueprint decision");
    status(w.run(["set", "--records", p.records, "--feature", "F-0003", "--status", "retired",
      "--decision", "D-0001", "--by", "lead", "--note", "The feature was superseded."], { entry: "blueprint.mjs" }), 0);
    status(w.run(["--repo", p.product, "--sha", p.initial, "--command",
      "node --test smoke.test.mjs", "--out", join(p.records, "evidence/0004/suite")], { entry: "suite-green.mjs" }), 0);
    const sameCommit = { base: p.initial, commit: p.initial };
    const judge = handoff(w, p, { round: 4, step: "judge", product: sameCommit });
    const sealed = "sealed/judge/0004/judge-1.md";
    put(p.records, sealed, "# Sealed\n\n## Report (verbatim)\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n");
    judge.files.push(sealed);
    const worker = handoff(w, p, { round: 3, step: "actor", product: sameCommit });
    const previous = readFileSync(join(p.records, handoffsPath), "utf8");
    put(p.records, handoffsPath, previous + jsonl(worker, judge));
    const candidate = s.save([
      { round: 2, area: "watch" },
      { round: 3, area: "release" },
      { round: 4, area: "driver", verdict: "CONVERGED" },
    ]);
    status(w.run([...argsFor(w, p, "critic", { round: 10 }), "--dry-run"], { entry: "call.mjs" }), 0);
    const reviewed = s.save([], [
      { round: 5, step: "reviewer-frame" },
      { round: 5, step: "judge-frame" },
    ]);
    assert.doesNotMatch(reviewed, cadenceDue);
    assert.match(reviewed, convergence);
    assert.doesNotMatch(candidate, convergence);
    assertDue(candidate, [2, 3, 4]);
  });

test("R8-A5-06 ordered · flow: judge rulings, a repeated ruling, an unruled row, an advancing round and a lowered cadence arrive one by one, bound 7 events · loss: stuck", t => {
  const f = mechanisms(t, { cadence: 2 });
  const events = [
    [() => f.rows(judgeRow(2, { time: at(60) })), false],
    [() => f.rows(judgeRow(2, { time: at(120) })), false],
    [() => f.rows(judgeRow(3, { time: at(180), verdict: "-" })), false],
    [() => f.rows(judgeRow(3, { time: at(240) })), true],
    [() => { f.handoffs({ round: 4, step: "reviewer-frame", time: at(290) }, { round: 4, step: "judge-frame", time: at(295) }); f.rows(judgeRow(4, { time: at(298) })); }, false],
    [() => { const path = join(f.p.records, "loop.json"); put(f.p.records, "loop.json", json({ ...JSON.parse(readFileSync(path, "utf8")), cadence: { adversarial: 1 } })); }, false],
    [() => f.rows(judgeRow(5, { time: at(420) })), true],
  ];
  const seen = [due(f.next({ when: at(30) }))];
  events.forEach(([event], i) => {
    event();
    f.publish(`Event ${i + 1}`, at(60 * (i + 1) + 5));
    seen.push(due(f.next({ when: at(60 * (i + 1) + 10) })));
  });
  assert.deepEqual(seen, [false, ...events.map(([, expected]) => expected)]);
});

test("R8-A2-01 ordered · flow: the cadence predicate an intervention cites fires on the snapshot before the owner's word and once on an earlier snapshot nobody corrected · loss: wrong-result", t => {
  const f = mechanisms(t, { cadence: 2 });
  cadenceSnapshots(f);
  const word = ownerWord(wordId(1), at(330), "三轮对抗之后要有推进，为什么还在加固？");
  directions(f, [{ word, id: "I-0001", disposition: byPredicate }]);
  const m = f.metrics();
  assert.equal(m.ownerDirections, 1, json(m));
  assert.equal(m.raisedFirst, 0, json(m));
  const counts = falseAlarmCounts(m);
  assert.ok(counts.length > 0, `no false-alarm count in ${json(m)}`);
  assert.ok(counts.every(n => n === 1), `false alarms ${counts.join(", ")} in ${json(m)}`);
});

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
  assert.ok(m.directions.find(d => d.id === firing.id)?.predicates?.some(p => p.fires === true), json(m));
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
