import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { metricsLines, ownerWaiting, phaseMetrics, phaseWindow, waitingText } from "../lib/owner-metrics.mjs";
import { appendWords, markProblem, wordClasses } from "../lib/owner-words.mjs";
import { inspect, interventionClaim, interventionDisposition, openWords, raisedFirstFindings, RUNGS } from "../records-check.mjs";
import { repo, scripts } from "./helpers.mjs";

const IDS = /(?<![\w-])(?:D-\d{4}|I-\d{4}|R-\d{4}-[a-z]+)(?![\w-])/g;
const word = (n, time) => ({ id: `W-${String(n).padStart(10, "0")}`, time, source: "claude", session: "s", text: `word ${n}`, sha256: "fixture" });

function commitAt(dir, time, files, message = "records") {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", message], { env: { ...process.env, GIT_COMMITTER_DATE: time, GIT_AUTHOR_DATE: time } });
}

const ownerWords = (r, ...argv) => spawnSync(process.execPath, [join(scripts, "owner-words.mjs"), ...argv, "--records", r], { encoding: "utf8" });
const handoff = (round, step, phase, time) => ({ id: `R-${String(round).padStart(4, "0")}-${step}`, time, phase, round, step, role: step.split("-")[0],
  attempt: 1, agent: { runner: "claude" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, files: [`rounds/${String(round).padStart(4, "0")}-${step}.md`],
  record: `rounds/${String(round).padStart(4, "0")}-${step}.md` });
const raisedFailures = s => s.failures.filter(f => f.rule === "raised-first");

test("G1 marks: a direction names its intervention, an answer its batch; the latest valid mark is the word's one class (flow: the lead classifies an owner word and later corrects it; loss: wrong-result, a direction counted as routine for good)", () => {
  assert.equal(markProblem({ id: "W-1", as: "direction" }), "--as direction needs --intervention I-NNNN");
  assert.equal(markProblem({ id: "W-1", as: "answer", batch: "B-0001", intervention: "I-0001" }), "--intervention belongs to --as direction");
  assert.equal(markProblem({ id: "W-1", as: "routine", batch: "B-0001" }), "--batch belongs to --as answer");
  assert.equal(markProblem({ id: "W-1", as: "maybe" }), "--as must be direction, answer, routine, not-owner");
  assert.equal(markProblem({ id: "W-1", as: "routine" }), null);
  const classes = wordClasses([{ id: "W-1", as: "routine", note: "x" }, { id: "W-1", as: "direction" }, { id: "W-1", as: "direction", intervention: "I-0002" }]);
  assert.deepEqual(classes.get("W-1"), { id: "W-1", as: "direction", intervention: "I-0002" });
});

test("G1 claim: the last raised-first line holds; no is no; IDs are read from the value (flow: the lead appends a correction to an append-only intervention; loss: stuck, a wrong claim that cannot be withdrawn)", () => {
  assert.deepEqual(interventionClaim("# I-0001\n\nwords: W-0000000001, W-0000000002\n", IDS), { words: ["W-0000000001", "W-0000000002"], value: undefined, named: undefined });
  assert.equal(interventionClaim("raised-first: D-0001\n\nraised-first: no, the owner was first\n", IDS).named, null);
  assert.deepEqual(interventionClaim("raised-first: D-0001 (item 2), R-0003-judge\n", IDS).named, ["D-0001", "R-0003-judge"]);
  assert.deepEqual(interventionClaim("raised-first: nobody\n", IDS).named, []);
});

test("G1 settlement: a direction word stays open until its intervention is committed, even when a record cites it (flow: the owner gives a direction the lead distils into a purpose record; loss: false-verdict, convergence with the intervention never written)", () => {
  const w = word(1, "2020-11-21T00:00:00Z");
  const r = repo({ "README.md": "records\n" });
  appendWords(r, [w]);
  commitAt(r, "2020-11-21T01:00:00Z", { "purpose/P-0001.md": `# P-0001\n\nwords: ${w.id}\n` });
  assert.deepEqual(openWords(r), []);
  assert.equal(ownerWords(r, "mark", "--id", w.id, "--as", "direction").status, 64);
  const marked = ownerWords(r, "mark", "--id", w.id, "--as", "direction", "--intervention", "I-0001");
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stderr, /stays open until its intervention I-0001 is committed/);
  assert.deepEqual(openWords(r).map(x => x.id), [w.id]);
  assert.match(inspect(r).screening.find(f => f.rule === "open-owner-word").detail, /direction word; its intervention I-0001 is not recorded/);
  assert.match(ownerWords(r, "open").stdout, /\(direction: I-0001 not recorded\)$/m);
  assert.equal(ownerWords(r, "mark", "--id", w.id, "--as", "direction", "--intervention", "I-0001").status, 64, "the same class again changes nothing");
  mkdirSync(join(r, "interventions"), { recursive: true });
  writeFileSync(join(r, "interventions/I-0001.md"), `# I-0001\n\nwords: ${w.id}\nraised-first: no\n`);
  assert.deepEqual(openWords(r).map(x => x.id), [w.id], "a draft cannot settle the word");
  commitAt(r, "2020-11-21T02:00:00Z", { "interventions/I-0001.md": `# I-0001\n\nwords: ${w.id}\nraised-first: no\n` });
  assert.deepEqual(openWords(r), []);
  assert.equal(ownerWords(r, "open").status, 0);
});

