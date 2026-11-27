// D-0061, design/suite-once.md#1, design/suite-once.md#2
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { auditAccess } from "../audit-access.mjs";
import { lookupSuiteReceipt, purgeTreeReceipts, stageSuiteWorkspace, suiteGreen, suiteStore } from "../suite-green.mjs";
import { git, repo, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("suite-once-load-");

function countedRepo(passing = true) {
  const counterFile = join(temp("suite-once-counter-"), "runs.log");
  const assertion = passing ? "assert.equal(1, 1);" : "assert.equal(1, 2);";
  const dir = repo({
    "VERSION": "0.1.0\n",
    "t.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { appendFileSync } from "node:fs";',
      'import test from "node:test";',
      `test("counted", () => { appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); ${assertion} });`,
      "",
    ].join("\n"),
  });
  const count = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);
  return { dir, counterFile, count };
}

test("lookupSuiteReceipt resolves green receipts by exact tree, runtime, and intact log digest", () => {
  const { dir, count } = countedRepo(true);
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";

  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command: "echo smoke" }), null);

  const ran = suiteGreen({ repo: dir, sha, command, format: "node-test" });
  assert.equal(ran.green, true);
  assert.equal(count(), 1);

  const hit = lookupSuiteReceipt({ repo: dir, sha, command, install: "" });
  assert.ok(hit);
  assert.equal(hit.receipt.green, true);
  assert.equal(hit.receipt.tree, tree);
  assert.equal(hit.receipt.sha, sha);
  assert.equal(existsSync(hit.receiptPath), true);
  assert.equal(existsSync(hit.logPath), true);

  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command, runtime: { node: "v0.0.0-mismatch", platform: process.platform, arch: process.arch } }), null);

  const tampered = gzipSync("corrupted log\n");
  writeFileSync(hit.logPath, tampered);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);
});

test("purgeTreeReceipts removes only receipts for target tree and defeats pre-poisoning", () => {
  const { dir, count } = countedRepo(true);
  const baseSha = git(dir, "rev-parse", "HEAD");
  const baseTree = git(dir, "rev-parse", `${baseSha}^{tree}`);
  const command = "node --test t.test.mjs";

  assert.deepEqual(purgeTreeReceipts(dir, baseTree), { purged: 0 });

  const base = suiteGreen({ repo: dir, sha: baseSha, command, format: "node-test" });
  assert.equal(base.green, true);
  assert.equal(count(), 1);

  const nextCounter = join(temp("suite-once-next-"), "runs.log");
  writeFileSync(join(dir, "t.test.mjs"), [
    'import assert from "node:assert/strict";',
    'import { appendFileSync } from "node:fs";',
    'import test from "node:test";',
    `test("next", () => { appendFileSync(${JSON.stringify(nextCounter)}, "run\\n"); assert.equal(1, 1); });`,
    "",
  ].join("\n"));
  git(dir, "add", "t.test.mjs");
  git(dir, "commit", "-qm", "second tree");
  const targetSha = git(dir, "rev-parse", "HEAD");
  const targetTree = git(dir, "rev-parse", `${targetSha}^{tree}`);

  const baseHit = lookupSuiteReceipt({ repo: dir, sha: baseSha, command });
  const baseStored = JSON.parse(readFileSync(baseHit.receiptPath, "utf8"));
  const forgedKey = { ...baseStored.key, tree: targetTree };
  const keyHash = createHash("sha256").update(JSON.stringify([
    forgedKey.repository, forgedKey.tree, forgedKey.command, forgedKey.install ?? null, forgedKey.execution ?? null,
    [forgedKey.runtime?.node ?? null, forgedKey.runtime?.platform ?? null, forgedKey.runtime?.arch ?? null],
  ])).digest("hex");
  const forgedDir = join(suiteStore(dir), keyHash);
  mkdirSync(forgedDir, { recursive: true });
  const logText = "$ node --test t.test.mjs\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nexit 0\n";
  const forged = {
    ...baseStored,
    sha: targetSha,
    tree: targetTree,
    key: forgedKey,
    green: true,
    exit: 0,
    reasons: [],
    log: { sha256: createHash("sha256").update(logText).digest("hex"), bytes: Buffer.byteLength(logText) },
  };
  writeFileSync(join(forgedDir, "9999-forged.log.gz"), gzipSync(logText));
  writeFileSync(join(forgedDir, "9999-forged.json"), `${JSON.stringify(forged, null, 1)}\n`);

  assert.ok(lookupSuiteReceipt({ repo: dir, sha: targetSha, command }));
  assert.deepEqual(purgeTreeReceipts(dir, targetTree), { purged: 1 });
  assert.equal(lookupSuiteReceipt({ repo: dir, sha: targetSha, command }), null);
  assert.ok(lookupSuiteReceipt({ repo: dir, sha: baseSha, command }));
  assert.equal(existsSync(forgedDir), false);
});

