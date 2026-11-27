// D-0060, D-0017, D-0058, design/mandatory-control-plane.md#3
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as archFacts from "../scripts/lib/arch-facts.mjs";
import { outerLoopState } from "../scripts/lib/cadence.mjs";
import { undiagnosedAlarms } from "../scripts/lib/diagnosis.mjs";
import { alarms } from "../scripts/trajectory.mjs";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Critic",
  GIT_AUTHOR_EMAIL: "critic@example.invalid",
  GIT_COMMITTER_NAME: "Critic",
  GIT_COMMITTER_EMAIL: "critic@example.invalid",
};

function makeTempDir(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function putFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function initRepo(t, files, prefix = "cadence-repo-") {
  const dir = makeTempDir(t, prefix);
  git(dir, "init", "-q", "-b", "main");
  putFiles(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}

function commitFiles(repo, files, message) {
  putFiles(repo, files);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", message);
  return git(repo, "rev-parse", "HEAD");
}

function linesOf(n, prefix = "export const v") {
  return Array.from({ length: n }, (_, i) => `${prefix}_${i} = ${i};`).join("\n") + "\n";
}

function judgeRow(round, commit, ci, phase = "v1") {
  return {
    time: `2026-11-24T00:${String(round).padStart(2, "0")}:00Z`,
    round,
    phase,
    area: "core",
    role: "judge",
    model: "gpt-5.4",
    verdict: "CONTINUE",
    opened: "-",
    closed: "-",
    suite: "10/0",
    owner: "0",
    commit,
    ci,
  };
}

function actorHandoff(round, base, commit, phase = "v1") {
  const id = `R-${String(round).padStart(4, "0")}-actor`;
  return {
    id,
    time: `2026-11-24T01:${String(round).padStart(2, "0")}:00Z`,
    phase,
    round,
    step: "actor",
    role: "actor",
    attempt: 1,
    agent: { runner: "codex", model: "gpt-5.4" },
    view: "a".repeat(40),
    product: { base, commit },
    audit: { violations: 0 },
    record: `rounds/${String(round).padStart(4, "0")}-actor.md`,
    files: [`rounds/${String(round).padStart(4, "0")}-actor.md`],
  };
}

test("CAD-01 (D-0017): descendant green CI extinguishes ancestor ci-absent in undiagnosedAlarms and alarms({ repo }); loss: stuck/false-verdict", t => {
  const product = initRepo(t, { "src/app.mjs": "export const v = 0;\n" }, "cadence-prod-");
  const c0 = git(product, "rev-parse", "HEAD");
  const c1 = commitFiles(product, { "src/app.mjs": "export const v = 1;\n" }, "C1");
  const c2 = commitFiles(product, { "src/app.mjs": "export const v = 2;\n" }, "C2");
  const c3 = commitFiles(product, { "src/app.mjs": "export const v = 3;\n" }, "C3");

  git(product, "checkout", "-q", "-b", "diverged", c0);
  const d1 = commitFiles(product, { "src/div.mjs": "export const d = 1;\n" }, "D1");
  git(product, "checkout", "-q", "main");

  const rows = [
    judgeRow(1, c1, "absent"),
    judgeRow(2, c2, "success"),
    judgeRow(3, c3, "absent"),
    judgeRow(4, d1, "absent"),
  ];
  const records = initRepo(t, {
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": rows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  }, "cadence-rec-");

  const openWithRepo = undiagnosedAlarms(records, "HEAD", "v1", { repo: product }).map(a => a.key);
  assert.ok(!openWithRepo.includes("ci-absent:v1:1"), `ancestor C1 should be extinguished by descendant green C2; got ${openWithRepo.join(", ")}`);
  assert.ok(openWithRepo.includes("ci-absent:v1:3"), `latest C3 with no green descendant must stay active; got ${openWithRepo.join(", ")}`);
  assert.ok(openWithRepo.includes("ci-absent:v1:4"), `diverged D1 not an ancestor of C2 must stay active; got ${openWithRepo.join(", ")}`);

  const alarmsWithRepo = alarms(rows, { repo: product }).filter(a => a.type === "ci-absent").map(a => a.key);
  assert.ok(!alarmsWithRepo.includes("ci-absent:v1:1"), `alarms({ repo }) must extinguish ancestor C1; got ${alarmsWithRepo.join(", ")}`);
  assert.ok(alarmsWithRepo.includes("ci-absent:v1:3"), `alarms({ repo }) must keep latest C3 active; got ${alarmsWithRepo.join(", ")}`);
  assert.ok(alarmsWithRepo.includes("ci-absent:v1:4"), `alarms({ repo }) must keep diverged D1 active; got ${alarmsWithRepo.join(", ")}`);
});

test("CAD-02 (D-0017): without { repo }, pure-row lineage extinguishes earlier ci-absent only within the same phase; loss: false-verdict", t => {
  const sha1 = "1".repeat(40);
  const sha2 = "2".repeat(40);
  const sha3 = "3".repeat(40);
  const rows = [
    judgeRow(1, sha1, "unknown", "v1"),
    judgeRow(2, sha2, "success", "v2"),
    judgeRow(3, sha3, "absent", "v1"),
  ];
  const recordsOtherPhase = initRepo(t, {
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": rows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  }, "cadence-phase-");

  const crossPhaseOpen = undiagnosedAlarms(recordsOtherPhase, "HEAD", "v1").map(a => a.key);
  assert.ok(crossPhaseOpen.includes("ci-absent:v1:1"), `green row in v2 must NOT extinguish v1:1; got ${crossPhaseOpen.join(", ")}`);
  assert.ok(crossPhaseOpen.includes("ci-absent:v1:3"), `v1:3 has no green descendant; got ${crossPhaseOpen.join(", ")}`);

  const samePhaseRows = [
    judgeRow(1, sha1, "absent", "v1"),
    judgeRow(2, sha2, "success", "v1"),
    judgeRow(4, sha3, "absent", "v1"),
  ];
  const recordsSamePhase = initRepo(t, {
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": samePhaseRows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  }, "cadence-lineage-");

  const openNoRepo = undiagnosedAlarms(recordsSamePhase, "HEAD", "v1").map(a => a.key);
  assert.ok(!openNoRepo.includes("ci-absent:v1:1"), `same-phase later green round should extinguish round 1 without repo; got ${openNoRepo.join(", ")}`);
  assert.ok(openNoRepo.includes("ci-absent:v1:4"), `round 4 after round 2 must stay active; got ${openNoRepo.join(", ")}`);
});

function deltaBreaches(current, baseline) {
  assert.equal(typeof archFacts.compareArchFacts, "function", "arch-facts.mjs must export compareArchFacts(current, baseline)");
  const result = archFacts.compareArchFacts(current, baseline);
  const list = Array.isArray(result) ? result : result?.breaches;
  assert.ok(Array.isArray(list), "compareArchFacts must return an array of breaches (or { breaches: [...] })");
  return list;
}

test("CAD-03 (D-0058): compareArchFacts returns 0 delta breaches on unchanged legacy debt and outerLoopState stays ok; loss: stuck", t => {
  const repo = initRepo(t, {
    "scripts/legacy.mjs": linesOf(850, "export const leg"),
    "scripts/old.mjs": "export const legacyId = 1;\n",
    "scripts/app.mjs": 'import { leg_0 } from "./legacy.mjs";\nimport { legacyId } from "./old.mjs";\nexport const run = () => leg_0 + legacyId;\n',
  }, "cadence-t3-a-");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const baseline = archFacts.collectArchFacts(repo, baseSha);

  const c1 = commitFiles(repo, {
    "scripts/app.mjs": 'import { leg_0 } from "./legacy.mjs";\nimport { legacyId } from "./old.mjs";\nexport const run = () => leg_0 + legacyId;\nexport const extra = 1;\n',
  }, "touch unrelated app.mjs");
  const current = archFacts.collectArchFacts(repo, c1, { baselineSha: baseSha });

  assert.equal(deltaBreaches(current, baseline).length, 0, "unchanged legacy debt must produce 0 delta breaches");

  const outer = outerLoopState({
    handoffs: [
      { id: "R-0001-reviewer-architecture", phase: "v1", round: 1, step: "reviewer-architecture", role: "reviewer", product: { base: baseSha, commit: baseSha } },
      actorHandoff(2, baseSha, c1, "v1"),
    ],
    baselineFacts: baseline,
    currentFacts: current,
    archBreaches: deltaBreaches(current, baseline),
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: c1,
  });
  assert.notEqual(outer.status, "hard-due", "unchanged legacy debt must NOT trigger hard-due");
  assert.equal(outer.t3Due, false);
});

test("CAD-04 (D-0058): compareArchFacts flags worsening file-size, net-new anti-rot, and ignores improved debt; loss: false-verdict/stuck", t => {
  const baseFiles = {
    "scripts/legacy.mjs": linesOf(850, "export const leg"),
    "scripts/old.mjs": "export const legacyId = 1;\n",
    "scripts/app.mjs": 'import { leg_0 } from "./legacy.mjs";\nimport { legacyId } from "./old.mjs";\nexport const run = () => leg_0 + legacyId;\n',
  };

  {
    const repo = initRepo(t, baseFiles, "cadence-t3-b-");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const baseline = archFacts.collectArchFacts(repo, baseSha);
    const cWorse = commitFiles(repo, { "scripts/legacy.mjs": linesOf(860, "export const leg") }, "grow legacy.mjs");
    const current = archFacts.collectArchFacts(repo, cWorse, { baselineSha: baseSha });
    const delta = deltaBreaches(current, baseline);
    assert.ok(delta.some(b => b.kind === "file-size" && b.path === "scripts/legacy.mjs"),
      `worsening file-size on scripts/legacy.mjs must be flagged; got ${JSON.stringify(delta)}`);
    assert.ok(!delta.some(b => b.path === "scripts/old.mjs"),
      `unchanged compat-remnant on scripts/old.mjs must NOT appear in delta; got ${JSON.stringify(delta)}`);
  }

  {
    const repo = initRepo(t, baseFiles, "cadence-t3-c-");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const baseline = archFacts.collectArchFacts(repo, baseSha);
    const cNew = commitFiles(repo, {
      "scripts/new-rot.mjs": `export const compatShim = 1;\n${linesOf(810, "export const nr")}`,
      "scripts/app.mjs": `${baseFiles["scripts/app.mjs"]}import { compatShim } from "./new-rot.mjs";\nexport const s = compatShim;\n`,
    }, "add new-rot.mjs");
    const current = archFacts.collectArchFacts(repo, cNew, { baselineSha: baseSha });
    const delta = deltaBreaches(current, baseline);
    assert.ok(delta.some(b => b.kind === "compat-remnant" && b.path === "scripts/new-rot.mjs"),
      `net-new compat-remnant must be flagged; got ${JSON.stringify(delta)}`);
    assert.ok(delta.some(b => b.kind === "file-size" && b.path === "scripts/new-rot.mjs"),
      `net-new file-size must be flagged; got ${JSON.stringify(delta)}`);
    assert.ok(!delta.some(b => b.path === "scripts/legacy.mjs" || b.path === "scripts/old.mjs"),
      `unchanged legacy files must NOT appear in delta; got ${JSON.stringify(delta)}`);
  }

  {
    const repo = initRepo(t, baseFiles, "cadence-t3-d-");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const baseline = archFacts.collectArchFacts(repo, baseSha);
    const cImproved = commitFiles(repo, { "scripts/legacy.mjs": linesOf(790, "export const leg") }, "shrink legacy.mjs");
    const current = archFacts.collectArchFacts(repo, cImproved, { baselineSha: baseSha });
    const delta = deltaBreaches(current, baseline);
    assert.equal(delta.length, 0, `improved legacy.mjs (850 -> 790) must yield 0 delta breaches; got ${JSON.stringify(delta)}`);
  }

  {
    const prose = n => Array.from({ length: n }, (_, i) => `// Explanatory prose comment line ${i + 1} describing behavior.`).join("\n");
    const rotBase = {
      "scripts/commented.mjs": `${prose(14)}\nexport const c = 1;\n`,
      "scripts/host.mjs": 'import { c } from "./commented.mjs";\nexport const p = "/home/alice/data";\nexport const out = () => [c, p];\n',
      "test/rot.test.mjs": 'import test from "node:test";\ntest.skip("legacy skipped", () => {});\n',
    };
    const repo = initRepo(t, rotBase, "cadence-t3-e-");
    const baseSha = git(repo, "rev-parse", "HEAD");
    const baseline = archFacts.collectArchFacts(repo, baseSha);

    const cWorse = commitFiles(repo, {
      "scripts/commented.mjs": `${prose(16)}\nexport const c = 1;\n`,
      "scripts/host.mjs": 'import { c } from "./commented.mjs";\nexport const p = "/home/alice/data";\nexport const q = "127.0.0.1:9999";\nexport const out = () => [c, p, q];\n',
    }, "worsen comment bloat and add loopback literal");
    const current = archFacts.collectArchFacts(repo, cWorse, { baselineSha: baseSha });
    const delta = deltaBreaches(current, baseline);
    assert.ok(delta.some(b => b.kind === "comment-bloat" && b.path === "scripts/commented.mjs"),
      `increased comment-bloat must be flagged; got ${JSON.stringify(delta)}`);
    assert.ok(delta.some(b => b.kind === "hardcoded-literal" && b.path === "scripts/host.mjs"),
      `net-new hardcoded-literal must be flagged; got ${JSON.stringify(delta)}`);
    assert.ok(!delta.some(b => b.kind === "test-rot" && b.path === "test/rot.test.mjs"),
      `unchanged test-rot must NOT appear in delta; got ${JSON.stringify(delta)}`);
  }
});

test("CAD-05 (D-0058): past outerGrace with active reviewer-architecture, only packages intersecting hotspotPaths are blocked; without active review, hard-due blocks all; loss: stuck/false-verdict", t => {
  const repo = initRepo(t, {
    "scripts/unrelated.mjs": linesOf(20, "export const u"),
    "scripts/hotspot.mjs": linesOf(20, "export const h"),
  }, "cadence-hotspot-");
  const baseSha = git(repo, "rev-parse", "HEAD");
  const baseline = archFacts.collectArchFacts(repo, baseSha);

  const cHot = commitFiles(repo, {
    "scripts/hotspot.mjs": linesOf(850, "export const h"),
  }, "hotspot grows past 800 lines");
  const current = archFacts.collectArchFacts(repo, cHot, { baselineSha: baseSha });
  const delta = deltaBreaches(current, baseline);
  assert.ok(delta.some(b => b.path === "scripts/hotspot.mjs"));

  const handoffs = [
    { id: "R-0001-reviewer-architecture", phase: "v1", round: 1, step: "reviewer-architecture", role: "reviewer", product: { base: baseSha, commit: baseSha } },
    actorHandoff(2, baseSha, cHot, "v1"),
  ];
  const activeArch = [{
    id: "R-0003-reviewer-architecture",
    phase: "v1",
    round: 3,
    step: "reviewer-architecture",
    role: "reviewer",
    liveWorkspace: true,
  }];

  const unrelatedState = outerLoopState({
    handoffs,
    archBreaches: delta,
    baselineFacts: baseline,
    currentFacts: current,
    prepared: activeArch,
    packageFiles: ["scripts/unrelated.mjs"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(unrelatedState.t3Due, true);
  assert.equal(unrelatedState.blocked, false, `unrelated package must NOT be blocked while async reviewer-architecture is active; got ${JSON.stringify(unrelatedState)}`);

  const hotspotExact = outerLoopState({
    handoffs,
    archBreaches: delta,
    baselineFacts: baseline,
    currentFacts: current,
    prepared: activeArch,
    packageFiles: ["scripts/hotspot.mjs"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(hotspotExact.blocked, true, "package touching hotspot.mjs must be blocked");

  const hotspotGlob = outerLoopState({
    handoffs,
    archBreaches: delta,
    baselineFacts: baseline,
    currentFacts: current,
    prepared: activeArch,
    packageFiles: ["scripts/*.mjs"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(hotspotGlob.blocked, true, "package glob intersecting hotspot.mjs must be blocked");

  const noArchStarted = outerLoopState({
    handoffs,
    archBreaches: delta,
    baselineFacts: baseline,
    currentFacts: current,
    prepared: [],
    packageFiles: ["scripts/unrelated.mjs"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(noArchStarted.status, "hard-due");
  assert.equal(noArchStarted.blocked, true, "without an active reviewer-architecture call, hard-due must block all actor packages");
});
