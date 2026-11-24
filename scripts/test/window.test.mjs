import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT } from "../call.mjs";
import { UsageError } from "../lib/args.mjs";
import { closeWindow, openWindow, parseWindows, windowAlarmKey, WindowRefusalError, WINDOWS, windowState } from "../lib/window.mjs";
import { git, roomyStore, scripts, selfLoop, setup, temp } from "./helpers.mjs";

const PHASE = "S5";
const put = (root, path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const commitAll = (repo, msg) => { git(repo, "add", "-A"); git(repo, "commit", "-qm", msg); };
const nodeRun = (script, args, env = process.env) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", env });

function writeConfig(s) {
  const config = join(s.dir, "loop.json");
  put(s.dir, "loop.json", JSON.stringify(s.cfg));
  return config;
}

function runNext(s, config) {
  s.host ??= { SELF_LOOP_LOAD_DIR: temp("self-loop-load-"), SELF_LOOP_OWNER_STORE: roomyStore() };
  return nodeRun("loop.mjs", ["next", "--config", config], { ...process.env, ...s.host, PATH: `${s.dir}:${process.env.PATH}` });
}

function appendHandoff(records, entry, recordBody) {
  put(records, entry.record, recordBody ?? `# ${entry.id}\n`);
  const existing = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8");
  put(records, "metrics/handoffs.jsonl", existing + JSON.stringify(entry) + "\n");
}

function makeActorHandoff(round, base, commit, agent = { runner: "claude", model: "claude-opus-4-6" }, time = "2026-11-24T01:00:00Z") {
  const stem = `${String(round).padStart(4, "0")}-actor`;
  const record = `rounds/${stem}.md`;
  return {
    id: `R-${stem}`, time, phase: PHASE, round, step: "actor", role: "actor", attempt: 1,
    agent, view: "a".repeat(40), product: { base, commit }, audit: { violations: 0 }, record, files: [record],
  };
}

function makeJudgeHandoff(round, sha, { agent = { runner: "codex", model: "gpt-5" }, sealed = false, time = "2026-11-24T02:00:00Z" } = {}) {
  const pad = String(round).padStart(4, "0");
  const record = `rounds/${pad}-judge.md`;
  const sealedFile = `sealed/judge/${pad}/judge-1.md`;
  const files = sealed ? [record, sealedFile] : [record];
  return {
    entry: {
      id: `R-${pad}-judge`, time, phase: PHASE, round, step: "judge", role: "judge", attempt: 1,
      agent, view: "a".repeat(40), product: { base: sha, commit: sha }, audit: { violations: 0 }, record, files,
    },
    sealedFile,
  };
}

function commitProduct(product, msg) {
  const head = git(product, "rev-parse", "loop/s5");
  const tree = git(product, "rev-parse", `${head}^{tree}`);
  const sha = git(product, "commit-tree", tree, "-p", head, "-m", msg);
  git(product, "update-ref", "refs/heads/loop/s5", sha);
  return { base: head, commit: sha };
}

test("1. open validation rejects invalid horizon, missing fields, and overlapping windows", async () => {
  const s = await setup();
  for (const badHorizon of [1, 0, -2, 13, "4", 2.5]) {
    assert.throws(
      () => openWindow(s.records, { phase: PHASE, startRound: 2, horizon: badHorizon, goal: "refactor", invariants: ["tests green"] }),
      UsageError,
      `expected UsageError for horizon=${JSON.stringify(badHorizon)}`
    );
  }
  assert.throws(() => openWindow(s.records, { phase: PHASE, startRound: 2, horizon: 4, goal: "", invariants: ["ok"] }), UsageError);
  assert.throws(() => openWindow(s.records, { phase: PHASE, startRound: 2, horizon: 4, goal: "g", invariants: [] }), UsageError);

  const cliBad = nodeRun("window.mjs", ["open", "--records", s.records, "--phase", PHASE, "--horizon", "1", "--goal", "g", "--invariant", "i"]);
  assert.equal(cliBad.status, 64);

  const cliOk = selfLoop(["window", "open", "--records", s.records, "--phase", PHASE, "--horizon", "4", "--goal", "Split engine", "--invariant", "API parity", "--invariant", "Zero leaks", "--start-round", "10", "--json"]);
  assert.equal(cliOk.status, 0, cliOk.stderr);
  const opened = JSON.parse(cliOk.stdout);
  assert.equal(opened.event.id, "W-0001");
  assert.deepEqual(opened.event.invariants, ["API parity", "Zero leaks"]);

  assert.throws(
    () => openWindow(s.records, { phase: PHASE, startRound: 11, horizon: 3, goal: "overlap", invariants: ["ok"] }),
    WindowRefusalError
  );
  const cliOverlap = nodeRun("window.mjs", ["open", "--records", s.records, "--phase", PHASE, "--horizon", "3", "--goal", "overlap", "--invariant", "ok"]);
  assert.equal(cliOverlap.status, 2);

  const st = selfLoop(["window", "status", "--records", s.records, "--phase", PHASE, "--json"]);
  assert.equal(st.status, 0, st.stderr);
  assert.equal(JSON.parse(st.stdout).mode, "slack");
});

test("2. horizon=4 progresses slack -> converging -> gate-due, blocking actor with exit 7 while allowing critic/judge", async () => {
  const s = await setup({}, { gates: { require: ["github-actions/verify"], suite: "npm test" } });
  put(s.records, "metrics/blueprint.jsonl", jsonl({ feature: "F-0001", status: "building", time: "2026-11-24T00:00:00Z", by: "lead", note: "start", evidence: {} }));
  commitAll(s.records, "start building");
  put(s.dir, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"in_progress\"}'\n");
  chmodSync(join(s.dir, "gh"), 0o755);
  const config = writeConfig(s);

  openWindow(s.records, { phase: PHASE, startRound: 10, horizon: 4, goal: "Rewrite core", invariants: ["Full suite green", "API stable"] });

  // Rounds 10, 11, 12 -> usedActorRounds = 0, 1, 2 -> mode === "slack"
  for (let i = 0; i < 3; i++) {
    const round = 10 + i;
    const nextOut = runNext(s, config);
    assert.equal(nextOut.status, 0, nextOut.stderr);
    assert.match(nextOut.stdout, new RegExp(`Window: W-0001 \\(slack · ${i}/4 actor rounds · end round 13\\)`));
    assert.doesNotMatch(nextOut.stdout, /building features without a recorded running call|no suite-green receipt|CI not green|no judge ruling on the integration head/);
    assert.match(nextOut.stdout, /call\.mjs .* actor --round/);

    const dry = s.run("actor", { round, dry: true });
    assert.equal(dry.code, EXIT.done, dry.message);

    const { base, commit } = commitProduct(s.product, `refactor step ${i + 1}`);
    appendHandoff(s.records, makeActorHandoff(round, base, commit));
    commitAll(s.records, `actor round ${round}`);
  }

  // Round 13 -> usedActorRounds = 3 -> mode === "converging"
  const convNext = runNext(s, config);
  assert.equal(convNext.status, 0, convNext.stderr);
  assert.match(convNext.stdout, /Window: W-0001 \(converging · 3\/4 actor rounds · end round 13\)/);
  assert.match(convNext.stdout, /final actor round 13/);
  assert.equal(s.run("actor", { round: 13, dry: true }).code, EXIT.done);

  const { base: b13, commit: c13 } = commitProduct(s.product, "convergence step 4");
  appendHandoff(s.records, makeActorHandoff(13, b13, c13));
  commitAll(s.records, "actor round 13");

  // After 4th actor hand-off -> usedActorRounds = 4 -> mode === "gate-due", actorBlocked === true
  const gateNext = runNext(s, config);
  assert.equal(gateNext.status, 0, gateNext.stderr);
  assert.match(gateNext.stdout, /Window: W-0001 \(gate-due · 4\/4 actor rounds · end round 13\)/);
  assert.match(gateNext.stdout, /building features without a recorded running call/);
  assert.match(gateNext.stdout, /no suite-green receipt/);
  assert.match(gateNext.stdout, /CI not green/);
  assert.match(gateNext.stdout, /no judge ruling on the integration head/);
  assert.match(gateNext.stdout, /window\.mjs close .* --id W-0001 --verdict verified/);
  assert.match(gateNext.stdout, /further actor calls are mechanically refused/);

  const actorRefused = s.run("actor", { round: 14, dry: true });
  assert.equal(actorRefused.code, EXIT.records, `expected exit 7, got ${actorRefused.code}: ${actorRefused.message}`);
  assert.match(actorRefused.message, /W-0001.*4\/4/);

  // Critic, judge, and reviewer are NEVER blocked by gate-due
  assert.equal(s.run("critic", { round: 14, dry: true }).code, EXIT.done);
  assert.equal(s.run("judge", { round: 14, dry: true }).code, EXIT.done);
  assert.equal(s.run("reviewer", { round: 14, dry: true }).code, EXIT.done);

  // A CONTINUE judge ruling inside the window emits deterministic window-horizon alarm
  const { entry: j14 } = makeJudgeHandoff(14, c13);
  appendHandoff(s.records, j14);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 14, phase: PHASE, role: "judge", area: "core", verdict: "CONTINUE", commit: c13, suite: "10/1", ci: "success", time: "2026-11-24T02:00:00Z",
  }));
  commitAll(s.records, "continue ruling in window");
  const st = JSON.parse(nodeRun("window.mjs", ["status", "--records", s.records, "--phase", PHASE, "--json"]).stdout);
  assert.equal(st.alarm?.key, windowAlarmKey(PHASE, "W-0001"));
  assert.match(runNext(s, config).stdout, new RegExp(`window horizon alarm needs diagnosis: ${windowAlarmKey(PHASE, "W-0001")}`));
});

