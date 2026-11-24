// D-0060, design/mandatory-control-plane.md#4
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePlan, snapshot, validatePlan } from "../scripts/lib/plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, "..", "scripts");
const BRIEFS = {
  shared: "engines/shared.md",
  critic: "engines/critic.md",
  actor: "engines/actor.md",
  judge: "engines/judge.md",
  reviewer: "engines/frame-reviewer.md",
};

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "sl-plan-auth-batch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const ownerStore = join(root, "owner-store");
  const loadDir = join(root, "load");
  const claudeHome = join(root, "claude-home");
  const codexHome = join(root, "codex-home");
  const geminiHome = join(root, "gemini-home");
  for (const d of [home, ownerStore, loadDir, claudeHome, codexHome, geminiHome]) mkdirSync(d, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    SELF_LOOP_TEST: "1",
    SELF_LOOP_OWNER_STORE: ownerStore,
    SELF_LOOP_LOAD_DIR: loadDir,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    GEMINI_HOME: geminiHome,
    ANTIGRAVITY_APP_DATA_DIR: "",
    T3CODE_HOME: "",
    T3CODE_THREAD_ID: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Critic Test",
    GIT_AUTHOR_EMAIL: "critic@example.invalid",
    GIT_COMMITTER_NAME: "Critic Test",
    GIT_COMMITTER_EMAIL: "critic@example.invalid",
  };
  delete env.SELF_LOOP_CONFIG;

  const git = (repoDir, ...args) =>
    execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env }).trim();

  const put = (baseDir, rel, content) => {
    const abs = join(baseDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };

  const repo = (dir, files, msg = "init") => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", msg);
    return dir;
  };

  repo(ownerStore, {
    "README.md": "# Owner store\n",
    "products.json": JSON.stringify({ products: [], roots: [], maxLoadRatio: 1e9, minAvailableMemoryGB: 0 }, null, 2) + "\n",
  });

  const runScript = (script, args, { cwd = root, extraEnv = {} } = {}) =>
    spawnSync(process.execPath, [join(scriptsDir, script), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...env, ...extraEnv },
      maxBuffer: 16 * 1024 * 1024,
    });

  return { root, env, claudeHome, codexHome, git, put, repo, runScript };
}

