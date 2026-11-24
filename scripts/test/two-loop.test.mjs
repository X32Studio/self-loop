// P-0011, D-0058, D-0060
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT } from "../call.mjs";
import { outerLoopState } from "../lib/cadence.mjs";
import { appendWords, captureOwnerText, isSubstantiveOwnerWord } from "../lib/owner-words.mjs";
import { openWindow } from "../lib/window.mjs";
import { git, isolatedEnv, loopProduct, ownerStore, roomyStore, scripts, selfLoop, setup, temp } from "./helpers.mjs";

const PHASE = "S5";
const put = (root, path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
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
  return nodeRun("loop.mjs", ["next", "--config", config], { ...process.env, ...s.host });
}

function appendHandoff(records, entry, body) {
  put(records, entry.record, body ?? `# ${entry.id}\n`);
  const existing = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8");
  put(records, "metrics/handoffs.jsonl", existing + JSON.stringify(entry) + "\n");
}

function commitProductFile(product, rel, content, msg) {
  const base = git(product, "rev-parse", "loop/s5");
  git(product, "checkout", "-q", "loop/s5");
  put(product, rel, content);
  git(product, "add", "-A");
  git(product, "commit", "-qm", msg);
  return { base, commit: git(product, "rev-parse", "loop/s5") };
}

function actorHandoff(round, base, commit, time) {
  const stem = `${String(round).padStart(4, "0")}-actor`;
  const record = `rounds/${stem}.md`;
  return {
    id: `R-${stem}`, time, phase: PHASE, round, step: "actor", role: "actor", attempt: 1,
    agent: { runner: "claude", model: "claude-opus-4-6" }, view: "a".repeat(40),
    product: { base, commit }, audit: { violations: 0 }, record, files: [record],
  };
}

test("1. T1 0-bug green streak progresses ok -> async-due -> hard-due (exit 7) and resets after reviewer-architecture", async () => {
  const s = await setup({}, { cadence: { deliveries: 2, outerGrace: 1 } });
  const config = writeConfig(s);

  for (let i = 1; i <= 2; i++) {
    const { base, commit } = commitProductFile(s.product, `src/f${i}.js`, `export const f${i} = ${i};\n`, `delivery ${i}`);
    appendHandoff(s.records, actorHandoff(i + 1, base, commit, `2026-11-24T01:0${i}:00Z`));
    commitAll(s.records, `actor delivery ${i}`);
  }

  const handoffs2 = readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const st2 = outerLoopState({ handoffs: handoffs2, rows: [], deliveries: 2, outerGrace: 1, phase: PHASE });
  assert.equal(st2.status, "async-due");
  assert.equal(st2.t1Due, true);
  assert.equal(st2.graceRemaining, 1);

  const nextAsync = runNext(s, config);
  assert.equal(nextAsync.status, 0, nextAsync.stderr);
  assert.match(nextAsync.stdout, /Outer loop: async-due \(T1\)/);
  assert.match(nextAsync.stdout, /Outer loop due asynchronously \(T1\)/);
  assert.match(nextAsync.stdout, /--step reviewer-architecture/);

  assert.equal(s.run("actor", { round: 4, dry: true }).code, EXIT.done);

  const { base: b3, commit: c3 } = commitProductFile(s.product, "src/f3.js", "export const f3 = 3;\n", "delivery 3");
  appendHandoff(s.records, actorHandoff(4, b3, c3, "2026-11-24T01:03:00Z"));
  commitAll(s.records, "actor delivery 3");

  const handoffs3 = readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const st3 = outerLoopState({ handoffs: handoffs3, rows: [], deliveries: 2, outerGrace: 1, phase: PHASE });
  assert.equal(st3.status, "hard-due");
  assert.equal(st3.graceRemaining, 0);

  const nextHard = runNext(s, config);
  assert.equal(nextHard.status, 0, nextHard.stderr);
  assert.match(nextHard.stdout, /Outer loop: hard-due \(T1\)/);
  assert.match(nextHard.stdout, /mechanically blocked \(exit 7\)/);

  const refused = s.run("actor", { round: 5, dry: true });
  assert.equal(refused.code, EXIT.records, `expected exit 7, got ${refused.code}: ${refused.message}`);
  assert.match(refused.message, /reviewer-architecture/);
  assert.match(refused.message, /T1 delivery cadence/);

  assert.equal(s.run("critic", { round: 5, dry: true }).code, EXIT.done);
  assert.equal(s.run("judge", { round: 5, dry: true }).code, EXIT.done);
  assert.equal(s.run("reviewer", { round: 5, step: "reviewer-architecture", dry: true }).code, EXIT.done);

  const arch = s.run("reviewer", { round: 5, step: "reviewer-architecture" });
  assert.equal(arch.code, EXIT.done, arch.message);
  const handoffsAfter = readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const stAfter = outerLoopState({ handoffs: handoffsAfter, rows: [], deliveries: 2, outerGrace: 1, phase: PHASE, targetSha: c3 });
  assert.equal(stAfter.status, "ok");
  assert.equal(stAfter.deliveriesSince, 0);
  assert.equal(s.run("actor", { round: 6, dry: true }).code, EXIT.done);
});

