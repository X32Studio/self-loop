// D-0060, design/mandatory-control-plane.md#1
import assert from "node:assert/strict";
import { chmodSync, cpSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { has, json, jsonl, output, put, skill, status, world } from "./fixture.mjs";
import { now } from "./scenario.mjs";

const CLAUDE_ACTOR = {
  runner: "t3:claude",
  model: "claude-opus-4-6",
  observedModel: "claude-opus-4-6",
  observedModels: ["claude-opus-4-6"],
};

const CODEX_REVIEWER = {
  runner: "t3:codex",
  model: "gpt-5.4",
  observedModel: "gpt-5.4",
  observedModels: ["gpt-5.4"],
};

const CLAUDE_JUDGE_SAME_VENDOR = {
  runner: "t3:claude",
  model: "claude-haiku-5-5",
  observedModel: "claude-haiku-5-5",
  observedModels: ["claude-haiku-5-5"],
};

const pad = n => String(n).padStart(4, "0");

function provenanceWorld(t, { withHooks = false, extraCommits = 0, branch = "loop/v1", phase = "v1" } = {}) {
  const w = world(t);
  const product = join(w.projects, "project", "prov-product");
  const initialFiles = {
    "README.md": "# Provenance target\n",
    "VERSION": "0.0.1\n",
    "scripts/test/smoke.test.mjs": "import test from 'node:test';\ntest('smoke', () => {});\n",
  };
  w.repo(product, initialFiles);
  if (withHooks) {
    const source = join(skill, "scripts");
    cpSync(source, join(product, "scripts"), {
      recursive: true,
      filter: file => file !== join(source, "test"),
    });
    cpSync(join(skill, ".githooks"), join(product, ".githooks"), { recursive: true });
    chmodSync(join(product, ".githooks", "pre-push"), 0o755);
    chmodSync(join(product, ".githooks", "pre-commit"), 0o755);
    w.commit(product, "Install hooks and scripts");
  }
  const ancestors = [w.git(product, "rev-parse", "HEAD")];
  for (let i = 1; i <= extraCommits; i++) {
    put(product, `scripts/legacy-${i}.mjs`, `export const legacy${i} = ${i};\n`);
    ancestors.push(w.commit(product, `Legacy commit ${i}`));
  }
  const baseline = ancestors.at(-1);
  w.git(product, "branch", "-f", branch, baseline);
  w.git(product, "checkout", "-q", "--detach", baseline);

  const remote = join(w.dir, "origin.git");
  mkdirSync(remote, { recursive: true });
  w.git(remote, "init", "-q", "--bare");
  w.git(product, "remote", "add", "origin", remote);

  const records = join(w.projects, "records", "prov-records");
  const config = join(records, "loop.json");
  const workDir = join(w.dir, "work", "prov");
  const loadDir = join(w.dir, "load");
  mkdirSync(loadDir, { recursive: true });

  w.repo(records, {
    "README.md": "# Provenance records\n",
    "records.json": json({}),
    "loop.json": json({
      product,
      records,
      workDir,
      branch,
      phase,
      briefs: {},
      agents: { actor: CLAUDE_ACTOR, critic: CODEX_REVIEWER, judge: CODEX_REVIEWER },
      protected: ["main"],
      gates: { remote: "origin", require: [] },
      provenanceBaseline: baseline,
    }),
    "purpose/P-0001.md": "# P-0001 Mandatory control plane\n\nstatus: active\n",
    "decisions/D-0060.md": "# D-0060 Mandatory control plane\n\nid: D-0060\nby: owner\nstatus: active\n",
    "blueprint/F-0004.md": `# F-0004 Provenance gate\n\nid: F-0004\nphase: ${phase}\nrequirements: P-0001\n`,
    "metrics/blueprint.jsonl": jsonl({ feature: "F-0004", status: "building", time: now, by: "lead", note: "Start", evidence: {} }),
    "metrics/handoffs.jsonl": "",
    "metrics/trajectory.jsonl": "",
    "rounds/0001-reviewer-frame.md": `# R-0001-reviewer-frame\n\nphase: ${phase}\nrole: reviewer\n`,
  });
  status(w.run(["--repo", records, "--write"], { entry: "records-check.mjs" }), 0);
  w.commit(records, "Initialize records");
  w.register([{ name: "prov-target", records }]);

  let receiptSeq = 0;
  const makeReceipt = (sha = w.git(product, "rev-parse", "HEAD")) => {
    const prefix = join(w.dir, `suite-${sha.slice(0, 12)}-${++receiptSeq}`);
    status(w.run([
      "--repo", product, "--sha", sha, "--command", "node --test scripts/test/smoke.test.mjs", "--out", prefix,
    ], { entry: "suite-green.mjs", extraEnv: { SELF_LOOP_LOAD_DIR: loadDir } }), 0);
    return `${prefix}.json`;
  };

  const push = (targetBranch = branch, sha = w.git(product, "rev-parse", "HEAD"), flags = []) => {
    const receipt = makeReceipt(sha);
    return w.run([
      "--repo", product, "--branch", targetBranch, "--sha", sha, "--suite-receipt", receipt, ...flags,
    ], { entry: "gated-push.mjs", extraEnv: { SELF_LOOP_LOAD_DIR: loadDir } });
  };

  const remoteRef = (refName = `refs/heads/${branch}`) => {
    const r = w.runGit(remote, "rev-parse", "--verify", "--quiet", refName);
    return r.status === 0 ? r.stdout.trim() : null;
  };

  const writePlan = (planId, packages) => {
    const body = [
      `# ${planId} Provenance test plan`,
      "",
      `scope: provenance-test-${planId.toLowerCase()}`,
      `phase: ${phase}`,
      ...packages.flatMap(p => [
        "",
        `## ${p.id}`,
        "",
        `role: ${p.role}`,
        `handoff: ${p.handoff}`,
        `authority: ${p.authority ?? "D-0060"}`,
        `goal: ${p.goal ?? `Deliver ${p.id}`}`,
        `files: ${(p.files ?? []).join(", ")}`,
        `interface: ${p.interface ?? "D-0060"}`,
        `acceptance: ${p.acceptance ?? "D-0060"}`,
        `needs: ${(p.needs ?? []).join(", ")}`,
        ...(p.reviews ? [`reviews: ${p.reviews.join(", ")}`] : []),
      ]),
      "",
    ].join("\n");
    put(records, `plans/${planId}.md`, body);
    w.git(records, "add", "-A");
    status(w.run(["--repo", records, "--write"], { entry: "records-check.mjs" }), 0);
    return w.commit(records, `Publish ${planId}`);
  };

  const recordHandoff = ({
    round = 1,
    role,
    step,
    base,
    commit = base,
    planId = "PL-0001",
    pkgId,
    files = [],
    agent,
    verdict = "CONVERGED",
    acceptance = "pass",
  }) => {
    const view = w.git(records, "rev-parse", "HEAD");
    const id = `R-${pad(round)}-${step}`;
    const record = `rounds/${pad(round)}-${step}.md`;
    const auditFile = `${role === "judge" ? `sealed/judge/${pad(round)}` : `evidence/${pad(round)}`}/${step}-1-audit.json`;
    const ownFiles = [record];
    put(records, record, [
      `# ${id}`,
      "",
      `phase: ${phase}`,
      `role: ${role}`,
      `agent: ${agent.runner} ${agent.model ?? ""}`.trim(),
      `view: records@${view}`,
      `product: ${base}${commit !== base ? ` -> ${commit}` : ""}`,
      "",
      "## Report (verbatim)",
      "",
      "Completed.",
      "",
    ].join("\n"));
    put(records, auditFile, json({ id, role, attempt: 1, exit: 0, agent, violations: [] }));
    if (role === "judge") {
      const sealed = `sealed/judge/${pad(round)}/${step}-1.md`;
      ownFiles.push(sealed);
      put(records, sealed, [
        `# ${id}`,
        "",
        `phase: ${phase}`,
        `role: judge`,
        `view: records@${view}`,
        "",
        "## Task (verbatim)",
        "",
        "```text",
        "Judge wave.",
        "```",
        "",
        "## Report (verbatim)",
        "",
        `VERDICT: ${verdict}`,
        `ACCEPTANCE: ${acceptance}`,
        "",
      ].join("\n"));
      const existingTraj = readFileSync(join(records, "metrics/trajectory.jsonl"), "utf8");
      put(records, "metrics/trajectory.jsonl", existingTraj + jsonl({
        time: now,
        round,
        phase,
        area: "provenance",
        role: "judge",
        model: agent.model,
        verdict,
        opened: "-",
        closed: "-",
        suite: "1/0",
        owner: "0",
        commit,
        ci: "-",
      }));
    }
    const existingHandoffs = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8");
    const entry = {
      id,
      time: now,
      phase,
      round,
      step,
      role,
      attempt: 1,
      agent,
      view,
      features: ["F-0004"],
      briefs: [],
      task: "0".repeat(64),
      product: { base, commit },
      exit: 0,
      audit: { violations: 0, denied: 0, flags: 0, unrecognized: 0, file: auditFile },
      record,
      files: ownFiles,
      dispatch: { plan: planId, package: pkgId, files },
    };
    put(records, "metrics/handoffs.jsonl", existingHandoffs + jsonl(entry));
    w.git(records, "add", "-A");
    status(w.run(["--repo", records, "--write"], { entry: "records-check.mjs" }), 0);
    return w.commit(records, `Record ${id}`);
  };

  const openWindow = ({ horizon = 3, startRound = 1 } = {}) => {
    status(w.run([
      "open", "--records", records, "--phase", phase, "--start-round", String(startRound),
      "--horizon", String(horizon), "--goal", "Bounded refactor", "--invariant", "Keep suite green",
    ], { entry: "window.mjs" }), 0);
  };

  const makeManualCommit = (filePath, contents, message = "Manual edit", { parent = null } = {}) => {
    if (parent) w.git(product, "checkout", "-q", "--detach", parent);
    put(product, filePath, contents);
    const sha = w.commit(product, message);
    w.git(product, "branch", "-f", branch, sha);
    return sha;
  };

  return {
    w, product, records, remote, config, baseline, ancestors, branch, phase, loadDir,
    makeReceipt, push, remoteRef, writePlan, recordHandoff, openWindow, makeManualCommit,
  };
}

function refusedPush(res, beforeRemote, getRemote, expectedSha = null) {
  assert.equal(res.status, 2, output(res));
  assert.equal(getRemote(), beforeRemote, "remote ref must not move on refused push");
  if (expectedSha) has(output(res), expectedSha.slice(0, 7));
}

test("PROV-01 working-branch unattested commit above provenanceBaseline is refused", t => {
  const pw = provenanceWorld(t);
  const manualSha = pw.makeManualCommit("scripts/foo.mjs", "export const foo = 1;\n", "Unattested manual change");
  const res = pw.push("loop/v1", manualSha);
  refusedPush(res, null, () => pw.remoteRef("refs/heads/loop/v1"), manualSha);
});

test("PROV-02 working-branch missing critic/judge refuses loop/<phase>; ci/<handoff-id> requires PL + critic + actor", t => {
  const pw = provenanceWorld(t);
  pw.writePlan("PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0001-actor-a", files: ["scripts/a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0001-critic-a", files: ["acceptance/a.test.mjs"], needs: ["actor-a"], reviews: ["actor-a"] },
    { id: "judge", role: "judge", handoff: "R-0001-judge", files: [], needs: ["critic-a"] },
  ]);
  const actorSha = pw.makeManualCommit("scripts/a.mjs", "export const a = 1;\n", "Actor A commit");
  pw.recordHandoff({
    round: 1, role: "actor", step: "actor-a", base: pw.baseline, commit: actorSha,
    pkgId: "actor-a", files: ["scripts/a.mjs"], agent: CLAUDE_ACTOR,
  });

  const loopNoCritic = pw.push("loop/v1", actorSha);
  refusedPush(loopNoCritic, null, () => pw.remoteRef("refs/heads/loop/v1"));
  assert.match(output(loopNoCritic), /critic|judge|wave/i);

  const ciNoCritic = pw.push("ci/R-0001-actor-a", actorSha);
  refusedPush(ciNoCritic, null, () => pw.remoteRef("refs/heads/ci/R-0001-actor-a"));
  assert.match(output(ciNoCritic), /critic/i);

  pw.recordHandoff({
    round: 1, role: "critic", step: "critic-a", base: actorSha, commit: actorSha,
    pkgId: "critic-a", files: ["acceptance/a.test.mjs"], agent: CODEX_REVIEWER,
  });

  status(pw.push("ci/R-0001-actor-a", actorSha), 0);
  assert.equal(pw.remoteRef("refs/heads/ci/R-0001-actor-a"), actorSha);

  const loopNoJudge = pw.push("loop/v1", actorSha);
  refusedPush(loopNoJudge, null, () => pw.remoteRef("refs/heads/loop/v1"));
  assert.match(output(loopNoJudge), /judge|wave/i);

  const unattested = pw.makeManualCommit("scripts/sneaky-ci.mjs", "export const s = 1;\n", "Sneaky CI commit");
  const ciUnattested = pw.push("ci/R-0001-actor-a", unattested);
  refusedPush(ciUnattested, actorSha, () => pw.remoteRef("refs/heads/ci/R-0001-actor-a"), unattested);
});

