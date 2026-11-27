// D-0016, R-0008-judge-frame
import assert from "node:assert/strict";
import test from "node:test";
import { addedProse, proseLines } from "../lib/comments.mjs";

test("flow: actor hands off division after an object; loss: false-verdict from guessing regex context", () => {
  const source = 'const ratio = {} / 2; const label = "// data"; // Explain ratio.\n';
  assert.equal(proseLines("a.mjs", source)[0].text, "Explain ratio.");
  assert.equal(proseLines("a.mjs", source)[0].scope, "comment");
});

test("flow: unfamiliar tool syntax is judged then source changes; loss: stale false-verdict", () => {
  const path = "a.mjs", source = "// @tool-option enabled\nexport {};\n";
  const [pending] = proseLines(path, source);
  assert.equal(pending.status, "pending");
  assert.match(pending.source, /^[a-f0-9]{64}$/);
  const resolutions = [{ ...pending, verdict: "directive", evidence: "consumer syntax" }];
  assert.deepEqual(proseLines(path, source, { resolutions }), []);
  assert.equal(proseLines(path, source + "\n", { resolutions })[0].status, "pending");
  assert.equal(proseLines("b.mjs", source, { resolutions })[0].status, "pending");
  assert.equal(proseLines(path, source, { resolutions: [{ ...resolutions[0], rule: "other" }] })[0].status, "pending");
  assert.equal(addedProse([{ path, before: source, after: source + "\n" }], { resolutions })[0].status, "pending");
});

test("flow: ordinary prose and recognized directives reach hand-off; loss: false-verdict", () => {
  const text = "// Explain the result.\nexport {};\n";
  const [candidate] = proseLines("a.mjs", text);
  assert.equal(candidate.status, "pending");
  assert.deepEqual(proseLines("a.mjs", text, { resolutions: [{ ...candidate, verdict: "prose", evidence: "Independent review establishes explanatory prose, no tool consumer." }] }), [{ line: 1, text: "Explain the result." }]);
  assert.deepEqual(proseLines("a.mjs", "// @ts-check\nexport {};\n"), []);
});

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { commentResolutions, ProseBudgetExceededError, proseCacheDir, proseInTree } from "../lib/comments.mjs";

