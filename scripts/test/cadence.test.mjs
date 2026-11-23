// D-0032, design/generative-engine-b.md#tests
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { UsageError } from "../lib/args.mjs";
import { advancingAction, cadenceLines, cadenceOf, cadenceState, CADENCE_DEFAULTS, dueReason } from "../lib/cadence.mjs";
import { git, roomyStore, scripts, setup, temp } from "./helpers.mjs";

const handoff = (round, step, extra = {}) => ({ id: `R-${String(round).padStart(4, "0")}-${step}`, round, step, role: step.split("-")[0],
  time: `2026-11-2${Math.min(round, 9)}T00:00:00Z`, ...extra });
const ruling = (round, extra = {}) => ({ round, phase: "v1", role: "judge", verdict: "CONTINUE", area: "core", opened: "-", closed: "-", ...extra });
const state = (handoffs, rows, options = {}) => cadenceState({ handoffs, rows, nextRound: 99, ...options });
const frame = handoff(1, "reviewer-frame");

test("flow: the lead configures the cadence in loop.json; loss: wrong-result when a bad value silently becomes the default", () => {
  assert.deepEqual(cadenceOf({}), { adversarial: CADENCE_DEFAULTS.adversarial, source: "default" });
  assert.deepEqual(cadenceOf({ cadence: {} }), { adversarial: 3, source: "default" });
  assert.deepEqual(cadenceOf({ cadence: { adversarial: 5 } }), { adversarial: 5, source: "loop.json" });
  for (const cadence of [null, 3, [], "3", { adversarial: 0 }, { adversarial: -1 }, { adversarial: 2.5 }, { adversarial: "3" },
    { adversarial: null }, { adversarial: 3, advancing: 1 }])
    assert.throws(() => cadenceOf({ cadence, configFile: "/x/loop.json" }), e => e instanceof UsageError && e.message.startsWith("/x/loop.json: cadence"), JSON.stringify(cadence));
});

test("flow: the lead runs three judged rounds after the phase frame; loss: stuck when the advancing round is never called", () => {
  assert.equal(state([frame], [ruling(1), ruling(2)]).due, false);
  const due = state([frame], [ruling(1), ruling(2), ruling(3)]);
  assert.equal(due.due, true);
  assert.deepEqual(due.rounds, [1, 2, 3]);
  assert.deepEqual(due.baseline, { kind: "frame", round: 1, ids: ["R-0001-reviewer-frame"] });
  assert.equal(due.next.round, 99);
  assert.equal(due.next.started, false);
  assert.deepEqual(due.next.calls.map(c => [c.step, c.state]), [["reviewer-frame-blind", "due"], ["reviewer-frame", "due"], ["judge-frame", "due"]]);
  assert.equal(state([frame], [ruling(1)], { adversarial: 1 }).due, true);
  assert.equal(state([frame], [ruling(1), ruling(2), ruling(3)], { adversarial: 4 }).due, false);
});

test("flow: rows that are not judged adversarial rulings of the window; loss: false-verdict when they count toward the cadence", () => {
  const rows = [ruling(1), ruling(1, { area: "other" }), ruling(2, { verdict: "-" }), ruling(3, { role: "actor" })];
  assert.deepEqual(state([frame], rows).rounds, [1], "one round with two judge rows, a judge row with no ruling and an actor row");
  assert.deepEqual(state([handoff(3, "reviewer-frame")], [ruling(1), ruling(2), ruling(3), ruling(4)]).rounds, [3, 4], "rows before the phase frame");
  const none = state([], [ruling(1), ruling(2), ruling(3)]);
  assert.equal(none.baseline, null);
  assert.equal(none.due, false);
});

test("flow: an advancing round holds a frame and a judge-frame hand-off; loss: false-verdict when the count does not restart after it", () => {
  const advanced = [frame, handoff(4, "reviewer-frame-blind"), handoff(4, "judge-frame")];
  const after = state(advanced, [1, 2, 3, 4, 5, 6].map(r => ruling(r)));
  assert.deepEqual(after.baseline, { kind: "advancing", round: 4, ids: ["R-0004-reviewer-frame-blind", "R-0004-judge-frame"] });
  assert.deepEqual(after.rounds, [5, 6], "the advancing round's own judge row is not adversarial");
  assert.equal(after.due, false);
  assert.equal(state(advanced, [5, 6, 7].map(r => ruling(r))).due, true);
  const half = state([frame, handoff(4, "reviewer-frame-b")], [1, 2, 3, 5].map(r => ruling(r)));
  assert.deepEqual(half.rounds, [1, 2, 3, 5], "a frame without a judge-frame is no advancing round");
  const variant = state([frame, handoff(4, "reviewer-frame"), handoff(4, "judge-frame-b")], [1, 2, 3, 5].map(r => ruling(r)));
  assert.deepEqual(variant.rounds, [5]);
});

