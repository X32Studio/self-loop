// D-0060, design/mandatory-control-plane.md#1
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_LEAD_PATHS,
  isCleanWaveMerge,
  isExactRevertOfAttested,
  isLeadOnlyCommit,
  readProvenanceBaseline,
  verifyProvenance,
  verifyWaveGate,
} from "../lib/provenance.mjs";
import { git, repo, scripts, skill, temp } from "./helpers.mjs";

const CLAUDE = { runner: "t3:claude", model: "claude-opus-5-5", observedModel: "claude-opus-5-5", observedModels: ["claude-opus-5-5"] };
const CODEX = { runner: "t3:codex", model: "gpt-6.2-sol", observedModel: "gpt-6.2-sol", observedModels: ["gpt-6.2-sol"] };
const CLAUDE_ALT = { runner: "t3:claude", model: "claude-haiku-5-5", observedModel: "claude-haiku-5-5", observedModels: ["claude-haiku-5-5"] };
const pad = n => String(n).padStart(4, "0");

function writeFile(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commitFile(root, rel, content, msg = rel) {
  writeFile(root, rel, content);
  git(root, "add", rel);
  git(root, "commit", "-qm", msg);
  return git(root, "rev-parse", "HEAD");
}

function makeFixture({ extraFiles = {}, withHooks = false } = {}) {
  const product = repo({
    "README.md": "# Target\n",
    "VERSION": "0.0.1\n",
    "scripts/test/smoke.test.mjs": "import test from 'node:test';\ntest('ok', () => {});\n",
    ...extraFiles,
  });
  if (withHooks) {
    cpSync(scripts, join(product, "scripts"), { recursive: true, filter: f => f !== join(scripts, "test") });
    cpSync(join(skill, ".githooks"), join(product, ".githooks"), { recursive: true });
    chmodSync(join(product, ".githooks", "pre-push"), 0o755);
    chmodSync(join(product, ".githooks", "pre-commit"), 0o755);
    git(product, "add", "-A");
    git(product, "commit", "-qm", "Install hooks");
  }
  const baseline = git(product, "rev-parse", "HEAD");
  git(product, "branch", "-f", "loop/v1", baseline);
  const workDir = temp("prov-work-");
  const records = repo({
    "records.json": "{}\n",
    "decisions/D-0060.md": "# D-0060\n\nid: D-0060\nstatus: active\n",
    "plans/PL-0001.md": "# PL-0001\n\nscope: unit\nphase: v1\n",
    "plans/PL-0002.md": "# PL-0002\n\nscope: unit-two\nphase: v1\n",
    "metrics/handoffs.jsonl": "",
    "metrics/trajectory.jsonl": "",
  });
  writeFile(records, "loop.json", JSON.stringify({
    product, records, workDir, branch: "loop/v1", phase: "v1", briefs: {},
    agents: { actor: CLAUDE, critic: CODEX, judge: CODEX },
    protected: ["main"], gates: { remote: "origin", require: [] }, provenanceBaseline: baseline,
  }, null, 2) + "\n");
  git(records, "add", "-A");
  git(records, "commit", "-qm", "Init records");

  const recordHandoff = ({ round = 1, role, step, base, commit = base, plan = "PL-0001", pkg = step, files = [], agent, verdict = "CONVERGED", acceptance = "pass" }) => {
    const view = git(records, "rev-parse", "HEAD");
    const id = `R-${pad(round)}-${step}`;
    const rec = `rounds/${pad(round)}-${step}.md`;
    const own = [rec];
    writeFile(records, rec, `# ${id}\n\nphase: v1\nrole: ${role}\n`);
    if (role === "judge") {
      const sealed = `sealed/judge/${pad(round)}/${step}-1.md`;
      own.push(sealed);
      writeFile(records, sealed, `# ${id}\n\n## Task (verbatim)\n\n\`\`\`text\nJudge\n\`\`\`\n\n## Report (verbatim)\n\nVERDICT: ${verdict}\nACCEPTANCE: ${acceptance}\n`);
    }
    const prev = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8");
    const entry = {
      id, time: "2026-11-24T00:00:00Z", phase: "v1", round, step, role, attempt: 1,
      agent, view, features: ["F-0004"], briefs: [], task: "0".repeat(64),
      product: { base, commit }, exit: 0, audit: { violations: 0, denied: 0, flags: 0, unrecognized: 0, file: `evidence/${pad(round)}/${step}-1-audit.json` },
      record: rec, files: own,
      ...(plan ? { dispatch: { plan, package: pkg, files } } : {}),
    };
    writeFile(records, "metrics/handoffs.jsonl", prev + JSON.stringify(entry) + "\n");
    git(records, "add", "-A");
    git(records, "commit", "-qm", `Record ${id}`);
  };

  const openWindow = ({ horizon = 3, startRound = 1 } = {}) => {
    const r = spawnSync(process.execPath, [
      join(scripts, "window.mjs"), "open", "--records", records, "--phase", "v1",
      "--start-round", String(startRound), "--horizon", String(horizon),
      "--goal", "Refactor", "--invariant", "Green",
    ], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };

  return { product, records, baseline, recordHandoff, openWindow };
}

test("DEFAULT_LEAD_PATHS and readProvenanceBaseline resolve config and records", () => {
  assert.deepEqual([...DEFAULT_LEAD_PATHS], ["VERSION", "docs/", "AGENTS.md", "CLAUDE.md", "README.md"]);
  const { records, baseline } = makeFixture();
  assert.equal(readProvenanceBaseline({}), null);
  assert.equal(readProvenanceBaseline({ cfg: { provenanceBaseline: "not-a-sha" } }), null);
  assert.equal(readProvenanceBaseline({ records }), baseline);
  const other = "b".repeat(40);
  assert.equal(readProvenanceBaseline({ cfg: { provenanceBaseline: other }, records }), other);
  assert.equal(readProvenanceBaseline({ cfg: { provenanceBaseline: null }, records }), null);
});

test("isLeadOnlyCommit accepts lead paths, rejects code edits, merges, and git replace spoofs", () => {
  const { product, baseline } = makeFixture();
  const docsSha = commitFile(product, "docs/guide.md", "# Guide\n");
  assert.equal(isLeadOnlyCommit(product, docsSha), true);
  assert.equal(isLeadOnlyCommit(product, docsSha, ["VERSION"]), false);
  const verSha = commitFile(product, "VERSION", "0.0.2\n");
  assert.equal(isLeadOnlyCommit(product, verSha), true);
  writeFile(product, "docs/note.md", "# Note\n");
  writeFile(product, "scripts/x.mjs", "export const x = 1;\n");
  git(product, "add", "-A");
  git(product, "commit", "-qm", "mixed");
  const mixedSha = git(product, "rev-parse", "HEAD");
  assert.equal(isLeadOnlyCommit(product, mixedSha), false);

  git(product, "replace", mixedSha, docsSha);
  assert.equal(isLeadOnlyCommit(product, mixedSha), false);
  git(product, "replace", "-d", mixedSha);

  git(product, "checkout", "-q", "--detach", baseline);
  const branchA = commitFile(product, "docs/a.md", "a\n");
  git(product, "checkout", "-q", "--detach", baseline);
  const branchB = commitFile(product, "docs/b.md", "b\n");
  const mergedTree = git(product, "merge-tree", "--write-tree", branchA, branchB).split("\n")[0].trim();
  const mergeSha = git(product, "commit-tree", mergedTree, "-p", branchA, "-p", branchB, "-m", "merge docs");
  assert.equal(isLeadOnlyCommit(product, mergeSha), false);
});

test("isCleanWaveMerge validates 2-parent and 3-parent merges and rejects evil merges and unattested parents", () => {
  const { product, baseline } = makeFixture();
  git(product, "checkout", "-q", "--detach", baseline);
  const a = commitFile(product, "scripts/a.mjs", "export const a = 1;\n");
  git(product, "checkout", "-q", "--detach", baseline);
  const b = commitFile(product, "scripts/b.mjs", "export const b = 2;\n");
  git(product, "checkout", "-q", "--detach", baseline);
  const c = commitFile(product, "scripts/c.mjs", "export const c = 3;\n");

  const t2 = git(product, "merge-tree", "--write-tree", a, b).split("\n")[0].trim();
  const m2 = git(product, "commit-tree", t2, "-p", a, "-p", b, "-m", "merge 2");
  assert.equal(isCleanWaveMerge(product, m2, new Set([a, b])), true);
  assert.equal(isCleanWaveMerge(product, m2, new Set([a])), false);
  assert.equal(isCleanWaveMerge(product, a, new Set([baseline, a])), false);

  const t3 = git(product, "merge-tree", "--write-tree", m2, c).split("\n")[0].trim();
  const m3 = git(product, "commit-tree", t3, "-p", a, "-p", b, "-p", c, "-m", "merge 3");
  assert.equal(isCleanWaveMerge(product, m3, new Set([a, b, c])), true);

  git(product, "checkout", "-q", m2);
  writeFile(product, "scripts/smuggled.mjs", "export const bad = 1;\n");
  git(product, "add", "scripts/smuggled.mjs");
  const evil = git(product, "commit-tree", git(product, "write-tree"), "-p", a, "-p", b, "-m", "evil");
  git(product, "reset", "-q", "--hard", m2);
  assert.equal(isCleanWaveMerge(product, evil, new Set([a, b])), false);

  git(product, "replace", evil, m2);
  assert.equal(isCleanWaveMerge(product, evil, new Set([a, b])), false);
  git(product, "replace", "-d", evil);
});

test("isExactRevertOfAttested accepts exact tip, non-tip, and custom-message reverts and rejects impure reverts", () => {
  const { product, baseline } = makeFixture();
  const a = commitFile(product, "scripts/a.mjs", "export const a = 1;\n", "Add a");
  const b = commitFile(product, "scripts/b.mjs", "export const b = 2;\n", "Add b");
  const attested = new Set([a, b]);

  git(product, "revert", "--no-edit", a);
  const nonTip = git(product, "rev-parse", "HEAD");
  assert.equal(isExactRevertOfAttested(product, nonTip, attested), true);
  assert.equal(isExactRevertOfAttested(product, nonTip, new Set([b])), false);

  git(product, "checkout", "-q", "--detach", b);
  git(product, "revert", "--no-commit", b);
  git(product, "commit", "-qm", "undo without sha hint");
  const tipNoHint = git(product, "rev-parse", "HEAD");
  assert.equal(isExactRevertOfAttested(product, tipNoHint, attested), true);

  git(product, "checkout", "-q", "--detach", b);
  git(product, "revert", "--no-commit", a);
  writeFile(product, "scripts/extra.mjs", "export const extra = 1;\n");
  git(product, "add", "scripts/extra.mjs");
  git(product, "commit", "-qm", "impure revert");
  const impure = git(product, "rev-parse", "HEAD");
  assert.equal(isExactRevertOfAttested(product, impure, attested), false);

  git(product, "checkout", "-q", "--detach", b);
  git(product, "commit", "--allow-empty", "-qm", "noop");
  const noop = git(product, "rev-parse", "HEAD");
  assert.equal(isExactRevertOfAttested(product, noop, attested), false);
});

test("verifyProvenance handles unset baseline, invalid baseline, disconnected history, unplanned actor, and TDD pre-actor critic", () => {
  const { product, records, baseline, recordHandoff } = makeFixture();
  const noBaseline = verifyProvenance({ repo: product, records, sha: baseline, branch: "loop/v1", cfg: { provenanceBaseline: null } });
  assert.equal(noBaseline.ok, true);
  assert.equal(noBaseline.enforced, false);

  const badBaseline = verifyProvenance({ repo: product, records, sha: baseline, branch: "loop/v1", cfg: { provenanceBaseline: "bad" } });
  assert.equal(badBaseline.ok, false);

  const orphan = git(product, "commit-tree", git(product, "rev-parse", `${baseline}^{tree}`), "-m", "orphan root");
  const orphanRes = verifyProvenance({ repo: product, records, sha: orphan, branch: "loop/v1" });
  assert.equal(orphanRes.ok, false);
  assert.match(orphanRes.reasons.join("; "), /does not descend/);

  const unplanned = commitFile(product, "scripts/unplanned.mjs", "export const u = 1;\n");
  recordHandoff({ round: 1, role: "actor", step: "actor-u", base: baseline, commit: unplanned, plan: null, agent: CLAUDE });
  const unplannedRes = verifyProvenance({ repo: product, records, sha: unplanned, branch: "loop/v1" });
  assert.equal(unplannedRes.ok, false);
  assert.deepEqual(unplannedRes.unattested, [unplanned]);

  git(product, "checkout", "-q", "--detach", baseline);
  const criticSha = commitFile(product, "acceptance/tdd.test.mjs", "import test from 'node:test';\ntest('tdd', () => {});\n");
  recordHandoff({ round: 2, role: "critic", step: "critic-tdd", base: baseline, commit: criticSha, plan: "PL-0001", pkg: "critic-tdd", agent: CODEX });
  const actorSha = commitFile(product, "scripts/tdd.mjs", "export const tdd = 1;\n");
  recordHandoff({ round: 2, role: "actor", step: "actor-tdd", base: criticSha, commit: actorSha, plan: "PL-0001", pkg: "actor-tdd", agent: CLAUDE });

  const ciOk = verifyProvenance({ repo: product, records, sha: actorSha, branch: "ci/R-0002-actor-tdd" });
  assert.equal(ciOk.ok, true, ciOk.reasons.join("; "));
  const ciBadName = verifyProvenance({ repo: product, records, sha: actorSha, branch: "ci/R-9999-missing" });
  assert.equal(ciBadName.ok, false);

  recordHandoff({ round: 2, role: "judge", step: "judge", base: actorSha, commit: actorSha, plan: "PL-0001", pkg: "judge", agent: CODEX });
  const loopOk = verifyProvenance({ repo: product, records, sha: actorSha, branch: "loop/v1" });
  assert.equal(loopOk.ok, true, loopOk.reasons.join("; "));
});

test("verifyWaveGate rotates vendors cleanly across judged waves and never defers protected branches under open windows", () => {
  const { product, records, baseline, recordHandoff, openWindow } = makeFixture();
  const w1 = commitFile(product, "scripts/w1.mjs", "export const w1 = 1;\n");
  recordHandoff({ round: 1, role: "actor", step: "actor-one", base: baseline, commit: w1, plan: "PL-0001", agent: CLAUDE });
  recordHandoff({ round: 1, role: "critic", step: "critic-one", base: w1, commit: w1, plan: "PL-0001", agent: CODEX });
  recordHandoff({ round: 1, role: "judge", step: "judge-one", base: w1, commit: w1, plan: "PL-0001", agent: CODEX });

  const w2 = commitFile(product, "scripts/w2.mjs", "export const w2 = 2;\n");
  recordHandoff({ round: 2, role: "actor", step: "actor-two", base: w1, commit: w2, plan: "PL-0002", agent: CODEX });
  recordHandoff({ round: 2, role: "critic", step: "critic-two", base: w2, commit: w2, plan: "PL-0002", agent: CLAUDE });
  recordHandoff({ round: 2, role: "judge", step: "judge-two", base: w2, commit: w2, plan: "PL-0002", agent: CLAUDE_ALT });
  const rotated = verifyWaveGate({ repo: product, records, sha: w2, branch: "loop/v1" });
  assert.equal(rotated.ok, true, rotated.reasons.join("; "));

  openWindow({ horizon: 5, startRound: 3 });
  const w3 = commitFile(product, "scripts/w3.mjs", "export const w3 = 3;\n");
  recordHandoff({ round: 3, role: "actor", step: "actor-three", base: w2, commit: w3, plan: "PL-0002", agent: CLAUDE });
  const workingDeferred = verifyWaveGate({ repo: product, records, sha: w3, branch: "loop/v1" });
  assert.equal(workingDeferred.ok, true, workingDeferred.reasons.join("; "));
  assert.equal(workingDeferred.deferredByWindow, "W-0001");
  const protectedRefused = verifyWaveGate({ repo: product, records, sha: w3, branch: "main" });
  assert.equal(protectedRefused.ok, false);
});

test(".githooks/pre-push preserves stdin for both provenance and D-0004 version-gate checks", () => {
  const { product, records, baseline, recordHandoff } = makeFixture({ withHooks: true });
  const remote = temp("remote-");
  git(remote, "init", "-q", "--bare");
  git(product, "remote", "add", "origin", remote);
  git(product, "tag", "v0.0.1", baseline);
  git(product, "push", "-q", "origin", `${baseline}:refs/heads/loop/v1`, "refs/tags/v0.0.1");
  git(product, "config", "core.hooksPath", ".githooks");

  const store = temp("store-");
  writeFile(store, "products.json", JSON.stringify({ products: [{ name: "prov", records }] }) + "\n");
  const env = { ...process.env, SELF_LOOP_OWNER_STORE: store, SELF_LOOP_LOAD_DIR: temp("load-") };
  delete env.NODE_TEST_CONTEXT;

  const actorSha = commitFile(product, "scripts/attested.mjs", "export const ok = 1;\n");
  recordHandoff({ round: 1, role: "actor", step: "actor-a", base: baseline, commit: actorSha, plan: "PL-0001", agent: CLAUDE });
  recordHandoff({ round: 1, role: "critic", step: "critic-a", base: actorSha, commit: actorSha, plan: "PL-0001", agent: CODEX });
  recordHandoff({ round: 1, role: "judge", step: "judge", base: actorSha, commit: actorSha, plan: "PL-0001", agent: CODEX });

  const unbumped = spawnSync("git", ["-C", product, "push", "origin", `${actorSha}:refs/heads/loop/v1`], { encoding: "utf8", env });
  assert.notEqual(unbumped.status, 0);
  assert.match(unbumped.stderr, /VERSION 0\.0\.1 is not greater than/);

  const bumped = commitFile(product, "VERSION", "0.0.2\n");
  git(product, "tag", "v0.0.2", bumped);
  const valid = spawnSync("git", ["-C", product, "push", "origin", `${bumped}:refs/heads/loop/v1`, "refs/tags/v0.0.2"], { encoding: "utf8", env });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(git(remote, "rev-parse", "refs/heads/loop/v1"), bumped);

  git(product, "branch", "temp-del", bumped);
  git(product, "push", "-q", "--no-verify", "origin", "temp-del");
  const del = spawnSync("git", ["-C", product, "push", "origin", ":refs/heads/temp-del"], { encoding: "utf8", env });
  assert.equal(del.status, 0, del.stderr);
});