test("stageSuiteWorkspace enforces lookup vs ensure, read-only 0444 staging, outPrefix, and red refusal", () => {
  const { dir, count } = countedRepo(true);
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";

  assert.throws(() => stageSuiteWorkspace({ repo: dir, sha, command, ws: temp("ws-bad-mode-"), mode: "invalid" }), /mode must be lookup or ensure/);

  const wsCold = temp("ws-cold-");
  assert.deepEqual(stageSuiteWorkspace({ repo: dir, sha, command, ws: wsCold, mode: "lookup" }), {
    ok: true, reused: false, receipt: null, stagedPath: null,
  });
  assert.equal(count(), 0);

  const wsEnsure = temp("ws-ensure-");
  const outPrefix = join(temp("ws-out-"), "evidence", "suite");
  const first = stageSuiteWorkspace({ repo: dir, sha, command, ws: wsEnsure, mode: "ensure", format: "node-test", outPrefix });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(first.receipt.tree, tree);
  assert.equal(statSync(first.stagedPath).mode & 0o222, 0);
  assert.equal(statSync(join(wsEnsure, "suite.log.gz")).mode & 0o222, 0);
  assert.equal(existsSync(`${outPrefix}.json`), true);
  assert.equal(existsSync(`${outPrefix}.log.gz`), true);
  assert.equal(count(), 1);

  const restaged = stageSuiteWorkspace({ repo: dir, sha, command, ws: wsEnsure, mode: "lookup" });
  assert.equal(restaged.ok, true);
  assert.equal(restaged.reused, true);
  assert.equal(count(), 1);

  const { dir: redDir, count: redCount } = countedRepo(false);
  const redSha = git(redDir, "rev-parse", "HEAD");
  const wsRed = temp("ws-red-");
  const red = stageSuiteWorkspace({ repo: redDir, sha: redSha, command, ws: wsRed, mode: "ensure" });
  assert.equal(red.ok, false);
  assert.equal(red.reused, false);
  assert.ok(Array.isArray(red.reasons) && red.reasons.length > 0);
  assert.equal(existsSync(join(wsRed, "suite-receipt.json")), false);
  assert.equal(redCount(), 1);
});

