// D-0061, design/suite-once.md#1
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { auditAccess } from "../scripts/audit-access.mjs";
import * as suiteGreenMod from "../scripts/suite-green.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

function withIsolatedLoadDir(t) {
  const prev = process.env.SELF_LOOP_LOAD_DIR;
  const dir = makeTempDir(t, "suite-once-load-");
  process.env.SELF_LOOP_LOAD_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.SELF_LOOP_LOAD_DIR;
    else process.env.SELF_LOOP_LOAD_DIR = prev;
  });
  return dir;
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, "--no-replace-objects", ...args], { encoding: "utf8", env: GIT_ENV }).trim();
}

function putFiles(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function initRepo(t, files, prefix = "suite-once-repo-") {
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

function readCounter(counterFile) {
  if (!existsSync(counterFile)) return 0;
  return readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length;
}

function countedTestSource(counterFile, passing = true) {
  const assertion = passing ? "assert.equal(1, 1);" : "assert.equal(1, 2);";
  return [
    'import assert from "node:assert/strict";',
    'import { appendFileSync } from "node:fs";',
    'import test from "node:test";',
    `test("counted", () => { appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); ${assertion} });`,
    "",
  ].join("\n");
}

function storedReceiptPaths(storeDir) {
  if (!existsSync(storeDir)) return [];
  const found = [];
  for (const sub of readdirSync(storeDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subDir = join(storeDir, sub.name);
    for (const entry of readdirSync(subDir)) {
      if (entry.endsWith(".json")) found.push(join(subDir, entry));
    }
  }
  return found;
}

test("SO-01 (D-0061): lookupSuiteReceipt and stageSuiteWorkspace enforce once-per-tree lookup vs ensure and fail closed on red/replaced trees; loss: stuck/false-verdict", t => {
  withIsolatedLoadDir(t);
  assert.equal(typeof suiteGreenMod.lookupSuiteReceipt, "function", "scripts/suite-green.mjs must export lookupSuiteReceipt");
  assert.equal(typeof suiteGreenMod.stageSuiteWorkspace, "function", "scripts/suite-green.mjs must export stageSuiteWorkspace");

  const { lookupSuiteReceipt, stageSuiteWorkspace } = suiteGreenMod;
  const command = "node --test suite.test.mjs";
  const counterFile = join(makeTempDir(t, "so01-count-"), "runs.log");
  const repo = initRepo(t, {
    "VERSION": "0.1.0\n",
    "suite.test.mjs": countedTestSource(counterFile, true),
  }, "so01-repo-");
  const c1 = git(repo, "rev-parse", "HEAD");
  const tree1 = git(repo, "rev-parse", `${c1}^{tree}`);

  assert.equal(lookupSuiteReceipt({ repo, sha: c1, command }), null);

  const wsLookupCold = makeTempDir(t, "so01-ws-lookup-cold-");
  const coldLookup = stageSuiteWorkspace({ repo, sha: c1, command, ws: wsLookupCold, mode: "lookup" });
  assert.deepEqual(coldLookup, { ok: true, reused: false, receipt: null, stagedPath: null });
  assert.equal(existsSync(join(wsLookupCold, "suite-receipt.json")), false);
  assert.equal(readCounter(counterFile), 0);

  const wsEnsure1 = makeTempDir(t, "so01-ws-ensure-1-");
  const ensured = stageSuiteWorkspace({ repo, sha: c1, command, ws: wsEnsure1, mode: "ensure" });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.reused, false);
  assert.equal(ensured.receipt?.green, true);
  assert.equal(ensured.receipt?.tree, tree1);
  assert.equal(ensured.stagedPath, join(wsEnsure1, "suite-receipt.json"));
  assert.equal(existsSync(ensured.stagedPath), true);
  assert.equal(statSync(ensured.stagedPath).mode & 0o222, 0, "staged suite-receipt.json must be read-only");
  const stagedJson = JSON.parse(readFileSync(ensured.stagedPath, "utf8"));
  assert.equal(stagedJson.tree, tree1);
  assert.equal(stagedJson.green, true);
  assert.equal(readCounter(counterFile), 1);

  const found = lookupSuiteReceipt({ repo, sha: c1, command });
  assert.ok(found && found.receipt?.green === true && found.receipt?.tree === tree1);
  assert.equal(existsSync(found.receiptPath), true);
  assert.equal(existsSync(found.logPath), true);

  const wsEnsure2 = makeTempDir(t, "so01-ws-ensure-2-");
  const ensuredAgain = stageSuiteWorkspace({ repo, sha: c1, command, ws: wsEnsure2, mode: "ensure" });
  assert.equal(ensuredAgain.ok, true);
  assert.equal(ensuredAgain.reused, true);
  assert.equal(ensuredAgain.receipt?.tree, tree1);
  assert.equal(existsSync(ensuredAgain.stagedPath), true);

  const wsLookupWarm = makeTempDir(t, "so01-ws-lookup-warm-");
  const warmLookup = stageSuiteWorkspace({ repo, sha: c1, command, ws: wsLookupWarm, mode: "lookup" });
  assert.equal(warmLookup.ok, true);
  assert.equal(warmLookup.reused, true);
  assert.equal(warmLookup.receipt?.tree, tree1);
  assert.equal(statSync(warmLookup.stagedPath).mode & 0o222, 0);

  const c1Twin = git(repo, "commit-tree", tree1, "-p", c1, "-m", "twin same tree");
  const wsTwin = makeTempDir(t, "so01-ws-twin-");
  const twinEnsure = stageSuiteWorkspace({ repo, sha: c1Twin, command, ws: wsTwin, mode: "ensure" });
  assert.equal(twinEnsure.ok, true);
  assert.equal(twinEnsure.reused, true);
  assert.equal(twinEnsure.receipt?.tree, tree1);
  assert.equal(readCounter(counterFile), 1, "same tree across lookup/ensure/twin must execute suite exactly once");

  const cBad = commitFiles(repo, { "suite.test.mjs": countedTestSource(counterFile, false) }, "red suite");
  const wsBad = makeTempDir(t, "so01-ws-bad-");
  const badRes = stageSuiteWorkspace({ repo, sha: cBad, command, ws: wsBad, mode: "ensure" });
  assert.equal(badRes.ok, false);
  assert.equal(badRes.reused, false);
  assert.equal(existsSync(join(wsBad, "suite-receipt.json")), false);
  assert.equal(lookupSuiteReceipt({ repo, sha: cBad, command }), null);
  assert.equal(readCounter(counterFile), 2);

  git(repo, "replace", cBad, c1);
  assert.equal(lookupSuiteReceipt({ repo, sha: cBad, command }), null, "git replace must not spoof lookupSuiteReceipt");
  const wsReplaced = makeTempDir(t, "so01-ws-replaced-");
  const replacedRes = stageSuiteWorkspace({ repo, sha: cBad, command, ws: wsReplaced, mode: "ensure" });
  assert.equal(replacedRes.ok, false, "git replace must not turn a red tree green");
  assert.equal(existsSync(join(wsReplaced, "suite-receipt.json")), false);
});

test("SO-02 (D-0061): purgeTreeReceipts defeats child cache pre-poisoning without deleting receipts for unrelated trees; loss: false-verdict", t => {
  withIsolatedLoadDir(t);
  assert.equal(typeof suiteGreenMod.purgeTreeReceipts, "function", "scripts/suite-green.mjs must export purgeTreeReceipts");
  assert.equal(typeof suiteGreenMod.lookupSuiteReceipt, "function", "scripts/suite-green.mjs must export lookupSuiteReceipt");
  assert.equal(typeof suiteGreenMod.stageSuiteWorkspace, "function", "scripts/suite-green.mjs must export stageSuiteWorkspace");

  const { lookupSuiteReceipt, purgeTreeReceipts, stageSuiteWorkspace, suiteGreen, suiteStore } = suiteGreenMod;
  const command = "node --test suite.test.mjs";
  const otherCounter = join(makeTempDir(t, "so02-other-count-"), "other.log");
  const targetCounter = join(makeTempDir(t, "so02-target-count-"), "target.log");

  const repo = initRepo(t, {
    "VERSION": "0.1.0\n",
    "suite.test.mjs": countedTestSource(otherCounter, true),
  }, "so02-repo-");
  const otherSha = git(repo, "rev-parse", "HEAD");
  const otherTree = git(repo, "rev-parse", `${otherSha}^{tree}`);

  const baseline = suiteGreen({ repo, sha: otherSha, command, format: "node-test" });
  assert.equal(baseline.green, true);
  assert.equal(readCounter(otherCounter), 1);

  const storeDir = suiteStore(repo);
  const [templatePath] = storedReceiptPaths(storeDir);
  assert.ok(templatePath, "suiteGreen must store a baseline receipt");
  const templateRun = JSON.parse(readFileSync(templatePath, "utf8"));

  const childWt = join(makeTempDir(t, "so02-child-"), "wt");
  git(repo, "worktree", "add", "-q", "--detach", childWt, otherSha);
  const targetSha = commitFiles(childWt, { "suite.test.mjs": countedTestSource(targetCounter, true) }, "child candidate");
  const targetTree = git(repo, "rev-parse", `${targetSha}^{tree}`);
  assert.notEqual(targetTree, otherTree);
  assert.equal(readCounter(targetCounter), 0);

  const childStoreDir = suiteStore(childWt);
  assert.equal(childStoreDir, storeDir);
  const forgedKey = { ...templateRun.key, tree: targetTree };
  const keyText = JSON.stringify([
    forgedKey.repository,
    forgedKey.tree,
    forgedKey.command,
    forgedKey.install ?? null,
    forgedKey.execution ?? null,
    [forgedKey.runtime?.node ?? null, forgedKey.runtime?.platform ?? null, forgedKey.runtime?.arch ?? null],
  ]);
  const forgedDir = join(childStoreDir, createHash("sha256").update(keyText).digest("hex"));
  mkdirSync(forgedDir, { recursive: true });
  const forgedLogText = "$ node --test suite.test.mjs\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nexit 0\n";
  const forgedLogSha = createHash("sha256").update(forgedLogText).digest("hex");
  const forgedReceipt = {
    ...templateRun,
    sha: targetSha,
    tree: targetTree,
    key: forgedKey,
    green: true,
    exit: 0,
    reasons: [],
    summary: { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    log: { sha256: forgedLogSha, bytes: Buffer.byteLength(forgedLogText) },
  };
  writeFileSync(join(forgedDir, "9999999999999-forged.log.gz"), gzipSync(forgedLogText));
  writeFileSync(join(forgedDir, "9999999999999-forged.json"), `${JSON.stringify(forgedReceipt, null, 1)}\n`);

  const poisoned = lookupSuiteReceipt({ repo, sha: targetSha, command });
  assert.ok(poisoned && poisoned.receipt?.tree === targetTree, "pre-poisoned receipt should resolve before purgeTreeReceipts");

  purgeTreeReceipts(repo, targetTree);

  assert.equal(lookupSuiteReceipt({ repo, sha: targetSha, command }), null, "purgeTreeReceipts must invalidate pre-poisoned receipt");
  const wsTarget = makeTempDir(t, "so02-ws-target-");
  const ensured = stageSuiteWorkspace({ repo, sha: targetSha, command, ws: wsTarget, mode: "ensure" });
  assert.equal(ensured.ok, true);
  assert.equal(ensured.reused, false, "defeated forged receipt must force host suite execution");
  assert.equal(readCounter(targetCounter), 1, "host suite must actually execute once");

  const unrelated = lookupSuiteReceipt({ repo, sha: otherSha, command });
  assert.ok(unrelated && unrelated.receipt?.tree === otherTree, "unrelated receipts for other trees must remain intact");
});

test("SO-03 (D-0061): auditAccess screens duplicateSuiteRuns as Rung-3 flags without flagging targeted probes or mutations; loss: stuck/false-verdict", t => {
  const root = makeTempDir(t, "so03-");
  const ws = join(root, "ws");
  const wt = join(ws, "wt");
  const records = join(root, "records");
  mkdirSync(wt, { recursive: true });
  mkdirSync(records, { recursive: true });
  const stagedSuiteCommand = "node --test scripts/test";

  const claudeDup = auditAccess([ws, wt], [
    { id: "judge", event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: stagedSuiteCommand } }] } } },
  ], { tools: null, forbidden: [records], cwd: wt, stagedSuiteCommand });
  assert.equal(claudeDup.violations.length, 0);
  assert.ok(Array.isArray(claudeDup.duplicateSuiteRuns) && claudeDup.duplicateSuiteRuns.length >= 1, "Claude duplicate suite run must populate duplicateSuiteRuns");
  assert.ok(claudeDup.flags.length >= 1, "Claude duplicate suite run must increment flags");

  const codexDup = auditAccess([ws, wt], [
    { id: "judge", event: { type: "item.completed", item: { type: "command_execution", command: stagedSuiteCommand } } },
  ], { tools: null, forbidden: [records], cwd: wt, stagedSuiteCommand });
  assert.equal(codexDup.violations.length, 0);
  assert.ok(Array.isArray(codexDup.duplicateSuiteRuns) && codexDup.duplicateSuiteRuns.length >= 1, "Codex duplicate suite run must populate duplicateSuiteRuns");
  assert.ok(codexDup.flags.length >= 1, "Codex duplicate suite run must increment flags");

  const agDup = auditAccess([ws, wt], [
    { id: "judge", event: { type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "run_command", args: { CommandLine: stagedSuiteCommand } }] } },
    { id: "judge", event: { type: "GENERIC", status: "DONE" } },
    { id: "judge", event: { type: "PLANNER_RESPONSE", status: "DONE" } },
  ], { tools: null, forbidden: [records], cwd: wt, stagedSuiteCommand });
  assert.equal(agDup.violations.length, 0);
  assert.ok(Array.isArray(agDup.duplicateSuiteRuns) && agDup.duplicateSuiteRuns.length >= 1, "Antigravity duplicate suite run must populate duplicateSuiteRuns");
  assert.ok(agDup.flags.length >= 1, "Antigravity duplicate suite run must increment flags");

  const targetedProbe = auditAccess([ws, wt], [
    { id: "critic", event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "node --test acceptance/suite-once.test.mjs" } }] } } },
  ], { tools: null, forbidden: [records], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(targetedProbe.duplicateSuiteRuns, []);
  assert.equal(targetedProbe.flags.length, 0);

  const mutationProbe = auditAccess([ws, wt], [
    { id: "judge", event: { type: "item.completed", item: { type: "command_execution", command: "node --test scripts/test/suite-green.test.mjs" } } },
  ], { tools: null, forbidden: [records], cwd: wt, stagedSuiteCommand });
  assert.deepEqual(mutationProbe.duplicateSuiteRuns, []);
  assert.equal(mutationProbe.flags.length, 0);

  const withoutOption = auditAccess([ws, wt], [
    { id: "judge", event: { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "Bash", input: { command: stagedSuiteCommand } }] } } },
  ], { tools: null, forbidden: [records], cwd: wt });
  assert.equal((withoutOption.duplicateSuiteRuns ?? []).length, 0);
  assert.equal(withoutOption.flags.length, 0);
});

