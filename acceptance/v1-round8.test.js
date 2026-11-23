import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonl, output, put, status, world, writeGh } from "./fixture.mjs";
import { argsFor, greenCheck, phase } from "./round6-b-fixture.mjs";
import { hostMeasurement } from "./round7-b-fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const clock = "2026-11-22T00:00:00.000Z";
const first = "B-0001";
const second = "B-0002";
const third = "B-0003";
const wordsPath = "owner/words.jsonl";
const marksPath = "owner/word-marks.jsonl";
const answersPath = "owner/answers.jsonl";
const handoffsPath = "metrics/handoffs.jsonl";
const trajectoryPath = "metrics/trajectory.jsonl";
const convergence = /recorded convergence checks are satisfied/i;
const cadenceDue = /advancing round due/i;

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

function ownerWord(id, time, text) {
  return { id, time, text, source: "codex", session: "fixture-owner", ordinal: 1 };
}

function roundCase(id, label, flow, loss, body) {
  test(`${id} [${label}] flow: ${flow} | loss: ${loss}`, body);
}

function recordsCLI(w, records, entry, verb, ...args) {
  return w.run([verb, "--records", records, ...args], { entry, at: clock });
}

function check(w, records, ...args) {
  return w.run(["--repo", records, ...args], { entry: "records-check.mjs", at: clock });
}

function publish(w, records, message, at = clock) {
  w.git(records, "add", "-A");
  status(check(w, records, "--write"), 0);
  return w.commit(records, message, at);
}

function intervention(id, words, raisedFirst) {
  return `# ${id}\n\nTime: 2026-11-21, Asia/Dubai\nwords: ${words.map(word => word.id).join(", ")}\nraised-first: ${raisedFirst}\n\nFrame before: The current blueprint omits this responsibility.\nReframe: Make the responsibility explicit.\n\nGeneral question: Which responsibility is still owned by the owner?\n`;
}

function wordRepository(t, words = archivedDirections) {
  const w = world(t, { clock });
  const records = w.repo(join(w.dir, "records"), {
    "records.json": "{}\n",
  }, priorCapture);
  const wordsCLI = (...args) => recordsCLI(w, records, "owner-words.mjs", ...args);
  const capture = () => {
    put(records, wordsPath, jsonl(...words));
    publish(w, records, "Import captured owner words");
  };
  return { w, records, wordsCLI, capture };
}