test("3. verified close refuses missing/failing/same-vendor evidence and succeeds only with full committed proof", async () => {
  const s = await setup({}, { gates: { require: ["github-actions/verify"] } });
  const config = writeConfig(s);
  openWindow(s.records, { phase: PHASE, startRound: 10, horizon: 2, goal: "Refactor", invariants: ["Green"] });
  const { base, commit } = commitProduct(s.product, "actor work");
  const tree = git(s.product, "rev-parse", `${commit}^{tree}`);
  appendHandoff(s.records, makeActorHandoff(10, base, commit, { runner: "claude", model: "claude-opus-4-6" }));
  commitAll(s.records, "actor commit");

  // Missing judge ruling
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), WindowRefusalError);

  // Failing suite count (10/1)
  const { entry: jBad } = makeJudgeHandoff(11, commit, { agent: { runner: "codex", model: "gpt-5" } });
  appendHandoff(s.records, jBad);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 11, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "10/1", ci: "success", time: "2026-11-24T02:00:00Z",
  }));
  commitAll(s.records, "bad suite count");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /suite count/);

  // Same-vendor judge/actor (both anthropic/claude)
  const { entry: jSame } = makeJudgeHandoff(12, commit, { agent: { runner: "claude", model: "claude-sonnet-4-6" } });
  appendHandoff(s.records, jSame);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 12, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "12/0", ci: "success", time: "2026-11-24T02:10:00Z",
  }));
  commitAll(s.records, "same vendor ruling");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /independence/);

  // Different-vendor judge, passing suite count, but missing suite-green receipt
  const { entry: jGood } = makeJudgeHandoff(13, commit, { agent: { runner: "codex", model: "gpt-5" } });
  appendHandoff(s.records, jGood);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 13, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "12/0", ci: "success", time: "2026-11-24T02:20:00Z",
  }));
  commitAll(s.records, "good judge no receipts");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /suite-green receipt/);

  // Add green suite-green receipt, still missing committed green CI receipt (gates.require configured)
  put(s.records, "evidence/0013/suite-1.json", JSON.stringify({ repository: s.product, sha: commit, tree, green: true }));
  commitAll(s.records, "suite receipt only");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /remote CI/);

  // Add committed green CI receipt -> CLI close succeeds
  const ciPath = `evidence/0013/ci-${commit.slice(0, 12)}-1/receipt.json`;
  put(s.records, ciPath, JSON.stringify({ repository: "example/product", sha: commit, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }));
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 13, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "12/0", ci: "success", ciReceipt: ciPath, time: "2026-11-24T02:20:00Z",
  }));
  commitAll(s.records, "green ci receipt");

  const closed = nodeRun("window.mjs", ["close", "--records", s.records, "--id", "W-0001", "--verdict", "verified", "--commit", commit, "--config", config, "--json"]);
  assert.equal(closed.status, 0, closed.stderr);
  const payload = JSON.parse(closed.stdout);
  assert.equal(payload.event.verdict, "verified");
  assert.equal(payload.event.suiteReceipt, "evidence/0013/suite-1.json");
  assert.equal(payload.event.ciReceipt, ciPath);

  // Closing again or closing unknown ID is refused
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /already closed/);
  assert.throws(() => closeWindow(s.records, { id: "W-0099", commit, verdict: "verified", cfg: s.cfg }), /does not exist/);
});

