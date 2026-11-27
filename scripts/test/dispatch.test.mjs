// P-0012, D-0059, D-0063, design/parallel-dispatch.md#4, design/dispatch.md#file-ownership
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT } from "../call.mjs";
import { buildImportGraph } from "../lib/arch-facts.mjs";
import { analyzeDecoupling, computeDispatchPlan, computeWaves, integrateWave, prepareWave, readPlanWindow, recordWave, renderDispatchLines, reviewCoverage, validateDispatchCall } from "../lib/dispatch.mjs";
import { validateHandoff } from "../lib/handoff.mjs";
import { isCodeJudge, judgeLineageProblems, loadPlan, parsePlan, readyPlan, snapshot, validatePlan } from "../lib/plan.mjs";
import { openWindow } from "../lib/window.mjs";
import { git, isolatedEnv, repo, roomyStore, scripts, selfLoop, setup, temp } from "./helpers.mjs";

const put = (root, rel, text) => { const abs = join(root, rel); mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, text); };
const commitAll = (dir, msg) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); return git(dir, "rev-parse", "HEAD"); };
const pkgMd = (id, { role = "actor", handoff = `R-0002-${role}-${id}`, files = "", needs = "", iface = "fixed contract", reviews = null } = {}) => [
  `## ${id}`, "authority: D-0001", `goal: Deliver ${id}`, `files: ${Array.isArray(files) ? files.join(", ") : files}`,
  `interface: ${iface}`, `needs: ${Array.isArray(needs) ? needs.join(", ") : needs}`,
  ...(reviews !== null ? [`reviews: ${Array.isArray(reviews) ? reviews.join(", ") : reviews}`] : []),
  `role: ${role}`, "acceptance: tests pass", `handoff: ${handoff}`, "",
];
const planMd = (id, packages, { scope = "S5/round-2", phase = "S5", supersedes = null } = {}) =>
  [`# ${id} Plan`, `scope: ${scope}`, `phase: ${phase}`, ...(supersedes ? [`supersedes: ${supersedes}`] : []), "", ...packages.flat()].join("\n");

const baseHandoff = (overrides = {}) => ({
  id: "R-0002-actor-a", time: "2026-11-24T09:00:00Z", phase: "S5", round: 2, step: "actor-a", role: "actor", attempt: 1,
  agent: { runner: "cmd" }, view: "a".repeat(40), product: { base: "b".repeat(40), commit: "c".repeat(40) },
  audit: { violations: 0 }, record: "rounds/0002-actor-a.md", files: ["rounds/0002-actor-a.md"], ...overrides,
});

async function makeWorkspace(productFiles = {}, { agents = {}, scenario = {}, recordFiles = {}, owns = { critic: ["test"], actor: ["src"] } } = {}) {
  const s = await setup(scenario, {
    plans: false,
    owns,
    recordFiles: { "decisions/D-0001.md": "# D-0001 Dispatch contract\nby: owner\n", "design/api.md": "# API\n\n## v1\n", ...recordFiles },
    ...(Object.keys(agents).length ? { agents } : {}),
  });
  if (Object.keys(productFiles).length) {
    for (const [k, v] of Object.entries(productFiles)) put(s.product, k, v);
    commitAll(s.product, "product files");
    git(s.product, "branch", "-f", "loop/s5", "HEAD");
  }
  put(s.records, "loop.json", JSON.stringify(s.cfg, null, 2) + "\n");
  commitAll(s.records, "loop config");
  return s;
}

const runNext = records => spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", join(records, "loop.json")], {
  encoding: "utf8", env: { ...isolatedEnv(), SELF_LOOP_LOAD_DIR: temp("sl-load-"), SELF_LOOP_OWNER_STORE: roomyStore() },
});

test("buildImportGraph extracts sorted static relative JS/TS edges and excludes test dirs", () => {
  const r = repo({
    "src/a.mjs": "export const a = 1;\n", "src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a + 1;\n',
    "src/c.mjs": 'import { b } from "./b";\nexport { a } from "./a.mjs";\nexport const c = b;\n', "test/a.test.mjs": 'import { a } from "../src/a.mjs";\nconsole.log(a);\n',
  });
  const g = buildImportGraph(r, git(r, "rev-parse", "HEAD"));
  assert.deepEqual(g.files, ["src/a.mjs", "src/b.mjs", "src/c.mjs"]);
  assert.deepEqual(g.edges, [{ from: "src/b.mjs", to: "src/a.mjs" }, { from: "src/c.mjs", to: "src/a.mjs" }, { from: "src/c.mjs", to: "src/b.mjs" }]);
});

test("plan reviews field and handoff dispatch contract validation", () => {
  const files = {
    "decisions/D-0001.md": "# D-0001\nby: owner\n",
    "plans/PL-0001.md": planMd("PL-0001", [
      pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js" }),
      pkgMd("c", { role: "critic", files: "test/c.test.js", needs: "a, b", reviews: "a, b" }),
      pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "c" }),
    ]),
  };
  const st = { revision: "a".repeat(40), files: new Set(Object.keys(files)), read: p => files[p] ?? "", bytes: p => files[p] ?? null };
  const p1 = parsePlan(files["plans/PL-0001.md"]);
  assert.deepEqual(p1.packages[2].reviews, ["a", "b"]);
  assert.deepEqual(validatePlan(p1, st), []);
  assert.match(validatePlan(parsePlan(planMd("PL-0002", [pkgMd("c", { role: "critic", reviews: "c" })])), st).join("\n"), /cannot reference itself/);
  assert.match(validatePlan(parsePlan(planMd("PL-0002", [pkgMd("c", { role: "critic", reviews: "ghost" })])), st).join("\n"), /unknown in-plan package ghost/);
  assert.deepEqual(validatePlan(parsePlan(planMd("PL-0002", [
    pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js" }),
    pkgMd("c", { role: "critic", files: "test/c.test.js", needs: "a, b", reviews: "b, a" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "c" }),
  ], { supersedes: "PL-0001" })), st), []);
  assert.match(validatePlan(parsePlan(planMd("PL-0002", [
    pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js" }),
    pkgMd("c", { role: "critic", files: "test/c.test.js", needs: "a, b", reviews: "a" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "c" }),
  ], { supersedes: "PL-0001" })), st).join("\n"), /new handoff/);

  assert.equal(validateHandoff(baseHandoff({ dispatch: { plan: "PL-0001", package: "a", files: ["src/a.js"] } })).dispatch.package, "a");
  assert.throws(() => validateHandoff(baseHandoff({ dispatch: { plan: "bad", package: "a", files: [] } })), /dispatch/);
  assert.throws(() => validateHandoff(baseHandoff({ dispatch: { plan: "PL-0001", package: "a", files: [""] } })), /dispatch/);
});

