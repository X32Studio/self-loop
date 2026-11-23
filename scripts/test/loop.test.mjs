import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { CROWDED, git, ownerStore, roomyStore, scripts, setup, skill, temp } from "./helpers.mjs";

const put = (root, path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const jsonl = (...rows) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const phase = "S5";
const building = time => jsonl({ feature: "F-0001", status: "building", time, by: "lead", note: "Work started", evidence: {} });

function run(s, command, ...args) {
  const config = join(s.dir, "loop config.json");
  put(s.dir, "loop config.json", JSON.stringify(s.cfg));
  s.host ??= { SELF_LOOP_LOAD_DIR: temp("self-loop-load-"), SELF_LOOP_OWNER_STORE: roomyStore() };
  return spawnSync(process.execPath, [join(scripts, "loop.mjs"), command, "--config", config, ...args],
    { encoding: "utf8", env: { ...process.env, ...s.host, PATH: `${s.dir}:${process.env.PATH}` } });
}

test("next derives the ordered actions from committed records, prepared work and the gates", async () => {
  const s = await setup({}, { frame: false, gates: { require: ["github-actions/verify"], suite: "npm test" } });
  const head = git(s.product, "rev-parse", "loop/s5"), tree = git(s.product, "rev-parse", "HEAD^{tree}");
  const unmerged = git(s.product, "commit-tree", tree, "-p", head, "-m", "unmerged actor");
  const nextBranch = git(s.product, "rev-parse", "loop/s5");
  const event = (round, role, commit, base = head) => {
    const step = role === "judge" && round === 4 ? "judge-followup" : role;
    const stem = `000${round}-${step}`;
    const record = `rounds/${stem}.md`;
    put(s.records, record, `# R-${stem}\n`);
    return { id: `R-${stem}`, phase, round, record, role, step, product: { base, commit }, files: [record],
      view: "b".repeat(40), time: "2026-11-20T12:00:00Z", attempt: 1, audit: { violations: 0 }, agent: { runner: "codex" } };
  };
  const recorded = [event(1, "actor", unmerged), event(4, "judge", head)];
  put(s.records, "metrics/handoffs.jsonl", jsonl(...recorded));
  put(s.records, "metrics/trajectory.jsonl", jsonl(...[1, 2, 3].map(round => ({
    round, phase, role: "judge", commit: head, area: "records", verdict: "CONTINUE", time: "2026-11-20T12:00:00Z",
  }))));
  put(s.records, "metrics/blueprint.jsonl", building("2026-11-20T00:00:00Z"));
  put(s.records, "blueprint/F-0002.md", "# F-0002 Work to classify\n\nid: F-0002\nphase: S5\nrequirements: P-0001\n");
  put(s.records, "owner/words.jsonl", jsonl({ id: "W-0123456789", text: "Owner input" }));
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "phase records");
  put(s.records, "purpose/P-0099.md", "# Uncommitted draft\n\nwords: W-0123456789\n");
  put(s.dir, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"in_progress\"}'\n");
  chmodSync(join(s.dir, "gh"), 0o755);
  const ws = join(s.cfg.workDir, "0005-actor-a-test");
  mkdirSync(join(ws, "wt"), { recursive: true });
  put(ws, "call.json", JSON.stringify({ version: 1, phase, role: "actor", record: "rounds/0005-actor-a.md", round: 5, step: "actor-a",
    id: "R-0005-actor-a", wt: join(ws, "wt"), ws, nonce: "test", features: ["F-0002"] }));
  const before = git(s.records, "status", "--porcelain");
  const result = run(s, "next");
  assert.equal(result.status, 0, result.stderr);
  const expected = ["unrecorded prepared", "open owner words", "no phase frame", "without status", "without a recorded running call",
    "actor commit not merged", "no suite-green receipt", "CI not green", "ruling not in the trajectory", "alarms need diagnosis", "convergence conditions not met"];
  let pos = -1;
  for (const item of expected) {
    const found = result.stdout.indexOf(item, pos + 1);
    assert.ok(found > pos, `missing or unordered: ${item}\n${result.stdout}`);
    pos = found;
  }
  for (const needle of ["record --ws", "owner-words.mjs open", "reviewer-frame", "blueprint.mjs status", "F-0001", unmerged,
    `--sha ${head}`, "ci-green.mjs", "trajectory.mjs append", "reviewer-diagnosis", "loop config.json"]) assert.ok(result.stdout.includes(needle), needle);
  assert.ok(!result.stdout.includes("no judge ruling on"), "the ruled integration SHA needs no new judge call");
  assert.equal(git(s.records, "status", "--porcelain"), before);
  assert.equal(git(s.product, "rev-parse", "loop/s5"), nextBranch);
  const updated = git(s.product, "commit-tree", tree, "-p", unmerged, "-m", "new integration head");
  git(s.product, "update-ref", "refs/heads/loop/s5", updated);
  assert.match(run(s, "next").stdout, /is ahead of the integration SHA .* by commits no hand-off records/, "an unrecorded branch update is not the integration SHA");
  recorded.push(event(6, "actor", updated, unmerged));
  put(s.records, "metrics/handoffs.jsonl", jsonl(...recorded));
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "a recorded descendant of the ruling");
  put(s.records, "evidence/0005/clean-suite.json", JSON.stringify({ repository: s.product, sha: updated, tree: git(s.product, "rev-parse", `${updated}^{tree}`), green: true }));
  git(s.records, "add", "evidence/0005/clean-suite.json");
  assert.match(run(s, "next").stdout, /no suite-green receipt/, "a staged receipt cannot settle the gate");
  git(s.records, "commit", "-qm", "green suite receipt");
  put(s.dir, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\"}'\n");
  const updatedState = run(s, "next");
  assert.equal(updatedState.status, 0, updatedState.stderr);
  assert.doesNotMatch(updatedState.stdout, /no suite-green receipt|CI not green|actor commit not merged/);
  assert.match(updatedState.stdout, /no judge ruling on the integration head/);
  assert.ok(updatedState.stdout.includes(`--base ${updated}`));
  recorded.push(event(7, "judge", updated, updated));
  put(s.records, "metrics/handoffs.jsonl", jsonl(...recorded));
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "judge hand-off on the descendant");
  const judged = run(s, "next").stdout;
  assert.ok(!judged.includes("no judge ruling on"), "the unlogged judge's hand-off counts as a ruling to review");
  assert.match(judged, new RegExp(`ruling not in the trajectory: R-0007-judge[\\s\\S]*--commit ${updated}`));
});

