// F-0009, D-0016, D-0062, D-0066, D-0068, design/paseo-and-judge-policy.md#1
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { EXIT, normalize } from "../call.mjs";
import { policyOf } from "../gated-push.mjs";
import { verifyProvenance, verifyWaveGate } from "../lib/provenance.mjs";
import {
  independenceModel,
  JUDGE_INDEPENDENCE_POLICIES,
  judgeIndependenceProblem,
  modelVendor,
  normalizeModelName,
  observedModelsOf,
  priorConvergedCommits,
  unjudgedCoveringActors,
  validateJudgeIndependence,
  validateModelVendors,
  vendorOfModel,
  waveIndependenceProblem,
} from "../lib/vendor.mjs";
import { closeWindow, openWindow, WindowRefusalError } from "../lib/window.mjs";
import { fakeGh, git, green, isolatedEnv, ownerStore, repo, scripts, temp } from "./helpers.mjs";

const ag = (model, observedModels = [model]) => ({
  runner: "t3:antigravity",
  model,
  observedModel: observedModels[0] ?? null,
  observedModels,
});

test("JUDGE_INDEPENDENCE_POLICIES and validateJudgeIndependence fail closed on invalid values", () => {
  assert.deepEqual(JUDGE_INDEPENDENCE_POLICIES, ["vendor", "model", "session"]);
  assert.equal(Object.isFrozen(JUDGE_INDEPENDENCE_POLICIES), true);
  assert.deepEqual(validateJudgeIndependence(undefined), { ok: true, policy: "vendor", error: null });
  assert.deepEqual(validateJudgeIndependence("vendor"), { ok: true, policy: "vendor", error: null });
  assert.deepEqual(validateJudgeIndependence("model"), { ok: true, policy: "model", error: null });
  assert.deepEqual(validateJudgeIndependence("session"), { ok: true, policy: "session", error: null });
  for (const bad of [null, "", "MODEL", "VENDOR", "SESSION", "none", "any", false, true, 0, 1, {}, []]) {
    const res = validateJudgeIndependence(bad);
    assert.equal(res.ok, false, JSON.stringify(bad));
    assert.equal(res.policy, null);
    assert.match(res.error, /invalid judgeIndependence/);
  }
});

test("vendorOfModel, observedModelsOf, modelVendor, and independenceModel harden observedModels fail-closed", () => {
  assert.equal(vendorOfModel("gemini-2.5-flash-lite-high"), "google");
  assert.equal(vendorOfModel("Claude-Opus-4-6"), "anthropic");
  assert.equal(vendorOfModel("gpt-5.4"), "openai");
  assert.equal(vendorOfModel("custom-unknown"), null);

  assert.deepEqual(observedModelsOf({ observedModels: [" gemini-2.5-flash-high "] }), ["gemini-2.5-flash-high"]);
  assert.deepEqual(observedModelsOf({ observedModel: "gpt-5.4" }), ["gpt-5.4"]);
  assert.deepEqual(observedModelsOf({}), []);

  assert.equal(modelVendor(ag("gemini-2.5-flash-lite-high")), "google");
  assert.equal(independenceModel(ag("gemini-2.5-flash-lite-high")), "gemini-2.5-flash-lite-high");
  assert.equal(modelVendor(ag("gemini-2.5-flash-lite-high", ["gemini-2.5-flash-lite-high", "Gemini-2.5-Flash-Lite-High"])), "google");
  assert.equal(independenceModel(ag("gemini-2.5-flash-lite-high", ["gemini-2.5-flash-lite-high", "Gemini-2.5-Flash-Lite-High"])), "gemini-2.5-flash-lite-high");

  const invalidAgents = [
    null,
    {},
    ag("gemini-2.5-flash-lite-high", []),
    ag("gemini-2.5-flash-lite-high", ["gemini-2.5-flash-lite-high", ""]),
    ag("gemini-2.5-flash-lite-high", ["gemini-2.5-flash-lite-high", "   "]),
    ag("gemini-2.5-flash-lite-high", ["gemini-2.5-flash-lite-high", null]),
    ag("gemini-2.5-flash-lite-high", ["gemini-2.5-flash-lite-high", "gemini-2.5-flash-high"]),
    ag("custom-unknown", ["custom-unknown"]),
    { runner: "t3:antigravity", model: "gemini-2.5-flash-lite-high" },
    { runner: "t3:antigravity", observedModels: "gemini-2.5-flash-lite-high" },
  ];
  for (const agent of invalidAgents) {
    assert.equal(modelVendor(agent), null, JSON.stringify(agent));
    assert.equal(independenceModel(agent), null, JSON.stringify(agent));
  }

  assert.equal(modelVendor({ runner: "claude", model: "claude-opus-4-6" }), "anthropic");
  assert.equal(independenceModel({ runner: "claude", model: "claude-opus-4-6" }), "claude-opus-4-6");
  assert.equal(modelVendor({ runner: "claude", model: "fixture-actor" }), "anthropic");
  assert.equal(independenceModel({ runner: "claude", model: "fixture-actor" }), "fixture-actor");
  assert.equal(modelVendor({ runner: "t3:codex", observedModel: "gpt-5.4" }), "openai");
  assert.equal(independenceModel({ runner: "t3:codex", observedModel: "gpt-5.4" }), "gpt-5.4");
  assert.equal(modelVendor({ runner: "codex", observedModel: "mystery-model-xyz" }), null);
  assert.equal(independenceModel({ runner: "codex", observedModel: "mystery-model-xyz" }), null);
  assert.equal(modelVendor({ runner: "claude", observedModel: "mystery-model-xyz" }), null);
  assert.equal(independenceModel({ runner: "claude", observedModel: "mystery-model-xyz" }), null);
});

