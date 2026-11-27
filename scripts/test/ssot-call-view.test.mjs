// F-0014, D-0060
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { call, EXIT, load } from "../call.mjs";
import { git, isolatedEnv, repo, scripts, temp } from "./helpers.mjs";

process.env.SELF_LOOP_TEST = "1";

const mkRepo = (files, dir) => { mkdirSync(dir, { recursive: true }); return repo(files, dir); };

const write = (root, rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const commitFile = (r, rel, text, msg) => {
  write(r, rel, text);
  git(r, "add", "--", rel);
  git(r, "commit", "-q", "-m", msg);
  return git(r, "rev-parse", "HEAD");
};

function makeCallFixture(t, { ssot, productFiles = {}, t3 = false } = {}) {
  const root = temp("self-loop-ssot-call-");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const product = mkRepo({ "README.md": "# product\n", ...productFiles }, join(root, "product"));
  git(product, "checkout", "-q", "-b", "loop/v1");

  const frameRecord = "rounds/0001-reviewer-frame.md";
  const frameHandoff = {
    id: "R-0001-reviewer-frame", time: "2026-11-23T00:00:00Z", phase: "v1", round: 1, step: "reviewer-frame",
    role: "reviewer", attempt: 1, agent: { runner: "cmd", model: null }, view: "0".repeat(40),
    features: [], briefs: ["engines/shared.md", "engines/frame-reviewer.md"], task: "0".repeat(64),
    product: { base: "0".repeat(40), commit: "0".repeat(40) }, exit: 0,
    audit: { violations: 0, denied: 0, flags: 0, unrecognized: 0, file: "evidence/0001/reviewer-frame-1-audit.json" },
    record: frameRecord, files: [frameRecord],
  };
  const records = mkRepo({
    "README.md": "# records\n",
    "records.json": "{}\n",
    "decisions/D-0001.md": "# D-0001 SSOT view test\n\nby: owner\n",
    "blueprint/F-0001.md": "# F-0001 Core\n",
    "engines/shared.md": "# Shared\n",
    "engines/frame-reviewer.md": "# Reviewer\n",
    "engines/critic.md": "# Critic\n",
    "engines/actor.md": "# Actor\n",
    "engines/judge.md": "# Judge\n",
    "plans/PL-0001.md": [
      "# PL-0001 SSOT view", "scope: v1/round-2", "phase: v1", "",
      "## actor", "role: actor", "handoff: R-0002-actor", "authority: D-0001", "goal: Actor view", "files: src/**, docs/**", "interface: fixed", "acceptance: pass", "needs: ", "",
      "## critic", "role: critic", "handoff: R-0002-critic", "authority: D-0001", "goal: Critic view", "files: test/**", "interface: fixed", "acceptance: pass", "needs: ", "reviews: actor", "",
      "## judge-cov", "role: judge", "handoff: R-0002-judge-cov", "authority: D-0001", "goal: Judge coverage", "files: ", "interface: fixed", "acceptance: pass", "needs: ", "",
    ].join("\n"),
    "plans/PL-0002.md": [
      "# PL-0002 SSOT judge view", "scope: v1/round-2-judge", "phase: v1", "",
      "## judge", "role: judge", "handoff: R-0002-judge", "authority: D-0001", "goal: Judge view", "files: ", "interface: fixed", "acceptance: pass", "needs: ", "",
    ].join("\n"),
    [frameRecord]: "# R-0001-reviewer-frame\n\nphase: v1\n",
    "metrics/handoffs.jsonl": `${JSON.stringify(frameHandoff)}\n`,
  }, join(root, "records"));

  const heavyAgent = t3 ? { runner: "t3", provider: "codex", model: "gpt-5" } : { runner: "cmd", cmd: ["true"] };
  const cfgObj = {
    product, records, workDir: join(root, "work"), phase: "v1", branch: "loop/v1", protected: ["main"],
    purpose: ["README.md"],
    briefs: {
      shared: "engines/shared.md", reviewer: "engines/frame-reviewer.md",
      critic: "engines/critic.md", actor: "engines/actor.md", judge: "engines/judge.md",
    },
    owns: { critic: ["test"], actor: ["src", "docs"] },
    agents: { reviewer: { runner: "cmd", cmd: ["true"] }, critic: heavyAgent, actor: heavyAgent, judge: heavyAgent },
    ...(ssot !== undefined ? { ssot } : {}),
  };
  const config = join(records, "loop.json");
  writeFileSync(config, `${JSON.stringify(cfgObj, null, 2)}\n`);
  git(records, "add", "--", "loop.json");
  git(records, "commit", "-q", "-m", "add loop.json");

  const taskFile = join(root, "task.md");
  writeFileSync(taskFile, "features: F-0001\nExecute test task.\n");
  return { root, product, records, config, taskFile };
}

const runCallCli = (args, env = isolatedEnv({ SELF_LOOP_TEST: "1" })) =>
  spawnSync(process.execPath, [join(scripts, "call.mjs"), ...args], { encoding: "utf8", env });

test("1. Configured ssot injects read-only ssot-status.md + prompt pointer for actor/critic/judge (CLI --dry-run and T3 --prepare), never runs custom check or reads dirty tree", t => {
  const markerRoot = temp("self-loop-ssot-marker-");
  t.after(() => rmSync(markerRoot, { recursive: true, force: true }));
  const markerFile = join(markerRoot, "check-ran.txt");
  const ssot = {
    entries: [
      { id: "api-drift", doc: "docs/API.md", watch: ["src/api/**"], mode: "same-batch", check: `echo ran > "${markerFile}" && exit 99` },
      {
        id: "pin-anchor", doc: "docs/PIN.md", watch: ["src/pin.json"], mode: "phase-close",
        anchors: [{ name: "pin", docPattern: "Pin:\\s*`([^`]+)`", source: "src/pin.json", jsonPointer: "/pin" }],
      },
      { id: "clean-doc", doc: "docs/CLEAN.md", watch: ["src/clean/**"], mode: "same-batch" },
    ],
  };

  const fx = makeCallFixture(t, {
    ssot,
    productFiles: {
      "src/api/handler.mjs": "export const v = 1;\n",
      "docs/API.md": "# API v1\n",
      "src/pin.json": JSON.stringify({ pin: "aaaa1111" }) + "\n",
      "docs/PIN.md": "# Pin\nPin: `aaaa1111`\n",
      "src/clean/mod.mjs": "export const c = 1;\n",
      "docs/CLEAN.md": "# Clean\n",
    },
  });
  commitFile(fx.product, "src/api/handler.mjs", "export const v = 2;\n", "drift api");
  const baseSha = commitFile(fx.product, "src/pin.json", JSON.stringify({ pin: "bbbb2222" }) + "\n", "stale pin");
  const shortSha = baseSha.slice(0, 7);

  write(fx.product, "docs/PIN.md", "# Pin\nPin: `bbbb2222`\n");
  write(fx.product, "src/clean/mod.mjs", "export const c = 999;\n");

  const planOpts = role => role === "reviewer" ? {} : { plan: role === "judge" ? "PL-0002" : "PL-0001", package: role };
  for (const [role, verb] of [["actor", "editing"], ["critic", "reviewing"], ["judge", "ruling"]]) {
    const r = call(load(fx.config), role, { round: 2, task: "features: F-0001\nWork.\n", base: baseSha, dry: true, ...planOpts(role) });
    assert.equal(r.code, EXIT.done, r.message);
    const statusPath = join(r.ws, "ssot-status.md");
    assert.equal(existsSync(statusPath), true, `${role} must receive ssot-status.md`);
    assert.equal(statSync(statusPath).mode & 0o777, 0o444, `${role} ssot-status.md must be read-only (0444)`);
    const md = readFileSync(statusPath, "utf8");
    assert.match(md, /## Rung-2 Failures/);
    assert.match(md, /pin-anchor/);
    assert.match(md, /## Rung-3 Drift/);
    assert.match(md, /api-drift.*src\/api\/handler\.mjs/);
    assert.match(md, /## Clean Entries \(1\)/);
    assert.match(md, /clean-doc/);
    const promptText = readFileSync(join(r.ws, "prompt.md"), "utf8");
    assert.match(promptText, new RegExp(`SSOT status at ${shortSha}: read ssot-status\\.md before ${verb} \\(.*pin-anchor.*api-drift.*1 clean\\)\\.`));
  }
  assert.equal(existsSync(markerFile), false, "custom Rung-2 check command must NEVER run during call.mjs workspace prep");

  for (const role of ["reviewer"]) {
    const r = call(load(fx.config), role, { round: 2, task: "features: F-0001\nReview.\n", base: baseSha, dry: true, ...planOpts(role) });
    assert.equal(r.code, EXIT.done, r.message);
    assert.equal(existsSync(join(r.ws, "ssot-status.md")), false, `${role} must NOT receive ssot-status.md`);
    assert.doesNotMatch(readFileSync(join(r.ws, "prompt.md"), "utf8"), /ssot-status\.md|SSOT status/i);
  }

  const t3Fx = makeCallFixture(t, {
    ssot, t3: true,
    productFiles: {
      "src/api/handler.mjs": "export const v = 1;\n",
      "docs/API.md": "# API v1\n",
      "src/pin.json": JSON.stringify({ pin: "aaaa1111" }) + "\n",
      "docs/PIN.md": "# Pin\nPin: `aaaa1111`\n",
      "src/clean/mod.mjs": "export const c = 1;\n",
      "docs/CLEAN.md": "# Clean\n",
    },
  });
  const t3Base = commitFile(t3Fx.product, "src/api/handler.mjs", "export const v = 2;\n", "drift api");
  for (const [role, verb] of [["actor", "editing"], ["critic", "reviewing"], ["judge", "ruling"]]) {
    const planId = role === "judge" ? "PL-0002" : "PL-0001";
    const cliRes = runCallCli([t3Fx.config, role, "--round", "2", "--plan", planId, "--package", role, "--task", t3Fx.taskFile, "--base", t3Base, "--prepare"]);
    assert.equal(cliRes.status, 0, cliRes.stderr);
    const prepared = JSON.parse(cliRes.stdout);
    const statusPath = join(prepared.ws, "ssot-status.md");
    assert.equal(existsSync(statusPath), true);
    assert.equal(statSync(statusPath).mode & 0o777, 0o444);
    assert.match(readFileSync(statusPath, "utf8"), /api-drift.*src\/api\/handler\.mjs/);
    for (const file of ["prompt.md", "t3-prompt.md"]) {
      const txt = readFileSync(join(prepared.ws, file), "utf8");
      assert.match(txt, new RegExp(`SSOT status at ${t3Base.slice(0, 7)}: read ssot-status\\.md before ${verb} \\(1 ssot-drift: api-drift; 2 clean\\)\\.`));
    }
    git(t3Fx.product, "worktree", "remove", "--force", prepared.wt);
  }
  assert.equal(existsSync(markerFile), false);
});

test("2. Zero impact when loop.json has no ssot key, graceful error summary, and symlinked config consistency (B1)", t => {
  const noSsot = makeCallFixture(t, { productFiles: { "src/a.mjs": "export const a = 1;\n" } });
  const cfg = load(noSsot.config);
  assert.equal(Object.hasOwn(cfg, "ssot"), false);
  const planOpts = role => role === "reviewer" ? {} : { plan: role === "judge" ? "PL-0002" : "PL-0001", package: role };
  for (const role of ["actor", "judge", "critic", "reviewer"]) {
    const r = call(cfg, role, { round: 2, task: "features: F-0001\nNo ssot.\n", dry: true, ...planOpts(role) });
    assert.equal(r.code, EXIT.done, r.message);
    assert.equal(existsSync(join(r.ws, "ssot-status.md")), false);
    assert.doesNotMatch(readFileSync(join(r.ws, "prompt.md"), "utf8"), /ssot-status\.md|SSOT status/i);
  }

  const brokenCfg = { ...cfg, ssot: { entries: [{ id: "a", doc: "README.md", watch: ["src/**"] }] }, configFile: undefined };
  const errCall = call(brokenCfg, "actor", { round: 2, task: "features: F-0001\nBroken ssot.\n", dry: true, plan: "PL-0001", package: "actor" });
  assert.equal(errCall.code, EXIT.done, errCall.message);
  const errMd = readFileSync(join(errCall.ws, "ssot-status.md"), "utf8");
  assert.equal(statSync(join(errCall.ws, "ssot-status.md")).mode & 0o777, 0o444);
  assert.match(errMd, /## Evaluation Error/);
  assert.match(errMd, /configFile must be an absolute path/);
  assert.match(readFileSync(join(errCall.ws, "prompt.md"), "utf8"), /evaluation error:/);

  const aliasDir = temp("self-loop-ssot-alias-");
  t.after(() => rmSync(aliasDir, { recursive: true, force: true }));
  const realRec = join(aliasDir, "nested", "real-rec"), linkedRec = join(aliasDir, "rec-link");
  mkdirSync(realRec, { recursive: true });
  writeFileSync(join(realRec, "loop.json"), JSON.stringify({ ...JSON.parse(readFileSync(noSsot.config, "utf8")), records: ".", product: ".." }));
  symlinkSync(realRec, linkedRec);
  const linkedNoSsotCfg = load(join(linkedRec, "loop.json"));
  assert.equal(linkedNoSsotCfg.configFile, join(linkedRec, "loop.json"));
  assert.equal(linkedNoSsotCfg.records, linkedRec);
  assert.equal(linkedNoSsotCfg.product, aliasDir);

  const extRoot = temp("self-loop-ssot-extlink-");
  t.after(() => rmSync(extRoot, { recursive: true, force: true }));
  const designRepo = mkRepo({ "ARCH.md": "# Arch\n" }, join(extRoot, "design"));
  const extFx = makeCallFixture(t, {
    productFiles: { "src/a.mjs": "export const a = 1;\n" },
    ssot: { repos: { design: "../design" }, entries: [{ id: "arch", repo: "design", doc: "ARCH.md", watch: ["src/**"] }] },
  });
  const symlinkRecDir = join(extRoot, "sub", "rec-link");
  mkdirSync(dirname(symlinkRecDir), { recursive: true });
  symlinkSync(extFx.records, symlinkRecDir);
  const symlinkCfgPath = join(symlinkRecDir, "loop.json");
  const checkRes = spawnSync(process.execPath, [join(scripts, "ssot-check.mjs"), "check", "--config", symlinkCfgPath], { encoding: "utf8", env: isolatedEnv() });
  assert.equal(checkRes.status, 2);
  assert.match(checkRes.stderr + checkRes.stdout, /repo-error|symlink/i);
  const symCall = call(load(symlinkCfgPath), "actor", { round: 2, task: "features: F-0001\nSymlink config.\n", dry: true, plan: "PL-0001", package: "actor" });
  assert.equal(symCall.code, EXIT.done, symCall.message);
  assert.match(readFileSync(join(symCall.ws, "ssot-status.md"), "utf8"), /repo-error|symlink/i);
  assert.ok(designRepo);
});