test("4. reframed close requires post-open reviewer-diagnosis citing window-horizon alarm on alarms: line", async () => {
  const s = await setup();
  const alarmKey = windowAlarmKey(PHASE, "W-0001");

  // Pre-open diagnosis citing the key must NOT satisfy a later window
  appendHandoff(s.records, {
    id: "R-0002-reviewer-diagnosis", time: "2026-11-24T00:00:00Z", phase: PHASE, round: 2,
    step: "reviewer-diagnosis", role: "reviewer", attempt: 1, agent: { runner: "claude" },
    view: "a".repeat(40), product: null, audit: { violations: 0 },
    record: "rounds/0002-reviewer-diagnosis.md", files: ["rounds/0002-reviewer-diagnosis.md"],
  }, `# R-0002-reviewer-diagnosis\n\nalarms: ${alarmKey}\n\n## Report (verbatim)\n\nEarly.\n`);
  commitAll(s.records, "pre-open diagnosis");

  openWindow(s.records, { phase: PHASE, startRound: 10, horizon: 3, goal: "Try refactor", invariants: ["ok"], now: new Date("2026-11-24T01:00:00Z") });
  assert.throws(() => closeWindow(s.records, { id: "W-0001", verdict: "reframed" }), /reviewer-diagnosis/);

  // Key only inside Report (not task) must NOT satisfy
  appendHandoff(s.records, {
    id: "R-0011-reviewer-diagnosis", time: "2026-11-24T02:00:00Z", phase: PHASE, round: 11,
    step: "reviewer-diagnosis", role: "reviewer", attempt: 1, agent: { runner: "claude" },
    view: "a".repeat(40), product: null, audit: { violations: 0 },
    record: "rounds/0011-reviewer-diagnosis.md", files: ["rounds/0011-reviewer-diagnosis.md"],
  }, `# R-0011-reviewer-diagnosis\n\n## Task (verbatim)\n\nNo alarm line.\n\n## Report (verbatim)\n\nalarms: ${alarmKey}\n`);
  commitAll(s.records, "report-only alarm");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", verdict: "reframed" }), /reviewer-diagnosis/);

  // Post-open diagnosis citing alarmKey on task alarms: line succeeds
  appendHandoff(s.records, {
    id: "R-0012-reviewer-diagnosis", time: "2026-11-24T03:00:00Z", phase: PHASE, round: 12,
    step: "reviewer-diagnosis", role: "reviewer", attempt: 1, agent: { runner: "claude" },
    view: "a".repeat(40), product: null, audit: { violations: 0 },
    record: "rounds/0012-reviewer-diagnosis.md", files: ["rounds/0012-reviewer-diagnosis.md"],
  }, `# R-0012-reviewer-diagnosis\n\n## Task (verbatim)\n\nalarms: ${alarmKey}\n\n## Report (verbatim)\n\nREFRAME.\n`);
  commitAll(s.records, "valid post-open diagnosis");

  const res = nodeRun("window.mjs", ["close", "--records", s.records, "--id", "W-0001", "--verdict", "reframed", "--note", "Reframed after diagnosis", "--json"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).event.verdict, "reframed");
});