test("G1 mark at the command line: routine needs a reason, an answer needs a sent batch (flow: the lead settles an answer to a batch; loss: wrong-result, an answer linked to no batch)", () => {
  const r = repo({ "README.md": "records\n", "owner/B-0001.md": "# B-0001 Owner batch\n\nphase: v1\nfrom: R-0001-judge\n" });
  const [a, b] = [word(1, "2020-11-21T00:00:00Z"), word(2, "2020-11-21T00:01:00Z")];
  appendWords(r, [a, b]);
  assert.equal(ownerWords(r, "mark", "--id", a.id, "--as", "routine").status, 64);
  assert.equal(ownerWords(r, "mark", "--id", a.id, "--as", "answer", "--batch", "B-0002").status, 64);
  assert.equal(ownerWords(r, "mark", "--id", a.id, "--as", "answer", "--batch", "B-0001").status, 0);
  assert.equal(ownerWords(r, "mark", "--id", b.id, "--as", "routine", "--note", "a go-ahead").status, 0);
  assert.equal(ownerWords(r, "mark", "--id", b.id, "--as", "not-owner", "--note", "the lead's echo").status, 0, "a reclassification is appended");
  assert.deepEqual(openWords(r), []);
});

test("G1 raised first is proven by commit order (flow: the lead records that the loop had a direction on record before the owner said it; loss: false-verdict, a raised-first share the records do not support)", () => {
  const early = word(1, "2020-11-21T00:00:00Z"), late = word(2, "2020-11-22T00:00:00Z"), older = word(3, "2020-11-19T00:00:00Z");
  const r = repo({ "README.md": "records\n" });
  appendWords(r, [early, late, older]);
  commitAt(r, "2020-11-20T00:00:00Z", { "decisions/D-0001.md": "# D-0001\n" });
  commitAt(r, "2020-11-21T00:00:00Z", { "decisions/D-0002.md": "# D-0002\n" });
  const interventions = {
    "interventions/I-0001.md": `# I-0001\n\nwords: ${late.id}\nraised-first: D-0001\n`,
    "interventions/I-0002.md": `# I-0002\n\nwords: ${older.id}\nraised-first: D-0001\n`,
    "interventions/I-0003.md": `# I-0003\n\nwords: ${late.id}\nraised-first: D-0099\n`,
    "interventions/I-0004.md": `# I-0004\n\nwords: ${older.id}\nraised-first: no\n`,
    "interventions/I-0005.md": `# I-0005\n\nwords: ${early.id}\nraised-first: D-0002\n`,
    "interventions/I-0006.md": `# I-0006\n\nwords: ${late.id}\nraised-first: maybe\n`,
    "interventions/I-0007.md": `# I-0007\n\nwords: ${late.id}\n`,
  };
  commitAt(r, "2020-11-22T01:00:00Z", interventions);
  const s = inspect(r);
  assert.deepEqual(raisedFailures(s).map(f => f.path), ["interventions/I-0002.md", "interventions/I-0003.md", "interventions/I-0005.md", "interventions/I-0006.md"]);
  assert.match(raisedFailures(s)[0].detail, /D-0001 was first committed at 2020-11-20T00:00:00Z \([0-9a-f]{12}\), not before W-0000000003 \(captured 2020-11-19T00:00:00Z\)/);
  assert.match(raisedFailures(s)[2].detail, /not before W-0000000001/, "equal timestamps do not prove strict priority");
  assert.deepEqual(s.screening.filter(f => f.rule === "raised-first").map(f => f.path), ["interventions/I-0007.md"]);
  commitAt(r, "2020-11-22T02:00:00Z", {
    "interventions/I-0002.md": interventions["interventions/I-0002.md"] + "\nraised-first: no\n",
    "interventions/I-0003.md": interventions["interventions/I-0003.md"] + "\nraised-first: D-0001\n",
  });
  assert.deepEqual(raisedFailures(inspect(r)).map(f => f.path), ["interventions/I-0005.md", "interventions/I-0006.md"], "an appended line corrects the claim");
  const checked = spawnSync(process.execPath, [join(scripts, "records-check.mjs"), "--repo", r, "--write"], { encoding: "utf8" });
  assert.equal(checked.status, 1, checked.stdout);
  assert.match(checked.stdout, /raised-first/);
});

test("G1 raised first covers the direction words marked to an intervention and refuses an uncommitted record (flow: the lead links a direction word that the intervention's words: line omits; loss: false-verdict, a claim checked against the wrong word)", () => {
  const direction = word(1, "2020-11-20T12:00:00Z"), quoted = word(2, "2020-11-22T00:00:00Z");
  const r = repo({ "README.md": "records\n" });
  appendWords(r, [direction, quoted]);
  commitAt(r, "2020-11-21T00:00:00Z", { "decisions/D-0001.md": "# D-0001\n" });
  assert.equal(ownerWords(r, "mark", "--id", direction.id, "--as", "direction", "--intervention", "I-0001").status, 0);
  commitAt(r, "2020-11-22T01:00:00Z", { "interventions/I-0001.md": `# I-0001\n\nwords: ${quoted.id}\nraised-first: D-0001\n` });
  assert.match(raisedFailures(inspect(r))[0]?.detail ?? "", /not before W-0000000001/);
  mkdirSync(join(r, "decisions"), { recursive: true });
  writeFileSync(join(r, "decisions/D-0002.md"), "# D-0002\n");
  writeFileSync(join(r, "interventions/I-0002.md"), `# I-0002\n\nwords: ${quoted.id}\nraised-first: D-0002\n`);
  execFileSync("git", ["-C", r, "add", "-A"]);
  assert.ok(raisedFailures(inspect(r)).some(f => f.path === "interventions/I-0002.md" && /has no commit/.test(f.detail)));
});