test("judgeIndependenceProblem enforces vendor default, model opt-in, case-insensitive model overlap, and fail-closed inputs", () => {
  const flash = ag("gemini-2.5-flash-high");
  const liteModel = ag("gemini-2.5-flash-lite-high");
  const flashCase = ag("Gemini-2.5-Flash-High");
  const codex = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4"] };

  assert.equal(judgeIndependenceProblem(codex, flash), null);
  assert.equal(judgeIndependenceProblem(codex, flash, "vendor"), null);
  assert.equal(judgeIndependenceProblem(codex, flash, "model"), null);

  assert.match(judgeIndependenceProblem(liteModel, flash), /same-vendor judge/);
  assert.match(judgeIndependenceProblem(liteModel, flash, "vendor"), /same-vendor judge/);
  assert.match(judgeIndependenceProblem(flash, flash), /same-vendor judge/);
  assert.match(judgeIndependenceProblem(flashCase, flash, "vendor"), /same-vendor judge/);
  assert.equal(judgeIndependenceProblem(liteModel, flash, "model"), null);

  assert.match(judgeIndependenceProblem(flash, flash, "model"), /same-model judge/);
  assert.match(judgeIndependenceProblem(flashCase, flash, "model"), /same-model judge/);
  assert.match(
    judgeIndependenceProblem({ runner: "custom-a", model: "shared-m" }, { runner: "custom-b", model: "Shared-M" }, "vendor"),
    /same-model judge/,
  );

  assert.match(judgeIndependenceProblem(ag("gemini-2.5-flash-lite-high", []), flash, "model"), /judge has unknown/);
  assert.match(judgeIndependenceProblem(liteModel, ag("gemini-2.5-flash-high", []), "model"), /actor has unknown/);
  assert.match(judgeIndependenceProblem(ag("x", ["gemini-2.5-flash-lite-high", "gemini-2.5-flash-high"]), flash, "model"), /judge has unknown/);
  assert.match(judgeIndependenceProblem({ runner: "t3:codex", model: "gpt-5.4", observedModel: null }, flash, "model"), /judge has unknown/);
  assert.match(judgeIndependenceProblem(liteModel, { runner: "t3:claude", model: "claude-opus-4-6", observedModel: null }, "model"), /actor has unknown/);
  assert.match(judgeIndependenceProblem({ runner: "codex", observedModel: "mystery-model-xyz" }, flash, "vendor"), /judge has unknown/);
  assert.match(judgeIndependenceProblem({ runner: "codex", observedModel: "mystery-model-xyz" }, flash, "model"), /judge has unknown/);
  assert.equal(judgeIndependenceProblem({ runner: "codex", model: "gpt-5.4" }, { runner: "claude", model: "fixture-actor" }, "vendor"), null);
  assert.match(judgeIndependenceProblem(liteModel, flash, "none"), /invalid judgeIndependence/);
  assert.match(judgeIndependenceProblem(liteModel, flash, null), /invalid judgeIndependence/);
});

test("unjudgedCoveringActors, priorConvergedCommits, and waveIndependenceProblem enforce multi-actor wave coverage", () => {
  const liteModel = ag("gemini-2.5-flash-lite-high"), flash = ag("gemini-2.5-flash-high"), proExp = ag("gemini-2.5-pro-exp-high");
  const order = ["c1", "c2", "c3"];
  const isAncestor = (a, b) => order.indexOf(a) >= 0 && order.indexOf(b) >= 0 && order.indexOf(a) <= order.indexOf(b);
  const a1 = { id: "R-0002-actor-a", role: "actor", round: 2, agent: liteModel, product: { commit: "c1" } };
  const a2 = { id: "R-0003-actor-b", role: "actor", round: 3, agent: flash, product: { commit: "c2" } };
  const jOverlap = { id: "R-0004-judge", role: "judge", round: 4, agent: liteModel, product: { base: "c2", commit: "c2" } };
  const jDistinct = { id: "R-0004-judge", role: "judge", round: 4, agent: proExp, product: { base: "c2", commit: "c2" } };

  assert.deepEqual(unjudgedCoveringActors({ actors: [a1, a2], targetCommit: "c2", isAncestor }).map(a => a.id), ["R-0002-actor-a", "R-0003-actor-b"]);
  assert.deepEqual(unjudgedCoveringActors({ actors: [a1, a2], targetCommit: "c2", priorConvergedCommits: ["c1"], isAncestor }).map(a => a.id), ["R-0003-actor-b"]);
  assert.deepEqual(unjudgedCoveringActors({ actors: [a1], targetCommit: "c2", priorConvergedCommits: ["c1"], isAncestor }).map(a => a.id), ["R-0002-actor-a"]);

  assert.match(waveIndependenceProblem({ judge: jOverlap, actors: [a1, a2], targetCommit: "c2", isAncestor, policy: "model" }), /R-0002-actor-a.*same-model judge/);
  assert.equal(waveIndependenceProblem({ judge: jDistinct, actors: [a1, a2], targetCommit: "c2", isAncestor, policy: "model" }), null);

  const j1Good = { id: "R-0002-judge", role: "judge", round: 2, agent: flash, product: { base: "c1", commit: "c1" } };
  const j1Bad = { id: "R-0002-judge", role: "judge", round: 2, agent: liteModel, product: { base: "c1", commit: "c1" } };
  const r1 = { round: 2, role: "judge", verdict: "CONVERGED", commit: "c1", suite: "1/0" };
  const r2 = { round: 3, role: "judge", verdict: "CONVERGED", commit: "c2", suite: "1/0" };
  const j2 = { id: "R-0003-judge", role: "judge", round: 3, agent: liteModel, product: { base: "c2", commit: "c2" } };

  const validPriors = priorConvergedCommits({ rows: [r1, r2], judges: [j1Good, j2], actors: [a1, a2], targetCommit: "c2", targetRuling: r2, isAncestor, policy: "model" });
  assert.deepEqual(validPriors, ["c1"]);
  assert.equal(waveIndependenceProblem({ judge: j2, actors: [a1, a2], targetCommit: "c2", priorConvergedCommits: validPriors, isAncestor, policy: "model" }), null);

  const forgedPriors = priorConvergedCommits({ rows: [r1, r2], judges: [j1Bad, j2], actors: [a1, a2], targetCommit: "c2", targetRuling: r2, isAncestor, policy: "model" });
  assert.deepEqual(forgedPriors, []);
  assert.match(waveIndependenceProblem({ judge: j2, actors: [a1, a2], targetCommit: "c2", priorConvergedCommits: forgedPriors, isAncestor, policy: "model" }), /R-0002-actor-a.*same-model judge/);
});