test("PROV-03 full-chain PL + critic + actor + cross-vendor judge passes loop/<phase>; same-vendor judge is refused", t => {
  const pw = provenanceWorld(t);
  pw.writePlan("PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0001-actor-a", files: ["scripts/a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0001-critic-a", files: ["acceptance/a.test.mjs"], needs: ["actor-a"], reviews: ["actor-a"] },
    { id: "judge", role: "judge", handoff: "R-0001-judge", files: [], needs: ["critic-a"] },
  ]);
  const actorSha = pw.makeManualCommit("scripts/a.mjs", "export const a = 1;\n", "Actor A commit");
  pw.recordHandoff({
    round: 1, role: "actor", step: "actor-a", base: pw.baseline, commit: actorSha,
    pkgId: "actor-a", files: ["scripts/a.mjs"], agent: CLAUDE_ACTOR,
  });
  pw.recordHandoff({
    round: 1, role: "critic", step: "critic-a", base: actorSha, commit: actorSha,
    pkgId: "critic-a", files: ["acceptance/a.test.mjs"], agent: CODEX_REVIEWER,
  });

  pw.recordHandoff({
    round: 1, role: "judge", step: "judge-same", base: actorSha, commit: actorSha,
    pkgId: "judge", files: [], agent: CLAUDE_JUDGE_SAME_VENDOR, verdict: "CONVERGED", acceptance: "pass",
  });
  const sameVendorRes = pw.push("loop/v1", actorSha);
  refusedPush(sameVendorRes, null, () => pw.remoteRef("refs/heads/loop/v1"));

  pw.recordHandoff({
    round: 1, role: "judge", step: "judge", base: actorSha, commit: actorSha,
    pkgId: "judge", files: [], agent: CODEX_REVIEWER, verdict: "CONVERGED", acceptance: "pass",
  });
  status(pw.push("loop/v1", actorSha), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), actorSha);
});