test("stall uses phase activity timestamps and exits 2 at the threshold", async () => {
  const s = await setup();
  const old = new Date(Date.now() - 10 * 3600_000).toISOString();
  const fresh = new Date(Date.now() - 5 * 60_000).toISOString();
  const stall = () => run(s, "stall", "--hours", "1");
  const commit = message => { git(s.records, "add", "-A"); git(s.records, "commit", "-qm", message); };
  assert.equal(stall().status, 2, "the old frame is also stale before building");
  put(s.records, "metrics/blueprint.jsonl", building(old));
  commit("start building");
  const stopped = stall();
  assert.equal(stopped.status, 2, stopped.stderr);
  assert.match(stopped.stdout, /F-0001.*metrics\/blueprint\.jsonl/);
  put(s.records, "owner/B-0001.md", "# B-0001\n\nphase: S4\n");
  put(s.records, "owner/answers.jsonl", jsonl({ batch: "B-0001", words: "Yes", time: fresh }));
  commit("answer outside the phase");
  assert.equal(stall().status, 2);
  const trajectory = currentPhase => jsonl({ round: 2, phase: currentPhase, role: "judge", verdict: "CONTINUE", time: fresh });
  put(s.records, "metrics/trajectory.jsonl", trajectory(phase));
  commit("new ruling for this phase");
  assert.match(stall().stdout, /metrics\/trajectory\.jsonl/);
  assert.equal(stall().status, 0);
  put(s.records, "metrics/trajectory.jsonl", trajectory("S4"));
  commit("ruling belongs to the other phase");
  assert.equal(stall().status, 2);
  put(s.records, "owner/B-0002.md", "# B-0002\n\nphase: S5\n");
  put(s.records, "owner/answers.jsonl", jsonl({ batch: "B-0001", words: "Yes", time: fresh }, { batch: "B-0002", words: "Yes", time: fresh }));
  commit("answer for the phase");
  const moving = stall();
  assert.equal(moving.status, 0, moving.stderr);
  assert.match(moving.stdout, /owner\/answers\.jsonl/);
  put(s.records, "owner/answers.jsonl", jsonl({ batch: "B-0001", words: "Yes", time: fresh }));
  const handoff = JSON.parse(git(s.records, "show", "HEAD:metrics/handoffs.jsonl"));
  put(s.records, "metrics/handoffs.jsonl", jsonl({ ...handoff, time: fresh }));
  commit("recent frame hand-off");
  assert.match(stall().stdout, /metrics\/handoffs\.jsonl/);
  assert.equal(stall().status, 0);
  assert.equal(run(s, "stall", "--hours", "0").status, 64);
});

