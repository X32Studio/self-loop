// D-0015, D-0031, design/generative-engine-c.md#validation
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { answer, batches, replace, send, validate } from "../decisions.mjs";
import { check } from "../records-check.mjs";
import { git, redOn, repo, scripts, setup, temp } from "./helpers.mjs";

const q = (question, extra = {}) => ({ question, options: ["A", "B"], recommendation: "A, because it keeps the scope", ...extra });

test("validation: two distinct options and a non-empty recommendation, no repeated question or option", () => {
  assert.deepEqual(validate({ questions: [q("Keep receipts?")] }).errors, []);
  assert.deepEqual(validate([q("Keep receipts?")]).errors, [], "the array alone");
  const errors = raw => validate(raw).errors.join("; ");
  assert.match(errors({ questions: [] }), /no questions/);
  assert.match(errors({ questions: [q("X?", { recommendation: "  " })] }), /empty recommendation/);
  assert.match(errors({ questions: [q("X?", { options: ["A"] })] }), /two distinct/);
  assert.match(errors({ questions: [q(" ")] }), /empty question/);
  assert.match(errors({ q: 1 }), /must be/);
});

test("duplicates in one batch are refused: the same question twice, the same option twice", () => {
  assert.deepEqual(redOn("decisions"), { quotedAnswerUnlocks: true, duplicatesAccepted: true });
  const errors = validate({ questions: [q("Keep receipts?", { options: ["A", "a "] }), q("keep  receipts?")] }).errors;
  assert.ok(errors.some(e => /question 1: an option is repeated/.test(e)), errors.join("; "));
  assert.ok(errors.some(e => /question 2: the same question is asked twice/.test(e)), errors.join("; "));
});