test("flow: audited judge resolves a frozen source at hand-off and phase-close; loss: actor bypass or stale approval", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "comment-resolution-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = join(root, "records"), product = join(root, "product");
  const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (repo, path, data) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), data); };
  for (const repo of [records, product]) {
    mkdirSync(repo); git(repo, "init", "-q"); git(repo, "config", "user.email", "test@example.test"); git(repo, "config", "user.name", "Test");
  }
  const commit = repo => { git(repo, "add", "."); git(repo, "commit", "-qm", "fixture"); return git(repo, "rev-parse", "HEAD"); };
  const path = "a.mjs", text = "// @new-tool-mode enabled\nexport {};\n";
  put(product, path, text);
  const sha = commit(product), [candidate] = proseLines(path, text);
  assert.throws(() => proseInTree(product, sha), /pending independent/);
  const row = { ...candidate, verdict: "directive", evidence: "https://consumer.example/syntax" };
  put(records, "actor-exceptions.json", JSON.stringify([row])); commit(records);
  assert.deepEqual(commentResolutions(records), []);
  const prefix = "sealed/judge/0001/judge-1", auditFile = `${prefix}-audit.json`, file = `${prefix}/out/comment-resolutions.json`;
  const h = { id: "R-0001-judge", role: "judge", step: "judge", round: 1, phase: "v1", attempt: 1, view: sha,
    agent: { runner: "t3", session: "independent-judge" }, product: { base: sha, commit: sha }, audit: { violations: 0 },
    record: "rounds/0001-judge.md", files: ["rounds/0001-judge.md", auditFile, file] };
  put(records, h.record, "# R-0001-judge\n");
  put(records, "metrics/handoffs.jsonl", JSON.stringify(h) + "\n");
  put(records, auditFile, JSON.stringify({ id: h.id, role: "judge", attempt: 1, exit: 0, agent: h.agent }));
  put(records, file, JSON.stringify([row]));
  assert.deepEqual(commentResolutions(records), []);
  commit(records);
  assert.equal(commentResolutions(records).length, 1);
  assert.deepEqual(proseInTree(product, sha, { records }), []);
  put(product, path, text + "export const n = 1;\n");
  assert.throws(() => proseInTree(product, commit(product), { records }), /pending independent/);
  put(records, file, JSON.stringify([{ ...row, verdict: "prose" }])); commit(records);
  assert.deepEqual(proseInTree(product, sha, { records }), [], "later edits cannot replace the published judge output");
  const handoffs = [h];
  const fresh = rows => {
    const attempt = handoffs.length + 1, prefix = `sealed/judge/0001/judge-${attempt}`;
    const file = `${prefix}/out/comment-resolutions.json`, audit = `${prefix}-audit.json`;
    const next = { ...h, attempt, files: [h.record, file, audit] };
    handoffs.push(next);
    put(records, file, JSON.stringify(rows));
    put(records, audit, JSON.stringify({ id: h.id, role: "judge", attempt, exit: 0, agent: h.agent }));
    put(records, "metrics/handoffs.jsonl", handoffs.map(r => JSON.stringify(r)).join("\n") + "\n");
    commit(records);
  };
  const ambiguousSql = "SELECT 'it\\'s -- data';\n";
  put(product, "a.sql", ambiguousSql);
  put(product, path, text);
  const tree = commit(product), [whole] = proseLines("a.sql", ambiguousSql);
  assert.equal(whole.scope, "source");
  assert.throws(() => proseInTree(product, tree, { records }), /pending independent/);
  const wholeRuling = { ...whole, verdict: "compliant", evidence: "Independent SQL dialect review: MySQL backslash escape, no comments." };
  fresh([wholeRuling]);
  assert.deepEqual(proseInTree(product, tree, { records }), []);
  assert.deepEqual(addedProse([{ path: "a.sql", before: null, after: ambiguousSql }], { resolutions: commentResolutions(records) }), []);
  fresh([{ ...wholeRuling, verdict: "prose" }]);
  assert.equal(proseInTree(product, tree, { records })[0].path, "a.sql");
  put(records, "metrics/handoffs.jsonl", [...handoffs, { ...h, role: "actor", step: "actor", id: "R-0001-actor", record: "rounds/0001-actor.md", files: ["rounds/0001-actor.md"] }].map(r => JSON.stringify(r)).join("\n") + "\n");
  commit(records);
  assert.deepEqual(commentResolutions(records), [], "an author session cannot independently judge its own work");

});

// D-0016, D-0064, R-0008-judge-frame
test("flow: supported languages establish lexical coverage deterministically while dialect-ambiguous SQL and NUL stay source-pending", () => {
  for (const [path, text] of [
    ["a.ts", "type T = number;"], ["plain.ts", "const x = 1;"], ["a.tsx", "const x = <div/>;"], ["a.jsx", "const x = <div/>;"], ["a.js", "const x = <div/>;"],
    ["a.swift", 'let x = #"// data"#'], ["a.py", 'x = "# data"'],
    ["a.sh", 'echo "# data"'], ["a.zsh", "echo ok"], ["a.yaml", "key: value"],
    ["a.sql", "SELECT 1"], ["a.css", "a {}"], ["a.html", "<p>hello</p>"],
    ["a.go", "package main"], ["a.rs", "fn main() {}"], ["a.c", "int x = 1;"], ["a.cpp", "int x = 1;"],
    ["a.java", "class A {}"], ["a.kt", "val x = 1"], ["a.toml", 'k = "v"'],
  ]) {
    assert.deepEqual(proseLines(path, text), [], path);
  }
  for (const [path, text] of [
    ["a.sql", "SELECT 'it\\'s -- data';\n"],
    ["a.sql", "SELECT 1; /* outer /* inner */ -- tail\n"],
    ["a.js", "\0"],
  ]) {
    const [candidate] = proseLines(path, text);
    assert.equal(candidate.scope, "source", path);
    assert.equal(candidate.status, "pending", path);
    const row = { ...candidate, verdict: "compliant", evidence: "Independent whole-source review against language and consumer facts." };
    assert.deepEqual(proseLines(path, text, { resolutions: [row] }), []);
    assert.equal(proseLines(path, text + "\n", { resolutions: [row] })[0].status, "pending");
    assert.equal(proseLines(path, text, { resolutions: [{ ...row, verdict: "literal" }] })[0].status, "pending");
    assert.equal(proseLines(path, text, { resolutions: [{ ...row, contract: "old" }] })[0].status, "pending");
    assert.equal(proseLines(path, text, { resolutions: [{ ...row, scope: "comment" }] })[0].status, "pending");
    assert.equal(proseLines(path, text, { resolutions: [{ ...row, verdict: "prose" }] })[0].status, undefined);
  }
});

