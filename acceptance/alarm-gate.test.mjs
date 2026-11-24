import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ledgerPath } from "./closing-fixture.mjs";
import { has, json, jsonOutput, jsonl, output, put, status, world } from "./fixture.mjs";

const history = JSON.parse(readFileSync(new URL("./fixtures/round5-replay.json", import.meta.url), "utf8"));
const handoffPath = "metrics/handoffs.jsonl";
const t3 = { runner: "t3", provider: "codex" };
const trigger = "2026-11-21T18:00:00Z";
const earlier = "2026-11-21T17:00:00Z";
const later = "2026-11-21T19:00:00Z";
const checkAt = "2026-11-21T20:00:00Z";

function callWorld(t, { clock } = {}) {
  const w = world(t, { clock });
  const product = w.repo(join(w.dir, "product"), { "README.md": "# Fixture\n" });
  const sha = w.git(product, "rev-parse", "HEAD");
  const workDir = join(w.dir, "roles");
  const records = join(w.dir, "records");
  const roles = ["critic", "actor", "judge", "reviewer"];
  const planDocs = {};
  const planFor = new Map();
  let planSeq = 1;
  for (let r = 1; r <= 6; r++) {
    const pad = String(r).padStart(4, "0");
    for (const [role, step] of [["critic", "critic"], ["actor", "actor"], ["actor", "actor-b"], ["judge", "judge"]]) {
      const id = `PL-${String(planSeq++).padStart(4, "0")}`;
      const tag = step.replace(/[^a-z]/g, "");
      const handoff = `R-${pad}-${step}`;
      const pkgs = role === "actor" ? [
        { id: step, role: "actor", handoff, files: "", reviews: null },
        { id: `${step}-cr`, role: "critic", handoff: `R-${pad}-critic-${tag}cov`, files: "", reviews: step },
        { id: `${step}-jg`, role: "judge", handoff: `R-${pad}-judge-${tag}cov`, files: "", reviews: null },
      ] : [{ id: step, role, handoff, files: "", reviews: null }];
      planDocs[`plans/${id}.md`] = [
        `# ${id} Replay plan`, `scope: v1/r${r}-${step}`, "phase: v1", "",
        ...pkgs.flatMap(q => [
          `## ${q.id}`, `role: ${q.role}`, `handoff: ${q.handoff}`, "authority: D-0001",
          `goal: Replay ${q.handoff}`, `files: ${q.files}`, "interface: fixed", "acceptance: pass", "needs:",
          ...(q.reviews ? [`reviews: ${q.reviews}`] : []), "",
        ]),
      ].join("\n");
      planFor.set(`${role}:${r}:${step}`, { plan: id, pkg: step });
    }
  }
  w.repo(records, {
    "records.json": json({ extraKinds: [{ kind: "Plan", path: "plans/PL-NNNN.md", changes: "immutable", citedAs: "PL-NNNN" }] }),
    "loop.json": json({
      phase: "v1", branch: "main", product, records, workDir,
      briefs: Object.fromEntries(roles.map(role => [role, `engines/${role}.md`])),
      agents: { critic: t3, actor: t3, judge: t3, reviewer: { runner: "claude" } },
    }),
    "decisions/D-0001.md": "# D-0001 Replay authority\n\nid: D-0001\nby: owner\nstatus: active\n",
    "purpose/P-0001.md": "# P-0001 The phase progresses\n\nstatus: active\n",
    "blueprint/F-0003.md": "# F-0003 Supervise the phase\n\nid: F-0003\nphase: v1\nrequirements: P-0001\n",
    ...planDocs,
    ...Object.fromEntries(roles.map(role => [`engines/${role}.md`, `# Fixture ${role}\n`])),
  });
  const config = join(records, "loop.json");
  const call = (role, { round, step = role, mode = "--dry-run", view, configFile = config, features = ["F-0003"] }) => {
    const task = put(w.dir, "call-task.md", `Continue the scheduled ${step} task.\nfeatures: ${features.length ? features.join(", ") : "none"}\n`);
    const bound = planFor.get(`${role}:${round}:${step}`);
    const planArgs = role !== "reviewer" && bound ? ["--plan", bound.plan, "--package", bound.pkg] : [];
    return w.run([configFile, role, "--round", String(round), "--step", step, ...planArgs, "--task", task,
      ...(view ? ["--view", view] : []), ...(mode ? [mode] : [])], { entry: "call.mjs", at: checkAt });
  };
  const snapshot = (rows, handoffs, tasks = {}, reports = {}) => {
    for (const h of handoffs) {
      const fence = "```";
      const report = reports[h.id] ? "\n## Report (verbatim)\n\n" + fence + "text\n" + reports[h.id] + "\n" + fence + "\n" : "";
      const task = tasks[h.id] ?? "Replay task";
      put(records, h.record, "# " + h.id + "\n\n## Task (verbatim)\n\n" + fence + "text\n" + task + "\n" + fence + "\n" + report);
    }
    put(records, handoffPath, jsonl(...handoffs));
    put(records, ledgerPath, jsonl(...rows));
    w.git(records, "add", "--", "metrics", ...(handoffs.length ? ["rounds"] : []));
    status(w.run(["--repo", records, "--write"], { entry: "records-check.mjs" }), 0);
    return w.commit(records, "Record the call's facts");
  };
  return { w, call, sha, records, config, workDir, snapshot };
}

