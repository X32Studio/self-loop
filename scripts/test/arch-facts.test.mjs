import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ARCH_THRESHOLDS, archCacheDir, buildImportGraph, collectArchFacts, compareArchFacts, structuralBreaches } from "../lib/arch-facts.mjs";
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

test("clean repository reports zero structural breaches and skips ignored directories", () => {
  const r = repo({
    "src/a.mjs": linesOf(40),
    "src/b.mjs": 'import { v_0 } from "./a.mjs";\nexport const out = v_0;\n',
    "node_modules/pkg/huge.js": linesOf(1500),
    "dist/bundle.js": linesOf(1500),
    "build/out.js": linesOf(1500),
    "test/big.test.js": linesOf(1200),
    "tests/spec.js": linesOf(1200),
    "acceptance/e2e.mjs": linesOf(1200),
    "test-support/fixtures.mjs": linesOf(1200),
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.equal(facts.sourceFileCount, 2);
  assert.deepEqual(facts.largestFiles.map(f => f.path), ["src/a.mjs", "src/b.mjs"]);
  assert.deepEqual(structuralBreaches(facts), []);
});

test("soft (>500) vs hard (>800) line thresholds flag hard breach only as T3", () => {
  const r = repo({
    "src/soft.mjs": linesOf(550),
    "src/hard.mjs": linesOf(850),
    "src/small.mjs": linesOf(25),
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.equal(facts.thresholds.softLines, ARCH_THRESHOLDS.softLines);
  assert.equal(facts.thresholds.hardLines, ARCH_THRESHOLDS.hardLines);

  const byPath = new Map(facts.largestFiles.map(f => [f.path, f]));
  assert.equal(byPath.get("src/soft.mjs").softBreach, true);
  assert.equal(byPath.get("src/soft.mjs").hardBreach, false);
  assert.equal(byPath.get("src/hard.mjs").softBreach, true);
  assert.equal(byPath.get("src/hard.mjs").hardBreach, true);
  assert.equal(byPath.get("src/small.mjs").softBreach, false);

  const breaches = structuralBreaches(facts);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, "file-size");
  assert.equal(breaches[0].path, "src/hard.mjs");
});

test("growth >= 35% from >= 100 baseline lines triggers file-growth breach; small files do not", () => {
  const r = repo({
    "src/growing.mjs": linesOf(200),
    "src/tiny.mjs": linesOf(20),
    "src/steady.mjs": linesOf(200),
  });
  const baseSha = git(r, "rev-parse", "HEAD");
  const headSha = putCommit(r, {
    "src/growing.mjs": linesOf(280),
    "src/tiny.mjs": linesOf(80),
    "src/steady.mjs": linesOf(240),
  }, "grow files");

  const facts = collectArchFacts(r, headSha, { baselineSha: baseSha });
  const byPath = new Map(facts.largestFiles.map(f => [f.path, f]));
  assert.equal(byPath.get("src/growing.mjs").baselineLines, 200);
  assert.equal(byPath.get("src/growing.mjs").growthPct, 40);
  assert.equal(byPath.get("src/growing.mjs").growthBreach, true);
  assert.equal(byPath.get("src/tiny.mjs").growthBreach, false);
  assert.equal(byPath.get("src/steady.mjs").growthBreach, false);

  const breaches = structuralBreaches(facts);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, "file-growth");
  assert.equal(breaches[0].path, "src/growing.mjs");
});

test("D-0064 T8: churn >= 3 emits churn-hotspot only on structural degradation, never for healthy shrinking or constant-size refactors", () => {
  const filler = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/pad-${String(i).padStart(2, "0")}.mjs`, linesOf(60)]));
  const r = repo({
    ...filler,
    "src/growing.mjs": linesOf(20),
    "src/shrinking.mjs": linesOf(30),
    "src/steady.mjs": linesOf(25),
    "src/rot-shrink.mjs": linesOf(30),
    "src/calm.mjs": linesOf(20),
  });
  const baseSha = git(r, "rev-parse", "HEAD");
  const baseFacts = collectArchFacts(r, baseSha);
  putCommit(r, {
    "src/growing.mjs": linesOf(21),
    "src/shrinking.mjs": linesOf(28),
    "src/steady.mjs": linesOf(25, "export const s1"),
    "src/rot-shrink.mjs": linesOf(28),
    "src/calm.mjs": linesOf(21),
  }, "touch 1");
  putCommit(r, {
    "src/growing.mjs": linesOf(22),
    "src/shrinking.mjs": linesOf(26),
    "src/steady.mjs": linesOf(25, "export const s2"),
    "src/rot-shrink.mjs": linesOf(26),
  }, "touch 2");
  const headSha = putCommit(r, {
    "src/growing.mjs": linesOf(23),
    "src/shrinking.mjs": linesOf(24),
    "src/steady.mjs": linesOf(25, "export const s3"),
    "src/rot-shrink.mjs": linesOf(23) + 'export const port = "localhost:8080";\n',
  }, "touch 3");

  const facts = collectArchFacts(r, headSha, { baselineSha: baseSha });
  assert.deepEqual(facts.churnHotspots, [
    { path: "src/growing.mjs", commits: 3 },
    { path: "src/rot-shrink.mjs", commits: 3 },
    { path: "src/shrinking.mjs", commits: 3 },
    { path: "src/steady.mjs", commits: 3 },
  ]);

  for (const breaches of [structuralBreaches(facts), compareArchFacts(facts, baseFacts)]) {
    const churnPaths = breaches.filter(b => b.kind === "churn-hotspot").map(b => b.path).sort();
    assert.deepEqual(churnPaths, ["src/growing.mjs", "src/rot-shrink.mjs"]);
    assert.equal(breaches.some(b => b.path === "src/shrinking.mjs"), false);
    assert.equal(breaches.some(b => b.path === "src/steady.mjs"), false);
  }
});

test("static ES import hubs compute fanIn/fanOut and parallelSiblings stay informational (not breaches)", () => {
  const r = repo({
    "src/core/shared.mjs": "export const s = 1;\n",
    "src/core/util.mjs": 'import { s } from "./shared.mjs";\nexport const u = s;\n',
    "src/a/alpha-kernel.mjs": [
      'import { s } from "../core/shared.mjs";',
      'import { u } from "../core/util.mjs";',
      'export { s } from "../core/shared.mjs";',
      "export const alpha = s + u;",
    ].join("\n") + "\n",
    "src/b/beta-kernel.mjs": 'import { s } from "../core/shared";\nexport const beta = s;\n',
    "src/c/plan-scheduler.ts": 'import { s } from "../core/shared.mjs";\nexport const p = s;\n',
    "src/d/cop-scheduler.ts": 'import { u } from "../core/util";\nexport const c = u;\n',
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);

  const hubByPath = new Map(facts.importHubs.map(h => [h.path, h]));
  assert.deepEqual(hubByPath.get("src/core/shared.mjs"), { path: "src/core/shared.mjs", fanIn: 4, fanOut: 0 });
  assert.deepEqual(hubByPath.get("src/core/util.mjs"), { path: "src/core/util.mjs", fanIn: 2, fanOut: 1 });
  assert.deepEqual(hubByPath.get("src/a/alpha-kernel.mjs"), { path: "src/a/alpha-kernel.mjs", fanIn: 0, fanOut: 2 });

  const siblingByRole = new Map(facts.parallelSiblings.map(s => [s.role, s]));
  assert.deepEqual(siblingByRole.get("kernel").paths, ["src/a/alpha-kernel.mjs", "src/b/beta-kernel.mjs"]);
  assert.deepEqual(siblingByRole.get("scheduler").paths, ["src/c/plan-scheduler.ts", "src/d/cop-scheduler.ts"]);
  assert.deepEqual(structuralBreaches(facts), [], "parallelSiblings are screening facts, never T3 hard breaches");

  const graph = buildImportGraph(r, sha);
  assert.equal(graph.files.length, 6);
  assert.ok(graph.edges.some(e => e.from === "src/a/alpha-kernel.mjs" && e.to === "src/core/shared.mjs"));
  assert.equal(graph.inEdges.get("src/core/shared.mjs").size, 4);
});

// F-0015, P-0014, P-0015, R-0055-judge-frame-hygiene
test("F-0015 A9: collectArchFacts caches tree metrics under host-level arch-cache without mutating .git (pruned to 16, fail-open) while recomputing churn per commit", t => {
  const nonGit = realpathSync(mkdtempSync(join(tmpdir(), "arch-non-git-")));
  t.after(() => rmSync(nonGit, { recursive: true, force: true }));
  assert.equal(archCacheDir(nonGit), null);

  const r = repo({ "src/churn.mjs": linesOf(25), "src/stable.mjs": linesOf(20) });
  const cacheDir = archCacheDir(r);
  assert.ok(cacheDir);
  t.after(() => rmSync(dirname(cacheDir), { recursive: true, force: true }));

  const commonDir = realpathSync(git(r, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  assert.equal(cacheDir.startsWith(commonDir), false);
  const baseSha = git(r, "rev-parse", "HEAD");
  const c1 = putCommit(r, { "src/churn.mjs": linesOf(30) }, "bump 1");
  const facts1 = collectArchFacts(r, c1, { baselineSha: baseSha });
  assert.deepEqual(facts1.churnHotspots, []);
  assert.equal(existsSync(join(commonDir, "self-loop-suite")), false);

  const targetTree = git(r, "rev-parse", `${c1}^{tree}`);
  const baseTree = git(r, "rev-parse", `${baseSha}^{tree}`);
  const matching = readdirSync(cacheDir).filter(n => n.startsWith(`arch-facts-v2-${targetTree}-${baseTree}-`) && n.endsWith(".json"));
  assert.equal(matching.length, 1);

  putCommit(r, { "src/churn.mjs": linesOf(35) }, "bump 2");
  const c3 = putCommit(r, { "src/churn.mjs": linesOf(30) }, "revert to c1 tree");
  assert.equal(git(r, "rev-parse", `${c3}^{tree}`), targetTree);
  const facts3 = collectArchFacts(r, c3, { baselineSha: baseSha });
  assert.equal(facts3.sha, c3);
  assert.equal(facts3.sourceFileCount, facts1.sourceFileCount);
  assert.deepEqual(facts3.fileLines, facts1.fileLines);
  assert.deepEqual(facts3.churnHotspots, [{ path: "src/churn.mjs", commits: 3 }]);

  for (let i = 0; i < 18; i++) {
    const s = putCommit(r, { "src/stable.mjs": linesOf(21 + i) }, `grow-${i}`);
    collectArchFacts(r, s, { baselineSha: baseSha });
  }
  assert.ok(readdirSync(cacheDir).filter(n => n.startsWith("arch-facts-v2-") && n.endsWith(".json")).length <= 16);
  assert.equal(existsSync(join(commonDir, "self-loop-suite")), false);

  rmSync(cacheDir, { recursive: true, force: true });
  writeFileSync(cacheDir, "unwritable-cache-sentinel");
  const failOpen = collectArchFacts(r, c3, { baselineSha: baseSha });
  assert.deepEqual(failOpen.churnHotspots, [{ path: "src/churn.mjs", commits: 3 }]);
  assert.equal(existsSync(join(commonDir, "self-loop-suite")), false);
});