function proof({ w, records }, id, at) {
  put(records, `decisions/${id}.md`, `# ${id} Propose a roadmap for the lead's next feature\n\nid: ${id}\nby: lead\nstatus: active\n`);
  publish(w, records, `Record proposal ${id}`, at);
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

function newPhase(w, name, options) {
  return phase({ ...w, run: (entry, args) => w.run(args, { entry }) }, name, options);
}

function appendHandoffs(w, p, entries) {
  const contents = readFileSync(join(p.records, handoffsPath), "utf8");
  put(p.records, handoffsPath, contents + jsonl(...entries.map(entry => handoff(w, p, entry))));
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

function cadenceWorld(t, { adversarial } = {}) {
  const w = world(t, { clock });
  const p = newPhase(w, "cadence", { files: {
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
  const at = words.findIndex(word => /(?:^|\/)call\.mjs$/.test(word));
  if (at < 0) return null;
  const [, role, ...rest] = words.slice(at + 1);
  const flag = name => rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined;
  return { role, step: flag("--step") ?? role, round: flag("--round") };
}

function assertDue(text, expectedRounds) {
  const lines = text.split("\n");
  const due = lines.findIndex(line => cadenceDue.test(line));
  assert.ok(due >= 0, text);
  const end = lines.findIndex((line, i) => i > due && /^\s*- /u.test(line));
  const block = lines.slice(due, end < 0 ? undefined : end).join("\n");
  assert.match(block, new RegExp(`\\b${expectedRounds.length}\\b`));
  for (const round of expectedRounds) assert.match(block, new RegExp(`\\b0*${round}\\b`));
  const calls = lines.map(callLine);
  const steps = ["reviewer-frame-blind", "reviewer-frame", "judge-frame"].map(step =>
    calls.findIndex((call, i) => i > due && call?.step === step));
  assert.ok(steps[0] > due && steps[1] > steps[0] && steps[2] > steps[1], text);
  const worker = calls.findIndex(call => ["critic", "actor"].includes(call?.role) && call.round !== undefined);
  assert.ok(worker < 0 || worker > steps[2], text);
  return block;
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

function decisionWorld(t) {
  const w = world(t, { clock });
  const p = w.makeProduct({ name: "intent", project: "intent", phase: "v1", activityAt: priorCapture });
  put(p.records, "purpose/P-0004.md", "# P-0004 Review the module boundary\n\nstatus: active\n");
  put(p.records, "purpose/P-0005.md", "# P-0005 Establish the engine cadence\n\nstatus: active\n");
  publish(w, p.records, "Record the two owner requirements");
  const run = (...args) => recordsCLI(w, p.records, "decisions.mjs", ...args);
  const file = raw => put(w.dir, "decisions.json", json(raw));
  const validate = raw => w.run(["validate", file(raw)], { entry: "decisions.mjs" });
  const send = (raw, phaseName = "v1") => run("send", "--file", file(raw), "--phase", phaseName, "--from", "R-0008-reviewer-frame");
  const list = () => readdirSync(join(p.records, "owner")).sort();
  return { w, p, run, validate, send, list };
}

function intent() {
  const options = ["现在", "放到 v2", "只先建计数"];
  const whyAsked = "记录、代码和第一性分析不能决定所有者愿意怎样分配本阶段的时间。";
  return {
    kind: "intent",
    requirement: "P-0004",
    questions: [
      { question: "生成引擎什么时候建？", options, recommendation: options[0], whyAsked },
      { question: "第二阶段何时启动？", options, recommendation: options[0], whyAsked },
      { question: "意图拷问怎么进行？", options, recommendation: options[0], whyAsked, dependsOn: 1,
        ifOther: { "放到 v2": "在 v2 开始时先确认依赖", "只先建计数": "先对齐计数口径" } },
      { question: "谁来批准推进？", options, recommendation: options[0], whyAsked },
    ],
  };
}

const invalidIntents = [
  ["01", "ordered", "a question with no reason the loop needs the owner", raw => { delete raw.questions[2].whyAsked; }, /whyAsked|why asked/i],
  ["02", "ordered", "a question depending on a later question", raw => { raw.questions[1].dependsOn = 3; }, /dependsOn|dependenc/i],
  ["03", "ordered", "a question depending on an absent question", raw => { raw.questions[2].dependsOn = 99; }, /dependsOn|dependenc/i],
  ["04", "ordered", "a conditional recommendation for a nonexistent option", raw => { raw.questions[2].ifOther["把设计移交"] = "重新分包"; }, /ifOther|把设计移交|option/i],
  ["09", "fresh", "conditional recommendations with no dependency", raw => { delete raw.questions[2].dependsOn; }, /dependsOn|dependenc|ifOther/i],
];

for (const [id, label, problem, mutate, diagnostic] of invalidIntents) {
  roundCase(`R8-G3-${id}`, label,
    `The lead validates a frame reviewer's intent proposal containing ${problem}`, "wrong-result", t => {
      const s = decisionWorld(t);
      status(s.validate(intent()), 0);
      const raw = intent();
      mutate(raw);
      const result = s.validate(raw);
      assert.notEqual(result.status, 0, output(result));
      assert.match(output(result), diagnostic);
      const refused = s.send(raw);
      assert.notEqual(refused.status, 0, output(refused));
      assert.match(output(refused), diagnostic);
      assert.equal(s.w.git(s.p.records, "status", "--porcelain"), "");
    });
}

roundCase("R8-G3-05", "fresh",
  "The lead sends a dependency-ordered batch and the owner reads the path for each alternate choice", "wrong-result", t => {
    const s = decisionWorld(t);
    const raw = intent();
    status(s.send(raw), 0);
    const batch = readFileSync(join(s.p.records, "owner", first + ".md"), "utf8");
    assert.match(batch, /P-0004/);
    const questionStarts = raw.questions.map(q => batch.indexOf(q.question));
    assert.ok(questionStarts.every((start, index) => start >= 0 && (index === 0 || start > questionStarts[index - 1])), batch);
    for (const [index, start] of questionStarts.entries()) {
      const section = batch.slice(start, questionStarts[index + 1]);
      assert.ok(section.includes(raw.questions[index].whyAsked), section);
      for (const [option, recommendation] of Object.entries(raw.questions[index].ifOther ?? {})) {
        const lines = section.split("\n");
        const line = lines.findIndex(text => text.includes(recommendation));
        assert.ok(line >= 0 && (lines[line].includes(option) || lines[line - 1]?.includes(option)), section);
      }
    }
  });

roundCase("R8-G3-06", "ordered",
  "The lead tries a third intent batch after two sends and can still ask another requirement or phase", "false-verdict", t => {
    const s = decisionWorld(t);
    const raw = intent();
    const firstQuestion = raw.questions[0];
    const legacy = [{ question: firstQuestion.question, options: firstQuestion.options, recommendation: firstQuestion.recommendation }];
    status(s.send(legacy), 0);
    status(s.send(raw), 0);
    status(s.run("answer", "--batch", second, "--words", "我ok"), 0);
    status(s.send(raw), 0);
    publish(s.w, s.p.records, "File the answered batch and its intent follow-up");
    const before = s.list();
    const refusal = s.send(raw);
    status(refusal, 2);
    assert.match(output(refusal), /P-0004/);
    assert.deepEqual(s.list(), before);
    assert.equal(s.w.git(s.p.records, "status", "--porcelain"), "");
    status(s.send({ ...raw, requirement: "P-0005" }), 0);
    status(s.send(raw, "v2"), 0);
    assert.equal(s.list().filter(name => /^B-\d{4}\.md$/.test(name)).length, 5);
  });

roundCase("R8-G3-07", "fresh",
  "The lead records the owner's verbatim answers, including line breaks, with all supported outcome labels", "data", t => {
    const s = decisionWorld(t);
    const outcomes = ["as-recommended", "amended", "other", undefined];
    const originals = ["我ok", "  " + approval.text + "\n", "第一项。\n\n  但保留独立审查。", "同意"];
    for (const [index, outcome] of outcomes.entries()) {
      const id = `B-000${index + 1}`;
      status(s.send(intent(), "phase-" + (index + 1)), 0);
      status(s.run("answer", "--batch", id, "--words", originals[index], ...(outcome ? ["--outcome", outcome] : [])), 0);
    }
    const events = readFileSync(join(s.p.records, answersPath), "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.words), originals);
    assert.deepEqual(events.map(event => event.outcome), outcomes);
    const text = status(s.run("status"), 0);
    for (const event of events) {
      const start = text.indexOf(event.batch + " ");
      const section = text.slice(start).split(/\n(?=B-\d{4} )/, 1)[0];
      assert.ok(start >= 0, text);
      assert.match(section, /\banswered\b/i);
      if (event.outcome) assert.ok(section.includes(event.outcome), text);
    }
    publish(s.w, s.p.records, "File all answer outcomes");
    status(check(s.w, s.p.records), 0);
  });

roundCase("R8-G3-08", "fresh",
  "The lead corrects a mistyped outcome before filing the owner's answer", "wrong-result", t => {
    const s = decisionWorld(t);
    status(s.send(intent()), 0);
    status(s.send(intent()), 0);
    const words = "2，我同意。";
    status(s.run("answer", "--batch", first, "--words", words), 0);
    const path = join(s.p.records, answersPath);
    const before = readFileSync(path);
    const invalid = s.run("answer", "--batch", second, "--words", words, "--outcome", "recommended");
    assert.notEqual(invalid.status, 0, output(invalid));
    assert.match(output(invalid), /outcome/i);
    assert.deepEqual(readFileSync(path), before);
    status(s.run("answer", "--batch", second, "--words", words, "--outcome", "as-recommended"), 0);
    assert.match(status(s.run("status"), 0), /^B-0002 answered[^\n]*\bas-recommended\b/m);
  });
