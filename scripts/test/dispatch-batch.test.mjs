// P-0012, D-0060, design/mandatory-control-plane.md#4
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { prepareWave, recordWave } from "../lib/dispatch.mjs";
import { loadPlan, parsePlan, readyPlan, snapshot, validatePlan } from "../lib/plan.mjs";
import { openWindow } from "../lib/window.mjs";
import { git, isolatedEnv, roomyStore, scripts, setup, temp } from "./helpers.mjs";

const put = (root, rel, text) => { const abs = join(root, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); return abs; };
const commitAll = (dir, msg) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); return git(dir, "rev-parse", "HEAD"); };
const wordRow = (id, text, time = "2026-11-24T12:00:00Z") => ({
  id, time, source: "antigravity", session: "unit-sess", text, sha256: createHash("sha256").update(text).digest("hex"),
});

function planMd(id, packages, { scope = "S5/round-2", phase = "S5", supersedes = null } = {}) {
  return [
    `# ${id} Plan`, `scope: ${scope}`, `phase: ${phase}`, ...(supersedes ? [`supersedes: ${supersedes}`] : []), "",
    ...packages.flatMap(p => [
      `## ${p.id}`, `role: ${p.role}`, `handoff: ${p.handoff}`,
      `authority: ${Array.isArray(p.authority) ? p.authority.join(", ") : p.authority}`,
      `goal: ${p.goal ?? `Deliver ${p.id}`}`, `files: ${(p.files ?? []).join(", ")}`,
      `interface: ${p.interface ?? "design/spec.md#v1"}`, `acceptance: ${p.acceptance ?? "tests pass"}`,
      `needs: ${(p.needs ?? []).join(", ")}`,
      ...(p.reviews ? [`reviews: ${p.reviews.join(", ")}`] : []), "",
    ]),
  ].join("\n");
}

function triad(authority = "D-0002") {
  return [
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority, files: ["test/a.test.js"], needs: [], reviews: ["actor-a"] },
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority, files: ["src/a.js"], needs: ["critic-a"] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority, files: [], needs: ["actor-a"], reviews: ["critic-a", "actor-a"] },
  ];
}

async function makeBatchWorld({ agents = null } = {}) {
  const t3 = p => ({ runner: "t3", provider: p, model: "m" });
  const s = await setup({}, {
    owns: { critic: ["test"], actor: ["src"] },
    agents: agents ?? { critic: t3("codex"), actor: t3("claude"), judge: t3("codex"), reviewer: t3("claude") },
    recordFiles: {
      "design/spec.md": "# Spec\n\n## v1\n\nContract.\n",
      "owner/B-0001.md": "# B-0001\n\nphase: S5\nfrom: R-0001-reviewer-frame\n\n### 1. Approve?\nOptions: Yes / No\nRecommendation: Yes\n",
      "owner/B-0002.md": "# B-0002\n\nphase: S5\nfrom: R-0001-reviewer-frame\n\n### 1. Pending?\nOptions: A / B\nRecommendation: A\n",
      "owner/answers.jsonl": JSON.stringify({ batch: "B-0001", time: "2026-11-24T08:00:00Z", words: "Yes", outcome: "as-recommended" }) + "\n",
      "decisions/D-0001.md": "# D-0001 Bare lead\n\nid: D-0001\nby: lead\nstatus: active\n",
      "decisions/D-0002.md": "# D-0002 Owner\n\nid: D-0002\nby: owner (B-0001 answer)\nrelates: B-0001\nstatus: active\n",
      "decisions/D-0003.md": "# D-0003 Unanswered\n\nid: D-0003\nby: lead\nrelates: B-0002\nstatus: active\n",
      "decisions/D-0004.md": "# D-0004 Missing reviewer\n\nid: D-0004\nby: lead\nrelates: R-0009-reviewer-frame\nstatus: active\n",
      "decisions/D-0005.md": "# D-0005 Reviewer backed\n\nid: D-0005\nby: lead\nrelates: R-0001-reviewer-frame\nstatus: active\n",
      "decisions/D-0006.md": "# D-0006 No by line\n\nstatus: active\n",
    },
  });
  put(s.product, "src/b.js", "export const b = 1;\n");
  put(s.product, "test/b.test.js", "export const tb = 1;\n");
  commitAll(s.product, "add b files");
  git(s.product, "branch", "-f", "loop/s5", "HEAD");
  put(s.records, "loop.json", JSON.stringify(s.cfg, null, 2) + "\n");
  commitAll(s.records, "commit loop.json");
  return s;
}