test("call.mjs normalize and gated-push.mjs policyOf validate judgeIndependence fail-closed", () => {
  const baseCfg = {
    product: "/tmp/p",
    records: "/tmp/r",
    workDir: "/tmp/w",
    phase: "v1",
    briefs: {},
    agents: {},
  };
  assert.equal(normalize(baseCfg).judgeIndependence, undefined);
  assert.equal(normalize({ ...baseCfg, judgeIndependence: "vendor" }).judgeIndependence, "vendor");
  assert.equal(normalize({ ...baseCfg, judgeIndependence: "model" }).judgeIndependence, "model");
  for (const bad of ["none", "", null, "MODEL", false]) {
    assert.throws(
      () => normalize({ ...baseCfg, judgeIndependence: bad }),
      err => err.code === EXIT.usage && /invalid judgeIndependence/.test(err.message),
    );
    const pol = policyOf({ protected: ["main"], gates: { require: [] }, judgeIndependence: bad });
    assert.match(pol.refused ?? "", /invalid judgeIndependence/);
  }
  assert.equal(policyOf({ protected: ["main"], gates: { require: [] }, judgeIndependence: "model" }).refused, undefined);
});

test("judgeIndependence end-to-end across provenance, gated-push, loop next, and window close", t => {
  const dir = realpathSync(temp("vendor-e2e-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const json = v => JSON.stringify(v, null, 2) + "\n";
  const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  const mk = (files, d) => { mkdirSync(d, { recursive: true }); return repo(files, d); };
  const product = mk({ "README.md": "# Policy\n", "VERSION": "0.1.0\n" }, join(dir, "product"));
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/policy.git");
  mkdirSync(join(product, "scripts"), { recursive: true });
  writeFileSync(join(product, "scripts", "a.mjs"), "export const a = 1;\n");
  git(product, "add", "scripts/a.mjs");
  git(product, "commit", "-qm", "feature");
  const commit = git(product, "rev-parse", "HEAD");
  git(product, "branch", "-f", "loop/v1", commit);
  const tree = git(product, "rev-parse", `${commit}^{tree}`);
  const records = join(dir, "records");
  const workDir = join(dir, "work");
  const loadDir = join(dir, "load");
  mkdirSync(workDir, { recursive: true });
  mkdirSync(loadDir, { recursive: true });
  const flash = ag("gemini-2.5-flash-high");
  const liteModel = ag("gemini-2.5-flash-lite-high");
  const codex = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4"] };
  const makeLoop = ji => ({
    product, records, workDir, branch: "loop/v1", phase: "v1", briefs: {},
    agents: { actor: flash, critic: codex, judge: liteModel },
    protected: ["main"], gates: { remote: "origin", require: ["github-actions/verify"] },
    provenanceBaseline: baseline,
    ...(ji !== undefined ? { judgeIndependence: ji } : {}),
  });
  const plan = [
    "# PL-0001 Plan", "scope: policy/v1", "phase: v1", "",
    "## actor", "role: actor", "handoff: R-0002-actor", "authority: D-0062", "goal: Actor", "files: scripts/a.mjs", "interface: D-0062", "acceptance: pass", "needs: ", "",
    "## critic", "role: critic", "handoff: R-0002-critic", "authority: D-0062", "goal: Critic", "files: acceptance/a.test.mjs", "interface: D-0062", "acceptance: pass", "needs: actor", "reviews: actor", "",
    "## judge", "role: judge", "handoff: R-0003-judge", "authority: D-0062", "goal: Judge", "files: ", "interface: D-0062", "acceptance: pass", "needs: critic", "",
  ].join("\n");
  mk({
    "README.md": "# Records\n", "records.json": "{}\n", "loop.json": json(makeLoop("model")),
    "purpose/P-0001.md": "# P-0001 Purpose\n\nstatus: active\n",
    "decisions/D-0062.md": "# D-0062 Policy\n\nid: D-0062\nby: owner\nstatus: active\n",
    "blueprint/F-0009.md": "# F-0009 Policy\n\nid: F-0009\nphase: v1\nrequirements: P-0001\n",
    "metrics/blueprint.jsonl": jsonl({ feature: "F-0009", phase: "v1", status: "done", time: "2026-11-26T02:05:00Z", by: "lead", note: "done", evidence: { round: "R-0003-judge", commit, ci: "evidence/0003/ci.json" } }),
    "plans/PL-0001.md": plan,
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nphase: v1\nrole: reviewer\n",
    "rounds/0002-actor.md": "# R-0002-actor\n",
    "rounds/0002-critic.md": "# R-0002-critic\n",
    "rounds/0003-judge.md": "# R-0003-judge\n",
    "sealed/judge/0003/judge-1.md": "# R-0003-judge\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n",
    "evidence/0003/suite-1.json": JSON.stringify({ repository: product, sha: commit, tree, green: true }),
    "evidence/0003/ci.json": JSON.stringify({ repository: "example/policy", sha: commit, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } }),
    "metrics/handoffs.jsonl": jsonl(
      { id: "R-0001-reviewer-frame", time: "2026-11-26T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: codex, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] },
      { id: "R-0002-actor", time: "2026-11-26T01:00:00Z", phase: "v1", round: 2, step: "actor", role: "actor", attempt: 1, agent: flash, view: "a".repeat(40), product: { base: baseline, commit }, audit: { violations: 0 }, record: "rounds/0002-actor.md", files: ["rounds/0002-actor.md"], dispatch: { plan: "PL-0001", package: "actor", files: ["scripts/a.mjs"] } },
      { id: "R-0002-critic", time: "2026-11-26T01:10:00Z", phase: "v1", round: 2, step: "critic", role: "critic", attempt: 1, agent: codex, view: "a".repeat(40), product: { base: commit, commit }, audit: { violations: 0 }, record: "rounds/0002-critic.md", files: ["rounds/0002-critic.md"], dispatch: { plan: "PL-0001", package: "critic", files: ["acceptance/a.test.mjs"] } },
      { id: "R-0003-judge", time: "2026-11-26T02:00:00Z", phase: "v1", round: 3, step: "judge", role: "judge", attempt: 1, agent: liteModel, view: "a".repeat(40), product: { base: commit, commit }, audit: { violations: 0 }, record: "rounds/0003-judge.md", files: ["rounds/0003-judge.md", "sealed/judge/0003/judge-1.md"], dispatch: { plan: "PL-0001", package: "judge", files: [] } },
    ),
    "metrics/trajectory.jsonl": jsonl({ round: 3, phase: "v1", role: "judge", area: "policy", verdict: "CONVERGED", commit, suite: "1/0", ci: "success", ciReceipt: "evidence/0003/ci.json", time: "2026-11-26T02:00:00Z" }),
  }, records);
  assert.equal(spawnSync(process.execPath, [join(scripts, "records-check.mjs"), "--repo", records, "--write"], { encoding: "utf8" }).status, 0);
  git(records, "add", "-A");
  git(records, "commit", "-qm", "init");
  const { event: win } = openWindow(records, { phase: "v1", startRound: 2, horizon: 2, goal: "Model opt-in", invariants: ["Suite green"] });
  const gh = fakeGh({ "example/policy": { [commit]: [green()] } });
  t.after(() => rmSync(gh.bin, { recursive: true, force: true }));
  const storeDir = join(dir, "store");
  mkdirSync(storeDir, { recursive: true });
  const store = ownerStore([{ name: "policy", records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } });
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir, PATH: `${gh.bin}${delimiter}${process.env.PATH}` });
  const run = (script, args) => spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", env });

  assert.equal(verifyProvenance({ repo: product, records, sha: commit, branch: "loop/v1" }).ok, true);
  assert.equal(run("gated-push.mjs", ["--verify-only", "--repo", product, "--branch", "loop/v1", "--sha", commit, "--owner-store", store]).status, 0);
  assert.equal(run("window.mjs", ["close", "--records", records, "--id", win.id, "--verdict", "verified", "--commit", commit]).status, 0);
  const nextOk = run("loop.mjs", ["next", "--config", join(records, "loop.json")]);
  assert.equal(nextOk.status, 0, nextOk.stderr);
  assert.match(nextOk.stdout, /The recorded convergence checks are satisfied/);

  writeFileSync(join(records, "loop.json"), json(makeLoop("vendor")));
  git(records, "add", "loop.json");
  git(records, "commit", "-qm", "set vendor");
  assert.equal(verifyProvenance({ repo: product, records, sha: commit, branch: "loop/v1" }).ok, false);
  assert.equal(run("gated-push.mjs", ["--verify-only", "--repo", product, "--branch", "loop/v1", "--sha", commit, "--owner-store", store]).status, 2);
  assert.match(run("loop.mjs", ["next", "--config", join(records, "loop.json")]).stdout, /judge\/actor independence needs confirmation/);
  const { event: win2 } = openWindow(records, { phase: "v1", startRound: 2, horizon: 2, goal: "Vendor default", invariants: ["Suite green"] });
  assert.throws(() => closeWindow(records, { id: win2.id, commit, verdict: "verified" }), WindowRefusalError);

  for (const bad of ["none", "", null, "MODEL", false]) {
    assert.equal(verifyProvenance({ repo: product, records, sha: commit, cfg: { provenanceBaseline: null, judgeIndependence: bad } }).ok, false);
    assert.equal(verifyWaveGate({ repo: product, records, sha: commit, branch: "loop/v1", cfg: { provenanceBaseline: null, judgeIndependence: bad } }).ok, false);
  }
});