test("analyzeDecoupling classifies decoupled, interface-coupled, undeclared-coupled, and write-coupled", async () => {
  const s = await makeWorkspace({ "src/a.mjs": "export const a = 1;\n", "src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a + 1;\n', "src/c.mjs": "export const c = 3;\n" });
  const base = git(s.product, "rev-parse", "loop/s5"), st = snapshot(s.records);
  const plan = { id: "PL-0001", scope: "S5/r2", phase: "S5", packages: [
    { id: "a", role: "actor", files: ["src/a.mjs"], interface: "D-0001", needs: [], handoff: "R-0002-actor-a" },
    { id: "b", role: "actor", files: ["src/b.mjs"], interface: "no pointer", needs: [], handoff: "R-0002-actor-b" },
    { id: "c", role: "actor", files: ["src/c.mjs"], interface: "design/api.md#v1", needs: [], handoff: "R-0002-actor-c" },
    { id: "d", role: "actor", files: ["src/c.mjs"], interface: "D-0001", needs: [], handoff: "R-0002-actor-d" },
  ] };
  const res = analyzeDecoupling({ plan, product: s.product, base, state: st });
  const kindOf = (r, l, ri) => r.pairs.find(p => p.left === l && p.right === ri)?.kind;
  assert.deepEqual([kindOf(res, "a", "b"), kindOf(res, "a", "c"), kindOf(res, "c", "d")], ["undeclared-coupled", "decoupled", "write-coupled"]);
  plan.packages[1].interface = "design/api.md#v1";
  assert.equal(kindOf(analyzeDecoupling({ plan, product: s.product, base, state: st }), "a", "b"), "interface-coupled");
  plan.packages[1].interface = "D-9999";
  assert.equal(kindOf(analyzeDecoupling({ plan, product: s.product, base, state: st }), "a", "b"), "undeclared-coupled");
});

test("reviewCoverage classifies unified, parallel, partial, none, and slack window", () => {
  const mk = pkgs => ({ id: "PL-0001", packages: pkgs });
  const a = { id: "a", role: "actor", files: ["src/a.js"], needs: [], handoff: "R-0002-actor-a" };
  const b = { id: "b", role: "actor", files: ["src/b.js"], needs: [], handoff: "R-0002-actor-b" };
  const unified = reviewCoverage(mk([a, b, { id: "c", role: "critic", files: ["test/all.test.js"], needs: ["a", "b"], handoff: "R-0002-critic-c" }]));
  assert.deepEqual([unified.topology, unified.required], ["unified", true]);
  assert.equal(reviewCoverage(mk([a, b, { id: "ca", role: "critic", files: ["test/a.test.js"], needs: ["a"], reviews: ["a"], handoff: "R-0002-critic-ca" }, { id: "cb", role: "critic", files: ["test/b.test.js"], needs: ["b"], reviews: ["b"], handoff: "R-0002-critic-cb" }])).topology, "parallel");
  const partial = reviewCoverage(mk([a, b, { id: "ca", role: "critic", files: ["test/a.test.js"], needs: ["a"], handoff: "R-0002-critic-ca" }]), { window: { mode: "slack" } });
  assert.deepEqual([partial.topology, partial.uncoveredActors, partial.required, reviewCoverage(mk([a])).topology], ["partial", ["b"], false, "none"]);
});

test("G1 and G2 enforce plan/package binding, superseded refusal, and DAG/batch prerequisites", async () => {
  const s = await makeWorkspace(
    { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n" },
    { scenario: { actor: [{ report: "done\n" }] }, recordFiles: { "owner/B-0001.md": "# B-0001\n\nphase: S5\n" } },
  );
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js", needs: "a" }), pkgMd("gated", { files: "src/g.js", needs: "B-0001" }),
    pkgMd("cr", { role: "critic", files: "test/cr.test.js", needs: "a, b, gated", reviews: "a, b, gated" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "cr" }),
  ]));
  commitAll(s.records, "PL-0001");

  assert.equal(s.run("actor", { round: 2, step: "actor-a", plan: "PL-0001" }).code, EXIT.usage);
  assert.equal(s.run("actor", { round: 2, step: "actor-a", plan: "PL-9999", package: "a" }).code, EXIT.records);
  assert.equal(s.run("actor", { round: 2, step: "actor-wrong", plan: "PL-0001", package: "a" }).code, EXIT.records);
  const unmetDep = s.run("actor", { round: 2, step: "actor-b", plan: "PL-0001", package: "b" });
  assert.equal(unmetDep.code, EXIT.records);
  assert.match(unmetDep.message, /G2.*a/);
  const unmetBatch = s.run("actor", { round: 2, step: "actor-gated", plan: "PL-0001", package: "gated" });
  assert.equal(unmetBatch.code, EXIT.records);
  assert.match(unmetBatch.message, /G2.*B-0001/);

  put(s.records, "plans/PL-0002.md", planMd("PL-0002", [
    pkgMd("a", { files: "src/a.js" }),
    pkgMd("cr", { role: "critic", handoff: "R-0002-critic-crb", files: "test/cr.test.js", needs: "a", reviews: "a" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge-b", needs: "cr" }),
  ], { supersedes: "PL-0001" }));
  commitAll(s.records, "supersede");
  const sup = s.run("actor", { round: 2, step: "actor-a", plan: "PL-0001", package: "a" });
  assert.equal(sup.code, EXIT.records);
  assert.match(sup.message, /superseded/);
});

test("G3 and G4 refuse live writer overlap and undeclared concurrent import coupling while permitting contracted pairs", async () => {
  const t3 = p => ({ runner: "t3", provider: p, model: "m" });
  const s = await makeWorkspace(
    { "src/a.mjs": "export const a = 1;\n", "src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a;\n', "src/c.mjs": "export const c = 3;\n" },
    { agents: { actor: t3("codex"), critic: t3("codex"), judge: t3("claude"), reviewer: t3("claude") } },
  );
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a", { files: "src/a.mjs", iface: "D-0001" }),
    pkgMd("b", { files: "src/b.mjs", iface: "uncommitted prose" }),
    pkgMd("c", { files: "src/c.mjs", iface: "independent" }),
    pkgMd("cr", { role: "critic", files: "test/cr.test.mjs", needs: "a, b, c", reviews: "a, b, c" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "cr" }),
  ]));
  put(s.records, "plans/PL-0009.md", planMd("PL-0009", [
    pkgMd("dup", { files: "src/a.mjs", iface: "D-0001" }),
    pkgMd("cr", { role: "critic", handoff: "R-0002-critic-dup", files: "test/dup.test.mjs", needs: "dup", reviews: "dup" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge-dup", needs: "cr" }),
  ], { scope: "S5/round-2-dup" }));
  commitAll(s.records, "PL-0001");

  assert.equal(s.run("actor", { round: 2, step: "actor-a", plan: "PL-0001", package: "a", prepare: true }).code, EXIT.done);
  const unplanned = s.run("actor", { round: 2, step: "actor-adhoc", plan: null, package: null, prepare: true });
  assert.equal(unplanned.code, EXIT.records);
  assert.match(unplanned.message, /requires --plan/);
  const overlap = s.run("actor", { round: 2, step: "actor-dup", plan: "PL-0009", package: "dup", prepare: true });
  assert.equal(overlap.code, EXIT.records);
  assert.match(overlap.message, /G3/);
  const g4Blocked = s.run("actor", { round: 2, step: "actor-b", plan: "PL-0001", package: "b", prepare: true });
  assert.equal(g4Blocked.code, EXIT.records);
  assert.match(g4Blocked.message, /G4.*src\/b\.mjs -> src\/a\.mjs/);
  assert.equal(s.run("actor", { round: 2, step: "actor-c", plan: "PL-0001", package: "c", prepare: true }).code, EXIT.done);

  put(s.records, "plans/PL-0002.md", planMd("PL-0002", [
    pkgMd("a", { files: "src/a.mjs", iface: "D-0001" }),
    pkgMd("b", { handoff: "R-0002-actor-bb", files: "src/b.mjs", iface: "design/api.md#v1" }),
    pkgMd("c", { files: "src/c.mjs", iface: "independent" }),
    pkgMd("cr", { role: "critic", files: "test/cr.test.mjs", needs: "a, b, c", reviews: "a, b, c" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "cr" }),
  ], { supersedes: "PL-0001" }));
  commitAll(s.records, "PL-0002 contracted");
  assert.equal(s.run("actor", { round: 2, step: "actor-bb", plan: "PL-0002", package: "b", prepare: true }).code, EXIT.done);
});

test("G5 confines actor commits to package globs and fails closed on peer-package edits", async () => {
  const s = await makeWorkspace(
    { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n", "src/extra.js": "export const e = 1;\n" },
    {
      scenario: {
        actor: [
          { report: "edited a and extra\n", write: { "src/a.js": "export const a = 2;\n", "src/extra.js": "export const e = 2;\n" } },
          { report: "touched peer\n", write: { "src/b.js": "export const b = 2;\n", "src/a.js": "export const a = 99;\n" } },
        ],
      },
    },
  );
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js" }),
    pkgMd("cr", { role: "critic", files: "test/cr.test.js", needs: "a, b", reviews: "a, b" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "cr" }),
  ]));
  commitAll(s.records, "PL-0001");
  const base = git(s.product, "rev-parse", "loop/s5");

  const ok = s.run("actor", { round: 2, step: "actor-a", plan: "PL-0001", package: "a", base });
  assert.equal(ok.code, EXIT.done, ok.message);
  assert.deepEqual(ok.handoff.dispatch, { plan: "PL-0001", package: "a", files: ["src/a.js"] });
  assert.equal(git(s.product, "show", `${ok.handoff.product.commit}:src/a.js`), "export const a = 2;");
  assert.equal(git(s.product, "show", `${ok.handoff.product.commit}:src/extra.js`), "export const e = 1;");
  assert.ok(ok.handoff.product.outside.includes("src/extra.js"));

  const bad = s.run("actor", { round: 2, step: "actor-b", plan: "PL-0001", package: "b", base });
  assert.equal(bad.code, EXIT.records);
  assert.match(bad.message, /cross-package write violation/);
  assert.equal(git(s.product, "show", "loop/s5:src/b.js"), "export const b = 1;");
});