test("5. phase convergence refuses while a window is open and succeeds once closed", async () => {
  const s = await setup({}, { gates: { require: ["github-actions/verify"] } });
  const config = writeConfig(s);
  openWindow(s.records, { phase: PHASE, startRound: 2, horizon: 2, goal: "Converge cleanly", invariants: ["All green"] });
  const { base, commit } = commitProduct(s.product, "clean work");
  const tree = git(s.product, "rev-parse", `${commit}^{tree}`);
  const ciPath = `evidence/0003/ci-${commit.slice(0, 12)}-1/receipt.json`;
  const suitePath = "evidence/0003/suite-1.json";

  appendHandoff(s.records, makeActorHandoff(2, base, commit, { runner: "claude", model: "claude-opus-4-6" }));
  const { entry: j3, sealedFile } = makeJudgeHandoff(3, commit, { agent: { runner: "codex", model: "gpt-5" }, sealed: true });
  appendHandoff(s.records, j3);
  put(s.records, sealedFile, "# R-0003-judge\n\n```\n\n## Report (verbatim)\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n");
  put(s.records, suitePath, JSON.stringify({ repository: s.product, sha: commit, tree, green: true }));
  put(s.records, ciPath, JSON.stringify({ repository: "example/product", sha: commit, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }));
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 3, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "12/0", ci: "success", ciReceipt: ciPath, time: "2026-11-24T02:00:00Z",
  }));
  put(s.records, "metrics/blueprint.jsonl", jsonl({
    feature: "F-0001", phase: PHASE, status: "done", time: "2026-11-24T02:05:00Z", by: "lead", note: "done",
    evidence: { round: "R-0003-judge", commit, ci: ciPath },
  }));
  put(s.dir, "gh", "#!/bin/sh\nprintf '%s\\n' '{\"app\":\"github-actions\",\"name\":\"verify\",\"status\":\"completed\",\"conclusion\":\"success\"}'\n");
  chmodSync(join(s.dir, "gh"), 0o755);
  git(s.records, "add", "-A");
  const rc = nodeRun("records-check.mjs", ["--repo", s.records, "--write"]);
  assert.equal(rc.status, 0, rc.stdout + rc.stderr);
  commitAll(s.records, "everything green except open window");

  const openNext = runNext(s, config);
  assert.equal(openNext.status, 0, openNext.stderr);
  assert.match(openNext.stdout, /open bounded window W-0001 \(converging\) must be closed before phase convergence \(metrics\/windows\.jsonl\)/);

  closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg });
  const closedNext = runNext(s, config);
  assert.equal(closedNext.status, 0, closedNext.stderr);
  assert.match(closedNext.stdout, /The recorded convergence checks are satisfied/);
});

