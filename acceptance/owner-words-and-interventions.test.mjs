import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonl, output, put, status, world } from "./fixture.mjs";
import { phase } from "./loop-world-fixture.mjs";
import { at, interventionText, itemsOf, marksPath, mechanisms, ownerWord, pad, pkg, shuffled, wordId, wordsPath } from "./plan-world-fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const clock = "2026-11-22T00:00:00.000Z";
const first = "B-0001";
const second = "B-0002";
const third = "B-0003";
const answersPath = "owner/answers.jsonl";
const handoffsPath = "metrics/handoffs.jsonl";
const RUNGS = ["construction", "hard gate", "screening predicate", "question bank", "owner-only"];

const blueprint = ownerWord("W-a53bc02389", "2026-11-21T04:52:29.056Z",
  "你的生成引擎应该有一张整体的蓝图，记录你的顶层需求，整体重要feature的设计，为什么要这些feature，以及哪些做完了，哪些没有。");
const modules = ownerWord("W-0249b13ee1", "2026-11-21T23:08:09.809Z",
  "生成引擎从现有架构反查方向，先把代码抽象成模块，再查模块的边界和设计。");
const dispatch = ownerWord("W-dc50ba0172", "2026-11-21T23:20:20.692Z",
  "主负责人只排发和分包，不应该自己做。");
const approval = ownerWord("W-702e5b684e", "2026-11-21T23:37:57Z",
  "1，除此以外，应该是从第一性的和语录的反推，让客观第三方做评价，agent as a judegement，确保推论和设计是合理的，符合意图。2，我同意。另外，生成引擎不应该只有event based，还应该有周期性的，比如三轮对抗一轮推进。另外，目前抵抗似乎有点过了，一直在局部打转，如果边际效益已经递减的很厉害，已经在钻牛角尖应该抽离推进新feature开发。");
const archivedDirections = [blueprint, modules, dispatch];
const priorCapture = "2026-11-20T12:00:00.000Z";

function roundCase(id, label, flow, loss, body) {
  test(`${id} [${label}] flow: ${flow} | loss: ${loss}`, body);
}

function recordsCLI(w, records, entry, verb, ...args) {
  return w.run([verb, "--records", records, ...args], { entry, at: clock });
}

function check(w, records, ...args) {
  return w.run(["--repo", records, ...args], { entry: "records-check.mjs", at: clock });
}

function publish(w, records, message, when = clock) {
  w.git(records, "add", "-A");
  status(check(w, records, "--write"), 0);
  return w.commit(records, message, when);
}

function intervention(id, words, raisedFirst) {
  return `# ${id}\n\nTime: 2026-11-21, Asia/Dubai\nwords: ${words.map(word => word.id).join(", ")}\nraised-first: ${raisedFirst}\n\nFrame before: The current blueprint omits this responsibility.\nReframe: Make the responsibility explicit.\n\nGeneral question: Which responsibility is still owned by the owner?\n`;
}

function wordRepository(t, words = archivedDirections) {
  const w = world(t, { clock });
  const records = w.repo(join(w.dir, "records"), { "records.json": "{}\n" }, priorCapture);
  const wordsCLI = (...args) => recordsCLI(w, records, "owner-words.mjs", ...args);
  const capture = () => {
    put(records, wordsPath, jsonl(...words));
    publish(w, records, "Import captured owner words");
  };
  return { w, records, wordsCLI, capture };
}

function proof({ w, records }, id, when) {
  put(records, `decisions/${id}.md`, `# ${id} Propose a roadmap for the lead's next feature\n\nid: ${id}\nby: lead\nstatus: active\n`);
  publish(w, records, `Record proposal ${id}`, when);
}

function stageIntervention({ w, records }, id, words, raisedFirst) {
  const path = `interventions/${id}.md`;
  put(records, path, intervention(id, words, raisedFirst));
  w.git(records, "add", "--", path);
  return check(w, records, "--write", "--json");
}

function rejectsProof(result, id, source) {
  assert.notEqual(result.status, 0, output(result));
  const { failures } = JSON.parse(result.stdout);
  assert.ok(failures.some(finding =>
    finding.path === `interventions/${id}.md` && JSON.stringify(finding).includes(source)), output(result));
}

