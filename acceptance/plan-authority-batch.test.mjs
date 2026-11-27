// D-0060, D-0063, design/mandatory-control-plane.md#4, design/parallel-dispatch.md#1
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadPlan, parsePlan, readyPlan, snapshot, validatePlan } from "../scripts/lib/plan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(here, "..", "scripts");
const BRIEFS = { shared: "engines/shared.md", critic: "engines/critic.md", actor: "engines/actor.md", judge: "engines/judge.md", reviewer: "engines/frame-reviewer.md" };

function makeSandbox(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sl-plan-auth-batch-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [home, ownerStore, loadDir, claudeHome, codexHome, geminiHome, agHome] = ["home", "owner-store", "load", "claude-home", "codex-home", "gemini-home", "ag-home"].map(n => join(root, n));
  for (const d of [home, ownerStore, loadDir, claudeHome, codexHome, geminiHome, agHome]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, SELF_LOOP_TEST: "1", SELF_LOOP_OWNER_STORE: ownerStore, SELF_LOOP_LOAD_DIR: loadDir, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, GEMINI_HOME: geminiHome, ANTIGRAVITY_HOME: "", ANTIGRAVITY_APP_DATA_DIR: "", ANTIGRAVITY_LS_VERSION: "", T3CODE_HOME: "", T3CODE_THREAD_ID: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Critic Test", GIT_AUTHOR_EMAIL: "critic@example.invalid", GIT_COMMITTER_NAME: "Critic Test", GIT_COMMITTER_EMAIL: "critic@example.invalid" };
  delete env.SELF_LOOP_CONFIG;
  const git = (repoDir, ...args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env }).trim();
  const put = (baseDir, rel, content) => { const abs = join(baseDir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); return abs; };
  const repo = (dir, files, msg = "init") => { mkdirSync(dir, { recursive: true }); git(dir, "init", "-q", "-b", "main"); for (const [rel, text] of Object.entries(files)) put(dir, rel, text); git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); return dir; };
  repo(ownerStore, { "README.md": "# Owner store\n", "products.json": "{\"products\":[],\"roots\":[],\"maxLoadRatio\":1000000000,\"minAvailableMemoryGB\":0}\n" });
  const runScript = (script, args, { cwd = root, extraEnv = {} } = {}) => spawnSync(process.execPath, [join(scriptsDir, script), ...args], { cwd, encoding: "utf8", env: { ...env, ...extraEnv }, maxBuffer: 16 * 1024 * 1024 });
  return { root, env, claudeHome, codexHome, geminiHome, agHome, git, put, repo, runScript };
}