test("G6 and G7 drive parallel actors, pipelined and parallel critics, wave integration, and judge join barrier", async () => {
  const s = await makeWorkspace(
    { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n", "src/c.js": "export const c = 1;\n", "test/a.test.js": "export const ta = 1;\n", "test/b.test.js": "export const tb = 1;\n" },
    {
      scenario: {
        actor: [
          { report: "a\n", write: { "src/a.js": "export const a = 10;\n" } },
          { report: "b\n", write: { "src/b.js": "export const b = 20;\n" } },
          { report: "c\n", write: { "src/c.js": "export const c = 30;\n" } },
        ],
        critic: [
          { report: "ca\n", write: { "test/a.test.js": "export const ta = 10;\n" } },
          { report: "cb\n", write: { "test/b.test.js": "export const tb = 20;\n" } },
        ],
        judge: [{ report: "VERDICT: CONVERGED\nACCEPTANCE: pass\n", public: "public ok\n" }],
      },
    },
  );
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js" }), pkgMd("c", { files: "src/c.js" }),
    pkgMd("ca", { role: "critic", files: "test/a.test.js", needs: "a", reviews: "a" }),
    pkgMd("cb", { role: "critic", files: "test/b.test.js", needs: "b, c", reviews: "b, c" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "ca, cb" }),
  ]));
  for (const id of ["R-0002-actor-a", "R-0002-actor-b", "R-0002-actor-c", "R-0002-critic-ca", "R-0002-critic-cb", "R-0002-judge"]) {
    put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  }
  commitAll(s.records, "PL-0001");
  const m0 = git(s.product, "rev-parse", "loop/s5");

  const next0 = runNext(s.records);
  assert.equal(next0.status, 0, next0.stderr);
  assert.match(next0.stdout, /Parallel wave \(PL-0001, topology: parallel\): 3 parallel actor\(s\)/);
  assert.match(next0.stdout, /--plan PL-0001 --package a/);

  const ra = s.run("actor", { round: 2, step: "actor-a", plan: "PL-0001", package: "a", base: m0 });
  assert.equal(ra.code, EXIT.done, ra.message);
  const stA = snapshot(s.records);
  const dpMid = computeDispatchPlan({ state: stA, plan: loadPlan(stA, "PL-0001"), product: s.product, base: ra.handoff.product.commit, host: { admits: true, over: [], calls: [] } });
  assert.deepEqual(dpMid.parallelBatch.critics.map(c => c.id), ["ca"]);
  assert.deepEqual(dpMid.parallelBatch.actors.map(a => a.id), ["b", "c"]);

  assert.equal(s.run("actor", { round: 2, step: "actor-b", plan: "PL-0001", package: "b", base: m0 }).code, EXIT.done);
  assert.equal(s.run("actor", { round: 2, step: "actor-c", plan: "PL-0001", package: "c", base: m0 }).code, EXIT.done);
  const nextDiv = runNext(s.records);
  assert.equal(nextDiv.status, 0, nextDiv.stderr);
  assert.match(nextDiv.stdout, /dispatch\.mjs integrate --records/);

  const analyzeCli = selfLoop(["dispatch", "analyze", "--records", s.records, "--plan", "PL-0001", "--json"]);
  assert.equal(analyzeCli.status, 0, analyzeCli.stderr);
  assert.equal(JSON.parse(analyzeCli.stdout).coverage.topology, "parallel");

  const dryCli = selfLoop(["dispatch", "integrate", "--records", s.records, "--plan", "PL-0001", "--wave", "0", "--dry-run", "--json"]);
  assert.equal(dryCli.status, 0, dryCli.stderr);
  assert.equal(JSON.parse(dryCli.stdout).disjoint, true);

  const applyCli = selfLoop(["dispatch", "integrate", "--records", s.records, "--plan", "PL-0001", "--wave", "0", "--apply", "--json"]);
  assert.equal(applyCli.status, 0, applyCli.stderr);
  const merged = JSON.parse(applyCli.stdout);
  assert.equal(merged.ok, true);
  assert.equal(merged.parents.length, 3);
  assert.equal(git(s.product, "rev-parse", "loop/s5"), merged.commit);
  assert.equal(git(s.product, "show", `${merged.commit}:src/c.js`), "export const c = 30;");

  const stMerged = snapshot(s.records);
  const dpMerged = computeDispatchPlan({ state: stMerged, plan: loadPlan(stMerged, "PL-0001"), product: s.product, base: merged.commit, host: { admits: true, over: [], calls: [] } });
  assert.equal(dpMerged.needsIntegration, false);
  assert.deepEqual(dpMerged.parallelBatch.critics.map(c => c.id), ["ca", "cb"]);
  assert.ok(renderDispatchLines(dpMerged).some(l => l.includes("Parallel critic batch (2, topology parallel)")));

  const g7Unmerged = validateDispatchCall({ cfg: s.cfg, state: stMerged, planId: "PL-0001", packageId: "j", role: "judge", step: "judge", round: 2, base: ra.handoff.product.commit, prepared: [] });
  assert.equal(g7Unmerged.ok, false);
  assert.ok(g7Unmerged.errors.some(e => e.includes("not an ancestor")));

  assert.equal(s.run("critic", { round: 2, step: "critic-ca", plan: "PL-0001", package: "ca", base: merged.commit }).code, EXIT.done);
  const judgeEarly = s.run("judge", { round: 2, step: "judge", plan: "PL-0001", package: "j", base: merged.commit });
  assert.equal(judgeEarly.code, EXIT.records);
  assert.match(judgeEarly.message, /G7.*cb/);
  assert.equal(s.run("critic", { round: 2, step: "critic-cb", plan: "PL-0001", package: "cb", base: merged.commit }).code, EXIT.done);
  const judgeMissingCritics = s.run("judge", { round: 2, step: "judge", plan: "PL-0001", package: "j", base: merged.commit });
  assert.equal(judgeMissingCritics.code, EXIT.records);
  assert.match(judgeMissingCritics.message, /G7.*critic (?:ca|cb)/);
  const applyCritics = selfLoop(["dispatch", "integrate", "--records", s.records, "--plan", "PL-0001", "--apply", "--json"]);
  assert.equal(applyCritics.status, 0, applyCritics.stderr + applyCritics.stdout);
  const mergedWithCritics = JSON.parse(applyCritics.stdout);
  assert.equal(mergedWithCritics.ok, true);
  const judgeOk = s.run("judge", { round: 2, step: "judge", plan: "PL-0001", package: "j", base: mergedWithCritics.commit });
  assert.equal(judgeOk.code, EXIT.done, judgeOk.message);
  assert.equal(judgeOk.handoff.dispatch.package, "j");
});