function handoff(w, p, { round, step, phase: phaseName = "v1", time = clock, product = null, report = "" }) {
  const number = pad(round);
  const id = `R-${number}-${step}`;
  const record = `rounds/${number}-${step}.md`;
  const role = step.split("-")[0];
  const runner = role === "actor" ? "t3:codex" : "claude";
  put(p.records, record, `# ${id}\n\nphase: ${phaseName}\nrole: ${role}\n\n${report}\n`);
  return { id, round, phase: phaseName, role, step, time, product, record, attempt: 1,
    files: [record], view: w.git(p.records, "rev-parse", "HEAD"),
    audit: { violations: 0 }, agent: { runner, model: `fixture-${runner}` } };
}

function newPhase(w, name, options) {
  return phase({ ...w, run: (entry, args) => w.run(args, { entry }) }, name, options);
}

function count(value) {
  return Array.isArray(value) ? value.length : value;
}

function metricsFixture(t) {
  const w = world(t, { clock });
  const p = w.makeProduct({ name: "metrics", project: "metrics", phase: "v1", activityAt: priorCapture });
  const deprecated = ownerWord("W-0000000020", priorCapture, "Retain the old release note.");
  const citedOnly = ownerWord("W-0000000021", "2026-11-21T23:15:00Z", "Keep the acceptance rules visible.");
  const routine = ownerWord("W-0000000022", "2026-11-21T23:16:00Z", "继续");
  const notOwner = ownerWord("W-0000000023", "2026-11-21T23:17:00Z", "The harness echoed a go-ahead.");
  const pending = ownerWord("W-0000000024", "2026-11-21T23:19:00Z", "Give the rollout its own receipt.");
  const directions = [deprecated, ...archivedDirections, pending];
  const captured = [...directions, citedOnly, routine, notOwner, approval]
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  put(p.records, wordsPath, jsonl(...captured));
  put(p.records, marksPath, jsonl(
    ...directions.map((word, index) => ({ id: word.id, as: "direction", intervention: `I-000${index + 1}`, time: clock })),
    { id: approval.id, as: "answer", batch: third, time: clock },
    { id: routine.id, as: "routine", note: "Go-ahead", time: clock },
    { id: notOwner.id, as: "not-owner", note: "Harness echo", time: clock },
  ));
  put(p.records, "purpose/P-0004.md", `# P-0004 Show the phase conditions\n\nwords: ${citedOnly.id}\n`);
  put(p.records, handoffsPath, jsonl(
    handoff(w, p, { round: 1, step: "reviewer-frame", time: "2026-11-21T04:50:00Z" }),
    handoff(w, p, { round: 9, step: "reviewer-frame", phase: "v2", time: "2026-11-21T23:09:00Z" }),
  ));
  return { w, p, directions };
}

function nestedFields(object, prefix = "") {
  return Object.entries(object).flatMap(([key, value]) => {
    const field = (prefix + key).toLowerCase().replace(/[^a-z]/g, "");
    return value && typeof value === "object" && !Array.isArray(value)
      ? nestedFields(value, field) : [[field, value]];
  });
}

function metric(report, names, expected) {
  const fields = nestedFields(report);
  assert.ok(fields.some(([key, value]) => names.includes(key) && value === expected), json(report));
}

function interventionItems(text) {
  return itemsOf(text).filter(item => /intervention/i.test(item.title) && /disposition|rung|mechanism|carri/i.test(item.title));
}

function listedInterventions(text) {
  return [...new Set(interventionItems(text).flatMap(item => item.lines.join("\n").match(/I-\d{4}/g) ?? []))].sort();
}

roundCase("R8-G1-01", "ordered",
  "The lead records the blueprint, module review and dispatch directions with no prior proposal", "false-verdict", t => {
    const legacy = ownerWord("W-e5cdb8cfca", "2026-11-21T05:37:00Z", "那你搞啊，wish啊到目前为止不搞了呢");
    const s = wordRepository(t, [...archivedDirections, legacy]);
    s.capture();
    put(s.records, "interventions/I-0001.md", `# I-0001\n\nTime: 2026-11-21, Asia/Dubai\nwords: ${legacy.id}\n\nFrame before: The loop had no configuration.\nReframe: Give self-loop its own loop configuration.\n\nGeneral question: How does the loop advance without the owner asking?\n`);
    publish(s.w, s.records, "Import the historical intervention");
    for (const [index, word] of archivedDirections.entries()) {
      const id = `I-000${index + 2}`;
      status(stageIntervention(s, id, [word], "no"), 0);
      publish(s.w, s.records, `Record ${id}`);
    }
    status(check(s.w, s.records), 0);
  });

