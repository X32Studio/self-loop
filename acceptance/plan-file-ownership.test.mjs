// D-0060, D-0063, design/dispatch.md#file-ownership, design/parallel-dispatch.md#4
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parsePlan, snapshot, validatePlan } from "../scripts/lib/plan.mjs";

const scriptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const BRIEFS = {
  shared: "engines/shared.md", critic: "engines/critic.md", actor: "engines/actor.md",
  judge: "engines/judge.md", reviewer: "engines/frame-reviewer.md",
};
const sha256 = v => createHash("sha256").update(v).digest("hex");
const canonical = v => (v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`);

function makeSandbox(t) {
  const root = mkdtempSync(join(tmpdir(), "sl-plan-ownership-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [home, ownerStore, loadDir, claudeHome, codexHome, geminiHome] = ["home", "owner-store", "load", "claude-home", "codex-home", "gemini-home"].map(n => join(root, n));
  for (const d of [home, ownerStore, loadDir, claudeHome, codexHome, geminiHome]) mkdirSync(d, { recursive: true });
  const env = { ...process.env, HOME: home, SELF_LOOP_TEST: "1", SELF_LOOP_OWNER_STORE: ownerStore, SELF_LOOP_LOAD_DIR: loadDir, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome, GEMINI_HOME: geminiHome, ANTIGRAVITY_APP_DATA_DIR: "", T3CODE_HOME: "", T3CODE_THREAD_ID: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ALLOW_PROTOCOL: "file", GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Critic Test", GIT_AUTHOR_EMAIL: "critic@example.invalid", GIT_COMMITTER_NAME: "Critic Test", GIT_COMMITTER_EMAIL: "critic@example.invalid" };
  delete env.SELF_LOOP_CONFIG;
  const git = (repoDir, ...args) => execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", env }).trim();
  const put = (baseDir, rel, content) => { const abs = join(baseDir, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, content); return abs; };
  const commit = (dir, msg, at = null) => { git(dir, "add", "-A"); execFileSync("git", ["-C", dir, "commit", "-qm", msg], { encoding: "utf8", env: at ? { ...env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : env }); };
  const repo = (dir, files, msg = "init", at = null) => { mkdirSync(dir, { recursive: true }); git(dir, "init", "-q", "-b", "main"); for (const [rel, text] of Object.entries(files)) put(dir, rel, text); commit(dir, msg, at); return dir; };
  repo(ownerStore, { "README.md": "# Owner store\n", "products.json": JSON.stringify({ products: [], roots: [], maxLoadRatio: 1e9, minAvailableMemoryGB: 0 }, null, 2) + "\n" });
  const runScript = (script, args, { cwd = root, extraEnv = {} } = {}) => spawnSync(process.execPath, [join(scriptsDir, script), ...args], { cwd, encoding: "utf8", env: { ...env, ...extraEnv }, maxBuffer: 16 * 1024 * 1024 });
  return { root, env, claudeHome, codexHome, git, put, commit, repo, runScript };
}

function makeWorld(sb, { owns = { critic: ["test", "acceptance"], actor: ["src"] }, seedAt = "2026-11-24T08:00:00Z" } = {}) {
  const product = join(sb.root, "product"), records = join(sb.root, "records"), workDir = join(sb.root, "work");
  mkdirSync(workDir, { recursive: true });
  sb.repo(product, { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n", "test/a.test.js": "export const ta = 1;\n", "test/b.test.js": "export const tb = 1;\n", "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('seed', () => {});\n", "docs/PURPOSE.md": "# Purpose\n\nDeterministic control plane.\n" }, "init", seedAt);
  sb.git(product, "branch", "loop/s5");
  const cfg = { product, branch: "loop/s5", records, workDir, phase: "S5", briefs: BRIEFS, sealed: [], purpose: ["docs/PURPOSE.md"], owns, protected: ["main"], commitPrefix: "loop(s5)", gates: { require: [] }, agents: { critic: { runner: "t3", provider: "codex", model: "m" }, actor: { runner: "t3", provider: "claude", model: "m" }, judge: { runner: "t3", provider: "codex", model: "m" }, reviewer: { runner: "t3", provider: "claude", model: "m" } } };
  const handoffs = [{ id: "R-0001-reviewer-frame", time: "2026-11-24T08:00:00Z", phase: "S5", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: { runner: "claude", model: "claude-test" }, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] }];
  sb.repo(records, {
    "README.md": "# Loop records\n", "records.json": JSON.stringify({ extraKinds: [] }, null, 2) + "\n", "loop.json": JSON.stringify(cfg, null, 2) + "\n",
    ...Object.fromEntries(Object.values(BRIEFS).map(p => [p, `# ${p}\n\nBrief text.\n`])),
    "purpose/P-0001.md": "# P-0001 Deterministic control plane\n\nstatus: active\n", "blueprint/F-0001.md": "# F-0001 Control plane feature\n\nid: F-0001\nphase: S5\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": JSON.stringify({ feature: "F-0001", phase: "S5", status: "building", time: seedAt, by: "lead", note: "active", evidence: {} }) + "\n",
    "design/spec.md": "# Spec\n\n## v1\n\nFrozen contract.\n\n# M1\n\nMinimum verified release.\n",
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nVERDICT: CONTINUE\n", "metrics/handoffs.jsonl": handoffs.map(h => JSON.stringify(h)).join("\n") + "\n",
    "owner/B-0001.md": "# B-0001 Owner batch\n\nphase: S5\nfrom: R-0001-reviewer-frame\n\n### 1. Approve?\nOptions: Yes / No\nRecommendation: Yes\n",
    "owner/answers.jsonl": JSON.stringify({ batch: "B-0001", time: seedAt, words: "as recommended", outcome: "as-recommended" }) + "\n",
    "decisions/D-0002.md": "# D-0002 Owner-approved decision\n\nid: D-0002\nby: owner (B-0001 answer)\ndate: 2026-11-24\nstatus: active\nrelates: B-0001, R-0001-reviewer-frame\n\n# Authority\n\nscope-assess IndependentJudge judge request-scope\n",
  }, "seed records", seedAt);
  assert.equal(sb.runScript("records-check.mjs", ["--repo", records, "--write"]).status, 0);
  sb.commit(records, "index", seedAt);
  const commitRecords = (msg, at = null) => { sb.git(records, "add", "-A"); assert.equal(sb.runScript("records-check.mjs", ["--repo", records, "--write"]).status, 0); sb.commit(records, msg, at); };
  return { product, records, workDir, configPath: join(records, "loop.json"), cfg, commitRecords };
}