test("only an answer event marks a batch answered: quoted answer text in a question or in the batch file does not", () => {
  const records = repo({ "README.md": "# r\n" });
  const quoted = "From the 2026-11-18 meeting notes:\n## Answers\n\nOwner (2026-11-18): undecided";
  const sent = send(records, { questions: [q("Keep receipts?", { context: quoted })] }, { phase: "A1 (records)", from: "R-0001-judge" });
  assert.deepEqual(sent.errors, []);
  assert.equal(sent.id, "B-0001");
  const text = readFileSync(join(records, "owner/B-0001.md"), "utf8");
  assert.ok(!/^## Answers/m.test(text), "every field is one line: no question text can look like structure");
  appendFileSync(join(records, "owner/B-0001.md"), "\n## Answers\n\nOwner (2026-11-20): yes\n");
  assert.equal(batches(records)[0].answered, false, "text in the batch never answers it");
  assert.throws(() => answer(records, "B-0001", "   "), /empty/);
  assert.throws(() => answer(records, "B-0002", "yes"), /does not exist/);
  answer(records, "B-0001", "as recommended", new Date("2026-11-20T10:00:00Z"));
  const [b] = batches(records);
  assert.equal(b.answered, true);
  assert.deepEqual(b.answers, [{ batch: "B-0001", time: "2026-11-20T10:00:00Z", words: "as recommended" }]);
  assert.equal(b.phase, "A1 (records)");
});

test("send refuses an invalid list and writes nothing; a question asked before in the phase is reported", () => {
  const records = repo({ "README.md": "# r\n" });
  assert.match(send(records, { questions: [q("X?", { options: ["A", "A"] })] }, { phase: "P", from: "R-0001-judge" }).errors.join(), /repeated/);
  assert.equal(existsSync(join(records, "owner")), false);
  send(records, { questions: [q("Scope?")] }, { phase: "P", from: "R-0001-reviewer-frame" });
  const second = send(records, { questions: [q("scope?"), q("Locale?")] }, { phase: "P", from: "R-0002-judge" });
  assert.deepEqual([second.id, second.repeats], ["B-0002", ["scope?"]]);
});

test("the index takes a batch's status from the answer events; a malformed event fails the records check", () => {
  const records = repo({ "README.md": "# r\n" });
  send(records, { questions: [q("Scope?")] }, { phase: "P", from: "R-0001-judge" });
  send(records, { questions: [q("Locale?")] }, { phase: "P", from: "R-0002-judge" });
  appendFileSync(join(records, "owner/B-0001.md"), "\n## Answers\n\nOwner (2026-11-20): yes\n");
  answer(records, "B-0002", "B");
  git(records, "add", "-A");
  const index = (check(records, { write: true }), readFileSync(join(records, "INDEX.md"), "utf8"));
  assert.match(index, /B-0001 \| `owner\/B-0001\.md` \| B-0001 Owner batch \| open \|/);
  assert.match(index, /B-0002 \| `owner\/B-0002\.md` \| B-0002 Owner batch \| answered \|/);
  writeFileSync(join(records, "owner/answers.jsonl"), "{\"batch\":\"B-0001\",\"words\":\"\"}\n");
  assert.ok(check(records, { write: true }).failures.some(f => f.rule === "answers"));
});

test("CLI: validate exits 1 on an invalid list, 0 on a valid one; answer records verbatim words", () => {
  const dir = temp();
  const file = join(dir, "d.json");
  const cli = (...a) => spawnSync(process.execPath, [join(scripts, "decisions.mjs"), ...a], { encoding: "utf8" });
  writeFileSync(file, JSON.stringify({ questions: [q("X?", { recommendation: "" })] }));
  assert.equal(cli("validate", file).status, 1);
  writeFileSync(file, JSON.stringify({ questions: [q("X?")] }));
  assert.equal(cli("validate", file).status, 0);
  writeFileSync(join(dir, "bad.json"), "{");
  assert.equal(cli("validate", join(dir, "bad.json")).status, 1);
  const records = repo({ "README.md": "# r\n" });
  assert.equal(cli("send", "--records", records, "--file", file, "--phase", "P", "--from", "R-0001-judge").status, 0);
  assert.equal(cli("answer", "--records", records, "--batch", "B-0001", "--words", "").status, 64);
  assert.equal(cli("answer", "--records", records, "--batch", "B-0001", "--words", "A, as recommended").status, 0);
  assert.match(cli("status", "--records", records).stdout, /B-0001 answered/);
});

// D-0015

const decisionsCli = (...a) => spawnSync(process.execPath, [join(scripts, "decisions.mjs"), ...a], { encoding: "utf8" });
const ledger = records => (existsSync(join(records, "owner/answers.jsonl")) ? readFileSync(join(records, "owner/answers.jsonl"), "utf8") : "");

function replacedWorld() {
  const records = repo({ "README.md": "# r\n" });
  send(records, { questions: [q("Which adapters?")] }, { phase: "v1", from: "R-0001-reviewer-frame" });
  send(records, { questions: [q("Which adapters, now that Codex hooks exist?", { context: "Replaces B-0001, whose options predate D-0012." })] }, { phase: "v1", from: "R-0002-judge" });
  send(records, { questions: [q("Scope (B-0001 again)?")] }, { phase: "v1", from: "R-0003-judge" });
  send(records, { questions: [q("Locale?", { context: "Unrelated to B-00010 and AB-0001." })] }, { phase: "v1", from: "R-0004-judge" });
  answer(records, "B-0002", "as recommended", new Date("2026-11-21T10:00:00Z"));
  answer(records, "B-0004", "A", new Date("2026-11-21T10:05:00Z"));
  return records;
}

test("replace closes a batch through the later, answered batch that names it, with no owner words for it", () => {
  const records = replacedWorld();
  const result = decisionsCli("replace", "--records", records, "--batch", "B-0001", "--by", "B-0002", "--note", "B-0002 re-asked\nwith the D-0012 options");
  assert.equal(result.status, 0, result.stderr);
  const events = ledger(records).trim().split("\n").map(l => JSON.parse(l));
  assert.deepEqual(events.at(-1), { batch: "B-0001", time: events.at(-1).time, replacedBy: "B-0002", note: "B-0002 re-asked with the D-0012 options" });
  assert.ok(events.every(e => e.batch !== "B-0001" || !("words" in e)), "no owner words are written for the replaced batch");
  const [b1] = batches(records);
  assert.deepEqual([b1.answered, b1.answers, b1.replacedBy], [true, [], "B-0002"]);
  for (const args of [[], ["--phase", "v1"]]) {
    const status = decisionsCli("status", "--records", records, ...args).stdout;
    assert.match(status, /^B-0001 replaced by B-0002 {2}phase v1/m);
    assert.match(status, /^B-0002 answered/m);
    assert.match(status, /^B-0003 open/m);
  }
  git(records, "add", "-A");
  const state = check(records, { write: true });
  assert.deepEqual(state.failures, []);
  assert.match(readFileSync(join(records, "INDEX.md"), "utf8"), /B-0001 \| `owner\/B-0001\.md` \| B-0001 Owner batch \| replaced by B-0002 \|/);
});

test("replace refuses, with the reason and nothing written: unknown, itself, earlier, unanswered, already closed, not named", () => {
  const records = replacedWorld();
  const refused = (batch, by, reason) => {
    const before = ledger(records);
    const r = decisionsCli("replace", "--records", records, "--batch", batch, "--by", by);
    assert.equal(r.status, 2, `${batch} by ${by}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, reason);
    assert.equal(ledger(records), before, "nothing written");
  };
  refused("B-0009", "B-0002", /unknown batch B-0009/);
  refused("B-0001", "B-0009", /unknown batch B-0009/);
  refused("B-0001", "B-0001", /cannot replace itself/);
  refused("B-0002", "B-0001", /B-0001 was sent before B-0002/);
  refused("B-0001", "B-0003", /B-0003 is not answered/);
  refused("B-0002", "B-0004", /B-0002 is already answered/);
  refused("B-0001", "B-0004", /B-0004 does not name B-0001/);
  assert.equal(replace(records, "B-0001", "B-0002").problem, undefined);
  answer(records, "B-0003", "B");
  refused("B-0001", "B-0003", /B-0001 was already replaced by B-0002/);
  assert.equal(decisionsCli("replace", "--records", records, "--batch", "B-1", "--by", "B-0002").status, 64);
  assert.equal(decisionsCli("replace", "--records", records, "--batch", "B-0001").status, 64);
});

test("the records check refuses a replacement written by hand that replace would refuse, and one carrying words", () => {
  const records = replacedWorld();
  git(records, "add", "-A");
  for (const [line, reason] of [
    [{ batch: "B-0001", time: "2026-11-21T11:00:00Z", replacedBy: "B-0003" }, /B-0003 is not answered/],
    [{ batch: "B-0001", time: "2026-11-21T11:00:00Z", replacedBy: "B-0002", words: "yes" }, /carries no words/],
  ]) {
    const kept = ledger(records);
    writeFileSync(join(records, "owner/answers.jsonl"), kept + JSON.stringify(line) + "\n");
    const failures = check(records, { write: true }).failures.filter(f => f.rule === "answers");
    assert.ok(failures.some(f => reason.test(f.detail)), JSON.stringify(failures));
    writeFileSync(join(records, "owner/answers.jsonl"), kept);
  }
  assert.equal(replace(records, "B-0001", "B-0002").problem, undefined);
  answer(records, "B-0001", "and keep the shell wrapper out");
  assert.deepEqual(check(records, { write: true }).failures, []);
  assert.equal(batches(records)[0].answers.length, 1);
});

test("next's convergence check counts a replaced batch as closed", async () => {
  const s = await setup({});
  const config = join(s.dir, "loop.json");
  writeFileSync(config, JSON.stringify(s.cfg));
  writeFileSync(join(s.dir, "gh"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(s.dir, "gh"), 0o755);
  const next = () => spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", config],
    { encoding: "utf8", env: { ...process.env, PATH: `${s.dir}:${process.env.PATH}` } });
  send(s.records, { questions: [q("Scope?")] }, { phase: "S5", from: "R-0001-reviewer-frame" });
  send(s.records, { questions: [q("Scope, replacing B-0001?")] }, { phase: "S5", from: "R-0002-judge" });
  answer(s.records, "B-0002", "as recommended");
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "batches");
  const open = next();
  assert.equal(open.status, 0, open.stderr);
  assert.match(open.stdout, /open owner batches: B-0001 /);
  assert.equal(replace(s.records, "B-0001", "B-0002").problem, undefined);
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "replace B-0001");
  const closed = next();
  assert.equal(closed.status, 0, closed.stderr);
  assert.doesNotMatch(closed.stdout, /open owner batches/);
});

const why = "the records and the code cannot tell how the owner wants to spend this phase";
const intentBatch = (extra = {}) => ({ kind: "intent", requirement: "P-0005", questions: [
  q("When is the engine built?", { options: ["now", "in v2", "counts only"], recommendation: "now", whyAsked: why }),
  q("How is intent grilled?", { options: ["one batch", "live"], recommendation: "one batch", whyAsked: why, dependsOn: 1,
    ifOther: { "In  V2": "live, at the start of v2" } }),
  q("Who approves the advance?", { whyAsked: why }),
], ...extra });
const errorsOf = raw => validate(raw).errors.join("; ");
const mutated = change => { const raw = intentBatch(); change(raw); return raw; };

test("flow: lead validates unresolved intent choices before sending; loss: false-verdict; requirement, reasons and backward option dependencies", () => {
  const valid = validate(intentBatch());
  assert.deepEqual(valid.errors, []);
  assert.deepEqual([valid.kind, valid.requirement], ["intent", "P-0005"]);
  assert.deepEqual(valid.questions[1].ifOther, [{ option: "in v2", recommendation: "live, at the start of v2" }]);
  assert.deepEqual([valid.questions[1].dependsOn, valid.questions[0].dependsOn], [1, null]);
  assert.deepEqual([validate([q("X?")]).kind, validate({ questions: [q("X?")] }).requirement], [null, null]);
  for (const [change, reason] of [
    [raw => { delete raw.questions[2].whyAsked; }, /question 3: an intent question needs whyAsked/],
    [raw => { raw.questions[0].whyAsked = "  "; }, /question 1: an intent question needs whyAsked/],
    [raw => { delete raw.requirement; }, /names the requirement it grills/],
    [raw => { raw.requirement = "F-0011"; }, /names the requirement it grills/],
    [raw => { raw.requirement = "P-5"; }, /names the requirement it grills/],
    [raw => { raw.kind = "grill"; }, /kind must be "intent" or absent/],
    [raw => { raw.questions[1].dependsOn = 2; }, /question 2: dependsOn 2 is not an earlier question/],
    [raw => { raw.questions[1].dependsOn = 3; }, /question 2: dependsOn 3 is not an earlier question/],
    [raw => { raw.questions[1].dependsOn = 0; }, /question 2: dependsOn 0 names no question/],
    [raw => { raw.questions[1].dependsOn = 99; }, /question 2: dependsOn 99 names no question/],
    [raw => { raw.questions[1].dependsOn = "1"; }, /question 2: dependsOn "1" names no question/],
    [raw => { raw.questions[1].dependsOn = 1.5; }, /names no question/],
    [raw => { delete raw.questions[1].dependsOn; }, /question 2: ifOther needs dependsOn/],
    [raw => { raw.questions[1].ifOther = { "in v3": "live" }; }, /ifOther key "in v3" is not an option of question 1/],
    [raw => { raw.questions[1].ifOther = { "one batch": "live" }; }, /ifOther key "one batch" is not an option of question 1/],
    [raw => { raw.questions[1].ifOther = { "in v2": "live", "IN V2": "one batch" }; }, /names option "IN V2" of question 1 twice/],
    [raw => { raw.questions[1].ifOther = { "in v2": " " }; }, /ifOther "in v2" needs the recommendation that follows/],
    [raw => { raw.questions[1].ifOther = {}; }, /ifOther maps options/],
    [raw => { raw.questions[1].ifOther = ["in v2"]; }, /ifOther maps options/],
  ]) assert.match(errorsOf(mutated(change)), reason);
  assert.match(errorsOf({ requirement: "P-0005", questions: [q("X?")] }), /"requirement" belongs to an intent batch/);
  assert.deepEqual(validate({ questions: [q("X?"), q("Y?", { dependsOn: 1, ifOther: { B: "B too" } })] }).errors, [], "any batch may carry a dependency");
  assert.match(errorsOf({ questions: [q("X?", { dependsOn: 1 })] }), /question 1: dependsOn 1 is not an earlier question/);
  assert.match(errorsOf({ questions: [q("X?", { whyAsked: 3 })] }), /whyAsked must be text/);
  assert.deepEqual(validate(mutated(raw => { raw.questions[1].dependsOn = null; delete raw.questions[1].ifOther; })).errors, [], "null is no dependency");
});

test("flow: owner reads dependent choices sent by the lead; loss: wrong-result; batch preserves reasons and conditional recommendations", () => {
  const records = repo({ "purpose/P-0005.md": "# P-0005\n" });
  const sent = send(records, intentBatch(), { phase: "v1", from: "R-0008-reviewer-frame" });
  assert.deepEqual([sent.errors, sent.intent], [[], { requirement: "P-0005", earlier: [], recorded: true }]);
  const textOf = readFileSync(join(records, "owner/B-0001.md"), "utf8");
  assert.match(textOf, /^phase: v1\nfrom: R-0008-reviewer-frame\nkind: intent\nrequirement: P-0005\n\n/m);
  assert.match(textOf, /^Intent batch 1 of at most 2 for P-0005 in this phase\./m);
  assert.match(textOf, /### 2\. How is intent grilled\?\nWhy asked: the records[^\n]*\nDepends on: question 1\nOptions: one batch \/ live\nRecommendation: one batch\nIf question 1 is answered "in v2": live, at the start of v2\n/);
  assert.equal(textOf.match(/^Why asked: /gm).length, 3);
  const [b] = batches(records);
  assert.deepEqual([b.kind, b.requirement, b.questions.length], ["intent", "P-0005", 3]);
  const plain = repo({ "README.md": "# r\n" });
  send(plain, { questions: [q("Keep receipts?", { context: "c", costOfWaiting: "w" })] }, { phase: "v1", from: "R-0001-judge" });
  assert.equal(readFileSync(join(plain, "owner/B-0001.md"), "utf8"), [
    "# B-0001 Owner batch", "", "phase: v1", "from: R-0001-judge", "",
    "Each question carries the loop's recommendation; answering \"as recommended\" is enough. The answer is recorded verbatim with `node scripts/decisions.mjs answer --records <records> --batch B-0001 --words \"<the owner's words>\"`.", "",
    "### 1. Keep receipts?", "Context: c", "Options: A / B", "Recommendation: A, because it keeps the scope", "Cost of waiting: w", ""].join("\n"), "an ordinary batch keeps its text");
  assert.deepEqual([batches(plain)[0].kind, batches(plain)[0].requirement], [null, null]);
});

test("flow: lead sends intent and follow-up batches across requirements and phases; loss: false-verdict; third intent batch alone is refused", () => {
  const dir = temp();
  const records = repo({ "purpose/P-0005.md": "# P-0005\n" });
  const file = raw => { const path = join(dir, "d.json"); writeFileSync(path, JSON.stringify(raw)); return path; };
  const sendCli = (raw, phase = "v1") => decisionsCli("send", "--records", records, "--file", file(raw), "--phase", phase, "--from", "R-0008-reviewer-frame");
  assert.equal(sendCli({ questions: [q("Ordinary?")] }).status, 0);
  const firstIntent = sendCli(intentBatch());
  assert.equal(firstIntent.status, 0, firstIntent.stderr);
  assert.doesNotMatch(firstIntent.stdout, /screening/);
  const followUp = sendCli(intentBatch());
  assert.equal(followUp.status, 0, followUp.stderr);
  assert.match(followUp.stdout, /screening: follow-up intent batch for P-0005 after B-0002; no further intent batch for it in phase v1/);
  assert.match(readFileSync(join(records, "owner/B-0003.md"), "utf8"), /^Intent batch 2 of at most 2 for P-0005/m);
  assert.doesNotMatch(readFileSync(join(records, "owner/B-0003.md"), "utf8"), /B-0002/, "a follow-up does not name the batch it follows");
  answer(records, "B-0003", "as recommended");
  assert.equal(replace(records, "B-0002", "B-0003").problem, "B-0003 does not name B-0002: a replacing batch says which batch it replaces");
  const before = readdirSync(join(records, "owner")).sort();
  const third = sendCli(intentBatch());
  assert.equal(third.status, 2);
  assert.match(third.stderr, /refused: phase v1 already holds 2 intent batches for P-0005 \(B-0002, B-0003\): one batch and at most one follow-up per requirement; nothing written/);
  assert.deepEqual(readdirSync(join(records, "owner")).sort(), before);
  assert.equal(sendCli({ questions: [q("Ordinary again?")] }).status, 0, "an ordinary batch is not counted");
  const other = sendCli(intentBatch({ requirement: "P-0006" }));
  assert.equal(other.status, 0);
  assert.match(other.stdout, /screening: P-0006 has no record purpose\/P-0006\.md in the records/);
  assert.equal(sendCli(intentBatch(), "v2").status, 0, "another phase");
  assert.equal(sendCli(intentBatch(), " v1 ").status, 2, "the phase is compared as stored");
  assert.equal(sendCli(mutated(raw => { delete raw.questions[0].whyAsked; })).status, 1, "an invalid list is refused as before");
});

test("flow: lead records and inspects a multilingual owner answer with an outcome; loss: data; verbatim words and distinct outcome survive", () => {
  const records = repo({ "README.md": "# r\n" });
  for (const phase of ["p1", "p2", "p3", "p4"]) send(records, intentBatch(), { phase, from: "R-0008-reviewer-frame" });
  const ledgerOf = () => ledger(records);
  const words = "  1，除此以外，让客观第三方做评价。\n\n2，我同意。\n";
  for (const [batch, outcome] of [["B-0001", "as-recommended"], ["B-0002", "amended"], ["B-0003", "other"]]) {
    const r = decisionsCli("answer", "--records", records, "--batch", batch, "--words", words, "--outcome", outcome);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { batch, time: JSON.parse(r.stdout).time, words, outcome });
    assert.doesNotMatch(r.stderr, /screening/);
  }
  const plain = decisionsCli("answer", "--records", records, "--batch", "B-0004", "--words", "同意");
  assert.equal(plain.status, 0);
  assert.equal("outcome" in JSON.parse(plain.stdout), false);
  assert.match(plain.stderr, /screening: no --outcome/);
  const kept = ledgerOf();
  for (const bad of [["--outcome", "recommended"], ["--outcome"], ["--outcome", "As-Recommended"]]) {
    const r = decisionsCli("answer", "--records", records, "--batch", "B-0004", "--words", "again", ...bad);
    assert.equal(r.status, 64, r.stderr);
    assert.match(r.stderr, /--outcome must be one of as-recommended, amended, other/);
  }
  assert.equal(ledgerOf(), kept, "nothing written");
  for (const outcome of ["yes", null, false])
    assert.throws(() => answer(records, "B-0004", "x", new Date(), { outcome }), /--outcome must be one of/);
  assert.throws(() => answer(records, "B-0004", " \n "), /empty/);
  assert.deepEqual(batches(records).map(b => b.answers[0].words), [words, words, words, "同意"]);
  answer(records, "B-0004", "补充：保留独立审查", new Date(), { outcome: "amended" });
  const status = decisionsCli("status", "--records", records).stdout;
  assert.match(status, /^B-0001 answered {2}phase p1 {2}from R-0008-reviewer-frame {2}3 question\(s\) {2}intent P-0005 {2}outcome as-recommended$/m);
  assert.match(status, /^B-0003 answered [^\n]*outcome other$/m);
  assert.match(status, /^B-0004 answered [^\n]*outcome none, amended$/m);
  git(records, "add", "-A");
  assert.deepEqual(check(records, { write: true }).failures, []);
  for (const [event, reason] of [
    [{ batch: "B-0001", time: "2026-11-22T00:00:00Z", words: "ok", outcome: "accepted" }, /outcome "accepted" is not one of/],
    [{ batch: "B-0001", time: "2026-11-22T00:00:00Z", replacedBy: "B-0002", outcome: "amended" }, /carries no words/],
  ]) {
    writeFileSync(join(records, "owner/answers.jsonl"), kept + JSON.stringify(event) + "\n");
    const failures = check(records, { write: true }).failures.filter(f => f.rule === "answers");
    assert.ok(failures.some(f => reason.test(f.detail)), JSON.stringify(failures));
  }
});