roundCase("R8-G1-02", "ordered",
  "The lead cites a written proposal in an intervention and checks its provenance before committing", "false-verdict", t => {
    const s = wordRepository(t);
    proof(s, "D-0001", "2026-11-21T04:52:28Z");
    s.capture();
    status(stageIntervention(s, "I-0001", [blueprint], "D-0001"), 0);
    publish(s.w, s.records, "Record the supported intervention");
    rejectsProof(stageIntervention(s, "I-0002", [dispatch], "D-9999"), "I-0002", "D-9999");
  });

roundCase("R8-G1-03", "fresh",
  "The lead cites a proposal written in the same Git second as an owner direction and checks an exact-second capture", "false-verdict", t => {
    const exact = ownerWord("W-0000000011", "2026-11-21T04:52:29Z", "Put the roadmap on record before designing.");
    const s = wordRepository(t, [blueprint, exact]);
    proof(s, "D-0001", "2026-11-21T04:52:29Z");
    s.capture();
    status(stageIntervention(s, "I-0001", [blueprint], "D-0001"), 0);
    publish(s.w, s.records, "Record evidence before the millisecond capture");
    rejectsProof(stageIntervention(s, "I-0002", [exact], "D-0001"), "I-0002", "D-0001");
  });

roundCase("R8-G1-04", "fresh",
  "The lead distills two owner prompts together and tries to credit a proposal written between them", "wrong-result", t => {
    const s = wordRepository(t);
    proof(s, "D-0001", "2026-11-21T23:10:00Z");
    s.capture();
    status(stageIntervention(s, "I-0001", [dispatch], "D-0001"), 0);
    publish(s.w, s.records, "Record the independently supported direction");
    rejectsProof(stageIntervention(s, "I-0002", [modules, dispatch], "D-0001"), "I-0002", "D-0001");
  });

