// D-0060, design/mandatory-control-plane.md#1
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_LEAD_PATHS,
  evaluateCertifiedWaveCoverage,
  isCleanWaveMerge,
  isExactRevertOfAttested,
  isLeadOnlyCommit,
  readProvenanceBaseline,
  verifyProvenance,
  verifyWaveGate,
} from "../lib/provenance.mjs";
import { git, repo, scripts, skill, temp } from "./helpers.mjs";

const CLAUDE = { runner: "t3:claude", model: "claude-opus-4-6", observedModel: "claude-opus-4-6", observedModels: ["claude-opus-4-6"] };
const CODEX = { runner: "t3:codex", model: "gpt-5.4", observedModel: "gpt-5.4", observedModels: ["gpt-5.4"] };
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

test("evaluateCertifiedWaveCoverage authenticates historical loop.json, fails closed on corruption/mid-round transitions, and walks lead-only tips", () => {
  const ag = m => ({ runner: "t3:antigravity", model: m, observedModel: m, observedModels: [m] });
  const liteModel = ag("gemini-2.5-flash-lite-high"), flash = ag("gemini-2.5-flash-high");
  const codexNoObs = { runner: "codex", model: "gpt-5.4", observedModel: null };

  const makeHistory = ({ corruptWave1 = null, midRoundSwitch = false } = {}) => {
    const { product, records, baseline, recordHandoff } = makeFixture();
    const w1 = commitFile(product, "scripts/w1.mjs", "export const w1 = 1;\n");
    const w2 = commitFile(product, "scripts/w2.mjs", "export const w2 = 2;\n");
    const tip = commitFile(product, "VERSION", "0.0.2\n");
    const baseLoop = JSON.parse(readFileSync(join(records, "loop.json"), "utf8"));
    const writeLoop = val => {
      const cur = { ...baseLoop };
      if (val === undefined) delete cur.judgeIndependence;
      else cur.judgeIndependence = val;
      commitFile(records, "loop.json", JSON.stringify(cur, null, 2) + "\n", `loop ${val}`);
    };
    const appendRow = (round, commit) => {
      const prev = readFileSync(join(records, "metrics/trajectory.jsonl"), "utf8");
      commitFile(records, "metrics/trajectory.jsonl", prev + JSON.stringify({ round, phase: "v1", role: "judge", area: "policy", verdict: "CONVERGED", commit, suite: "1/0", ci: "success", time: "2026-11-26T00:00:00Z" }) + "\n", `row ${round}`);
    };
    recordHandoff({ round: 1, role: "actor", step: "actor-a", base: baseline, commit: w1, plan: "PL-0001", agent: liteModel });
    const viewBefore = git(records, "rev-parse", "HEAD");
    if (corruptWave1 === "json") commitFile(records, "loop.json", "{corrupt", "corrupt loop");
    else if (corruptWave1 === "invalid-policy") writeLoop("bogus");
    else if (midRoundSwitch) writeLoop("model");
    recordHandoff({ round: 1, role: "judge", step: "judge-a", base: w1, commit: w1, plan: "PL-0001", agent: codexNoObs });
    if (midRoundSwitch) {
      const lines = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n");
      const last = JSON.parse(lines.pop());
      last.view = viewBefore;
      lines.push(JSON.stringify(last));
      commitFile(records, "metrics/handoffs.jsonl", lines.join("\n") + "\n", "set pre-switch view");
    }
    appendRow(1, w1);
    if (!midRoundSwitch) writeLoop("model");
    recordHandoff({ round: 2, role: "actor", step: "actor-b", base: w1, commit: w2, plan: "PL-0002", agent: flash });
    recordHandoff({ round: 2, role: "judge", step: "judge-b", base: w2, commit: w2, plan: "PL-0002", agent: liteModel });
    appendRow(2, w2);
    const allHandoffs = readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    const judge2 = allHandoffs.find(h => h.id === "R-0002-judge-b");
    return { product, records, w1, w2, tip, judge2 };
  };

  const ok = makeHistory();
  const covOk = evaluateCertifiedWaveCoverage({ repo: ok.product, records: ok.records, targetCommit: ok.tip, judge: ok.judge2 });
  assert.equal(covOk.ok, true, covOk.problem ?? "");
  assert.equal(covOk.judgedCommit, ok.w2);
  assert.deepEqual(covOk.priorConverged, [ok.w1]);
  assert.deepEqual(covOk.actors.map(a => a.id), ["R-0002-actor-b"]);

  for (const mode of ["json", "invalid-policy"]) {
    const bad = makeHistory({ corruptWave1: mode });
    const covBad = evaluateCertifiedWaveCoverage({ repo: bad.product, records: bad.records, targetCommit: bad.w2, judge: bad.judge2 });
    assert.equal(covBad.ok, false, `corrupt ${mode} must fail closed`);
    assert.deepEqual(covBad.priorConverged, []);
    assert.deepEqual(covBad.actors.map(a => a.id), ["R-0001-actor-a", "R-0002-actor-b"]);
  }

  const mid = makeHistory({ midRoundSwitch: true });
  const covMid = evaluateCertifiedWaveCoverage({ repo: mid.product, records: mid.records, targetCommit: mid.w2, judge: mid.judge2 });
  assert.equal(covMid.ok, false, "mid-round vendor->model transition must require both policies");
  assert.deepEqual(covMid.priorConverged, []);
});