test("G6 refuses conflicting wave integration and G7 respects bounded window slack vs uncovered actor", async () => {
  const s = await makeWorkspace(
    { "src/shared.js": "export const x = 0;\n", "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n" },
    {
      scenario: {
        actor: [
          { report: "a\n", write: { "src/shared.js": "export const x = 1;\n" } },
          { report: "b\n", write: { "src/shared.js": "export const x = 2;\n" } },
        ],
        judge: [{ report: "VERDICT: CONTINUE\n", public: "ok\n" }],
      },
    },
  );
  put(s.records, "plans/PL-0010.md", planMd("PL-0010", [
    pkgMd("a", { files: "src/shared.js" }),
    pkgMd("cr", { role: "critic", handoff: "R-0002-critic-a", files: "test/a.test.js", needs: "a", reviews: "a" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge-a", needs: "cr" }),
  ], { scope: "S5/round-2-a" }));
  put(s.records, "plans/PL-0011.md", planMd("PL-0011", [
    pkgMd("b", { files: "src/shared.js" }),
    pkgMd("cr", { role: "critic", handoff: "R-0002-critic-b", files: "test/b.test.js", needs: "b", reviews: "b" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge-b", needs: "cr" }),
  ], { scope: "S5/round-2-b" }));
  commitAll(s.records, "actor plans");
  const m0 = git(s.product, "rev-parse", "loop/s5");

  const r1 = s.run("actor", { round: 2, step: "actor-a", plan: "PL-0010", package: "a", base: m0 });
  const r2 = s.run("actor", { round: 2, step: "actor-b", plan: "PL-0011", package: "b", base: m0 });
  assert.equal(r1.code, EXIT.done, r1.message);
  assert.equal(r2.code, EXIT.done, r2.message);

  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a", { files: "src/a.js" }), pkgMd("b", { files: "src/b.js" }), pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "a, b" }),
  ]));
  commitAll(s.records, "PL-0001");

  const stNoWin = snapshot(s.records);
  assert.throws(() => loadPlan(stNoWin, "PL-0001"), /lack critic coverage outside an open W-NNNN window/);
  const g7NoCritic = validateDispatchCall({ cfg: s.cfg, state: stNoWin, planId: "PL-0001", packageId: "j", role: "judge", step: "judge", round: 2, base: r1.handoff.product.commit, prepared: [] });
  assert.equal(g7NoCritic.ok, false);
  assert.ok(g7NoCritic.errors.some(e => e.includes("lack critic coverage")));

  openWindow(s.records, { phase: "S5", startRound: 2, horizon: 4, goal: "refactor", invariants: ["green"] });
  const stWin = snapshot(s.records);
  const direct = integrateWave({ cfg: s.cfg, state: stWin, plan: loadPlan(stWin, "PL-0001"), apply: false });
  assert.equal(direct.ok, false);
  assert.equal(direct.disjoint, false);
  const conflictCli = selfLoop(["dispatch", "integrate", "--records", s.records, "--plan", "PL-0001", "--dry-run", "--json"]);
  assert.equal(conflictCli.status, 1);
  assert.equal(JSON.parse(conflictCli.stdout).conflicts[0].files[0], "src/shared.js");

  const wavesCli = selfLoop(["dispatch", "waves", "--records", s.records, "--plan", "PL-0001", "--json"]);
  assert.equal(wavesCli.status, 0, wavesCli.stderr);
  assert.equal(JSON.parse(wavesCli.stdout).coverage.topology, "none");

  const win = readPlanWindow(stWin, "S5", 2);
  assert.equal(win.mode, "slack");
  const g7Slack = validateDispatchCall({ cfg: s.cfg, state: stWin, planId: "PL-0001", packageId: "j", role: "judge", step: "judge", round: 2, base: r1.handoff.product.commit, prepared: [], window: win });
  assert.ok(!g7Slack.errors.some(e => e.includes("lack critic coverage")));
});

test("D-0063 unit boundaries: handoff-ID waves/coverage/G2 and G5 peerFiles retention across ordered superset globs", async () => {
  const s = await makeWorkspace({ "src/a.js": "export const a = 1;\n", "test/domain.test.js": "export const t = 1;\n" });
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("c0", { role: "critic", handoff: "R-0002-critic-init", files: "test/**" }),
    pkgMd("a1", { role: "actor", handoff: "R-0002-actor-fix", files: "src/a.js", needs: "R-0002-critic-init" }),
    pkgMd("c1", { role: "critic", handoff: "R-0002-critic-post", files: "test/domain.test.js", needs: "R-0002-actor-fix", reviews: "a1" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "R-0002-critic-post" }),
  ]));
  commitAll(s.records, "PL-0001 unit boundaries");
  const st = snapshot(s.records), pl = loadPlan(st, "PL-0001"), base0 = git(s.product, "rev-parse", "loop/s5");
  assert.deepEqual(Object.fromEntries(computeWaves(pl)), { c0: 0, a1: 1, c1: 2, j: 3 });
  const cov = reviewCoverage(pl);
  assert.deepEqual(cov.critics.find(c => c.id === "c0")?.targets, ["a1"]);
  assert.deepEqual(cov.criticPairsOverlap, []);
  const g2 = validateDispatchCall({ cfg: s.cfg, state: st, planId: "PL-0001", packageId: "a1", role: "actor", step: "actor-fix", round: 2, base: base0, prepared: [] });
  assert.equal(g2.ok, false);
  assert.ok(g2.errors.some(e => /G2 unmet dependency c0 \(R-0002-critic-init\)/.test(e)));
  const g5 = validateDispatchCall({ cfg: s.cfg, state: st, planId: "PL-0001", packageId: "c1", role: "critic", step: "critic-post", round: 2, base: base0, prepared: [] });
  assert.ok(g5.peerFiles.includes("test/**") && g5.peerFiles.includes("src/a.js"));
});