function makeWorld(sb, { agents = null } = {}) {
  const product = join(sb.root, "product");
  const records = join(sb.root, "records");
  const workDir = join(sb.root, "work");
  mkdirSync(workDir, { recursive: true });

  sb.repo(product, {
    "src/a.js": "export const a = 1;\n",
    "src/b.js": "export const b = 1;\n",
    "test/a.test.js": "export const ta = 1;\n",
    "test/b.test.js": "export const tb = 1;\n",
    "docs/PURPOSE.md": "# Purpose\n\nDeterministic control plane.\n",
  });
  sb.git(product, "branch", "loop/s5");

  const defaultAgents = agents ?? {
    critic: { runner: "t3", provider: "codex", model: "m" },
    actor: { runner: "t3", provider: "claude", model: "m" },
    judge: { runner: "t3", provider: "codex", model: "m" },
    reviewer: { runner: "t3", provider: "claude", model: "m" },
  };
  const cfg = {
    product,
    branch: "loop/s5",
    records,
    workDir,
    phase: "S5",
    briefs: BRIEFS,
    sealed: [],
    purpose: ["docs/PURPOSE.md"],
    owns: { critic: ["test"], actor: ["src"] },
    protected: ["main"],
    agents: defaultAgents,
    commitPrefix: "loop(s5)",
  };

  const handoffs = [
    {
      id: "R-0001-reviewer-frame",
      time: "2026-11-24T08:00:00Z",
      phase: "S5",
      round: 1,
      step: "reviewer-frame",
      role: "reviewer",
      attempt: 1,
      agent: { runner: "claude", model: "claude-test" },
      view: "a".repeat(40),
      product: null,
      audit: { violations: 0 },
      record: "rounds/0001-reviewer-frame.md",
      files: ["rounds/0001-reviewer-frame.md"],
    },
    {
      id: "R-0001-judge-frame",
      time: "2026-11-24T08:05:00Z",
      phase: "S5",
      round: 1,
      step: "judge-frame",
      role: "judge",
      attempt: 1,
      agent: { runner: "codex", model: "gpt-test" },
      view: "a".repeat(40),
      product: null,
      audit: { violations: 0 },
      record: "rounds/0001-judge-frame.md",
      files: ["rounds/0001-judge-frame.md"],
    },
  ];

  const recordFiles = {
    "README.md": "# Loop records\n",
    "records.json": JSON.stringify({ extraKinds: [] }, null, 2) + "\n",
    "loop.json": JSON.stringify(cfg, null, 2) + "\n",
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief text.\n`])),
    "purpose/P-0001.md": "# P-0001 Deterministic control plane\n\nstatus: active\n",
    "blueprint/F-0001.md": "# F-0001 Control plane feature\n\nid: F-0001\nphase: S5\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": JSON.stringify({
      feature: "F-0001", phase: "S5", status: "building", time: "2026-11-24T08:00:00Z", by: "lead", note: "active", evidence: {},
    }) + "\n",
    "design/spec.md": "# Spec\n\n## v1\n\nFrozen contract.\n",
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nVERDICT: CONTINUE\n",
    "rounds/0001-judge-frame.md": "# R-0001-judge-frame\n\nVERDICT: CONVERGED\n",
    "metrics/handoffs.jsonl": handoffs.map(h => JSON.stringify(h)).join("\n") + "\n",
    "owner/B-0001.md": [
      "# B-0001 Owner batch", "", "phase: S5", "from: R-0001-reviewer-frame", "",
      "### 1. Approve v1 control plane?", "Options: Yes / No", "Recommendation: Yes", "",
    ].join("\n"),
    "owner/B-0002.md": [
      "# B-0002 Owner batch", "", "phase: S5", "from: R-0001-reviewer-frame", "",
      "### 1. Unanswered question?", "Options: A / B", "Recommendation: A", "",
    ].join("\n"),
    "owner/answers.jsonl": JSON.stringify({
      batch: "B-0001", time: "2026-11-24T08:10:00Z", words: "as recommended", outcome: "as-recommended",
    }) + "\n",
    "decisions/D-0001.md": "# D-0001 Bare lead decision\n\nid: D-0001\nby: lead\ndate: 2026-11-24\nstatus: active\n\nSelf-authored without reviewer or owner batch.\n",
    "decisions/D-0002.md": "# D-0002 Owner-approved decision\n\nid: D-0002\nby: owner (B-0001 answer)\ndate: 2026-11-24\nstatus: active\nrelates: B-0001, R-0001-reviewer-frame\n",
    "decisions/D-0003.md": "# D-0003 Decision citing unanswered batch\n\nid: D-0003\nby: lead\ndate: 2026-11-24\nrelates: B-0002\nstatus: active\n",
    "decisions/D-0004.md": "# D-0004 Decision citing missing reviewer handoff\n\nid: D-0004\nby: lead\ndate: 2026-11-24\nrelates: R-0009-reviewer-frame\nstatus: active\n",
    "decisions/D-0005.md": "# D-0005 Reviewer-backed decision\n\nid: D-0005\nby: lead (from R-0001-reviewer-frame)\ndate: 2026-11-24\nrelates: R-0001-reviewer-frame\nstatus: active\n",
  };
  sb.repo(records, recordFiles, "seed records");
  const rc = sb.runScript("records-check.mjs", ["--repo", records, "--write"]);
  assert.equal(rc.status, 0, rc.stderr + rc.stdout);
  sb.git(records, "add", "-A");
  sb.git(records, "commit", "-qm", "index");

  const configPath = join(records, "loop.json");
  const commitRecords = msg => {
    sb.git(records, "add", "-A");
    const r = sb.runScript("records-check.mjs", ["--repo", records, "--write"]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    sb.git(records, "add", "-A");
    sb.git(records, "commit", "-qm", msg);
  };

  return { product, records, workDir, configPath, cfg, commitRecords };
}

const wordRow = (id, text, time = "2026-11-24T12:00:00Z") => ({
  id,
  time,
  source: "antigravity",
  session: "ag-session-1",
  text,
  sha256: createHash("sha256").update(text).digest("hex"),
});

function planText(id, packages, { scope = "S5/round-2", phase = "S5", supersedes = null } = {}) {
  return [
    `# ${id} Plan`,
    `scope: ${scope}`,
    `phase: ${phase}`,
    ...(supersedes ? [`supersedes: ${supersedes}`] : []),
    "",
    ...packages.flatMap(p => [
      `## ${p.id}`,
      `role: ${p.role}`,
      `handoff: ${p.handoff}`,
      `authority: ${Array.isArray(p.authority) ? p.authority.join(", ") : p.authority}`,
      `goal: ${p.goal ?? `Deliver ${p.id}`}`,
      `files: ${Array.isArray(p.files) ? p.files.join(", ") : (p.files ?? "")}`,
      `interface: ${p.interface ?? "design/spec.md#v1"}`,
      `acceptance: ${p.acceptance ?? "acceptance passes"}`,
      `needs: ${Array.isArray(p.needs) ? p.needs.join(", ") : (p.needs ?? "")}`,
      ...(p.reviews !== undefined ? [`reviews: ${Array.isArray(p.reviews) ? p.reviews.join(", ") : p.reviews}`] : []),
      "",
    ]),
  ].join("\n");
}

