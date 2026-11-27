// P-0011, D-0016, D-0058, D-0064, D-0067
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT } from "../call.mjs";
import { UsageError } from "../lib/args.mjs";
import { closeWindow, defaultStartRound, openWindow, parseWindows, windowAlarmKey, WindowRefusalError, WINDOWS, windowState } from "../lib/window.mjs";
import { isNoDisputeCriticHandoff, parseNoDisputeCritic } from "../lib/window-state.mjs";
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

  const convNext = runNext(s, config);
  assert.equal(convNext.status, 0, convNext.stderr);
  assert.match(convNext.stdout, /Window: W-0001 \(converging · 3\/4 actor rounds · end round 13\)/);
  assert.match(convNext.stdout, /final actor round 13/);
  assert.equal(s.run("actor", { round: 13, dry: true }).code, EXIT.done);

  const { base: b13, commit: c13 } = commitProduct(s.product, "convergence step 4");
  appendHandoff(s.records, makeActorHandoff(13, b13, c13));
  commitAll(s.records, "actor round 13");

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

  assert.equal(s.run("critic", { round: 14, dry: true }).code, EXIT.done);
  assert.equal(s.run("judge", { round: 14, dry: true }).code, EXIT.done);
  assert.equal(s.run("reviewer", { round: 14, dry: true }).code, EXIT.done);

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

  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), WindowRefusalError);

  const { entry: jBad } = makeJudgeHandoff(11, commit, { agent: { runner: "codex", model: "gpt-5" } });
  appendHandoff(s.records, jBad);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 11, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "10/1", ci: "success", time: "2026-11-24T02:00:00Z",
  }));
  commitAll(s.records, "bad suite count");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /suite count/);

  const { entry: jSame } = makeJudgeHandoff(12, commit, { agent: { runner: "claude", model: "claude-sonnet-4-6" } });
  appendHandoff(s.records, jSame);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 12, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "12/0", ci: "success", time: "2026-11-24T02:10:00Z",
  }));
  commitAll(s.records, "same vendor ruling");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /independence/);

  const { entry: jGood } = makeJudgeHandoff(13, commit, { agent: { runner: "codex", model: "gpt-5" } });
  appendHandoff(s.records, jGood);
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 13, phase: PHASE, role: "judge", area: "core", verdict: "CONVERGED", commit, suite: "12/0", ci: "success", time: "2026-11-24T02:20:00Z",
  }));
  commitAll(s.records, "good judge no receipts");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /suite-green receipt/);

  put(s.records, "evidence/0013/suite-1.json", JSON.stringify({ repository: s.product, sha: commit, tree, green: true }));
  commitAll(s.records, "suite receipt only");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /remote CI/);

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

  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit, verdict: "verified", cfg: s.cfg }), /already closed/);
  assert.throws(() => closeWindow(s.records, { id: "W-0099", commit, verdict: "verified", cfg: s.cfg }), /does not exist/);
});