function makeWorld(sb, { agents = null, owns = null } = {}) {
  const product = join(sb.root, "product"), records = join(sb.root, "records"), workDir = join(sb.root, "work");
  mkdirSync(workDir, { recursive: true });
  sb.repo(product, { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n", "test/a.test.js": "export const ta = 1;\n", "test/b.test.js": "export const tb = 1;\n", "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('seed', () => {});\n", "docs/PURPOSE.md": "# Purpose\n\nDeterministic control plane.\n", "README.md": "# Product\n" });
  sb.git(product, "branch", "loop/s5");
  const defaultAgents = agents ?? { critic: { runner: "t3", provider: "codex", model: "m" }, actor: { runner: "t3", provider: "claude", model: "m" }, judge: { runner: "t3", provider: "codex", model: "m" }, reviewer: { runner: "t3", provider: "claude", model: "m" } };
  const cfg = { product, branch: "loop/s5", records, workDir, phase: "S5", briefs: BRIEFS, sealed: [], purpose: ["docs/PURPOSE.md"], owns: owns ?? { critic: ["test", "acceptance"], actor: ["src"] }, protected: ["main"], agents: defaultAgents, commitPrefix: "loop(s5)" };
  const handoffs = [
    { id: "R-0001-reviewer-frame", time: "2026-11-24T08:00:00Z", phase: "S5", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] },
    { id: "R-0001-judge-frame", time: "2026-11-24T08:05:00Z", phase: "S5", round: 1, step: "judge-frame", role: "judge", attempt: 1, agent: { runner: "codex", model: "gpt-test" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-judge-frame.md", files: ["rounds/0001-judge-frame.md"] },
  ];
  sb.repo(records, {
    "README.md": "# Loop records\n", "records.json": "{\"extraKinds\":[]}\n", "loop.json": JSON.stringify(cfg, null, 2) + "\n",
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief text.\n`])),
    "purpose/P-0001.md": "# P-0001 Deterministic control plane\n\nstatus: active\n",
    "blueprint/F-0001.md": "# F-0001 Control plane feature\n\nid: F-0001\nphase: S5\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": JSON.stringify({ feature: "F-0001", phase: "S5", status: "building", time: "2026-11-24T08:00:00Z", by: "lead", note: "active", evidence: {} }) + "\n",
    "design/spec.md": "# Spec\n\n## v1\n\nFrozen contract.\n",
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nVERDICT: CONTINUE\n", "rounds/0001-judge-frame.md": "# R-0001-judge-frame\n\nVERDICT: CONVERGED\n",
    "metrics/handoffs.jsonl": handoffs.map(h => JSON.stringify(h)).join("\n") + "\n",
    "owner/B-0001.md": "# B-0001 Owner batch\n\nphase: S5\nfrom: R-0001-reviewer-frame\n\n### 1. Approve v1 control plane?\nOptions: Yes / No\nRecommendation: Yes\n",
    "owner/B-0002.md": "# B-0002 Owner batch\n\nphase: S5\nfrom: R-0001-reviewer-frame\n\n### 1. Unanswered question?\nOptions: A / B\nRecommendation: A\n",
    "owner/answers.jsonl": JSON.stringify({ batch: "B-0001", time: "2026-11-24T08:10:00Z", words: "as recommended", outcome: "as-recommended" }) + "\n",
    "decisions/D-0001.md": "# D-0001 Bare lead decision\n\nid: D-0001\nby: lead\ndate: 2026-11-24\nstatus: active\n\nSelf-authored without reviewer or owner batch.\n",
    "decisions/D-0002.md": "# D-0002 Owner-approved decision\n\nid: D-0002\nby: owner (B-0001 answer)\ndate: 2026-11-24\nstatus: active\nrelates: B-0001, R-0001-reviewer-frame\n",
    "decisions/D-0003.md": "# D-0003 Decision citing unanswered batch\n\nid: D-0003\nby: lead\ndate: 2026-11-24\nrelates: B-0002\nstatus: active\n",
    "decisions/D-0004.md": "# D-0004 Decision citing missing reviewer handoff\n\nid: D-0004\nby: lead\ndate: 2026-11-24\nrelates: R-0009-reviewer-frame\nstatus: active\n",
    "decisions/D-0005.md": "# D-0005 Reviewer-backed decision\n\nid: D-0005\nby: lead (from R-0001-reviewer-frame)\ndate: 2026-11-24\nrelates: R-0001-reviewer-frame\nstatus: active\n",
  }, "seed records");
  assert.equal(sb.runScript("records-check.mjs", ["--repo", records, "--write"]).status, 0);
  sb.git(records, "add", "-A"); sb.git(records, "commit", "-qm", "index");
  const commitRecords = msg => { sb.git(records, "add", "-A"); assert.equal(sb.runScript("records-check.mjs", ["--repo", records, "--write"]).status, 0); sb.git(records, "add", "-A"); sb.git(records, "commit", "-qm", msg); };
  return { product, records, workDir, configPath: join(records, "loop.json"), cfg, commitRecords };
}

const wordRow = (id, text, time = "2026-11-24T12:00:00Z") => ({ id, time, source: "antigravity", session: "ag-session-1", text, sha256: createHash("sha256").update(text).digest("hex") });
const pkg = (id, role, handoff, files, needs, reviews) => ({ id, role, handoff, authority: "D-0002", files, needs, ...(reviews ? { reviews } : {}) });
const planText = (id, packages, { scope = "S5/round-2", phase = "S5", supersedes = null } = {}) => [
  `# ${id} Plan`, `scope: ${scope}`, `phase: ${phase}`, ...(supersedes ? [`supersedes: ${supersedes}`] : []), "",
  ...packages.flatMap(p => [
    `## ${p.id}`, `role: ${p.role}`, `handoff: ${p.handoff}`,
    `authority: ${Array.isArray(p.authority) ? p.authority.join(", ") : p.authority}`,
    `goal: ${p.goal ?? `Deliver ${p.id}`}`, `files: ${Array.isArray(p.files) ? p.files.join(", ") : (p.files ?? "")}`,
    `interface: ${p.interface ?? "design/spec.md#v1"}`, `acceptance: ${p.acceptance ?? "acceptance passes"}`,
    `needs: ${Array.isArray(p.needs) ? p.needs.join(", ") : (p.needs ?? "")}`,
    ...(p.reviews !== undefined ? [`reviews: ${Array.isArray(p.reviews) ? p.reviews.join(", ") : p.reviews}`] : []), "",
  ]),
].join("\n");
const validTriadPackages = (authority = "D-0002") => [
  { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority, files: ["test/a.test.js"], needs: [], reviews: ["actor-a"] },
  { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority, files: ["src/a.js"], needs: ["critic-a"] },
  { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority, files: [], needs: ["critic-a", "actor-a"], reviews: ["critic-a", "actor-a"] },
];

function assertRefused(res, pattern, label) {
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  assert.notEqual(res.status, 0, `${label}: expected non-zero exit, got 0:\n${combined}`);
  assert.doesNotMatch(combined, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/, label);
  if (pattern) assert.match(combined, pattern, `${label}: expected ${pattern} in:\n${combined}`);
}

function writeTranscript(sb, role, sessionId, prompt, cwd) {
  const now = new Date(), pad = n => String(n).padStart(2, "0"), ts = now.toISOString();
  const file = role === "actor"
    ? join(sb.claudeHome, "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`)
    : join(sb.codexHome, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()), `rollout-${sessionId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const rows = role === "actor"
    ? [{ type: "user", cwd, timestamp: ts, sessionId, message: { role: "user", content: prompt } },
       { type: "assistant", cwd, timestamp: ts, message: { model: "claude-test", stop_reason: "end_turn", content: [] } }]
    : [{ timestamp: ts, type: "session_meta", payload: { cwd, id: sessionId } },
       { timestamp: ts, type: "turn_context", payload: { cwd, model: "gpt-test" } },
       { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
       { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } }];
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function bumpMtimeAfterPrepare(file, ws) {
  const sec = Math.ceil((JSON.parse(readFileSync(join(ws, "call.json"), "utf8")).preparedAt + 1000) / 1000);
  utimesSync(file, sec, sec);
}

const extractPreparedItems = parsed => (Array.isArray(parsed) ? parsed : (parsed.prepared ?? parsed.packages ?? parsed.items ?? []));
const handoffsIn = (sb, w) => sb.git(w.records, "show", "HEAD:metrics/handoffs.jsonl").split("\n").filter(Boolean).map(l => JSON.parse(l));
const jsonOut = (sb, script, args) => JSON.parse(sb.runScript(script, args).stdout);
const prepDispatch = (sb, w, plan = "PL-0001") => {
  const res = sb.runScript("dispatch.mjs", ["prepare", "--config", w.configPath, "--plan", plan, "--json"]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  return extractPreparedItems(JSON.parse(res.stdout));
};
const completeSpec = (sb, spec, { role, edits = {}, report = "Done.", configPath, useDispatch = true }) => {
  for (const [rel, body] of Object.entries(edits)) sb.put(spec.wt, rel, body);
  sb.put(spec.ws, "out/report.md", report);
  bumpMtimeAfterPrepare(writeTranscript(sb, role, `sess-${spec.nonce}`, spec.prompt, spec.wt), spec.ws);
  return useDispatch
    ? sb.runScript("dispatch.mjs", ["record", "--config", configPath, "--plan", "PL-0001", "--json"])
    : sb.runScript("call.mjs", [configPath, "record", "--ws", spec.ws]);
};
const commitPlan = (sb, w, id, pkgs, msg) => {
  sb.put(w.records, `plans/${id}.md`, planText(id, pkgs));
  for (const p of pkgs) sb.put(w.workDir, `tasks/${p.handoff}.md`, `features: F-0001\nDeliver ${p.handoff}\n`);
  w.commitRecords(msg);
};
const prepCall = (sb, w, role, step, pkgId, base) => JSON.parse(sb.runScript("call.mjs", [w.configPath, role, "--round", "2", "--step", step, "--plan", "PL-0001", "--package", pkgId, ...(base ? ["--base", base] : []), "--task", join(w.workDir, "tasks", `R-0002-${step}.md`), "--prepare"]).stdout);
function advanceBranch(sb, w, file, body, msg, detachFrom = null) {
  sb.git(w.product, "checkout", "-q", ...(detachFrom ? ["--detach", detachFrom] : ["loop/s5"]));
  sb.put(w.product, file, body);
  sb.git(w.product, "add", file);
  sb.git(w.product, "commit", "-qm", msg);
  const sha = sb.git(w.product, "rev-parse", "HEAD");
  sb.git(w.product, "checkout", "-q", "main");
  return sha;
}

test("PLB-01 fresh · flow: plan.mjs validate enforces 0-turn grace on substantive open owner words while ignoring routine acks · loss: false-verdict", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), planFile = sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", validTriadPackages("D-0002")));
  sb.put(w.records, "owner/words.jsonl", [wordRow("W-0000000001", "ok", "2026-11-24T11:50:00Z"), wordRow("W-0000000002", "继续", "2026-11-24T11:51:00Z")].map(r => JSON.stringify(r)).join("\n") + "\n");
  w.commitRecords("commit PL-0001 with routine acks only");
  assert.equal(sb.runScript("plan.mjs", ["validate", planFile, "--records", w.records]).status, 0);
  const substantiveId = "W-aaaa111122";
  sb.put(w.records, "owner/words.jsonl", [wordRow("W-0000000001", "ok", "2026-11-24T11:50:00Z"), wordRow("W-0000000002", "继续", "2026-11-24T11:51:00Z"), wordRow(substantiveId, "所有工作包必须先通过生成引擎授权再执行", "2026-11-24T12:00:00Z")].map(r => JSON.stringify(r)).join("\n") + "\n");
  w.commitRecords("capture substantive owner word 0 turns ago");
  assertRefused(sb.runScript("plan.mjs", ["validate", planFile, "--records", w.records]), new RegExp(substantiveId), "0-turn substantive owner word refusal");
  sb.put(w.records, "decisions/D-0006.md", `# D-0006 Require generation-engine authority before execution\n\nid: D-0006\nby: owner (B-0001 answer)\ndate: 2026-11-24\nwords: ${substantiveId}\nrelates: B-0001, R-0001-reviewer-frame\nstatus: active\n\nDistilled from ${substantiveId}.\n`);
  w.commitRecords("distill substantive owner word");
  assert.equal(sb.runScript("plan.mjs", ["validate", planFile, "--records", w.records]).status, 0);
});

test("PLB-02 fresh · flow: plan validation rejects bare by:lead, unanswered-batch, and missing-reviewer authorities while accepting owner-batch, reviewer, and judge authorities · loss: false-verdict", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), st = snapshot(w.records);
  const checkBoth = (id, authority) => { const content = planText(id, validTriadPackages(authority)), draftPath = join(sb.root, `${id}.md`); writeFileSync(draftPath, content); return { cli: sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]), fn: validatePlan(parsePlan(content), st) }; };
  for (const [id, auth, pat, label] of [["PL-0001", "D-0001", /D-0001|authority|reviewer|owner/i, "bare by:lead D-0001"], ["PL-0002", "D-0003", /D-0003|B-0002|authority|unanswered|reviewer/i, "unanswered batch D-0003"], ["PL-0003", "D-0004", /D-0004|R-0009-reviewer-frame|authority|reviewer/i, "missing reviewer D-0004"]]) {
    const res = checkBoth(id, auth); assertRefused(res.cli, pat, `${label} CLI`); assert.ok(res.fn.length > 0, `validatePlan must refuse ${label}`);
  }
  for (const [i, auth] of ["D-0002", "D-0005", "R-0001-reviewer-frame", "R-0001-judge-frame"].entries()) {
    const res = checkBoth(`PL-001${i}`, auth); assert.equal(res.cli.status, 0, `${auth} CLI`); assert.deepEqual(res.fn, [], auth);
  }
});

test("PLB-03 fresh · flow: non-window plans require critic coverage for every actor package and make judge optional · loss: false-verdict", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), st = snapshot(w.records);
  const checkBoth = (id, packages) => { const content = planText(id, packages), draftPath = join(sb.root, `${id}.md`); writeFileSync(draftPath, content); return { cli: sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]), fn: validatePlan(parsePlan(content), st) }; };
  const actorA = { id: "actor-a", role: "actor", handoff: "R-0002-actor-a", authority: "D-0002", files: ["src/a.js"], needs: [] }, actorB = { id: "actor-b", role: "actor", handoff: "R-0002-actor-b", authority: "D-0002", files: ["src/b.js"], needs: [] };
  for (const [id, pkgs, pat, label] of [["PL-0001", [actorA], /critic|cover/i, "actor alone"], ["PL-0003", [actorA, { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["actor-a"], reviews: ["actor-a"] }], /critic/i, "actor+judge without critic"], ["PL-0004", [{ id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], reviews: ["actor-a"] }, { ...actorA, needs: ["critic-a"] }, actorB, { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["critic-a", "actor-b"], reviews: ["critic-a", "actor-a", "actor-b"] }], /actor-b|critic|cover/i, "partial critic coverage"]]) {
    const res = checkBoth(id, pkgs); assertRefused(res.cli, pat, `${label} CLI`); assert.ok(res.fn.length > 0, label);
  }
  for (const [id, pkgs] of [["PL-0002", [{ id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], reviews: ["actor-a"] }, { ...actorA, needs: ["critic-a"] }]], ["PL-0005", [actorA, { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], needs: ["actor-a"], reviews: ["actor-a"] }]], ["PL-0010", validTriadPackages("D-0002")], ["PL-0011", [actorA, { id: "critic-a", role: "critic", handoff: "R-0002-critic-a", authority: "D-0002", files: ["test/a.test.js"], needs: ["actor-a"] }, { id: "judge-a", role: "judge", handoff: "R-0002-judge", authority: "D-0002", files: [], needs: ["critic-a"] }]]]) {
    const ok = checkBoth(id, pkgs); assert.equal(ok.cli.status, 0); assert.deepEqual(ok.fn, []);
  }
});