test("effectiveJudgedCommit preserves attested leadPaths targets, strips unattested lead suffixes, ignores read-only tip handoffs, and refuses unjudged doc waves", () => {
  const ag = m => ({ runner: "t3:antigravity", model: m, observedModel: m, observedModels: [m] });
  const flash = ag("gemini-2.5-flash-high"), liteModel = ag("gemini-2.5-flash-lite-high");
  const { product, records, baseline, recordHandoff } = makeFixture();
  const baseLoop = JSON.parse(readFileSync(join(records, "loop.json"), "utf8"));
  commitFile(records, "loop.json", JSON.stringify({ ...baseLoop, judgeIndependence: "model" }, null, 2) + "\n", "enable model policy");
  const appendRow = (round, commit, tip = null) => {
    const prev = readFileSync(join(records, "metrics/trajectory.jsonl"), "utf8");
    const row = { round, phase: "v1", role: "judge", area: "docs", verdict: "CONVERGED", commit, ...(tip ? { tip } : {}), suite: "1/0", ci: "success", time: "2026-11-26T00:00:00Z" };
    commitFile(records, "metrics/trajectory.jsonl", prev + JSON.stringify(row) + "\n", `row ${round}`);
  };
  const handoffById = id => readFileSync(join(records, "metrics/handoffs.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l)).find(h => h.id === id);

  const doc1 = commitFile(product, "docs/guide.md", "# Guide v1\n", "Actor doc wave 1");
  recordHandoff({ round: 1, role: "actor", step: "actor-doc-a", base: baseline, commit: doc1, plan: "PL-0001", agent: flash });
  recordHandoff({ round: 1, role: "critic", step: "critic-doc-a", base: doc1, commit: doc1, plan: "PL-0001", agent: CODEX });
  recordHandoff({ round: 1, role: "judge", step: "judge-doc-a", base: doc1, commit: doc1, plan: "PL-0001", agent: liteModel });
  const tip1 = commitFile(product, "VERSION", "0.0.2\n", "Lead VERSION bump 1");
  appendRow(1, doc1, tip1);
  const j1 = handoffById("R-0001-judge-doc-a");

  const covDoc1 = evaluateCertifiedWaveCoverage({ repo: product, records, targetCommit: doc1, judge: j1 });
  assert.equal(covDoc1.ok, true, covDoc1.problem ?? "");
  assert.equal(covDoc1.judgedCommit, doc1);
  assert.deepEqual(covDoc1.actors.map(a => a.id), ["R-0001-actor-doc-a"]);
  assert.equal(verifyProvenance({ repo: product, records, sha: doc1, branch: "main" }).ok, true);
  assert.equal(verifyWaveGate({ repo: product, records, sha: doc1, branch: "main" }).ok, true);

  recordHandoff({ round: 1, role: "reviewer", step: "reviewer-tip", base: tip1, commit: tip1, plan: null, agent: CLAUDE });
  recordHandoff({ round: 1, role: "critic", step: "critic-tip-ro", base: tip1, commit: tip1, plan: "PL-0001", agent: CODEX });
  const covTip1 = evaluateCertifiedWaveCoverage({ repo: product, records, targetCommit: tip1, judge: j1 });
  assert.equal(covTip1.ok, true, covTip1.problem ?? "");
  assert.equal(covTip1.judgedCommit, doc1);
  assert.equal(verifyProvenance({ repo: product, records, sha: tip1, branch: "main" }).ok, true);
  assert.equal(verifyWaveGate({ repo: product, records, sha: tip1, branch: "main" }).ok, true);

  const leadDoc = commitFile(product, "docs/lead-note.md", "# Lead note\n", "Unattested lead doc");
  const covLeadDoc = evaluateCertifiedWaveCoverage({ repo: product, records, targetCommit: leadDoc, judge: j1 });
  assert.equal(covLeadDoc.ok, true, covLeadDoc.problem ?? "");
  assert.equal(covLeadDoc.judgedCommit, doc1);
  assert.equal(verifyProvenance({ repo: product, records, sha: leadDoc, branch: "main" }).ok, true);
  assert.equal(verifyWaveGate({ repo: product, records, sha: leadDoc, branch: "main" }).ok, true);

  const criticDoc = commitFile(product, "docs/spec.md", "# Spec\n", "Commit-producing critic doc");
  recordHandoff({ round: 2, role: "critic", step: "critic-spec", base: leadDoc, commit: criticDoc, plan: "PL-0002", agent: CODEX });
  const covCriticDoc = evaluateCertifiedWaveCoverage({ repo: product, records, targetCommit: criticDoc, evaluateJudge: false });
  assert.equal(covCriticDoc.judgedCommit, criticDoc);
  assert.equal(verifyProvenance({ repo: product, records, sha: criticDoc, branch: "main" }).ok, false);
  assert.equal(verifyWaveGate({ repo: product, records, sha: criticDoc, branch: "main" }).ok, false);

  const doc2 = commitFile(product, "docs/guide.md", "# Guide v2\n", "Actor doc wave 2");
  recordHandoff({ round: 2, role: "actor", step: "actor-doc-b", base: criticDoc, commit: doc2, plan: "PL-0002", agent: liteModel });
  const tip2 = commitFile(product, "VERSION", "0.0.3\n", "Lead VERSION bump 2");
  const covDoc2Unjudged = evaluateCertifiedWaveCoverage({ repo: product, records, targetCommit: tip2, evaluateJudge: false });
  assert.equal(covDoc2Unjudged.judgedCommit, doc2);
  assert.deepEqual(covDoc2Unjudged.priorConverged, [doc1]);
  assert.deepEqual(covDoc2Unjudged.actors.map(a => a.id), ["R-0002-actor-doc-b"]);
  assert.equal(verifyProvenance({ repo: product, records, sha: doc2, branch: "main" }).ok, false);
  assert.equal(verifyWaveGate({ repo: product, records, sha: doc2, branch: "main" }).ok, false);
  assert.equal(verifyProvenance({ repo: product, records, sha: tip2, branch: "main" }).ok, false);
  assert.equal(verifyWaveGate({ repo: product, records, sha: tip2, branch: "main" }).ok, false);

  recordHandoff({ round: 2, role: "judge", step: "judge-doc-b", base: doc2, commit: doc2, plan: "PL-0002", agent: flash });
  appendRow(2, doc2, tip2);
  const j2 = handoffById("R-0002-judge-doc-b");
  const covDoc2 = evaluateCertifiedWaveCoverage({ repo: product, records, targetCommit: tip2, judge: j2 });
  assert.equal(covDoc2.ok, true, covDoc2.problem ?? "");
  assert.equal(covDoc2.judgedCommit, doc2);
  assert.deepEqual(covDoc2.priorConverged, [doc1]);
  assert.deepEqual(covDoc2.actors.map(a => a.id), ["R-0002-actor-doc-b"]);
  assert.equal(verifyProvenance({ repo: product, records, sha: tip2, branch: "main" }).ok, true);
  assert.equal(verifyWaveGate({ repo: product, records, sha: tip2, branch: "main" }).ok, true);
});

test("provenance.mjs and window.mjs form a strict acyclic DAG via window-state.mjs", () => {
  const importsOf = rel => {
    const src = readFileSync(join(scripts, rel), "utf8");
    return [...src.matchAll(/(?:import|export)\s+(?:[^;{}'"\n]*|\{[^}]*\})\s+from\s+["'](\.[^"']+)["']/gm)].map(m => m[1]);
  };
  const stateImports = importsOf("lib/window-state.mjs");
  const provImports = importsOf("lib/provenance.mjs");
  const winImports = importsOf("lib/window.mjs");
  assert.deepEqual(stateImports, []);
  assert.ok(provImports.includes("./window-state.mjs"));
  assert.ok(!provImports.includes("./window.mjs"));
  assert.ok(winImports.includes("./window-state.mjs"));
  assert.ok(winImports.includes("./provenance.mjs"));

  const visited = new Set(), queue = ["lib/provenance.mjs"];
  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const spec of importsOf(cur)) {
      const resolved = join(dirname(cur), spec).replaceAll("\\", "/");
      if (!resolved.startsWith("..")) queue.push(resolved);
    }
  }
  assert.ok(!visited.has("lib/window.mjs"), "provenance.mjs must not reach window.mjs directly or transitively");
});

test("D-0064 T10: verifyProvenance and verifyWaveGate accept independent no-dispute critic without judge, retire critic-certified prior waves, and fail closed on violations", () => {
  const ag = (m, session = null) => ({ runner: "t3:antigravity", model: m, observedModel: m, observedModels: [m], ...(session ? { session } : {}) });
  const flash = ag("gemini-2.5-flash", "sess-flash");
  const proModel = ag("gemini-2.5-pro", "sess-pro");

  const setup = ({ policy = "model" } = {}) => {
    const fx = makeFixture();
    const baseLoop = JSON.parse(readFileSync(join(fx.records, "loop.json"), "utf8"));
    commitFile(fx.records, "loop.json", JSON.stringify({ ...baseLoop, judgeIndependence: policy }, null, 2) + "\n", `policy ${policy}`);
    const recordCritic = ({ round, step, base, commit = base, plan = "PL-0001", agent, report, sealed = true }) => {
      const view = git(fx.records, "rev-parse", "HEAD");
      const id = `R-${pad(round)}-${step}`;
      const rec = `rounds/${pad(round)}-${step}.md`;
      const sealedPath = `sealed/critic/${pad(round)}/${step}-1.md`;
      const body = `# ${id}\n\n## Task (verbatim)\n\n\`\`\`text\nCritic task\n\`\`\`\n\n## Report (verbatim)\n\n${report}\n`;
      const own = sealed ? [rec, sealedPath] : [rec];
      writeFile(fx.records, rec, sealed ? `# ${id}\n\nphase: v1\nrole: critic\n` : body);
      if (sealed) writeFile(fx.records, sealedPath, body);
      const prev = readFileSync(join(fx.records, "metrics/handoffs.jsonl"), "utf8");
      const entry = {
        id, time: "2026-11-27T00:00:00Z", phase: "v1", round, step, role: "critic", attempt: 1,
        agent, view, features: ["F-0009"], briefs: [], task: "0".repeat(64),
        product: { base, commit }, exit: 0, audit: { violations: 0, denied: 0, flags: 0, unrecognized: 0, file: `evidence/${pad(round)}/${step}-1-audit.json` },
        record: rec, files: own, dispatch: { plan, package: step, files: [] },
      };
      writeFile(fx.records, "metrics/handoffs.jsonl", prev + JSON.stringify(entry) + "\n");
      git(fx.records, "add", "-A");
      git(fx.records, "commit", "-qm", `Record ${id}`);
    };
    return { ...fx, recordCritic };
  };

  const ok = setup({ policy: "model" });
  const w1 = commitFile(ok.product, "scripts/w1.mjs", "export const w1 = 1;\n");
  ok.recordHandoff({ round: 1, role: "actor", step: "actor-a", base: ok.baseline, commit: w1, plan: "PL-0001", agent: flash });
  ok.recordCritic({ round: 1, step: "critic-a", base: w1, commit: w1, plan: "PL-0001", agent: proModel, report: "VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: -" });
  assert.equal(verifyProvenance({ repo: ok.product, records: ok.records, sha: w1, branch: "main" }).ok, true);
  assert.equal(verifyWaveGate({ repo: ok.product, records: ok.records, sha: w1, branch: "loop/v1" }).ok, true);

  const tip1 = commitFile(ok.product, "VERSION", "0.0.2\n");
  assert.equal(verifyProvenance({ repo: ok.product, records: ok.records, sha: tip1, branch: "main" }).ok, true);

  const w2 = commitFile(ok.product, "scripts/w2.mjs", "export const w2 = 2;\n");
  ok.recordHandoff({ round: 2, role: "actor", step: "actor-b", base: tip1, commit: w2, plan: "PL-0002", agent: proModel });
  const w2Test = commitFile(ok.product, "acceptance/w2.test.mjs", "import test from 'node:test';\ntest('w2', () => {});\n");
  ok.recordCritic({ round: 2, step: "critic-b", base: w2, commit: w2Test, plan: "PL-0002", agent: flash, report: "VERDICT: CONVERGED\nACCEPTANCE: pass\nDISPUTES: none", sealed: false });
  const cov2 = evaluateCertifiedWaveCoverage({ repo: ok.product, records: ok.records, targetCommit: w2Test, evaluateJudge: false });
  assert.deepEqual(cov2.priorConverged, [w1]);
  assert.deepEqual(cov2.actors.map(a => a.id), ["R-0002-actor-b"]);
  assert.equal(verifyProvenance({ repo: ok.product, records: ok.records, sha: w2Test, branch: "main" }).ok, true);
  assert.equal(verifyWaveGate({ repo: ok.product, records: ok.records, sha: w2Test, branch: "main" }).ok, true);

  const staleActor = commitFile(ok.product, "scripts/w3.mjs", "export const w3 = 3;\n");
  ok.recordHandoff({ round: 3, role: "actor", step: "actor-c", base: w2Test, commit: staleActor, plan: "PL-0002", agent: flash });
  assert.equal(verifyProvenance({ repo: ok.product, records: ok.records, sha: staleActor, branch: "main" }).ok, false);

  for (const [label, policy, criticAgent, report, traj] of [
    ["same-model", "model", ag("gemini-2.5-flash", "sess-other"), "VERDICT: PASS\nACCEPTANCE: pass", null],
    ["same-vendor", "vendor", proModel, "VERDICT: PASS\nACCEPTANCE: pass", null],
    ["shared-session", "model", ag("gemini-2.5-pro", "sess-flash"), "VERDICT: PASS\nACCEPTANCE: pass", null],
    ["disputed", "model", proModel, "VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: actor challenges case", null],
    ["opened", "model", proModel, "VERDICT: PASS\nACCEPTANCE: pass\nOPENED: gate:R1-1", null],
    ["continue", "model", proModel, "VERDICT: CONTINUE\nACCEPTANCE: pass", null],
    ["fail-acceptance", "model", proModel, "VERDICT: PASS\nACCEPTANCE: fail", null],
    ["narrative-only", "model", proModel, "No issues found.", null],
    ["trajectory-contradicted", "model", proModel, "VERDICT: PASS\nACCEPTANCE: pass", "CONTINUE"],
  ]) {
    const fx = setup({ policy });
    const a1 = commitFile(fx.product, "scripts/x.mjs", "export const x = 1;\n");
    fx.recordHandoff({ round: 1, role: "actor", step: "actor-x", base: fx.baseline, commit: a1, plan: "PL-0001", agent: flash });
    fx.recordCritic({ round: 1, step: "critic-x", base: a1, commit: a1, plan: "PL-0001", agent: criticAgent, report });
    if (traj) {
      commitFile(fx.records, "metrics/trajectory.jsonl", JSON.stringify({ round: 1, phase: "v1", role: "judge", verdict: traj, commit: a1, suite: "1/0" }) + "\n", "contradict");
    }
    const res = verifyProvenance({ repo: fx.product, records: fx.records, sha: a1, branch: "main" });
    assert.equal(res.ok, false, `${label} must be refused`);
  }
});

test("D-0064 T5: lead-patch commits are attested in provenance but still require Critic/Judge convergence before protected push", () => {
  const fx = makeFixture();
  git(fx.product, "checkout", "-q", "loop/v1");
  writeFile(fx.product, "scripts/fix.mjs", "export const fixed = true;\n");

  const runPatch = spawnSync(process.execPath, [
    join(scripts, "self-loop.mjs"), "patch", "--records", fx.records,
    "--reason", "add tiny helper", "--verify", "node -e 'process.exit(0)'", "--json",
  ], { encoding: "utf8" });
  assert.equal(runPatch.status, 0, runPatch.stderr);
  const patched = JSON.parse(runPatch.stdout);
  const patchSha = patched.handoff.product.commit;

  const baseCheck = verifyProvenance({ repo: fx.product, records: fx.records, sha: patchSha, mode: "base" });
  assert.equal(baseCheck.ok, true, baseCheck.reasons.join("; "));
  assert.deepEqual(baseCheck.unattested, []);

  const beforeConv = verifyProvenance({ repo: fx.product, records: fx.records, sha: patchSha, branch: "main" });
  assert.equal(beforeConv.ok, false);
  assert.deepEqual(beforeConv.unattested, []);

  fx.recordHandoff({ round: 1, role: "critic", step: "critic-lp", base: patchSha, commit: patchSha, plan: "PL-0001", agent: CODEX });
  fx.recordHandoff({ round: 1, role: "judge", step: "judge-lp", base: patchSha, commit: patchSha, plan: "PL-0001", agent: CODEX });
  const afterConv = verifyProvenance({ repo: fx.product, records: fx.records, sha: patchSha, branch: "main" });
  assert.equal(afterConv.ok, true, afterConv.reasons.join("; "));

  const prev = readFileSync(join(fx.records, "metrics/handoffs.jsonl"), "utf8");
  const badSha = commitFile(fx.product, "scripts/bad.mjs", "export const bad = 1;\n");
  const badEntry = {
    id: "LP-0099", time: "2026-11-27T00:00:00Z", phase: "v1", role: "lead-patch",
    product: { base: patchSha, commit: badSha }, files: ["scripts/bad.mjs"],
    reason: "tampered", verify: { command: "true", exit: 1 }, audit: { violations: 0 },
  };
  commitFile(fx.records, "metrics/handoffs.jsonl", prev + JSON.stringify(badEntry) + "\n", "tampered lead-patch");
  const badRes = verifyProvenance({ repo: fx.product, records: fx.records, sha: badSha, mode: "base" });
  assert.equal(badRes.ok, false);
});