test("G1 phase window: from the phase's first hand-off to now (flow: the lead reports a phase while another phase has started; loss: wrong-result, a later hand-off silently truncates the declared window)", () => {
  const handoffs = [handoff(1, "reviewer-frame", "v0", "2020-11-01T00:00:00Z"), handoff(2, "reviewer-frame", "v1", "2020-11-10T00:00:00Z"),
    handoff(3, "judge", "v1", "2020-11-12T00:00:00Z"), handoff(4, "reviewer-frame", "v2", "2020-11-20T00:00:00Z")];
  assert.deepEqual(phaseWindow(handoffs, "v1"), { from: "2020-11-10T00:00:00Z", to: null, start: "R-0002-reviewer-frame", end: null });
  assert.deepEqual(phaseWindow(handoffs, "v2"), { from: "2020-11-20T00:00:00Z", to: null, start: "R-0004-reviewer-frame", end: null });
  assert.deepEqual(phaseWindow(handoffs, "v9"), { from: null, to: null, start: null, end: null });
});

test("G1 metrics: settled owner directions, the share raised first, batches, answer outcomes, precision, unclassified and open words of the phase (flow: the lead reports the phase's owner interventions while one direction still awaits its intervention; loss: wrong-result, an engine acceptance computed by hand or a pending direction counted as settled while the class tally calls it open)", () => {
  const words = [word(1, "2020-11-09T00:00:00Z"), word(2, "2020-11-11T00:00:00Z"), word(3, "2020-11-12T00:00:00Z"), word(4, "2020-11-13T00:00:00Z"),
    word(5, "2020-11-14T00:00:00Z"), word(6, "2020-11-15T00:00:00Z"), word(7, "2020-11-16T00:00:00Z"), word(8, "2020-11-16T12:00:00Z"),
    word(9, "2020-11-19T00:00:00Z")];
  const lines = [handoff(1, "reviewer-frame", "v1", "2020-11-10T00:00:00Z"), handoff(2, "reviewer-frame", "v2", "2020-11-18T00:00:00Z")];
  const r = repo({ "README.md": "records\n", "loop.json": JSON.stringify({ phase: "v1" }) + "\n",
    "metrics/handoffs.jsonl": lines.map(h => JSON.stringify(h)).join("\n") + "\n", "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n", "rounds/0002-reviewer-frame.md": "# R-0002-reviewer-frame\n",
    "owner/B-0001.md": "# B-0001 Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n",
    "owner/B-0002.md": "# B-0002 Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n",
    "owner/B-0003.md": "# B-0003 Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n",
    "owner/B-0004.md": "# B-0004 Owner batch\n\nphase: v0\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n",
    "owner/answers.jsonl": [{ batch: "B-0001", time: "2020-11-12T00:00:00Z", words: "as recommended", outcome: "as-recommended" },
      { batch: "B-0002", time: "2020-11-13T00:00:00Z", words: "yes, but", outcome: "amended" },
      { batch: "B-0004", time: "2020-11-13T00:00:00Z", words: "older phase", outcome: "as-recommended" }].map(a => JSON.stringify(a)).join("\n") + "\n" });
  appendWords(r, words);
  commitAt(r, "2020-11-08T00:00:00Z", { "decisions/D-0001.md": "# D-0001\n" });
  for (const [w, i] of [[words[1], "I-0001"], [words[2], "I-0002"], [words[3], "I-0003"], [words[7], "I-0004"], [words[8], "I-0005"]])
    assert.equal(ownerWords(r, "mark", "--id", w.id, "--as", "direction", "--intervention", i).status, 0);
  assert.equal(ownerWords(r, "mark", "--id", words[4].id, "--as", "answer", "--batch", "B-0001").status, 0);
  assert.equal(ownerWords(r, "mark", "--id", words[0].id, "--as", "routine", "--note", "before the phase").status, 0);
  commitAt(r, "2020-11-17T00:00:00Z", {
    "interventions/I-0001.md": `# I-0001\n\nwords: ${words[1].id}\nraised-first: D-0001\n`,
    "interventions/I-0002.md": `# I-0002\n\nwords: ${words[2].id}\nraised-first: no\n`,
    "interventions/I-0004.md": `# I-0004\n\nwords: ${words[7].id}\nraised-first: D-0002\n`,
    "interventions/I-0005.md": `# I-0005\n\nwords: ${words[8].id}\nraised-first: D-0001\n`,
    "decisions/D-0002.md": "# D-0002\n",
    "purpose/P-0001.md": `# P-0001\n\nwords: ${words[5].id}\n`,
  });
  const m = phaseMetrics(r);
  assert.equal(m.phase, "v1");
  assert.equal(m.words, 8, "a later phase does not truncate the requested window");
  assert.deepEqual(m.classes, { direction: 4, answer: 1, routine: 0, "not-owner": 0, unclassified: 1, open: 2 });
  assert.deepEqual([m.ownerDirections, m.raisedFirst, m.raisedFirstShare], [4, 2, 2 / 4]);
  assert.deepEqual(m.directions.map(d => [d.id, d.raisedFirst, d.verified]),
    [[words[1].id, ["D-0001"], true], [words[2].id, "no", false], [words[7].id, ["D-0002"], false], [words[8].id, ["D-0001"], true]]);
  assert.match(m.directions[2].problems[0], /D-0002 was first committed at 2020-11-17T00:00:00Z/);
  assert.deepEqual(m.awaitingIntervention, [{ id: words[3].id, intervention: "I-0003" }]);
  assert.deepEqual([m.batchesSent, m.batchesAnswered], [3, 2]);
  assert.deepEqual(m.answersByOutcome, { "as-recommended": 1, amended: 1, other: 0, unlabelled: 0 });
  assert.equal(m.precision, 0.5);
  assert.equal(m.unclassified, 1);
  assert.deepEqual(m.unclassifiedWords, [words[5].id]);
  assert.deepEqual(m.openWords, [words[3].id, words[6].id]);
  const json = ownerWords(r, "metrics", "--json");
  assert.equal(json.status, 0, json.stderr);
  const timeless = value => ({ ...value, ownerWaiting: { ...value.ownerWaiting, intervals: value.ownerWaiting.intervals.map(i => i.state === "open" ? { ...i, to: "now", seconds: "accruing" } : i) } });
  assert.deepEqual(timeless(JSON.parse(json.stdout)), timeless(JSON.parse(JSON.stringify(m))));
  const text = ownerWords(r, "metrics", "--phase", "v1");
  assert.match(text.stdout, /^ownerDirections 4$/m);
  assert.match(text.stdout, /^raisedFirst 2 \(50% of owner directions; a named record committed before every cited word\)$/m);
  assert.match(text.stdout, new RegExp(`^open 2, not counted until settled: ${words[3].id} \\(direction, I-0003 not recorded\\), ${words[6].id}$`, "m"));
  assert.match(text.stdout, /^precision 50% \(1 as-recommended \/ 2 answered with an outcome\)$/m);
  assert.equal(phaseMetrics(r, "v0").words, 0, "a phase with no hand-off has no window");
  assert.deepEqual([phaseMetrics(r, "v2").words, phaseMetrics(r, "v2").raisedFirst], [1, 1]);
});

