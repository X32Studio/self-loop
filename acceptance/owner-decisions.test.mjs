import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { json, jsonl, output, put, status, world } from "./fixture.mjs";

const clock = "2026-11-22T00:00:00.000Z";
const priorCapture = "2026-11-20T12:00:00.000Z";
const first = "B-0001";
const second = "B-0002";
const third = "B-0003";
const answersPath = "owner/answers.jsonl";
const approvalText = "1，除此以外，应该是从第一性的和语录的反推，让客观第三方做评价，agent as a judegement，确保推论和设计是合理的，符合意图。2，我同意。另外，生成引擎不应该只有event based，还应该有周期性的，比如三轮对抗一轮推进。另外，目前抵抗似乎有点过了，一直在局部打转，如果边际效益已经递减的很厉害，已经在钻牛角尖应该抽离推进新feature开发。";

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
    const originals = ["我ok", "  " + approvalText + "\n", "第一项。\n\n  但保留独立审查。", "同意"];
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