test("PLB-04 fresh · flow: plan.mjs ready ignores legacy unplanned workspace owns-prefix fallback while preserving planned writer holds · loss: stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), sha = sb.git(w.product, "rev-parse", "loop/s5");
  const criticDone = { id: "R-0002-critic-a", time: "2026-11-24T09:00:00Z", phase: "S5", round: 2, step: "critic-a", role: "critic", attempt: 1, agent: { runner: "codex", model: "gpt-test" }, view: "a".repeat(40), product: { base: sha, commit: sha }, audit: { violations: 0 }, record: "rounds/0002-critic-a.md", files: ["rounds/0002-critic-a.md"], dispatch: { plan: "PL-0001", package: "critic-a", files: ["test/a.test.js"] } };
  sb.put(w.records, "rounds/0002-critic-a.md", "# R-0002-critic-a\n");
  sb.put(w.records, "metrics/handoffs.jsonl", readFileSync(join(w.records, "metrics/handoffs.jsonl"), "utf8") + JSON.stringify(criticDone) + "\n");
  sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", validTriadPackages("D-0002")));
  for (const id of ["R-0002-actor-a", "R-0002-judge"]) sb.put(w.workDir, `tasks/${id}.md`, `features: F-0001\nDeliver ${id}\n`);
  w.commitRecords("commit PL-0001 with critic-a done");
  const makeLiveWs = (name, callJson) => { const ws = join(w.workDir, name), wt = join(ws, "wt"); mkdirSync(ws, { recursive: true }); sb.git(w.product, "worktree", "add", "-q", "--detach", wt, "loop/s5"); sb.put(ws, "call.json", JSON.stringify({ ...callJson, ws, wt }, null, 2)); };
  makeLiveWs("0001-actor-legacy-unplanned", { version: 2, role: "actor", round: 1, step: "actor-legacy", id: "R-0001-actor-legacy", record: "rounds/0001-actor-legacy.md", phase: "S5", owns: ["src"], nonce: "1122334455667788" });
  const actorRow = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "actor-a");
  assert.ok(actorRow.status === "ready" && actorRow.holds.filter(h => h.kind === "writer").length === 0, JSON.stringify(actorRow));
  sb.put(w.records, "plans/PL-0000.md", planText("PL-0000", [pkg("critic-old", "critic", "R-0002-critic-old", ["test/a.test.js"], [], ["actor-old"]), pkg("actor-old", "actor", "R-0002-actor-old", ["src/a.js"], ["critic-old"]), pkg("judge-old", "judge", "R-0002-judge-old", [], ["critic-old", "actor-old"], ["critic-old", "actor-old"])]));
  sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", validTriadPackages("D-0002"), { supersedes: "PL-0000" }));
  w.commitRecords("add superseded PL-0000");
  makeLiveWs("0002-actor-old-planned", { version: 2, role: "actor", round: 2, step: "actor-old", id: "R-0002-actor-old", record: "rounds/0002-actor-old.md", phase: "S5", owns: ["src"], nonce: "8877665544332211", dispatch: { plan: "PL-0000", package: "actor-old", files: ["src/a.js"] } });
  const heldActor = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "actor-a");
  assert.ok(heldActor.status === "waiting" && heldActor.holds.some(h => h.kind === "writer" && h.target === "R-0002-actor-old"), JSON.stringify(heldActor));
});