test("the operating procedure documents the next and stall commands as screening", () => {
  const skillText = readFileSync(join(skill, "SKILL.md"), "utf8");
  assert.match(skillText, /node scripts\/loop\.mjs next --config <loop\.json>/);
  assert.match(skillText, /node scripts\/loop\.mjs stall --hours N/);
  assert.match(skillText, /^\| 3 Screening .*loop\.mjs/m);
  assert.match(readFileSync(join(skill, "DEBT.md"), "utf8"), /prepared workspace.*live/s);
});

test("next surfaces an unattested protected tip for a version-gated product", async () => {
  const s = await setup();
  const remote = join(s.dir, "remote.git");
  mkdirSync(remote);
  git(remote, "init", "--bare", "-q");
  git(s.product, "remote", "set-url", "origin", remote);
  put(s.product, "VERSION", "1.0.0\n");
  put(s.product, "scripts/version-gate.mjs", "// version-gated fixture\n");
  git(s.product, "add", "VERSION", "scripts");
  git(s.product, "commit", "-qm", "owner update");
  const sha = git(s.product, "rev-parse", "HEAD");
  git(remote, "fetch", "-q", s.product, `${sha}:refs/heads/main`);
  git(s.product, "update-ref", "refs/heads/loop/s5", sha);
  const result = run(s, "next");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`unattested remote tip: refs/heads/main at ${sha}`));
  assert.match(result.stdout, /version-gate\.mjs reconcile .* --close .* --cite/);
});

test("next counts this phase's open blockers", async () => {
  const s = await setup();
  const sha = git(s.product, "rev-parse", "loop/s5");
  const ruling = (phase, area, opened) => ({ round: 1, phase, role: "judge", verdict: "CONTINUE", commit: sha, area, opened });
  put(s.records, "metrics/trajectory.jsonl", jsonl(ruling("S4", "older", "older:legacy"), ruling("S5", "current", "current:own")));
  git(s.records, "add", "-A");
  git(s.records, "commit", "-qm", "distinct phases");
  const blockers = run(s, "next").stdout.split("\n").find(line => /open blockers:/.test(line));
  assert.match(blockers, /current:own/);
  assert.doesNotMatch(blockers, /older:legacy/);
});