function writeCodex(codexHome, sid, prompt, cwd) {
  const now = new Date();
  const dir = join(codexHome, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString();
  const file = join(dir, `rollout-${sid}.jsonl`);
  writeFileSync(file, [
    { timestamp: ts, type: "session_meta", payload: { cwd, id: sid } },
    { timestamp: ts, type: "turn_context", payload: { cwd, model: "gpt-test" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function writeClaude(claudeHome, sid, prompt, cwd) {
  const dir = join(claudeHome, "projects", cwd.replace(/[/.]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, [
    { type: "user", cwd, timestamp: ts, sessionId: sid, message: { role: "user", content: prompt } },
    { type: "assistant", cwd, timestamp: ts, message: { model: "claude-test", stop_reason: "end_turn", content: [] } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function bumpAfterPrepare(file, ws) {
  const { preparedAt } = JSON.parse(readFileSync(join(ws, "call.json"), "utf8"));
  const sec = Math.ceil((preparedAt + 1000) / 1000);
  utimesSync(file, sec, sec);
}

test("validatePlan enforces 0-turn substantive owner-word grace and ignores routine acks", async () => {
  const s = await makeBatchWorld();
  const plan = parsePlan(planMd("PL-0001", triad("D-0002")));

  put(s.records, "owner/words.jsonl", [wordRow("W-1111111111", "ok"), wordRow("W-2222222222", "继续")].map(r => JSON.stringify(r)).join("\n") + "\n");
  commitAll(s.records, "routine acks");
  assert.deepEqual(validatePlan(plan, snapshot(s.records)), []);

  put(s.records, "owner/words.jsonl", [
    wordRow("W-1111111111", "ok"),
    wordRow("W-3333333333", "Must require generation engine approval before actor work"),
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  commitAll(s.records, "substantive word");
  const blocked = validatePlan(plan, snapshot(s.records));
  assert.ok(blocked.some(e => e.includes("W-3333333333")), blocked.join("\n"));

  put(s.records, "owner/word-marks.jsonl", JSON.stringify({ id: "W-3333333333", as: "routine", note: "acknowledged", time: "2026-11-24T12:01:00Z" }) + "\n");
  commitAll(s.records, "mark word");
  assert.deepEqual(validatePlan(plan, snapshot(s.records)), []);
});

test("validatePlan enforces decision and generation-engine authority provenance", async () => {
  const s = await makeBatchWorld();
  const st = snapshot(s.records);

  for (const bad of ["D-0001", "D-0003", "D-0004", "D-0006"]) {
    const errs = validatePlan(parsePlan(planMd("PL-0001", triad(bad))), st);
    assert.ok(errs.length > 0, `expected ${bad} to be refused`);
  }
  for (const good of ["D-0002", "D-0005", "R-0001-reviewer-frame"]) {
    assert.deepEqual(validatePlan(parsePlan(planMd("PL-0001", triad(good))), st), [], `expected ${good} to pass`);
  }
});

test("validatePlan enforces Critic coverage outside open W-NNNN refactoring windows without requiring a mandatory judge", async () => {
  const s = await makeBatchWorld();
  const actorOnly = parsePlan(planMd("PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority: "D-0002", files: ["src/a.js"], needs: [] },
  ]));
  const errs = validatePlan(actorOnly, snapshot(s.records));
  assert.ok(errs.some(e => /critic/i.test(e)), errs.join("\n"));
  assert.ok(!errs.some(e => /judge/i.test(e)), errs.join("\n"));

  const actorPlusCritic = parsePlan(planMd("PL-0001", [
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], needs: [], reviews: ["actor-a"] },
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority: "D-0002", files: ["src/a.js"], needs: ["critic-a"] },
  ]));
  assert.deepEqual(validatePlan(actorPlusCritic, snapshot(s.records)), []);

  openWindow(s.records, { phase: "S5", startRound: 2, horizon: 3, goal: "refactor", invariants: ["tests green"] });
  assert.deepEqual(validatePlan(actorOnly, snapshot(s.records)), []);
});

test("readyPlan ignores unplanned workspace owns prefix while keeping planned writer holds", async () => {
  const s = await makeBatchWorld();
  const plan = parsePlan(planMd("PL-0001", triad("D-0002")));
  const superseded = parsePlan(planMd("PL-0000", [
    { id: "critic-old", role: "critic", handoff: "R-0001-critic-old", authority: "D-0002", files: ["test/a.test.js"], needs: [], reviews: ["actor-old"] },
    { id: "actor-old", role: "actor", handoff: "R-0001-actor-old", authority: "D-0002", files: ["src/a.js"], needs: ["critic-old"] },
    { id: "judge-old", role: "judge", handoff: "R-0001-judge-old", authority: "D-0002", files: [], needs: ["actor-old"] },
  ]));
  for (const p of plan.packages) put(s.cfg.workDir, `tasks/${p.handoff}.md`, `features: F-0001\n${p.id}\n`);
  const st = snapshot(s.records);
  const doneCritic = [{ id: "R-0002-critic-a", phase: "S5", record: "rounds/0001-reviewer-frame.md" }];
  const baseCtx = { cfg: s.cfg, handoffs: doneCritic, batches: [], plans: [superseded, plan] };
  const host = { admits: true, over: [], calls: [] };

  const unplanned = readyPlan(st, plan, {
    context: { ...baseCtx, prepared: [{ id: "R-0001-actor-adhoc", role: "actor", phase: "S5", liveWorkspace: true, ws: "/w/adhoc", owns: ["src"] }] },
    host,
  });
  assert.equal(unplanned.packages.find(p => p.id === "actor-a").status, "ready");

  const planned = readyPlan(st, plan, {
    context: {
      ...baseCtx,
      prepared: [{ id: "R-0001-actor-old", role: "actor", phase: "S5", liveWorkspace: true, ws: "/w/old", owns: ["src"], dispatch: { plan: "PL-0000", package: "actor-old", files: ["src/a.js"] } }],
    },
    host,
  });
  const held = planned.packages.find(p => p.id === "actor-a");
  assert.equal(held.status, "waiting");
  assert.ok(held.holds.some(h => h.kind === "writer" && h.target === "R-0001-actor-old"));
});

test("prepareWave and recordWave --integrate batch-prepare tasks, record by nonce, and integrate diverged actors", async () => {
  const s = await makeBatchWorld();
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], needs: [], reviews: ["actor-a"] },
    { id: "critic-b", role: "critic", handoff: "R-0002-critic-b", authority: "D-0002", files: ["test/b.test.js"], needs: [], reviews: ["actor-b"] },
    { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority: "D-0002", files: ["src/a.js"], needs: ["critic-a"] },
    { id: "actor-b", role: "actor", handoff: "R-0002-actor-b", authority: "D-0002", files: ["src/b.js"], needs: ["critic-b"] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["actor-a", "actor-b"], reviews: ["critic-a", "critic-b", "actor-a", "actor-b"] },
  ]));
  commitAll(s.records, "PL-0001");

  const codexHome = temp("sl-codex-");
  const claudeHome = temp("sl-claude-");
  const oldCodex = process.env.CODEX_HOME, oldClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  try {
    const st0 = snapshot(s.records);
    const plan = loadPlan(st0, "PL-0001");
    const prep0 = prepareWave({ cfg: s.cfg, state: st0, plan, host: { admits: true, over: [], calls: [] } });
    assert.equal(prep0.ok, true, JSON.stringify(prep0.errors));
    assert.equal(prep0.prepared.length, 2);
    for (const item of prep0.prepared) {
      assert.ok(existsSync(item.taskFile));
      assert.match(readFileSync(item.taskFile, "utf8"), /^features:\s*F-0001/m);
      put(item.ws, "out/report.md", `# ${item.handoff}\n\nRed cases.\n`);
      bumpAfterPrepare(writeCodex(codexHome, `s-${item.nonce}`, item.prompt, item.wt), item.ws);
    }

    const rec0 = recordWave({ cfg: s.cfg, state: snapshot(s.records), plan });
    assert.equal(rec0.ok, true, JSON.stringify(rec0.errors));
    assert.equal(rec0.recorded.length, 2);

    const prep1 = prepareWave({ cfg: s.cfg, state: snapshot(s.records), plan, host: { admits: true, over: [], calls: [] } });
    assert.equal(prep1.ok, true, JSON.stringify(prep1.errors));
    assert.equal(prep1.prepared.length, 2);
    for (const item of prep1.prepared) {
      const f = item.id === "actor-a" ? "src/a.js" : "src/b.js";
      put(item.wt, f, `export const ${item.id.slice(-1)} = 99;\n`);
      put(item.ws, "out/report.md", `# ${item.handoff}\n\nDone.\n`);
      bumpAfterPrepare(writeClaude(claudeHome, `s-${item.nonce}`, item.prompt, item.wt), item.ws);
    }

    const rec1 = recordWave({ cfg: s.cfg, state: snapshot(s.records), plan, integrate: true });
    assert.equal(rec1.ok, true, JSON.stringify(rec1.errors));
    assert.equal(rec1.recorded.length, 2);
    assert.equal(rec1.integration?.ok, true);
    assert.equal(git(s.product, "show", "loop/s5:src/a.js"), "export const a = 99;");
    assert.equal(git(s.product, "show", "loop/s5:src/b.js"), "export const b = 99;");
  } finally {
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
    if (oldClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldClaude;
  }

  const cliCheck = spawnSync(process.execPath, [join(scripts, "dispatch.mjs"), "prepare", "--config", join(s.records, "loop.json"), "--plan", "PL-0001", "--wave", "2", "--json"], {
    encoding: "utf8",
    env: { ...isolatedEnv(), SELF_LOOP_TEST: "1", SELF_LOOP_OWNER_STORE: roomyStore(), SELF_LOOP_LOAD_DIR: temp("sl-load-") },
  });
  assert.equal(cliCheck.status, 0, cliCheck.stderr + cliCheck.stdout);
  const parsed = JSON.parse(cliCheck.stdout);
  assert.equal(parsed.prepared.length, 1);
  assert.equal(parsed.prepared[0].id, "judge-a");
});