test("flow: the lead resumes an advancing round after its first call; loss: wrong-result when next splits it over two rounds", () => {
  const rows = [1, 2, 3].map(r => ruling(r));
  const framed = state([frame, handoff(4, "reviewer-frame"), handoff(4, "reviewer-diagnosis")], rows);
  assert.equal(framed.next.round, 4);
  assert.equal(framed.next.started, true);
  assert.deepEqual(framed.next.calls.map(c => [c.step, c.state, c.id ?? null]),
    [["reviewer-frame-blind", "covered", "R-0004-reviewer-frame"], ["reviewer-frame", "recorded", "R-0004-reviewer-frame"], ["judge-frame", "due", null]]);
  const blind = state([frame, handoff(4, "reviewer-frame-blind")], rows);
  assert.deepEqual(blind.next.calls.map(c => c.state), ["recorded", "due", "due"]);
  const prepared = state([frame, handoff(4, "reviewer-frame")], rows, { prepared: [{ round: 4, step: "judge-frame", id: "R-0004-judge-frame" }] });
  assert.deepEqual(prepared.next.calls.map(c => c.state), ["covered", "recorded", "prepared"]);
  const preparedOnly = state([frame], rows, { prepared: [{ round: 6, step: "judge-frame", id: "R-0006-judge-frame" }, { round: 5, step: "critic", id: "R-0005-critic" }] });
  assert.equal(preparedOnly.next.round, 6);
  assert.equal(state([frame], rows).next.started, false, "the phase frame of round 1 is no advancing round in progress");
});

test("flow: the advancing round reads where returns fall and lists its calls; loss: wrong-result when opened, closed and shelved are mixed up, or when the round tells the lead to stop settled work (D-0032 item 1)", () => {
  const rows = [ruling(1, { area: "watch", opened: "a:R1-1,a:R1-2", carried: "c:R0-1" }), ruling(2, { area: "watch", opened: "a:R2-1", closed: "a:R1-1,a:R1-2" }),
    ruling(2, { area: "push", opened: "p:R2-2", closed: "-" }), ruling(3, { area: "-", shelved: "a:R2-1", closed: "c:R0-1" })];
  const s = state([frame], rows);
  assert.deepEqual(s.returns.map(a => [a.area, a.rounds.map(r => [r.round, r.opened.length, r.closed.length, r.shelved.length])]),
    [["watch", [[1, 2, 0, 0], [2, 1, 2, 0]]], ["push", [[2, 1, 0, 0]]], ["-", [[3, 0, 1, 1]]]]);
  const lines = cadenceLines({ adversarial: 3, source: "default", state: s }, "metrics/trajectory.jsonl");
  assert.match(lines[0], /^Cadence: 3 judged adversarial rounds since the phase frame R-0001-reviewer-frame \(rounds 1, 2, 3\) · advancing round due/);
  assert.ok(lines.includes("  watch: round 1 opened 2, closed 0 · round 2 opened 1, closed 2"), lines.join("\n"));
  assert.ok(lines.includes("  no area: round 3 opened 0, closed 1, shelved 1"), lines.join("\n"));
  assert.match(dueReason({ adversarial: 3, source: "default", state: s }), /^advancing round due: 3 judged adversarial rounds .*\(rounds 1, 2, 3; cadence\.adversarial 3, the default; D-0032\)$/);
  const action = advancingAction({ adversarial: 3, source: "loop.json", state: s }, (role, step, round) => [`${role} ${step} ${round}`]);
  assert.match(action.title, /cadence\.adversarial 3 in loop\.json$/);
  assert.deepEqual(action.steps.filter(line => line.startsWith("  ")), ["  reviewer reviewer-frame-blind 99", "  reviewer reviewer-frame 99", "  judge judge-frame 99"]);
  assert.match(action.steps[0], /Hardening of an area under review pauses; work whose direction an owner decision or an independent ruling already settles runs alongside it/);
});

