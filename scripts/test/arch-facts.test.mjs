import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { ARCH_THRESHOLDS, collectArchFacts, structuralBreaches } from "../lib/arch-facts.mjs";
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
    "src/growing.mjs": linesOf(280), // +40% >= 35%
    "src/tiny.mjs": linesOf(80), // +300%, but baselineLines < 100
    "src/steady.mjs": linesOf(240), // +20% < 35%
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

test("churn >= 3 distinct commits since baselineSha triggers churn-hotspot breach", () => {
  const r = repo({
    "src/hot.mjs": linesOf(20),
    "src/calm.mjs": linesOf(20),
  });
  const baseSha = git(r, "rev-parse", "HEAD");
  putCommit(r, { "src/hot.mjs": linesOf(21), "src/calm.mjs": linesOf(21) }, "touch 1");
  putCommit(r, { "src/hot.mjs": linesOf(22) }, "touch 2");
  const headSha = putCommit(r, { "src/hot.mjs": linesOf(23) }, "touch 3");

  const facts = collectArchFacts(r, headSha, { baselineSha: baseSha });
  assert.deepEqual(facts.churnHotspots, [{ path: "src/hot.mjs", commits: 3 }]);

  const breaches = structuralBreaches(facts);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, "churn-hotspot");
  assert.equal(breaches[0].path, "src/hot.mjs");
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
});
