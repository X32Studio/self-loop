import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { bytes } from "./closing-fixture.mjs";
import { has, json, output, put, status, world } from "./fixture.mjs";
import { now, product } from "./scenario.mjs";

const first = "B-0001";
const second = "B-0002";
const third = "B-0003";
const fourth = "B-0004";

function batchWorld(t) {
  const w = world(t);
  const p = w.makeProduct(product("questions", 1, { phase: "v1" }));
  const { records } = p;
  const run = (verb, ...args) => w.run([verb, "--records", records, ...args], {
    entry: "decisions.mjs", at: now,
  });
  const send = (expected, context) => {
    const file = put(w.dir, "questions.json", json([{
      question: "Which option applies to " + expected + "?",
      options: ["Proceed", "Defer"], recommendation: "Proceed", context,
    }]));
    has(status(run("send", "--file", file, "--phase", "v1", "--from", "lead"), 0), expected);
  };
  const answer = (batch, words = "Proceed as recommended.") =>
    status(run("answer", "--batch", batch, "--words", words), 0);
  const replace = (batch, by) => run("replace", "--batch", batch, "--by", by, "--note", "The newer answer settled it");
  const check = (write = false) => w.run(["--repo", records, ...(write ? ["--write"] : [])], {
    entry: "records-check.mjs",
  });
  const commit = () => {
    status(check(true), 0);
    w.commit(records, "Record owner batches");
  };
  const owners = () => Object.fromEntries(["owner/answers.jsonl", "owner/words.jsonl",
    ...[first, second, third, fourth].map(id => "owner/" + id + ".md")]
    .map(path => [path, bytes(join(records, path))]));
  const next = () => status(w.run(["next", "--config", p.config], { entry: "loop.mjs" }), 0);
  return { w, records, run, send, answer, replace, check, commit, owners, next };
}

const refusals = [
  ["01", "unknown original", "B-9999", second, /unknown|does not exist|not found|no such/i],
  ["02", "unknown replacement", first, "B-9999", /unknown|does not exist|not found|no such/i],
  ["03", "itself", first, first, /itself|same batch|different batch/i],
  ["04", "earlier replacement", third, second, /earlier|later|before|sent after|must follow/i],
  ["05", "unanswered replacement", first, third, /unanswered|not answered|must be answered/i],
  ["06", "already answered original", second, fourth, /already answered/i],
  ["07", "replacement text omits the original", first, fourth, /not named|not name|does not mention|not mentioned|must name/i],
];

function refusalWorld(t) {
  const s = batchWorld(t);
  s.send(first, "The opening question.");
  s.send(second, "Replaces B-0001, and names B-0003 for the order check.");
  s.send(third, "Replaces B-0001 when answered.");
  s.send(fourth, "The wording only replaces B-0002.");
  s.answer(second);
  s.answer(fourth);
  s.commit();
  return s;
}

for (const [id, reason, batch, by, diagnostic] of refusals) {
  test(`R5-BAT-${id} replace refuses ${reason} and writes nothing`, t => {
    const s = refusalWorld(t);
    const before = s.owners();
    const result = s.replace(batch, by);
    status(result, 2);
    assert.match(output(result), diagnostic);
    assert.deepEqual(s.owners(), before);
    assert.equal(s.w.git(s.records, "status", "--porcelain"), "");
  });
}

test("R5-BAT-08 a replaced batch cannot be replaced again", t => {
  const s = refusalWorld(t);
  status(s.replace(first, second), 0);
  s.answer(third);
  s.commit();
  const before = s.owners();
  const result = s.replace(first, third);
  status(result, 2);
  assert.match(output(result), /already replaced|replaced by/i);
  assert.deepEqual(s.owners(), before);
  assert.equal(s.w.git(s.records, "status", "--porcelain"), "");
});

test("R5-BAT-09 a valid replacement closes the original with no words and survives records-check", t => {
  const s = batchWorld(t);
  s.send(first, "The premise still needs a decision.");
  s.send(second, "The revised question supersedes B-0001.");
  s.answer(second, "Proceed with the revised plan.");
  s.commit();
  const before = s.owners();
  assert.match(s.next(), /open owner batches: B-0001/);
  status(s.replace(first, second), 0);
  const after = s.owners();
  for (const path of ["owner/words.jsonl", "owner/B-0001.md", "owner/B-0002.md"]) {
    assert.deepEqual(after[path], before[path], path);
  }
  // A replacement can be represented in the same append-only ledger as answers.
  // Existing owner answers still have exactly their original words and attribution.
  for (const [index, byte] of before["owner/answers.jsonl"].entries()) {
    assert.equal(after["owner/answers.jsonl"][index], byte);
  }
  for (const line of after["owner/answers.jsonl"].toString().trimEnd().split("\n")) {
    const event = JSON.parse(line);
    if (event.batch === first) assert.ok(!event.words?.trim(), "a replacement records no owner words");
  }
  for (const args of [[], ["--phase", "v1"]]) {
    const text = status(s.run("status", ...args), 0);
    has(text, "B-0001 replaced by B-0002");
    assert.match(text, /^B-0002 answered/m);
    assert.doesNotMatch(text, /^B-0001 open/m);
  }
  s.commit();
  status(s.check(), 0);
  assert.doesNotMatch(s.next(), /open owner batches:/);
});