test("baseline-bounded unjudgedCoveringActors, historical vendor priorConvergedCommits, and multi-model Codex/Claude rejection", () => {
  const liteModel = ag("gemini-2.5-flash-lite-high"), flash = ag("gemini-2.5-flash-high");
  const order = ["b0", "b1", "c1", "c2"];
  const isAncestor = (a, b) => order.indexOf(a) >= 0 && order.indexOf(b) >= 0 && order.indexOf(a) <= order.indexOf(b);
  const histActor = { id: "R-0002-actor-hist", role: "actor", round: 2, agent: liteModel, product: { commit: "b1" } };
  const curActor = { id: "R-0003-actor", role: "actor", round: 3, agent: flash, product: { commit: "c1" } };
  const curActorOverlap = { id: "R-0004-actor-b", role: "actor", round: 4, agent: liteModel, product: { commit: "c2" } };
  const histVendorJudge = { id: "R-0002-judge", role: "judge", round: 2, agent: { runner: "codex", model: "gpt-5.4" }, product: { base: "b1", commit: "b1" } };
  const curModelJudge = { id: "R-0004-judge", role: "judge", round: 4, agent: liteModel, product: { base: "c1", commit: "c1" } };
  const rHist = { round: 2, role: "judge", verdict: "CONVERGED", commit: "b1", suite: "1/0" };
  const rCur = { round: 4, role: "judge", verdict: "CONVERGED", commit: "c1", suite: "1/0" };

  assert.deepEqual(unjudgedCoveringActors({ actors: [histActor, curActor], targetCommit: "c1", isAncestor, baseline: "b1" }).map(a => a.id), ["R-0003-actor"]);
  assert.deepEqual(unjudgedCoveringActors({ actors: [histActor, curActor], targetCommit: "b1", isAncestor, baseline: "b1" }).map(a => a.id), ["R-0002-actor-hist"]);
  assert.deepEqual(
    priorConvergedCommits({ rows: [rHist, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetRuling: rCur, isAncestor, policy: "model", baseline: "b1" }),
    [],
  );
  assert.deepEqual(
    priorConvergedCommits({ rows: [rHist, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetRuling: rCur, isAncestor, policy: "model", baseline: "b1", rulingPolicies: () => ["vendor"] }),
    ["b1"],
  );
  assert.deepEqual(
    priorConvergedCommits({ rows: [rHist, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetRuling: rCur, isAncestor, policy: "model", baseline: "b1", rulingPolicies: () => ["vendor", "model"] }),
    [],
  );
  for (const badRes of [null, [], [undefined], ["none"], ["vendor", "invalid"]]) {
    assert.deepEqual(
      priorConvergedCommits({ rows: [rHist, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetRuling: rCur, isAncestor, policy: "model", baseline: "b1", rulingPolicies: () => badRes }),
      [],
      JSON.stringify(badRes),
    );
  }
  assert.deepEqual(
    priorConvergedCommits({ rows: [{ ...rHist, tip: "c1" }, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetRuling: rCur, isAncestor, policy: "vendor", rulingPolicies: () => ["vendor"] }),
    [],
  );
  assert.deepEqual(
    priorConvergedCommits({ rows: [rHist, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "b1", isAncestor, policy: "vendor", rulingPolicies: () => ["vendor"] }),
    [],
  );
  assert.deepEqual(
    priorConvergedCommits({ rows: [rHist, rCur], judges: [histVendorJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetJudge: histVendorJudge, isAncestor, policy: "vendor", rulingPolicies: () => ["vendor"] }),
    [],
  );
  assert.equal(
    waveIndependenceProblem({ judge: curModelJudge, actors: [histActor, curActor], targetCommit: "c1", priorConvergedCommits: ["b1"], isAncestor, policy: "model", baseline: "b1" }),
    null,
  );
  assert.match(
    waveIndependenceProblem({ judge: curModelJudge, actors: [histActor, curActor, curActorOverlap], targetCommit: "c2", priorConvergedCommits: ["b1"], isAncestor, policy: "model", baseline: "b1" }),
    /R-0004-actor-b.*same-model judge/,
  );

  const forgedHistJudge = { id: "R-0002-judge", role: "judge", round: 2, agent: liteModel, product: { base: "b1", commit: "b1" } };
  assert.deepEqual(
    priorConvergedCommits({ rows: [rHist, rCur], judges: [forgedHistJudge, curModelJudge], actors: [histActor, curActor], targetCommit: "c1", targetRuling: rCur, isAncestor, policy: "model" }),
    [],
  );

  const codexSwitch = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4", "gpt-5.4-pro"] };
  const claudeSwitch = { runner: "t3:claude", model: "claude-opus-4-6", observedModel: "claude-opus-4-6", observedModels: ["claude-opus-4-6", "claude-sonnet-5-5"] };
  const codexSingle = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4"] };
  const codexActor = { runner: "t3:codex", model: "gpt-5.4-pro", observedModel: "gpt-5.4-pro", observedModels: ["gpt-5.4-pro"] };
  for (const pol of ["vendor", "model"]) {
    assert.match(judgeIndependenceProblem(codexSwitch, flash, pol), /judge has unknown/);
    assert.match(judgeIndependenceProblem(claudeSwitch, flash, pol), /judge has unknown/);
    assert.match(judgeIndependenceProblem(liteModel, codexSwitch, pol), /actor has unknown/);
  }
  assert.equal(judgeIndependenceProblem(codexSingle, codexActor, "model"), null);
  assert.equal(judgeIndependenceProblem(codexSingle, flash, "vendor"), null);
});

test("D-0064 T10: independent no-dispute critic satisfies judgeIndependence across vendor and model policies on protected gated-push without judge", t => {
  const dir = realpathSync(temp("vendor-nodispute-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const json = v => JSON.stringify(v, null, 2) + "\n";
  const jsonl = (...rows) => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  const mk = (files, d) => { mkdirSync(d, { recursive: true }); return repo(files, d); };
  const product = mk({ "README.md": "# Policy\n", "VERSION": "0.1.0\n" }, join(dir, "product"));
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "remote", "add", "origin", "https://github.com/example/nodispute.git");
  mkdirSync(join(product, "scripts"), { recursive: true });
  writeFileSync(join(product, "scripts", "f.mjs"), "export const f = 1;\n");
  git(product, "add", "scripts/f.mjs");
  git(product, "commit", "-qm", "feature");
  const commit = git(product, "rev-parse", "HEAD");
  git(product, "branch", "-f", "loop/v1", commit);
  const tree = git(product, "rev-parse", `${commit}^{tree}`);
  const records = join(dir, "records"), workDir = join(dir, "work"), loadDir = join(dir, "load"), storeDir = join(dir, "store");
  for (const d of [workDir, loadDir, storeDir]) mkdirSync(d, { recursive: true });
  const flash = ag("gemini-2.5-flash");
  const proModel = ag("gemini-2.5-pro");
  const codex = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4"] };
  const makeLoop = (ji, criticAgent) => ({
    product, records, workDir, branch: "loop/v1", phase: "v1", briefs: {},
    agents: { actor: flash, critic: criticAgent },
    protected: ["main"], gates: { remote: "origin", require: ["github-actions/verify"] },
    provenanceBaseline: baseline, judgeIndependence: ji,
  });
  const plan = [
    "# PL-0001 Plan", "scope: nodispute/v1", "phase: v1", "",
    "## actor", "role: actor", "handoff: R-0002-actor", "authority: D-0064", "goal: Actor", "files: scripts/f.mjs", "interface: D-0064", "acceptance: pass", "needs: ", "",
    "## critic", "role: critic", "handoff: R-0002-critic", "authority: D-0064", "goal: Critic", "files: ", "interface: D-0064", "acceptance: pass", "needs: actor", "reviews: actor", "",
  ].join("\n");
  const mkHandoffs = criticAgent => jsonl(
    { id: "R-0001-reviewer-frame", time: "2026-11-27T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame", role: "reviewer", attempt: 1, agent: codex, view: "a".repeat(40), product: null, audit: { violations: 0 }, record: "rounds/0001-reviewer-frame.md", files: ["rounds/0001-reviewer-frame.md"] },
    { id: "R-0002-actor", time: "2026-11-27T01:00:00Z", phase: "v1", round: 2, step: "actor", role: "actor", attempt: 1, agent: flash, view: "a".repeat(40), product: { base: baseline, commit }, audit: { violations: 0 }, record: "rounds/0002-actor.md", files: ["rounds/0002-actor.md"], dispatch: { plan: "PL-0001", package: "actor", files: ["scripts/f.mjs"] } },
    { id: "R-0002-critic", time: "2026-11-27T01:10:00Z", phase: "v1", round: 2, step: "critic", role: "critic", attempt: 1, agent: criticAgent, view: "a".repeat(40), product: { base: commit, commit }, audit: { violations: 0 }, record: "rounds/0002-critic.md", files: ["rounds/0002-critic.md", "sealed/critic/0002/critic-1.md"], dispatch: { plan: "PL-0001", package: "critic", files: [] } },
  );
  mk({
    "README.md": "# Records\n", "records.json": "{}\n", "loop.json": json(makeLoop("model", proModel)),
    "decisions/D-0064.md": "# D-0064\n\nid: D-0064\nby: owner\nstatus: active\n",
    "plans/PL-0001.md": plan,
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n",
    "rounds/0002-actor.md": "# R-0002-actor\n",
    "rounds/0002-critic.md": "# R-0002-critic\n",
    "sealed/critic/0002/critic-1.md": "# R-0002-critic\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\nDISPUTES: none\nOPENED: none\n",
    "metrics/handoffs.jsonl": mkHandoffs(proModel),
    "metrics/trajectory.jsonl": "",
  }, records);
  const suiteFile = join(dir, "suite.json");
  writeFileSync(suiteFile, JSON.stringify({ repository: product, sha: commit, tree, green: true }));
  const gh = fakeGh({ "example/nodispute": { [commit]: [green()] } });
  t.after(() => rmSync(gh.bin, { recursive: true, force: true }));
  const store = ownerStore([{ name: "nodispute", records }], { dir: storeDir, bound: { maxLoadRatio: 1e9, minAvailableMemoryGB: 0 } });
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: loadDir, PATH: `${gh.bin}${delimiter}${process.env.PATH}` });
  const push = args => spawnSync(process.execPath, [join(scripts, "gated-push.mjs"), ...args], { encoding: "utf8", env });

  assert.equal(verifyProvenance({ repo: product, records, sha: commit, branch: "main" }).ok, true);
  assert.equal(push(["--verify-only", "--repo", product, "--branch", "main", "--sha", commit, "--owner-store", store]).status, 0);
  const dryModel = push(["--repo", product, "--branch", "main", "--sha", commit, "--suite-receipt", suiteFile, "--owner-store", store, "--dry-run"]);
  assert.equal(dryModel.status, 0, dryModel.stderr);
  assert.match(dryModel.stdout, /would push/);

  writeFileSync(join(records, "loop.json"), json(makeLoop("vendor", proModel)));
  git(records, "add", "loop.json");
  git(records, "commit", "-qm", "vendor policy");
  assert.equal(verifyProvenance({ repo: product, records, sha: commit, branch: "main" }).ok, false);
  assert.equal(push(["--repo", product, "--branch", "main", "--sha", commit, "--suite-receipt", suiteFile, "--owner-store", store, "--dry-run"]).status, 2);

  writeFileSync(join(records, "metrics/handoffs.jsonl"), mkHandoffs(codex));
  git(records, "add", "metrics/handoffs.jsonl");
  git(records, "commit", "-qm", "cross-vendor critic");
  assert.equal(verifyProvenance({ repo: product, records, sha: commit, branch: "main" }).ok, true);
  assert.equal(push(["--repo", product, "--branch", "main", "--sha", commit, "--suite-receipt", suiteFile, "--owner-store", store, "--dry-run"]).status, 0);
});

test("D-0066: paseo:better-paseo-antigravity enforces strict observedModels independence under vendor and model policies", () => {
  const bpa = (model, observedModels = [model]) => ({
    runner: "paseo:better-paseo-antigravity",
    model,
    observedModel: observedModels[0] ?? null,
    observedModels,
  });
  const flash = bpa("gemini-2.5-flash");
  const proModel = bpa("gemini-2.5-pro");
  const proExp = bpa("gemini-2.5-pro-exp");

  assert.equal(modelVendor(flash), "google");
  assert.equal(independenceModel(flash), "gemini-2.5-flash");
  assert.equal(modelVendor({ runner: "paseo:codex", model: "gpt-5.4" }), "openai");
  assert.equal(modelVendor({ runner: "paseo:claude", model: "claude-opus-4-6" }), "anthropic");

  assert.equal(judgeIndependenceProblem(proModel, flash, "model"), null);
  assert.equal(judgeIndependenceProblem(proExp, flash, "model"), null);
  assert.match(judgeIndependenceProblem(proExp, flash, "vendor"), /same-vendor judge/);
  assert.match(judgeIndependenceProblem(flash, flash, "model"), /same-model judge/);
  assert.match(judgeIndependenceProblem(bpa("Gemini-2.5-Flash"), flash, "model"), /same-model judge/);

  const missingObs = [
    { runner: "paseo:better-paseo-antigravity", model: "gemini-2.5-pro-exp" },
    { runner: "paseo", provider: "better-paseo-antigravity", model: "gemini-2.5-pro-exp" },
    bpa("gemini-2.5-pro-exp", []),
    bpa("gemini-2.5-pro-exp", ["gemini-2.5-pro-exp", "gemini-2.5-flash"]),
  ];
  for (const bad of missingObs) {
    assert.equal(modelVendor(bad), null, JSON.stringify(bad));
    assert.equal(independenceModel(bad), null, JSON.stringify(bad));
    assert.match(judgeIndependenceProblem(bad, flash, "model"), /judge has unknown/);
    assert.match(judgeIndependenceProblem(bad, flash, "vendor"), /judge has unknown/);
    assert.match(judgeIndependenceProblem(proExp, bad, "model"), /actor has unknown/);
  }

  const order = ["c1"];
  const isAncestor = (a, b) => order.indexOf(a) >= 0 && order.indexOf(b) >= 0 && order.indexOf(a) <= order.indexOf(b);
  const actorH = { id: "R-0052-actor", role: "actor", round: 52, agent: flash, product: { commit: "c1" } };
  const judgeOk = { id: "R-0052-judge", role: "judge", round: 52, agent: proExp, product: { base: "c1", commit: "c1" } };
  const criticOk = { id: "R-0052-critic", role: "critic", round: 52, agent: proModel, product: { base: "c1", commit: "c1" } };
  const judgeSame = { id: "R-0052-judge", role: "judge", round: 52, agent: flash, product: { base: "c1", commit: "c1" } };
  const judgeNoObs = { id: "R-0052-judge", role: "judge", round: 52, agent: { runner: "paseo:better-paseo-antigravity", model: "gemini-2.5-pro-exp" }, product: { base: "c1", commit: "c1" } };

  assert.equal(waveIndependenceProblem({ judge: judgeOk, actors: [actorH], targetCommit: "c1", isAncestor, policy: "model" }), null);
  assert.equal(waveIndependenceProblem({ judge: criticOk, actors: [actorH], targetCommit: "c1", isAncestor, policy: "model" }), null);
  assert.match(waveIndependenceProblem({ judge: judgeSame, actors: [actorH], targetCommit: "c1", isAncestor, policy: "model" }), /same-model judge/);
  assert.match(waveIndependenceProblem({ judge: judgeNoObs, actors: [actorH], targetCommit: "c1", isAncestor, policy: "model" }), /unknown vendor\/model/);
});

test("D-0068: vendorOfModel strips router prefixes, supports major families, custom modelVendors, and explicit agent.vendor", () => {
  assert.equal(vendorOfModel("openrouter/gemini-2.5-pro-exp"), "google");
  assert.equal(vendorOfModel("openrouter/anthropic/claude-opus-4-6"), "anthropic");
  assert.equal(vendorOfModel("openai/o3-pro"), "openai");
  assert.equal(vendorOfModel("xai/grok-4"), "xai");
  assert.equal(vendorOfModel("alibaba/qwen-3-coder"), "alibaba");
  assert.equal(vendorOfModel("deepseek-r1"), "deepseek");
  assert.equal(vendorOfModel("minimax-m1"), "minimax");
  assert.equal(vendorOfModel("glm-4.5"), "zhipu");
  assert.equal(vendorOfModel("kimi-k2"), "moonshot");
  assert.equal(vendorOfModel("moonshot-v1-128k"), "moonshot");
  assert.equal(vendorOfModel("meta-llama/llama-4-maverick"), "meta");
  assert.equal(vendorOfModel("mistral-large"), "mistral");
  assert.equal(vendorOfModel("mixtral-8x22b"), "mistral");
  assert.equal(vendorOfModel("codestral-latest"), "mistral");

  const custom = { "acme-": "acme", "acme-v2": "acme-special", "router/priv": "private-co" };
  assert.equal(vendorOfModel("acme-v1", custom), "acme");
  assert.equal(vendorOfModel("acme-v2", custom), "acme-special");
  assert.equal(vendorOfModel("gateway/acme-v1", custom), "acme");
  assert.equal(vendorOfModel("router/priv", custom), "private-co");
  assert.equal(validateModelVendors(custom).ok, true);
  assert.equal(validateModelVendors(undefined).ok, true);
  assert.equal(validateModelVendors([]).ok, false);
  assert.equal(validateModelVendors({ "": "acme" }).ok, false);
  assert.equal(validateModelVendors({ "acme-": "" }).ok, false);

  const actorCustom = { runner: "t3:pi", model: "acme-v1", observedModel: "acme-v1", observedModels: ["acme-v1"] };
  const judgeCustom = { runner: "t3:pi", model: "beta-v1", vendor: "beta", observedModel: "beta-v1", observedModels: ["beta-v1"] };
  assert.equal(modelVendor(actorCustom), null);
  assert.equal(modelVendor(actorCustom, { modelVendors: custom }), "acme");
  assert.equal(independenceModel(actorCustom, { modelVendors: custom }), "acme-v1");
  assert.equal(modelVendor(judgeCustom), "beta");
  assert.equal(judgeIndependenceProblem(judgeCustom, actorCustom, "vendor", { modelVendors: custom }), null);
  assert.match(judgeIndependenceProblem(actorCustom, actorCustom, "vendor", { modelVendors: custom }), /same-vendor judge/);

  const order = ["c1"];
  const isAncestor = (a, b) => order.indexOf(a) >= 0 && order.indexOf(b) >= 0 && order.indexOf(a) <= order.indexOf(b);
  assert.equal(
    waveIndependenceProblem({
      judge: { id: "R-0053-judge", role: "judge", round: 53, agent: judgeCustom, product: { base: "c1", commit: "c1" } },
      actors: [{ id: "R-0053-actor", role: "actor", round: 53, agent: actorCustom, product: { commit: "c1" } }],
      targetCommit: "c1",
      isAncestor,
      policy: "vendor",
      modelVendors: custom,
    }),
    null,
  );
});

test("D-0068: judgeIndependence session permits same model across distinct sessions and fails closed on missing or shared session", () => {
  const actorA = { runner: "paseo:pi", model: "openrouter/gemini-2.5-pro-exp", session: "sess-actor-1" };
  const judgeDiff = { runner: "paseo:pi", model: "openrouter/gemini-2.5-pro-exp", session: "sess-judge-2" };
  const judgeSame = { runner: "paseo:pi", model: "openrouter/gemini-2.5-pro-exp", session: "sess-actor-1" };
  const noSess = { runner: "paseo:pi", model: "openrouter/gemini-2.5-pro-exp" };

  assert.equal(judgeIndependenceProblem(judgeDiff, actorA, "session"), null);
  assert.match(judgeIndependenceProblem(judgeSame, actorA, "session"), /same-session judge/);
  assert.match(judgeIndependenceProblem(noSess, actorA, "session"), /judge has unknown session/);
  assert.match(judgeIndependenceProblem(judgeDiff, noSess, "session"), /actor has unknown session/);

  const order = ["c1"];
  const isAncestor = (a, b) => order.indexOf(a) >= 0 && order.indexOf(b) >= 0 && order.indexOf(a) <= order.indexOf(b);
  const actorH = { id: "R-0053-actor", role: "actor", round: 53, agent: actorA, product: { commit: "c1" } };
  const judgeOk = { id: "R-0053-judge", role: "judge", round: 53, agent: judgeDiff, product: { base: "c1", commit: "c1" } };
  const judgeBad = { id: "R-0053-judge", role: "judge", round: 53, agent: judgeSame, product: { base: "c1", commit: "c1" } };
  const judgeMissing = { id: "R-0053-judge", role: "judge", round: 53, agent: noSess, product: { base: "c1", commit: "c1" } };

  assert.equal(waveIndependenceProblem({ judge: judgeOk, actors: [actorH], targetCommit: "c1", isAncestor, policy: "session" }), null);
  assert.match(waveIndependenceProblem({ judge: judgeBad, actors: [actorH], targetCommit: "c1", isAncestor, policy: "session" }), /same-session judge/);
  assert.match(waveIndependenceProblem({ judge: judgeMissing, actors: [actorH], targetCommit: "c1", isAncestor, policy: "session" }), /unknown session/);

  const baseDir = temp("vendor-norm-");
  const normSession = normalize({
    product: "prod", records: "rec", workDir: "work", phase: "v1", briefs: {}, agents: {},
    judgeIndependence: "session",
    modelVendors: { "custom-": "acme" },
  }, baseDir);
  assert.equal(normSession.judgeIndependence, "session");
  assert.throws(
    () => normalize({ product: "prod", records: "rec", workDir: "work", phase: "v1", briefs: {}, agents: {}, modelVendors: ["bad"] }, baseDir),
    err => err.code === EXIT.usage,
  );
  rmSync(baseDir, { recursive: true, force: true });
});

test("D-0068 horizontal sweep: router-prefix model equality, digit-suffixed families without false positives, and gated-push modelVendors validation", () => {
  assert.equal(normalizeModelName("openrouter/gemini-2.5-pro-exp"), "gemini-2.5-pro-exp");
  assert.equal(normalizeModelName("openrouter/google/Gemini-2.5-Pro-Exp"), "gemini-2.5-pro-exp");
  assert.equal(normalizeModelName("router/"), "");

  const routed = { runner: "t3:opencode", model: "openrouter/gemini-2.5-pro-exp", observedModel: "openrouter/gemini-2.5-pro-exp", observedModels: ["openrouter/gemini-2.5-pro-exp"] };
  const bare = ag("gemini-2.5-pro-exp");
  assert.match(judgeIndependenceProblem(bare, routed, "model"), /same-model judge/);
  assert.match(judgeIndependenceProblem(routed, bare, "model"), /same-model judge/);
  assert.equal(judgeIndependenceProblem(ag("gemini-2.5-flash-lite"), routed, "model"), null);
  assert.equal(modelVendor({ runner: "t3:opencode", observedModels: ["openrouter/gemini-2.5-pro-exp", "gemini-2.5-pro-exp"] }), "google");

  assert.deepEqual(
    ["openrouter/qwen3-coder", "qwen2.5-coder", "llama3-70b", "glm4-plus", "grok3", "claude3", "gemini2", "deepseek-v3", "minimax-m3", "kimi-k2", "gpt4o"].map(m => vendorOfModel(m)),
    ["alibaba", "alibaba", "meta", "zhipu", "xai", "anthropic", "google", "deepseek", "minimax", "moonshot", "openai"],
  );
  for (const nonMatch of ["grokking", "clam", "claudeville", "geminid", "qwench", "llamazing", "router/"]) {
    assert.equal(vendorOfModel(nonMatch), null, nonMatch);
  }

  assert.equal(policyOf({ protected: ["main"], gates: { require: [] }, modelVendors: { "acme-": "acme" } }).refused, undefined);
  assert.match(policyOf({ protected: ["main"], gates: { require: [] }, modelVendors: ["bad"] }).refused ?? "", /modelVendors/);
  assert.match(policyOf({ protected: ["main"], gates: { require: [] }, modelVendors: { "": "acme" } }).refused ?? "", /modelVendors/);
});