test("G1 metrics needs a phase: --phase, else the committed loop.json (flow: the lead runs metrics on records without a loop; loss: wrong-result, a silent count of no phase)", () => {
  const r = repo({ "README.md": "records\n" });
  assert.equal(ownerWords(r, "metrics").status, 64);
  assert.equal(ownerWords(r, "metrics", "--phase", "v1", "--json").status, 0);
});

const claimFindings = (text, words, first = { sha: "a".repeat(40), time: Date.parse("2020-11-20T00:00:00Z") / 1000 }) => raisedFirstFindings({
  interventions: [{ path: "interventions/I-0001.md", id: "I-0001", text }],
  states: words.map(word => ({ word })), ids: new Map([["D-0001", "decisions/D-0001.md"]]), idRegex: IDS,
  firstCommit: () => first,
});

test("all cited words participate in priority (flow: the lead cites an earlier correction in intervention prose; loss: false-verdict, a header-only check credits a later record)", () => {
  const early = word(1, "2020-11-19T00:00:00Z"), late = word(2, "2020-11-21T00:00:00Z");
  const result = claimFindings(`words: ${late.id}\nThe earlier correction was ${early.id}.\nraised-first: D-0001\n`, [early, late]);
  assert.equal(result.claims.get("I-0001").verified, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].detail, /W-0000000001/);
});

test("unknown capture evidence is screened without credit (flow: an intervention cites words from another product ledger; loss: wrong-result, unavailable evidence inflates raised-first share)", () => {
  const known = word(1, "2020-11-21T00:00:00Z");
  const claim = `words: ${known.id}, W-0000000002\nraised-first: D-0001\n`;
  for (const words of [[known], [known, word(2, "unknown")]]) {
    const result = claimFindings(claim, words);
    assert.equal(result.claims.get("I-0001").verified, false);
    assert.equal(result.failures.length, 0);
    assert.equal(result.screening.length, 1);
  }
  const unread = raisedFirstFindings({ interventions: [{ path: "interventions/I-0001.md", id: "I-0001", text: `words: ${known.id}\nraised-first: D-0001\n` }],
    states: [{ word: known }], ids: new Map([["D-0001", "decisions/D-0001.md"]]), idRegex: IDS, firstCommit: () => undefined });
  assert.equal(unread.claims.get("I-0001").verified, false);
  assert.equal(unread.failures.length, 0);
  assert.equal(unread.screening.length, 1);
});

test("priority uses strict timestamp order (flow: the lead cites a record committed before a millisecond-resolution capture; loss: false-verdict, an extra second of padding refuses a valid claim)", () => {
  for (const [capture, verified] of [["2020-11-20T00:00:00.500Z", true], ["2020-11-20T00:00:00Z", false], ["2020-11-19T23:59:59Z", false]]) {
    const w = word(1, capture);
    const result = claimFindings(`words: ${w.id}\nraised-first: D-0001\n`, [w]);
    assert.equal(result.claims.get("I-0001").verified, verified);
    assert.equal(result.failures.length, verified ? 0 : 1);
  }
});