test("R49-2/R50-1/R50-2 critic causal base, stale-critic J1/J2 lineage, and no-change actor G7 ancestry", async () => {
  const s = await makeWorkspace(
    { "src/a.js": "export const a = 1;\n", "test/a.test.js": "export const t = 1;\n", "README.md": "# r\n" },
    { scenario: { critic: [{ report: "init\n", write: { "test/a.test.js": "export const t = 2;\n" } }, { report: "no-diff post\n" }], actor: [{ report: "fix\n", write: { "src/a.js": "export const a = 2;\n" } }, { report: "no-diff actor\n" }] } },
  );
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("c0", { role: "critic", handoff: "R-0002-critic-init", files: "test/a.test.js", reviews: "a1" }),
    pkgMd("a1", { role: "actor", handoff: "R-0002-actor-fix", files: "src/a.js", needs: "c0" }),
    pkgMd("c1", { role: "critic", handoff: "R-0002-critic-post", files: "test/a.test.js", needs: "a1", reviews: "a1" }),
    pkgMd("jf", { role: "judge", handoff: "R-0002-judge-frame" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "c1" }),
  ]));
  for (const id of ["R-0002-critic-init", "R-0002-actor-fix", "R-0002-critic-post", "R-0002-judge-frame", "R-0002-judge"]) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  commitAll(s.records, "PL-0001 lineage");
  const base0 = git(s.product, "rev-parse", "loop/s5");
  const rC0 = s.run("critic", { round: 2, step: "critic-init", plan: "PL-0001", package: "c0", base: base0 });
  const rA1 = s.run("actor", { round: 2, step: "actor-fix", plan: "PL-0001", package: "a1", base: rC0.handoff.product.commit });
  assert.deepEqual([rC0.code, rA1.code], [EXIT.done, EXIT.done]);
  const actorSha = rA1.handoff.product.commit;
  const staleCall = s.run("critic", { round: 2, step: "critic-post", plan: "PL-0001", package: "c1", base: rC0.handoff.product.commit });
  assert.equal(staleCall.code, EXIT.records);
  assert.match(staleCall.message, new RegExp(`G2 critic causal base.*${actorSha.slice(0, 12)}`));

  git(s.product, "checkout", "-q", "--detach", rC0.handoff.product.commit);
  put(s.product, "README.md", "# off-branch doc\n");
  const docSha = commitAll(s.product, "doc branch");
  git(s.product, "branch", "-f", "loop/s5", docSha);
  const stPin = snapshot(s.records), plPin = loadPlan(stPin, "PL-0001");
  const dpPin = computeDispatchPlan({ state: stPin, plan: plPin, product: s.product, base: docSha, host: { admits: true, over: [], calls: [] } });
  assert.match(dpPin.parallelBatch.critics[0].command, new RegExp(`--base ${actorSha}`));
  assert.match(dpPin.packages.find(p => p.id === "c1").dispatchCommand, new RegExp(`--base ${actorSha}`));

  git(s.product, "checkout", "-q", "--detach", rC0.handoff.product.commit);
  put(s.product, "test/a.test.js", "export const t = 3;\n");
  const criticSha = commitAll(s.product, "stale writing critic");
  git(s.product, "checkout", "-q", "main");
  const staleH = baseHandoff({ id: "R-0002-critic-post", step: "critic-post", role: "critic", product: { base: rC0.handoff.product.commit, commit: criticSha }, record: "rounds/0002-critic-post.md", files: ["rounds/0002-critic-post.md"], dispatch: { plan: "PL-0001", package: "c1", files: ["test/a.test.js"] } });
  put(s.records, "rounds/0002-critic-post.md", "# R-0002-critic-post\n");
  put(s.records, "metrics/handoffs.jsonl", `${git(s.records, "show", "HEAD:metrics/handoffs.jsonl")}\n${JSON.stringify(staleH)}\n`);
  commitAll(s.records, "seed stale post-actor critic");

  const st = snapshot(s.records), pl = loadPlan(st, "PL-0001");
  assert.deepEqual([isCodeJudge(pl.packages.find(p => p.id === "jf")), isCodeJudge(pl.packages.find(p => p.id === "j"))], [false, true]);
  const probsOnActor = judgeLineageProblems(pl, { repo: s.product, handoffs: [rC0.handoff, rA1.handoff, staleH], base: actorSha });
  assert.deepEqual(probsOnActor.map(p => p.kind).sort(), ["lineage", "merge"]);
  assert.ok(probsOnActor.every(p => p.id === "c1"));
  const mergedStale = integrateWave({ cfg: s.cfg, state: st, plan: pl, apply: true });
  assert.equal(mergedStale.ok, true, mergedStale.message);
  assert.deepEqual(judgeLineageProblems(pl, { repo: s.product, handoffs: [rC0.handoff, rA1.handoff, staleH], base: mergedStale.commit }).map(p => [p.kind, p.id]), [["lineage", "c1"]]);
  const g7Code = validateDispatchCall({ cfg: s.cfg, state: st, planId: "PL-0001", packageId: "j", role: "judge", step: "judge", round: 2, base: mergedStale.commit, prepared: [] });
  assert.equal(g7Code.ok, false);
  assert.ok(g7Code.errors.some(e => /G7.*c1.*stale base/.test(e)));
  assert.equal(validateDispatchCall({ cfg: s.cfg, state: st, planId: "PL-0001", packageId: "jf", role: "judge", step: "judge-frame", round: 2, base: actorSha, prepared: [] }).ok, true);
  const ready = readyPlan(st, pl, { host: { admits: true, over: [], calls: [] }, base: mergedStale.commit });
  assert.deepEqual([ready.packages.find(p => p.id === "jf").status, ready.packages.find(p => p.id === "j").status, ready.packages.find(p => p.id === "j").idle], ["ready", "waiting", false]);
  const dp = computeDispatchPlan({ state: st, plan: pl, product: s.product, base: actorSha, host: { admits: true, over: [], calls: [] } });
  assert.equal(dp.needsIntegration, true);
  assert.ok(dp.unmergedWriters.some(w => w.id === "c1" && w.commit === criticSha));
  assert.ok(dp.judgeBlockedReasons.some(r => r.includes(criticSha.slice(0, 12))) && dp.judgeBlockedReasons.some(r => r.includes("stale base")));

  put(s.records, "plans/PL-0002.md", planMd("PL-0002", [
    pkgMd("a2", { role: "actor", handoff: "R-0003-actor-nodiff", files: "src/a.js" }),
    pkgMd("c2", { role: "critic", handoff: "R-0003-critic-nodiff", files: "", needs: "a2", reviews: "a2" }),
    pkgMd("j2", { role: "judge", handoff: "R-0003-judge", needs: "c2" }),
  ], { scope: "S5/round-3" }));
  for (const id of ["R-0003-actor-nodiff", "R-0003-critic-nodiff", "R-0003-judge"]) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  commitAll(s.records, "PL-0002 no-change actor");
  const rA2 = s.run("actor", { round: 3, step: "actor-nodiff", plan: "PL-0002", package: "a2", base: mergedStale.commit });
  const rC2 = s.run("critic", { round: 3, step: "critic-nodiff", plan: "PL-0002", package: "c2", base: mergedStale.commit });
  assert.deepEqual([rA2.code, rC2.code, rA2.handoff.product.commit], [EXIT.done, EXIT.done, mergedStale.commit]);
  const st2 = snapshot(s.records);
  const g7Older = validateDispatchCall({ cfg: s.cfg, state: st2, planId: "PL-0002", packageId: "j2", role: "judge", step: "judge", round: 3, base: base0, prepared: [] });
  assert.equal(g7Older.ok, false);
  assert.ok(g7Older.errors.some(e => e.includes(mergedStale.commit.slice(0, 12))), g7Older.errors.join("; "));
  assert.equal(validateDispatchCall({ cfg: s.cfg, state: st2, planId: "PL-0002", packageId: "j2", role: "judge", step: "judge", round: 3, base: mergedStale.commit, prepared: [] }).ok, true);
  assert.equal(prepareWave({ cfg: s.cfg, state: stPin, plan: plPin, base: docSha, host: { admits: true, over: [], calls: [] } }).ok, false);
});

