// P-0011, D-0058, design/two-loop-rhythm.md#6
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ANTI_ROT_THRESHOLDS, antiRotBreaches, scanAntiRot } from "../lib/anti-rot.mjs";
import { collectArchFacts, structuralBreaches } from "../lib/arch-facts.mjs";
import { outerLoopState } from "../lib/cadence.mjs";
import { git, repo } from "./helpers.mjs";

test("1. clean repo with pointer-only comments and wired exports produces zero anti-rot findings", () => {
  const r = repo({
    "src/math.mjs": [
      "// P-0011, design/two-loop-rhythm.md",
      "// P-0011, D-0058, design/two-loop-rhythm.md#6",
      "export function add(a, b) { return a + b; }",
      "export const SCALE = 2;",
    ].join("\n") + "\n",
    "src/index.mjs": [
      "// P-0011, design/two-loop-rhythm.md",
      'import { add, SCALE } from "./math.mjs";',
      "export const compute = x => add(x, SCALE);",
    ].join("\n") + "\n",
    "test/math.test.mjs": [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../src/math.mjs";',
      'test("adds", () => assert.equal(add(1, 2), 3));',
    ].join("\n") + "\n",
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.deepEqual(facts.antiRot, {
    compatRemnants: [],
    deadExports: [],
    hardcodedLiterals: [],
    testRot: [],
    commentBloat: [],
  });
  assert.deepEqual(structuralBreaches(facts), []);
});

test("2. compatRemnants detects legacy identifiers and compat filenames while ignoring string literals", () => {
  const r = repo({
    "src/compat-shim.js": "export const bridge = 1;\n",
    "src/engine.mjs": [
      "export function legacyAdapter(x) { return x; }",
      'export const ruleMessage = "never add a legacy compat shim or fallback";',
      "export const ok = legacyAdapter(1);",
    ].join("\n") + "\n",
    "src/index.mjs": [
      'import { bridge } from "./compat-shim.js";',
      'import { ruleMessage, ok } from "./engine.mjs";',
      "export const run = () => [bridge, ok, ruleMessage];",
    ].join("\n") + "\n",
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.deepEqual(facts.antiRot.compatRemnants, [
    { path: "src/compat-shim.js", line: 0, kind: "filename", marker: "compat-shim.js" },
    { path: "src/engine.mjs", line: 1, kind: "identifier", marker: "legacyAdapter" },
  ]);
  const breaches = structuralBreaches(facts);
  assert.equal(breaches.filter(b => b.kind === "compat-remnant").length, 2);
});

test("3. deadExports flags unreferenced exports while ignoring CLI entrypoints and imported symbols", () => {
  const r = repo({
    "scripts/tool.mjs": "#!/usr/bin/env node\nexport const cliEntry = true;\n",
    "src/index.mjs": "export const publicApi = 1;\n",
    "src/ns.mjs": "export const alpha = 1;\nexport const beta = 2;\n",
    "src/helpers.mjs": [
      "export function usedBySrc() { return 1; }",
      "export function usedByTest() { return 2; }",
      "export function unusedHelper() { return 3; }",
      "const hidden = 4;",
      "export { hidden as orphanAlias };",
    ].join("\n") + "\n",
    "src/main.mjs": [
      'import { usedBySrc } from "./helpers.mjs";',
      'import * as ns from "./ns.mjs";',
      "export const value = usedBySrc() + ns.alpha;",
    ].join("\n") + "\n",
    "test/helpers.test.mjs": [
      'import test from "node:test";',
      'import { usedByTest } from "../src/helpers.mjs";',
      'test("used", () => usedByTest());',
    ].join("\n") + "\n",
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.deepEqual(facts.antiRot.deadExports, [
    { path: "src/helpers.mjs", symbol: "orphanAlias" },
    { path: "src/helpers.mjs", symbol: "unusedHelper" },
  ]);
  const withDead = antiRotBreaches(facts.antiRot, { includeDeadExports: true });
  assert.deepEqual(withDead.map(b => `${b.kind}:${b.path}:${b.detail}`), [
    'dead-export:src/helpers.mjs:exported symbol "orphanAlias" has 0 internal importers',
    'dead-export:src/helpers.mjs:exported symbol "unusedHelper" has 0 internal importers',
  ]);
  assert.deepEqual(structuralBreaches(facts), []);
});

test("4. hardcodedLiterals detects host home paths and loopback ports while excluding config/example files", () => {
  const r = repo({
    "src/service.mjs": [
      'export const secretPath = "/home/alice/secret/key.pem";',
      'export const macPath = "/Users/bob/work/token";',
      'export const apiUrl = "http://localhost:8080/v1";',
      'export const loopUrl = "http://127.0.0.1:9001/health";',
    ].join("\n") + "\n",
    "src/defaults.mjs": 'export const devUrl = "http://localhost:3000";\n',
    "config/local.mjs": 'export const home = "/home/dev/cache";\n',
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.deepEqual(facts.antiRot.hardcodedLiterals, [
    { path: "src/service.mjs", line: 1, kind: "host-path", match: "/home/alice/" },
    { path: "src/service.mjs", line: 2, kind: "host-path", match: "/Users/bob/" },
    { path: "src/service.mjs", line: 3, kind: "loopback-port", match: "localhost:8080" },
    { path: "src/service.mjs", line: 4, kind: "loopback-port", match: "127.0.0.1:9001" },
  ]);
  const breaches = structuralBreaches(facts);
  assert.equal(breaches.filter(b => b.kind === "hardcoded-literal").length, 4);
});

test("5. testRot detects skipped and todo tests across both dot-syntax and options-object forms", () => {
  const r = repo({
    "src/app.mjs": "export const ok = true;\n",
    "test/app.test.mjs": [
      'import test from "node:test";',
      "// test.skip('commented out text is ignored')",
      'test("active test", () => {});',
      'test.skip("silently skipped", () => {});',
      'it.todo("unfinished case");',
      'test("option skip", { skip: true }, () => {});',
      'test("option todo reason", { timeout: 500, todo: "later" }, () => {});',
    ].join("\n") + "\n",
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  assert.deepEqual(facts.antiRot.testRot, [
    { path: "test/app.test.mjs", line: 4, kind: "skip" },
    { path: "test/app.test.mjs", line: 5, kind: "todo" },
    { path: "test/app.test.mjs", line: 6, kind: "skip" },
    { path: "test/app.test.mjs", line: 7, kind: "todo" },
  ]);
  const breaches = structuralBreaches(facts);
  assert.equal(breaches.filter(b => b.kind === "test-rot").length, 4);
});

test("6. commentBloat flags bulky narrative comments while allowing pointers, SPDX, shebangs, and tool directives", () => {
  const narrative = Array.from({ length: 8 }, (_, i) => `// Narrative line ${i + 1} explaining design details in code.`).join("\n");
  const longNarrative = Array.from({ length: 14 }, (_, i) => `// Excess prose explanation ${i + 1} that belongs in design docs.`).join("\n");
  const bigCode = Array.from({ length: 120 }, (_, i) => `const c${i} = ${i};`).join("\n");
  const pointersAndDirectives = [
    "#!/usr/bin/env node",
    "// SPDX-License-Identifier: MIT",
    "// P-0011, design/two-loop-rhythm.md",
    "// P-0011, D-0058, design/two-loop-rhythm.md#6",
    "// eslint-disable-next-line no-unused-vars",
    "/* c8 ignore next */",
    "// @ts-expect-error",
    "export const clean = 1;",
    "export const cleanTwo = 2;",
  ].join("\n") + "\n";

  const result = scanAntiRot({
    sourceFiles: [
      { path: "src/clean.mjs", text: pointersAndDirectives },
      { path: "src/ratio-bloat.mjs", text: `${narrative}\nexport const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\n` },
      { path: "src/count-bloat.mjs", text: `${longNarrative}\n${bigCode}\nexport const total = c0;\n` },
    ],
    thresholds: ANTI_ROT_THRESHOLDS,
  });

  assert.deepEqual(result.commentBloat.map(c => c.path), ["src/count-bloat.mjs", "src/ratio-bloat.mjs"]);
  const countHit = result.commentBloat.find(c => c.path === "src/count-bloat.mjs");
  const ratioHit = result.commentBloat.find(c => c.path === "src/ratio-bloat.mjs");
  assert.equal(countHit.proseLines, 14);
  assert.equal(ratioHit.proseLines, 8);
  assert.ok(ratioHit.ratio >= ANTI_ROT_THRESHOLDS.maxCommentRatio);
});

test("7. end-to-end collectArchFacts + structuralBreaches drives T3 in outerLoopState", () => {
  const proseBlock = Array.from({ length: 13 }, (_, i) => `// Bulky prose comment number ${i + 1} explaining why this exists.`).join("\n");
  const r = repo({
    "src/rot.mjs": `${proseBlock}\nexport function legacyBridge() { return "/home/alice/data"; }\n`,
    "test/rot.test.mjs": 'import test from "node:test";\ntest.skip("disabled", () => {});\n',
  });
  const sha = git(r, "rev-parse", "HEAD");
  const facts = collectArchFacts(r, sha);
  const breaches = structuralBreaches(facts);
  const kinds = new Set(breaches.map(b => b.kind));
  assert.ok(kinds.has("compat-remnant"));
  assert.ok(kinds.has("hardcoded-literal"));
  assert.ok(kinds.has("test-rot"));
  assert.ok(kinds.has("comment-bloat"));

  const asyncState = outerLoopState({
    handoffs: [{ id: "R-0001-reviewer-frame", phase: "P1", round: 1, step: "reviewer-frame", role: "reviewer" }],
    archBreaches: breaches,
    deliveries: 4,
    outerGrace: 1,
    phase: "P1",
    targetSha: sha,
  });
  assert.equal(asyncState.t3Due, true);
  assert.equal(asyncState.status, "async-due");
  assert.equal(asyncState.graceRemaining, 1);

  const hardState = outerLoopState({
    handoffs: [
      { id: "R-0001-reviewer-frame", phase: "P1", round: 1, step: "reviewer-frame", role: "reviewer" },
      { id: "R-0002-actor", phase: "P1", round: 2, step: "actor", role: "actor" },
    ],
    archBreaches: breaches,
    deliveries: 4,
    outerGrace: 1,
    phase: "P1",
    targetSha: sha,
  });
  assert.equal(hardState.t3Due, true);
  assert.equal(hardState.status, "hard-due");
  assert.equal(hardState.graceRemaining, 0);
});

test("8. regex quotes, template expressions, comments, string test fixtures, and self-dogfooding stay accurate", () => {
  const res = scanAntiRot({
    sourceFiles: [{
      path: "src/lex.mjs",
      text: [
        "// legacy comment and /Users/alice/projects should be ignored",
        "const QUOTE_RE = /['\"`]/; export const legacySameLine = 1;",
        "const TICK_RE = /`/;",
        "export function afterRegex() { return QUOTE_RE.test('a') && TICK_RE.test('b'); }",
        "export const tmpl = `prefix ${legacyInExpr} suffix`;",
        "export const legacyAfterRegex = 1;",
      ].join("\n") + "\n",
    }],
    testFiles: [{
      path: "test/lex.test.mjs",
      text: [
        'const fixture = "test.skip(\'fake\', () => {})";',
        'const optFixture = \'test("fake", { todo: "nope" }, () => {})\';',
        'test("real todo", { todo: "later" }, () => {});',
      ].join("\n") + "\n",
    }],
  });
  assert.deepEqual(res.compatRemnants.map(h => h.marker), ["legacySameLine", "legacyInExpr", "legacyAfterRegex"]);
  assert.deepEqual(res.deadExports.map(h => h.symbol), ["afterRegex", "legacyAfterRegex", "legacySameLine", "tmpl"]);
  assert.deepEqual(res.hardcodedLiterals, []);
  assert.deepEqual(res.testRot, [{ path: "test/lex.test.mjs", line: 3, kind: "todo" }]);

  const selfRes = scanAntiRot({
    sourceFiles: [
      { path: "scripts/lib/anti-rot.mjs", text: readFileSync(new URL("../lib/anti-rot.mjs", import.meta.url), "utf8") },
      { path: "scripts/lib/arch-facts.mjs", text: readFileSync(new URL("../lib/arch-facts.mjs", import.meta.url), "utf8") },
    ],
    testFiles: [
      { path: "scripts/test/anti-rot.test.mjs", text: readFileSync(new URL("./anti-rot.test.mjs", import.meta.url), "utf8") },
      { path: "scripts/test/arch-facts.test.mjs", text: readFileSync(new URL("./arch-facts.test.mjs", import.meta.url), "utf8") },
      { path: "scripts/test/cadence-delta.test.mjs", text: readFileSync(new URL("./cadence-delta.test.mjs", import.meta.url), "utf8") },
    ],
  });
  assert.deepEqual(selfRes.compatRemnants, []);
  assert.deepEqual(selfRes.hardcodedLiterals, []);
  assert.deepEqual(selfRes.testRot, []);
  assert.deepEqual(selfRes.commentBloat, []);
  assert.deepEqual(selfRes.deadExports, []);
});