test("missing priority evidence and zero observations have explicit results (flow: the lead measures a phase before its first hand-off; loss: wrong-result, invented ratios or draft words enter the report)", () => {
  const r = repo({ "README.md": "records\n", "loop.json": JSON.stringify({ phase: "v1" }) + "\n" });
  appendWords(r, [word(1, "2020-11-20T00:00:00Z")]);
  const m = phaseMetrics(r);
  assert.equal(m.words, 0);
  assert.equal(m.ownerDirections, 0);
  assert.equal(m.raisedFirstShare, null);
  assert.equal(m.precision, null);
  assert.equal(m.answeredWithOutcome, 0);
  assert.match(ownerWords(r, "metrics").stdout, /precision n\/a/);
});

test("replacement closures are not owner answers (flow: the lead replaces a batch, records an unlabelled answer and measures precision; loss: wrong-result, closure events inflate owner answer counts)", () => {
  const batches = Object.fromEntries([1, 2, 3].map(n => [`owner/B-000${n}.md`, `# B-000${n} Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\nB-0001\n`]));
  const r = repo({ "README.md": "records\n", ...batches,
    "owner/answers.jsonl": [
      { batch: "B-0002", time: "2020-11-20T00:00:00Z", words: "yes", outcome: "as-recommended" },
      { batch: "B-0001", time: "2020-11-20T01:00:00Z", replacedBy: "B-0002" },
      { batch: "B-0003", time: "2020-11-20T02:00:00Z", words: "a legacy answer" },
      { batch: "B-0003", time: "2020-11-20T03:00:00Z", words: "another answer", outcome: "other" },
    ].map(e => JSON.stringify(e)).join("\n") + "\n" });
  const m = phaseMetrics(r, "v1");
  assert.deepEqual([m.batchesSent, m.batchesAnswered, m.answeredWithOutcome], [3, 2, 2]);
  assert.deepEqual(m.answersByOutcome, { "as-recommended": 1, amended: 0, other: 1, unlabelled: 1 });
  assert.equal(m.precision, 0.5);
});

test("scoped hand-offs screen unrelated historical claims (flow: an actor records work while another intervention needs correction; loss: stuck, an unrelated records fault blocks the hand-off)", () => {
  const r = repo({ "README.md": "records\n", "interventions/I-0001.md": "# I-0001\n\nraised-first: D-0099\n" });
  assert.equal(raisedFailures(inspect(r)).length, 1);
  const scoped = inspect(r, { own: ["README.md"] });
  assert.equal(raisedFailures(scoped).length, 0);
  assert.equal(scoped.screening.filter(f => f.rule === "raised-first" && /which no record carries/.test(f.detail)).length, 1);
});

test("metrics use committed capture times within the inclusive window (flow: the lead captures words before and during a phase and leaves a draft record; loss: wrong-result, future words or draft classifications enter the report)", () => {
  const start = "2020-11-20T00:00:00Z";
  const h = handoff(1, "reviewer-frame", "v1", start);
  const r = repo({ "README.md": "records\n", "loop.json": JSON.stringify({ phase: "v1" }) + "\n",
    "metrics/handoffs.jsonl": JSON.stringify(h) + "\n", [h.record]: `# ${h.id}\n` });
  const before = word(1, "2020-11-19T23:59:59.999Z"), boundary = word(2, start), future = word(3, "2999-01-01T00:00:00Z");
  appendWords(r, [before, boundary, future]);
  mkdirSync(join(r, "purpose"), { recursive: true });
  writeFileSync(join(r, "purpose/P-0001.md"), `# P-0001\n\nwords: ${boundary.id}\n`);
  const m = phaseMetrics(r);
  assert.equal(m.words, 1);
  assert.equal(m.unclassified, 0);
  assert.deepEqual(m.openWords, [boundary.id]);
});

test("not-owner corrections exclude captured deputy messages without rewriting words (flow: transcript sync captures a deputy-to-parent message as user text and the lead marks its provenance; loss: wrong-result, non-owner messages inflate owner directions)", () => {
  const h = handoff(1, "reviewer-frame", "v1", "2020-11-20T00:00:00Z");
  const r = repo({ "README.md": "records\n", "loop.json": JSON.stringify({ phase: "v1" }) + "\n",
    "metrics/handoffs.jsonl": JSON.stringify(h) + "\n", [h.record]: `# ${h.id}\n` });
  const deputy = { ...word(1, "2020-11-20T01:00:00Z"), source: "codex", text: "  Deputy report: please integrate the completed package.\nRaw message stays verbatim.  " };
  const owner = { ...word(2, "2020-11-20T02:00:00Z"), text: "The next phase must measure owner attention." };
  appendWords(r, [deputy, owner]);
  const raw = readFileSync(join(r, "owner/words.jsonl"), "utf8");
  for (const [w, intervention] of [[deputy, "I-0001"], [owner, "I-0002"]])
    assert.equal(ownerWords(r, "mark", "--id", w.id, "--as", "direction", "--intervention", intervention).status, 0);
  commitAt(r, "2020-11-20T03:00:00Z", {
    "interventions/I-0001.md": `# I-0001\n\nwords: ${deputy.id}\nraised-first: no\n`,
    "interventions/I-0002.md": `# I-0002\n\nwords: ${owner.id}\nraised-first: no\n`,
  });
  assert.equal(phaseMetrics(r).ownerDirections, 2);
  const corrected = ownerWords(r, "mark", "--id", deputy.id, "--as", "not-owner", "--note", "Deputy-to-parent tool message, not owner input");
  assert.equal(corrected.status, 0, corrected.stderr);
  const m = phaseMetrics(r);
  assert.equal(m.ownerDirections, 1);
  assert.equal(m.classes["not-owner"], 1);
  assert.equal(m.raisedFirst, 0);
  assert.deepEqual(m.directions.map(d => d.id), [owner.id]);
  assert.deepEqual(m.openWords, []);
  assert.deepEqual(openWords(r), []);
  const cli = ownerWords(r, "metrics", "--json");
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ownerDirections, 1);
  assert.equal(readFileSync(join(r, "owner/words.jsonl"), "utf8"), raw);
  assert.equal(JSON.parse(raw.split("\n")[0]).text, deputy.text);
});