test("PLB-18 off-branch no-change actor integrates alongside diverged actor while on-branch no-change reports no commits", async () => {
  const s = await makeWorkspace({ "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n", "README.md": "# r\n" }, { scenario: { actor: [{ report: "on\n" }, { report: "off\n" }, { report: "b\n", write: { "src/b.js": "export const b = 2;\n" } }] } });
  const olderSha = git(s.product, "rev-parse", "loop/s5"), host = { admits: true, over: [], calls: [] };
  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [pkgMd("on", { handoff: "R-0002-actor-on", files: "src/a.js" }), pkgMd("co", { role: "critic", handoff: "R-0002-critic-co", files: "", needs: "on", reviews: "on" }), pkgMd("jo", { role: "judge", handoff: "R-0002-judge-jo", needs: "co" })]));
  put(s.records, "plans/PL-0002.md", planMd("PL-0002", [pkgMd("a", { handoff: "R-0003-actor-a", files: "src/a.js" }), pkgMd("b", { handoff: "R-0003-actor-b", files: "src/b.js" }), pkgMd("c", { role: "critic", handoff: "R-0003-critic-c", files: "", needs: "a, b", reviews: "a, b" }), pkgMd("j", { role: "judge", handoff: "R-0003-judge", needs: "c" })], { scope: "S5/round-3" }));
  commitAll(s.records, "PL-0001 and PL-0002");
  assert.equal(s.run("actor", { round: 2, step: "actor-on", plan: "PL-0001", package: "on", base: olderSha }).code, EXIT.done);
  const st0 = snapshot(s.records), pl0 = loadPlan(st0, "PL-0001");
  assert.deepEqual([computeDispatchPlan({ state: st0, plan: pl0, product: s.product, base: olderSha, host }).needsIntegration, /no landed writer commits/.test(integrateWave({ cfg: s.cfg, state: st0, plan: pl0, apply: true }).message)], [false, true]);
  git(s.product, "checkout", "-q", "--detach", olderSha); put(s.product, "README.md", "# off-branch\n");
  const newerSha = commitAll(s.product, "off-branch newer"); git(s.product, "checkout", "-q", "main");
  const rA = s.run("actor", { round: 3, step: "actor-a", plan: "PL-0002", package: "a", base: newerSha }), rB = s.run("actor", { round: 3, step: "actor-b", plan: "PL-0002", package: "b", base: olderSha });
  assert.deepEqual([rA.code, rB.code, rA.handoff.product.commit], [EXIT.done, EXIT.done, newerSha]);
  const st2 = snapshot(s.records), pl2 = loadPlan(st2, "PL-0002"), dp = computeDispatchPlan({ state: st2, plan: pl2, product: s.product, base: rB.handoff.product.commit, host }), merged = integrateWave({ cfg: s.cfg, state: st2, plan: pl2, apply: true });
  assert.deepEqual([dp.needsIntegration, dp.unmergedWriters.map(w => w.id), merged.ok, git(s.product, "merge-base", "--is-ancestor", newerSha, merged.commit), git(s.product, "merge-base", "--is-ancestor", rB.handoff.product.commit, merged.commit), computeDispatchPlan({ state: st2, plan: pl2, product: s.product, base: merged.commit, host }).needsIntegration], [true, ["a"], true, "", "", false]);
});