test("2. T3 arch-facts hard-size breach triggers async-due -> hard-due after grace, but skips inside active Bounded Window", async () => {
  const s = await setup({}, { cadence: { deliveries: 10, outerGrace: 1 } });
  const config = writeConfig(s);
  const big = Array.from({ length: 850 }, (_, i) => `export const x${i} = ${i};`).join("\n") + "\n";
  commitProductFile(s.product, "src/god-module.js", big, "add god module");

  const next0 = runNext(s, config);
  assert.equal(next0.status, 0, next0.stderr);
  assert.match(next0.stdout, /Outer loop: async-due \(T3\)/);
  assert.match(next0.stdout, /src\/god-module\.js/);
  assert.equal(s.run("actor", { round: 2, dry: true }).code, EXIT.done);

  const { base, commit } = commitProductFile(s.product, "src/touch.js", "export const t = 1;\n", "one more delivery");
  appendHandoff(s.records, actorHandoff(2, base, commit, "2026-11-24T01:01:00Z"));
  commitAll(s.records, "delivery under T3");

  const blocked = s.run("actor", { round: 3, dry: true });
  assert.equal(blocked.code, EXIT.records, `expected exit 7, got ${blocked.code}: ${blocked.message}`);
  assert.match(blocked.message, /T3 arch-facts breach/);
  assert.match(blocked.message, /src\/god-module\.js/);

  openWindow(s.records, { phase: PHASE, startRound: 3, horizon: 3, goal: "Decompose god module", invariants: ["All files <= 500 lines"] });
  assert.equal(s.run("actor", { round: 3, dry: true }).code, EXIT.done);
});

test("3. read-only reviewer-architecture gets arch-facts.json + readable wt, makes zero product commits, and enforces strict confinement", async () => {
  const s = await setup({});
  const beforeProduct = git(s.product, "rev-parse", "loop/s5");

  const dry = s.run("reviewer", { round: 2, step: "reviewer-architecture", dry: true });
  assert.equal(dry.code, EXIT.done, dry.message);
  const factsPath = join(dry.ws, "arch-facts.json");
  assert.equal(existsSync(factsPath), true, "arch-facts.json written in reviewer-architecture workspace");
  const facts = JSON.parse(readFileSync(factsPath, "utf8"));
  assert.equal(facts.sha, beforeProduct);
  assert.ok(Array.isArray(facts.largestFiles) && facts.largestFiles.some(f => f.path === "src/a.js"));

  s.scenarioSet({
    reviewer: [{
      report: "VERDICT: CONTINUE\n\n# Architecture check\n\nReviewed wt/src/a.js.\n",
      events: [{ name: "Read", input: { file_path: "wt/src/a.js" } }],
    }],
  });
  const ok = s.run("reviewer", { round: 2, step: "reviewer-architecture" });
  assert.equal(ok.code, EXIT.done, ok.message);
  assert.equal(ok.handoff.product.base, beforeProduct);
  assert.equal(ok.handoff.product.commit, beforeProduct, "zero product commits from reviewer-architecture");
  assert.equal(git(s.product, "rev-parse", "loop/s5"), beforeProduct);

  s.scenarioSet({
    reviewer: [{ events: [{ name: "Read", input: { file_path: join(s.sealed, "case-07.mjs") } }] }],
  });
  const sealedHit = s.run("reviewer", { round: 3, step: "reviewer-architecture" });
  assert.equal(sealedHit.code, EXIT.violation, sealedHit.message);

  s.scenarioSet({
    reviewer: [{ events: [{ name: "Bash", input: { command: "ls" } }] }],
  });
  const bashHit = s.run("reviewer", { round: 4, step: "reviewer-architecture" });
  assert.equal(bashHit.code, EXIT.violation, bashHit.message);

  s.scenarioSet({
    reviewer: [{ write: { "ws:wt/src/a.js": "export const hacked = 1;\n" } }],
  });
  const mutateHit = s.run("reviewer", { round: 5, step: "reviewer-architecture" });
  assert.equal(mutateHit.code, EXIT.violation, mutateHit.message);
  assert.equal(git(s.product, "rev-parse", "loop/s5"), beforeProduct);
});