function planText(id, packages, { scope = "S5/round-2", phase = "S5", time = null } = {}) {
  return [
    `# ${id} Plan`, `scope: ${scope}`, `phase: ${phase}`, ...(time ? [`time: ${JSON.stringify(time)}`] : []), "",
    ...packages.flatMap(p => [
      `## ${p.id}`, `role: ${p.role}`, `handoff: ${p.handoff}`,
      `authority: ${Array.isArray(p.authority) ? p.authority.join(", ") : p.authority}`,
      `goal: ${p.goal ?? `Deliver ${p.id}`}`,
      `files: ${Array.isArray(p.files) ? p.files.join(", ") : (p.files ?? "")}`,
      `interface: ${p.interface ?? "design/spec.md#v1"}`, `acceptance: ${p.acceptance ?? "acceptance passes"}`,
      `needs: ${Array.isArray(p.needs) ? p.needs.join(", ") : (p.needs ?? "")}`,
      ...(p.reviews !== undefined ? [`reviews: ${Array.isArray(p.reviews) ? p.reviews.join(", ") : p.reviews}`] : []),
      "",
    ]),
  ].join("\n");
}

function assertRefused(res, pattern, label) {
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  assert.notEqual(res.status, 0, `${label}: expected non-zero exit, got 0:\n${combined}`);
  assert.doesNotMatch(combined, /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|SyntaxError/, label);
  if (pattern) assert.match(combined, pattern, `${label}: expected ${pattern} in:\n${combined}`);
}