test("R51-1/R51-2/D-0064 T10: plan.mjs ready command runs verbatim, Judge waits on pending Critic across ready/waves/prepare/G7, and Actor+Critic plans need no mandatory Judge", async () => {
  const t3 = p => ({ runner: "t3", provider: p, model: "m" });
  const s = await makeWorkspace(
    { "src/a.js": "export const a = 1;\n", "test/a.test.js": "export const t = 1;\n" },
    { agents: { actor: t3("claude"), critic: t3("codex"), judge: t3("codex"), reviewer: t3("claude") } },
  );
  const noJudgePlan = parsePlan(planMd("PL-0009", [
    pkgMd("a1", { handoff: "R-0002-actor-a", files: "src/a.js" }),
    pkgMd("c1", { role: "critic", handoff: "R-0002-critic-post", files: "", needs: "a1", reviews: "a1" }),
  ]));
  assert.deepEqual(validatePlan(noJudgePlan, snapshot(s.records)), []);
  assert.match(validatePlan(parsePlan(planMd("PL-0009", [pkgMd("a1", { handoff: "R-0002-actor-a", files: "src/a.js" })])), snapshot(s.records)).join("\n"), /lack critic coverage/);

  put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a1", { handoff: "R-0002-actor-a", files: "src/a.js" }),
    pkgMd("c1", { role: "critic", handoff: "R-0002-critic-post", files: "", needs: "a1", reviews: "a1" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "a1" }),
  ]));
  for (const id of ["R-0002-actor-a", "R-0002-critic-post", "R-0002-judge"]) put(s.cfg.workDir, `tasks/${id}.md`, `features: F-0001\n${id}\n`);
  const base0 = git(s.product, "rev-parse", "loop/s5");
  const actorH = baseHandoff({
    id: "R-0002-actor-a", step: "actor-a", role: "actor", product: { base: base0, commit: base0 },
    record: "rounds/0002-actor-a.md", files: ["rounds/0002-actor-a.md"], dispatch: { plan: "PL-0001", package: "a1", files: ["src/a.js"] },
  });
  put(s.records, "rounds/0002-actor-a.md", "# R-0002-actor-a\n");
  put(s.records, "metrics/handoffs.jsonl", `${git(s.records, "show", "HEAD:metrics/handoffs.jsonl")}\n${JSON.stringify(actorH)}\n`);
  commitAll(s.records, "PL-0001 with actor done and critic pending");

  const host = { admits: true, over: [], calls: [] };
  const st1 = snapshot(s.records), pl1 = loadPlan(st1, "PL-0001");
  const ready1 = readyPlan(st1, pl1, { host, base: base0 });
  const dp1 = computeDispatchPlan({ state: st1, plan: pl1, product: s.product, base: base0, host });
  const cRow = ready1.packages.find(p => p.id === "c1"), jRow = ready1.packages.find(p => p.id === "j");
  const jWave = dp1.packages.find(p => p.id === "j");
  assert.equal(cRow.status, "ready");
  assert.equal(cRow.command, dp1.packages.find(p => p.id === "c1").dispatchCommand);
  assert.match(cRow.command, /--plan PL-0001 --package c1/);
  assert.deepEqual([jRow.status, jRow.idle, jRow.command], ["waiting", false, undefined]);
  assert.deepEqual([jWave.status, jWave.idle, jWave.dispatchCommand], ["waiting", false, undefined]);
  assert.ok(jRow.holds.some(h => h.kind === "critic" && h.release.includes("R-0002-critic-post")));
  assert.ok(dp1.judgeBlockedReasons.some(r => r.includes("R-0002-critic-post")));

  const env = { ...isolatedEnv(), SELF_LOOP_TEST: "1", SELF_LOOP_OWNER_STORE: roomyStore(), SELF_LOOP_LOAD_DIR: temp("sl-load-") };
  const verbatim = spawnSync("sh", ["-c", cRow.command], { encoding: "utf8", env });
  assert.equal(verbatim.status, 0, verbatim.stderr + verbatim.stdout);
  assert.equal(JSON.parse(verbatim.stdout).id, "R-0002-critic-post");

  const st1b = snapshot(s.records);
  const s2 = await makeWorkspace(
    { "src/a.js": "export const a = 2;\n" },
    { agents: { actor: t3("claude"), critic: t3("codex"), judge: t3("codex"), reviewer: t3("claude") } },
  );
  put(s2.records, "plans/PL-0001.md", planMd("PL-0001", [
    pkgMd("a1", { handoff: "R-0002-actor-a", files: "src/a.js" }),
    pkgMd("c1", { role: "critic", handoff: "R-0002-critic-post", files: "", needs: "a1", reviews: "a1" }),
    pkgMd("j", { role: "judge", handoff: "R-0002-judge", needs: "a1" }),
  ]));
  const base2 = git(s2.product, "rev-parse", "loop/s5");
  const actorH2 = baseHandoff({
    id: "R-0002-actor-a", step: "actor-a", role: "actor", product: { base: base2, commit: base2 },
    record: "rounds/0002-actor-a.md", files: ["rounds/0002-actor-a.md"], dispatch: { plan: "PL-0001", package: "a1", files: ["src/a.js"] },
  });
  put(s2.records, "rounds/0002-actor-a.md", "# R-0002-actor-a\n");
  put(s2.records, "metrics/handoffs.jsonl", `${git(s2.records, "show", "HEAD:metrics/handoffs.jsonl")}\n${JSON.stringify(actorH2)}\n`);
  commitAll(s2.records, "PL-0001 for prepareWave");
  const st2 = snapshot(s2.records), pl2 = loadPlan(st2, "PL-0001");
  const prepCritic = prepareWave({ cfg: s2.cfg, state: st2, plan: pl2, readyBase: base2, host });
  assert.deepEqual([prepCritic.ok, prepCritic.errors, prepCritic.prepared.map(p => p.id)], [true, [], ["c1"]]);

  const criticH2 = baseHandoff({
    id: "R-0002-critic-post", step: "critic-post", role: "critic", product: { base: base2, commit: base2 },
    record: "rounds/0002-critic-post.md", files: ["rounds/0002-critic-post.md"], dispatch: { plan: "PL-0001", package: "c1", files: [] },
  });
  put(s2.records, "rounds/0002-critic-post.md", "# R-0002-critic-post\n");
  put(s2.records, "metrics/handoffs.jsonl", `${git(s2.records, "show", "HEAD:metrics/handoffs.jsonl")}\n${JSON.stringify(criticH2)}\n`);
  commitAll(s2.records, "record critic-post");
  const st3 = snapshot(s2.records), pl3 = loadPlan(st3, "PL-0001");
  const prepJudge = prepareWave({ cfg: s2.cfg, state: st3, plan: pl3, readyBase: base2, host });
  assert.deepEqual([prepJudge.ok, prepJudge.errors, prepJudge.prepared.map(p => p.id)], [true, [], ["j"]]);
  assert.equal(validateDispatchCall({ cfg: s.cfg, state: st1b, planId: "PL-0001", packageId: "j", role: "judge", step: "judge", round: 2, base: base0, prepared: [] }).ok, false);
});

