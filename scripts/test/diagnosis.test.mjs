// The alarm gate (lib/diagnosis.mjs, applied by call.mjs): a critic, actor or judge call, its preparation and its dry
// run are refused (exit 7) while the phase has an alarm at the view that no reviewer-diagnosis hand-off, recorded after
// the row that raised it, names on an `alarms:` line of its task. Admission (SKILL.md Enforcement ladder): the replay
// of this loop's phase v1 turns the recorded defect red (rounds 3 and 4 were briefed on undiagnosed alarms) and keeps
// every legitimate call green.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT, recordCall } from "../call.mjs";
import { alarmKeys, firings, taskOfRecord, undiagnosedAlarms } from "../lib/diagnosis.mjs";
import { recordOf } from "../lib/handoff.mjs";
import { parseRows } from "../trajectory.mjs";
import { fixtures, git, repo, scripts, setup, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");

const TRAJECTORY = "metrics/trajectory.jsonl";
const row = (round, fields = {}) => ({ round, phase: "S5", role: "judge", area: "core", verdict: "CONTINUE", opened: "-", closed: "-", suite: "1/0", ...fields });
const put = (dir, path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
const append = (records, ...rows) => {
  const file = join(records, TRAJECTORY);
  put(records, TRAJECTORY, (existsSync(file) ? readFileSync(file, "utf8") : "") + rows.map(r => JSON.stringify(r) + "\n").join(""));
  git(records, "add", TRAJECTORY);
  git(records, "commit", "-qm", `trajectory: round ${rows.map(r => r.round).join(",")}`);
};
const diagnosis = (keys, extra = "") => `Mode: DIAGNOSIS.\nfeatures: none\n${keys === null ? "" : `alarms: ${keys}\n`}${extra}`;
/** Two rulings of area core where round 1's blocker stays open after round 2: `partly-closed:S5:core:2` on row 2. */
const partly = [row(1, { opened: "bug:A" }), row(2)];

test("the task's alarms: lines and the record's task section are read exactly", () => {
  assert.deepEqual(alarmKeys("x\nalarms: a:b:1, `c:d` ,\r\nalarms:e\nnot alarms: f\n"), ["a:b:1", "c:d", "e"]);
  const record = "# R-0002-reviewer-diagnosis\n\nphase: v1\n\n## Task (verbatim)\n\n```text\nalarms: k:1\n```\n\n## Report (verbatim)\n\nalarms: k:2\n## Report (verbatim)\nalarms: k:3\n";
  assert.deepEqual(alarmKeys(taskOfRecord(record)), ["k:1"], "the reviewer's report never names a key");
});

test("an alarm fired on the row that last changed it: a grown alarm fires anew, an unchanged one keeps its row", () => {
  const parsed = list => parseRows(list.map(r => JSON.stringify(r)).join("\n"));
  const [areaRounds] = firings(parsed([row(1), row(2), row(3), row(4, { area: "other" })])).filter(a => a.type === "area-rounds");
  assert.equal(areaRounds.key, "area-rounds:S5:core");
  assert.equal(areaRounds.row, 2, "rounds 1-3 raised it on row 3 (index 2); a row of another area left it as it was");
  const grown = parsed([row(1), row(2), row(3), row(4, { area: "other" }), row(4)]);
  assert.equal(firings(grown).find(a => a.key === "area-rounds:S5:core").row, 4, "a fourth round of the area changed its evidence");
});

/** D-0017 item 2; design/alarm-gate.md#measured */
function replayRecords(replay, ciOf) {
  const records = repo({ "README.md": "# replay\n" });
  const rowTexts = replay.rows.map(text => { const r = JSON.parse(text); return JSON.stringify({ ...r, ci: ciOf(r) }); });
  const events = [
    ...replay.handoffs.map(h => ({ time: h.time, order: 0, h })),
    ...rowTexts.map(text => ({ time: JSON.parse(text).time, order: 1, text })),
  ].sort((a, b) => a.time.localeCompare(b.time) || a.order - b.order);
  const commits = [];
  let handoffs = "", rows = "";
  for (const e of events) {
    if (e.h) {
      const record = recordOf(e.h.round, e.h.step);
      const task = `Task of ${e.h.id}.\n${replay.alarmsLines[e.h.id] ?? ""}`.trim();
      put(records, record, `# ${e.h.id}\n\nphase: v1\n\n## Task (verbatim)\n\n\`\`\`text\n${task}\n\`\`\`\n\n## Report (verbatim)\n\nreport\n`);
      handoffs += JSON.stringify({ ...e.h, record, files: [record], attempt: 1, agent: { runner: "claude" }, product: null, audit: { violations: 0 } }) + "\n";
      put(records, "metrics/handoffs.jsonl", handoffs);
    } else {
      rows += e.text + "\n";
      put(records, TRAJECTORY, rows);
    }
    git(records, "add", "-A");
    git(records, "commit", "-qm", e.h?.id ?? "trajectory row");
    commits.push({ time: e.time, sha: git(records, "rev-parse", "HEAD") });
  }
  const firstOfView = new Map();
  for (const h of replay.handoffs) if (!firstOfView.has(h.view) || h.time < firstOfView.get(h.view)) firstOfView.set(h.view, h.time);
  const viewOf = h => commits.findLast(c => c.time < firstOfView.get(h.view)).sha;
  const keysOf = h => undiagnosedAlarms(records, viewOf(h), "v1").map(a => a.key).sort();
  const calls = replay.handoffs.filter(h => h.role !== "reviewer");
  return { records, rows, calls, keysOf, ids: (round, refused) => calls.filter(h => round(h.round) && refused === Boolean(keysOf(h).length)).map(h => h.id) };
}

test("admission (D-0017): the v1 replay refuses round 2 for ci-absent:v1:1 alone, and rounds 3 and 4 for their alarms", () => {
  const replay = JSON.parse(readFileSync(join(fixtures, "v1-alarm-replay.json"), "utf8"));
  const real = replayRecords(replay, r => r.ci);
  assert.deepEqual(real.ids(() => true, false), ["R-0001-critic", "R-0001-actor", "R-0001-judge"]);
  for (const h of real.calls.filter(h => h.round === 2)) assert.deepEqual(real.keysOf(h), ["ci-absent:v1:1"], h.id);
  assert.deepEqual(real.keysOf(real.calls.find(h => h.id === "R-0003-critic")),
    ["blocker-recurring:tip-ci-evidence", "ci-absent:v1:1", "ci-absent:v1:2", "partly-closed:v1:watch:2"]);
  assert.deepEqual(real.ids(r => r >= 3, true), ["R-0003-critic", "R-0003-actor", "R-0003-judge", "R-0004-critic", "R-0004-actor", "R-0004-actor-b", "R-0004-judge"]);
  assert.deepEqual(undiagnosedAlarms(real.records, "HEAD", "v1").map(a => a.key), ["ci-absent:v1:1", "ci-absent:v1:2", "ci-absent:v1:3", "ci-absent:v1:4"],
    "R-0005-reviewer-diagnosis named the other four alarms");

  const roundOneGreen = replayRecords(replay, r => r.round === 1 ? "success" : r.ci);
  assert.deepEqual(roundOneGreen.ids(r => r <= 2, true), []);
  assert.deepEqual(roundOneGreen.ids(r => r <= 2, false), ["R-0001-critic", "R-0001-actor", "R-0001-judge", "R-0002-critic", "R-0002-actor", "R-0002-judge", "R-0002-actor-b"]);
});

test("admission: with every candidate green, the v1 replay refuses exactly rounds 3 and 4, and a grown alarm again", () => {
  const replay = JSON.parse(readFileSync(join(fixtures, "v1-alarm-replay.json"), "utf8"));
  const green = replayRecords(replay, () => "success");
  assert.deepEqual(green.ids(() => true, true), ["R-0003-critic", "R-0003-actor", "R-0003-judge", "R-0004-critic", "R-0004-actor", "R-0004-actor-b", "R-0004-judge"]);
  assert.deepEqual(green.ids(() => true, false), ["R-0001-critic", "R-0001-actor", "R-0001-judge", "R-0002-critic", "R-0002-actor", "R-0002-judge", "R-0002-actor-b"]);
  assert.deepEqual(undiagnosedAlarms(green.records, "HEAD", "v1"), []);
  const rows = green.rows + JSON.stringify({ ...JSON.parse(replay.rows[3]), ci: "success", time: "2026-11-21T20:00:00Z", round: 5, opened: "-", closed: "tip-ci-evidence:R1-5" }) + "\n";
  put(green.records, TRAJECTORY, rows);
  git(green.records, "commit", "-qam", "round 5");
  assert.deepEqual(undiagnosedAlarms(green.records, "HEAD", "v1").map(a => a.key), ["area-rounds:v1:watch"]);
});

test("recorded after (D-0017 item 3): the later time decides; on the same second, the commit that added the diagnosis must hold the row", () => {
  const key = "partly-closed:S5:core:2";
  const world = (rowTime, diagnosisTime, together) => {
    const records = repo({ "README.md": "# order\n" });
    const record = "rounds/0003-reviewer-diagnosis.md";
    const rows = partly.map(r => JSON.stringify({ ...r, time: rowTime }) + "\n").join("");
    const handoff = JSON.stringify({ id: "R-0003-reviewer-diagnosis", time: diagnosisTime, phase: "S5", round: 3, step: "reviewer-diagnosis",
      role: "reviewer", record, files: [record], view: "f".repeat(40), attempt: 1, agent: { runner: "claude" }, product: null, audit: { violations: 0 } }) + "\n";
    const diagnose = () => {
      put(records, record, `# R-0003-reviewer-diagnosis\n\n## Task (verbatim)\n\nalarms: ${key}\n`);
      put(records, "metrics/handoffs.jsonl", handoff);
    };
    if (together === "diagnosis first") { diagnose(); git(records, "add", "-A"); git(records, "commit", "-qm", "diagnosis"); }
    put(records, TRAJECTORY, rows);
    if (together !== "diagnosis first") diagnose();
    git(records, "add", "-A");
    git(records, "commit", "-qm", "rows");
    return undiagnosedAlarms(records, "HEAD", "S5").map(a => a.key);
  };
  assert.deepEqual(world("2026-11-21T18:00:00Z", "2026-11-21T17:59:59Z", "one commit"), [key], "an earlier diagnosis never covers, even in the row's commit");
  assert.deepEqual(world("2026-11-21T18:00:00Z", "2026-11-21T18:00:01Z", "diagnosis first"), [], "a later time covers");
  assert.deepEqual(world("2026-11-21T18:00:00Z", "2026-11-21T18:00:00Z", "diagnosis first"), [key], "same second: the diagnosis's commit lacks the row");
  assert.deepEqual(world("2026-11-21T18:00:00Z", "2026-11-21T18:00:00Z", "one commit"), [], "same second: its commit holds the row");
  assert.deepEqual(world("-", "2026-11-21T17:00:00Z", "diagnosis first"), [key], "a row without a time: commit order decides");
});

test("call.mjs refuses a critic, actor or judge call, dry run and preparation while an alarm waits; the reviewer is never refused", async () => {
  const s = await setup({});
  append(s.records, ...partly);
  const head = git(s.records, "rev-parse", "HEAD");
  for (const role of ["critic", "actor", "judge"]) {
    for (const dry of [false, true]) {
      const r = s.run(role, { dry });
      assert.equal(r.code, EXIT.records, r.message);
      assert.equal(r.ws, undefined, "no workspace");
      assert.match(r.message, /partly-closed:S5:core:2/);
      assert.match(r.message, /alarms: partly-closed:S5:core:2/);
      assert.match(r.message, /call\.mjs .* reviewer --round 1 --step reviewer-diagnosis --task/);
    }
    s.cfg.agents[role] = { runner: "t3", provider: "claude" };
    const prepared = s.run(role, { prepare: true });
    assert.equal(prepared.code, EXIT.records, prepared.message);
    const snapshots = join(s.cfg.workDir, ".prepared");
    assert.ok(!existsSync(snapshots) || !readdirSync(snapshots).length, "no preparation snapshot");
  }
  assert.deepEqual(s.counts(), {});
  assert.equal(git(s.records, "rev-parse", "HEAD"), head, "nothing recorded");
  const r = s.run("reviewer", { round: 2, step: "reviewer-diagnosis", task: diagnosis("partly-closed:S5:core:2") });
  assert.equal(r.code, EXIT.done, r.message);
  for (const role of ["critic", "actor", "judge"]) s.cfg.agents[role] = { runner: "cmd", cmd: s.cfg.agents.reviewer.cmd };
  const critic = s.run("critic", { round: 2 });
  assert.equal(critic.code, EXIT.done, critic.message);
});

test("only a reviewer-diagnosis of the same phase, recorded after the row, naming the key on its task's alarms: line covers it", async () => {
  const s = await setup({ reviewer: [{ report: "VERDICT: CONTINUE\nalarms: partly-closed:S5:core:2\n" }] });
  // Recorded before the row: it could not have diagnosed it.
  assert.equal(s.run("reviewer", { round: 1, step: "reviewer-diagnosis", task: diagnosis("partly-closed:S5:core:2") }).code, EXIT.done);
  append(s.records, ...partly);
  assert.equal(s.run("critic", { dry: true }).code, EXIT.records, "the diagnosis came before the row");
  // The key only in the reviewer's report, not in the lead's task.
  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-diagnosis", task: diagnosis(null, "Diagnose `partly-closed:S5:core:2`.\n") }).code, EXIT.done);
  assert.equal(s.run("critic", { round: 2, dry: true }).code, EXIT.records, "named in prose and in the report only");
  // Another mode of the reviewer.
  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-subtraction", task: diagnosis("partly-closed:S5:core:2") }).code, EXIT.done);
  assert.equal(s.run("critic", { round: 2, dry: true }).code, EXIT.records, "a subtraction review is no diagnosis");
  // Another phase's diagnosis.
  s.cfg.phase = "S9";
  assert.equal(s.run("reviewer", { round: 3, step: "reviewer-diagnosis", task: diagnosis("partly-closed:S5:core:2") }).code, EXIT.done);
  s.cfg.phase = "S5";
  const still = s.run("critic", { round: 3, dry: true });
  assert.equal(still.code, EXIT.records, "a diagnosis of phase S9");
  // The gate prints a step whose record is free in that round.
  assert.match(still.message, /--round 3 --step reviewer-diagnosis-b /, "round 3 holds S9's reviewer-diagnosis record");
  assert.match(s.run("critic", { round: 4, dry: true }).message, /--round 4 --step reviewer-diagnosis /);
  assert.equal(s.run("reviewer", { round: 3, step: "reviewer-diagnosis-b", task: diagnosis("partly-closed:S5:core:2") }).code, EXIT.done);
  assert.equal(s.run("critic", { round: 4, dry: true }).code, EXIT.done);
});

test("every key must be named; alarms that fired on rows of another phase do not count", async () => {
  const s = await setup({});
  append(s.records, row(1, { phase: "S4", opened: "bug:A" }), row(2, { phase: "S4" }), row(3, { phase: "S4" }));
  assert.equal(s.run("critic", { dry: true }).code, EXIT.done, "S4's alarms do not stop S5");
  append(s.records, row(4, { opened: "bug:B" }), row(5), row(6, { opened: "bug:C" }));
  const r = s.run("critic", { dry: true });
  assert.equal(r.code, EXIT.records);
  // bug opened again in S5 rounds: the class alarm fired on an S5 row now.
  for (const key of ["blocker-recurring:bug", "partly-closed:S5:core:5", "partly-closed:S5:core:6", "area-rounds:S5:core"]) assert.match(r.message, new RegExp(key));
  assert.doesNotMatch(r.message, /S4:core/);
  assert.equal(s.run("reviewer", { round: 7, step: "reviewer-diagnosis", task: diagnosis("partly-closed:S5:core:5, area-rounds:S5:core, blocker-recurring:bug") }).code, EXIT.done);
  const left = s.run("critic", { round: 7, dry: true });
  assert.equal(left.code, EXIT.records);
  assert.match(left.message, /alarms: partly-closed:S5:core:6\n/);
});

test("the gate reads the view the role gets: a view pinned before the row has no alarm, and the call agrees with its dry run", async () => {
  const s = await setup({});
  const before = git(s.records, "rev-parse", "HEAD");
  append(s.records, ...partly);
  assert.equal(s.run("actor", { dry: true }).code, EXIT.records);
  assert.equal(s.run("actor", { dry: true, view: before }).code, EXIT.done);
  assert.equal(s.run("actor", { view: before }).code, EXIT.done);
});

test("loop.mjs next lists exactly the alarms the gate refuses on, with the gate's own matching", async () => {
  const s = await setup({});
  const next = () => {
    const config = join(s.dir, "loop.json");
    writeFileSync(config, JSON.stringify(s.cfg));
    const r = spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", config], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  append(s.records, ...partly);
  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-diagnosis", task: diagnosis(null, "Diagnose `partly-closed:S5:core:2`.\n") }).code, EXIT.done);
  assert.equal(s.run("critic", { round: 3, dry: true }).code, EXIT.records, "a backquoted key in prose is no diagnosis");
  const listed = next();
  assert.match(listed, /alarms need diagnosis: partly-closed:S5:core:2/);
  assert.match(listed, /alarms: partly-closed:S5:core:2/);
  assert.match(listed, /alarms with no matching diagnosis/);
  assert.equal(s.run("reviewer", { round: 3, step: "reviewer-diagnosis", task: diagnosis("partly-closed:S5:core:2") }).code, EXIT.done);
  assert.equal(s.run("critic", { round: 4, dry: true }).code, EXIT.done);
  const cleared = next();
  assert.doesNotMatch(cleared, /alarms need diagnosis|alarms with no matching diagnosis/);
});

test("a malformed trajectory at the view refuses the call with the reason, never a silent pass", async () => {
  const s = await setup({});
  put(s.records, TRAJECTORY, "{\"round\": \"one\"}\n");
  git(s.records, "add", TRAJECTORY);
  git(s.records, "commit", "-qm", "bad row");
  const r = s.run("critic", { dry: true });
  assert.equal(r.code, EXIT.records);
  assert.match(r.message, /cannot be read for the alarm check/);
});

test("record is never refused by an alarm: a child prepared before the row is recorded after it", async () => {
  const s = await setup({}, { agents: { actor: { runner: "t3", provider: "codex", model: "fixture" } } });
  const { prepared: p } = s.run("actor", { prepare: true });
  const transcript = join(p.ws, "fixture.jsonl");
  put(p.ws, "fixture.jsonl", [
    { type: "session_meta", payload: { id: p.id } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: p.prompt }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  put(p.ws, "out/report.md", "fixture report\n");
  append(s.records, ...partly);
  const result = recordCall(s.cfg, p.ws, { transcript, session: p.id });
  assert.equal(result.code, EXIT.done, result.message);
});

test("alarm-deadlock regression: ci-absent blocks judge --prepare with reviewer --prepare guidance, and t3:antigravity reviewer-diagnosis unblocks it", async () => {
  const s = await setup({}, {
    agents: {
      reviewer: { runner: "t3", provider: "antigravity", model: "gemini-4-neon" },
      judge: { runner: "t3", provider: "codex", model: "gpt-5.4" },
      critic: { runner: "t3", provider: "codex", model: "gpt-5.4" },
      actor: { runner: "t3", provider: "antigravity", model: "gemini-4-neon" },
    },
  });
  append(s.records, row(30, { ci: "absent" }));
  const blocked = s.run("judge", { round: 31, prepare: true });
  assert.equal(blocked.code, EXIT.records, blocked.message);
  assert.match(blocked.message, /ci-absent:S5:30/);
  assert.match(blocked.message, /call\.mjs .* reviewer --round 31 --step reviewer-diagnosis --task .* --prepare/);

  const prep = s.run("reviewer", { round: 31, step: "reviewer-diagnosis", task: diagnosis("ci-absent:S5:30"), prepare: true });
  assert.equal(prep.code, EXIT.done, prep.message);
  const { ws, wt, prompt } = prep.prepared;
  assert.equal(wt, null);
  put(ws, "out/report.md", "VERDICT: CONTINUE\nPREMISE: ci was absent in round 30.\n");

  const agHome = temp("ag-diag-home-"), convId = "diag-ag-session";
  const prevAg = process.env.ANTIGRAVITY_APP_DATA_DIR, prevGem = process.env.GEMINI_HOME, prevT3 = process.env.T3CODE_HOME;
  process.env.ANTIGRAVITY_APP_DATA_DIR = agHome;
  process.env.GEMINI_HOME = temp("gemini-diag-home-");
  process.env.T3CODE_HOME = "";
  try {
    const ts = new Date().toISOString();
    const transcript = join(agHome, "brain", convId, ".system_generated", "logs", "transcript_full.jsonl");
    put(dirname(transcript), "transcript_full.jsonl", [
      { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: ts, content: prompt },
      { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ts, model: "gemini-4-neon",
        tool_calls: [{ name: "read_file", args: { Path: join(ws, "records/INDEX.md") } }, { name: "write_file", args: { Path: join(ws, "out/report.md"), Content: "VERDICT: CONTINUE\n" } }] },
      { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", created_at: ts },
      { step_index: 3, source: "MODEL", type: "GENERIC", status: "DONE", created_at: ts },
      { step_index: 4, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: ts, model: "gemini-4-neon" },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const rec = recordCall(s.cfg, ws, { session: convId });
    assert.equal(rec.code, EXIT.done, rec.message);
    assert.equal(rec.handoff.id, "R-0031-reviewer-diagnosis");
    assert.equal(rec.handoff.agent.runner, "t3:antigravity");
  } finally {
    if (prevAg === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR; else process.env.ANTIGRAVITY_APP_DATA_DIR = prevAg;
    if (prevGem === undefined) delete process.env.GEMINI_HOME; else process.env.GEMINI_HOME = prevGem;
    if (prevT3 === undefined) delete process.env.T3CODE_HOME; else process.env.T3CODE_HOME = prevT3;
  }

  const unblocked = s.run("judge", { round: 31, prepare: true });
  assert.equal(unblocked.code, EXIT.done, unblocked.message);
  assert.ok(unblocked.prepared.wt);
});