test("PLB-05 fresh · flow: dispatch.mjs prepare|record and self-loop.mjs dispatch prepare|record batch-prepare tasks and record by nonce without --session · loss: stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb);
  sb.put(w.records, "plans/PL-0001.md", planText("PL-0001", [
    { ...pkg("critic-a", "critic", "R-0002-critic-a", ["test/a.test.js"], [], ["actor-a"]), acceptance: "test/a.test.js passes" },
    { ...pkg("critic-b", "critic", "R-0002-critic-b", ["test/b.test.js"], [], ["actor-b"]), acceptance: "test/b.test.js passes" },
    { ...pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], ["critic-a"]), acceptance: "test/a.test.js passes" },
    { ...pkg("actor-b", "actor", "R-0002-actor-b", ["src/b.js"], ["critic-b"]), acceptance: "test/b.test.js passes" },
    { ...pkg("judge-final", "judge", "R-0002-judge", [], ["actor-a", "actor-b"], ["critic-a", "critic-b", "actor-a", "actor-b"]), acceptance: "full suite passes" },
  ]));
  w.commitRecords("commit decoupled 2-critic + 2-actor + judge PL-0001");
  assert.equal(existsSync(join(w.workDir, "tasks", "R-0002-critic-a.md")), false);
  const wave0Specs = extractPreparedItems(jsonOut(sb, "dispatch.mjs", ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"]));
  assert.equal(wave0Specs.length, 2);
  for (const hId of ["R-0002-critic-a", "R-0002-critic-b"]) {
    const taskFile = join(w.workDir, "tasks", `${hId}.md`), spec = wave0Specs.find(s => (s.handoff ?? s.id) === hId || s.id === hId.replace("R-0002-", ""));
    assert.ok(existsSync(taskFile) && /^features:\s*F-\d{4}/m.test(readFileSync(taskFile, "utf8")) && spec && /^[0-9a-f]{16}$/.test(spec.nonce) && existsSync(join(spec.ws, "call.json")) && existsSync(spec.wt) && spec.prompt.includes(spec.nonce) && spec.target?.provider === "codex");
    const callJson = JSON.parse(readFileSync(join(spec.ws, "call.json"), "utf8"));
    assert.deepEqual([callJson.nonce, callJson.dispatch?.plan], [spec.nonce, "PL-0001"]);
    sb.put(spec.ws, "out/report.md", `# ${hId} report\n\nRed cases written.\n`);
    bumpMtimeAfterPrepare(writeTranscript(sb, "critic", `sess-${hId}-${spec.nonce}`, spec.prompt, spec.wt), spec.ws);
  }
  assert.equal(sb.runScript("dispatch.mjs", ["record", "--config", w.configPath, "--plan", "PL-0001", "--json"]).status, 0);
  const handoffs0 = handoffsIn(sb, w).map(h => h.id);
  assert.ok(handoffs0.includes("R-0002-critic-a") && handoffs0.includes("R-0002-critic-b"));
  const wave1Specs = extractPreparedItems(jsonOut(sb, "self-loop.mjs", ["dispatch", "prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"]));
  assert.equal(wave1Specs.length, 2);
  for (const [pkgId, hId, srcFile] of [["actor-a", "R-0002-actor-a", "src/a.js"], ["actor-b", "R-0002-actor-b", "src/b.js"]]) {
    const spec = wave1Specs.find(s => (s.handoff ?? s.id) === hId || s.id === pkgId);
    assert.ok(existsSync(join(w.workDir, "tasks", `${hId}.md`)) && spec && /^[0-9a-f]{16}$/.test(spec.nonce) && spec.target?.provider === "claude");
    sb.put(spec.wt, srcFile, `export const ${pkgId.slice(-1)} = 42;\n`);
    sb.put(spec.ws, "out/report.md", `# ${hId} report\n\nImplemented ${srcFile}.\n`);
    bumpMtimeAfterPrepare(writeTranscript(sb, "actor", `sess-${hId}-${spec.nonce}`, spec.prompt, spec.wt), spec.ws);
  }
  assert.equal(sb.runScript("self-loop.mjs", ["dispatch", "record", "--config", w.configPath, "--plan", "PL-0001", "--json"]).status, 0);
  for (const id of ["R-0002-actor-a", "R-0002-actor-b"]) assert.ok(handoffsIn(sb, w).find(row => row.id === id)?.product?.commit !== handoffsIn(sb, w).find(row => row.id === id)?.product?.base);
});