test("D-0068: recordWave honors explicit agent.adapter when provider name does not imply adapter", async () => {
  const codexHome = temp("disp-custom-adapter-");
  const prevCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const s = await makeWorkspace(
      { "src/custom.js": "export const c = 1;\n" },
      { agents: { actor: { runner: "t3", provider: "custom-router", adapter: "codex", model: "gpt-5.4" }, critic: { runner: "cmd", cmd: ["true"] }, judge: { runner: "cmd", cmd: ["true"] } } },
    );
    put(s.records, "plans/PL-0001.md", planMd("PL-0001", [
      pkgMd("a1", { handoff: "R-0002-actor-a", files: "src/custom.js" }),
      pkgMd("c1", { role: "critic", handoff: "R-0002-critic-a", files: "", needs: "a1", reviews: "a1" }),
    ]));
    put(s.cfg.workDir, "tasks/R-0002-actor-a.md", "features: F-0001\nEdit custom.js\n");
    commitAll(s.records, "PL-0001 custom adapter");
    const st = snapshot(s.records), pl = loadPlan(st, "PL-0001");
    const prepRes = prepareWave({ cfg: s.cfg, state: st, plan: pl, wave: 0, host: { admits: true, over: [], calls: [] } });
    assert.equal(prepRes.ok, true, JSON.stringify(prepRes.errors));
    const prep = prepRes.prepared[0];
    put(prep.wt, "src/custom.js", "export const c = 2;\n");
    put(prep.ws, "out/report.md", "Done.\n");
    const { preparedAt } = JSON.parse(readFileSync(join(prep.ws, "call.json"), "utf8"));
    const now = new Date(preparedAt + 1000), pad = n => String(n).padStart(2, "0");
    const rollDir = join(codexHome, "sessions", String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
    mkdirSync(rollDir, { recursive: true });
    const roll = join(rollDir, `rollout-${prep.nonce}.jsonl`);
    writeFileSync(roll, [
      { timestamp: now.toISOString(), type: "session_meta", payload: { cwd: prep.wt, id: "cx-custom-1" } },
      { timestamp: now.toISOString(), type: "turn_context", payload: { cwd: prep.wt, model: "gpt-5.4" } },
      { timestamp: now.toISOString(), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prep.prompt }] } },
      { timestamp: now.toISOString(), type: "event_msg", payload: { type: "task_complete" } },
    ].map(r => JSON.stringify(r)).join("\n") + "\n");
    const sec = Math.ceil((preparedAt + 1000) / 1000);
    utimesSync(roll, sec, sec);
    const rec = recordWave({ cfg: s.cfg, state: st, plan: pl, wave: 0 });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal(rec.recorded.length, 1);
    assert.equal(rec.recorded[0].session, "cx-custom-1");
  } finally {
    if (prevCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodex;
  }
});