test("next keeps committed blocker identities until their terminal dispositions are committed", async () => {
  const s = await setup();
  const sha = git(s.product, "rev-parse", "loop/s5");
  const ruling = (round, fields) => ({ round, phase, role: "judge", verdict: "CONTINUE", commit: sha, area: "delivery", ...fields });
  const rows = [ruling(1, { opened: "delivery:opened:part", carried: "release:carried" })];
  const write = () => put(s.records, "metrics/trajectory.jsonl", jsonl(...rows));
  const commit = () => {
    git(s.records, "add", "metrics/trajectory.jsonl");
    git(s.records, "commit", "-qm", "record blocker dispositions");
  };
  const shown = () => {
    const result = run(s, "next");
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const open = text => text.split("\n").find(line => /open blockers:/.test(line)) ?? "";
  write();
  assert.equal(open(shown()), "");
  commit();
  const committed = open(shown());
  assert.match(committed, /delivery:opened:part \(R-0001\)/);
  assert.match(committed, /release:carried \(R-0001\)/);
  rows.push(ruling(2, { closed: "delivery:opened:part", shelved: "release:carried" }));
  write();
  assert.equal(open(shown()), committed);
  git(s.records, "add", "metrics/trajectory.jsonl");
  assert.equal(open(shown()), committed);
  commit();
  const terminal = shown();
  assert.equal(open(terminal), "");
  assert.match(terminal, /Shelved blockers \(known limits, not open\): release:carried \(R-0002\)/);
});

test("open blockers are the opened and carried keys minus the closed and shelved ones; shelved keys stay visible", async () => {
  const s = await setup();
  const sha = git(s.product, "rev-parse", "loop/s5");
  const ruling = (round, fields) => ({ round, phase: "S5", role: "judge", verdict: "CONTINUE", commit: sha, area: "driver", ...fields });
  put(s.records, "metrics/trajectory.jsonl", jsonl(
    ruling(1, { opened: "gate:R1-1,gate:R1-2,gate:R1-3" }),
    ruling(2, { closed: "gate:R1-1", shelved: "gate:R1-2", carried: "older:R0-9" }),
  ));
  git(s.records, "add", "-A");
  git(s.records, "commit", "-qm", "rulings with shelved and carried blockers");
  const out = run(s, "next").stdout;
  const blockers = out.split("\n").find(line => /open blockers:/.test(line));
  assert.match(blockers, /gate:R1-3 \(R-0001\)/);
  assert.match(blockers, /older:R0-9 \(R-0002\)/, "a blocker carried from an earlier phase gates this one until closed");
  assert.doesNotMatch(blockers, /R1-1|R1-2/);
  assert.match(out, /Shelved blockers \(known limits, not open\): gate:R1-2 \(R-0002\)/);
  put(s.records, "metrics/trajectory.jsonl", jsonl(
    ruling(1, { opened: "gate:R1-2" }), ruling(2, { shelved: "gate:R1-2" }), ruling(3, { opened: "gate:R1-2" }),
  ));
  git(s.records, "add", "-A");
  git(s.records, "commit", "-qm", "a shelved blocker opened again");
  assert.match(run(s, "next").stdout.split("\n").find(line => /open blockers:/.test(line)), /gate:R1-2 \(R-0003\)/);
});

test("next suggests a heavy call only while the measured host is within the bound, and shows the heavy-call count without bounding by it", async () => {
  const s = await setup({}, { frame: false, gates: { require: ["github-actions/verify"], suite: "npm test" } });
  const load = temp("self-loop-load-");
  for (let n = 0; n < 5; n++) writeFileSync(join(load, `suite-${process.pid}-${n}.json`), JSON.stringify({ kind: "suite", pid: process.pid, repo: s.product }));
  const heavy = text => text.split("\n").filter(line => /call\.mjs.* (?:critic|actor|judge) --round |suite-green\.mjs.* --command /.test(line));
  const roomy = ownerStore([], { bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0, heavyBudget: 1 } });
  s.host = { SELF_LOOP_LOAD_DIR: load, SELF_LOOP_OWNER_STORE: roomy };
  const within = run(s, "next").stdout;
  assert.match(within, /^Load 5: heavy calls on this host .*shown, not the bound/m);
  assert.match(within, /^Host within the bound: 1-minute load average [\d.]+ on \d+ cores \(at most 1000000000 × \d+ = [\d.e+]+\), available memory [\d.]+ GiB \(at least 0 GiB\); bound from .*products\.json maxLoadRatio, minAvailableMemoryGB/m);
  assert.match(within, /products\.json heavyBudget is no longer read: the bound is the measured host state \(D-0025\)/);
  assert.ok(heavy(within).length >= 2, within);
  assert.doesNotMatch(within, /Waiting on the host load/);
  const lowMemory = ownerStore([], { bound: { ...CROWDED, maxLoadRatio: 1e9 } });
  s.host = { SELF_LOOP_LOAD_DIR: temp("self-loop-load-"), SELF_LOOP_OWNER_STORE: lowMemory };
  const over = run(s, "next").stdout;
  assert.match(over, /^Load 0: /m);
  assert.match(over, /^Host over the bound: .*at least 1000000000 GiB\)/m);
  assert.match(over, /Waiting on the host load: available memory [\d.]+ GiB is below 1000000000 GiB\. No new heavy call/);
  assert.deepEqual(heavy(over), []);
  assert.match(over, /call\.mjs.* reviewer --round \d+ --step reviewer-frame/, "the reviewer is not a heavy call and stays offered");
});

test("stall clocks pre-building phases using blueprint activity and reports a phase without features", async () => {
  const s = await setup({}, { frame: false });
  const activity = time => jsonl({ feature: "F-0001", status: "designing", time, by: "lead", note: "Design", evidence: {} });
  const putActivity = time => {
    put(s.records, "metrics/blueprint.jsonl", activity(time));
    git(s.records, "add", "-A");
    git(s.records, "commit", "-qm", "design event");
  };
  putActivity("2026-01-01T00:00:00Z");
  const stalled = run(s, "stall", "--hours", "1");
  assert.equal(stalled.status, 2, stalled.stdout);
  assert.match(stalled.stdout, /STALL.*F-0001.*metrics\/blueprint.jsonl/);
  putActivity(new Date().toISOString());
  assert.match(run(s, "stall", "--hours", "1").stdout, /active.*metrics\/blueprint.jsonl/);
  s.cfg.phase = "empty-phase";
  const empty = run(s, "stall", "--hours", "0.000001");
  assert.equal(empty.status, 2, empty.stdout);
  assert.match(empty.stdout, /STALL.*no features/);
});

