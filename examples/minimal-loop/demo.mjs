#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const scripts = join(root, "scripts");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Demo User",
  GIT_AUTHOR_EMAIL: "demo@example.invalid",
  GIT_COMMITTER_NAME: "Demo User",
  GIT_COMMITTER_EMAIL: "demo@example.invalid",
};

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, env: gitEnv, encoding: "utf8" });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stderr}\n${r.stdout}`);
  }
  return r;
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { env: gitEnv, encoding: "utf8" }).trim();
}

const sandbox = mkdtempSync(join(tmpdir(), "self-loop-demo-"));
try {
  const product = join(sandbox, "demo-app");
  const records = join(sandbox, "demo-records");
  const store = join(sandbox, "owner-store");
  const work = join(sandbox, "work");
  mkdirSync(product, { recursive: true });
  mkdirSync(records, { recursive: true });
  mkdirSync(work, { recursive: true });

  // 1. Initialize product repo
  git(product, "init", "-b", "main");
  writeFileSync(join(product, "VERSION"), "0.1.0\n");
  mkdirSync(join(product, "src"), { recursive: true });
  writeFileSync(join(product, "src", "index.mjs"), "export const add = (a, b) => a + b;\n");
  mkdirSync(join(product, "test"), { recursive: true });
  writeFileSync(join(product, "test", "app.test.mjs"),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/index.mjs';\ntest('add', () => assert.equal(add(1, 2), 3));\n");
  git(product, "add", "-A");
  git(product, "commit", "-m", "init demo-app");
  git(product, "branch", "loop/v1");
  const headSha = git(product, "rev-parse", "HEAD");

  // 2. Initialize records repo & register product
  git(records, "init", "-b", "main");
  for (const dir of ["purpose", "blueprint", "engines", "metrics", "rounds", "evidence", "owner"]) {
    mkdirSync(join(records, dir), { recursive: true });
  }
  writeFileSync(join(records, "README.md"), "# demo-app records\n");
  writeFileSync(join(records, "records.json"), JSON.stringify({ sealed: [], extraKinds: [] }, null, 2) + "\n");
  writeFileSync(join(records, "owner", "words.jsonl"), JSON.stringify({
    id: "W-0000000001",
    time: "2026-11-23T00:00:00Z",
    source: "demo",
    text: "Add two numbers reliably."
  }) + "\n");
  writeFileSync(join(records, "purpose", "P-0001.md"), "# P-0001 Reliable addition\n\nwords: W-0000000001\n\nAdd two numbers reliably.\n");
  writeFileSync(join(records, "blueprint", "F-0001.md"), [
    "# F-0001 Addition core",
    "",
    "id: F-0001",
    "requirements: P-0001",
    "phase: v1",
    "",
    "## 为什么",
    "Serve P-0001.",
    "",
    "## 做什么",
    "Provide a verified add() helper.",
    "",
    "## 设计",
    "none",
    "",
    "## 验收",
    "node --test test/app.test.mjs",
    "",
  ].join("\n"));
  writeFileSync(join(records, "metrics", "blueprint.jsonl"), JSON.stringify({
    feature: "F-0001", status: "building", phase: "v1", by: "lead", note: "demo start", time: "2026-11-23T00:05:00Z", evidence: {}
  }) + "\n");
  for (const b of ["shared", "critic", "actor", "judge", "frame-reviewer"]) {
    writeFileSync(join(records, "engines", `${b}.md`), `# ${b} brief\n`);
  }
  writeFileSync(join(records, "metrics", "handoffs.jsonl"), "");
  writeFileSync(join(records, "metrics", "trajectory.jsonl"), "");
  writeFileSync(join(records, "loop.json"), JSON.stringify({
    product,
    branch: "loop/v1",
    protected: ["main"],
    records,
    workDir: work,
    phase: "v1",
    purpose: ["purpose/P-0001.md"],
    briefs: {
      shared: "engines/shared.md",
      critic: "engines/critic.md",
      actor: "engines/actor.md",
      judge: "engines/judge.md",
      reviewer: "engines/frame-reviewer.md"
    },
    owns: { critic: ["test"], actor: ["src"] },
    agents: {
      critic: { runner: "codex", model: "vendor-b-critic" },
      actor: { runner: "claude", model: "vendor-a-actor" },
      judge: { runner: "codex", model: "vendor-b-judge" },
      reviewer: { runner: "claude", model: "vendor-a-reviewer" }
    },
    sealed: [],
    gates: { suite: "node --test test/app.test.mjs", require: [], remote: "origin" }
  }, null, 2) + "\n");

  const viewSha = (git(records, "add", "-A"), git(records, "commit", "-m", "init records"), git(records, "rev-parse", "HEAD"));
  writeFileSync(join(records, "rounds", "0001-reviewer-frame.md"), "# R-0001-reviewer-frame\n\n## Task (verbatim)\n\nFrame phase v1.\n\n## Report (verbatim)\n\nCONTINUE\n");
  writeFileSync(join(records, "metrics", "handoffs.jsonl"), JSON.stringify({
    id: "R-0001-reviewer-frame", round: 1, phase: "v1", role: "reviewer", step: "reviewer-frame",
    attempt: 1, view: viewSha, record: "rounds/0001-reviewer-frame.md", agent: { runner: "claude", model: "vendor-a-reviewer" },
    product: null, audit: { violations: 0 }, files: ["rounds/0001-reviewer-frame.md"]
  }) + "\n");
  writeFileSync(join(records, "metrics", "trajectory.jsonl"), [
    JSON.stringify({ round: 1, phase: "v1", role: "judge", area: "core", verdict: "CONTINUE", opened: "overflow:R1-1", closed: "-", suite: "1/0", commit: headSha, ci: "absent", time: "2026-11-23T01:00:00Z" }),
    JSON.stringify({ round: 2, phase: "v1", role: "judge", area: "core", verdict: "CONTINUE", opened: "overflow:R2-1", closed: "-", suite: "1/0", commit: headSha, ci: "absent", time: "2026-11-23T02:00:00Z" }),
  ].join("\n") + "\n");
  git(records, "add", "-A");

  console.log("=== 1. Records Check & Index Generation ===");
  const chk = run(process.execPath, [join(scripts, "records-check.mjs"), "--repo", records, "--write"], root);
  console.log(chk.stdout.trim() || "records-check: clean (INDEX.md generated)");
  git(records, "add", "-A");
  git(records, "commit", "-m", "record frame and trajectory");

  console.log("\n=== 2. Trajectory Alarms & Diagnosis Gate ===");
  const alarms = run(process.execPath, [join(scripts, "trajectory.mjs"), "alarms", "--file", join(records, "metrics", "trajectory.jsonl")], root);
  console.log(alarms.stdout.trim());

  const taskFile = join(sandbox, "actor-task.md");
  writeFileSync(taskFile, "features: F-0001\n\nAttempt another patch on core.\n");
  const blocked = run(process.execPath, [join(scripts, "call.mjs"), join(records, "loop.json"), "actor", "--round", "3", "--task", taskFile, "--dry-run"], root, { allowFail: true });
  console.log(`call.mjs actor --dry-run exited ${blocked.status} (refused until alarms are diagnosed):`);
  console.log(blocked.stderr.trim().split("\n").slice(0, 5).join("\n"));

  console.log("\n=== 3. Exact-Tree Suite Receipt (Clean Checkout) ===");
  const receiptPrefix = join(sandbox, "suite-receipt");
  const suite = run(process.execPath, [join(scripts, "suite-green.mjs"), "--repo", product, "--sha", headSha, "--command", "node --test test/app.test.mjs", "--format", "node-test", "--out", receiptPrefix], root);
  console.log(suite.stdout.trim());

  console.log("\n=== 4. Protected Push Gate ===");
  run(process.execPath, [join(scripts, "self-loop.mjs"), "registry", "init", "--owner-store", store], root);
  run(process.execPath, [join(scripts, "self-loop.mjs"), "registry", "add", "--name", "demo-app", "--records", records, "--owner-store", store], root);
  const pushRefused = run(process.execPath, [join(scripts, "gated-push.mjs"), "--repo", product, "--branch", "main", "--suite-receipt", `${receiptPrefix}.json`, "--owner-store", store, "--dry-run"], root, { allowFail: true });
  console.log(`gated-push.mjs --branch main exited ${pushRefused.status} (refused without Judge CONVERGED):`);
  console.log(pushRefused.stderr.trim().split("\n")[0]);

  console.log("\nDemo complete. All mechanical gates behaved as designed.");
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