function expectGate(s, result, keys) {
  status(result, 7);
  for (const key of keys) has(output(result), key);
  has(output(result), "reviewer-diagnosis");
  has(output(result), "call.mjs");
  assert.equal(existsSync(s.workDir), false, "the refusal happens before creating a role workspace");
  assert.equal(s.w.git(s.records, "status", "--porcelain"), "");
}

function replay(t, wanted, { trajectory = history.trajectory, alarms = {} } = {}) {
  const s = callWorld(t);
  const snapshots = new Map();
  const results = wanted.map(id => {
    const index = history.handoffs.findIndex(h => h.id === id);
    assert.ok(index >= 0, id);
    const h = history.handoffs[index];
    if (!snapshots.has(h.view)) {
      const view = s.snapshot(trajectory.filter(row => row.round < h.round), history.handoffs.slice(0, index));
      snapshots.set(h.view, view);
    }
    const before = s.w.git(s.records, "rev-parse", "HEAD");
    const result = s.call(h.role, { ...h, view: snapshots.get(h.view) });
    assert.equal(s.w.git(s.records, "rev-parse", "HEAD"), before, id);
    assert.equal(s.w.git(s.records, "status", "--porcelain"), "", id);
    return { id, result };
  });
  for (const { id, result } of results) {
    const keys = alarms[id];
    assert.equal(result.status, keys ? 7 : 0, id + "\n" + output(result));
    if (keys) {
      expectGate(s, result, keys);
      const alarmKey = /\b(?:area-rounds|blocker-recurring|partly-closed|ci-not-green|ci-absent|growth):[\w-]+(?:[.:/][\w-]+)*/g;
      const named = output(result).match(alarmKey) ?? [];
      assert.deepEqual([...new Set(named)].sort(), [...keys].sort(), id);
    } else {
      has(output(result), "dry run");
    }
  }
}

test("R5-AL-01 history refuses R-0003-critic and R-0004-critic for undiagnosed alarms", t => {
  replay(t, ["R-0003-critic", "R-0004-critic"], {
    alarms: {
      "R-0003-critic": [
        "partly-closed:v1:watch:2", "blocker-recurring:tip-ci-evidence", "ci-absent:v1:1", "ci-absent:v1:2",
      ],
      "R-0004-critic": [
        "partly-closed:v1:watch:2", "blocker-recurring:tip-ci-evidence", "partly-closed:v1:watch:3", "area-rounds:v1:watch",
        "ci-absent:v1:1", "ci-absent:v1:2", "ci-absent:v1:3",
      ],
    },
  });
});

test("R5-AL-02A every historical round-2 call is refused for round 1's absent CI alone", t => {
  const calls = history.handoffs.filter(h => h.round === 2).map(h => h.id);
  replay(t, calls, {
    alarms: Object.fromEntries(calls.map(id => [id, ["ci-absent:v1:1"]])),
  });
});

test("R5-AL-02B every round-1 and round-2 call passes when only round 1's CI word is green", t => {
  const calls = history.handoffs.filter(h => h.round <= 2).map(h => h.id);
  const trajectory = history.trajectory.map(row => row.round === 1 ? { ...row, ci: "success" } : row);
  replay(t, calls, { trajectory });
});

const frame = history.handoffs[0];
const diagnosis = (round, phase, time) => {
  const id = String(round).padStart(4, "0") + "-reviewer-diagnosis";
  const record = "rounds/" + id + ".md";
  return { ...frame, id: "R-" + id, role: "reviewer", step: "reviewer-diagnosis", record,
    files: [record], round, phase, time };
};
const row = (round, phase, ci, overrides = {}) => ({
  round, phase, role: "judge", verdict: "CONTINUE", time: trigger, ci, area: "watch", ...overrides,
});

test("R5-AL-05 a grown partly-closed alarm needs its own later diagnosis", t => {
  const s = callWorld(t);
  const rows = [row(1, "v1", "success", { opened: "layout:link" }), row(2, "v1", "success"), row(3, "v1", "success")];
  const reviewed = diagnosis(4, "v1", later);
  s.snapshot(rows, [frame, reviewed], { [reviewed.id]: "alarms: partly-closed:v1:watch:2, area-rounds:v1:watch" });
  const key = "partly-closed:v1:watch:3";
  expectGate(s, s.call("actor", { round: 5, mode: "--prepare" }), [key]);
  const next = diagnosis(5, "v1", checkAt);
  s.snapshot(rows, [frame, reviewed, next], {
    [reviewed.id]: "alarms: partly-closed:v1:watch:2, area-rounds:v1:watch",
    [next.id]: "alarms: " + key,
  });
  status(s.call("actor", { round: 6, mode: "--prepare" }), 0);
});