test("4. reframed close requires post-open reviewer-diagnosis citing window-horizon alarm on alarms: line", async () => {
  const s = await setup();
  const alarmKey = windowAlarmKey(PHASE, "W-0001");

  appendHandoff(s.records, {
    id: "R-0002-reviewer-diagnosis", time: "2026-11-24T00:00:00Z", phase: PHASE, round: 2,
    step: "reviewer-diagnosis", role: "reviewer", attempt: 1, agent: { runner: "claude" },
    view: "a".repeat(40), product: null, audit: { violations: 0 },
    record: "rounds/0002-reviewer-diagnosis.md", files: ["rounds/0002-reviewer-diagnosis.md"],
  }, `# R-0002-reviewer-diagnosis\n\nalarms: ${alarmKey}\n\n## Report (verbatim)\n\nEarly.\n`);
  commitAll(s.records, "pre-open diagnosis");

  openWindow(s.records, { phase: PHASE, startRound: 10, horizon: 3, goal: "Try refactor", invariants: ["ok"], now: new Date("2026-11-24T01:00:00Z") });
  assert.throws(() => closeWindow(s.records, { id: "W-0001", verdict: "reframed" }), /reviewer-diagnosis/);

  appendHandoff(s.records, {
    id: "R-0011-reviewer-diagnosis", time: "2026-11-24T02:00:00Z", phase: PHASE, round: 11,
    step: "reviewer-diagnosis", role: "reviewer", attempt: 1, agent: { runner: "claude" },
    view: "a".repeat(40), product: null, audit: { violations: 0 },
    record: "rounds/0011-reviewer-diagnosis.md", files: ["rounds/0011-reviewer-diagnosis.md"],
  }, `# R-0011-reviewer-diagnosis\n\n## Task (verbatim)\n\nNo alarm line.\n\n## Report (verbatim)\n\nalarms: ${alarmKey}\n`);
  commitAll(s.records, "report-only alarm");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", verdict: "reframed" }), /reviewer-diagnosis/);

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
    goodLine + goodLine,
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

test("8. windowState recognizes role=critic verdicts and committed no-dispute critic handoffs fail-closed (D-0064 T10, D-0067)", () => {
  const win = [{
    type: "open", id: "W-0001", phase: PHASE, startRound: 10, horizon: 3,
    goal: "Refactor state", invariants: ["Green"], openedAt: "2026-11-24T00:00:00Z", openedBy: "lead",
  }];
  const sha = "a".repeat(40);
  const stContinue = windowState({
    windows: win,
    handoffs: [],
    rows: [{ round: 11, phase: PHASE, role: "critic", verdict: "CONTINUE", commit: sha, suite: "10/1", ci: "success" }],
    phase: PHASE,
  });
  assert.equal(stContinue.lastRuling?.role, "critic");
  assert.equal(stContinue.lastRuling?.verdict, "CONTINUE");
  assert.equal(stContinue.alarm?.key, windowAlarmKey(PHASE, "W-0001"));
  assert.match(stContinue.alarm.message, /received critic verdict CONTINUE in round 11/);

  const stRowPass = windowState({
    windows: win,
    handoffs: [],
    rows: [
      { round: 11, phase: PHASE, role: "critic", verdict: "CONTINUE", commit: sha, suite: "10/1", ci: "success" },
      { round: 12, phase: PHASE, role: "critic", verdict: "PASS", commit: sha, suite: "12/0", ci: "success" },
    ],
    phase: PHASE,
  });
  assert.equal(stRowPass.lastRuling?.verdict, "PASS");
  assert.equal(stRowPass.alarm, null);

  const criticHandoff = (round, { violations = 0, step = "critic", sealed = false } = {}) => {
    const p = String(round).padStart(4, "0");
    const record = `rounds/${p}-${step}.md`;
    const sealedFile = `sealed/critic/${p}/${step}-1.md`;
    return {
      id: `R-${p}-${step}`, time: `2026-11-24T0${round - 10}:00:00Z`, phase: PHASE, round, step, role: "critic", attempt: 1,
      agent: { runner: "codex", model: "gpt-5" }, view: sha, product: { base: sha, commit: sha },
      audit: { violations }, record, files: sealed ? [record, sealedFile] : [record],
    };
  };
  const body = hdr => `# R\n\n## Task (verbatim)\n\n\`\`\`text\nVERDICT: PASS\nACCEPTANCE: pass\n\`\`\`\n\n## Report (verbatim)\n\n${hdr}\n`;

  const clean = criticHandoff(12);
  const store = new Map([[clean.record, body("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: none\nOPENED: -")]]);
  const read = p => store.get(p) ?? "";
  const files = new Set(store.keys());

  assert.equal(isNoDisputeCriticHandoff(clean, { read, has: p => files.has(p) }), true);
  assert.equal(parseNoDisputeCritic(clean, { read, has: p => files.has(p) }).verdict, "PASS");

  const stClean = windowState({
    windows: win,
    handoffs: [clean],
    rows: [{ round: 11, phase: PHASE, role: "critic", verdict: "CONTINUE", commit: sha, suite: "10/1", ci: "success" }],
    phase: PHASE,
    read,
    files,
  });
  assert.equal(stClean.criticConverged?.id, clean.id);
  assert.equal(stClean.lastRuling?.verdict, "PASS");
  assert.equal(stClean.alarm, null);

  const badCases = [
    ["audit violations", criticHandoff(12, { violations: 1 }), "VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -"],
    ["disputes present", criticHandoff(12), "VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: actor challenges case"],
    ["opened blocker", criticHandoff(12), "VERDICT: CONVERGED\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: bug:R12-1"],
    ["acceptance fail", criticHandoff(12), "VERDICT: PASS\nACCEPTANCE: fail\nDISPUTES: -"],
    ["task spoofing only", criticHandoff(12), "No verdict headers here."],
  ];
  for (const [label, h, hdr] of badCases) {
    const sMap = new Map([[h.record, body(hdr)]]);
    assert.equal(isNoDisputeCriticHandoff(h, { read: p => sMap.get(p) ?? "", has: p => sMap.has(p) }), false, label);
  }

  const stContradicted = windowState({
    windows: win,
    handoffs: [clean],
    rows: [{ round: 12, phase: PHASE, role: "judge", verdict: "CONTINUE", commit: sha, suite: "10/1", ci: "success" }],
    phase: PHASE,
    read,
    files,
  });
  assert.equal(stContradicted.criticConverged, null);
  assert.equal(stContradicted.alarm?.key, windowAlarmKey(PHASE, "W-0001"));
});

test("9. defaultStartRound ignores round-less lead-patch entries; verified close admits independent no-dispute critic and modelVendors config", async () => {
  const s = await setup({}, {
    gates: { require: ["github-actions/verify"] },
    judgeIndependence: "vendor",
    modelVendors: { "custom-alpha": "alpha", "custom-beta": "beta" },
  });
  const { base, commit: actorSha } = commitProduct(s.product, "actor change");
  const { commit: lpSha } = commitProduct(s.product, "lead micro patch");
  const { commit: criticSha } = commitProduct(s.product, "critic test");
  const tree = git(s.product, "rev-parse", `${criticSha}^{tree}`);

  const lpEntry = {
    id: "LP-0001", time: "2026-11-27T01:05:00Z", phase: PHASE, role: "lead-patch",
    product: { base: actorSha, commit: lpSha }, files: ["a.js"],
    lines: { added: 1, deleted: 0, total: 1 }, reason: "typo",
    verify: { command: "true", exit: 0 }, audit: { violations: 0 },
  };
  const actorAgent = { runner: "t3:pi", model: "custom-alpha", observedModel: "custom-alpha", observedModels: ["custom-alpha"] };
  const criticAgent = { runner: "t3:opencode", model: "custom-beta", observedModel: "custom-beta", observedModels: ["custom-beta"] };
  appendHandoff(s.records, makeActorHandoff(10, base, actorSha, actorAgent));
  put(s.records, "metrics/handoffs.jsonl", readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8") + JSON.stringify(lpEntry) + "\n");
  commitAll(s.records, "seed actor and round-less lead-patch");

  assert.equal(defaultStartRound(s.records), 11);
  const opened = nodeRun("window.mjs", ["open", "--records", s.records, "--phase", PHASE, "--horizon", "2", "--goal", "Critic close", "--invariant", "Green", "--json"]);
  assert.equal(opened.status, 0, opened.stderr + opened.stdout);
  assert.equal(JSON.parse(opened.stdout).event.startRound, 11);

  const criticRecord = "rounds/0011-critic-a.md";
  const criticEntry = {
    id: "R-0011-critic-a", time: "2026-11-27T02:00:00Z", phase: PHASE, round: 11, step: "critic-a", role: "critic", attempt: 1,
    agent: criticAgent, view: "a".repeat(40), product: { base: lpSha, commit: criticSha }, audit: { violations: 0 },
    record: criticRecord, files: [criticRecord],
  };
  const criticBody = hdr => `# R-0011-critic-a\n\n## Report (verbatim)\n\n${hdr}\n`;
  appendHandoff(s.records, criticEntry, criticBody("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: -"));
  const ciPath = `evidence/0011/ci-${criticSha.slice(0, 12)}-1/receipt.json`;
  put(s.records, "evidence/0011/suite-1.json", JSON.stringify({ repository: s.product, sha: criticSha, tree, green: true }));
  put(s.records, ciPath, JSON.stringify({ repository: "example/product", sha: criticSha, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }));
  put(s.records, "metrics/trajectory.jsonl", jsonl({
    round: 11, phase: PHASE, role: "critic", area: "core", verdict: "PASS", commit: criticSha, suite: "8/0", ci: "success", ciReceipt: ciPath, time: "2026-11-27T02:01:00Z",
  }));
  commitAll(s.records, "independent critic pass");

  const statusJson = JSON.parse(nodeRun("window.mjs", ["status", "--records", s.records, "--phase", PHASE, "--json"]).stdout);
  assert.equal(statusJson.criticConverged?.id, "R-0011-critic-a");

  const badCfg = join(s.dir, "bad-mv.json");
  put(s.dir, "bad-mv.json", JSON.stringify({ ...s.cfg, modelVendors: ["not-an-object"] }));
  assert.notEqual(nodeRun("window.mjs", ["close", "--records", s.records, "--id", "W-0001", "--verdict", "verified", "--commit", criticSha, "--config", badCfg]).status, 0);
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit: criticSha, verdict: "verified", cfg: { ...s.cfg, modelVendors: ["not-an-object"] } }), WindowRefusalError);

  put(s.records, criticRecord, criticBody("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: D1\nOPENED: -"));
  commitAll(s.records, "disputed critic");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit: criticSha, verdict: "verified", cfg: s.cfg }), WindowRefusalError);

  put(s.records, criticRecord, criticBody("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: -"));
  const sameVendorHandoffs = readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8").replaceAll("custom-beta", "custom-alpha");
  put(s.records, "metrics/handoffs.jsonl", sameVendorHandoffs);
  commitAll(s.records, "same-vendor critic");
  assert.throws(() => closeWindow(s.records, { id: "W-0001", commit: criticSha, verdict: "verified", cfg: s.cfg }), /independence/);

  put(s.records, "metrics/handoffs.jsonl", sameVendorHandoffs.replace("R-0011-critic-a\",\"time\":\"2026-11-27T02:00:00Z\",\"phase\":\"S5\",\"round\":11,\"step\":\"critic-a\",\"role\":\"critic\",\"attempt\":1,\"agent\":{\"runner\":\"t3:opencode\",\"model\":\"custom-alpha\",\"observedModel\":\"custom-alpha\",\"observedModels\":[\"custom-alpha\"]}", "R-0011-critic-a\",\"time\":\"2026-11-27T02:00:00Z\",\"phase\":\"S5\",\"round\":11,\"step\":\"critic-a\",\"role\":\"critic\",\"attempt\":1,\"agent\":{\"runner\":\"t3:opencode\",\"model\":\"custom-beta\",\"observedModel\":\"custom-beta\",\"observedModels\":[\"custom-beta\"]}"));
  commitAll(s.records, "restore independent critic");
  const config = writeConfig(s);
  const closed = nodeRun("window.mjs", ["close", "--records", s.records, "--id", "W-0001", "--verdict", "verified", "--commit", criticSha, "--config", config, "--json"]);
  assert.equal(closed.status, 0, closed.stderr + closed.stdout);
  assert.equal(JSON.parse(closed.stdout).event.ciReceipt, ciPath);
});