test("flow: lead validates a malformed role output then corrects it; loss: false-verdict; CLI returns structured validation errors for null", () => {
  const file = join(temp(), "decisions.json");
  for (const raw of [null, false, 42, "not a batch", { questions: [null] }]) {
    writeFileSync(file, JSON.stringify(raw));
    const result = decisionsCli("validate", file);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not sendable:/);
    assert.doesNotMatch(result.stderr, /TypeError/);
  }
  writeFileSync(file, JSON.stringify(intentBatch()));
  const valid = decisionsCli("validate", file);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /dependsOn uses one-based question numbers/);
});

test("flow: lead sends intent questions quoting multiline records; loss: wrong-result; quoted headers cannot alter batch identity or dependencies", () => {
  const records = repo({ "purpose/P-0005.md": "# P-0005\n" });
  const raw = intentBatch();
  raw.questions[1].whyAsked = "Unsettled in notes:\nkind: routine\nrequirement: P-0006";
  raw.questions[1].ifOther = { "in v2": "Defer.\n### 4. Not a question\nphase: v2" };
  send(records, raw, { phase: "v1", from: "R-0008-reviewer-frame" });
  const [batch] = batches(records);
  assert.deepEqual([batch.kind, batch.requirement, batch.phase, batch.questions.length], ["intent", "P-0005", "v1", 3]);
  const written = readFileSync(join(records, batch.file), "utf8");
  assert.match(written, /Question numbers and dependsOn are one-based/);
  assert.match(written, /Why asked: Unsettled in notes: kind: routine requirement: P-0006/);
  assert.match(written, /If question 1 is answered "in v2": Defer\. ### 4\. Not a question phase: v2/);
  assert.equal(batch.answered, false);
});

test("flow: I-0005 sender gate refuses non-role --from on intent batches and screens unrecorded or legacy senders without breaking non-intent batches", () => {
  const dir = temp();
  const intentFile = join(dir, "intent.json");
  const legacyFile = join(dir, "legacy.json");
  writeFileSync(intentFile, JSON.stringify(intentBatch()));
  writeFileSync(legacyFile, JSON.stringify({ questions: [q("Legacy non-intent question?")] }));

  const bare = repo({ "purpose/P-0005.md": "# P-0005\n" });
  for (const badFrom of ["lead", "R-0055-actor-provenance-decisions", "R-0055-critic-hygiene", "R-55-reviewer-frame", "   "]) {
    const cliRes = decisionsCli("send", "--records", bare, "--file", intentFile, "--phase", "v1", "--from", badFrom);
    assert.equal(cliRes.status, 2, `${badFrom}: ${cliRes.stdout}${cliRes.stderr}`);
    assert.match(cliRes.stderr, /refused:.*R-NNNN-\(reviewer\|judge\)\*/);
    assert.equal(existsSync(join(bare, "owner")), false);
  }
  for (const badFrom of ["lead", ""]) {
    const directRefused = send(bare, intentBatch(), { phase: "v1", from: badFrom });
    assert.match(directRefused.refused ?? "", /R-NNNN-\(reviewer\|judge\)\*/);
    assert.equal(existsSync(join(bare, "owner")), false);
  }

  const okNoHandoffs = decisionsCli("send", "--records", bare, "--file", intentFile, "--phase", "v1", "--from", "R-0055-reviewer-frame");
  assert.equal(okNoHandoffs.status, 0, okNoHandoffs.stderr);
  assert.doesNotMatch(okNoHandoffs.stderr, /screening:/);
  assert.equal(existsSync(join(bare, "owner/B-0001.md")), true);

  const okJudgeNoHandoffs = decisionsCli("send", "--records", bare, "--file", intentFile, "--phase", "v1", "--from", "R-0055-judge-frame-hygiene");
  assert.equal(okJudgeNoHandoffs.status, 0, okJudgeNoHandoffs.stderr);
  assert.doesNotMatch(okJudgeNoHandoffs.stderr, /screening:/);

  const legacyOnBare = decisionsCli("send", "--records", bare, "--file", legacyFile, "--phase", "v1", "--from", "lead");
  assert.equal(legacyOnBare.status, 0, legacyOnBare.stderr);
  assert.match(legacyOnBare.stderr, /screening:.*does not match a reviewer\/judge hand-off/);
  assert.equal(existsSync(join(bare, "owner/B-0003.md")), true);

  const withHandoffs = repo({
    "purpose/P-0005.md": "# P-0005\n",
    "metrics/handoffs.jsonl": JSON.stringify({ id: "R-0055-reviewer-frame", role: "reviewer" }) + "\n",
  });
  const missingRole = decisionsCli("send", "--records", withHandoffs, "--file", intentFile, "--phase", "v1", "--from", "R-0055-reviewer-other");
  assert.equal(missingRole.status, 0, missingRole.stderr);
  assert.match(missingRole.stderr, /screening: --from R-0055-reviewer-other has no recorded hand-off in metrics\/handoffs\.jsonl/);

  const presentRole = decisionsCli("send", "--records", withHandoffs, "--file", intentFile, "--phase", "v1", "--from", "R-0055-reviewer-frame");
  assert.equal(presentRole.status, 0, presentRole.stderr);
  assert.doesNotMatch(presentRole.stderr, /screening:/);

  const legacyMissing = decisionsCli("send", "--records", withHandoffs, "--file", legacyFile, "--phase", "v1", "--from", "R-0055-reviewer-other");
  assert.equal(legacyMissing.status, 0, legacyMissing.stderr);
  assert.match(legacyMissing.stderr, /screening: --from R-0055-reviewer-other has no recorded hand-off in metrics\/handoffs\.jsonl/);

  const legacyPresent = decisionsCli("send", "--records", withHandoffs, "--file", legacyFile, "--phase", "v1", "--from", "R-0055-reviewer-frame");
  assert.equal(legacyPresent.status, 0, legacyPresent.stderr);
  assert.doesNotMatch(legacyPresent.stderr, /screening:/);
});