test("PROV-04 open W-NNNN window defers judge in slack/converging and enforces wave gate at gate-due", t => {
  const pw = provenanceWorld(t);
  pw.openWindow({ horizon: 3, startRound: 1 });
  pw.writePlan("PL-0001", [
    { id: "actor-one", role: "actor", handoff: "R-0001-actor-one", files: ["scripts/one.mjs"] },
    { id: "actor-two", role: "actor", handoff: "R-0002-actor-two", files: ["scripts/two.mjs"], needs: ["actor-one"] },
    { id: "actor-three", role: "actor", handoff: "R-0003-actor-three", files: ["scripts/three.mjs"], needs: ["actor-two"] },
    { id: "critic-wave", role: "critic", handoff: "R-0003-critic-wave", files: ["acceptance/wave.test.mjs"], needs: ["actor-three"], reviews: ["actor-one", "actor-two", "actor-three"] },
    { id: "judge-wave", role: "judge", handoff: "R-0003-judge", files: [], needs: ["critic-wave"] },
  ]);

  const sha1 = pw.makeManualCommit("scripts/one.mjs", "export const one = 1;\n", "Actor round 1");
  pw.recordHandoff({
    round: 1, role: "actor", step: "actor-one", base: pw.baseline, commit: sha1,
    pkgId: "actor-one", files: ["scripts/one.mjs"], agent: CLAUDE_ACTOR,
  });
  status(pw.push("loop/v1", sha1), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), sha1);

  const sha2 = pw.makeManualCommit("scripts/two.mjs", "export const two = 2;\n", "Actor round 2");
  pw.recordHandoff({
    round: 2, role: "actor", step: "actor-two", base: sha1, commit: sha2,
    pkgId: "actor-two", files: ["scripts/two.mjs"], agent: CLAUDE_ACTOR,
  });
  status(pw.push("loop/v1", sha2), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), sha2);

  const sha3 = pw.makeManualCommit("scripts/three.mjs", "export const three = 3;\n", "Actor round 3");
  pw.recordHandoff({
    round: 3, role: "actor", step: "actor-three", base: sha2, commit: sha3,
    pkgId: "actor-three", files: ["scripts/three.mjs"], agent: CLAUDE_ACTOR,
  });
  const dueRes = pw.push("loop/v1", sha3);
  refusedPush(dueRes, sha2, () => pw.remoteRef("refs/heads/loop/v1"));
  assert.match(output(dueRes), /critic|judge|gate-due|window/i);

  pw.recordHandoff({
    round: 3, role: "critic", step: "critic-wave", base: sha3, commit: sha3,
    pkgId: "critic-wave", files: ["acceptance/wave.test.mjs"], agent: CODEX_REVIEWER,
  });
  pw.recordHandoff({
    round: 3, role: "judge", step: "judge", base: sha3, commit: sha3,
    pkgId: "judge-wave", files: [], agent: CODEX_REVIEWER, verdict: "CONVERGED", acceptance: "pass",
  });
  status(pw.push("loop/v1", sha3), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), sha3);
});