test("PLB-12 ordered · flow: self-loop.mjs init and call.mjs smoke with updated assets/brief-critic.md and assets/brief-judge.md deliver D-0063/D-0098 briefs cleanly · loss: stuck", t => {
  const sb = makeSandbox(t), product = join(sb.root, "init-product");
  sb.repo(product, { "src/a.js": "export const a = 1;\n", "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('seed', () => {});\n" });
  const initRes = sb.runScript("self-loop.mjs", ["init", "--product", product, "--json"], { cwd: product });
  assert.equal(initRes.status, 0, initRes.stderr + initRes.stdout);
  const info = JSON.parse(initRes.stdout), assetsDir = join(here, "..", "assets");
  for (const [role, file] of Object.entries({ shared: "brief-shared.md", critic: "brief-critic.md", actor: "brief-actor.md", judge: "brief-judge.md", reviewer: "brief-frame-reviewer.md" })) {
    sb.put(info.records, `engines/${file === "brief-frame-reviewer.md" ? "frame-reviewer.md" : `${role}.md`}`, readFileSync(join(assetsDir, file), "utf8"));
  }
  const cfg = JSON.parse(readFileSync(info.config, "utf8"));
  cfg.owns = { critic: ["acceptance"], actor: ["src"] };
  cfg.agents = { critic: { runner: "t3", provider: "codex", model: "m" }, actor: { runner: "t3", provider: "claude", model: "m" }, judge: { runner: "t3", provider: "codex", model: "m" }, reviewer: { runner: "t3", provider: "claude", model: "m" } };
  sb.put(info.records, "loop.json", JSON.stringify(cfg, null, 2) + "\n");
  sb.put(info.records, "decisions/D-0001.md", "# D-0001 Adopt sequential suites\n\nid: D-0001\nby: owner\ndate: 2026-11-26\nstatus: active\n");
  sb.put(info.records, "blueprint/F-0001.md", "# F-0001 Feature\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n");
  sb.put(info.records, "purpose/P-0001.md", "# P-0001 Purpose\n\nstatus: active\n");
  sb.put(info.records, "rounds/0001-reviewer-frame.md", "# R-0001-reviewer-frame\n\nVERDICT: CONTINUE\n");
  sb.put(info.records, "metrics/handoffs.jsonl", JSON.stringify({ id: "R-0001-reviewer-frame", time: "2026-11-26T08:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] }) + "\n");
  sb.put(info.records, "plans/PL-0001.md", planText("PL-0001", [pkg("critic-initial", "critic", "R-0002-critic-initial", ["acceptance/domain.test.mjs"], [], ["actor-fix"]), pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], ["critic-initial"]), pkg("critic-post", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["actor-fix"], ["actor-fix"]), pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post"], ["critic-initial", "actor-fix", "critic-post"])].map(p => ({ ...p, authority: "D-0001" })), { scope: "v1/round-2", phase: "v1" }));
  sb.git(info.records, "add", "-A");
  const chk = sb.runScript("records-check.mjs", ["--repo", info.records, "--write", "--json"]);
  assert.deepEqual([chk.status, JSON.parse(chk.stdout).failures], [0, []]);
  sb.git(info.records, "add", "-A"); sb.git(info.records, "commit", "-qm", "commit briefs and PL-0001");
  const cPrep = sb.runScript("call.mjs", [info.config, "critic", "--round", "2", "--step", "critic-initial", "--plan", "PL-0001", "--package", "critic-initial", "--task", sb.put(cfg.workDir, "tasks/R-0002-critic-initial.md", "features: F-0001\nRun critic.\n"), "--prepare"]);
  assert.equal(cPrep.status, 0, cPrep.stderr + cPrep.stdout);
  const cBrief = readFileSync(join(JSON.parse(cPrep.stdout).ws, "brief.md"), "utf8");
  assert.equal(cBrief.trimEnd(), readFileSync(join(assetsDir, "brief-critic.md"), "utf8").trimEnd());
  assert.match(cBrief, /D-0063, D-0098/);
  const jPrep = sb.runScript("call.mjs", [info.config, "judge", "--round", "2", "--step", "judge-frame", "--task", sb.put(cfg.workDir, "tasks/R-0002-judge-frame.md", "features: F-0001\nRule frame.\n"), "--prepare"]);
  assert.equal(jPrep.status, 0, jPrep.stderr + jPrep.stdout);
  const jBrief = readFileSync(join(JSON.parse(jPrep.stdout).ws, "brief.md"), "utf8");
  assert.equal(jBrief.trimEnd(), readFileSync(join(assetsDir, "brief-judge.md"), "utf8").trimEnd());
  assert.ok(/D-0098/.test(jBrief) && /MERGE.*RETIRE/.test(jBrief));
});

test("PLB-16 fresh · flow: pre-actor critic stays unpinned, post-actor critic pins 2-actor off-branch chain across ready/waves/dispatch-prepare, holds diverged actors, and refuses stale explicit bases · loss: wrong-result", t => {
  const sbA = makeSandbox(t), wA = makeWorld(sbA);
  commitPlan(sbA, wA, "PL-0001", [
    pkg("critic-init", "critic", "R-0002-critic-init", ["acceptance/domain.test.mjs"], [], ["actor-1", "actor-2"]),
    pkg("actor-1", "actor", "R-0002-actor-one", ["src/a.js"], ["critic-init"]),
    pkg("actor-2", "actor", "R-0002-actor-two", ["src/a.js"], ["actor-1"]),
    pkg("critic-post", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["actor-2"], ["actor-1", "actor-2"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post"], ["critic-init", "actor-1", "actor-2", "critic-post"]),
  ], "commit PL-0001 Flow A");
  const readyInit = jsonOut(sbA, "plan.mjs", ["ready", "--records", wA.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-init");
  assert.equal([readyInit.status, readyInit.command.includes("--base")].join(","), "ready,false");
  assert.equal(completeSpec(sbA, prepDispatch(sbA, wA)[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('init', () => {});\n" }, configPath: wA.configPath }).status, 0);
  const prep1 = extractPreparedItems(JSON.parse(sbA.runScript("self-loop.mjs", ["dispatch", "prepare", "--config", wA.configPath, "--plan", "PL-0001", "--json"]).stdout));
  assert.deepEqual(prep1.map(s => s.id), ["actor-1"]);
  const docSha = advanceBranch(sbA, wA, "README.md", "# Product\n\nDoc commit while actor is out.\n", "docs: advance loop/s5");
  assert.equal(completeSpec(sbA, prep1[0], { role: "actor", edits: { "src/a.js": "export const a = 21;\n" }, configPath: wA.configPath }).status, 0);
  const sha1 = handoffsIn(sbA, wA).find(h => h.id === "R-0002-actor-one").product.commit;
  assert.equal(completeSpec(sbA, prepCall(sbA, wA, "actor", "actor-two", "actor-2", sha1), { role: "actor", edits: { "src/a.js": "export const a = 42;\n" }, configPath: wA.configPath }).status, 0);
  const actorCommit = handoffsIn(sbA, wA).find(h => h.id === "R-0002-actor-two").product.commit;
  assert.notEqual(actorCommit, docSha);
  const readyA = jsonOut(sbA, "plan.mjs", ["ready", "--records", wA.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-post");
  assert.ok(readyA.status === "ready" && readyA.command?.includes(`--base ${actorCommit}`), readyA.command);
  const waveA = jsonOut(sbA, "dispatch.mjs", ["waves", "--records", wA.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-post");
  assert.ok(waveA.status === "ready" && waveA.dispatchCommand?.includes(`--base ${actorCommit}`), waveA.dispatchCommand);
  const criticTask = join(wA.workDir, "tasks", "R-0002-critic-post.md");
  for (const extra of [["--base", docSha], []]) {
    const stale = sbA.runScript("call.mjs", [wA.configPath, "critic", "--round", "2", "--step", "critic-post", "--plan", "PL-0001", "--package", "critic-post", ...extra, "--task", criticTask, "--prepare"]);
    assert.equal(stale.status, 7, stale.stdout + stale.stderr);
    assertRefused(stale, new RegExp(actorCommit.slice(0, 12)), "Flow C names missing actor commit");
  }
  const postSpecs = extractPreparedItems(JSON.parse(sbA.runScript("self-loop.mjs", ["dispatch", "prepare", "--config", wA.configPath, "--plan", "PL-0001", "--json"]).stdout));
  assert.deepEqual(postSpecs.map(s => s.id), ["critic-post"]);
  assert.equal(sbA.git(postSpecs[0].wt, "rev-parse", "HEAD"), actorCommit);
  assert.equal(readFileSync(join(postSpecs[0].wt, "src/a.js"), "utf8"), "export const a = 42;\n");

  const sbB = makeSandbox(t), wB = makeWorld(sbB);
  commitPlan(sbB, wB, "PL-0001", [
    pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], []), pkg("actor-b", "actor", "R-0002-actor-b", ["src/b.js"], []),
    pkg("critic-join", "critic", "R-0002-critic-join", ["acceptance/domain.test.mjs"], ["actor-a", "actor-b"], ["actor-a", "actor-b"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-join"], ["actor-a", "actor-b", "critic-join"]),
  ], "commit PL-0001 Flow B");
  const prepB = prepDispatch(sbB, wB);
  assert.equal(prepB.length, 2);
  for (const s of prepB) assert.equal(completeSpec(sbB, s, { role: "actor", edits: s.id === "actor-a" ? { "src/a.js": "export const a = 10;\n" } : { "src/b.js": "export const b = 20;\n" }, configPath: wB.configPath }).status, 0);
  const readyJoin = jsonOut(sbB, "plan.mjs", ["ready", "--records", wB.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-join");
  assert.ok(readyJoin.status === "waiting" && readyJoin.command === undefined && readyJoin.holds.some(h => /integrate/i.test(`${h.kind} ${h.target} ${h.release}`)), JSON.stringify(readyJoin));
  const wavesJoin = jsonOut(sbB, "dispatch.mjs", ["waves", "--records", wB.records, "--plan", "PL-0001", "--json"]);
  assert.deepEqual([wavesJoin.packages.find(p => p.id === "critic-join").status, wavesJoin.parallelBatch.critics.length, wavesJoin.needsIntegration], ["waiting", 0, true]);
  assert.deepEqual(extractPreparedItems(JSON.parse(sbB.runScript("dispatch.mjs", ["prepare", "--config", wB.configPath, "--plan", "PL-0001", "--json"]).stdout)), []);
  const intB = jsonOut(sbB, "dispatch.mjs", ["integrate", "--records", wB.records, "--plan", "PL-0001", "--apply", "--json"]);
  assert.equal(intB.ok, true);
  assert.ok(jsonOut(sbB, "plan.mjs", ["ready", "--records", wB.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-join").command?.includes(`--base ${intB.commit}`));
  const prepAfterInt = prepDispatch(sbB, wB);
  assert.deepEqual([prepAfterInt.map(s => s.id), sbB.git(prepAfterInt[0].wt, "rev-parse", "HEAD")], [["critic-join"], intB.commit]);
});

test("PLB-17 fresh · flow: criticCausalBase, G7, waves, and readyPlan enforce ancestry for no-change actor commits (commit === base) while admitting exact newer revision and exempting judge-frame/judge-comments · loss: wrong-result", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), olderSha = sb.git(w.product, "rev-parse", "loop/s5");
  const newerSha = advanceBranch(sb, w, "README.md", "# Product\n\nApproved base.\n", "advance loop/s5 to newerSha");
  commitPlan(sb, w, "PL-0001", [
    pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], []), pkg("critic-post", "critic", "R-0002-critic-post", [], ["actor-fix"], ["actor-fix"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post"], ["actor-fix", "critic-post"]),
  ], "commit PL-0001 no-change actor");
  assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "actor", report: "# R-0002-actor-fix\n\nAlready satisfied.\n", configPath: w.configPath }).status, 0);
  assert.ok(jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-post").command?.includes(`--base ${newerSha}`));
  assert.equal(sb.runScript("call.mjs", [w.configPath, "critic", "--round", "2", "--step", "critic-post", "--plan", "PL-0001", "--package", "critic-post", "--base", olderSha, "--task", join(w.workDir, "tasks", "R-0002-critic-post.md"), "--prepare"]).status, 7);
  assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "critic", report: "# R-0002-critic-post\n\nVerified on newerSha.\n", configPath: w.configPath }).status, 0);
  const hs = handoffsIn(sb, w), aH = hs.find(h => h.id === "R-0002-actor-fix"), cH = hs.find(h => h.id === "R-0002-critic-post");
  assert.deepEqual([aH.product.base, aH.product.commit, cH.product.base, cH.product.commit], [newerSha, newerSha, newerSha, newerSha]);
  const judgeTask = join(w.workDir, "tasks", "R-0002-judge.md");
  const staleJudge = sb.runScript("call.mjs", [w.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", olderSha, "--task", judgeTask, "--prepare"]);
  assertRefused(staleJudge, new RegExp(newerSha.slice(0, 12)), "names no-change actor commit");
  const wavesOlder = jsonOut(sb, "dispatch.mjs", ["waves", "--records", w.records, "--plan", "PL-0001", "--base", olderSha, "--json"]);
  assert.ok(wavesOlder.packages.find(p => p.id === "judge-final").status === "waiting" && wavesOlder.judgeBlockedReasons.some(r => r.includes(newerSha.slice(0, 12))));
  const readyOlder = readyPlan(snapshot(w.records), loadPlan(snapshot(w.records), "PL-0001"), { base: olderSha }).packages.find(p => p.id === "judge-final");
  assert.ok(readyOlder.status === "waiting" && readyOlder.holds.some(h => `${h.target} ${h.release}`.includes(newerSha.slice(0, 12))));
  const readyNewer = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final");
  assert.ok(readyNewer.status === "ready" && readyNewer.command?.includes(newerSha));
  const wavesNewer = jsonOut(sb, "dispatch.mjs", ["waves", "--records", w.records, "--plan", "PL-0001", "--base", newerSha, "--json"]);
  assert.deepEqual([wavesNewer.packages.find(p => p.id === "judge-final").status, wavesNewer.judgeBlockedReasons], ["ready", []]);
  assert.equal(sb.runScript("call.mjs", [w.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", newerSha, "--task", judgeTask, "--prepare"]).status, 0);
  for (const meta of ["judge-frame", "judge-comments"]) {
    assert.equal(sb.runScript("call.mjs", [w.configPath, "judge", "--round", "2", "--step", meta, "--base", olderSha, "--task", sb.put(w.workDir, `tasks/R-0002-${meta}.md`, `features: F-0001\nMeta ${meta}\n`), "--prepare"]).status, 0);
  }
});

test("PLB-18 fresh · flow: dispatch.mjs integrate --apply merges diverged no-change actor commit (commit === base) so critic-join unblocks instead of looping stuck · loss: stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), olderSha = sb.git(w.product, "rev-parse", "loop/s5");
  const newerSha = advanceBranch(sb, w, "README.md", "# Product\n\nApproved off-branch base.\n", "approved newer off-branch", olderSha);
  commitPlan(sb, w, "PL-0001", [
    pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], []), pkg("actor-b", "actor", "R-0002-actor-b", ["src/b.js"], []),
    pkg("critic-join", "critic", "R-0002-critic-join", ["acceptance/domain.test.mjs"], ["actor-a", "actor-b"], ["actor-a", "actor-b"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-join"], ["actor-a", "actor-b", "critic-join"]),
  ], "commit PL-0001 diverged no-change actor");
  assert.equal(completeSpec(sb, prepCall(sb, w, "actor", "actor-a", "actor-a", newerSha), { role: "actor", report: "# R-0002-actor-a\n\nAlready satisfied.\n", useDispatch: false, configPath: w.configPath }).status, 0);
  assert.equal(completeSpec(sb, prepCall(sb, w, "actor", "actor-b", "actor-b", olderSha), { role: "actor", edits: { "src/b.js": "export const b = 20;\n" }, useDispatch: false, configPath: w.configPath }).status, 0);
  const shaB = handoffsIn(sb, w).find(h => h.id === "R-0002-actor-b").product.commit;
  assert.equal(jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-join").status, "waiting");
  const intRes = jsonOut(sb, "dispatch.mjs", ["integrate", "--records", w.records, "--plan", "PL-0001", "--apply", "--json"]);
  assert.equal(intRes.ok, true);
  assert.doesNotThrow(() => sb.git(w.product, "merge-base", "--is-ancestor", newerSha, intRes.commit));
  assert.doesNotThrow(() => sb.git(w.product, "merge-base", "--is-ancestor", shaB, intRes.commit));
  assert.equal(jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-join").status, "ready");
  assert.deepEqual(prepDispatch(sb, w).map(s => s.id), ["critic-join"]);
});

test("PLB-19 ordered · flow: plan.mjs ready --json command executes verbatim via call.mjs --prepare for ready actor, pinned post-actor critic, and optional judge without G1 exit 7 · loss: stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb);
  commitPlan(sb, w, "PL-0001", [
    pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], []),
    pkg("critic-post", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["actor-a"], ["actor-a"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post"], ["actor-a", "critic-post"]),
  ], "commit PL-0001 PLB-19");
  const runCmd = row => {
    const res = spawnSync("/bin/sh", ["-c", row.command], { cwd: sb.root, encoding: "utf8", env: sb.env });
    assert.equal(res.status, 0, `${row.id} failed (${res.status}):\n${res.stdout}\n${res.stderr}`);
    return JSON.parse(res.stdout);
  };
  const rA = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "actor-a");
  assert.match(rA.command, /--plan PL-0001 --package actor-a\b/);
  const sA = runCmd(rA);
  assert.equal(completeSpec(sb, sA, { role: "actor", edits: { "src/a.js": "export const a = 11;\n" }, configPath: w.configPath, useDispatch: false }).status, 0);
  const shaA = handoffsIn(sb, w).find(h => h.id === "R-0002-actor-a").product.commit;
  const rC = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-post");
  assert.ok(rC.command.includes("--plan PL-0001 --package critic-post") && rC.command.includes(`--base ${shaA}`), rC.command);
  const sC = runCmd(rC);
  assert.equal(sb.git(sC.wt, "rev-parse", "HEAD"), shaA);
  assert.equal(completeSpec(sb, sC, { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('plb19', () => {});\n" }, configPath: w.configPath, useDispatch: false }).status, 0);
  const shaC = handoffsIn(sb, w).find(h => h.id === "R-0002-critic-post").product.commit;
  const rJ = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final");
  assert.ok(rJ.command.includes("--plan PL-0001 --package judge-final") && rJ.command.includes(`--base ${shaC}`), rJ.command);
  const sJ = runCmd(rJ), jCall = JSON.parse(readFileSync(join(sJ.ws, "call.json"), "utf8"));
  assert.deepEqual([jCall.role, jCall.dispatch?.package, sb.git(sJ.wt, "rev-parse", "HEAD")], ["judge", "judge-final", shaC]);
});

test("PLB-20 ordered · flow: optional judge whose explicit needs only name actor stays held while scheduled post-actor critic is pending, dispatch.mjs prepare launches critic with 0 errors, then judge unblocks cleanly · loss: wrong-result / stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb);
  commitPlan(sb, w, "PL-0001", [pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], []), pkg("critic-post", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["actor-a"], ["actor-a"]), pkg("judge-final", "judge", "R-0002-judge", [], ["actor-a"], ["actor-a", "critic-post"])], "commit PL-0001 PLB-20");
  assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "actor", edits: { "src/a.js": "export const a = 77;\n" }, configPath: w.configPath }).status, 0);
  const readyHold = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final");
  assert.ok(readyHold.status === "waiting" && readyHold.idle === false && readyHold.command === undefined && readyHold.holds.some(h => /critic-post/.test(`${h.target} ${h.release}`)));
  const wavesHold = jsonOut(sb, "dispatch.mjs", ["waves", "--records", w.records, "--plan", "PL-0001", "--json"]), wJudgeHold = wavesHold.packages.find(p => p.id === "judge-final");
  assert.ok(wJudgeHold.status === "waiting" && wJudgeHold.idle === false && wJudgeHold.dispatchCommand === undefined && wavesHold.judgeBlockedReasons.some(r => /critic/i.test(r)));
  const prepCritRes = jsonOut(sb, "dispatch.mjs", ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"]);
  assert.deepEqual([prepCritRes.errors ?? [], extractPreparedItems(prepCritRes).map(s => s.id)], [[], ["critic-post"]]);
  assert.equal(completeSpec(sb, extractPreparedItems(prepCritRes)[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('plb20', () => {});\n" }, configPath: w.configPath }).status, 0);
  const readyUnblocked = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final");
  assert.ok(readyUnblocked.status === "ready" && /--plan PL-0001 --package judge-final\b/.test(readyUnblocked.command));
  const prepJudgeRes = jsonOut(sb, "dispatch.mjs", ["prepare", "--config", w.configPath, "--plan", "PL-0001", "--json"]);
  assert.deepEqual([prepJudgeRes.errors ?? [], extractPreparedItems(prepJudgeRes).map(s => s.id)], [[], ["judge-final"]]);
});

test("PLB-21 fresh · flow: D-0064 T8 shrinking churn hotspot allows actor call.mjs and loop.mjs next while growing churned file blocks · loss: stuck / false-verdict", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), lines = n => Array.from({ length: n }, (_, i) => `export const a${i} = ${i};`).join("\n") + "\n";
  sb.git(w.product, "checkout", "-q", "loop/s5"); sb.put(w.product, "src/a.js", lines(15)); sb.git(w.product, "add", "src/a.js"); sb.git(w.product, "commit", "-qm", "seed 15");
  const baseSha = sb.git(w.product, "rev-parse", "HEAD");
  for (const n of [12, 10, 8]) { sb.put(w.product, "src/a.js", lines(n)); sb.git(w.product, "add", "src/a.js"); sb.git(w.product, "commit", "-qm", `shrink ${n}`); }
  const shrunkSha = sb.git(w.product, "rev-parse", "HEAD"); sb.git(w.product, "checkout", "-q", "main");
  const baseRows = handoffsIn(sb, w).map(h => h.id === "R-0001-reviewer-frame" || h.id === "R-0001-judge-frame" ? { ...h, product: { base: baseSha, commit: baseSha } } : h);
  sb.put(w.records, "rounds/0002-actor-seed.md", "# R-0002-actor-seed\n\nSeed 1.\n");
  sb.put(w.records, "rounds/0003-actor-seed.md", "# R-0003-actor-seed\n\nSeed 2.\n");
  sb.put(w.records, "metrics/handoffs.jsonl", [...baseRows,
    { id: "R-0002-actor-seed", time: "2026-11-24T09:00:00Z", phase: "S5", round: 2, step: "actor-seed", role: "actor", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: { base: baseSha, commit: baseSha }, audit: { violations: 0 }, record: "rounds/0002-actor-seed.md", files: ["rounds/0002-actor-seed.md"] },
    { id: "R-0003-actor-seed", time: "2026-11-24T09:10:00Z", phase: "S5", round: 3, step: "actor-seed", role: "actor", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: { base: baseSha, commit: shrunkSha }, audit: { violations: 0 }, record: "rounds/0003-actor-seed.md", files: ["rounds/0003-actor-seed.md"] },
  ].map(h => JSON.stringify(h)).join("\n") + "\n");
  commitPlan(sb, w, "PL-0001", [pkg("critic-a", "critic", "R-0004-critic-a", ["acceptance/domain.test.mjs"], [], ["actor-a"]), pkg("actor-a", "actor", "R-0004-actor-a", ["src/a.js"], [])], "commit churn plan");
  sb.put(w.workDir, "tasks/R-0004-actor-a.md", "features: F-0001\nEdit src/a.js\n");
  assert.equal(sb.runScript("call.mjs", [w.configPath, "actor", "--round", "4", "--step", "actor-a", "--plan", "PL-0001", "--package", "actor-a", "--base", shrunkSha, "--task", join(w.workDir, "tasks/R-0004-actor-a.md"), "--prepare"]).status, 0);
  assert.doesNotMatch(sb.runScript("loop.mjs", ["next", "--config", w.configPath]).stdout, /churn-hotspot/);
  sb.git(w.product, "checkout", "-q", "loop/s5"); sb.put(w.product, "src/a.js", lines(22)); sb.git(w.product, "add", "src/a.js"); sb.git(w.product, "commit", "-qm", "grow 22");
  const grownSha = sb.git(w.product, "rev-parse", "HEAD"); sb.git(w.product, "checkout", "-q", "main");
  assertRefused(sb.runScript("call.mjs", [w.configPath, "actor", "--round", "4", "--step", "actor-a", "--plan", "PL-0001", "--package", "actor-a", "--base", grownSha, "--task", join(w.workDir, "tasks/R-0004-actor-a.md"), "--prepare"]), /churn-hotspot/, "growing churn hotspot blocks actor");
  sb.put(w.records, "metrics/handoffs.jsonl", [...baseRows, { id: "R-0002-actor-seed", time: "2026-11-24T09:00:00Z", phase: "S5", round: 2, step: "actor-seed", role: "actor", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: { base: baseSha, commit: baseSha }, audit: { violations: 0 }, record: "rounds/0002-actor-seed.md", files: ["rounds/0002-actor-seed.md"] }, { id: "R-0003-actor-seed", time: "2026-11-24T09:10:00Z", phase: "S5", round: 3, step: "actor-seed", role: "actor", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: { base: baseSha, commit: grownSha }, audit: { violations: 0 }, record: "rounds/0003-actor-seed.md", files: ["rounds/0003-actor-seed.md"] }].map(h => JSON.stringify(h)).join("\n") + "\n");
  w.commitRecords("advance integration head to grownSha");
  assert.match(sb.runScript("loop.mjs", ["next", "--config", w.configPath]).stdout, /churn-hotspot/);
});

test("PLB-22 fresh · flow: D-0064 T9 call.mjs record skips out/tmp and nested .git when archiving out/ and auto-prunes finished wt/ · loss: disclosure / data", t => {
  const sb = makeSandbox(t), w = makeWorld(sb);
  commitPlan(sb, w, "PL-0001", validTriadPackages(), "commit PL-0001 T9");
  const criticSpec = prepDispatch(sb, w)[0];
  sb.put(criticSpec.wt, "test/a.test.js", "export const ta = 2;\n");
  sb.put(criticSpec.ws, "out/report.md", "# R-0002-critic-a\n\nVERDICT: CONTINUE\n");
  sb.put(criticSpec.ws, "out/artifact.txt", "keep-artifact\n");
  sb.put(criticSpec.ws, "out/tmp/scratch.txt", "drop-scratch\n");
  sb.put(criticSpec.ws, "out/sub/.git/HEAD", "ref: refs/heads/main\n");
  bumpMtimeAfterPrepare(writeTranscript(sb, "critic", `sess-${criticSpec.nonce}`, criticSpec.prompt, criticSpec.wt), criticSpec.ws);
  const recRes = sb.runScript("call.mjs", [w.configPath, "record", "--ws", criticSpec.ws]);
  assert.equal(recRes.status, 0, recRes.stderr + recRes.stdout);
  const handoff = JSON.parse(recRes.stdout);
  assert.ok(handoff.files.some(f => f.includes("artifact.txt")), JSON.stringify(handoff.files));
  assert.equal(handoff.files.some(f => f.includes("scratch.txt") || f.includes(".git")), false, JSON.stringify(handoff.files));
  assert.equal(existsSync(criticSpec.wt), false, "finished wt/ must be auto-pruned");
  assert.equal(sb.git(w.product, "worktree", "list").includes(criticSpec.wt), false);
});

test("PLB-23 fresh · flow: D-0068 hooks install/check/uninstall honors ANTIGRAVITY_HOME and self-loop.mjs init CLI configures harness, provider, adapter, role models, and independence · loss: stuck / false-verdict", t => {
  const sb = makeSandbox(t), agHome = sb.agHome, prod = join(sb.root, "cfg-prod");
  sb.repo(prod, { "src/a.js": "export const a = 1;\n" });
  const initPaseo = sb.runScript("self-loop.mjs", ["init", "--product", prod, "--harness", "paseo", "--provider", "better-paseo-antigravity", "--actor-model", "gemini-2.5-flash", "--critic-model", "gemini-2.5-pro", "--judge-model", "gemini-2.5-pro-exp", "--independence", "model", "--json"], { cwd: prod });
  assert.equal(initPaseo.status, 0, initPaseo.stderr + initPaseo.stdout);
  const cfgP = JSON.parse(readFileSync(JSON.parse(initPaseo.stdout).config, "utf8"));
  assert.deepEqual([cfgP.judgeIndependence, cfgP.agents.actor.runner, cfgP.agents.actor.provider, cfgP.agents.actor.model, cfgP.agents.critic.model, cfgP.agents.judge.model], ["model", "paseo", "better-paseo-antigravity", "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-pro-exp"]);

  const prod2 = join(sb.root, "cfg-prod-2");
  sb.repo(prod2, { "src/a.js": "export const a = 1;\n" });
  const initGen = sb.runScript("self-loop.mjs", ["init", "--product", prod2, "--harness", "t3", "--provider", "opencode", "--adapter", "generic", "--model", "openrouter/kimi-k2", "--independence", "session", "--json"], { cwd: prod2 });
  assert.equal(initGen.status, 0, initGen.stderr + initGen.stdout);
  const cfgG = JSON.parse(readFileSync(JSON.parse(initGen.stdout).config, "utf8"));
  assert.deepEqual([cfgG.judgeIndependence, cfgG.agents.actor.runner, cfgG.agents.actor.provider, cfgG.agents.actor.adapter, cfgG.agents.actor.model], ["session", "t3", "opencode", "generic", "openrouter/kimi-k2"]);

  const badCombo = sb.runScript("self-loop.mjs", ["init", "--product", prod2, "--harness", "t3", "--provider", "better-paseo-antigravity"], { cwd: prod2 });
  assert.notEqual(badCombo.status, 0);

  sb.put(agHome, "config/skills/self-loop/SKILL.md", "# Skill\n");
  const hEnv = { ANTIGRAVITY_HOME: agHome };
  assert.equal(sb.runScript("self-loop.mjs", ["hooks", "install", "--harness", "antigravity", "--scope", "global"], { cwd: prod, extraEnv: hEnv }).status, 0);
  const agHooks = join(agHome, "config/hooks.json"), gemHooks = join(sb.geminiHome, "config/hooks.json");
  assert.equal(existsSync(agHooks) && existsSync(gemHooks), true);
  assert.equal(sb.runScript("self-loop.mjs", ["hooks", "check", "--harness", "antigravity", "--scope", "global"], { cwd: prod, extraEnv: hEnv }).status, 0);
  sb.put(agHooks, "", JSON.stringify({ ...JSON.parse(readFileSync(agHooks, "utf8")), "self-loop": { broken: true } }));
  assert.notEqual(sb.runScript("self-loop.mjs", ["hooks", "check", "--harness", "antigravity", "--scope", "global"], { cwd: prod, extraEnv: hEnv }).status, 0);
  assert.equal(sb.runScript("self-loop.mjs", ["hooks", "uninstall", "--harness", "antigravity", "--scope", "global"], { cwd: prod, extraEnv: hEnv }).status, 0);
  assert.equal(existsSync(agHooks) || existsSync(gemHooks), false);
});
