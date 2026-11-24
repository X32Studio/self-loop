// P-0012, D-0059, design/parallel-dispatch.md#4
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { EXIT } from "../call.mjs";
import { buildImportGraph } from "../lib/arch-facts.mjs";
import {
  analyzeDecoupling, computeDispatchPlan,
  integrateWave, readPlanWindow, renderDispatchLines, reviewCoverage, validateDispatchCall,
} from "../lib/dispatch.mjs";
import { validateHandoff } from "../lib/handoff.mjs";
import { loadPlan, parsePlan, snapshot, validatePlan } from "../lib/plan.mjs";
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

async function makeWorkspace(productFiles = {}, { agents = {}, scenario = {}, recordFiles = {} } = {}) {
  const s = await setup(scenario, {
    plans: false,
    owns: { critic: ["test"], actor: ["src"] },
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
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a + 1;\n',
    "src/c.mjs": 'import { b } from "./b";\nexport { a } from "./a.mjs";\nexport const c = b;\n',
    "test/a.test.mjs": 'import { a } from "../src/a.mjs";\nconsole.log(a);\n',
  });
  const g = buildImportGraph(r, git(r, "rev-parse", "HEAD"));
  assert.deepEqual(g.files, ["src/a.mjs", "src/b.mjs", "src/c.mjs"]);
  assert.deepEqual(g.edges, [
    { from: "src/b.mjs", to: "src/a.mjs" },
    { from: "src/c.mjs", to: "src/a.mjs" },
    { from: "src/c.mjs", to: "src/b.mjs" },
  ]);
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
  const s = await makeWorkspace({
    "src/a.mjs": "export const a = 1;\n",
    "src/b.mjs": 'import { a } from "./a.mjs";\nexport const b = a + 1;\n',
    "src/c.mjs": "export const c = 3;\n",
  });
  const base = git(s.product, "rev-parse", "loop/s5"), st = snapshot(s.records);
  const plan = {
    id: "PL-0001", scope: "S5/r2", phase: "S5",
    packages: [
      { id: "a", role: "actor", files: ["src/a.mjs"], interface: "D-0001", needs: [], handoff: "R-0002-actor-a" },
      { id: "b", role: "actor", files: ["src/b.mjs"], interface: "no pointer", needs: [], handoff: "R-0002-actor-b" },
      { id: "c", role: "actor", files: ["src/c.mjs"], interface: "design/api.md#v1", needs: [], handoff: "R-0002-actor-c" },
      { id: "d", role: "actor", files: ["src/c.mjs"], interface: "D-0001", needs: [], handoff: "R-0002-actor-d" },
    ],
  };
  const res = analyzeDecoupling({ plan, product: s.product, base, state: st });
  const kindOf = (r, l, ri) => r.pairs.find(p => p.left === l && p.right === ri)?.kind;
  assert.equal(kindOf(res, "a", "b"), "undeclared-coupled");
  assert.equal(kindOf(res, "a", "c"), "decoupled");
  assert.equal(kindOf(res, "c", "d"), "write-coupled");
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
  assert.equal(unified.topology, "unified");
  assert.equal(unified.required, true);
  const parallel = reviewCoverage(mk([
    a, b,
    { id: "ca", role: "critic", files: ["test/a.test.js"], needs: ["a"], reviews: ["a"], handoff: "R-0002-critic-ca" },
    { id: "cb", role: "critic", files: ["test/b.test.js"], needs: ["b"], reviews: ["b"], handoff: "R-0002-critic-cb" },
  ]));
  assert.equal(parallel.topology, "parallel");
  const partial = reviewCoverage(mk([a, b, { id: "ca", role: "critic", files: ["test/a.test.js"], needs: ["a"], handoff: "R-0002-critic-ca" }]), { window: { mode: "slack" } });
  assert.equal(partial.topology, "partial");
  assert.deepEqual(partial.uncoveredActors, ["b"]);
  assert.equal(partial.required, false);
  assert.equal(reviewCoverage(mk([a])).topology, "none");
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
  const judgeOk = s.run("judge", { round: 2, step: "judge", plan: "PL-0001", package: "j", base: merged.commit });
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
