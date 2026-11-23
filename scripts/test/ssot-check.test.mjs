// F-0014, D-0057: Two-way proof tests for SSOT authority doc verification, drift detection, merges, cross-repo sync, and gate wiring.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pushCommit } from "../lib/ci.mjs";
import { attestSsot, checkSsot, SsotConfigError, validateSsotSchema } from "../lib/ssot.mjs";
import { fakeGh, git, green, isolatedEnv, repo, roomyStore, scripts, temp } from "./helpers.mjs";

const write = (root, rel, text) => {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

const mkRepo = (files, dir) => { mkdirSync(dir, { recursive: true }); return repo(files, dir); };

const commitFile = (r, rel, text, msg = `update ${rel}`) => {
  write(r, rel, text);
  git(r, "add", "--", rel);
  git(r, "commit", "-q", "-m", msg);
  return git(r, "rev-parse", "HEAD");
};

const trackTemp = (t, prefix = "self-loop-ssot-test-") => {
  const dir = temp(prefix);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const runCli = (script, args, env = isolatedEnv()) =>
  spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", env });

const ssotCli = (args, env) => runCli("ssot-check.mjs", args, env);
const worktreePaths = r => git(r, "worktree", "list", "--porcelain").split("\n").filter(l => l.startsWith("worktree "));

function makeLoop(t, { productFiles = {}, ssot, extraRecords = {}, branch = "loop/v1", protectedBranches = ["main"], require = [], extraLoop = {} } = {}) {
  const root = trackTemp(t);
  const product = mkRepo({ "README.md": "# product\n", ...productFiles }, join(root, "product"));
  if (branch !== "main") git(product, "checkout", "-q", "-b", branch);
  const bare = join(root, "origin.git");
  git(root, "init", "-q", "--bare", bare);
  git(product, "remote", "add", "origin", bare);
  const records = mkRepo({ "README.md": "# records\n", "records.json": "{}\n", ...extraRecords }, join(root, "records"));
  const loopCfg = {
    product, records, workDir: join(root, "work"), phase: "v1", branch, protected: protectedBranches,
    briefs: { shared: "engines/shared.md", critic: "engines/critic.md", actor: "engines/actor.md", judge: "engines/judge.md", reviewer: "engines/frame-reviewer.md" },
    agents: { critic: { runner: "cmd", cmd: ["true"] }, actor: { runner: "cmd", cmd: ["true"] }, judge: { runner: "cmd", cmd: ["true"] }, reviewer: { runner: "cmd", cmd: ["true"] } },
    gates: { require, remote: "origin" }, ...(ssot !== undefined ? { ssot } : {}), ...extraLoop,
  };
  write(records, "loop.json", JSON.stringify(loopCfg, null, 2) + "\n");
  git(records, "add", "--", "loop.json");
  git(records, "commit", "-q", "-m", "loop config");
  const store = join(root, "owner-store");
  mkdirSync(store, { recursive: true });
  writeFileSync(join(store, "products.json"), JSON.stringify({ products: [{ name: "demo", records }] }));
  return { root, product, bare, records, store, config: join(records, "loop.json"), loopCfg };
}

function suiteReceiptFor(product, sha, dir) {
  const file = join(dir, `suite-${sha.slice(0, 8)}.json`);
  writeFileSync(file, JSON.stringify({ repository: product, sha, tree: git(product, "--no-replace-objects", "rev-parse", `${sha}^{tree}`), green: true, reasons: [] }));
  return file;
}

function addJudgeConvergence(records, sha, { round = 1, phase = "v1" } = {}) {
  const pad = String(round).padStart(4, "0");
  const pub = `rounds/${pad}-judge.md`, sealed = `sealed/judge/${pad}/judge-1.md`;
  const row = { round, phase, area: "core", role: "judge", model: "m", verdict: "CONVERGED", opened: "-", closed: "-", suite: "10/0", owner: "0", commit: sha, ci: "success", time: "2026-11-23T00:00:00Z" };
  const handoff = { id: `R-${pad}-judge`, role: "judge", step: "judge", round, phase, attempt: 1, view: "a".repeat(40), record: pub,
    agent: { runner: "codex" }, product: { base: sha, commit: sha }, files: [pub, sealed], audit: { violations: 0 }, time: "2026-11-23T00:00:00Z" };
  write(records, pub, `# R-${pad}-judge\n\nphase: ${phase}\n\n## Public report (verbatim, out/public.md)\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n`);
  write(records, sealed, `\`\`\`\nmeta\n\`\`\`\n\n## Report (verbatim)\n\nVERDICT: CONVERGED\nACCEPTANCE: pass\n`);
  write(records, "metrics/handoffs.jsonl", JSON.stringify(handoff) + "\n");
  write(records, "metrics/trajectory.jsonl", JSON.stringify(row) + "\n");
  git(records, "add", "--", pub, sealed, "metrics/handoffs.jsonl", "metrics/trajectory.jsonl");
  git(records, "commit", "-q", "-m", `judge convergence ${sha.slice(0, 7)}`);
}

test("1. Backward compatibility: repo without ssot passes ssot-check, gated-push, trajectory, next, and records-check with zero overhead", t => {
  const fx = makeLoop(t, { productFiles: { "src/app.js": "export const v = 1;\n" } });
  const sha = git(fx.product, "rev-parse", "HEAD");
  const checkRes = ssotCli(["check", "--config", fx.config, "--sha", sha, "--strict", "--json"]);
  assert.equal(checkRes.status, 0, checkRes.stderr);
  assert.equal(JSON.parse(checkRes.stdout).configured, false);

  const suite = suiteReceiptFor(fx.product, sha, fx.root);
  const push = runCli("gated-push.mjs", ["--repo", fx.product, "--branch", "loop/v1", "--sha", sha, "--suite-receipt", suite, "--owner-store", fx.store]);
  assert.equal(push.status, 0, push.stderr);
  assert.equal(git(fx.bare, "rev-parse", "refs/heads/loop/v1"), sha);

  const loadDir = trackTemp(t, "self-loop-load-"), storeDir = roomyStore();
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  const next = runCli("self-loop.mjs", ["next", "--config", fx.config, "--owner-store", storeDir], isolatedEnv({ SELF_LOOP_LOAD_DIR: loadDir }));
  assert.equal(next.status, 0, next.stderr);
  assert.doesNotMatch(next.stdout, /ssot-drift/i);

  write(fx.records, "metrics/trajectory.jsonl", "");
  const alarmsRes = runCli("trajectory.mjs", ["alarms", "--file", join(fx.records, "metrics/trajectory.jsonl"), "--json"]);
  assert.equal(alarmsRes.status, 0, alarmsRes.stderr);
  assert.deepEqual(JSON.parse(alarmsRes.stdout), []);
});

test("2. Rung-2 built-in anchors: jsonPointer + sourcePattern, exact match, stale mismatch, ambiguity, and exact --sha tree isolation", t => {
  const ssot = {
    entries: [{
      id: "contracts-index", doc: "contracts/README.md", repo: "product", watch: ["packages/**"],
      anchors: [
        { name: "protocol-pin", docPattern: "Protocol Pin:\\s*`([0-9a-f]{8,64})`", source: "packages/protocol/pin.json", jsonPointer: "/meta~1v1/pin~0id" },
        { name: "api-version", docPattern: "API Version:\\s*`([0-9]+\\.[0-9]+)`", source: "packages/api/version.mjs", sourcePattern: 'export const API_VERSION = "([^"]+)";' },
      ],
    }],
  };
  const fx = makeLoop(t, {
    ssot,
    productFiles: {
      "packages/protocol/pin.json": JSON.stringify({ "meta/v1": { "pin~id": "deadbeef01" }, nested: { obj: true } }) + "\n",
      "packages/api/version.mjs": 'export const API_VERSION = "2.4";\n',
      "contracts/README.md": "# Contracts\n\nProtocol Pin: `deadbeef01`\nAPI Version: `2.4`\n",
    },
  });
  const goodSha = git(fx.product, "rev-parse", "HEAD");
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", goodSha, "--strict"]).status, 0);

  // Dirty working tree edits must not pollute checking exact --sha
  write(fx.product, "packages/protocol/pin.json", JSON.stringify({ "meta/v1": { "pin~id": "ffffffff99" } }) + "\n");
  write(fx.product, "contracts/README.md", "# Broken dirty doc\n");
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", goodSha, "--strict"]).status, 0);
  git(fx.product, "checkout", "--", ".");

  // Stale pin mismatch, missing anchor, duplicate anchor, and non-scalar pointer all fail closed (exit 2)
  const staleSha = commitFile(fx.product, "packages/protocol/pin.json", JSON.stringify({ "meta/v1": { "pin~id": "cafebabe02" } }) + "\n", "bump pin");
  const stale = ssotCli(["check", "--config", fx.config, "--sha", staleSha, "--json"]);
  assert.equal(stale.status, 2);
  assert.deepEqual([JSON.parse(stale.stdout).failures[0].expected, JSON.parse(stale.stdout).failures[0].actual], ["cafebabe02", "deadbeef01"]);

  const missingSha = commitFile(fx.product, "contracts/README.md", "# Contracts\n\nAPI Version: `2.4`\n", "drop pin");
  assert.match(JSON.parse(ssotCli(["check", "--config", fx.config, "--sha", missingSha, "--json"]).stdout).failures[0].detail, /matched 0 time/);

  const dupSha = commitFile(fx.product, "contracts/README.md", "Protocol Pin: `cafebabe02`\nProtocol Pin: `cafebabe02`\nAPI Version: `2.4`\n", "dup pin");
  assert.match(JSON.parse(ssotCli(["check", "--config", fx.config, "--sha", dupSha, "--json"]).stdout).failures[0].detail, /matched 2 time/);

  const badPtrCfg = join(fx.root, "bad-ptr.json");
  writeFileSync(badPtrCfg, JSON.stringify({ ...fx.loopCfg, ssot: { entries: [{ id: "obj-ptr", doc: "contracts/README.md", watch: ["packages/**"],
    anchors: [{ name: "obj", docPattern: "API Version:\\s*`([^`]+)`", source: "packages/protocol/pin.json", jsonPointer: "/nested" }] }] } }));
  assert.match(JSON.parse(ssotCli(["check", "--config", badPtrCfg, "--sha", goodSha, "--json"]).stdout).failures[0].detail, /unsupported JSON value/);
});

test("3. Rung-2 custom check command runs in clean detached worktree with exact env vars, --out no-overwrite, and cleanup", t => {
  const checkScript = [
    'import { existsSync, readFileSync } from "node:fs";',
    'if (existsSync("DIRTY_UNTRACKED.txt")) process.exit(3);',
    'for (const k of ["SELF_LOOP_SSOT_ID", "SELF_LOOP_SSOT_DOC", "SELF_LOOP_SSOT_SHA", "SELF_LOOP_SSOT_PRODUCT", "SELF_LOOP_SSOT_DOC_REPO"]) if (!process.env[k]) process.exit(4);',
    'const doc = readFileSync(process.env.SELF_LOOP_SSOT_DOC, "utf8");',
    'if (!doc.includes(JSON.parse(readFileSync("src/routes.json", "utf8")).route)) { console.error("route missing in doc"); process.exit(1); }',
  ].join("\n") + "\n";

  const fx = makeLoop(t, {
    ssot: { entries: [{ id: "routes", doc: "docs/ROUTES.md", watch: ["src/**"], check: "node scripts/verify-routes.mjs" }] },
    productFiles: { "scripts/verify-routes.mjs": checkScript, "src/routes.json": JSON.stringify({ route: "/v1/health" }) + "\n", "docs/ROUTES.md": "# Routes\n- /v1/health\n" },
  });
  const okSha = git(fx.product, "rev-parse", "HEAD");
  write(fx.product, "DIRTY_UNTRACKED.txt", "dirty\n");
  const wtBefore = worktreePaths(fx.product);
  const receiptOut = join(fx.root, "ssot-receipt.json");
  assert.equal(ssotCli(["--config", fx.config, "--sha", okSha, "--strict", "--json", "--out", receiptOut]).status, 0);
  assert.equal(JSON.parse(readFileSync(receiptOut, "utf8")).ok, true);
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", okSha, "--out", receiptOut]).status, 64);
  assert.deepEqual(worktreePaths(fx.product), wtBefore);

  const failSha = commitFile(fx.product, "src/routes.json", JSON.stringify({ route: "/v1/new-endpoint" }) + "\n", "add endpoint");
  const fail = ssotCli(["check", "--config", fx.config, "--sha", failSha, "--json"]);
  assert.equal(fail.status, 2);
  assert.match(JSON.parse(fail.stdout).failures[0].output, /route missing in doc/);
  assert.deepEqual(worktreePaths(fx.product), wtBefore);
});

test("4. Rung-3 in-repo drift: watch/ignore, literal pathspec, --no-ff merges (B1), one-shot expiry, watch-widening (N5), product updated refusal (N3)", t => {
  const fx = makeLoop(t, {
    ssot: { entries: [{ id: "api-doc", doc: "docs/A*.md", watch: ["src/**"], ignore: ["**/*.test.mjs"], mode: "same-batch" }] },
    productFiles: { "src/core.mjs": "export const x = 1;\n", "docs/A*.md": "# API v1\n", "docs/AB.md": "# sibling\n" },
  });
  const c1 = git(fx.product, "rev-parse", "HEAD");
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", c1, "--strict"]).status, 0);

  // Ignored and unwatched paths cause 0 drift
  const cIgnored = commitFile(fx.product, "src/core.test.mjs", "// test\n", "test");
  const cUnwatched = commitFile(fx.product, "README.md", "# readme\n", "readme");
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", cIgnored, "--strict"]).status, 0);
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", cUnwatched, "--strict"]).status, 0);

  // N4: Editing sibling docs/AB.md must NOT clear drift on literal docs/A*.md
  const c2 = commitFile(fx.product, "src/core.mjs", "export const x = 2;\n", "change core");
  const cSibling = commitFile(fx.product, "docs/AB.md", "# sibling v2\n", "edit sibling");
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", cSibling, "--strict"]).status, 2);

  // N3: Product entry refuses --disposition updated
  const badUpd = ssotCli(["attest", "--config", fx.config, "--id", "api-doc", "--sha", c2, "--disposition", "updated", "--by", "actor", "--reason", "nope"]);
  assert.equal(badUpd.status, 2);
  assert.match(badUpd.stderr, /product-repo entry/);

  // One-shot no-contract-change clears c2, invalidates on watch widening (N5) and on next watched commit
  assert.equal(ssotCli(["attest", "--config", fx.config, "--id", "api-doc", "--sha", c2, "--disposition", "no-contract-change", "--by", "actor", "--reason", "perf", "--round", "2"]).status, 0);
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", c2, "--strict"]).status, 0);

  const widenedCfg = join(fx.root, "widened.json");
  writeFileSync(widenedCfg, JSON.stringify({ ...fx.loopCfg, ssot: { entries: [{ id: "api-doc", doc: "docs/A*.md", watch: ["src/**", "lib/**"], ignore: ["**/*.test.mjs"] }] } }));
  assert.equal(ssotCli(["check", "--config", widenedCfg, "--sha", c2, "--strict"]).status, 2, "widening watch must invalidate prior no-contract-change");

  const c3 = commitFile(fx.product, "src/core.mjs", "export const x = 3;\n", "change core again");
  assert.equal(ssotCli(["check", "--config", fx.config, "--sha", c3, "--strict"]).status, 2);

  // B1 Merge Scenario 1 (fp): feature branch updates code + doc together, --no-ff merge -> 0 drift & protected branch passes!
  const mFx = makeLoop(t, {
    branch: "main", protectedBranches: ["main"], require: [],
    ssot: { entries: [{ id: "api", doc: "docs/API.md", watch: ["src/**"] }] },
    productFiles: { "src/a.mjs": "export const a = 1;\n", "docs/API.md": "# API 1\n" },
  });
  git(mFx.product, "checkout", "-q", "-b", "feat/ok");
  write(mFx.product, "src/a.mjs", "export const a = 2;\n");
  write(mFx.product, "docs/API.md", "# API 2\n");
  git(mFx.product, "add", "--", "src/a.mjs", "docs/API.md");
  git(mFx.product, "commit", "-q", "-m", "feat code + doc");
  git(mFx.product, "checkout", "-q", "main");
  git(mFx.product, "merge", "-q", "--no-ff", "feat/ok", "-m", "merge feat/ok");
  const mergeOk = git(mFx.product, "rev-parse", "HEAD");
  assert.equal(ssotCli(["check", "--config", mFx.config, "--sha", mergeOk, "--strict"]).status, 0, "ordinary --no-ff merge must have 0 drift");
  addJudgeConvergence(mFx.records, mergeOk);
  const mergeSuite = suiteReceiptFor(mFx.product, mergeOk, mFx.root);
  assert.equal(runCli("gated-push.mjs", ["--repo", mFx.product, "--branch", "main", "--sha", mergeOk, "--suite-receipt", mergeSuite, "--owner-store", mFx.store]).status, 0);

  // B1 Merge Scenario 2 (side): side branch changes watched code without doc, --no-ff merge -> drift detected!
  git(mFx.product, "checkout", "-q", "-b", "feat/miss-doc");
  commitFile(mFx.product, "src/a.mjs", "export const a = 3;\n", "side code only");
  git(mFx.product, "checkout", "-q", "main");
  git(mFx.product, "merge", "-q", "--no-ff", "feat/miss-doc", "-m", "merge side miss");
  const mergeMiss = git(mFx.product, "rev-parse", "HEAD");
  const missRes = ssotCli(["check", "--config", mFx.config, "--sha", mergeMiss, "--strict", "--json"]);
  assert.equal(missRes.status, 2);
  assert.deepEqual(JSON.parse(missRes.stdout).drift[0].changedPaths, ["src/a.mjs"]);

  // B1 Merge Scenario 3 (evil): side branch updates code + doc, evil merge modifies another watched file -> drift detected!
  git(mFx.product, "checkout", "-q", "-b", "feat/evil");
  write(mFx.product, "src/a.mjs", "export const a = 4;\n");
  write(mFx.product, "docs/API.md", "# API 4\n");
  git(mFx.product, "add", "--", "src/a.mjs", "docs/API.md");
  git(mFx.product, "commit", "-q", "-m", "clean feat");
  git(mFx.product, "checkout", "-q", "main");
  git(mFx.product, "merge", "-q", "--no-ff", "--no-commit", "feat/evil");
  write(mFx.product, "src/evil.mjs", "export const evil = true;\n");
  git(mFx.product, "add", "--", "src/evil.mjs");
  git(mFx.product, "commit", "-q", "-m", "evil merge");
  const mergeEvil = git(mFx.product, "rev-parse", "HEAD");
  const evilRes = ssotCli(["check", "--config", mFx.config, "--sha", mergeEvil, "--strict", "--json"]);
  assert.equal(evilRes.status, 2);
  assert.deepEqual(JSON.parse(evilRes.stdout).drift[0].changedPaths, ["src/evil.mjs"]);
});

test("5. Cross-repo ssot.repos (B2, N3, N10): isolated external check worktree, dirty attest refusal, unchanged blob refusal, and symlink escapes", t => {
  const root = trackTemp(t, "self-loop-ssot-xrepo-");
  const designDir = mkRepo({ "顶层规划/顶层设计.md": "# 顶层设计 v1\nPin: `aaaa1111`\n" }, join(root, "design"));
  const extCheckScript = [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const doc = readFileSync(join(process.env.SELF_LOOP_SSOT_DOC_REPO, process.env.SELF_LOOP_SSOT_DOC), "utf8");',
    'const pin = JSON.parse(readFileSync("packages/core/pin.json", "utf8")).pin;',
    'if (!doc.includes(pin)) { console.error("external doc pin mismatch"); process.exit(1); }',
  ].join("\n") + "\n";
  const product = mkRepo({
    "packages/core/src/index.mjs": "export const a = 1;\n",
    "packages/core/pin.json": JSON.stringify({ pin: "aaaa1111" }) + "\n",
    "scripts/check-xrepo.mjs": extCheckScript,
  }, join(root, "product"));
  const records = mkRepo({ "README.md": "# records\n", "records.json": "{}\n" }, join(root, "records"));
  const config = join(records, "loop.json");
  const baseCfg = {
    product, records, workDir: join(root, "work"), phase: "v1", branch: "main", protected: ["main"], briefs: {}, agents: {}, gates: { require: [] },
    ssot: {
      repos: { design: "../design" },
      entries: [{ id: "top-arch", doc: "顶层规划/顶层设计.md", repo: "design", watch: ["packages/**"], ignore: ["**/*.test.*"], mode: "phase-close", check: "node scripts/check-xrepo.mjs" }],
    },
  };
  writeFileSync(config, JSON.stringify(baseCfg, null, 2) + "\n");
  git(records, "add", "--", "loop.json");
  git(records, "commit", "-q", "-m", "init loop");

  const p1 = git(product, "rev-parse", "HEAD");
  const designWtBefore = worktreePaths(designDir);
  assert.equal(ssotCli(["check", "--config", config, "--sha", p1, "--strict"]).status, 2);

  // Initial baseline updated attestation succeeds
  assert.equal(ssotCli(["attest", "--config", config, "--id", "top-arch", "--sha", p1, "--disposition", "updated", "--by", "actor", "--reason", "initial sync"]).status, 0);
  assert.equal(ssotCli(["check", "--config", config, "--sha", p1, "--strict"]).status, 0);
  assert.deepEqual(worktreePaths(designDir), designWtBefore, "external detached worktree must be cleaned");

  // B2: Bump product pin -> dirty uncommitted edit in external design repo MUST NOT pass check AND MUST refuse attest updated!
  const p2 = commitFile(product, "packages/core/pin.json", JSON.stringify({ pin: "bbbb2222" }) + "\n", "bump pin");
  write(designDir, "顶层规划/顶层设计.md", "# 顶层设计 v2 dirty\nPin: `bbbb2222`\n");
  const dirtyCheck = ssotCli(["check", "--config", config, "--sha", p2, "--json"]);
  assert.equal(dirtyCheck.status, 2, "dirty uncommitted external doc must not make check pass");
  assert.equal(JSON.parse(dirtyCheck.stdout).failures[0].kind, "check-failed");
  assert.deepEqual(worktreePaths(designDir), designWtBefore);

  const dirtyAttest = ssotCli(["attest", "--config", config, "--id", "top-arch", "--sha", p2, "--disposition", "updated", "--by", "actor", "--reason", "uncommitted"]);
  assert.equal(dirtyAttest.status, 2);
  assert.match(dirtyAttest.stderr, /uncommitted changes/);

  // N3: Reverting dirty edit and attesting updated on unchanged committed doc must be refused!
  git(designDir, "checkout", "--", ".");
  const sameBlob = ssotCli(["attest", "--config", config, "--id", "top-arch", "--sha", p2, "--disposition", "updated", "--by", "actor", "--reason", "no real change"]);
  assert.equal(sameBlob.status, 2);
  assert.match(sameBlob.stderr, /unchanged from previous updated receipt/);

  // Committing real update in design repo -> check & attest updated both pass!
  const d2 = commitFile(designDir, "顶层规划/顶层设计.md", "# 顶层设计 v2\nPin: `bbbb2222`\n", "commit pin sync");
  const att2 = ssotCli(["attest", "--config", config, "--id", "top-arch", "--sha", p2, "--disposition", "updated", "--by", "actor", "--reason", "synced pin", "--json"]);
  assert.equal(att2.status, 0, att2.stderr);
  assert.equal(JSON.parse(att2.stdout).row.docRepoSha, d2);
  assert.equal(ssotCli(["check", "--config", config, "--sha", p2, "--strict"]).status, 0);

  // Escape & N10 vectors: "..", relative symlink, absolute intermediate symlink, committed symlink doc
  const outside = mkRepo({ "secret.md": "# outside\n" }, join(root, "outside"));
  symlinkSync(outside, join(root, "design-link"));
  const cases = [
    [{ repos: { design: "../design" }, entries: [{ id: "esc", doc: "../outside.md", repo: "design", watch: ["packages/**"] }] }],
    [{ repos: { design: "../design-link" }, entries: [{ id: "rel-sym", doc: "secret.md", repo: "design", watch: ["packages/**"] }] }],
    [{ repos: { design: join(root, "design-link") }, entries: [{ id: "abs-sym", doc: "secret.md", repo: "design", watch: ["packages/**"] }] }],
  ];
  for (const [i, ssotCfg] of cases.entries()) {
    const f = join(root, `esc-${i}.json`);
    writeFileSync(f, JSON.stringify({ ...baseCfg, ssot: ssotCfg }));
    assert.equal(ssotCli(["check", "--config", f, "--sha", p2]).status, 2, `escape case ${i}`);
  }
  symlinkSync(join(outside, "secret.md"), join(designDir, "escape-link.md"));
  git(designDir, "add", "--", "escape-link.md");
  git(designDir, "commit", "-q", "-m", "symlink doc");
  const symDocCfg = join(root, "sym-doc.json");
  writeFileSync(symDocCfg, JSON.stringify({ ...baseCfg, ssot: { repos: { design: "../design" }, entries: [{ id: "sym-doc", doc: "escape-link.md", repo: "design", watch: ["packages/**"] }] } }));
  assert.equal(ssotCli(["check", "--config", symDocCfg, "--sha", p2]).status, 2);
});

test("6. End-to-end integration: gated-push, trajectory CONVERGED & alarms (N9), self-loop next/ssot, and records-check (B3)", t => {
  const ssot = {
    entries: [{
      id: "contracts", doc: "docs/CONTRACTS.md", watch: ["src/**"], mode: "phase-close",
      anchors: [{ name: "pin", docPattern: "Pin:\\s*`([^`]+)`", source: "src/pin.json", jsonPointer: "/pin" }],
    }],
  };
  const fx = makeLoop(t, {
    ssot, protectedBranches: ["main"], require: [],
    productFiles: { "src/pin.json": JSON.stringify({ pin: "aaaa1111" }) + "\n", "src/api.mjs": "export const api = 1;\n", "docs/CONTRACTS.md": "# Contracts\n\nPin: `aaaa1111`\n" },
  });

  // 6a. Rung-2 failure refuses working branch gated-push
  const badPinSha = commitFile(fx.product, "src/pin.json", JSON.stringify({ pin: "bbbb2222" }) + "\n", "stale pin");
  assert.equal(runCli("gated-push.mjs", ["--repo", fx.product, "--branch", "loop/v1", "--sha", badPinSha, "--suite-receipt", suiteReceiptFor(fx.product, badPinSha, fx.root), "--owner-store", fx.store]).status, 2);

  // 6b. Rung-3 drift warns on working branch, blocks protected branch
  write(fx.product, "src/pin.json", JSON.stringify({ pin: "aaaa1111" }) + "\n");
  write(fx.product, "src/api.mjs", "export const api = 2;\n");
  git(fx.product, "add", "--", "src/pin.json", "src/api.mjs");
  git(fx.product, "commit", "-q", "-m", "api drift");
  const driftSha = git(fx.product, "rev-parse", "HEAD");
  const driftSuite = suiteReceiptFor(fx.product, driftSha, fx.root);

  const workOk = runCli("gated-push.mjs", ["--repo", fx.product, "--branch", "loop/v1", "--sha", driftSha, "--suite-receipt", driftSuite, "--owner-store", fx.store]);
  assert.equal(workOk.status, 0, workOk.stderr);
  assert.match(workOk.stderr, /Warning: ssot-drift contracts/);

  addJudgeConvergence(fx.records, driftSha);
  assert.equal(runCli("gated-push.mjs", ["--repo", fx.product, "--branch", "main", "--sha", driftSha, "--suite-receipt", driftSuite, "--owner-store", fx.store]).status, 2);

  // 6c. self-loop next, self-loop ssot, trajectory alarms, and B3 records-check screening
  const loadDir = trackTemp(t, "self-loop-load-"), storeDir = roomyStore();
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  const nextDrift = runCli("self-loop.mjs", ["next", "--config", fx.config, "--owner-store", storeDir], isolatedEnv({ SELF_LOOP_LOAD_DIR: loadDir }));
  assert.equal(nextDrift.status, 0, nextDrift.stderr);
  assert.match(nextDrift.stdout, /ssot-drift/);
  assert.equal(runCli("self-loop.mjs", ["ssot", "check", "--config", fx.config, "--sha", driftSha, "--strict"]).status, 2);

  const trajAlarms = runCli("trajectory.mjs", ["alarms", "--file", join(fx.records, "metrics/trajectory.jsonl"), "--json"]);
  assert.equal(trajAlarms.status, 0);
  assert.ok(JSON.parse(trajAlarms.stdout).some(a => a.type === "ssot-drift" && a.key === "ssot-drift:contracts"));

  assert.equal(runCli("records-check.mjs", ["--repo", fx.records, "--write"]).status, 0);
  git(fx.records, "add", "--", "INDEX.md");
  git(fx.records, "commit", "-q", "-m", "index");

  const recDrift = runCli("records-check.mjs", ["--repo", fx.records, "--json"]);
  assert.equal(recDrift.status, 0, recDrift.stdout + recDrift.stderr);
  assert.ok(JSON.parse(recDrift.stdout).screening.some(s => s.rule === "ssot-drift" && /contracts/.test(s.detail)), "B3: records-check must surface ssot-drift screening");

  // 6d. trajectory append refuses CONVERGED while drift exists, accepts once cleared
  const ghFx = makeLoop(t, {
    ssot, require: ["github-actions/verify"], extraRecords: { "metrics/.keep": "" },
    productFiles: { "src/pin.json": JSON.stringify({ pin: "aaaa1111" }) + "\n", "src/api.mjs": "export const api = 1;\n", "docs/CONTRACTS.md": "# Contracts\n\nPin: `aaaa1111`\n" },
  });
  git(ghFx.product, "remote", "set-url", "origin", "https://github.com/example/ssot-demo.git");
  const driftSha2 = commitFile(ghFx.product, "src/api.mjs", "export const api = 2;\n", "drift");
  const cleanSha2 = commitFile(ghFx.product, "docs/CONTRACTS.md", "# Contracts v2\n\nPin: `aaaa1111`\n", "sync");
  const gh = fakeGh({ "example/ssot-demo": { [driftSha2]: [green()], [cleanSha2]: [green()] } });
  t.after(() => rmSync(gh.bin, { recursive: true, force: true }));
  const trajPath = join(ghFx.records, "metrics/trajectory.jsonl");
  const env = isolatedEnv({ PATH: gh.env.PATH });

  assert.equal(runCli("trajectory.mjs", ["append", "--file", trajPath, "--round", "1", "--phase", "v1", "--role", "judge", "--verdict", "CONVERGED", "--suite", "5/0", "--commit", driftSha2], env).status, 2);
  assert.equal(existsSync(trajPath), false);
  assert.equal(runCli("trajectory.mjs", ["append", "--file", trajPath, "--round", "1", "--phase", "v1", "--role", "judge", "--verdict", "CONVERGED", "--suite", "5/0", "--commit", cleanSha2], env).status, 0);

  // N9: Broken product path in loop.json surfaces visible ssot-error alarm instead of silent swallow
  const brokenFx = makeLoop(t, { ssot, extraRecords: { "metrics/trajectory.jsonl": "" } });
  rmSync(brokenFx.product, { recursive: true, force: true });
  const errAlarms = runCli("trajectory.mjs", ["alarms", "--file", join(brokenFx.records, "metrics/trajectory.jsonl"), "--json"]);
  assert.equal(errAlarms.status, 0);
  assert.ok(JSON.parse(errAlarms.stdout).some(a => a.type === "ssot-error" && /SSOT screening failed/.test(a.message)));

  // 6e. Clear drift -> protected push succeeds; malformed ssot-sync.jsonl line fails records-check with exact path & line (B3)
  assert.equal(ssotCli(["attest", "--config", fx.config, "--id", "contracts", "--sha", driftSha, "--disposition", "no-contract-change", "--by", "judge", "--reason", "verified internal"]).status, 0);
  const recClean = runCli("records-check.mjs", ["--repo", fx.records, "--json"]);
  assert.equal(recClean.status, 0, recClean.stdout + recClean.stderr);
  assert.deepEqual(JSON.parse(recClean.stdout).failures, []);
  assert.equal(JSON.parse(recClean.stdout).screening.some(s => s.rule === "ssot-drift"), false);
  assert.equal(runCli("gated-push.mjs", ["--repo", fx.product, "--branch", "main", "--sha", driftSha, "--suite-receipt", driftSuite, "--owner-store", fx.store]).status, 0);

  writeFileSync(join(fx.records, "metrics/ssot-sync.jsonl"), readFileSync(join(fx.records, "metrics/ssot-sync.jsonl"), "utf8") + "{not-json\n");
  const recBad = runCli("records-check.mjs", ["--repo", fx.records, "--json"]);
  assert.equal(recBad.status, 1);
  assert.ok(JSON.parse(recBad.stdout).failures.some(f => f.rule === "ssot-sync" && f.path === "metrics/ssot-sync.jsonl" && f.line === 2));
});

test("7. R1 & C1 regressions: broken loop.json without ssot emits no ssot-error; missing/relative configFile throws; example schema valid", t => {
  // R1: Without ssot key, malformed JSON or loop.json missing product must NOT emit ssot-error in trajectory alarms
  const noProd = makeLoop(t, { extraRecords: { "metrics/trajectory.jsonl": "" } });
  writeFileSync(noProd.config, JSON.stringify({ phase: "v1" }) + "\n");
  const rNoProd = runCli("trajectory.mjs", ["alarms", "--file", join(noProd.records, "metrics/trajectory.jsonl"), "--json"]);
  assert.equal(rNoProd.status, 0, rNoProd.stderr);
  assert.deepEqual(JSON.parse(rNoProd.stdout), []);

  writeFileSync(noProd.config, "{invalid-json\n");
  const rBadJson = runCli("trajectory.mjs", ["alarms", "--file", join(noProd.records, "metrics/trajectory.jsonl"), "--json"]);
  assert.equal(rBadJson.status, 0, rBadJson.stderr);
  assert.deepEqual(JSON.parse(rBadJson.stdout), []);

  // R1 positive: With ssot key, broken loop.json (missing product) DOES surface ALARM ssot-error
  writeFileSync(noProd.config, JSON.stringify({ phase: "v1", ssot: { entries: [{ id: "a", doc: "README.md", watch: ["src/**"] }] } }) + "\n");
  const rWithSsot = runCli("trajectory.mjs", ["alarms", "--file", join(noProd.records, "metrics/trajectory.jsonl"), "--json"]);
  assert.equal(rWithSsot.status, 0, rWithSsot.stderr);
  assert.ok(JSON.parse(rWithSsot.stdout).some(a => a.type === "ssot-error" && /SSOT screening failed/.test(a.message)));

  // C1: checkSsot, attestSsot, and pushCommit with ssot refuse missing or relative configFile explicitly
  const ssot = { entries: [{ id: "a", doc: "README.md", watch: ["README.md"] }] };
  const sha = git(noProd.product, "rev-parse", "HEAD");
  for (const bad of [undefined, "", "loop.json", "rel/loop.json"]) {
    assert.throws(() => checkSsot({ product: noProd.product, records: noProd.records, configFile: bad, ssot, sha }), SsotConfigError);
    assert.throws(() => attestSsot({ product: noProd.product, records: noProd.records, configFile: bad, ssot, id: "a", sha, disposition: "no-contract-change", by: "actor", reason: "r" }), SsotConfigError);
  }
  const suite = JSON.parse(readFileSync(suiteReceiptFor(noProd.product, sha, noProd.root), "utf8"));
  assert.throws(() => pushCommit({ repo: noProd.product, records: noProd.records, sha, branch: "loop/v1", suite, protectedBranches: ["main"], ssot, dry: true }), SsotConfigError);

  // Example config's ssot block must validate cleanly against validateSsotSchema
  const example = JSON.parse(readFileSync(join(scripts, "..", "assets", "self-loop.example.json"), "utf8"));
  assert.equal(validateSsotSchema(example.ssot, "assets/self-loop.example.json").entries.length, 2);
});