test("4. owner-words strips T3/harness noise envelopes and distinguishes routine acks from substantive statements", () => {
  const noise = [
    "Delegated task node:delegated-task:abc123 [completed]: finished",
    "  Delegated task node:delegated-task:xyz999 status update",
    '[T3 Code: the agent in T3 thread "0dda5e1c" sent this message, not the user.]\n\nAct as actor.',
    "<CONTEXT_SUMMARY>\nPrevious conversation summary\n</CONTEXT_SUMMARY>",
    "  <SYSTEM_MESSAGE>\nReminder: work efficiently.\n</SYSTEM_MESSAGE>",
  ];
  for (const text of noise) {
    assert.equal(captureOwnerText(text), null, `noise must be ignored: ${text}`);
  }

  const realWords = [
    "先做重构，而且不需要每轮开发完就critic",
    "Please decompose src/task.js before adding new features.",
  ];
  for (const text of realWords) {
    assert.equal(captureOwnerText(text), text);
    assert.equal(isSubstantiveOwnerWord(text), true);
  }

  for (const ack of ["ok", "go", "yes", "继续", "去做", "好的", "确认", "好的！", "ok."]) {
    assert.equal(isSubstantiveOwnerWord(ack), false, `routine ack should be non-substantive: ${ack}`);
  }
  for (const substantive of ["继续?", "为什么？", "不要用兼容层", "Add an architecture gate in code, not prose."]) {
    assert.equal(isSubstantiveOwnerWord(substantive), true, `substantive word expected: ${substantive}`);
  }
});

test("5. owner-word distillation gate enforces 0-turn grace on 1st actor turn (exit 7), leaves reviewer open, and unblocks once distilled", async () => {
  const s = await setup({});
  const config = writeConfig(s);

  const routineWord = {
    id: "W-1111111111", time: "2026-11-24T00:10:00Z", source: "claude", session: "s1",
    text: "去做", sha256: "a",
  };
  const substantiveWord = {
    id: "W-2222222222", time: "2026-11-24T00:20:00Z", source: "claude", session: "s1",
    text: "这些东西需要你在代码上和门控上控制好，不要靠自然语言", sha256: "b",
  };
  appendWords(s.records, [routineWord, substantiveWord]);

  const nextOut = runNext(s, config);
  assert.equal(nextOut.status, 0, nextOut.stderr);
  assert.match(nextOut.stdout, /substantive open owner word\(s\) \(W-2222222222\)/);
  assert.match(nextOut.stdout, /--step reviewer-distill/);

  const refused = s.run("actor", { round: 2, dry: true });
  assert.equal(refused.code, EXIT.records, `expected exit 7, got ${refused.code}: ${refused.message}`);
  assert.match(refused.message, /W-2222222222/);
  assert.match(refused.message, /reviewer-distill/);
  assert.doesNotMatch(refused.message, /W-1111111111/, "routine ack is not blocked");

  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-distill", dry: true }).code, EXIT.done);

  put(s.records, "purpose/P-0002.md", "# P-0002 Code-enforced gates\n\nwords: W-2222222222\n");
  commitAll(s.records, "distill owner word");
  assert.equal(s.run("actor", { round: 2, dry: true }).code, EXIT.done);
});

test("6. self-loop start surfaces missing Antigravity hooks.json when a T3 instance exists and stays silent when none exists", () => {
  const lead = loopProduct({ activity: "2026-11-24T00:00:00.000Z" });
  const store = ownerStore([{ name: "lead", records: lead.records }]);

  const cleanEnv = isolatedEnv({ SELF_LOOP_OWNER_STORE: store });
  const cleanJson = selfLoop(["start", "--now", "2026-11-24T01:00:00.000Z", "--json"], { cwd: lead.product, env: cleanEnv });
  assert.equal(cleanJson.status, 0, cleanJson.stderr);
  const cleanReport = JSON.parse(cleanJson.stdout);
  assert.deepEqual(cleanReport.hooks, { healthy: true, findings: [] });
  assert.equal(cleanReport.session.hooks, undefined);

  const cleanText = selfLoop(["start", "--now", "2026-11-24T01:00:00.000Z"], { cwd: lead.product, env: cleanEnv });
  assert.equal(cleanText.status, 0, cleanText.stderr);
  assert.doesNotMatch(cleanText.stdout, /hooks \(antigravity\)/);

  const fakeT3 = temp("fake-t3-home-");
  mkdirSync(join(fakeT3, "userdata", "providers", "antigravity", "inst-deadbeef", "antigravity-acp"), { recursive: true });
  const agEnv = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, T3CODE_HOME: fakeT3 });

  const badJson = selfLoop(["start", "--now", "2026-11-24T01:00:00.000Z", "--json"], { cwd: lead.product, env: agEnv });
  assert.equal(badJson.status, 0, badJson.stderr);
  const badReport = JSON.parse(badJson.stdout);
  assert.equal(badReport.hooks.healthy, false);
  assert.ok(badReport.hooks.findings.some(f => f.includes("inst-deadbeef") && f.includes("hooks.json")), JSON.stringify(badReport.hooks));
  assert.equal(badReport.session.hooks.healthy, false);

  const badText = selfLoop(["start", "--now", "2026-11-24T01:00:00.000Z"], { cwd: lead.product, env: agEnv });
  assert.equal(badText.status, 0, badText.stderr);
  assert.match(badText.stdout, /hooks \(antigravity\):.*inst-deadbeef.*hooks\.json/);
});
