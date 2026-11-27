import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { DEFAULT_LAYOUT, inspect } from "../records-check.mjs";
import { field, keyPattern, keyProblem, LOSSES } from "../lib/judge-bar.mjs";
import { git, repo, temp } from "./helpers.mjs";

const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
const FLOW = "flow: A lead runs the release command on a reviewed build.";
const LOSS = "loss: false-verdict. The gate accepts a build with failing evidence.";
const problem = (text, key, keys = [key]) => keyProblem(text.split("\n"), key, keys);

test("a key is named by its whole class:id or its id, never inside a longer id or under another class", () => {
  const named = (key, text) => keyPattern(key).test(text);
  for (const text of ["**OPEN — release:R6-1, round-close.**", "`R6-1`", "(R6-1)", "R6-1.", "R6-1的修复", "R6-1/R6-2", "release:R6-1"])
    assert.ok(named("release:R6-1", text), text);
  for (const text of ["R6-10", "R6-1-b", "R6-1.2", "XR6-1", "other:R6-1", "release:R6-10"])
    assert.ok(!named("release:R6-1", text), text);
  assert.ok(named("a.b:c:d", "a.b:c:d") && !named("a.b:c:d", "x:c:d"));
});

test("field lines: flow and loss at a line start, Markdown decoration allowed, the loss's first word from the closed list", () => {
  for (const line of ["flow: x", "- flow: x", "  * **flow:** x", "> Flow: x", "1. `flow`: x", "**flow**: x"])
    assert.equal(field(line)?.name, "flow", line);
  for (const word of LOSSES) assert.equal(field(`loss: ${word}. why`).listed, true, word);
  for (const line of ["loss: `data`", "- **loss:** Stuck, since", "loss: wrong-result)", "loss: data, false-verdict"])
    assert.equal(field(line).listed, true, line);
  for (const line of ["loss: false-verdict-risk. x", "loss: data-loss", "loss:", "loss: none", "loss: 数据丢失"])
    assert.equal(field(line).listed, false, line);
  for (const line of ["flowchart: x", "lossless: data", "the flow: x", "See flow: x"]) assert.equal(field(line), null, line);
});

test("blocks: a paragraph, a heading's section, a list item; a field is never borrowed from another key's block", () => {
  const key = "release:R6-1", other = "release:R6-2", keys = [key, other];
  assert.equal(problem(`**OPEN — ${key}.**\n${FLOW}\n${LOSS}`, key), null);
  assert.equal(problem(`### ${key}\n\n${FLOW}\n\n${LOSS}\n\n### ${other}`, key, keys), null);
  assert.equal(problem(`- **${key}** (round-close)\n  - ${FLOW}\n  - ${LOSS}\n- **${other}**`, key, keys), null);
  assert.equal(problem(`**OPEN — ${key}.**\n${FLOW}\nwhich ${other} also shows,\n${LOSS}`, key, keys), null, "a wrapped line does not cut");
  assert.equal(problem(`**OPEN — ${key} and ${other}.**\n${FLOW}\n${LOSS}`, other, keys), null, "one block may open two keys");
  assert.match(problem(`**OPEN — ${key}.**\n${FLOW}\n\n**OPEN — ${other}.**\n${FLOW}\n${LOSS}`, key, keys), /missing a loss: line/);
  assert.match(problem(`- **${key}**\n  ${FLOW}\n- **${other}**\n  ${FLOW}\n  ${LOSS}`, key, keys), /missing a loss: line/);
  assert.match(problem(`**OPEN — ${key}.**\n${FLOW}\n**OPEN — ${other}.**\n${LOSS}`, key, keys), /missing a loss: line/);
  assert.match(problem(`### ${key}\n\n${FLOW}\n\n#### ${other}\n\n${LOSS}`, key, keys), /missing a loss: line/);
  assert.match(problem(`**OPEN — ${key}.**\n${LOSS}`, key), /missing a flow: line/);
  assert.match(problem(`**OPEN — ${key}.**\n${FLOW}\nloss: risky`, key), /`risky` is not one of data, wrong-result/);
  assert.match(problem(`${FLOW}\n${LOSS}`, key), /no block names it/);
});