function validTriadPackages(authority = "D-0002") {
  return [
    {
      id: "critic-a",
      role: "critic",
      handoff: "R-0002-critic-a",
      authority,
      files: ["test/a.test.js"],
      needs: [],
      reviews: ["actor-a"],
    },
    {
      id: "actor-a",
      role: "actor",
      handoff: "R-0002-actor-a",
      authority,
      files: ["src/a.js"],
      needs: ["critic-a"],
    },
    {
      id: "judge-a",
      role: "judge",
      handoff: "R-0002-judge",
      authority,
      files: [],
      needs: ["critic-a", "actor-a"],
      reviews: ["critic-a", "actor-a"],
    },
  ];
}

function assertRefused(res, pattern, label) {
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  assert.notEqual(res.status, 0, `${label}: expected non-zero exit, got 0:\n${combined}`);
  assert.doesNotMatch(combined, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/, label);
  if (pattern) assert.match(combined, pattern, `${label}: expected ${pattern} in:\n${combined}`);
}

test("PLB-01 fresh · flow: plan.mjs validate enforces 0-turn grace on substantive open owner words while ignoring routine acks · loss: false-verdict", t => {
  const sb = makeSandbox(t);
  const w = makeWorld(sb);
  const planFile = sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", validTriadPackages("D-0002")));

  sb.put(w.records, "owner/words.jsonl", [
    wordRow("W-0000000001", "ok", "2026-11-24T11:50:00Z"),
    wordRow("W-0000000002", "继续", "2026-11-24T11:51:00Z"),
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  w.commitRecords("commit PL-0001 with routine acks only");

  const ackOnly = sb.runScript("plan.mjs", ["validate", planFile, "--records", w.records]);
  assert.equal(ackOnly.status, 0, ackOnly.stderr + ackOnly.stdout);

  const substantiveId = "W-aaaa111122";
  sb.put(w.records, "owner/words.jsonl", [
    wordRow("W-0000000001", "ok", "2026-11-24T11:50:00Z"),
    wordRow("W-0000000002", "继续", "2026-11-24T11:51:00Z"),
    wordRow(substantiveId, "所有工作包必须先通过生成引擎授权再执行", "2026-11-24T12:00:00Z"),
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  w.commitRecords("capture substantive owner word 0 turns ago");

  const blocked = sb.runScript("plan.mjs", ["validate", planFile, "--records", w.records]);
  assertRefused(blocked, new RegExp(substantiveId), "0-turn substantive owner word refusal");

  sb.put(w.records, "decisions/D-0006.md", [
    "# D-0006 Require generation-engine authority before execution",
    "",
    "id: D-0006",
    "by: owner (B-0001 answer)",
    "date: 2026-11-24",
    `words: ${substantiveId}`,
    "relates: B-0001, R-0001-reviewer-frame",
    "status: active",
    "",
    `Distilled from ${substantiveId}.`,
    "",
  ].join("\n"));
  w.commitRecords("distill substantive owner word");

  const unblocked = sb.runScript("plan.mjs", ["validate", planFile, "--records", w.records]);
  assert.equal(unblocked.status, 0, unblocked.stderr + unblocked.stdout);
});

test("PLB-02 fresh · flow: plan validation rejects bare by:lead, unanswered-batch, and missing-reviewer authorities while accepting owner-batch, reviewer, and judge authorities · loss: false-verdict", t => {
  const sb = makeSandbox(t);
  const w = makeWorld(sb);
  const st = snapshot(w.records);

  const checkBoth = (id, authority) => {
    const content = planText(id, validTriadPackages(authority));
    const draftPath = join(sb.root, `${id}.md`);
    writeFileSync(draftPath, content);
    return {
      cli: sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]),
      fn: validatePlan(parsePlan(content), st),
    };
  };

  const bare = checkBoth("PL-0001", "D-0001");
  assertRefused(bare.cli, /D-0001|authority|reviewer|owner/i, "bare by:lead D-0001 CLI");
  assert.ok(bare.fn.length > 0, "validatePlan must refuse bare by:lead D-0001");

  const unanswered = checkBoth("PL-0002", "D-0003");
  assertRefused(unanswered.cli, /D-0003|B-0002|authority|unanswered|reviewer/i, "unanswered batch D-0003 CLI");
  assert.ok(unanswered.fn.length > 0, "validatePlan must refuse unanswered-batch D-0003");

  const missingRev = checkBoth("PL-0003", "D-0004");
  assertRefused(missingRev.cli, /D-0004|R-0009-reviewer-frame|authority|reviewer/i, "missing reviewer D-0004 CLI");
  assert.ok(missingRev.fn.length > 0, "validatePlan must refuse missing-reviewer D-0004");

  for (const [i, auth] of ["D-0002", "D-0005", "R-0001-reviewer-frame", "R-0001-judge-frame"].entries()) {
    const res = checkBoth(`PL-001${i}`, auth);
    assert.equal(res.cli.status, 0, `${auth} CLI failed: ${res.cli.stderr}\n${res.cli.stdout}`);
    assert.deepEqual(res.fn, [], `${auth} validatePlan errors: ${res.fn.join("; ")}`);
  }
});

test("PLB-03 fresh · flow: non-window plans require both critic coverage and judge coverage for every actor package · loss: false-verdict", t => {
  const sb = makeSandbox(t);
  const w = makeWorld(sb);
  const st = snapshot(w.records);

  const checkBoth = (id, packages) => {
    const content = planText(id, packages);
    const draftPath = join(sb.root, `${id}.md`);
    writeFileSync(draftPath, content);
    return {
      cli: sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]),
      fn: validatePlan(parsePlan(content), st),
    };
  };

  const actorA = { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority: "D-0002", files: ["src/a.js"], needs: [] };
  const actorB = { id: "actor-b", role: "actor", handoff: "R-0002-actor-b", authority: "D-0002", files: ["src/b.js"], needs: [] };

  const soloActor = checkBoth("PL-0001", [actorA]);
  assertRefused(soloActor.cli, /critic|judge|cover/i, "actor alone CLI");
  assert.ok(soloActor.fn.length > 0, "validatePlan must refuse actor without critic/judge");

  const noJudge = checkBoth("PL-0002", [
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], reviews: ["actor-a"] },
    { ...actorA, needs: ["critic-a"] },
  ]);
  assertRefused(noJudge.cli, /judge/i, "actor+critic without judge CLI");
  assert.ok(noJudge.fn.length > 0, "validatePlan must refuse plan missing judge coverage");

  const noCritic = checkBoth("PL-0003", [
    actorA,
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["actor-a"], reviews: ["actor-a"] },
  ]);
  assertRefused(noCritic.cli, /critic/i, "actor+judge without critic CLI");
  assert.ok(noCritic.fn.length > 0, "validatePlan must refuse actor without critic coverage");

  const partialCritic = checkBoth("PL-0004", [
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], reviews: ["actor-a"] },
    { ...actorA, needs: ["critic-a"] },
    actorB,
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["critic-a", "actor-b"], reviews: ["critic-a", "actor-a", "actor-b"] },
  ]);
  assertRefused(partialCritic.cli, /actor-b|critic|cover/i, "partial critic coverage CLI");
  assert.ok(partialCritic.fn.length > 0, "validatePlan must refuse uncovered actor-b");

  const preCriticOk = checkBoth("PL-0010", validTriadPackages("D-0002"));
  assert.equal(preCriticOk.cli.status, 0, preCriticOk.cli.stderr + preCriticOk.cli.stdout);
  assert.deepEqual(preCriticOk.fn, []);

  const postCriticOk = checkBoth("PL-0011", [
    actorA,
    { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], needs: ["actor-a"] },
    { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["critic-a"] },
  ]);
  assert.equal(postCriticOk.cli.status, 0, postCriticOk.cli.stderr + postCriticOk.cli.stdout);
  assert.deepEqual(postCriticOk.fn, []);
});