roundCase("R8-G1-05", "fresh",
  "The lead marks a cited owner direction and asks whether the phase can close before filing its intervention", "false-verdict", t => {
    const w = world(t, { clock });
    const p = newPhase(w, "word-settlement");
    put(p.records, wordsPath, jsonl(modules));
    put(p.records, "purpose/P-0004.md", `# P-0004 Review module boundaries\n\nwords: ${modules.id}\n`);
    publish(w, p.records, "Distill the owner's module direction");
    const wordsCLI = (...args) => recordsCLI(w, p.records, "owner-words.mjs", ...args);
    const next = () => status(w.run(["next", "--config", p.config]), 0);
    assert.deepEqual(JSON.parse(status(wordsCLI("open", "--json"), 0)), []);
    status(wordsCLI("mark", "--id", modules.id, "--as", "direction", "--intervention", "I-0001"), 0);
    const result = wordsCLI("open", "--json");
    assert.deepEqual(JSON.parse(status(result, 2)).map(word => word.id), [modules.id]);
    assert.match(next(), /open words \(owner\/words\.jsonl/i);
    status(stageIntervention({ w, records: p.records }, "I-0001", [modules], "no"), 0);
    publish(w, p.records, "Record the intervention and regenerate views");
    assert.deepEqual(JSON.parse(status(wordsCLI("open", "--json"), 0)), []);
    assert.doesNotMatch(next(), /open words \(owner\/words\.jsonl/i);
  });

roundCase("R8-G1-06", "ordered",
  "The lead reads the metric for a phase with migrated citations, pending classification and inherited directions", "wrong-result", t => {
    const { w, p, directions } = metricsFixture(t);
    for (const [index, word] of directions.slice(0, -1).entries()) {
      const id = `I-000${index + 1}`;
      put(p.records, `interventions/${id}.md`, intervention(id, [word], "no"));
    }
    publish(w, p.records, "File the historical owner directions");
    const metrics = (...args) => JSON.parse(status(recordsCLI(w, p.records, "owner-words.mjs", "metrics", "--json", ...args), 0));
    for (const [report, expected] of [[metrics(), 3], [metrics("--phase", "v1"), 3], [metrics("--phase", "v2"), 1]]) {
      assert.equal(report.ownerDirections, expected, json(report));
      assert.equal(report.raisedFirst, 0, json(report));
      assert.equal(count(report.unclassified), 1, json(report));
    }
  });

roundCase("R8-G1-07", "fresh",
  "The lead compares precision after an amended recommendation, a legacy unlabelled answer and a still-open batch", "wrong-result", t => {
    const w = world(t, { clock });
    const p = w.makeProduct({ name: "precision", project: "precision", phase: "v1", activityAt: priorCapture });
    put(p.records, handoffsPath, jsonl(handoff(w, p, { round: 1, step: "reviewer-frame", time: priorCapture })));
    proof({ w, records: p.records }, "D-0001", "2026-11-21T04:52:28Z");
    put(p.records, wordsPath, jsonl(blueprint, modules));
    put(p.records, marksPath, jsonl(
      { id: blueprint.id, as: "direction", intervention: "I-0001", time: clock },
      { id: modules.id, as: "direction", intervention: "I-0002", time: clock },
    ));
    put(p.records, "interventions/I-0001.md", intervention("I-0001", [blueprint], "D-0001"));
    put(p.records, "interventions/I-0002.md", intervention("I-0002", [modules], "no"));
    for (const [id, title] of [[first, "Where do the records live?"], [second, "Which adapters are needed?"],
      [third, "When should the generative engine be built?"], ["B-0004", "Which feature starts after this phase?"]]) {
      put(p.records, `owner/${id}.md`, `# ${id} Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\n\n### 1. ${title}\nOptions: Now / Later\nRecommendation: Now\n`);
    }
    put(p.records, answersPath, jsonl(
      { batch: first, time: "2026-11-21T06:06:35Z", words: "同意，self-loop应该额外做一个repo，推送，且应该推送必须更新版本号，并挂在t3code中" },
      { batch: second, time: "2026-11-21T14:52:34Z", words: "我ok", outcome: "as-recommended" },
      { batch: third, time: approval.time, words: approval.text, outcome: "amended" },
    ));
    publish(w, p.records, "Replay the archived answers and file the open batch");
    const report = JSON.parse(status(recordsCLI(w, p.records, "owner-words.mjs", "metrics", "--json"), 0));
    assert.equal(report.ownerDirections, 2, json(report));
    assert.equal(report.raisedFirst, 1, json(report));
    metric(report, ["raisedfirstshare", "raisedfirstratio", "raisedfirstrate", "raisedshare", "shareraisedfirst", "share"], 0.5);
    metric(report, ["batchessent", "sentbatches", "ownerbatchessent", "sent"], 4);
    metric(report, ["batchesanswered", "answeredbatches", "ownerbatchesanswered", "answered"], 3);
    metric(report, ["answersasrecommended", "answersbyoutcomeasrecommended", "outcomesasrecommended",
      "answeroutcomesasrecommended", "batchesoutcomesasrecommended", "asrecommended"], 1);
    metric(report, ["answersamended", "answersbyoutcomeamended", "outcomesamended",
      "answeroutcomesamended", "batchesoutcomesamended", "amended"], 1);
    metric(report, ["precision", "proposalprecision", "batchprecision", "batchesprecision", "answerprecision"], 0.5);
  });

roundCase("R8-G1-08", "ordered",
  "The lead ties a captured reply to its answered batch so a reply is not left as an open direction", "false-verdict", t => {
    const s = wordRepository(t, [approval]);
    s.capture();
    const { w, records, wordsCLI } = s;
    put(records, "owner/B-0003.md", "# B-0003 Owner batch\n\nphase: v1\nfrom: R-0008-reviewer-frame\n\n### 1. When should the engine be built?\n");
    status(recordsCLI(w, records, "decisions.mjs", "answer", "--batch", third, "--words", approval.text), 0);
    publish(w, records, "File the recorded answer");
    assert.deepEqual(JSON.parse(status(wordsCLI("open", "--json"), 2)).map(word => word.id), [approval.id]);
    status(wordsCLI("mark", "--id", approval.id, "--as", "answer", "--batch", third), 0);
    assert.deepEqual(JSON.parse(status(wordsCLI("open", "--json"), 0)), []);
  });

test("R8-A1-01 ordered · flow: lead records three interventions, two without a disposition, then marks a word, prepares a critic and reads next · loss: stuck", t => {
  const f = mechanisms(t);
  const words = [1, 2, 3, 4].map(n => ownerWord(wordId(n), at(100 + n), `Owner correction ${n}: start the decided work now.`));
  put(f.p.records, wordsPath, jsonl(...words));
  put(f.p.records, marksPath, jsonl(...words.slice(0, 3).map((word, i) => ({ id: word.id, as: "direction", intervention: `I-000${i + 1}`, time: at(120) }))));
  put(f.p.records, "interventions/I-0001.md", interventionText("I-0001", [words[0].id], { raised: "no" }));
  put(f.p.records, "interventions/I-0002.md", interventionText("I-0002", [words[1].id], { raised: "no" }));
  put(f.p.records, "interventions/I-0003.md", interventionText("I-0003", [words[2].id], { raised: "no",
    rung: "construction", carried: "the registry and the 12 h stall check (F-0003, scripts/lib/tick.mjs)" }));
  f.publish("Record three interventions", at(130));
  status(f.w.run("owner-words.mjs", ["mark", "--records", f.p.records, "--id", words[3].id, "--as", "direction", "--intervention", "I-0001"], { at: at(140) }), 0);
  status(f.w.run("records-check.mjs", ["--repo", f.p.records], { at: at(150) }), 0);
  const critic = pkg("alpha", { role: "critic", round: 8, files: ["acceptance/alpha/**"] });
  f.prepare(critic, at(160));
  const text = f.next();
  assert.deepEqual(listedInterventions(text), ["I-0001", "I-0002"], text);
  const convergence = itemsOf(text).find(item => /convergence conditions not met/.test(item.title));
  assert.ok(convergence, text);
  assert.doesNotMatch(convergence.lines.join("\n"), /I-000\d|disposition|rung|carried-by/i);
});

test("R8-A1-02 fresh · flow: lead files interventions with partial dispositions, prose that names a rung, and an appended correction · loss: false-verdict", t => {
  const f = mechanisms(t);
  const words = [1, 2, 3, 4, 5, 6].map(n => ownerWord(wordId(n), at(100 + n), `Owner correction ${n}.`));
  put(f.p.records, wordsPath, jsonl(...words));
  put(f.p.records, marksPath, jsonl(...words.map((word, i) => ({ id: word.id, as: "direction", intervention: `I-000${i + 1}`, time: at(120) }))));
  const texts = {
    "I-0001": interventionText("I-0001", [words[0].id], { raised: "no", rung: "screening predicate" }),
    "I-0002": interventionText("I-0002", [words[1].id], { raised: "no", carried: "F-0012 A3" }),
    "I-0003": interventionText("I-0003", [words[2].id], { raised: "no", rung: "owner-only", carried: "none: the owner's taste in naming has no record to compute from" }),
    "I-0004": interventionText("I-0004", [words[3].id], { raised: "no", extra: [
      "Which rung carries it: a screening predicate, carried-by F-0012 once the plan records holds.",
      "rung of the ladder and carried-by pointer are still to be written."] }),
    "I-0005": interventionText("I-0005", [words[4].id], { raised: "no" }),
    "I-0006": interventionText("I-0006", [words[5].id], { raised: "no", rung: "", carried: "F-0011 item 2" }),
  };
  for (const [id, text] of Object.entries(texts)) put(f.p.records, `interventions/${id}.md`, text);
  f.publish("Record six interventions", at(130));
  const before = f.next({ when: at(200) });
  assert.deepEqual(listedInterventions(before), ["I-0001", "I-0002", "I-0004", "I-0005", "I-0006"], before);
  put(f.p.records, "interventions/I-0005.md", texts["I-0005"] + "rung: hard gate\ncarried-by: records-check.mjs raised-first (RECORDS.md, The owner's words)\n");
  f.publish("Append the disposition of I-0005", at(300));
  const after = f.next({ when: at(400) });
  assert.deepEqual(listedInterventions(after), ["I-0001", "I-0002", "I-0004", "I-0006"], after);
});

test("R8-A1-03 fresh · flow: lead backfills a long intervention log in which about half carry a disposition · loss: false-verdict", t => {
  const f = mechanisms(t);
  const draw = seeded(seed + 13);
  const total = 48 + draw(17);
  const words = Array.from({ length: total }, (_, i) => ownerWord(wordId(100 + i), at(100 + i), `Owner correction ${i}.`));
  put(f.p.records, wordsPath, jsonl(...words));
  put(f.p.records, marksPath, jsonl(...words.map((word, i) => ({ id: word.id, as: "direction", intervention: `I-${pad(i + 1)}`, time: at(200) }))));
  const pointers = ["F-0012 A3", "F-0011 item 2", "the registry and stall check", "none: a one-off preference of the owner", "D-0032 cadence"];
  const undisposed = [];
  for (let i = 0; i < total; i++) {
    const id = `I-${pad(i + 1)}`;
    const disposed = draw(2) === 0;
    if (!disposed) undisposed.push(id);
    put(f.p.records, `interventions/${id}.md`, interventionText(id, [words[i].id], disposed
      ? { raised: "no", rung: RUNGS[draw(RUNGS.length)], carried: pointers[draw(pointers.length)] } : { raised: "no" }));
  }
  f.publish("Backfill the intervention log", at(300));
  const text = f.next({ when: at(400) });
  assert.deepEqual(listedInterventions(text), undisposed.sort(), text);
});