test("A1 disposition: a rung of the five and a carried-by pointer or a reason, the last line of each holding (flow: the lead files an intervention and appends its disposition later; loss: false-verdict, an intervention listed as disposed with half a disposition)", () => {
  const cases = [
    ["rung: screening predicate\ncarried-by: idle-packages (F-0012 A3)\n", true, "screening predicate"],
    ["rung: Hard  Gate\ncarried-by: records-check.mjs raised-first\n", true, "hard gate"],
    ["rung: owner-only\ncarried-by: none: the owner's taste has no record to compute from\n", true, "owner-only"],
    ["rung: owner-only\ncarried-by: none\n", false, "owner-only"],
    ["rung: lint\ncarried-by: F-0012\n", false, "lint"],
    ["rung: \ncarried-by: F-0011 item 2\n", false, ""],
    ["carried-by: F-0012 A3\n", false, null],
    ["rung: construction\n", false, "construction"],
    ["Which rung carries it: a screening predicate, carried-by F-0012.\nrung of the ladder is still to be written.\n", false, null],
    ["rung: lint\ncarried-by: \nrung: question bank\ncarried-by: engines/frame-reviewer.md\n", true, "question bank"],
  ];
  for (const [text, disposed, rung] of cases) {
    const d = interventionDisposition(text);
    assert.equal(d.disposed, disposed, text);
    assert.equal(d.rung, rung, text);
    assert.equal(d.problems.length === 0, disposed, text);
  }
  assert.deepEqual(RUNGS, ["construction", "hard gate", "screening predicate", "question bank", "owner-only"]);
});