test("diverged hand-offs wait on the lead's merge, which becomes the integration SHA once a hand-off records on it", async () => {
  const s = await setup();
  const base = git(s.product, "rev-parse", "loop/s5"), tree = git(s.product, "rev-parse", `${base}^{tree}`);
  const left = git(s.product, "commit-tree", tree, "-p", base, "-m", "critic cases");
  const right = git(s.product, "commit-tree", tree, "-p", base, "-m", "actor work");
  const frame = JSON.parse(git(s.records, "show", "HEAD:metrics/handoffs.jsonl"));
  const event = (round, role, product) => {
    const record = `rounds/000${round}-${role}.md`;
    put(s.records, record, `# R-000${round}-${role}\n`);
    return { ...frame, id: `R-000${round}-${role}`, round, role, step: role, record, files: [record], product };
  };
  put(s.records, "metrics/trajectory.jsonl", jsonl({ round: 1, phase, role: "judge", commit: base, area: "core", verdict: "CONTINUE", time: "2026-11-20T12:00:00Z" }));
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "ruling");
  const rows = [frame, event(2, "critic", { base, commit: left }), event(2, "actor", { base, commit: right })];
  put(s.records, "metrics/handoffs.jsonl", jsonl(...rows));
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "parallel hand-offs");
  const diverged = run(s, "next").stdout;
  assert.match(diverged, /Integration SHA none: merge needed/);
  assert.ok(diverged.includes(`${left} (R-0002-critic)`) && diverged.includes(`${right} (R-0002-actor)`), diverged);
  assert.ok(diverged.includes(`merge --no-edit ${left} ${right}`), diverged);
  assert.match(diverged, /the suite, CI and judge wait on the merge/);
  const merge = git(s.product, "commit-tree", tree, "-p", left, "-p", right, "-m", "the lead's merge");
  git(s.product, "update-ref", "refs/heads/loop/s5", merge);
  const merged = run(s, "next").stdout;
  assert.match(merged, /merges every diverged head/);
  assert.ok(merged.includes(`--sha ${merge}`) && merged.includes(`--base ${merge}`), merged);
  rows.push(event(3, "judge", { base: merge, commit: merge }));
  put(s.records, "metrics/handoffs.jsonl", jsonl(...rows));
  git(s.records, "add", "-A"); git(s.records, "commit", "-qm", "judge on the merge");
  const judged = run(s, "next").stdout;
  assert.match(judged, new RegExp(`Integration SHA ${merge} \\(R-0003-judge, recorded after the ruling of round 1\\)`));
  assert.match(judged, new RegExp(`ruling not in the trajectory: R-0003-judge[\\s\\S]*--commit ${merge}`));
});

test("A4 measures: the header prints the counters' figures, and every value the counters do not know as unknown, never 0 (flow: the lead quotes next's header in a report; loss: wrong-result, an unknown measure read as zero)", async () => {
  const { measuresLines } = await import("../loop.mjs");
  const cadence = { state: { returns: [] } };
  const waiting = { seconds: 900, batches: 2, open: ["B-0002"], intervals: [], unknowns: [] };
  const metrics = { ownerDirections: 4, raisedFirst: 1, precision: 2 / 3, answersByOutcome: { "as-recommended": 2 }, answeredWithOutcome: 3, ownerWaiting: waiting };
  const [owner, none] = measuresLines({ metrics, reconciled: null, cadence });
  assert.match(owner, /owner directions 4 · raised first 1 · precision of batch answers 66\.7% \(2 as-recommended of 3 labelled\) · owner waiting 900 s over 2 owner batches of the phase, B-0002 still open and accruing/);
  assert.match(owner, /returns per area: none/);
  assert.equal(none, "  no current plan of the phase: critical path unknown · idle dispatchable unknown (plan.mjs measure)");
  const [blank] = measuresLines({ metrics: { ...metrics, precision: null, answersByOutcome: { "as-recommended": 0 }, answeredWithOutcome: 0,
    ownerWaiting: { seconds: null, batches: 1, open: [], intervals: [], unknowns: ["owner/B-0001.md has no single first publication in the records history"] } }, reconciled: null, cadence });
  assert.match(blank, /precision of batch answers unknown \(0 as-recommended of 0 labelled\) · owner waiting unknown \(owner\/B-0001\.md has no single first publication/);
  const [empty] = measuresLines({ metrics: { ...metrics, ownerWaiting: { seconds: 0, batches: 0, open: [], intervals: [], unknowns: [] } }, reconciled: null, cadence });
  assert.match(empty, /owner waiting 0 s \(no owner batch sent in the phase\)/);
  const [failed] = measuresLines({ metrics: null, problem: "no window", reconciled: null, cadence: { state: { returns: [{ area: "a", rounds: [] }] } } });
  assert.match(failed, /owner directions unknown · raised first unknown · precision of batch answers unknown · owner waiting unknown \(not computed: no window\) · returns per area: listed below/);
  assert.doesNotMatch([owner, none, blank, failed].join("\n"), /idle[^\n]* 0\b|critical path 0\b|owner waiting 0\b/);
});