const put = (root, path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const jsonl = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";

test("flow: the lead runs loop.mjs next after three judged rounds; loss: stuck when the advancing round is not listed before the critic and convergence is not withheld, false-verdict when a round not yet due reads as due", async () => {
  const s = await setup();
  const head = git(s.product, "rev-parse", "loop/s5");
  const config = join(s.dir, "loop.json");
  const host = { SELF_LOOP_LOAD_DIR: temp("self-loop-load-"), SELF_LOOP_OWNER_STORE: roomyStore() };
  const next = cfg => {
    writeFileSync(config, JSON.stringify(cfg));
    return spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", config], { encoding: "utf8", env: { ...process.env, ...host } });
  };
  const frameLine = git(s.records, "show", "HEAD:metrics/handoffs.jsonl");
  const commit = (rows, extra = []) => {
    put(s.records, "metrics/trajectory.jsonl", jsonl(rows));
    put(s.records, "metrics/handoffs.jsonl", [frameLine, ...extra.map(h => JSON.stringify(h))].join("\n") + "\n");
    for (const h of extra) put(s.records, h.record, `# ${h.id}\n`);
    put(s.records, "metrics/blueprint.jsonl", jsonl([{ feature: "F-0001", status: "building", time: "2026-11-20T00:00:00Z", by: "lead", note: "Work started", evidence: {} }]));
    git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "rounds");
  };
  const rows = [1, 2, 3].map(round => ({ round, phase: "S5", role: "judge", verdict: "CONTINUE", area: "core", commit: head, time: "2026-11-20T12:00:00Z" }));
  commit(rows);
  const due = next(s.cfg);
  assert.equal(due.status, 0, due.stderr);
  const at = needle => due.stdout.indexOf(needle);
  assert.ok(at("- advancing round due: 3 judged adversarial rounds since the phase frame R-0001-reviewer-frame (rounds 1, 2, 3)") > 0, due.stdout);
  assert.ok(at("- advancing round due") < at("without a recorded running call"), "before the critic item");
  assert.ok(due.stdout.includes(" critic --round 5 "), "the next adversarial round follows the advancing round");
  for (const step of ["reviewer-frame-blind", "reviewer-frame", "judge-frame"]) assert.ok(due.stdout.includes(`--round 4 --step ${step} `), step);
  assert.ok(at("--step reviewer-frame-blind") < at("--step reviewer-frame ") && at("--step reviewer-frame ") < at("--step judge-frame"));
  assert.match(due.stdout, /convergence conditions not met[\s\S]*advancing round due: 3 judged adversarial rounds/);
  assert.match(due.stdout, /^ {2}core: round 1 opened 0, closed 0 · round 2/m);

  const record = (round, step, role) => ({ id: `R-000${round}-${step}`, phase: "S5", round, step, role, record: `rounds/000${round}-${step}.md`,
    files: [`rounds/000${round}-${step}.md`], view: "f".repeat(40), time: "2026-11-20T13:00:00Z", attempt: 1, audit: { violations: 0 },
    agent: { runner: "claude" }, product: role === "judge" ? { base: head, commit: head } : null });
  commit(rows, [record(4, "reviewer-frame-blind", "reviewer"), record(4, "judge-frame", "judge")]);
  const done = next(s.cfg);
  assert.equal(done.status, 0, done.stderr);
  assert.doesNotMatch(done.stdout, /advancing round due|ruling not in the trajectory: R-0004-judge-frame/);
  assert.match(done.stdout, /^Cadence: 0 judged adversarial rounds since the advancing round 4 \(R-0004-reviewer-frame-blind, R-0004-judge-frame\) · next advancing round after 3 judged adversarial rounds, 3 more /m);

  commit(rows);
  const larger = next({ ...s.cfg, cadence: { adversarial: 4 } }).stdout;
  assert.doesNotMatch(larger, /advancing round due/);
  assert.match(larger, /· next advancing round after 4 judged adversarial rounds, 1 more \(cadence\.adversarial 4 in loop\.json/);
  const bad = next({ ...s.cfg, cadence: { adversarial: 0 } });
  assert.equal(bad.status, 64, bad.stdout);
  assert.match(bad.stderr, /cadence\.adversarial must be a positive whole number/);
});