test("A2 replay: a predicate firing on consecutive records commits up to the word is one corrected episode, an earlier isolated firing one false alarm, and a predicate the records cannot decide earns no credit and names its event (flow: the lead cites a screening predicate in an intervention's disposition; loss: wrong-result, raised-first credit or false alarms miscounted)", () => {
  const r = repo({ "README.md": "records\n" });
  const loop = { product: r, records: ".", workDir: join(r, "..", `${Date.now()}-work`), phase: "v1", briefs: {}, agents: { actor: { runner: "t3" } }, cadence: { adversarial: 1 } };
  const handoffs = rows => rows.map(h => JSON.stringify(h)).join("\n") + "\n";
  const rows = list => list.map(row => JSON.stringify({ phase: "v1", role: "judge", verdict: "CONTINUE", area: "a", time: "2026-11-22T00:00:00Z", ...row })).join("\n") + "\n";
  const frame = handoff(1, "reviewer-frame", "v1", "2026-11-22T00:00:00Z");
  commitAt(r, "2026-11-22T00:00:10Z", { "loop.json": JSON.stringify(loop), "metrics/handoffs.jsonl": handoffs([frame]), "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n" });
  commitAt(r, "2026-11-22T00:01:00Z", { "metrics/trajectory.jsonl": rows([{ round: 2 }]) });
  const advancing = [handoff(3, "reviewer-frame", "v1", "2026-11-22T00:02:00Z"), handoff(3, "judge-frame", "v1", "2026-11-22T00:02:00Z")];
  commitAt(r, "2026-11-22T00:02:00Z", { "metrics/handoffs.jsonl": handoffs([frame, ...advancing]), "rounds/0003-reviewer-frame.md": "# r\n", "rounds/0003-judge-frame.md": "# j\n" });
  commitAt(r, "2026-11-22T00:03:00Z", { "metrics/trajectory.jsonl": rows([{ round: 2 }, { round: 4 }]) });
  commitAt(r, "2026-11-22T00:04:00Z", { "notes.txt": "an unrelated commit while the round stays due\n" });
  const w1 = word(1, "2026-11-22T00:04:30Z"), w2 = word(2, "2026-11-22T00:04:40Z");
  appendWords(r, [w1, w2]);
  commitAt(r, "2026-11-22T00:05:00Z", {
    "owner/word-marks.jsonl": [{ id: w1.id, as: "direction", intervention: "I-0001", time: "2026-11-22T00:05:00Z" }, { id: w2.id, as: "direction", intervention: "I-0002", time: "2026-11-22T00:05:00Z" }].map(m => JSON.stringify(m)).join("\n") + "\n",
    "interventions/I-0001.md": `# I-0001\n\nwords: ${w1.id}\nraised-first: no\nrung: screening predicate\ncarried-by: advancing-round-due (lib/cadence.mjs)\n`,
    "interventions/I-0002.md": `# I-0002\n\nwords: ${w2.id}\nrung: screening predicate\ncarried-by: idle-packages (F-0012 A3)\n`,
    "interventions/I-0003.md": "# I-0003\n\nrung: screening predicate\ncarried-by: a check nobody wrote\n",
  });
  const m = phaseMetrics(r, "v1");
  const due = m.predicates["advancing-round-due"];
  assert.deepEqual([due.fired, due.falseAlarms, due.episodes.map(e => [e.snapshots, e.corrected])], [[w1.id], 1, [[1, false], [2, true]]]);
  assert.ok(!("credited" in due), "a replay is coverage, not credit");
  const idle = m.predicates["idle-packages"];
  assert.deepEqual([idle.fired, idle.notFired, idle.unknown], [[], [w2.id], []], "no plan: the predicate decides it does not fire");
  assert.deepEqual(idle.needs, { event: "a committed launch or acknowledgement event for each started package, and the measured capacity at reconciliation", feature: "F-0012" });
  assert.deepEqual(m.directions.map(d => [d.id, d.verified, d.wouldHaveFired]), [[w1.id, false, ["advancing-round-due"]], [w2.id, false, []]]);
  assert.equal(m.raisedFirst, 0, "a predicate's replay never counts as raised first");
  assert.deepEqual([m.wouldHaveFired.directions, m.wouldHaveFired.words], [1, [w1.id]]);
  assert.ok(!m.screening.some(f => f.path === "interventions/I-0001.md"), "nothing is raised against an intervention that says raised-first: no");
  assert.ok(m.screening.some(f => /I-0003 names the screening predicate rung, but its carried-by: names no registered predicate/.test(f.detail)));
  assert.deepEqual(m.undisposed, []);
  const quick = phaseMetrics(r, "v1", { falseAlarms: false });
  assert.equal(quick.raisedFirst, m.raisedFirst, "next's header reads the same count without the false-alarm replay");
  assert.ok(!("falseAlarms" in quick.predicates["advancing-round-due"]));
  const text = metricsLines(m).join("\n");
  assert.match(text, /^raisedFirst 0 \(0% of owner directions; a named record committed before every cited word\)$/m);
  assert.match(text, new RegExp(`^wouldHaveFired 1 of 2 owner directions \\(${w1.id}\\): today's predicate code replayed on the records commit before each word; coverage for the independent review, never raised first$`, "m"));
  assert.match(text, /^predicate advancing-round-due [^\n]*would have fired on the records commit before: W-0000000001 /m);
  assert.doesNotMatch(text, /verified by predicate|credited/);
});

test("R8-1 raised first counts record claims proven by commit order only; a predicate's replay is listed apart and never overrides raised-first: no (flow: the lead files two corrections, one claiming a record committed before the word and one saying no, both citing a predicate that fires before the word; loss: wrong-result, the owner-facing raised-first count credits today's code run on old commits)", () => {
  const r = repo({ "README.md": "records\n" });
  const loop = { product: r, records: ".", workDir: join(r, "..", `${Date.now()}-work`), phase: "v1", briefs: {}, agents: { actor: { runner: "t3" } }, cadence: { adversarial: 1 } };
  const rows = list => list.map(row => JSON.stringify({ phase: "v1", role: "judge", verdict: "CONTINUE", area: "a", time: "2026-11-22T00:00:00Z", ...row })).join("\n") + "\n";
  const frame = handoff(1, "reviewer-frame", "v1", "2026-11-22T00:00:00Z");
  commitAt(r, "2026-11-22T00:00:10Z", { "loop.json": JSON.stringify(loop), "metrics/handoffs.jsonl": JSON.stringify(frame) + "\n", "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n",
    "decisions/D-0001.md": "# D-0001 Advance after each judged round\n" });
  commitAt(r, "2026-11-22T00:01:00Z", { "metrics/trajectory.jsonl": rows([{ round: 2 }]) });
  const claimed = word(1, "2026-11-22T00:02:00Z"), declined = word(2, "2026-11-22T00:02:10Z"), unstated = word(3, "2026-11-22T00:02:20Z");
  appendWords(r, [claimed, declined, unstated]);
  const carried = "rung: screening predicate\ncarried-by: advancing-round-due\n";
  commitAt(r, "2026-11-22T00:03:00Z", {
    "owner/word-marks.jsonl": [[claimed, "I-0001"], [declined, "I-0002"], [unstated, "I-0003"]].map(([w, i]) => JSON.stringify({ id: w.id, as: "direction", intervention: i, time: "2026-11-22T00:03:00Z" })).join("\n") + "\n",
    "interventions/I-0001.md": `# I-0001\n\nwords: ${claimed.id}\nraised-first: D-0001\n${carried}`,
    "interventions/I-0002.md": `# I-0002\n\nwords: ${declined.id}\nraised-first: no\n${carried}`,
    "interventions/I-0003.md": `# I-0003\n\nwords: ${unstated.id}\n${carried}`,
  });
  const m = phaseMetrics(r, "v1", { falseAlarms: false });
  assert.deepEqual(m.directions.map(d => [d.id, d.raisedFirst, d.verified, d.wouldHaveFired]),
    [[claimed.id, ["D-0001"], true, ["advancing-round-due"]], [declined.id, "no", false, ["advancing-round-due"]], [unstated.id, null, false, ["advancing-round-due"]]]);
  assert.deepEqual([m.ownerDirections, m.raisedFirst, m.raisedFirstShare], [3, 1, 1 / 3]);
  assert.deepEqual(m.wouldHaveFired.words, [claimed.id, declined.id, unstated.id]);
  assert.ok(!m.directions.some(d => "raisedBy" in d));
  assert.ok(!m.screening.some(f => f.rule === "raised-first" && /I-0002/.test(f.detail)), JSON.stringify(m.screening));
});