test("flow: unfamiliar directives need no special spelling; loss: false refusal and conflicting approval", () => {
  for (const words of ["region Worker", "GENERATED FILE", "tool(option)", "Explain the result."]) {
    const path = "a.js", text = `// ${words}\nexport {};`;
    const [candidate] = proseLines(path, text);
    assert.equal(candidate.status, "pending");
    const row = { ...candidate, verdict: "directive", evidence: "Consumer facts" };
    assert.deepEqual(proseLines(path, text, { resolutions: [row] }), []);
    assert.equal(proseLines(path, text, { resolutions: [row, { ...row, verdict: "prose" }] })[0].status, undefined);
    assert.equal(proseLines(path, text, { resolutions: [{ ...row, evidence: "" }] })[0].status, "pending");
  }
  assert.deepEqual(proseLines("a.js", '// @ts-check\nconst data = "// hello";\n'), []);
});

// D-0016, D-0064
test("source prose retains identity and cannot spend coverage labels as move credits", () => {
  const before = "-- Old explanation\nSELECT 'it\\'s -- data', 1;\n";
  const after = "-- Different explanation\n-- Newly added explanation\nSELECT 'it\\'s -- data', 2;\n";
  const judge = (path, source, proseComments) => ({ ...proseLines(path, source)[0], verdict: "prose", evidence: "Independent whole-source inventory", ...(proseComments ? { proseComments } : {}) });
  const resolutions = [judge("a.sql", before), judge("a.sql", after), judge("b.sql", after)];
  const [finding] = proseLines("a.sql", after, { resolutions });
  assert.equal(finding.scope, "source");
  assert.equal(finding.path, "a.sql");
  assert.equal(finding.source, resolutions[1].source);
  assert.equal(addedProse([{ path: "a.sql", before, after }], { resolutions }).length, 1);
  assert.equal(addedProse([{ path: "a.sql", before, after: null }, { path: "b.sql", before: null, after }], { resolutions }).length, 1);
  assert.deepEqual(addedProse([{ path: "a.sql", before, after: before }], { resolutions }), []);
  assert.deepEqual(addedProse([{ path: "a.sql", before, after: null }], { resolutions }), []);
  const edited = before.replace(", 1;", ", 2;");
  const inventories = [judge("a.sql", before, ["Old explanation"]), judge("a.sql", edited, ["Old explanation"])];
  assert.deepEqual(addedProse([{ path: "a.sql", before, after: edited }], { resolutions: inventories }), []);
  const reduced = "-- Old explanation\nSELECT 'it\\'s -- data', 3;\n";
  const multiple = "-- Old explanation\n-- Remove this prose\nSELECT 'it\\'s -- data', 1;\n";
  assert.deepEqual(addedProse([{ path: "a.sql", before: multiple, after: reduced }], { resolutions: [
    judge("a.sql", multiple, ["Old explanation", "Remove this prose"]), judge("a.sql", reduced, ["Old explanation"]),
  ] }), []);
  assert.equal(addedProse([{ path: "a.sql", before, after }], { resolutions: [
    judge("a.sql", before, ["Old explanation"]), judge("a.sql", after, ["Different explanation", "Newly added explanation"]),
  ] }).length, 1);
  const duplicate = "-- Old explanation\n" + edited;
  inventories.push(judge("a.sql", duplicate, ["Old explanation", "Old explanation"]));
  assert.equal(addedProse([{ path: "a.sql", before, after: duplicate }], { resolutions: inventories }).length, 1);
  inventories.push(judge("a.sql", edited));
  assert.deepEqual(addedProse([{ path: "a.sql", before, after: edited }], { resolutions: inventories }), [], "a fresh complete inventory may supplement an earlier bare verdict");
  inventories.push(judge("a.sql", edited, ["Different explanation"]));
  assert.equal(addedProse([{ path: "a.sql", before, after: edited }], { resolutions: inventories }).length, 1, "conflicting inventories cannot certify a delta");
});