test("PLB-04 fresh · flow: plan.mjs ready ignores legacy unplanned workspace owns-prefix fallback while preserving planned writer holds · loss: stuck", t => {
  const sb = makeSandbox(t);
  const w = makeWorld(sb);

  const criticDone = {
    id: "R-0002-critic-a",
    time: "2026-11-24T09:00:00Z",
    phase: "S5",
    round: 2,
    step: "critic-a",
    role: "critic",
    attempt: 1,
    agent: { runner: "codex", model: "gpt-test" },
    view: "a".repeat(40),
    product: { base: sb.git(w.product, "rev-parse", "loop/s5"), commit: sb.git(w.product, "rev-parse", "loop/s5") },
    audit: { violations: 0 },
    record: "rounds/0002-critic-a.md",
    files: ["rounds/0002-critic-a.md"],
    dispatch: { plan: "PL-0001", package: "critic-a", files: ["test/a.test.js"] },
  };
  sb.put(w.records, "rounds/0002-critic-a.md", "# R-0002-critic-a\n");
  sb.put(
    w.records,
    "metrics/handoffs.jsonl",
    readFileSync(join(w.records, "metrics/handoffs.jsonl"), "utf8") + JSON.stringify(criticDone) + "\n",
  );
  sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", validTriadPackages("D-0002")));
  for (const id of ["R-0002-actor-a", "R-0002-judge"]) {
    sb.put(w.workDir, `tasks/${id}.md`, `features: F-0001\nDeliver ${id}\n`);
  }
  w.commitRecords("commit PL-0001 with critic-a done");

  const unplannedWs = join(w.workDir, "0001-actor-legacy-unplanned");
  const unplannedWt = join(unplannedWs, "wt");
  mkdirSync(unplannedWs, { recursive: true });
  sb.git(w.product, "worktree", "add", "-q", "--detach", unplannedWt, "loop/s5");
  sb.put(unplannedWs, "call.json", JSON.stringify({
    version: 2,
    role: "actor",
    round: 1,
    step: "actor-legacy",
    id: "R-0001-actor-legacy",
    record: "rounds/0001-actor-legacy.md",
    phase: "S5",
    ws: unplannedWs,
    wt: unplannedWt,
    owns: ["src"],
    nonce: "1122334455667788",
  }, null, 2));

  const readyRes = sb.runScript("plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]);
  assert.equal(readyRes.status, 0, readyRes.stderr + readyRes.stdout);
  const parsed = JSON.parse(readyRes.stdout);
  const actorRow = parsed.packages.find(p => p.id === "actor-a");
  assert.ok(actorRow, "actor-a must exist in ready output");
  assert.equal(actorRow.status, "ready", `unplanned legacy owns must NOT block actor-a: ${JSON.stringify(actorRow)}`);
  assert.equal(actorRow.holds.filter(h => h.kind === "writer").length, 0);

  sb.put(w.records, "plans/PL-0000.md", planText("PL-0000", [
    { id: "critic-old", role: "critic", handoff: "R-0002-critic-old", authority: "D-0002", files: ["test/a.test.js"], reviews: ["actor-old"] },
    { id: "actor-old", role: "actor", handoff: "R-0002-actor-old", authority: "D-0002", files: ["src/a.js"], needs: ["critic-old"] },
    { id: "judge-old", role: "judge", handoff: "R-0002-judge-old", authority: "D-0002", files: [], needs: ["critic-old", "actor-old"], reviews: ["critic-old", "actor-old"] },
  ]));
  sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", validTriadPackages("D-0002"), { supersedes: "PL-0000" }));
  w.commitRecords("add superseded PL-0000");

  const plannedWs = join(w.workDir, "0002-actor-old-planned");
  const plannedWt = join(plannedWs, "wt");
  mkdirSync(plannedWs, { recursive: true });
  sb.git(w.product, "worktree", "add", "-q", "--detach", plannedWt, "loop/s5");
  sb.put(plannedWs, "call.json", JSON.stringify({
    version: 2,
    role: "actor",
    round: 2,
    step: "actor-old",
    id: "R-0002-actor-old",
    record: "rounds/0002-actor-old.md",
    phase: "S5",
    ws: plannedWs,
    wt: plannedWt,
    owns: ["src"],
    nonce: "8877665544332211",
    dispatch: { plan: "PL-0000", package: "actor-old", files: ["src/a.js"] },
  }, null, 2));

  const heldRes = sb.runScript("plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]);
  assert.equal(heldRes.status, 0, heldRes.stderr + heldRes.stdout);
  const heldActor = JSON.parse(heldRes.stdout).packages.find(p => p.id === "actor-a");
  assert.equal(heldActor.status, "waiting");
  assert.ok(heldActor.holds.some(h => h.kind === "writer" && h.target === "R-0002-actor-old"), JSON.stringify(heldActor));
});

function writeCodexTranscript(codexHome, sessionId, prompt, cwd) {
  const now = new Date();
  const dir = join(
    codexHome,
    "sessions",
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString();
  const rows = [
    { timestamp: ts, type: "session_meta", payload: { cwd, id: sessionId } },
    { timestamp: ts, type: "turn_context", payload: { cwd, model: "gpt-test" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ];
  const file = join(dir, `rollout-${sessionId}.jsonl`);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function writeClaudeTranscript(claudeHome, sessionId, prompt, cwd) {
  const slug = cwd.replace(/[/.]/g, "-");
  const dir = join(claudeHome, "projects", slug);
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString();
  const rows = [
    { type: "user", cwd, timestamp: ts, sessionId, message: { role: "user", content: prompt } },
    { type: "assistant", cwd, timestamp: ts, message: { model: "claude-test", stop_reason: "end_turn", content: [] } },
  ];
  const file = join(dir, `${sessionId}.jsonl`);
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function bumpMtimeAfterPrepare(file, ws) {
  const { preparedAt } = JSON.parse(readFileSync(join(ws, "call.json"), "utf8"));
  const sec = Math.ceil((preparedAt + 1000) / 1000);
  utimesSync(file, sec, sec);
}

function extractPreparedItems(parsed) {
  if (Array.isArray(parsed)) return parsed;
  return parsed.prepared ?? parsed.packages ?? parsed.items ?? [];
}

test("PLB-05 fresh · flow: dispatch.mjs prepare|record and self-loop.mjs dispatch prepare|record batch-prepare tasks and record by nonce without --session · loss: stuck", t => {
  const sb = makeSandbox(t);
  const w = makeWorld(sb);

  sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", [
    {
      id: "critic-a",
      role: "critic",
      handoff: "R-0002-critic-a",
      authority: "D-0002",
      files: ["test/a.test.js"],
      acceptance: "test/a.test.js passes",
      needs: [],
      reviews: ["actor-a"],
    },
    {
      id: "critic-b",
      role: "critic",
      handoff: "R-0002-critic-b",
      authority: "D-0002",
      files: ["test/b.test.js"],
      acceptance: "test/b.test.js passes",
      needs: [],
      reviews: ["actor-b"],
    },
    {
      id: "actor-a",
      role: "actor",
      handoff: "R-0002-actor-a",
      authority: "D-0002",
      files: ["src/a.js"],
      acceptance: "test/a.test.js passes",
      needs: ["critic-a"],
    },
    {
      id: "actor-b",
      role: "actor",
      handoff: "R-0002-actor-b",
      authority: "D-0002",
      files: ["src/b.js"],
      acceptance: "test/b.test.js passes",
      needs: ["critic-b"],
    },
    {
      id: "judge-final",
      role: "judge",
      handoff: "R-0002-judge",
      authority: "D-0002",
      files: [],
      acceptance: "full suite passes",
      needs: ["actor-a", "actor-b"],
      reviews: ["critic-a", "critic-b", "actor-a", "actor-b"],
    },
  ]));
  w.commitRecords("commit decoupled 2-critic + 2-actor + judge PL-0001");

  assert.equal(existsSync(join(w.workDir, "tasks", "R-0002-critic-a.md")), false);
  assert.equal(existsSync(join(w.workDir, "tasks", "R-0002-critic-b.md")), false);

  const prepWave0 = sb.runScript("dispatch.mjs", ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"]);
  assert.equal(prepWave0.status, 0, prepWave0.stderr + prepWave0.stdout);
  const wave0Specs = extractPreparedItems(JSON.parse(prepWave0.stdout));
  assert.equal(wave0Specs.length, 2, `expected 2 Wave-0 prepared specs, got: ${prepWave0.stdout}`);

  for (const hId of ["R-0002-critic-a", "R-0002-critic-b"]) {
    const taskFile = join(w.workDir, "tasks", `${hId}.md`);
    assert.equal(existsSync(taskFile), true, `missing materialized task ${taskFile}`);
    assert.match(readFileSync(taskFile, "utf8"), /^features:\s*F-\d{4}/m);

    const spec = wave0Specs.find(s => (s.handoff ?? s.id) === hId || s.id === hId.replace("R-0002-", ""));
    assert.ok(spec, `missing spec for ${hId} in ${JSON.stringify(wave0Specs)}`);
    assert.match(spec.nonce, /^[0-9a-f]{16}$/);
    assert.ok(existsSync(join(spec.ws, "call.json")), "call.json missing");
    assert.ok(existsSync(spec.wt), "worktree missing");
    assert.ok(spec.prompt.includes(spec.nonce), "prompt must carry nonce");
    assert.ok(spec.target && spec.target.provider === "codex", `expected codex target: ${JSON.stringify(spec.target)}`);

    const callJson = JSON.parse(readFileSync(join(spec.ws, "call.json"), "utf8"));
    assert.equal(callJson.nonce, spec.nonce);
    assert.equal(callJson.dispatch?.plan, "PL-0001");

    sb.put(spec.ws, "out/report.md", `# ${hId} report\n\nRed cases written.\n`);
    const transcript = writeCodexTranscript(sb.codexHome, `sess-${hId}-${spec.nonce}`, spec.prompt, spec.wt);
    bumpMtimeAfterPrepare(transcript, spec.ws);
  }

  const recWave0 = sb.runScript("dispatch.mjs", ["record", "--config", w.configPath, "--plan", "PL-0001", "--json"]);
  assert.equal(recWave0.status, 0, recWave0.stderr + recWave0.stdout);

  const handoffsAfterWave0 = sb.git(w.records, "show", "HEAD:metrics/handoffs.jsonl")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .map(h => h.id);
  assert.ok(handoffsAfterWave0.includes("R-0002-critic-a"), `missing R-0002-critic-a in ${handoffsAfterWave0}`);
  assert.ok(handoffsAfterWave0.includes("R-0002-critic-b"), `missing R-0002-critic-b in ${handoffsAfterWave0}`);

  const prepWave1 = sb.runScript("self-loop.mjs", ["dispatch", "prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"]);
  assert.equal(prepWave1.status, 0, prepWave1.stderr + prepWave1.stdout);
  const wave1Specs = extractPreparedItems(JSON.parse(prepWave1.stdout));
  assert.equal(wave1Specs.length, 2, `expected 2 Wave-1 prepared specs, got: ${prepWave1.stdout}`);

  for (const [pkgId, hId, srcFile] of [
    ["actor-a", "R-0002-actor-a", "src/a.js"],
    ["actor-b", "R-0002-actor-b", "src/b.js"],
  ]) {
    const taskFile = join(w.workDir, "tasks", `${hId}.md`);
    assert.equal(existsSync(taskFile), true, `missing materialized task ${taskFile}`);
    const spec = wave1Specs.find(s => (s.handoff ?? s.id) === hId || s.id === pkgId);
    assert.ok(spec, `missing spec for ${hId}`);
    assert.match(spec.nonce, /^[0-9a-f]{16}$/);
    assert.ok(spec.target && spec.target.provider === "claude", `expected claude target: ${JSON.stringify(spec.target)}`);

    sb.put(spec.wt, srcFile, `export const ${pkgId.slice(-1)} = 42;\n`);
    sb.put(spec.ws, "out/report.md", `# ${hId} report\n\nImplemented ${srcFile}.\n`);
    const transcript = writeClaudeTranscript(sb.claudeHome, `sess-${hId}-${spec.nonce}`, spec.prompt, spec.wt);
    bumpMtimeAfterPrepare(transcript, spec.ws);
  }

  const recWave1 = sb.runScript("self-loop.mjs", ["dispatch", "record", "--config", w.configPath, "--plan", "PL-0001", "--json"]);
  assert.equal(recWave1.status, 0, recWave1.stderr + recWave1.stdout);

  const handoffsAfterWave1 = sb.git(w.records, "show", "HEAD:metrics/handoffs.jsonl")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l));
  const actorA = handoffsAfterWave1.find(h => h.id === "R-0002-actor-a");
  const actorB = handoffsAfterWave1.find(h => h.id === "R-0002-actor-b");
  assert.ok(actorA && actorA.product?.commit !== actorA.product?.base, "actor-a commit must be recorded");
  assert.ok(actorB && actorB.product?.commit !== actorB.product?.base, "actor-b commit must be recorded");
});