test("6. records-check passes valid metrics/windows.jsonl and fails closed on corruption", async () => {
  const s = await setup();
  openWindow(s.records, { phase: PHASE, startRound: 2, horizon: 3, goal: "Valid window", invariants: ["Keep green"] });
  assert.equal(nodeRun("records-check.mjs", ["--repo", s.records, "--write"]).status, 0);
  commitAll(s.records, "write index");
  const ok = nodeRun("records-check.mjs", ["--repo", s.records, "--json"]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(JSON.parse(ok.stdout).failures.length, 0);

  const goodLine = readFileSync(join(s.records, WINDOWS), "utf8");
  const corruptCases = [
    goodLine + "{not-json\n",
    goodLine + goodLine, // duplicate ID + overlapping open
    goodLine + JSON.stringify({ type: "close", id: "W-0099", phase: PHASE, closedAt: "2026-11-24T03:00:00Z", closedBy: "lead", commit: null, verdict: "reframed" }) + "\n",
  ];
  for (const content of corruptCases) {
    put(s.records, WINDOWS, content);
    const bad = nodeRun("records-check.mjs", ["--repo", s.records, "--json"]);
    assert.equal(bad.status, 1);
    assert.ok(JSON.parse(bad.stdout).failures.some(f => f.rule === "window" && f.path === WINDOWS));
  }
  assert.throws(() => parseWindows(JSON.stringify({ type: "open", id: "W-0001", phase: PHASE, startRound: 1, horizon: 99, goal: "g", invariants: ["i"], openedAt: "2026-11-24T00:00:00Z", openedBy: "lead" }) + "\n"));
});

test("7. zero regression when metrics/windows.jsonl is absent", async () => {
  const s = await setup();
  const config = writeConfig(s);
  assert.equal(windowState({ windows: [], handoffs: [], rows: [], phase: PHASE }).mode, "normal");
  const out = runNext(s, config);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /Window:|bounded window/);
  assert.equal(s.run("actor", { round: 2, dry: true }).code, EXIT.done);
  assert.equal(nodeRun("records-check.mjs", ["--repo", s.records, "--write"]).status, 0);
});