test("measures-zero owner waiting: each batch of the phase waits from its publication to its answer, its replacement or, while open, to now; an unknown publication makes the figure unknown; no batch is 0 s with its reason (flow: the lead reads the measures while one batch of the phase is unanswered and no plan names it; loss: wrong-result, the owner's open wait printed as 0 s)", () => {
  const at = iso => Date.parse(iso);
  const sent = { "owner/B-0001.md": at("2026-11-22T00:00:00Z"), "owner/B-0002.md": at("2026-11-22T00:01:00Z"), "owner/B-0003.md": at("2026-11-22T00:02:00Z"), "owner/B-0004.md": null };
  const batch = (n, fields = {}) => ({ id: `B-000${n}`, file: `owner/B-000${n}.md`, answers: [], replacedBy: null, ...fields });
  const events = [{ batch: "B-0002", time: "2026-11-22T00:03:00Z", replacedBy: "B-0003" }];
  const options = { events, now: at("2026-11-22T00:10:00Z"), published: path => sent[path] };
  const answered = batch(1, { answers: [{ time: "2026-11-22T00:05:00Z" }, { time: "2026-11-22T00:04:00Z" }] });
  const w = ownerWaiting([answered, batch(2, { replacedBy: "B-0003" }), batch(3)], options);
  assert.deepEqual(w.intervals.map(i => [i.batch, i.state, i.seconds]), [["B-0001", "answered", 240], ["B-0002", "replaced", 120], ["B-0003", "open", 480]]);
  assert.deepEqual([w.seconds, w.open, w.unknowns], [840, ["B-0003"], []]);
  assert.equal(waitingText(w), "840 s over 3 owner batches of the phase, B-0003 still open and accruing");
  const later = ownerWaiting([batch(3)], { ...options, now: at("2026-11-22T00:20:00Z") });
  assert.equal(later.seconds, 1080, "an open batch accrues from its send time");
  const unknown = ownerWaiting([answered, batch(4)], options);
  assert.equal(unknown.seconds, null);
  assert.match(waitingText(unknown), /^unknown \(owner\/B-0004\.md has no single first publication in the records history\)$/);
  const badAnswer = ownerWaiting([batch(1, { answers: [{ time: "yesterday" }] })], options);
  assert.equal(badAnswer.seconds, null);
  assert.match(waitingText(badAnswer), /B-0001's answer has no valid time/);
  const none = ownerWaiting([], options);
  assert.deepEqual([none.seconds, waitingText(none)], [0, "0 s (no owner batch sent in the phase)"]);
});

test("measures-zero owner waiting through phaseMetrics: the batches of the phase from Git publication, another phase's batch excluded (flow: the lead reads metrics after sending two batches, one answered; loss: wrong-result, the publication time read from the wrong history)", () => {
  const h = handoff(1, "reviewer-frame", "v1", "2020-11-20T00:00:00Z");
  const r = repo({ "README.md": "records\n" });
  commitAt(r, "2020-11-20T00:00:00Z", { "loop.json": JSON.stringify({ phase: "v1" }) + "\n", "metrics/handoffs.jsonl": JSON.stringify(h) + "\n", [h.record]: `# ${h.id}\n` });
  commitAt(r, "2020-11-20T01:00:00Z", { "owner/B-0001.md": "# B-0001 Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n" });
  commitAt(r, "2020-11-20T02:00:00Z", { "owner/B-0002.md": "# B-0002 Owner batch\n\nphase: v1\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n",
    "owner/B-0003.md": "# B-0003 Owner batch\n\nphase: v0\nfrom: R-0001-reviewer-frame\n\n### 1. Q\n" });
  commitAt(r, "2020-11-20T03:00:00Z", { "owner/answers.jsonl": JSON.stringify({ batch: "B-0001", time: "2020-11-20T01:30:00Z", words: "yes", outcome: "as-recommended" }) + "\n" });
  const before = Date.now();
  const m = phaseMetrics(r);
  const w = m.ownerWaiting;
  assert.deepEqual(w.intervals.map(i => [i.batch, i.state, i.from]), [["B-0001", "answered", "2020-11-20T01:00:00.000Z"], ["B-0002", "open", "2020-11-20T02:00:00.000Z"]]);
  assert.equal(w.intervals[0].seconds, 1800);
  assert.ok(w.intervals[1].seconds >= Math.floor(before / 1000) - Date.parse("2020-11-20T02:00:00Z") / 1000, JSON.stringify(w));
  assert.deepEqual(w.open, ["B-0002"]);
  assert.match(ownerWords(r, "metrics").stdout, /^ownerWaiting \d+ s over 2 owner batches of the phase, B-0002 still open and accruing$/m);
});