test("auditAccess flags exact stagedSuiteCommand on unchanged wt while allowing cd-outside mutations, writes, and targeted probes", () => {
  const ws = temp("audit-so-ws-");
  const wt = join(ws, "wt");
  const out = join(ws, "out");
  mkdirSync(wt, { recursive: true });
  mkdirSync(out, { recursive: true });
  const stagedSuiteCommand = "node --test scripts/test";

  const cdInWt = auditAccess([ws, wt], [
    { id: "judge", event: { type: "assistant", message: { content: [
      { type: "tool_use", id: "w1", name: "Write", input: { file_path: join(out, "report.md") } },
      { type: "tool_use", id: "b1", name: "Bash", input: { command: `cd ${wt} && node --test scripts/test` } },
    ] } } },
  ], { tools: null, forbidden: [], cwd: wt, stagedSuiteCommand });
  assert.equal(cdInWt.violations.length, 0);
  assert.equal(cdInWt.duplicateSuiteRuns.length, 1);
  assert.equal(cdInWt.flags.length, 1);

  const cdOutsideMut = auditAccess([ws, wt], [
    { id: "judge", event: { type: "assistant", message: { content: [
      { type: "tool_use", id: "b2", name: "Bash", input: { command: "cd /tmp/mut-copy && node --test scripts/test" } },
    ] } } },
  ], { tools: null, forbidden: [], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(cdOutsideMut.duplicateSuiteRuns, []);

  const afterEditInWt = auditAccess([ws, wt], [
    { id: "actor", event: { type: "assistant", message: { content: [
      { type: "tool_use", id: "e1", name: "Edit", input: { file_path: join(wt, "scripts/suite-green.mjs") } },
      { type: "tool_use", id: "b3", name: "Bash", input: { command: stagedSuiteCommand } },
    ] } } },
  ], { tools: null, forbidden: [], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(afterEditInWt.duplicateSuiteRuns, []);
  assert.equal(afterEditInWt.flags.length, 0);

  const refusedBash = auditAccess([ws, wt], [
    { id: "judge", event: { type: "assistant", message: { content: [
      { type: "tool_use", id: "b4", name: "Bash", input: { command: stagedSuiteCommand } },
    ] } } },
    { id: "judge", event: { type: "user", message: { content: [
      { type: "tool_result", tool_use_id: "b4", is_error: true, content: "denied" },
    ] } } },
  ], { tools: null, forbidden: [], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(refusedBash.duplicateSuiteRuns, []);
  assert.equal(refusedBash.flags.length, 0);

  const agAfterWrite = auditAccess([ws, wt], [
    { id: "actor", event: { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [
      { name: "edit_file", args: { Path: join(wt, "scripts/audit-access.mjs") } },
      { name: "run_command", args: { CommandLine: stagedSuiteCommand } },
    ] } },
    { id: "actor", event: { type: "GENERIC", status: "DONE" } },
    { id: "actor", event: { type: "GENERIC", status: "DONE" } },
    { id: "actor", event: { type: "PLANNER_RESPONSE", status: "DONE" } },
  ], { tools: null, forbidden: [], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(agAfterWrite.duplicateSuiteRuns, []);
  assert.equal(agAfterWrite.flags.length, 0);

  const codexAfterFileChange = auditAccess([ws, wt], [
    { id: "actor", event: { type: "item.completed", item: { type: "file_change", status: "completed", changes: [{ path: join(wt, "scripts/a.mjs") }] } } },
    { id: "actor", event: { type: "item.completed", item: { type: "command_execution", command: stagedSuiteCommand } } },
  ], { tools: null, forbidden: [], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(codexAfterFileChange.duplicateSuiteRuns, []);
  assert.equal(codexAfterFileChange.flags.length, 0);
});

function startStageEnsure(repoDir, sha, command, ws, nodeArgs = []) {
  const modUrl = pathToFileURL(join(process.cwd(), "scripts", "suite-green.mjs")).href;
  const code = [
    `import { stageSuiteWorkspace } from ${JSON.stringify(modUrl)};`,
    `const res = stageSuiteWorkspace({ repo: ${JSON.stringify(repoDir)}, sha: ${JSON.stringify(sha)}, command: ${JSON.stringify(command)}, ws: ${JSON.stringify(ws)}, mode: "ensure", format: "node-test" });`,
    "console.log(JSON.stringify({ ok: res.ok, reused: res.reused, tree: res.receipt?.tree ?? null, stagedPath: res.stagedPath }));",
  ].join("\n");
  const child = spawn(process.execPath, [...nodeArgs, "--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  const done = new Promise((resolvePromise, rejectPromise) => {
    child.on("error", rejectPromise);
    child.on("close", (status, signal) => resolvePromise({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

const spawnStageEnsure = (repoDir, sha, command, ws) => startStageEnsure(repoDir, sha, command, ws).done;

async function waitUntil(pred, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms`);
    await new Promise(r => setTimeout(r, 10));
  }
}

function scriptedRepo({ failRuns = [], delayMs = 0 } = {}) {
  const counterFile = join(temp("suite-once-scripted-"), "runs.log");
  const wait = delayMs > 0 ? `await new Promise(r => setTimeout(r, ${delayMs})); ` : "";
  const dir = repo({
    "VERSION": "0.1.0\n",
    "t.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import test from "node:test";',
      `const failRuns = new Set(${JSON.stringify(failRuns)});`,
      `test("scripted", async () => { appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); const n = readFileSync(${JSON.stringify(counterFile)}, "utf8").split("\\n").filter(Boolean).length; ${wait}assert.equal(failRuns.has(n), false); });`,
      "",
    ].join("\n"),
  });
  const count = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);
  return { dir, counterFile, count };
}

function genDirsForTree(storeDir, tree) {
  const root = join(storeDir, ".gen");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(n => n.startsWith(`${tree}-`)).map(n => join(root, n));
}

test("stageSuiteWorkspace serializes concurrent cold ensure calls per key and recovers from dead-PID, malformed, and red locks", async () => {
  const counterFile = join(temp("suite-once-sf-"), "runs.log");
  const dir = repo({
    "VERSION": "0.1.0\n",
    "t.test.mjs": [
      'import assert from "node:assert/strict";',
      'import { appendFileSync } from "node:fs";',
      'import test from "node:test";',
      `test("slow", async () => { await new Promise(r => setTimeout(r, 300)); appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); assert.equal(1, 1); });`,
      "",
    ].join("\n"),
  });
  const count = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";
  const wsA = temp("ws-sf-a-");
  const wsB = temp("ws-sf-b-");

  const [a, b] = await Promise.all([
    spawnStageEnsure(dir, sha, command, wsA),
    spawnStageEnsure(dir, sha, command, wsB),
  ]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const parsedA = JSON.parse(a.stdout.trim());
  const parsedB = JSON.parse(b.stdout.trim());
  assert.equal(parsedA.ok, true);
  assert.equal(parsedB.ok, true);
  assert.equal(parsedA.tree, tree);
  assert.equal(parsedB.tree, tree);
  assert.deepEqual([parsedA.reused, parsedB.reused].sort(), [false, true]);
  assert.equal(count(), 1);
  assert.equal(statSync(join(wsA, "suite-receipt.json")).mode & 0o222, 0);
  assert.equal(statSync(join(wsB, "suite-receipt.json")).mode & 0o222, 0);
  const storeDir = suiteStore(dir);
  assert.deepEqual(readdirSync(storeDir).filter(n => n.endsWith(".lock")), []);

  const baseHit = lookupSuiteReceipt({ repo: dir, sha, command });
  const baseKey = JSON.parse(readFileSync(baseHit.receiptPath, "utf8")).key;
  const hashFor = targetTree => createHash("sha256").update(JSON.stringify([
    baseKey.repository, targetTree, baseKey.command, baseKey.install ?? null, baseKey.execution ?? null,
    [baseKey.runtime?.node ?? null, baseKey.runtime?.platform ?? null, baseKey.runtime?.arch ?? null],
  ])).digest("hex");

  writeFileSync(join(dir, "code.mjs"), "export const step = 1;\n");
  git(dir, "add", "code.mjs");
  git(dir, "commit", "-qm", "dead pid lock tree");
  const deadSha = git(dir, "rev-parse", "HEAD");
  const deadTree = git(dir, "rev-parse", `${deadSha}^{tree}`);
  const deadLock = join(storeDir, `${hashFor(deadTree)}.lock`);
  const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  writeFileSync(deadLock, `${JSON.stringify({ pid: deadChild.pid, startedAt: "2026-01-01T00:00:00Z" })}\n`);
  const recDead = stageSuiteWorkspace({ repo: dir, sha: deadSha, command, ws: temp("ws-dead-"), mode: "ensure", format: "node-test" });
  assert.equal(recDead.ok, true);
  assert.equal(recDead.reused, false);
  assert.equal(existsSync(deadLock), false);
  assert.equal(count(), 2);

  writeFileSync(join(dir, "code.mjs"), "export const step = 2;\n");
  git(dir, "add", "code.mjs");
  git(dir, "commit", "-qm", "malformed lock tree");
  const corruptSha = git(dir, "rev-parse", "HEAD");
  const corruptTree = git(dir, "rev-parse", `${corruptSha}^{tree}`);
  const corruptLock = join(storeDir, `${hashFor(corruptTree)}.lock`);
  writeFileSync(corruptLock, "{corrupt");
  const recCorrupt = stageSuiteWorkspace({ repo: dir, sha: corruptSha, command, ws: temp("ws-corrupt-"), mode: "ensure", format: "node-test" });
  assert.equal(recCorrupt.ok, true);
  assert.equal(recCorrupt.reused, false);
  assert.equal(existsSync(corruptLock), false);
  assert.equal(count(), 3);

  const { dir: redDir } = countedRepo(false);
  const redSha = git(redDir, "rev-parse", "HEAD");
  const red1 = stageSuiteWorkspace({ repo: redDir, sha: redSha, command, ws: temp("ws-red1-"), mode: "ensure", format: "node-test" });
  assert.equal(red1.ok, false);
  assert.deepEqual(readdirSync(suiteStore(redDir)).filter(n => n.endsWith(".lock")), []);
  const red2 = stageSuiteWorkspace({ repo: redDir, sha: redSha, command, ws: temp("ws-red2-"), mode: "ensure", format: "node-test" });
  assert.equal(red2.ok, false);
});

test("stageSuiteWorkspace uses monotonic generation chain for concurrent red handoff, sequential retry, purgeTreeReceipts .gen cleanup, and EACCES/EPERM fail-closed", async () => {
  const { dir, count } = scriptedRepo({ failRuns: [1], delayMs: 350 });
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";
  const wsA = temp("ws-red-sf-a-");
  const wsB = temp("ws-red-sf-b-");
  const wsC = temp("ws-red-sf-c-");

  const pA = spawnStageEnsure(dir, sha, command, wsA);
  const pB = spawnStageEnsure(dir, sha, command, wsB);
  await new Promise(r => setTimeout(r, 180));
  const pC = spawnStageEnsure(dir, sha, command, wsC);
  const [a, b, c] = await Promise.all([pA, pB, pC]);
  for (const r of [a, b, c]) assert.equal(r.status, 0, r.stderr);
  const parsed = [a, b, c].map(r => JSON.parse(r.stdout.trim()));
  for (const p of parsed) {
    assert.equal(p.ok, false);
    assert.equal(p.tree, tree);
  }
  assert.deepEqual(parsed.map(p => p.reused).sort(), [false, true, true]);
  assert.equal(count(), 1);
  for (const ws of [wsA, wsB, wsC]) assert.equal(existsSync(join(ws, "suite-receipt.json")), false);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);
  const storeDir = suiteStore(dir);
  assert.deepEqual(readdirSync(storeDir).filter(n => n.endsWith(".lock")), []);
  const [genDir] = genDirsForTree(storeDir, tree);
  assert.ok(genDir);
  assert.equal(existsSync(join(genDir, "g1.claim")), true);
  assert.equal(JSON.parse(readFileSync(join(genDir, "g1.done.json"), "utf8")).green, false);

  const retryWs = temp("ws-red-retry-");
  const retry = stageSuiteWorkspace({ repo: dir, sha, command, ws: retryWs, mode: "ensure", format: "node-test" });
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, false);
  assert.equal(count(), 2);
  assert.ok(lookupSuiteReceipt({ repo: dir, sha, command }));
  assert.equal(existsSync(join(genDir, "g1.claim")), true);
  assert.equal(existsSync(join(genDir, "g2.claim")), true);
  assert.equal(JSON.parse(readFileSync(join(genDir, "g2.done.json"), "utf8")).green, true);
  assert.equal(statSync(join(retryWs, "suite-receipt.json")).mode & 0o222, 0);

  writeFileSync(join(dir, "other.mjs"), "export const other = 1;\n");
  git(dir, "add", "other.mjs");
  git(dir, "commit", "-qm", "other tree");
  const otherSha = git(dir, "rev-parse", "HEAD");
  const otherTree = git(dir, "rev-parse", `${otherSha}^{tree}`);
  const otherRes = stageSuiteWorkspace({ repo: dir, sha: otherSha, command, ws: temp("ws-other-"), mode: "ensure", format: "node-test" });
  assert.equal(otherRes.ok, true);
  assert.equal(genDirsForTree(storeDir, otherTree).length, 1);

  assert.deepEqual(purgeTreeReceipts(dir, tree), { purged: 1 });
  assert.deepEqual(genDirsForTree(storeDir, tree), []);
  assert.equal(genDirsForTree(storeDir, otherTree).length, 1);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);
  assert.ok(lookupSuiteReceipt({ repo: dir, sha: otherSha, command }));

  const { dir: roDir, count: roCount } = countedRepo(true);
  const roSha = git(roDir, "rev-parse", "HEAD");
  const roStore = suiteStore(roDir);
  mkdirSync(roStore, { recursive: true });
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    chmodSync(roStore, 0o555);
    try {
      assert.throws(() => stageSuiteWorkspace({ repo: roDir, sha: roSha, command, ws: temp("ws-ro-"), mode: "ensure", format: "node-test" }), /EACCES|EPERM/);
      assert.equal(roCount(), 0);
    } finally {
      chmodSync(roStore, 0o755);
    }
  }
});

test("monotonic generation chain recovers from SIGKILL across concurrent waiters without duplicate recovery runs and keeps red-then-green verdicts exact", async () => {
  const { dir, count } = scriptedRepo({ failRuns: [2], delayMs: 400 });
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";
  const storeDir = suiteStore(dir);

  const g1 = startStageEnsure(dir, sha, command, temp("ws-kill-g1-"));
  await waitUntil(() => count() >= 1);
  g1.child.kill("SIGKILL");
  const g1Res = await g1.done;
  assert.equal(g1Res.signal, "SIGKILL");
  const [genDir] = genDirsForTree(storeDir, tree);
  assert.ok(genDir);
  assert.equal(existsSync(join(genDir, "g1.claim")), true);
  assert.equal(existsSync(join(genDir, "g1.done.json")), false);

  const wsR1 = temp("ws-kill-r1-");
  const wsR2 = temp("ws-kill-r2-");
  const [r1, r2] = await Promise.all([
    spawnStageEnsure(dir, sha, command, wsR1),
    spawnStageEnsure(dir, sha, command, wsR2),
  ]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const p1 = JSON.parse(r1.stdout.trim());
  const p2 = JSON.parse(r2.stdout.trim());
  assert.deepEqual([p1.ok, p2.ok], [false, false]);
  assert.deepEqual([p1.reused, p2.reused].sort(), [false, true]);
  assert.equal(count(), 2);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);
  assert.equal(existsSync(join(wsR1, "suite-receipt.json")), false);
  assert.equal(existsSync(join(wsR2, "suite-receipt.json")), false);
  assert.equal(existsSync(join(genDir, "g1.claim")), true);
  assert.equal(existsSync(join(genDir, "g2.claim")), true);
  assert.equal(JSON.parse(readFileSync(join(genDir, "g2.done.json"), "utf8")).green, false);
  assert.deepEqual(readdirSync(storeDir).filter(n => n.includes(".lock")), []);

  const retryWs = temp("ws-kill-retry-");
  const retry = stageSuiteWorkspace({ repo: dir, sha, command, ws: retryWs, mode: "ensure", format: "node-test" });
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, false);
  assert.equal(count(), 3);
  assert.equal(existsSync(join(genDir, "g3.claim")), true);
  assert.equal(JSON.parse(readFileSync(join(genDir, "g3.done.json"), "utf8")).green, true);
  assert.equal(statSync(join(retryWs, "suite-receipt.json")).mode & 0o222, 0);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command })?.receipt?.tree, tree);
});

test("already-enrolled waiters recover atomically when live g1 leader is SIGKILLed mid-flight", async () => {
  const { dir, count } = scriptedRepo({ failRuns: [2], delayMs: 450 });
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";
  const storeDir = suiteStore(dir);

  const g1 = startStageEnsure(dir, sha, command, temp("ws-enr-g1-"));
  await waitUntil(() => count() >= 1);
  const wA = spawnStageEnsure(dir, sha, command, temp("ws-enr-a-"));
  const wB = spawnStageEnsure(dir, sha, command, temp("ws-enr-b-"));
  await new Promise(r => setTimeout(r, 120));
  g1.child.kill("SIGKILL");
  await g1.done;

  const [resA, resB] = await Promise.all([wA, wB]);
  assert.equal(resA.status, 0, resA.stderr);
  assert.equal(resB.status, 0, resB.stderr);
  const pA = JSON.parse(resA.stdout.trim());
  const pB = JSON.parse(resB.stdout.trim());
  assert.deepEqual([pA.ok, pB.ok], [false, false]);
  assert.deepEqual([pA.reused, pB.reused].sort(), [false, true]);
  assert.equal(count(), 2);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);
  const [genDir] = genDirsForTree(storeDir, tree);
  assert.equal(existsSync(join(genDir, "g1.claim")), true);
  assert.equal(existsSync(join(genDir, "g2.claim")), true);
  assert.equal(JSON.parse(readFileSync(join(genDir, "g2.done.json"), "utf8")).green, false);
});

function makeLinkPausePreload(recordFile) {
  const dir = temp("suite-once-preload-");
  const file = join(dir, "pause-link.mjs");
  writeFileSync(file, [
    'import fs from "node:fs";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const targetRe = /[/\\\\]g1\\.claim$/;',
    "const origOpen = fs.openSync;",
    "const origLink = fs.linkSync;",
    "let stopped = false;",
    "fs.openSync = function (path, flags, ...rest) {",
    '  const isExcl = (typeof flags === "string" && flags.includes("x")) || (typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0);',
    `  if (typeof path === "string" && targetRe.test(path) && isExcl) fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ openExcl: true }));`,
    "  return origOpen.call(this, path, flags, ...rest);",
    "};",
    "fs.linkSync = function (existingPath, newPath) {",
    "  const res = origLink.call(this, existingPath, newPath);",
    '  if (!stopped && typeof newPath === "string" && targetRe.test(newPath)) {',
    "    stopped = true;",
    '    const raw = fs.readFileSync(newPath, "utf8");',
    `    fs.writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ openExcl: false, bytes: Buffer.byteLength(raw), payload: JSON.parse(raw) }));`,
    '    process.kill(process.pid, "SIGSTOP");',
    "  }",
    "  return res;",
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  return pathToFileURL(file).href;
}

test("atomic linkSync claim never exposes a 0-byte claim file and survives a >600ms SIGSTOP pause without duplicate execution", async t => {
  const { dir, count } = scriptedRepo({ failRuns: [1], delayMs: 250 });
  const sha = git(dir, "rev-parse", "HEAD");
  const tree = git(dir, "rev-parse", `${sha}^{tree}`);
  const command = "node --test t.test.mjs";
  const storeDir = suiteStore(dir);
  const recordFile = join(temp("suite-once-rec-"), "claim-obs.json");
  const preloadUrl = makeLinkPausePreload(recordFile);

  const ws1 = temp("ws-stop-1-");
  const ws2 = temp("ws-stop-2-");
  const c1 = startStageEnsure(dir, sha, command, ws1, ["--import", preloadUrl]);
  t.after(() => { try { c1.child.kill("SIGCONT"); } catch {} });

  await waitUntil(() => {
    if (c1.child.exitCode !== null) throw new Error(`caller1 exited early with ${c1.child.exitCode}`);
    if (!existsSync(recordFile)) return false;
    const st = spawnSync("ps", ["-o", "state=", "-p", String(c1.child.pid)], { encoding: "utf8" });
    return st.status === 0 && /^T/.test(st.stdout.trim());
  });

  const obs = JSON.parse(readFileSync(recordFile, "utf8"));
  assert.equal(obs.openExcl, false);
  assert.ok(obs.bytes > 0);
  assert.equal(obs.payload.pid, c1.child.pid);
  assert.equal(obs.payload.gen, 1);
  assert.equal(typeof obs.payload.token, "string");
  const [genDir] = genDirsForTree(storeDir, tree);
  assert.ok(genDir);
  assert.ok(statSync(join(genDir, "g1.claim")).size > 0);
  assert.equal(count(), 0);

  const c2 = startStageEnsure(dir, sha, command, ws2);
  await new Promise(r => setTimeout(r, 700));
  assert.equal(existsSync(join(genDir, "g2.claim")), false);
  assert.equal(count(), 0);

  c1.child.kill("SIGCONT");
  const [r1, r2] = await Promise.all([c1.done, c2.done]);
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r2.status, 0, r2.stderr);
  const p1 = JSON.parse(r1.stdout.trim());
  const p2 = JSON.parse(r2.stdout.trim());
  assert.deepEqual([p1.ok, p2.ok], [false, false]);
  assert.deepEqual([p1.reused, p2.reused].sort(), [false, true]);
  assert.equal(count(), 1);
  assert.equal(existsSync(join(genDir, "g2.claim")), false);
  assert.deepEqual(readdirSync(genDir).filter(n => n.startsWith(".claim-")), []);
  assert.equal(existsSync(join(ws1, "suite-receipt.json")), false);
  assert.equal(existsSync(join(ws2, "suite-receipt.json")), false);
  assert.equal(lookupSuiteReceipt({ repo: dir, sha, command }), null);

  const retryWs = temp("ws-stop-retry-");
  const retry = stageSuiteWorkspace({ repo: dir, sha, command, ws: retryWs, mode: "ensure", format: "node-test" });
  assert.equal(retry.ok, true);
  assert.equal(retry.reused, false);
  assert.equal(count(), 2);
  assert.equal(statSync(join(retryWs, "suite-receipt.json")).mode & 0o222, 0);
  assert.equal(existsSync(join(genDir, "g2.claim")), true);
  assert.equal(JSON.parse(readFileSync(join(genDir, "g2.done.json"), "utf8")).green, true);
});

test("generation fencing refuses execution and publication when superseded, and corrupt claims fail closed", async t => {
  const { dir: execDir, count: execCount } = scriptedRepo({ failRuns: [], delayMs: 50 });
  const execSha = git(execDir, "rev-parse", "HEAD");
  const execTree = git(execDir, "rev-parse", `${execSha}^{tree}`);
  const command = "node --test t.test.mjs";
  const execStore = suiteStore(execDir);
  const execRec = join(temp("suite-once-fexec-"), "obs.json");
  const wsExec = temp("ws-fexec-");
  const cExec = startStageEnsure(execDir, execSha, command, wsExec, ["--import", makeLinkPausePreload(execRec)]);
  t.after(() => { try { cExec.child.kill("SIGCONT"); } catch {} });

  await waitUntil(() => {
    if (cExec.child.exitCode !== null) throw new Error(`cExec exited early with ${cExec.child.exitCode}`);
    if (!existsSync(execRec)) return false;
    const st = spawnSync("ps", ["-o", "state=", "-p", String(cExec.child.pid)], { encoding: "utf8" });
    return st.status === 0 && /^T/.test(st.stdout.trim());
  });
  const [execGenDir] = genDirsForTree(execStore, execTree);
  writeFileSync(join(execGenDir, "g2.claim"), `${JSON.stringify({ pid: process.pid, gen: 2, token: "fence-exec", startedAt: new Date().toISOString() })}\n`);
  cExec.child.kill("SIGCONT");
  const execRes = await cExec.done;
  assert.notEqual(execRes.status, 0);
  assert.match(execRes.stderr, /fenced before execution/);
  assert.equal(execCount(), 0);
  assert.equal(existsSync(join(execGenDir, "g1.done.json")), false);
  assert.equal(existsSync(join(wsExec, "suite-receipt.json")), false);
  assert.equal(lookupSuiteReceipt({ repo: execDir, sha: execSha, command }), null);

  const { dir: pubDir, count: pubCount } = scriptedRepo({ failRuns: [], delayMs: 400 });
  const pubSha = git(pubDir, "rev-parse", "HEAD");
  const pubTree = git(pubDir, "rev-parse", `${pubSha}^{tree}`);
  const pubStore = suiteStore(pubDir);
  const wsPub = temp("ws-fpub-");
  const cPub = startStageEnsure(pubDir, pubSha, command, wsPub);
  await waitUntil(() => pubCount() >= 1);
  const [pubGenDir] = genDirsForTree(pubStore, pubTree);
  assert.ok(pubGenDir);
  writeFileSync(join(pubGenDir, "g2.claim"), `${JSON.stringify({ pid: process.pid, gen: 2, token: "fence-pub", startedAt: new Date().toISOString() })}\n`);
  const pubRes = await cPub.done;
  assert.notEqual(pubRes.status, 0);
  assert.match(pubRes.stderr, /fenced before publication/);
  assert.equal(existsSync(join(pubGenDir, "g1.done.json")), false);
  assert.equal(existsSync(join(wsPub, "suite-receipt.json")), false);
  assert.equal(lookupSuiteReceipt({ repo: pubDir, sha: pubSha, command }), null);

  const { dir: badDir, count: badCount } = countedRepo(true);
  const badSha = git(badDir, "rev-parse", "HEAD");
  const badTree = git(badDir, "rev-parse", `${badSha}^{tree}`);
  const warmBad = stageSuiteWorkspace({ repo: badDir, sha: badSha, command, ws: temp("ws-bad-warm-"), mode: "ensure", format: "node-test" });
  assert.equal(warmBad.ok, true);
  const [badGenDir] = genDirsForTree(suiteStore(badDir), badTree);
  purgeTreeReceipts(badDir, badTree);
  mkdirSync(badGenDir, { recursive: true });
  writeFileSync(join(badGenDir, "g1.claim"), "");
  assert.throws(() => stageSuiteWorkspace({ repo: badDir, sha: badSha, command, ws: temp("ws-bad-corrupt-"), mode: "ensure", format: "node-test" }), /invalid suite claim/);
  assert.equal(badCount(), 1);
});

test("D-0064 T6: VERSION-only commits hit codeTree reuse while real code changes trigger a fresh suite run", () => {
  const { dir, count } = countedRepo(true);
  const baseSha = git(dir, "rev-parse", "HEAD");
  const command = "node --test t.test.mjs";

  const first = stageSuiteWorkspace({ repo: dir, sha: baseSha, command, ws: temp("ws-ct-base-"), mode: "ensure", format: "node-test" });
  assert.equal(first.ok, true);
  assert.equal(first.reused, false);
  assert.equal(count(), 1);

  writeFileSync(join(dir, "VERSION"), "0.1.1\n");
  git(dir, "add", "VERSION");
  git(dir, "commit", "-qm", "bump VERSION only");
  const verSha = git(dir, "rev-parse", "HEAD");
  const verTree = git(dir, "rev-parse", `${verSha}^{tree}`);

  const hit = lookupSuiteReceipt({ repo: dir, sha: verSha, command });
  assert.ok(hit);
  assert.equal(hit.receipt.sha, verSha);
  assert.equal(hit.receipt.tree, verTree);
  assert.equal(hit.receipt.versionVaried, "0.1.1");

  const reused = stageSuiteWorkspace({ repo: dir, sha: verSha, command, ws: temp("ws-ct-ver-"), mode: "ensure", format: "node-test" });
  assert.equal(reused.ok, true);
  assert.equal(reused.reused, true);
  assert.equal(reused.receipt.tree, verTree);
  assert.equal(count(), 1);

  writeFileSync(join(dir, "feature.mjs"), "export const feature = 1;\n");
  git(dir, "add", "feature.mjs");
  git(dir, "commit", "-qm", "real code change");
  const codeSha = git(dir, "rev-parse", "HEAD");
  assert.equal(lookupSuiteReceipt({ repo: dir, sha: codeSha, command }), null);
  const fresh = stageSuiteWorkspace({ repo: dir, sha: codeSha, command, ws: temp("ws-ct-code-"), mode: "ensure", format: "node-test" });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.reused, false);
  assert.equal(count(), 2);
});
