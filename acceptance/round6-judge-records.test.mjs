import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { jsonOutput, jsonl, output, put, world } from "./fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const history = JSON.parse(readFileSync(new URL("./fixtures/round6-judge-history.json", import.meta.url), "utf8"));
const ledger = "metrics/trajectory.jsonl";
const handoffs = "metrics/handoffs.jsonl";
const decision = "decisions/D-0018.md";
const record = round => `rounds/${String(round).padStart(4, "0")}-judge.md`;
const flow = "flow: The lead uses the release command to publish a reviewed build.";
const annotation = "loss: false-verdict. The gate accepts a build with failing evidence.";
const blocker = "release-evidence:R6-1";
const sibling = "release-evidence:R6-2";

function block(key, lines) {
  return [`**OPEN — ${key}, round-close.**`, ...lines].join("  \n");
}

function checkRecords(w, records, ...args) {
  return w.run(["--repo", records, "--json", ...args], { entry: "records-check.mjs" });
}

function clean(w, records, ...args) {
  assert.deepEqual(jsonOutput(checkRecords(w, records, ...args)).failures, []);
}

function createRecords(w, name) {
  return w.repo(join(w.dir, name), { "README.md": "# Round records\n", [ledger]: "", [handoffs]: "" });
}

function adopt(w, records) {
  put(records, decision, history.decision.join("\n"));
  return w.commit(records, "Adopt D-0018");
}

function handoff(records, round, view) {
  const path = record(round);
  const id = "R-" + path.slice("rounds/".length, -".md".length);
  appendFileSync(join(records, handoffs), jsonl({
    id, round, phase: "v1", role: "judge", step: "judge", view, attempt: 1,
    agent: { runner: "t3:codex" }, product: null, audit: { violations: 0 }, record: path, files: [path],
  }));
}

function ruling(w, records, { view, report, opened, closed = "-", priorRows = [] }) {
  const path = record(6);
  put(records, path, [
    "# R-0006-judge", "", "phase: v1", "role: judge", `view: records@${view}`, "",
    "## Public report (verbatim, out/public.md)", "", ...report, "",
  ].join("\n"));
  handoff(records, 6, view);
  w.git(records, "add", "--", path, handoffs);
  clean(w, records, "--write");
  w.commit(records, "Record the judge hand-off");
  put(records, ledger, jsonl(...priorRows, {
    ...history.judges.at(-1).row, round: 6, time: "2026-11-21T21:00:00Z",
    opened: opened.length ? opened.join(",") : "-", closed,
  }));
  w.git(records, "add", "--", ledger);
}

function witness(t, { bad, good, opened = [blocker], missing, field }) {
  const w = world(t);
  const admitted = createRecords(w, "admitted");
  ruling(w, admitted, { view: adopt(w, admitted), report: good, opened });
  clean(w, admitted);

  const refused = createRecords(w, "refused");
  ruling(w, refused, { view: adopt(w, refused), report: bad, opened });
  const result = checkRecords(w, refused);
  assert.ifError(result.error);
  assert.ok(Number.isInteger(result.status) && result.status > 0, output(result));
  const { failures } = JSON.parse(result.stdout);
  const forRecord = failures.filter(item => item.path === record(6));
  assert.ok(forRecord.length, JSON.stringify(failures));
  const details = forRecord.map(item => item.detail).join("\n");
  assert.match(details, new RegExp(`(?<![\\w-])${missing}(?![\\w-])`));
  assert.match(details, field);
}

const complete = block(blocker, [flow, annotation]);

test("R6-C-R01 opened key without flow fails", t => {
  witness(t, {
    good: [complete], bad: [block(blocker, [annotation])], missing: "R6-1", field: /\bflow\b/i,
  });
});

test("R6-C-R02 opened key without loss fails", t => {
  witness(t, {
    good: [complete], bad: [block(blocker, [flow])], missing: "R6-1", field: /\bloss\b/i,
  });
});

test("R6-C-R03 loss outside the closed list fails", t => {
  witness(t, {
    good: [complete], bad: [block(blocker, [flow, "loss: false-verdict-risk. The lead must rerun the release."])],
    missing: "R6-1", field: /\bloss\b/i,
  });
});

test("R6-C-R04 another opened block cannot supply the missing loss", t => {
  const other = block(sibling, [flow, "loss: stuck. The lead has no available release route."]);
  witness(t, {
    good: [complete, "", other], bad: [block(blocker, [flow]), "", other], opened: [blocker, sibling],
    missing: "R6-1", field: /\bloss\b/i,
  });
});

test("R6-C-R05 exact opened IDs survive similarly named neighbors at scale", t => {
  const draw = seeded(seed);
  const losses = ["data", "wrong-result", "false-verdict", "disclosure", "stuck"];
  const keys = Array.from({ length: 14 + draw(11) }, (_, i) => `release-evidence:R6-${i + 1}`);
  const offset = draw(keys.length >= 20 ? 2 : 1);
  const reports = keys.map((key, i) => {
    const name = i % 2 ? key : key.split(":")[1];
    return [block(name, [flow, `loss: ${losses[i % losses.length]}`]), ""];
  });
  const target = keys[offset].split(":")[1];
  const red = reports.slice();
  red[offset] = [block(target, [flow]), ""];
  witness(t, {
    good: reports.flat(), bad: red.flat(), opened: keys, missing: target, field: /\bloss\b/i,
  });
});

function replayHistory(w, records) {
  const rows = [];
  for (const { decisionInView, report, row } of history.judges) {
    const view = decisionInView ? adopt(w, records) : w.git(records, "rev-parse", "HEAD");
    put(records, record(row.round), report.map(line => line.startsWith("view: records@")
      ? `view: records@${view}`
      : line).join("\n"));
    rows.push(row);
    put(records, ledger, jsonl(...rows));
    handoff(records, row.round, view);
    w.git(records, "add", "--", record(row.round), ledger, handoffs);
    clean(w, records, "--write");
    w.commit(records, `Replay round ${row.round}`);
  }
  return rows;
}

test("R6-C-R06 exact public judge reports from rounds 1 through 5 are admitted", t => {
  const w = world(t);
  const records = createRecords(w, "rounds-1-5");
  replayHistory(w, records);
  clean(w, records);
});

test("R6-C-R07 a later adoption does not govern an older pinned view", t => {
  const w = world(t);
  const records = createRecords(w, "pinned-before-adoption");
  const view = w.git(records, "rev-parse", "HEAD");
  adopt(w, records);
  ruling(w, records, { view, report: [block(blocker, [annotation])], opened: [blocker] });
  clean(w, records);
});

test("R6-C-R08 a closed key is not subject to the opened-key format", t => {
  const w = world(t);
  const records = createRecords(w, "closing-only");
  const priorRows = replayHistory(w, records);
  const closed = priorRows.at(-1).opened;
  ruling(w, records, {
    view: w.git(records, "rev-parse", "HEAD"),
    report: [`**CLOSED — ${closed}.** The gate now checks the effective push destination.`],
    opened: [], closed, priorRows,
  });
  clean(w, records);
});