function writeTranscript(sb, role, sessionId, prompt, cwd, startTs = new Date().toISOString(), endTs = startTs) {
  const now = new Date(), pad = n => String(n).padStart(2, "0");
  const file = role === "actor"
    ? join(sb.claudeHome, "projects", cwd.replace(/[/.]/g, "-"), `${sessionId}.jsonl`)
    : join(sb.codexHome, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()), `rollout-${sessionId}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  const rows = role === "actor"
    ? [{ type: "user", cwd, timestamp: startTs, sessionId, message: { role: "user", content: prompt } },
       { type: "assistant", cwd, timestamp: endTs, message: { model: "claude-test", stop_reason: "end_turn", content: [] } },
       { type: "result", cwd, timestamp: endTs, subtype: "success" }]
    : [{ timestamp: startTs, type: "session_meta", payload: { cwd, id: sessionId } },
       { timestamp: startTs, type: "turn_context", payload: { cwd, model: "gpt-test" } },
       { timestamp: startTs, type: "event_msg", payload: { type: "user_message", message: prompt } },
       { timestamp: endTs, type: "event_msg", payload: { type: "task_complete" } }];
  writeFileSync(file, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function completeSpec(sb, spec, { role, edits = {}, report = "Done.", pub = null, startTs, endTs, recordAt = null, useDispatch = true, plan = "PL-0001", configPath }) {
  for (const [rel, body] of Object.entries(edits)) sb.put(spec.wt, rel, body);
  sb.put(spec.ws, "out/report.md", report);
  if (pub) sb.put(spec.ws, "out/public.md", pub);
  const tr = writeTranscript(sb, role, `sess-${spec.nonce}`, spec.prompt, spec.wt, startTs, endTs);
  const sec = Math.ceil((JSON.parse(readFileSync(join(spec.ws, "call.json"), "utf8")).preparedAt + 1000) / 1000);
  utimesSync(tr, sec, sec);
  const extraEnv = recordAt ? { GIT_AUTHOR_DATE: recordAt, GIT_COMMITTER_DATE: recordAt } : {};
  return useDispatch
    ? sb.runScript("dispatch.mjs", ["record", "--config", configPath, "--plan", plan, "--json"], { extraEnv })
    : sb.runScript("call.mjs", [configPath, "record", "--ws", spec.ws], { extraEnv });
}

const prepDispatch = (sb, w, plan = "PL-0001") => {
  const res = sb.runScript("dispatch.mjs", ["prepare", "--config", w.configPath, "--plan", plan, "--json"]);
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const parsed = JSON.parse(res.stdout);
  return Array.isArray(parsed) ? parsed : (parsed.prepared ?? parsed.packages ?? parsed.items ?? []);
};

const commitPlan = (sb, w, id, pkgs, msg, at = null, time = null) => {
  sb.put(w.records, `plans/${id}.md`, planText(id, pkgs, { time }));
  for (const p of pkgs) sb.put(w.workDir, `tasks/${p.handoff}.md`, `features: F-0001\nDeliver ${p.handoff}\n`);
  w.commitRecords(msg, at);
};

const handoffsIn = (sb, w) => sb.git(w.records, "show", "HEAD:metrics/handoffs.jsonl").split("\n").filter(Boolean).map(l => JSON.parse(l));
const jsonOut = (sb, script, args) => JSON.parse(sb.runScript(script, args).stdout);
const pkg = (id, role, handoff, files, needs, reviews) => ({ id, role, handoff, authority: "D-0002", files, needs, ...(reviews ? { reviews } : {}) });
const recRef = (sb, records, path, rev = "HEAD") => ({ repository: records, commit: sb.git(records, "rev-parse", rev), path, sha256: sha256(execFileSync("git", ["-C", records, "show", `${rev}:${path}`])) });

test("PLB-06 fresh · flow: sequential transitive needs chain sharing one living acceptance file passes validate, gates ready/writer holds, and passes dispatch/call G5 without peer violation while refusing outside-package writes · loss: false-verdict / stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb);
  const seqPkgs = [
    pkg("critic-initial", "critic", "R-0002-critic-initial", ["acceptance/domain.test.mjs"], [], ["actor-fix"]),
    pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], ["critic-initial"]),
    pkg("critic-post-actor", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["actor-fix"], ["actor-fix"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post-actor"], ["critic-initial", "actor-fix", "critic-post-actor"]),
  ];
  const seqContent = planText("PL-0001", seqPkgs), draftPath = join(sb.root, "PL-0001.md");
  writeFileSync(draftPath, seqContent);
  assert.equal(sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]).status, 0);
  assert.deepEqual(validatePlan(parsePlan(seqContent), snapshot(w.records)), []);
  commitPlan(sb, w, "PL-0001", seqPkgs, "commit sequential shared-file PL-0001");

  const wave0 = prepDispatch(sb, w);
  assert.deepEqual(wave0.map(s => s.id), ["critic-initial"]);
  const postLive = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "critic-post-actor");
  assert.equal(postLive.status, "waiting");
  assert.ok(postLive.holds.some(h => h.kind === "package" && h.target === "actor-fix"));
  assert.ok(postLive.holds.some(h => h.kind === "writer" && h.target === "R-0002-critic-initial"));

  assert.equal(completeSpec(sb, wave0[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('red', () => {});\n" }, configPath: w.configPath }).status, 0);
  const ready1 = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]);
  assert.equal(ready1.packages.find(p => p.id === "actor-fix").status, "ready");
  assert.equal(ready1.packages.find(p => p.id === "critic-post-actor").status, "waiting");

  const wave1 = prepDispatch(sb, w);
  assert.deepEqual(wave1.map(s => s.id), ["actor-fix"]);
  assert.equal(completeSpec(sb, wave1[0], { role: "actor", edits: { "src/a.js": "export const a = 42;\n" }, configPath: w.configPath }).status, 0);

  const wave2 = prepDispatch(sb, w);
  assert.deepEqual(wave2.map(s => s.id), ["critic-post-actor"]);
  assert.equal(completeSpec(sb, wave2[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('consolidated', () => {});\n" }, configPath: w.configPath }).status, 0);

  const postH = handoffsIn(sb, w).find(h => h.id === "R-0002-critic-post");
  assert.ok(postH && postH.product?.commit !== postH.product?.base);
  assert.equal(jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final").status, "ready");

  const sbBad = makeSandbox(t), wBad = makeWorld(sbBad);
  commitPlan(sbBad, wBad, "PL-0001", seqPkgs, "commit PL-0001 for G5 cross-package check");
  const badPrep = prepDispatch(sbBad, wBad)[0];
  assertRefused(completeSpec(sbBad, badPrep, { role: "critic", edits: { "src/a.js": "export const a = 999;\n" }, useDispatch: false, configPath: wBad.configPath }), /cross-package write violation/, "ordered peer writing outside pkg.files into peer file");
});

test("PLB-07 fresh · flow: concurrent or unordered packages sharing overlapping files remain refused including across different wave depths · loss: data / false-verdict", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), st = snapshot(w.records);
  const checkRefused = (id, packages, label) => {
    const content = planText(id, packages), draftPath = join(sb.root, `${id}.md`);
    writeFileSync(draftPath, content);
    assertRefused(sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]), /share overlapping files/, `${label} CLI`);
    assert.ok(validatePlan(parsePlan(content), st).some(e => /share overlapping files/.test(e)), `${label} fn`);
  };
  for (const [id, packages, label] of [
    ["PL-0002", [
      pkg("critic-a", "critic", "R-0002-critic-a", ["acceptance/domain.test.mjs"], [], ["actor-a"]),
      pkg("critic-b", "critic", "R-0002-critic-b", ["acceptance/domain.test.mjs"], [], ["actor-b"]),
      pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], ["critic-a"]), pkg("actor-b", "actor", "R-0002-actor-b", ["src/b.js"], ["critic-b"]),
      pkg("judge-final", "judge", "R-0002-judge", [], ["actor-a", "actor-b"], ["critic-a", "critic-b", "actor-a", "actor-b"]),
    ], "same-wave unordered overlap"],
    ["PL-0003", [
      pkg("actor-a-prep", "actor", "R-0002-actor-aprep", ["src/a.js"], []), pkg("branch-a-1", "actor", "R-0002-actor-a", ["src/b.js"], ["actor-a-prep"]),
      pkg("branch-a-2", "critic", "R-0002-critic-a", ["acceptance/domain.test.mjs"], ["branch-a-1"], ["actor-a-prep", "branch-a-1"]),
      pkg("branch-b-0", "actor", "R-0002-actor-b", ["test/b.test.js"], []), pkg("branch-b-1", "critic", "R-0002-critic-b", ["acceptance/domain.test.mjs"], ["branch-b-0"], ["branch-b-0"]),
      pkg("judge-final", "judge", "R-0002-judge", [], ["branch-a-2", "branch-b-1"], ["actor-a-prep", "branch-a-1", "branch-a-2", "branch-b-0", "branch-b-1"]),
    ], "cross-depth wave-2 vs wave-1 unordered overlap"],
    ["PL-0004", [
      pkg("branch-a-1", "actor", "R-0002-actor-a", ["src/a.js"], []), pkg("branch-a-2", "critic", "R-0002-critic-a", ["acceptance/*.test.mjs"], ["branch-a-1"], ["branch-a-1"]),
      pkg("branch-b-1", "critic", "R-0002-critic-b", ["acceptance/domain.test.mjs"], [], ["branch-b-2"]), pkg("branch-b-2", "actor", "R-0002-actor-b", ["src/b.js"], ["branch-b-1"]),
      pkg("judge-final", "judge", "R-0002-judge", [], ["branch-a-2", "branch-b-2"], ["branch-a-1", "branch-a-2", "branch-b-1", "branch-b-2"]),
    ], "wave-1 vs wave-0 glob unordered overlap"],
  ]) checkRefused(id, packages, label);
});

test("PLB-08 fresh · flow: diamond DAG partial ordering refuses unordered middle branches sharing a living suite or overlapping globs while permitting ordered root-to-join shared files · loss: data / false-verdict", t => {
  const sb = makeSandbox(t), w = makeWorld(sb), st = snapshot(w.records);
  const check = (id, packages) => {
    const content = planText(id, packages), draftPath = join(sb.root, `${id}.md`);
    writeFileSync(draftPath, content);
    return { cli: sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]), fn: validatePlan(parsePlan(content), st) };
  };
  for (const [id, lf, rf] of [["PL-0001", ["acceptance/domain.test.mjs"], ["acceptance/domain.test.mjs"]], ["PL-0002", ["acceptance/*.test.mjs"], ["acceptance/domain.test.mjs"]]]) {
    const res = check(id, [
      pkg("root", "actor", "R-0002-actor-root", ["src/a.js"], []),
      pkg("left", "critic", "R-0002-critic-left", lf, ["root"], ["root"]),
      pkg("right", "critic", "R-0002-critic-right", rf, ["root"], ["root"]),
      pkg("join", "judge", "R-0002-judge", [], ["left", "right"], ["root", "left", "right"]),
    ]);
    assertRefused(res.cli, /left and right share overlapping files/, `${id} diamond unordered branches CLI`);
    assert.ok(res.fn.some(e => /left and right share overlapping files/.test(e)));
  }
  const ok = check("PL-0003", [
    pkg("root", "critic", "R-0002-critic-root", ["acceptance/domain.test.mjs"], [], ["left", "right"]),
    pkg("left", "actor", "R-0002-actor-left", ["src/a.js"], ["root"]),
    pkg("right", "actor", "R-0002-actor-right", ["src/b.js"], ["root"]),
    pkg("join", "critic", "R-0002-critic-join", ["acceptance/domain.test.mjs"], ["left", "right"], ["left", "right"]),
    pkg("judge", "judge", "R-0002-judge", [], ["join"], ["root", "left", "right", "join"]),
  ]);
  assert.equal(ok.cli.status, 0, ok.cli.stderr + ok.cli.stdout);
  assert.deepEqual(ok.fn, []);
});

test("PLB-09 fresh · flow: in-plan handoff-ID needs references validate before commit, gate ready/G2 holds, compute wave order, and cover pre-actor critics · loss: false-verdict / stuck", t => {
  const sb = makeSandbox(t), w = makeWorld(sb);
  const handoffNeeds = [
    pkg("critic-initial", "critic", "R-0002-critic-initial", ["acceptance/**"], []),
    pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], ["R-0002-critic-initial"]),
    pkg("critic-post-actor", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["R-0002-actor-fix"], ["actor-fix"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["R-0002-critic-post"], ["critic-initial", "actor-fix", "critic-post-actor"]),
  ];
  const content = planText("PL-0001", handoffNeeds), draftPath = join(sb.root, "PL-0001.md");
  writeFileSync(draftPath, content);
  assert.equal(sb.runScript("plan.mjs", ["validate", draftPath, "--records", w.records]).status, 0);
  assert.deepEqual(validatePlan(parsePlan(content), snapshot(w.records)), []);
  commitPlan(sb, w, "PL-0001", handoffNeeds, "commit handoff-ID needs PL-0001");

  const ready0 = jsonOut(sb, "plan.mjs", ["ready", "--records", w.records, "--plan", "PL-0001", "--json"]);
  assert.deepEqual(["critic-initial", "actor-fix", "critic-post-actor"].map(id => ready0.packages.find(p => p.id === id).status), ["ready", "waiting", "waiting"]);
  assertRefused(sb.runScript("call.mjs", [w.configPath, "actor", "--round", "2", "--step", "actor-fix", "--plan", "PL-0001", "--package", "actor-fix", "--task", join(w.workDir, "tasks", "R-0002-actor-fix.md"), "--prepare"]), /G2/i, "unmet handoff-ID needs G2 refusal");
  assert.deepEqual(prepDispatch(sb, w).map(s => s.id), ["critic-initial"]);
});

test("PLB-10 fresh · flow: Gate G5 enforces path-level isolation across ordered superset and partial-overlap globs while allowing shared intersection writes · loss: false-verdict / wrong-result", t => {
  const runScenario = ({ criticInitFiles, criticPostFiles, initEditPath, postEdits, expectRefused = null, expectCommitted = null, expectOutside = [], label }) => {
    const sb = makeSandbox(t), w = makeWorld(sb);
    commitPlan(sb, w, "PL-0001", [
      pkg("critic-initial", "critic", "R-0002-critic-initial", criticInitFiles, [], ["actor-fix"]),
      pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], ["critic-initial"]),
      pkg("critic-post-actor", "critic", "R-0002-critic-post", criticPostFiles, ["actor-fix"], ["actor-fix"]),
      pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post-actor"], ["critic-initial", "actor-fix", "critic-post-actor"]),
    ], `commit ${label}`);
    assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "critic", edits: { [initEditPath]: "import test from 'node:test';\ntest('init', () => {});\n" }, configPath: w.configPath }).status, 0);
    assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "actor", edits: { "src/a.js": "export const a = 42;\n" }, configPath: w.configPath }).status, 0);
    const rec2 = completeSpec(sb, prepDispatch(sb, w)[0], { role: "critic", edits: postEdits, useDispatch: !expectRefused, configPath: w.configPath });
    if (expectRefused) { assert.equal(rec2.status, 7, `${label}:\n${rec2.stdout}\n${rec2.stderr}`); return assertRefused(rec2, expectRefused, label); }
    assert.equal(rec2.status, 0, `${label}: ${rec2.stderr}\n${rec2.stdout}`);
    const postH = handoffsIn(sb, w).find(h => h.id === "R-0002-critic-post");
    assert.ok(postH && postH.product?.commit !== postH.product?.base);
    for (const [rel, body] of Object.entries(expectCommitted ?? {})) assert.equal(sb.git(w.product, "show", `${postH.product.commit}:${rel}`), body.trimEnd());
    for (const rel of expectOutside) assert.ok(postH.product.outside.includes(rel));
  };
  runScenario({ criticInitFiles: ["acceptance/**"], criticPostFiles: ["acceptance/domain.test.mjs"], initEditPath: "acceptance/domain.test.mjs", postEdits: { "acceptance/other.test.mjs": "import test from 'node:test';\ntest('escaped', () => {});\n" }, expectRefused: /cross-package write violation.*acceptance\/other\.test\.mjs/, label: "superset refuses outside" });
  runScenario({ criticInitFiles: ["acceptance/a-*.test.mjs"], criticPostFiles: ["acceptance/*-b.test.mjs"], initEditPath: "acceptance/a-b.test.mjs", postEdits: { "acceptance/a-only.test.mjs": "import test from 'node:test';\ntest('escaped', () => {});\n" }, expectRefused: /cross-package write violation.*acceptance\/a-only\.test\.mjs/, label: "partial-overlap refuses peer-only" });
  runScenario({ criticInitFiles: ["acceptance/**"], criticPostFiles: ["acceptance/domain.test.mjs"], initEditPath: "acceptance/domain.test.mjs", postEdits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('post', () => {});\n" }, expectCommitted: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('post', () => {});\n" }, label: "superset allows own subset" });
  runScenario({ criticInitFiles: ["acceptance/a-*.test.mjs"], criticPostFiles: ["acceptance/*-b.test.mjs"], initEditPath: "acceptance/a-b.test.mjs", postEdits: { "acceptance/a-b.test.mjs": "import test from 'node:test';\ntest('shared-intersection', () => {});\n", "acceptance/unowned.test.mjs": "import test from 'node:test';\ntest('unowned', () => {});\n" }, expectCommitted: { "acceptance/a-b.test.mjs": "import test from 'node:test';\ntest('shared-intersection', () => {});\n" }, expectOutside: ["acceptance/unowned.test.mjs"], label: "partial-overlap allows shared intersection" });
});

test("PLB-11 fresh · flow: dispatch.mjs integrate accepts sequential linear-ancestry actors editing src/a.js while refusing diverged sequential and unordered parallel actors · loss: data / wrong-result", t => {
  const seqPkgs = [
    pkg("a1", "actor", "R-0002-actor-one", ["src/a.js"], []), pkg("a2", "actor", "R-0002-actor-two", ["src/a.js"], ["a1"]),
    pkg("c1", "critic", "R-0002-critic-all", ["test/a.test.js"], ["a2"], ["a1", "a2"]), pkg("j1", "judge", "R-0002-judge", [], ["c1"], ["a1", "a2", "c1"]),
  ];
  const sb = makeSandbox(t), w = makeWorld(sb, { owns: { critic: ["test"], actor: ["src"] } });
  commitPlan(sb, w, "PL-0001", seqPkgs, "commit sequential actors PL-0001");
  assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "actor", edits: { "src/a.js": "export const a = 2;\n" }, configPath: w.configPath }).status, 0);
  assert.equal(completeSpec(sb, prepDispatch(sb, w)[0], { role: "actor", edits: { "src/a.js": "export const a = 3;\n" }, configPath: w.configPath }).status, 0);
  const linearInt = sb.runScript("dispatch.mjs", ["integrate", "--records", w.records, "--plan", "PL-0001", "--dry-run", "--json"]);
  assert.equal(linearInt.status, 0, linearInt.stderr + linearInt.stdout);
  assert.deepEqual([JSON.parse(linearInt.stdout).ok, JSON.parse(linearInt.stdout).disjoint], [true, true]);

  const sbDiv = makeSandbox(t), wDiv = makeWorld(sbDiv, { owns: { critic: ["test"], actor: ["src"] } }), divBase = sbDiv.git(wDiv.product, "rev-parse", "loop/s5");
  commitPlan(sbDiv, wDiv, "PL-0001", seqPkgs, "commit diverged sequential PL-0001");
  for (const [step, pId, val] of [["actor-one", "a1", 10], ["actor-two", "a2", 20]]) {
    const p = JSON.parse(sbDiv.runScript("call.mjs", [wDiv.configPath, "actor", "--round", "2", "--step", step, "--plan", "PL-0001", "--package", pId, "--base", divBase, "--task", join(wDiv.workDir, "tasks", `R-0002-${step}.md`), "--prepare"]).stdout);
    assert.equal(completeSpec(sbDiv, p, { role: "actor", edits: { "src/a.js": `export const a = ${val};\n` }, useDispatch: false, configPath: wDiv.configPath }).status, 0);
  }
  const divInt = sbDiv.runScript("dispatch.mjs", ["integrate", "--records", wDiv.records, "--plan", "PL-0001", "--dry-run", "--json"]);
  assert.equal(divInt.status, 1);
  assert.deepEqual([JSON.parse(divInt.stdout).disjoint, JSON.parse(divInt.stdout).conflicts[0].files], [false, ["src/a.js"]]);

  const sbPar = makeSandbox(t), wPar = makeWorld(sbPar, { owns: { critic: ["test"], actor: ["src"] } }), parBase = sbPar.git(wPar.product, "rev-parse", "loop/s5");
  sbPar.put(wPar.records, "plans/PL-0010.md", planText("PL-0010", [pkg("a1", "actor", "R-0002-actor-one", ["src/a.js"], []), pkg("c1", "critic", "R-0002-critic-one", ["test/a.test.js"], ["a1"], ["a1"]), pkg("j1", "judge", "R-0002-judge-one", [], ["c1"])], { scope: "S5/par-a" }));
  sbPar.put(wPar.records, "plans/PL-0011.md", planText("PL-0011", [pkg("a2", "actor", "R-0002-actor-two", ["src/a.js"], []), pkg("c2", "critic", "R-0002-critic-two", ["test/b.test.js"], ["a2"], ["a2"]), pkg("j2", "judge", "R-0002-judge-two", [], ["c2"])], { scope: "S5/par-b" }));
  commitPlan(sbPar, wPar, "PL-0001", [pkg("a1", "actor", "R-0002-actor-one", ["src/a.js"], []), pkg("a2", "actor", "R-0002-actor-two", ["src/b.js"], []), pkg("c", "critic", "R-0002-critic-join", ["test/a.test.js"], ["a1", "a2"], ["a1", "a2"]), pkg("j", "judge", "R-0002-judge-join", [], ["c"])], "commit parallel actors");
  for (const [pl, pId, step, val] of [["PL-0010", "a1", "actor-one", 100], ["PL-0011", "a2", "actor-two", 200]]) {
    const u = JSON.parse(sbPar.runScript("call.mjs", [wPar.configPath, "actor", "--round", "2", "--step", step, "--plan", pl, "--package", pId, "--base", parBase, "--task", join(wPar.workDir, "tasks", `R-0002-${step}.md`), "--prepare"]).stdout);
    assert.equal(completeSpec(sbPar, u, { role: "actor", edits: { "src/a.js": `export const a = ${val};\n` }, useDispatch: false, configPath: wPar.configPath }).status, 0);
  }
  const parInt = sbPar.runScript("dispatch.mjs", ["integrate", "--records", wPar.records, "--plan", "PL-0001", "--dry-run", "--json"]);
  assert.equal(parInt.status, 1);
  assert.deepEqual([JSON.parse(parInt.stdout).disjoint, JSON.parse(parInt.stdout).conflicts[0].files], [false, ["src/a.js"]]);
});

test("PLB-13 fresh · flow: plan.mjs measure --json produces identical criticalPath, diamond idleDispatchable, and plan-time/v2 forecast whether needs/releasePackages use package IDs or same-plan handoff IDs · loss: wrong-result", t => {
  const runTimed = (mode, diamond = false) => {
    const sb = makeSandbox(t), w = makeWorld(sb), dep = (p, h) => (mode === "handoff" ? h : p);
    const authRef = recRef(sb, w.records, "decisions/D-0002.md"), critRef = recRef(sb, w.records, "design/spec.md");
    const time = { schema: "plan-time/v2", rootPlan: "PL-0001", baseline: { previousRoot: null, startedAt: "2026-11-24T08:00:00Z", startRefs: [authRef], deadline: { at: "2026-11-24T12:00:00Z", authorityRefs: [authRef] }, minimum: { outcome: "done", criteriaRefs: [critRef], authorityRefs: [authRef] }, promises: [] } };
    const pkgs = diamond ? [
      pkg("critic-init", "critic", "R-0002-critic-init", ["acceptance/domain.test.mjs"], [], ["actor-a", "actor-b"]),
      pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], ["critic-init"]),
      pkg("actor-b", "actor", "R-0002-actor-b", ["src/b.js"], [dep("critic-init", "R-0002-critic-init")]),
      pkg("judge-final", "judge", "R-0002-judge", [], ["actor-a", dep("actor-b", "R-0002-actor-b")], ["critic-init", "actor-a", "actor-b"]),
    ] : [
      pkg("critic-init", "critic", "R-0002-critic-init", ["acceptance/domain.test.mjs"], [], ["actor-fix"]),
      pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], [dep("critic-init", "R-0002-critic-init")]),
      pkg("critic-post", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], [dep("actor-fix", "R-0002-actor-fix")], ["actor-fix"]),
      pkg("judge-final", "judge", "R-0002-judge", [], [dep("critic-post", "R-0002-critic-post")], ["critic-init", "actor-fix", "critic-post"]),
    ];
    commitPlan(sb, w, "PL-0001", pkgs, `commit PL-0001 (${mode})`, "2026-11-24T09:00:00Z", time);
    const basedOn = sb.git(w.records, "rev-parse", "HEAD"), est = (lo, hi) => ({ asOf: "2026-11-24T09:00:00Z", remaining: { lowSeconds: lo, highSeconds: hi }, availableAfter: { lowSeconds: 0, highSeconds: 0 }, basisRefs: [authRef], assumptions: ["cap"], unknowns: [] });
    const estIds = diamond ? { "critic-init": est(5, 5), "actor-a": est(4, 4), "actor-b": est(10, 10), "judge-final": est(11, 11) } : { "critic-init": est(5, 5), "actor-fix": est(10, 10), "critic-post": est(6, 6), "judge-final": est(11, 11) };
    const fo = { schema: "plan-forecast/v1", rootRef: recRef(sb, w.records, "plans/PL-0001.md", basedOn), planRef: recRef(sb, w.records, "plans/PL-0001.md", basedOn), parents: [], outlook: { asOf: "2026-11-24T09:00:00Z", observation: { observedAt: "2026-11-24T09:00:00Z", recordedAt: "2026-11-24T09:00:00Z", evidenceRefs: [authRef] }, basedOn, inputs: [authRef], releasePackages: [dep("judge-final", "R-0002-judge")], reserve: { remaining: { lowSeconds: 1, highSeconds: 2 }, covers: ["review"], basisRefs: [authRef], assumptions: [] }, checkpointAt: "2026-11-24T10:00:00Z", change: { reason: "init", authorityRefs: [authRef], deferredPackages: [] }, outcome: { state: "active", evidenceRefs: [], deliveredAt: null } }, estimates: estIds, promisesAdded: [] };
    const foBytes = JSON.stringify(fo);
    sb.put(w.records, `forecasts/FO-${sha256(foBytes)}.json`, foBytes);
    w.commitRecords("forecast", "2026-11-24T09:00:05Z");
    const steps = diamond ? [
      [["critic", "critic-init", { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('init', () => {});\n" }, null, "2026-11-24T09:00:10Z", "2026-11-24T09:00:15Z", "2026-11-24T09:00:20Z"]],
      [["actor", "actor-a", { "src/a.js": "export const a = 2;\n" }, null, "2026-11-24T09:00:25Z", "2026-11-24T09:00:29Z", "2026-11-24T09:00:32Z"], ["actor", "actor-b", { "src/b.js": "export const b = 3;\n" }, null, "2026-11-24T09:00:30Z", "2026-11-24T09:00:40Z", "2026-11-24T09:00:45Z"]],
      [["judge", "judge-final", {}, "VERDICT: CONVERGED\n", "2026-11-24T09:00:55Z", "2026-11-24T09:01:06Z", "2026-11-24T09:01:10Z"]],
    ] : [
      [["critic", "critic-init", { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('init', () => {});\n" }, null, "2026-11-24T09:00:10Z", "2026-11-24T09:00:15Z", "2026-11-24T09:00:20Z"]],
      [["actor", "actor-fix", { "src/a.js": "export const a = 42;\n" }, null, "2026-11-24T09:00:30Z", "2026-11-24T09:00:40Z", "2026-11-24T09:00:45Z"]],
      [["critic", "critic-post", { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('post', () => {});\n" }, null, "2026-11-24T09:00:50Z", "2026-11-24T09:00:56Z", "2026-11-24T09:01:00Z"]],
      [["judge", "judge-final", {}, "VERDICT: CONVERGED\n", "2026-11-24T09:01:10Z", "2026-11-24T09:01:21Z", "2026-11-24T09:01:25Z"]],
    ];
    for (const wave of steps) {
      const specs = prepDispatch(sb, w);
      assert.equal(specs.length, wave.length);
      for (const [role, id, edits, pub, startTs, endTs, recordAt] of wave) {
        const spec = specs.find(s => s.id === id);
        assert.equal(completeSpec(sb, spec, { role, edits, report: pub ?? "Ok.", pub, startTs, endTs, recordAt, useDispatch: false, configPath: w.configPath }).status, 0);
      }
      if (wave.length > 1) assert.equal(sb.runScript("dispatch.mjs", ["integrate", "--records", w.records, "--plan", "PL-0001", "--apply"]).status, 0);
    }
    const res = sb.runScript("plan.mjs", ["measure", "--records", w.records, "--plan", "PL-0001", "--now", "2026-11-24T09:05:00Z", "--json"]);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    return JSON.parse(res.stdout);
  };
  const proj = m => m.idleDispatchable.intervals.map(({ package: pId, interval, dependencyAvailableWindowSeconds }) => ({ pId, interval, dependencyAvailableWindowSeconds }));
  for (const [diamond, secs, path, wins] of [[false, 32, ["critic-init", "actor-fix", "critic-post", "judge-final"], [10, 10, 5, 10]], [true, 26, ["critic-init", "actor-b", "judge-final"], [10, 5, 10, 10]]]) {
    const mPkg = runTimed("package", diamond), mHandoff = runTimed("handoff", diamond);
    assert.equal(mPkg.criticalPath.seconds, secs);
    assert.equal(mHandoff.criticalPath.seconds, secs, JSON.stringify(mHandoff.criticalPath));
    assert.deepEqual(mHandoff.criticalPath.path, path);
    assert.deepEqual(mHandoff.criticalPath.path, mPkg.criticalPath.path);
    assert.deepEqual(proj(mHandoff), proj(mPkg));
    assert.deepEqual(proj(mPkg).map(x => x.dependencyAvailableWindowSeconds), wins);
    assert.deepEqual([mHandoff.time.forecast.earliestAt, mHandoff.time.forecast.latestAt], [mPkg.time.forecast.earliestAt, mPkg.time.forecast.latestAt]);
    assert.deepEqual(mHandoff.time.forecast.unknowns, mPkg.time.forecast.unknowns);
    assert.deepEqual(mHandoff.time.forecast.conditionalOn, mPkg.time.forecast.conditionalOn);
  }
});

test("PLB-14 fresh · flow: G7, waves, ready, and integrate enforce writing and read-only post-actor critic lineage while exempting judge-frame and judge-comments · loss: wrong-result", t => {
  const sbA = makeSandbox(t), wA = makeWorld(sbA);
  commitPlan(sbA, wA, "PL-0001", [
    pkg("critic-init", "critic", "R-0002-critic-init", ["acceptance/domain.test.mjs"], [], ["actor-fix"]),
    pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], ["critic-init"]),
    pkg("critic-post", "critic", "R-0002-critic-post", ["acceptance/domain.test.mjs"], ["actor-fix"], ["actor-fix"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post"], ["critic-init", "actor-fix", "critic-post"]),
  ], "commit PL-0001 part A");
  assert.equal(completeSpec(sbA, prepDispatch(sbA, wA)[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('red', () => {});\n" }, configPath: wA.configPath }).status, 0);
  assert.equal(completeSpec(sbA, prepDispatch(sbA, wA)[0], { role: "actor", edits: { "src/a.js": "export const a = 42;\n" }, configPath: wA.configPath }).status, 0);
  assert.equal(completeSpec(sbA, prepDispatch(sbA, wA)[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('post', () => {});\n" }, configPath: wA.configPath }).status, 0);
  const hsA = handoffsIn(sbA, wA), actorCommitA = hsA.find(h => h.id === "R-0002-actor-fix").product.commit, criticPostCommit = hsA.find(h => h.id === "R-0002-critic-post").product.commit;
  assert.notEqual(criticPostCommit, actorCommitA);
  const judgeTaskA = join(wA.workDir, "tasks", "R-0002-judge.md");
  const staleJudge = sbA.runScript("call.mjs", [wA.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", actorCommitA, "--task", judgeTaskA, "--prepare"]);
  assert.equal(staleJudge.status, 7);
  assertRefused(staleJudge, new RegExp(criticPostCommit.slice(0, 12)), "Part A names required critic SHA");
  assertRefused(staleJudge, /--base|integrate|merge|ancestor|descend/i, "Part A repair path");
  const wavesStaleA = jsonOut(sbA, "dispatch.mjs", ["waves", "--records", wA.records, "--plan", "PL-0001", "--base", actorCommitA, "--json"]);
  assert.ok(wavesStaleA.judgeBlockedReasons.some(r => /critic-post|R-0002-critic-post/.test(r) && r.includes(criticPostCommit.slice(0, 12))));
  assert.equal(wavesStaleA.packages.find(p => p.id === "judge-final").status, "waiting");
  for (const meta of ["judge-frame", "judge-comments"]) {
    const mt = sbA.put(wA.workDir, `tasks/R-0002-${meta}.md`, `features: F-0001\nMeta ${meta}\n`);
    assert.equal(sbA.runScript("call.mjs", [wA.configPath, "judge", "--round", "2", "--step", meta, "--base", actorCommitA, "--task", mt, "--prepare"]).status, 0);
  }
  const readyOkA = jsonOut(sbA, "plan.mjs", ["ready", "--records", wA.records, "--plan", "PL-0001", "--json"]);
  assert.equal(readyOkA.packages.find(p => p.id === "judge-final").status, "ready");
  assert.ok(readyOkA.packages.find(p => p.id === "judge-final").command.includes(criticPostCommit));
  assert.deepEqual(jsonOut(sbA, "dispatch.mjs", ["waves", "--records", wA.records, "--plan", "PL-0001", "--json"]).judgeBlockedReasons, []);
  assert.equal(sbA.runScript("call.mjs", [wA.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", criticPostCommit, "--task", judgeTaskA, "--prepare"]).status, 0);

  const sbB = makeSandbox(t), wB = makeWorld(sbB), base0 = sbB.git(wB.product, "rev-parse", "loop/s5");
  commitPlan(sbB, wB, "PL-0001", [
    pkg("critic-init", "critic", "R-0002-critic-init", ["acceptance/domain.test.mjs"], [], ["actor-fix"]),
    pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], ["critic-init"]),
    pkg("critic-post", "critic", "R-0002-critic-post", [], ["actor-fix"], ["actor-fix"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-post"], ["critic-init", "actor-fix", "critic-post"]),
  ], "commit PL-0001 part B");
  assert.equal(completeSpec(sbB, prepDispatch(sbB, wB)[0], { role: "critic", edits: { "acceptance/domain.test.mjs": "import test from 'node:test';\ntest('red', () => {});\n" }, configPath: wB.configPath }).status, 0);
  assert.equal(completeSpec(sbB, prepDispatch(sbB, wB)[0], { role: "actor", edits: { "src/a.js": "export const a = 99;\n" }, configPath: wB.configPath }).status, 0);
  const actorCommitB = handoffsIn(sbB, wB).find(h => h.id === "R-0002-actor-fix").product.commit;
  sbB.put(wB.records, "rounds/0002-critic-post.md", "# R-0002-critic-post\n\nStale base.\n");
  sbB.put(wB.records, "metrics/handoffs.jsonl", readFileSync(join(wB.records, "metrics/handoffs.jsonl"), "utf8") + JSON.stringify({
    id: "R-0002-critic-post", time: "2026-11-24T09:10:00Z", phase: "S5", round: 2, step: "critic-post", role: "critic", attempt: 1,
    agent: { runner: "t3:codex", model: "gpt-test" }, view: sbB.git(wB.records, "rev-parse", "HEAD"), product: { base: base0, commit: base0 },
    audit: { violations: 0 }, record: "rounds/0002-critic-post.md", files: ["rounds/0002-critic-post.md"], dispatch: { plan: "PL-0001", package: "critic-post", files: [] },
  }) + "\n");
  wB.commitRecords("seed stale post-actor critic");
  assertRefused(sbB.runScript("call.mjs", [wB.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", actorCommitB, "--task", join(wB.workDir, "tasks", "R-0002-judge.md"), "--prepare"]), /critic-post|R-0002-critic-post/, "Part B names stale critic");
  const wavesB = jsonOut(sbB, "dispatch.mjs", ["waves", "--records", wB.records, "--plan", "PL-0001", "--json"]);
  assert.ok(wavesB.judgeBlockedReasons.some(r => /critic-post|R-0002-critic-post/.test(r)));
  assert.equal(wavesB.packages.find(p => p.id === "judge-final").status, "waiting");
  const judgeRowB = jsonOut(sbB, "plan.mjs", ["ready", "--records", wB.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final");
  assert.deepEqual([judgeRowB.status, judgeRowB.idle], ["waiting", false]);
  assert.ok(judgeRowB.holds.some(h => /critic-post|R-0002-critic-post/.test(`${h.target} ${h.release}`)));

  const sbC = makeSandbox(t), wC = makeWorld(sbC), baseC = sbC.git(wC.product, "rev-parse", "loop/s5");
  commitPlan(sbC, wC, "PL-0001", [
    pkg("actor-a", "actor", "R-0002-actor-a", ["src/a.js"], []), pkg("actor-b", "actor", "R-0002-actor-b", ["src/b.js"], []),
    pkg("critic-a", "critic", "R-0002-critic-a", ["test/a.test.js"], ["actor-a"], ["actor-a"]),
    pkg("critic-b", "critic", "R-0002-critic-b", ["test/b.test.js"], ["actor-b"], ["actor-b"]),
    pkg("judge-final", "judge", "R-0002-judge", [], ["critic-a", "critic-b"], ["actor-a", "actor-b", "critic-a", "critic-b"]),
  ], "commit PL-0001 part C");
  for (const s of prepDispatch(sbC, wC)) assert.equal(completeSpec(sbC, s, { role: "actor", edits: s.id === "actor-a" ? { "src/a.js": "export const a = 7;\n" } : { "src/b.js": "export const b = 8;\n" }, useDispatch: false, configPath: wC.configPath }).status, 0);
  const hsC1 = handoffsIn(sbC, wC);
  for (const [id, step, file] of [["critic-a", "critic-a", "test/a.test.js"], ["critic-b", "critic-b", "test/b.test.js"]]) {
    const aSha = hsC1.find(h => h.id === `R-0002-${id.replace("critic", "actor")}`).product.commit;
    const p = JSON.parse(sbC.runScript("call.mjs", [wC.configPath, "critic", "--round", "2", "--step", step, "--plan", "PL-0001", "--package", id, "--base", aSha, "--task", join(wC.workDir, "tasks", `R-0002-${step}.md`), "--prepare"]).stdout);
    assert.equal(completeSpec(sbC, p, { role: "critic", edits: { [file]: `export const t = '${id}';\n` }, useDispatch: false, configPath: wC.configPath }).status, 0);
  }
  assert.equal(sbC.runScript("call.mjs", [wC.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", baseC, "--task", join(wC.workDir, "tasks", "R-0002-judge.md"), "--prepare"]).status, 7);
  assert.equal(jsonOut(sbC, "dispatch.mjs", ["waves", "--records", wC.records, "--plan", "PL-0001", "--json"]).needsIntegration, true);
  assert.equal(jsonOut(sbC, "plan.mjs", ["ready", "--records", wC.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final").status, "waiting");
  const intC = jsonOut(sbC, "dispatch.mjs", ["integrate", "--records", wC.records, "--plan", "PL-0001", "--apply", "--json"]);
  assert.equal(intC.ok, true);
  assert.equal(intC.commits.length, 4);
  assert.equal(jsonOut(sbC, "plan.mjs", ["ready", "--records", wC.records, "--plan", "PL-0001", "--json"]).packages.find(p => p.id === "judge-final").status, "ready");
  assert.equal(sbC.runScript("call.mjs", [wC.configPath, "judge", "--round", "2", "--step", "judge", "--plan", "PL-0001", "--package", "judge-final", "--base", intC.commit, "--task", join(wC.workDir, "tasks", "R-0002-judge.md"), "--prepare"]).status, 0);
});

test("PLB-15 fresh · flow: plan.mjs measure --json preserves verified scope releaseEta when plan-time/v2 needs spell same-plan handoff IDs instead of package IDs · loss: wrong-result", t => {
  const runScoped = mode => {
    const sb = makeSandbox(t), w = makeWorld(sb), dep = (p, h) => (mode === "handoff" ? h : p);
    const authRef = recRef(sb, w.records, "decisions/D-0002.md"), critRef = recRef(sb, w.records, "design/spec.md");
    const time = { schema: "plan-time/v2", rootPlan: "PL-0001", baseline: { previousRoot: null, startedAt: "2026-11-24T08:00:00Z", startRefs: [authRef], deadline: { at: "2026-11-24T12:00:00Z", authorityRefs: [authRef] }, minimum: { outcome: "verified", criteriaRefs: [critRef], authorityRefs: [authRef] }, promises: [] } };
    commitPlan(sb, w, "PL-0001", [
      pkg("critic-init", "critic", "R-0002-critic-init", ["acceptance/domain.test.mjs"], [], ["actor-fix"]),
      pkg("actor-fix", "actor", "R-0002-actor-fix", ["src/a.js"], [dep("critic-init", "R-0002-critic-init")]),
      pkg("judge-final", "judge", "R-0002-judge", [], [dep("actor-fix", "R-0002-actor-fix")], ["critic-init", "actor-fix"]),
    ], `commit PL-0001 (${mode})`, "2026-11-24T09:00:00Z", time);
    const basedOn = sb.git(w.records, "rev-parse", "HEAD"), rootRef = recRef(sb, w.records, "plans/PL-0001.md", basedOn);
    const est = (lo, hi) => ({ asOf: "2026-11-24T09:00:00Z", remaining: { lowSeconds: lo, highSeconds: hi }, availableAfter: { lowSeconds: 0, highSeconds: 0 }, basisRefs: [authRef], assumptions: ["cap"], unknowns: [] });
    const fo = { schema: "plan-forecast/v1", rootRef, planRef: rootRef, parents: [], outlook: { asOf: "2026-11-24T09:00:00Z", observation: { observedAt: "2026-11-24T09:00:00Z", recordedAt: "2026-11-24T09:00:00Z", evidenceRefs: [authRef] }, basedOn, inputs: [authRef], releasePackages: ["judge-final"], reserve: { remaining: { lowSeconds: 2, highSeconds: 4 }, covers: ["review"], basisRefs: [authRef], assumptions: [] }, checkpointAt: "2026-11-24T10:00:00Z", change: { reason: "init", authorityRefs: [authRef], deferredPackages: [] }, outcome: { state: "active", evidenceRefs: [], deliveredAt: null } }, estimates: { "critic-init": est(1, 2), "actor-fix": est(3, 4), "judge-final": est(5, 6) }, promisesAdded: [] };
    const claim = { criteria: [{ ref: critRef, selector: "# M1", purpose: "minimum", promiseId: null, packages: ["judge-final"] }], releasePackages: ["judge-final"], deferred: [], gatePolicyRefs: [recRef(sb, w.records, "loop.json", basedOn)] };
    const src = JSON.stringify({ author: "IndependentJudge", role: "judge", requestId: "request-scope", endorsesClaim: sha256(canonical({ type: "scope", rootRef, planRef: rootRef, basedOn, claim })) });
    const plat = JSON.stringify({ taskId: "request-scope", childThreadId: "IndependentJudge", status: "completed", latestTerminalStatus: "completed", hasPendingChildRuns: false, childRunId: "run-1", latestTerminalRunId: "run-1" });
    const foBytes = JSON.stringify(fo);
    sb.put(w.records, `forecasts/FO-${sha256(foBytes)}.json`, foBytes);
    sb.put(w.records, "evidence/0001/scope/source.json", src);
    sb.put(w.records, "evidence/0001/scope/platform.json", plat);
    sb.put(w.records, "evidence/0001/scope/archive-hashes.json", JSON.stringify({ "source.json": sha256(src), "platform.json": sha256(plat) }));
    w.commitRecords("forecast and archive", "2026-11-24T09:00:05Z");
    const tb = JSON.stringify({ schema: "plan-time-binding/v1", type: "scope", rootRef, planRef: rootRef, basedOn, sourceRef: recRef(sb, w.records, "evidence/0001/scope/source.json"), authorizationRef: authRef, authorizationSelector: "# Authority", provenanceRefs: [recRef(sb, w.records, "evidence/0001/scope/platform.json"), recRef(sb, w.records, "evidence/0001/scope/archive-hashes.json")], supersedes: [], claim });
    sb.put(w.records, `evidence/0001/time-binding/TB-${sha256(tb)}.json`, tb);
    w.commitRecords("scope binding", "2026-11-24T09:00:06Z");
    const res = sb.runScript("plan.mjs", ["measure", "--records", w.records, "--plan", "PL-0001", "--now", "2026-11-24T09:05:00Z", "--json"]);
    assert.equal(res.status, 0, res.stderr + res.stdout);
    return JSON.parse(res.stdout);
  };
  const mPkg = runScoped("package"), mHandoff = runScoped("handoff");
  assert.deepEqual([mPkg.time.forecast.releaseEta.evidenceStatus, mHandoff.time.forecast.releaseEta.evidenceStatus], ["verified", "verified"], JSON.stringify([mPkg.time.findings, mHandoff.time.findings]));
  assert.deepEqual(mHandoff.time.forecast.releaseEta, mPkg.time.forecast.releaseEta);
  assert.deepEqual(mHandoff.time.findings, []);
});