test("PROV-05 evil merge smuggling unattested file is refused; clean merge-tree wave merge passes", t => {
  const pw = provenanceWorld(t);
  pw.openWindow({ horizon: 5, startRound: 1 });
  pw.writePlan("PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0001-actor-a", files: ["scripts/a.mjs"] },
    { id: "actor-b", role: "actor", handoff: "R-0001-actor-b", files: ["scripts/b.mjs"] },
  ]);

  const commitA = pw.makeManualCommit("scripts/a.mjs", "export const a = 1;\n", "Actor A", { parent: pw.baseline });
  const commitB = pw.makeManualCommit("scripts/b.mjs", "export const b = 2;\n", "Actor B", { parent: pw.baseline });

  pw.recordHandoff({
    round: 1, role: "actor", step: "actor-a", base: pw.baseline, commit: commitA,
    pkgId: "actor-a", files: ["scripts/a.mjs"], agent: CLAUDE_ACTOR,
  });
  pw.recordHandoff({
    round: 1, role: "actor", step: "actor-b", base: pw.baseline, commit: commitB,
    pkgId: "actor-b", files: ["scripts/b.mjs"], agent: CLAUDE_ACTOR,
  });

  const cleanTree = pw.w.git(pw.product, "merge-tree", "--write-tree", commitA, commitB).split("\n")[0].trim();
  const cleanMerge = pw.w.git(pw.product, "commit-tree", cleanTree, "-p", commitA, "-p", commitB, "-m", "self-loop: integrate PL-0001");

  pw.w.git(pw.product, "checkout", "-q", cleanMerge);
  put(pw.product, "scripts/evil.mjs", "export const backdoor = true;\n");
  pw.w.git(pw.product, "add", "scripts/evil.mjs");
  const evilTree = pw.w.git(pw.product, "write-tree");
  const evilMerge = pw.w.git(pw.product, "commit-tree", evilTree, "-p", commitA, "-p", commitB, "-m", "self-loop: integrate PL-0001");
  pw.w.git(pw.product, "reset", "-q", "--hard", cleanMerge);

  pw.w.git(pw.product, "branch", "-f", "loop/v1", evilMerge);
  const evilRes = pw.push("loop/v1", evilMerge);
  refusedPush(evilRes, null, () => pw.remoteRef("refs/heads/loop/v1"), evilMerge);

  pw.w.git(pw.product, "branch", "-f", "loop/v1", cleanMerge);
  status(pw.push("loop/v1", cleanMerge), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), cleanMerge);
});

