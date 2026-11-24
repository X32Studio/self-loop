// D-0060, D-0017, D-0058, design/mandatory-control-plane.md#3
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectArchFacts, compareArchFacts, structuralBreaches } from "../lib/arch-facts.mjs";
import { outerLoopState } from "../lib/cadence.mjs";
import { undiagnosedAlarms } from "../lib/diagnosis.mjs";
import { alarms, extinguishedCiAbsent } from "../trajectory.mjs";
import { git, repo } from "./helpers.mjs";

const linesOf = (n, prefix = "export const v") =>
  Array.from({ length: n }, (_, i) => `${prefix}_${i} = ${i};`).join("\n") + "\n";

const putCommit = (dir, files, msg) => {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", msg);
  return git(dir, "rev-parse", "HEAD");
};

const judgeRow = (round, commit, ci, phase = "v1", extra = {}) => ({
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
  ...extra,
});

test("D-0017 amended: ancestor ci-absent extinguishes via git ancestry while earlier diverged branch and latest absent stay active", () => {
  const product = repo({ "src/app.mjs": "export const v = 0;\n" });
  const c0 = git(product, "rev-parse", "HEAD");
  const c1 = putCommit(product, { "src/app.mjs": "export const v = 1;\n" }, "C1");
  const c2 = putCommit(product, { "src/app.mjs": "export const v = 2;\n" }, "C2");
  const c3 = putCommit(product, { "src/app.mjs": "export const v = 3;\n" }, "C3");

  git(product, "checkout", "-q", "-b", "side", c0);
  const d1 = putCommit(product, { "src/side.mjs": "export const s = 1;\n" }, "D1");
  git(product, "checkout", "-q", "main");

  const rows = [
    judgeRow(1, d1, "absent"),
    judgeRow(2, c1, "absent"),
    judgeRow(3, c2, "success"),
    judgeRow(4, c3, "absent"),
    judgeRow(5, "f".repeat(40), "unknown"),
  ];

  const found = alarms(rows, { repo: product });
  const activeCi = found.filter(a => a.type === "ci-absent").map(a => a.key);
  assert.deepEqual(activeCi, ["ci-absent:v1:1", "ci-absent:v1:4", "ci-absent:v1:5"]);
  assert.equal(found.extinguished.length, 1);
  assert.equal(found.extinguished[0].key, "ci-absent:v1:2");
  assert.deepEqual(found.extinguished[0].extinguishedBy, { round: 3, commit: c2 });
  assert.deepEqual(extinguishedCiAbsent(rows, { repo: product }), found.extinguished);

  const records = repo({
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": rows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  });
  const open = undiagnosedAlarms(records, "HEAD", "v1", { repo: product });
  assert.deepEqual(open.filter(a => a.type === "ci-absent").map(a => a.key), ["ci-absent:v1:1", "ci-absent:v1:4", "ci-absent:v1:5"]);
  assert.deepEqual(open.extinguished.map(e => e.key), ["ci-absent:v1:2"]);
});

test("D-0017 amended: all-extinguished undiagnosedAlarms stays deepEqual to [] while carrying non-enumerable extinguished metadata", () => {
  const product = repo({ "src/a.mjs": "export const a = 1;\n" });
  const c1 = git(product, "rev-parse", "HEAD");
  const c2 = putCommit(product, { "src/a.mjs": "export const a = 2;\n" }, "C2");
  const rows = [judgeRow(1, c1, "absent"), judgeRow(2, c2, "success")];
  const records = repo({
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": rows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  });
  const open = undiagnosedAlarms(records, "HEAD", "v1", { repo: product });
  assert.deepEqual(open, []);
  assert.equal(open.extinguished.length, 1);
  assert.equal(open.extinguished[0].key, "ci-absent:v1:1");
});

test("D-0017 amended: without repo, cross-phase green row never extinguishes and same-phase later green round extinguishes", () => {
  const s1 = "1".repeat(40), s2 = "2".repeat(40), s3 = "3".repeat(40);
  const crossRows = [judgeRow(1, s1, "absent", "v1"), judgeRow(2, s2, "success", "v2")];
  const recCross = repo({
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": crossRows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  });
  assert.deepEqual(undiagnosedAlarms(recCross, "HEAD", "v1").map(a => a.key), ["ci-absent:v1:1"]);

  const sameRows = [judgeRow(1, s1, "unknown", "v1"), judgeRow(2, s2, "success", "v1"), judgeRow(3, s3, "absent", "v1")];
  const recSame = repo({
    "README.md": "# records\n",
    "metrics/trajectory.jsonl": sameRows.map(r => JSON.stringify(r)).join("\n") + "\n",
    "metrics/handoffs.jsonl": "",
  });
  const open = undiagnosedAlarms(recSame, "HEAD", "v1");
  assert.deepEqual(open.filter(a => a.type === "ci-absent").map(a => a.key), ["ci-absent:v1:3"]);
  assert.deepEqual(open.extinguished.map(e => e.key), ["ci-absent:v1:1"]);
});

test("D-0058 amended: compareArchFacts delegates to structuralBreaches when baselineFacts is null and isolates delta across all kinds", () => {
  const prose = n => Array.from({ length: n }, (_, i) => `// Prose explanation line ${i + 1} for baseline.`).join("\n");
  const r = repo({
    "src/big.mjs": linesOf(840, "export const b"),
    "src/bridge.mjs": "export const legacyName = 1;\n",
    "src/host.mjs": 'export const dir = "/home/bob/data";\n',
    "src/commented.mjs": `${prose(14)}\nexport const c = 1;\n`,
    "src/grow.mjs": linesOf(200, "export const g"),
    "src/hot.mjs": linesOf(20, "export const h"),
    "test/existing.test.mjs": 'import test from "node:test";\ntest.skip("old", () => {});\n',
  });
  const baseSha = git(r, "rev-parse", "HEAD");
  const baseline = collectArchFacts(r, baseSha);

  assert.deepEqual(compareArchFacts(baseline, null), structuralBreaches(baseline));
  assert.deepEqual(compareArchFacts(baseline, undefined), structuralBreaches(baseline));
  assert.deepEqual(compareArchFacts(null, baseline), []);
  assert.deepEqual(compareArchFacts(baseline, baseline), []);

  const cShift = putCommit(r, {
    "src/bridge.mjs": "\n\nexport const legacyName = 1;\n",
    "src/host.mjs": '\nexport const dir = "/home/bob/data";\n',
    "test/existing.test.mjs": 'import test from "node:test";\n\n\ntest.skip("old", () => {});\n',
  }, "shift lines only");
  const shifted = collectArchFacts(r, cShift, { baselineSha: baseSha });
  assert.deepEqual(compareArchFacts(shifted, baseline), []);

  const cShrink = putCommit(r, { "src/big.mjs": linesOf(820, "export const b") }, "shrink slightly");
  assert.deepEqual(compareArchFacts(collectArchFacts(r, cShrink, { baselineSha: baseSha }), baseline), []);

  putCommit(r, { "src/hot.mjs": linesOf(21, "export const h") }, "hot 1");
  putCommit(r, { "src/hot.mjs": linesOf(22, "export const h") }, "hot 2");
  const cWorse = putCommit(r, {
    "src/hot.mjs": linesOf(23, "export const h"),
    "src/grow.mjs": linesOf(280, "export const g"),
    "src/commented.mjs": `${prose(15)}\nexport const c = 1;\n`,
    "src/host.mjs": 'export const dir = "/home/bob/data";\nexport const port = "localhost:8080";\n',
    "test/existing.test.mjs": 'import test from "node:test";\ntest.skip("old", () => {});\ntest.skip("added", () => {});\n',
  }, "worsen multiple metrics");
  const worse = collectArchFacts(r, cWorse, { baselineSha: baseSha });
  const delta = compareArchFacts(worse, baseline);
  const pairs = delta.map(b => `${b.kind}:${b.path}`).sort();
  assert.deepEqual(pairs, [
    "churn-hotspot:src/hot.mjs",
    "comment-bloat:src/commented.mjs",
    "file-growth:src/grow.mjs",
    "hardcoded-literal:src/host.mjs",
    "test-rot:test/existing.test.mjs",
  ]);
});

test("D-0058 amended: outerLoopState evaluates delta via baselineFacts and scopes blocking by hotspotPaths when reviewer-architecture is active", () => {
  const r = repo({
    "scripts/existing.mjs": linesOf(850, "export const e"),
    "scripts/hotspot.mjs": linesOf(30, "export const h"),
    "scripts/clean.mjs": linesOf(30, "export const c"),
  });
  const baseSha = git(r, "rev-parse", "HEAD");
  const baseline = collectArchFacts(r, baseSha);

  const cTouch = putCommit(r, { "scripts/clean.mjs": linesOf(35, "export const c") }, "touch clean");
  const cleanFacts = collectArchFacts(r, cTouch, { baselineSha: baseSha });
  const handoffs = [
    { id: "R-0001-reviewer-architecture", phase: "v1", round: 1, step: "reviewer-architecture", role: "reviewer", product: { base: baseSha, commit: baseSha } },
    { id: "R-0002-actor", phase: "v1", round: 2, step: "actor", role: "actor", product: { base: baseSha, commit: cTouch } },
  ];

  const okState = outerLoopState({
    handoffs,
    archBreaches: structuralBreaches(cleanFacts),
    baselineFacts: baseline,
    currentFacts: cleanFacts,
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cTouch,
  });
  assert.equal(okState.status, "ok");
  assert.equal(okState.t3Due, false);
  assert.equal(okState.blocked, false);
  assert.deepEqual(okState.hotspotPaths, []);

  const cHot = putCommit(r, { "scripts/hotspot.mjs": linesOf(830, "export const h") }, "grow hotspot");
  const hotFacts = collectArchFacts(r, cHot, { baselineSha: baseSha });
  const hotHandoffs = [
    ...handoffs.slice(0, 1),
    { id: "R-0002-actor", phase: "v1", round: 2, step: "actor", role: "actor", product: { base: baseSha, commit: cHot } },
  ];

  const inactivePrepared = [
    { id: "R-0003-reviewer-architecture", phase: "v2", round: 3, step: "reviewer-architecture", role: "reviewer" },
    { id: "R-0004-reviewer-architecture", phase: "v1", round: 4, step: "reviewer-architecture", role: "reviewer", cancelled: true },
  ];
  const stillBlocked = outerLoopState({
    handoffs: hotHandoffs,
    baselineFacts: baseline,
    facts: hotFacts,
    prepared: inactivePrepared,
    packageFiles: ["scripts/clean.mjs"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(stillBlocked.archReviewActive, false);
  assert.equal(stillBlocked.status, "hard-due");
  assert.equal(stillBlocked.blocked, true);

  const activePrepared = [
    { id: "R-0003-reviewer-architecture", phase: "v1", round: 3, step: "reviewer-architecture", role: "reviewer", liveWorkspace: true },
  ];
  const disjoint = outerLoopState({
    handoffs: hotHandoffs,
    baselineFacts: baseline,
    facts: hotFacts,
    prepared: activePrepared,
    packageFiles: ["scripts/clean.mjs", "docs/**"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(disjoint.archReviewActive, true);
  assert.deepEqual(disjoint.hotspotPaths, ["scripts/hotspot.mjs"]);
  assert.equal(disjoint.blocked, false);

  const dirOverlap = outerLoopState({
    handoffs: hotHandoffs,
    baselineFacts: baseline,
    facts: hotFacts,
    prepared: activePrepared,
    packageFiles: ["scripts/"],
    deliveries: 10,
    outerGrace: 1,
    phase: "v1",
    targetSha: cHot,
  });
  assert.equal(dirOverlap.blocked, true);

  const t1Hard = outerLoopState({
    handoffs: [
      handoffs[0],
      { id: "R-0002-actor", phase: "v1", round: 2, step: "actor", role: "actor" },
      { id: "R-0003-actor", phase: "v1", round: 3, step: "actor", role: "actor" },
      { id: "R-0004-actor", phase: "v1", round: 4, step: "actor", role: "actor" },
    ],
    prepared: activePrepared,
    packageFiles: ["scripts/clean.mjs"],
    deliveries: 2,
    outerGrace: 1,
    phase: "v1",
  });
  assert.equal(t1Hard.status, "hard-due");
  assert.equal(t1Hard.t1Due, true);
  assert.equal(t1Hard.t3Due, false);
  assert.equal(t1Hard.blocked, true);
});