test("SO-04 (D-0061): role briefs cite host-attested suite-receipt.json and subtract duplicate full-suite execution on unchanged trees; loss: stuck", () => {
  const judge = readFileSync(join(REPO_ROOT, "assets", "brief-judge.md"), "utf8");
  const critic = readFileSync(join(REPO_ROOT, "assets", "brief-critic.md"), "utf8");
  const actor = readFileSync(join(REPO_ROOT, "assets", "brief-actor.md"), "utf8");

  assert.doesNotMatch(judge, /You run the full suite yourself/i);
  assert.doesNotMatch(actor, /the full suite's counts as you ran it/i);

  const forbidsDuplicateSuite = /(?:never|do not|don't|must not|forbid)[^\n.]*(?:re-?run|duplicate|repeat|run\s+the)[^\n.]*(?:full|public)[^\n.]*suite|(?:never|do not|don't|must not|forbid)[^\n.]*(?:re-?run|duplicate|repeat)[^\n.]*gates\.suite/i;
  const mentionsUnchangedTree = /(?:unchanged\s+(?:tree|worktree|HEAD)|HEAD\^\{tree\}|same\s+tree)/i;

  for (const [name, text] of [["brief-judge.md", judge], ["brief-critic.md", critic], ["brief-actor.md", actor]]) {
    assert.match(text, /suite-receipt\.json/, `${name} must reference host-attested suite-receipt.json`);
    assert.match(text, forbidsDuplicateSuite, `${name} must forbid re-running the full public suite`);
    assert.match(text, mentionsUnchangedTree, `${name} must bind the no-rerun rule to an unchanged tree`);
  }

  assert.match(judge, /sealed\//);
  assert.match(judge, /mutation/i);
  assert.match(critic, /targeted/i);
  assert.match(actor, /targeted/i);
});