test("PROV-06 leadPaths-only commit and exact reverts pass; mixed lead+code and impure revert are refused", t => {
  const pw = provenanceWorld(t);
  pw.writePlan("PL-0001", [
    { id: "actor-a", role: "actor", handoff: "R-0001-actor-a", files: ["scripts/feature-a.mjs"] },
    { id: "critic-a", role: "critic", handoff: "R-0001-critic-a", files: ["acceptance/a.test.mjs"], needs: ["actor-a"], reviews: ["actor-a"] },
    { id: "judge", role: "judge", handoff: "R-0001-judge", files: [], needs: ["critic-a"] },
  ]);
  const actorA = pw.makeManualCommit("scripts/feature-a.mjs", "export const featureA = 1;\n", "Actor A");
  pw.recordHandoff({
    round: 1, role: "actor", step: "actor-a", base: pw.baseline, commit: actorA,
    pkgId: "actor-a", files: ["scripts/feature-a.mjs"], agent: CLAUDE_ACTOR,
  });
  pw.recordHandoff({
    round: 1, role: "critic", step: "critic-a", base: actorA, commit: actorA,
    pkgId: "critic-a", files: ["acceptance/a.test.mjs"], agent: CODEX_REVIEWER,
  });
  pw.recordHandoff({
    round: 1, role: "judge", step: "judge", base: actorA, commit: actorA,
    pkgId: "judge", files: [], agent: CODEX_REVIEWER, verdict: "CONVERGED", acceptance: "pass",
  });

  put(pw.product, "docs/note.md", "# Release note\n");
  put(pw.product, "VERSION", "0.0.2\n");
  const leadOnly = pw.w.commit(pw.product, "Lead docs and VERSION update");
  pw.w.git(pw.product, "branch", "-f", "loop/v1", leadOnly);
  status(pw.push("loop/v1", leadOnly), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), leadOnly);

  put(pw.product, "docs/note.md", "# Updated note\n");
  put(pw.product, "scripts/sneaky.mjs", "export const sneaky = 1;\n");
  const mixedSha = pw.w.commit(pw.product, "Docs + sneaky script");
  pw.w.git(pw.product, "branch", "-f", "loop/v1", mixedSha);
  const mixedRes = pw.push("loop/v1", mixedSha);
  refusedPush(mixedRes, leadOnly, () => pw.remoteRef("refs/heads/loop/v1"), mixedSha);

  pw.w.git(pw.product, "checkout", "-q", "--detach", leadOnly);
  pw.w.git(pw.product, "branch", "-f", "loop/v1", leadOnly);
  pw.openWindow({ horizon: 5, startRound: 2 });
  pw.writePlan("PL-0002", [
    { id: "actor-b", role: "actor", handoff: "R-0002-actor-b", files: ["scripts/feature-b.mjs"] },
  ]);
  const actorB = pw.makeManualCommit("scripts/feature-b.mjs", "export const featureB = 2;\n", "Actor B");
  pw.recordHandoff({
    round: 2, role: "actor", step: "actor-b", base: leadOnly, commit: actorB,
    planId: "PL-0002", pkgId: "actor-b", files: ["scripts/feature-b.mjs"], agent: CLAUDE_ACTOR,
  });

  pw.w.git(pw.product, "revert", "--no-edit", actorA);
  const exactNonTipRevert = pw.w.git(pw.product, "rev-parse", "HEAD");
  pw.w.git(pw.product, "branch", "-f", "loop/v1", exactNonTipRevert);
  status(pw.push("loop/v1", exactNonTipRevert), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), exactNonTipRevert);

  pw.w.git(pw.product, "revert", "--no-edit", actorB);
  const exactTipRevert = pw.w.git(pw.product, "rev-parse", "HEAD");
  pw.w.git(pw.product, "branch", "-f", "loop/v1", exactTipRevert);
  status(pw.push("loop/v1", exactTipRevert), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), exactTipRevert);

  pw.w.git(pw.product, "checkout", "-q", "--detach", actorB);
  pw.w.git(pw.product, "revert", "--no-commit", actorA);
  put(pw.product, "scripts/sneaky.mjs", "export const smuggledInRevert = true;\n");
  const impureRevert = pw.w.commit(pw.product, `Revert "Actor A"`);
  pw.w.git(pw.product, "branch", "-f", "loop/v1", impureRevert);
  const impureRes = pw.push("loop/v1", impureRevert);
  refusedPush(impureRes, exactTipRevert, () => pw.remoteRef("refs/heads/loop/v1"), impureRevert);
});