function records({ bars = ["decisions/D-0018.md"], report, rows, name = "rounds/0006-judge.md", phase = "v1", into }) {
  const dir = into ?? repo({ "README.md": "# records\n" });
  for (const bar of bars) put(dir, bar, `# ${bar}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", "view");
  const view = git(dir, "rev-parse", "HEAD");
  put(dir, name, [`# R-${name.slice(7, -3)}`, "", `phase: ${phase}`, "role: judge", `view: records@${view}`, "",
    "## Public report (verbatim, out/public.md)", "", ...report, ""].join("\n"));
  if (rows) put(dir, "metrics/trajectory.jsonl", rows.map(r => JSON.stringify({ phase: "v1", role: "judge", ...r }) + "\n").join(""));
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "record");
  return dir;
}
function put(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
const findings = (dir, options = {}) => {
  const state = inspect(dir, { layoutText, ...options });
  const mine = list => list.filter(f => f.rule === "judge-bar").map(f => `${f.path}: ${f.detail}`);
  return { failures: mine(state.failures), screening: mine(state.screening) };
};
const opened = keys => [{ round: 6, opened: keys.join(",") }];

test("records: the round's opened keys are held only when the view holds the bar; a later judge record of the round is the way out", () => {
  const bad = ["**OPEN — release:R6-1, round-close.**", FLOW];
  const dir = records({ report: bad, rows: opened(["release:R6-1"]) });
  const red = findings(dir).failures;
  assert.equal(red.length, 1);
  assert.match(red[0], /^rounds\/0006-judge\.md: R-0006-judge: release:R6-1, opened by the round's judge trajectory row, .*missing a loss: line/);
  assert.deepEqual(findings(records({ report: bad, rows: [{ round: 6, phase: "v2", opened: "release:R6-1" }] })), { failures: [], screening: [] },
    "a row of another phase");
  assert.deepEqual(findings(records({ report: bad, rows: [{ round: 6, role: "review", opened: "release:R6-1" }] })).failures, []);
  records({ into: dir, name: "rounds/0006-judge-b.md", bars: [], report: ["**OPEN — release:R6-1.**", FLOW, LOSS] });
  assert.deepEqual(findings(dir), { failures: [], screening: [] });
});

test("records: the adopting decision is the records' own (records.json blockerBar), so another product's D-0018 holds nothing", () => {
  const bad = ["**OPEN — store:R35-1.**", "The store loses a record."];
  const appRecs = records({ bars: ["decisions/D-0018.md"], report: bad, rows: [{ round: 35, opened: "store:R35-1" }], name: "rounds/0035-judge.md" });
  assert.equal(findings(appRecs).failures.length, 1, "by default the D-0018 file adopts the bar");
  assert.deepEqual(findings(appRecs, { config: { blockerBar: "decisions/D-0052.md" } }), { failures: [], screening: [] });
  const adopted = records({ bars: ["decisions/D-0052.md"], report: bad, rows: [{ round: 35, opened: "store:R35-1" }], name: "rounds/0035-judge.md" });
  assert.match(findings(adopted, { config: { blockerBar: "decisions/D-0052.md" } }).failures[0], /store:R35-1.*decisions\/D-0052\.md is in its view/);
  for (const blockerBar of [7, "", "/abs/D-0052.md", "decisions/D-0052"])
    assert.match(findings(adopted, { config: { blockerBar } }).failures[0] ?? "", /^records\.json: blockerBar must be/, String(blockerBar));
});

test("records: an unreadable view is screened, and a hand-off check that does not own the record or the trajectory only screens", () => {
  const bad = ["**OPEN — release:R6-1.**", FLOW];
  const dir = records({ report: bad, rows: opened(["release:R6-1"]) });
  const text = readFileSync(join(dir, "rounds/0006-judge.md"), "utf8").replace(/records@[0-9a-f]+/, `records@${"0".repeat(40)}`);
  writeFileSync(join(dir, "rounds/0006-judge.md"), text);
  assert.deepEqual(findings(dir).failures, []);
  assert.match(findings(dir).screening[0], /cannot be read, so whether decisions\/D-0018\.md governs it is unknown/);
  git(dir, "checkout", "-q", "--", ".");
  assert.deepEqual(findings(dir, { own: ["README.md"] }).failures, []);
  assert.equal(findings(dir, { own: ["README.md"] }).screening.length, 1);
  writeFileSync(join(dir, "rounds/0006-judge.md"), text.replace(/^view: .*\n/m, ""));
  assert.deepEqual(findings(dir), { failures: [], screening: [] }, "a record with no view line predates the header and the bar");
  git(dir, "checkout", "-q", "--", ".");
  const plain = temp();
  for (const path of ["README.md", "rounds/0006-judge.md", "metrics/trajectory.jsonl"]) put(plain, path, readFileSync(join(dir, path), "utf8"));
  assert.deepEqual(findings(plain).failures, []);
  assert.equal(findings(plain).screening.length, 1);
});