// D-0016, D-0064
test("publication binds resolution and audit bytes; a fresh judge can resolve pending source", t => {
  const records = realpathSync(mkdtempSync(join(tmpdir(), "comment-publication-")));
  t.after(() => rmSync(records, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", records, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const put = (path, data) => { mkdirSync(dirname(join(records, path)), { recursive: true }); writeFileSync(join(records, path), data); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); };
  const source = "SELECT 'it\\'s -- data';\n", candidate = proseLines("a.sql", source)[0];
  const row = { ...candidate, verdict: "compliant", evidence: "Independent full source review" };
  const handoffs = [];
  const publish = (attempt, rows, exit = 0) => {
    const prefix = `sealed/judge/0001/judge-${attempt}`, file = `${prefix}/out/comment-resolutions.json`, audit = `${prefix}-audit.json`;
    const h = { id: "R-0001-judge", role: "judge", step: "judge", round: 1, phase: "v1", attempt, view: "a".repeat(40), agent: { runner: "t3", session: `judge-${attempt}` }, product: null, audit: { violations: 0 }, record: "rounds/0001-judge.md", files: ["rounds/0001-judge.md", file, audit] };
    handoffs.push(h);
    put(h.record, "# judge\n"); put("metrics/handoffs.jsonl", handoffs.map(h => JSON.stringify(h)).join("\n") + "\n");
    put(file, JSON.stringify(rows)); put(audit, JSON.stringify({ id: h.id, role: h.role, attempt, exit, agent: h.agent })); commit();
    return { file, audit, h };
  };
  const first = publish(1, []);
  put(first.file, JSON.stringify([row])); commit();
  assert.equal(proseLines("a.sql", source, { resolutions: commentResolutions(records) })[0].status, "pending");
  const second = publish(2, [row], 1);
  put(second.audit, JSON.stringify({ id: second.h.id, role: "judge", attempt: 2, exit: 0, agent: second.h.agent })); commit();
  assert.equal(proseLines("a.sql", source, { resolutions: commentResolutions(records) })[0].status, "pending");
  const third = publish(3, [row]);
  assert.deepEqual(proseLines("a.sql", source, { resolutions: commentResolutions(records) }), []);
  put(third.file, "[]"); put(third.audit, "{}"); commit();
  assert.deepEqual(proseLines("a.sql", source, { resolutions: commentResolutions(records) }), []);
});

// F-0015, P-0014, P-0015, R-0055-judge-frame-hygiene
test("F-0015: commentResolutions runs zero ls-tree calls and short-circuits in 1 show when empty", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "comment-fast-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = join(root, "records"), binDir = join(root, "bin"), logFile = join(root, "git.log");
  mkdirSync(records); mkdirSync(binDir);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const git = (...args) => execFileSync(realGit, ["-C", records, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const put = (p, d) => { mkdirSync(dirname(join(records, p)), { recursive: true }); writeFileSync(join(records, p), d); };
  const commit = () => { git("add", "."); git("commit", "-qm", "fixture"); };
  const spy = join(binDir, "git");
  writeFileSync(spy, `#!/bin/sh\necho "$@" >> "${logFile}"\nexec "${realGit}" "$@"\n`);
  chmodSync(spy, 0o755);
  const prevPath = process.env.PATH;
  t.after(() => { process.env.PATH = prevPath; });
  const runSpied = fn => {
    writeFileSync(logFile, "");
    process.env.PATH = `${binDir}:${prevPath}`;
    try { return fn(); }
    finally { process.env.PATH = prevPath; }
  };
  const hNoRes = {
    id: "R-0001-judge", role: "judge", step: "judge", round: 1, phase: "v1", attempt: 1,
    view: "a".repeat(40), agent: { runner: "t3", session: "j-1" }, product: null,
    audit: { violations: 0 }, record: "rounds/0001-judge.md", files: ["rounds/0001-judge.md"],
  };
  put(hNoRes.record, "# judge\n");
  put("metrics/handoffs.jsonl", JSON.stringify(hNoRes) + "\n");
  commit();
  assert.deepEqual(runSpied(() => commentResolutions(records)), []);
  const emptyCalls = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(emptyCalls.length, 1, `expected single HEAD show call, got: ${emptyCalls.join(" | ")}`);
  assert.equal(emptyCalls.some(c => /\bls-tree\b/.test(c)), false);

  const src = "// @custom-directive 1\nexport {};\n", [cand] = proseLines("a.mjs", src);
  const row = { ...cand, verdict: "directive", evidence: "tool consumer" };
  const prefix = "sealed/judge/0002/judge-1", resPath = `${prefix}/out/comment-resolutions.json`, auditPath = `${prefix}-audit.json`;
  const hWithRes = {
    id: "R-0002-judge", role: "judge", step: "judge", round: 2, phase: "v1", attempt: 1,
    view: "b".repeat(40), agent: { runner: "t3", session: "j-2" }, product: null,
    audit: { violations: 0 }, record: "rounds/0002-judge.md", files: ["rounds/0002-judge.md", resPath, auditPath],
  };
  put(hWithRes.record, "# judge 2\n");
  put(resPath, JSON.stringify([row]));
  put(auditPath, JSON.stringify({ id: hWithRes.id, role: "judge", attempt: 1, exit: 0, agent: hWithRes.agent }));
  put("metrics/handoffs.jsonl", [hNoRes, hWithRes].map(x => JSON.stringify(x)).join("\n") + "\n");
  commit();
  const resolved = runSpied(() => commentResolutions(records));
  assert.equal(resolved.length, 1);
  const activeCalls = readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
  assert.equal(activeCalls.some(c => /\bls-tree\b/.test(c)), false, `unexpected ls-tree: ${activeCalls.join(" | ")}`);
  assert.ok(activeCalls.some(c => /--no-replace-objects cat-file --batch/.test(c)));
});

// F-0015, P-0014, P-0015
test("F-0015: proseInTree supports tree-keyed caching (pruned to 16, skips pending) and maxFiles/maxMs deferral", t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "prose-cache-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const product = join(root, "product");
  mkdirSync(product);
  const git = (...args) => execFileSync("git", ["-C", product, ...args], { encoding: "utf8" }).trim();
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.test");
  const commitFiles = files => {
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(dirname(join(product, rel)), { recursive: true });
      writeFileSync(join(product, rel), body);
    }
    git("add", "-A"); git("commit", "-qm", "c");
    return git("rev-parse", "HEAD");
  };
  const sha = commitFiles({ "src/a.mjs": "export const a = 1;\n", "src/b.mjs": "export const b = 2;\n" });
  assert.deepEqual(proseInTree(product, sha), []);
  assert.throws(() => proseInTree(product, sha, { maxFiles: 1 }), err => err instanceof ProseBudgetExceededError && err.code === "PROSE_BUDGET_EXCEEDED" && err.deferred === true);
  assert.throws(() => proseInTree(product, sha, { maxMs: 0 }), err => err instanceof ProseBudgetExceededError && err.code === "PROSE_BUDGET_EXCEEDED");
  const defFiles = proseInTree(product, sha, { maxFiles: 1, deferOnBudget: true });
  assert.equal(defFiles.deferred, true);
  assert.match(defFiles.reason, /exceed budget/);
  const defMs = proseInTree(product, sha, { maxMs: 0, deferOnBudget: true });
  assert.equal(defMs.deferred, true);

  assert.equal(proseCacheDir(root), null);
  const cacheDir = proseCacheDir(product);
  assert.ok(cacheDir);
  t.after(() => rmSync(dirname(cacheDir), { recursive: true, force: true }));
  const commonDir = realpathSync(git("rev-parse", "--path-format=absolute", "--git-common-dir"));
  assert.equal(cacheDir.startsWith(commonDir), false);

  const first = proseInTree(product, sha, { cache: true, deferOnBudget: true });
  assert.deepEqual(first, { lines: [], deferred: false, reason: null, cached: false });
  assert.equal(existsSync(join(commonDir, "self-loop-suite")), false);
  const hit = proseInTree(product, sha, { cache: true, maxFiles: 0, maxMs: 0, deferOnBudget: true });
  assert.deepEqual(hit, { lines: [], deferred: false, reason: null, cached: true });

  const beforePending = readdirSync(cacheDir).length;
  const pendingSha = commitFiles({ "src/p.mjs": "// Unresolved prose line\nexport const p = 1;\n" });
  assert.throws(() => proseInTree(product, pendingSha, { cache: true }), /pending independent/);
  assert.equal(readdirSync(cacheDir).length, beforePending);

  for (let i = 0; i < 18; i++) {
    const s = commitFiles({ "src/p.mjs": `export const p = ${i};\n` });
    assert.deepEqual(proseInTree(product, s, { cache: true }), []);
  }
  assert.ok(readdirSync(cacheDir).filter(n => n.startsWith("prose-") && n.endsWith(".json")).length <= 16);
  assert.equal(existsSync(join(commonDir, "self-loop-suite")), false);
});