test("PROV-07 commits at or before provenanceBaseline are exempt; commits above are strictly checked", t => {
  const pw = provenanceWorld(t, { extraCommits: 2 });
  status(pw.push("loop/v1", pw.baseline), 0);
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), pw.baseline);

  const above = pw.makeManualCommit("scripts/above.mjs", "export const above = 1;\n", "Unattested above baseline");
  const res = pw.push("loop/v1", above);
  refusedPush(res, pw.baseline, () => pw.remoteRef("refs/heads/loop/v1"), above);
});

test("PROV-08 direct git push on unattested commit is blocked by .githooks/pre-push", t => {
  const pw = provenanceWorld(t, { withHooks: true });
  pw.w.git(pw.product, "tag", "v0.0.1", pw.baseline);
  status(pw.w.runGit(pw.product, "push", "origin", `${pw.baseline}:refs/heads/loop/v1`, "refs/tags/v0.0.1"), 0);
  pw.w.git(pw.product, "config", "core.hooksPath", ".githooks");

  put(pw.product, "scripts/bypass.mjs", "export const bypass = true;\n");
  put(pw.product, "VERSION", "0.0.2\n");
  const manualSha = pw.w.commit(pw.product, "Manual commit with valid VERSION bump");
  pw.w.git(pw.product, "tag", "v0.0.2", manualSha);

  const direct = pw.w.runGit(pw.product, "push", "origin", "HEAD:refs/heads/loop/v1", "refs/tags/v0.0.2");
  assert.notEqual(direct.status, 0, output(direct));
  assert.equal(pw.remoteRef("refs/heads/loop/v1"), pw.baseline, "remote branch must remain at baseline");
  assert.equal(pw.remoteRef("refs/tags/v0.0.2"), null, "unattested tag must not reach remote");
});