test("R5-AL-06 another phase's alarms are irrelevant to a current-phase call", t => {
  const s = callWorld(t);
  s.snapshot([
    row(1, "v0", "failure", { opened: "layout:link" }), row(2, "v0", "success"), row(2, "v1", "success"),
  ], [frame]);
  status(s.call("judge", { round: 3 }), 0);
});

test("R5-AL-07 all adversarial roles are gated while the reviewer can diagnose", t => {
  const s = callWorld(t);
  const rows = [row(1, "v1", "failure")];
  const view = s.snapshot(rows, [frame]);
  const cli = JSON.parse(readFileSync(s.config, "utf8"));
  for (const role of ["critic", "actor", "judge"]) {
    cli.agents[role] = { runner: "codex" };
  }
  const cliConfig = put(s.w.dir, "cli-loop.json", json(cli));
  for (const role of ["critic", "actor", "judge"]) {
    expectGate(s, s.call(role, { round: 2, mode: null, view, configFile: cliConfig }), ["ci-not-green:v1:1"]);
    for (const mode of ["--dry-run", "--prepare"]) {
      expectGate(s, s.call(role, { round: 2, mode, view }), ["ci-not-green:v1:1"]);
    }
  }
  status(s.call("reviewer", { round: 2, step: "reviewer-diagnosis" }), 0);
  assert.equal(s.w.git(s.records, "rev-parse", "HEAD"), view);
});

test("R5-AL-08 the same key in an older or other-phase diagnosis does not discharge an alarm", t => {
  const s = callWorld(t);
  const key = "ci-not-green:v1:2";
  const before = diagnosis(2, "v1", earlier);
  const elsewhere = diagnosis(3, "v0", later);
  s.snapshot([row(2, "v1", "failure")], [frame, before, elsewhere], {
    [before.id]: "alarms: " + key,
    [elsewhere.id]: "alarms: " + key,
  });
  expectGate(s, s.call("judge", { round: 4 }), [key]);
});

test("R5-AL-09 record may finish an already prepared call when an alarm arrives", t => {
  const s = callWorld(t);
  s.snapshot([], [frame]);
  const prepared = jsonOutput(s.call("critic", { round: 2, mode: "--prepare" }));
  s.snapshot([row(1, "v1", "failure")], [frame]);
  put(prepared.ws, "out/report.md", "Completed the previously prepared call.\n");
  const session = "alarm-acceptance-child";
  const transcript = put(s.w.dir, "child.jsonl", jsonl(
    { timestamp: checkAt, type: "session_meta", payload: { cwd: prepared.wt, id: session } },
    { timestamp: checkAt, type: "response_item", payload: { type: "message", role: "user",
      content: [{ type: "input_text", text: prepared.prompt }] } },
    { timestamp: checkAt, type: "event_msg", payload: { type: "task_complete" } },
  ));
  const handoff = jsonOutput(s.w.run([s.config, "record", "--ws", prepared.ws, "--session", session,
    "--transcript", transcript], { entry: "call.mjs", at: checkAt }));
  assert.equal(handoff.id, "R-0002-critic");
  has(s.w.git(s.records, "show", "HEAD:" + handoffPath), handoff.id);
});

test("R5-AL-10 a quoted key or a report-only alarms line cannot stand in for the task's declaration", t => {
  const s = callWorld(t);
  const key = "ci-not-green:v1:2";
  const prose = diagnosis(3, "v1", later);
  const report = diagnosis(4, "v1", later);
  s.snapshot([row(2, "v1", "failure")], [frame, prose, report], {
    [prose.id]: "Compare the old note mentioning `" + key + "`.",
  }, { [report.id]: "alarms: " + key });
  expectGate(s, s.call("actor", { round: 5 }), [key]);
});

test("R5-AL-11 commit order decides whether a diagnosis with the triggering row's timestamp counts", t => {
  const key = "ci-not-green:v1:2";
  const rows = [row(2, "v1", "failure")];
  const reviewed = diagnosis(3, "v1", trigger);
  const tasks = { [reviewed.id]: "alarms: " + key };

  const diagnosisFirst = callWorld(t, { clock: trigger });
  diagnosisFirst.snapshot([], [frame, reviewed], tasks);
  diagnosisFirst.snapshot(rows, [frame, reviewed], tasks);
  const refused = diagnosisFirst.call("actor", { round: 4 });

  const rulingFirst = callWorld(t, { clock: trigger });
  rulingFirst.snapshot(rows, [frame]);
  rulingFirst.snapshot(rows, [frame, reviewed], tasks);
  const admitted = rulingFirst.call("actor", { round: 4 });

  expectGate(diagnosisFirst, refused, [key]);
  status(admitted, 0);
});
