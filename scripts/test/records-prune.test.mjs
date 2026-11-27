// F-0015, D-0016, D-0069, R-0055-judge-frame-hygiene, R-0055-judge-frame-alphax
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { MAX_AUDIT_JSON_BYTES } from "../audit-access.mjs";
import { isPrunablePath, liveEvidenceStats, parsePruneManifests, pruneAndCompactRecords } from "../lib/records-prune.mjs";
import { check, inspect } from "../records-check.mjs";
import { git, repo } from "./helpers.mjs";

const sha256 = data => createHash("sha256").update(data).digest("hex");
const put = (root, rel, content) => {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
};

test("isPrunablePath distinguishes prunable evidence/sealed logs from protected paths", () => {
  assert.equal(isPrunablePath("evidence/0001/actor-1/out/junk.txt"), true);
  assert.equal(isPrunablePath("evidence/0001/actor-1.log.gz"), true);
  assert.equal(isPrunablePath("sealed/judge/0001/judge-1.log.gz"), true);
  assert.equal(isPrunablePath("sealed/judge/0001/judge-1-log.jsonl"), true);

  for (const protectedPath of [
    "rounds/0001-actor.md",
    "decisions/D-0001.md",
    "prune/PR-0001.md",
    "evidence/0001/time-binding/TB-" + "a".repeat(64) + ".json",
    "evidence/normal-entry/state.json",
    "evidence/blueprint/ci.json",
    "sealed/judge/0001/judge-1.md",
    "sealed/critic/0001/critic-1.md",
    "sealed/judge/0001/judge-1-audit.json",
    "sealed/judge/0001/judge-1/out/report.md",
    "sealed/cases/held-out.mjs",
  ]) {
    assert.equal(isPrunablePath(protectedPath), false, protectedPath);
  }
});

test("pruneAndCompactRecords enforces P1-P6 protection, compacts >1 MiB audits in place, and passes records-check", () => {
  const sha = "a".repeat(40);
  const junkBody = "unused build output\n";
  const junkDigest = sha256(junkBody);
  const giantAuditObj = {
    id: "R-0008-actor", role: "actor", attempt: 1, exit: 0, nonce: "n-8",
    agent: { runner: "paseo", model: "gemini-2.5-flash" },
    unrecognized: 0, unparsedCalls: 0, toolEvents: 3, violations: [], denied: [], duplicateSuiteRuns: [],
    flags: [
      ...Array.from({ length: 80 }, (_, i) => ({ id: "actor", command: "z".repeat(18_000), path: `/outside/f-${i}.ts` })),
      { id: "actor", command: "cat /sealed/case.mjs", path: "/sealed/case.mjs", forbidden: true },
    ],
  };
  const giantAuditStr = `${JSON.stringify(giantAuditObj, null, 2)}\n`;
  assert.ok(Buffer.byteLength(giantAuditStr, "utf8") > MAX_AUDIT_JSON_BYTES);

  const giantSealedAudit = `${JSON.stringify({ ...giantAuditObj, id: "R-0001-judge", role: "judge" }, null, 2)}\n`;
  const bigSealedLog = Buffer.alloc(MAX_AUDIT_JSON_BYTES + 4096, 65);
  const smallSealedLog = Buffer.from("small-log");
  const tbHash = "b".repeat(64);

  const ciReceipt = JSON.stringify({ repository: "example/app", sha, ci: "success", ok: true, missing: [], conclusions: { "ci/test": "success" } });
  const trajRow = { round: 1, phase: "v1", role: "judge", area: "core", verdict: "CONVERGED", commit: sha, suite: "5/0", ci: "success", ciReceipt: "evidence/0001/ci-traj/receipt.json" };
  const bpEvent = { feature: "F-0001", status: "done", time: "2026-11-20T00:00:00Z", by: "lead", note: "done", evidence: { round: "R-0001-judge", commit: sha, ci: "evidence/0001/ci-bp/receipt.json" } };
  const winOpen = { type: "open", id: "W-0001", phase: "v1", startRound: 7, horizon: 4, goal: "hygiene", invariants: ["tests green"], openedAt: "2026-11-25T00:00:00Z", openedBy: "lead" };

  const h1Actor = {
    id: "R-0001-actor", time: "2026-11-20T00:00:00Z", phase: "v1", round: 1, step: "actor", role: "actor",
    attempt: 1, view: sha, agent: { runner: "paseo" }, product: { base: sha, commit: sha },
    audit: { violations: 0, file: "evidence/0001/actor-1-audit.json" }, record: "rounds/0001-actor.md",
    files: ["rounds/0001-actor.md", "evidence/0001/actor-1-audit.json", "evidence/0001/actor-1/out/junk.txt", "evidence/0001/actor-1/out/proposal.md"],
    designConflicts: [{ path: "design/core.md", current: sha256("# Core\n"), changed: sha, proposal: "evidence/0001/actor-1/out/proposal.md" }],
  };
  const h1Arch = {
    id: "R-0001-reviewer-architecture", time: "2026-11-20T00:01:00Z", phase: "v1", round: 1, step: "reviewer-architecture", role: "reviewer",
    attempt: 1, view: sha, agent: { runner: "paseo" }, product: { base: sha, commit: sha },
    audit: { violations: 0, file: "evidence/0001/reviewer-architecture-1-audit.json" }, record: "rounds/0001-reviewer-architecture.md",
    files: ["rounds/0001-reviewer-architecture.md", "evidence/0001/reviewer-architecture-1-audit.json", "evidence/0001/reviewer-architecture-1-arch-facts.json"],
  };
  const h1Judge = {
    id: "R-0001-judge", time: "2026-11-20T00:02:00Z", phase: "v1", round: 1, step: "judge", role: "judge",
    attempt: 1, view: sha, agent: { runner: "paseo" }, product: { base: sha, commit: sha },
    audit: { violations: 0, file: "sealed/judge/0001/judge-1-audit.json" }, record: "rounds/0001-judge.md",
    files: [
      "rounds/0001-judge.md",
      "sealed/judge/0001/judge-1.md",
      "sealed/judge/0001/judge-1-audit.json",
      "sealed/judge/0001/judge-1.log.gz",
      "sealed/judge/0001/judge-2.log.gz",
      "sealed/judge/0001/judge-1/out/comment-resolutions.json",
    ],
  };
  const h8Actor = {
    id: "R-0008-actor", time: "2026-11-26T00:00:00Z", phase: "v1", round: 8, step: "actor", role: "actor",
    attempt: 1, view: sha, agent: { runner: "paseo" }, product: { base: sha, commit: sha },
    audit: { violations: 0, file: "evidence/0008/actor-1-audit.json" }, record: "rounds/0008-actor.md",
    files: ["rounds/0008-actor.md", "evidence/0008/actor-1-audit.json"],
  };

  const files = {
    "README.md": "# records\n",
    "loop.json": '{"phase":"v1"}\n',
    "records.json": JSON.stringify({ publicImports: ["evidence/0001/public-import.txt"] }) + "\n",
    "purpose/P-0001.md": "# P-0001 Core\n",
    "blueprint/F-0001.md": "# F-0001 Feature\n\nid: F-0001\nphase: v1\nrequirements: P-0001\n",
    "design/core.md": "# Core\n",
    "decisions/D-0001.md": "# D-0001 Keep cited\n\nby: owner\nSee evidence/0001/cited.txt\n",
    "plans/PL-0001.md": "# PL-0001 Active Plan\n\n## pkg-active\nrole: actor\nhandoff: R-0002-actor-active\n",
    "rounds/0001-actor.md": "# R-0001-actor\n",
    "rounds/0001-reviewer-architecture.md": "# R-0001-reviewer-architecture\n",
    "rounds/0001-judge.md": "# R-0001-judge\n\nVERDICT: CONVERGED\n",
    "rounds/0008-actor.md": "# R-0008-actor\n",
    "metrics/handoffs.jsonl": [h1Actor, h1Arch, h1Judge, h8Actor].map(h => JSON.stringify(h)).join("\n") + "\n",
    "metrics/trajectory.jsonl": `${JSON.stringify(trajRow)}\n`,
    "metrics/blueprint.jsonl": `${JSON.stringify(bpEvent)}\n`,
    "metrics/windows.jsonl": `${JSON.stringify(winOpen)}\n`,
    "evidence/0001/ci-traj/receipt.json": ciReceipt,
    "evidence/0001/ci-bp/receipt.json": ciReceipt,
    [`evidence/0001/time-binding/TB-${tbHash}.json`]: "{}\n",
    "evidence/normal-entry/entry.json": "{}\n",
    "evidence/blueprint/base.json": "{}\n",
    "evidence/0001/reviewer-architecture-1-arch-facts.json": "{}\n",
    "evidence/0001/reviewer-architecture-1-audit.json": "{}\n",
    "evidence/0001/actor-1-audit.json": "{}\n",
    "evidence/0001/actor-1/out/junk.txt": junkBody,
    "evidence/0001/actor-1/out/proposal.md": "# Conflict proposal\n",
    "evidence/0001/cited.txt": "cited\n",
    "evidence/0001/public-import.txt": "pub\n",
    "evidence/0002/actor-active-1/out/keep.txt": "active plan round 2\n",
    "evidence/0003/uncited-old.bin": "old-prunable\n",
    "evidence/0007/window-open.txt": "open window round 7\n",
    "evidence/0008/actor-1-audit.json": giantAuditStr,
    "sealed/judge/0001/judge-1.md": "# Judge full\n",
    "sealed/critic/0001/critic-1.md": "# Critic full\n",
    "sealed/judge/0001/judge-1-audit.json": giantSealedAudit,
    "sealed/judge/0001/judge-1/out/comment-resolutions.json": "[]\n",
    "sealed/judge/0001/judge-2.log.gz": smallSealedLog.toString("utf8"),
  };
  const r = repo(files);
  put(r, "sealed/judge/0001/judge-1.log.gz", bigSealedLog);
  git(r, "add", "sealed/judge/0001/judge-1.log.gz");
  check(r, { write: true });
  git(r, "add", "INDEX.md", "BLUEPRINT.md");
  git(r, "commit", "-qm", "seed full records");

  const statsBefore = liveEvidenceStats(inspect(r));
  assert.ok(statsBefore.fileCount >= 10);
  assert.equal(statsBefore.oversizedAudits.length, 2);

  const dry = pruneAndCompactRecords(r, { retainRounds: 2, apply: false });
  assert.equal(dry.apply, false);
  assert.equal(dry.commit, null);
  assert.equal(dry.tombstonePath, "prune/PR-0001.md");
  const dryPruned = dry.prunedFiles.map(f => f.path).sort();
  assert.deepEqual(dryPruned, [
    "evidence/0001/actor-1/out/junk.txt",
    "evidence/0001/actor-1-audit.json",
    "evidence/0001/reviewer-architecture-1-audit.json",
    "evidence/0003/uncited-old.bin",
    "sealed/judge/0001/judge-1.log.gz",
  ].sort());
  assert.deepEqual(dry.compactedAudits.map(c => c.path).sort(), [
    "evidence/0008/actor-1-audit.json",
    "sealed/judge/0001/judge-1-audit.json",
  ]);
  assert.equal(existsSync(join(r, "prune/PR-0001.md")), false);

  const applied = pruneAndCompactRecords(r, { retainRounds: 2, apply: true, installHooks: true });
  assert.equal(applied.apply, true);
  assert.match(applied.commit, /^[0-9a-f]{40}$/);
  assert.equal(applied.tombstonePath, "prune/PR-0001.md");
  assert.equal(existsSync(join(r, ".githooks/pre-commit")), true);
  assert.equal(git(r, "config", "--local", "--get", "core.hooksPath"), ".githooks");

  for (const kept of [
    "evidence/0001/ci-traj/receipt.json",
    "evidence/0001/ci-bp/receipt.json",
    `evidence/0001/time-binding/TB-${tbHash}.json`,
    "evidence/normal-entry/entry.json",
    "evidence/blueprint/base.json",
    "evidence/0001/reviewer-architecture-1-arch-facts.json",
    "evidence/0001/actor-1/out/proposal.md",
    "evidence/0001/cited.txt",
    "evidence/0001/public-import.txt",
    "evidence/0002/actor-active-1/out/keep.txt",
    "evidence/0007/window-open.txt",
    "evidence/0008/actor-1-audit.json",
    "sealed/judge/0001/judge-1.md",
    "sealed/critic/0001/critic-1.md",
    "sealed/judge/0001/judge-1-audit.json",
    "sealed/judge/0001/judge-1/out/comment-resolutions.json",
    "sealed/judge/0001/judge-2.log.gz",
  ]) {
    assert.equal(existsSync(join(r, kept)), true, `must protect ${kept}`);
  }
  assert.equal(existsSync(join(r, "evidence/0001/actor-1/out/junk.txt")), false);
  assert.equal(existsSync(join(r, "sealed/judge/0001/judge-1.log.gz")), false);

  for (const compactedPath of ["evidence/0008/actor-1-audit.json", "sealed/judge/0001/judge-1-audit.json"]) {
    const raw = readFileSync(join(r, compactedPath), "utf8");
    assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_AUDIT_JSON_BYTES);
    const parsed = JSON.parse(raw);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.flags[0].forbidden, true);
  }

  const preAuditDigest = sha256(giantAuditStr);
  put(r, "decisions/D-0002.md", `# D-0002 Historical digest refs\n\nby: lead\nPruned: evidence/0001/actor-1/out/junk.txt sha256:${junkDigest}\nCompacted: evidence/0008/actor-1-audit.json sha256:${preAuditDigest}\n`);
  git(r, "add", "decisions/D-0002.md");
  check(r, { write: true });
  git(r, "add", "INDEX.md");
  git(r, "commit", "-qm", "cite historical digests");

  const checked = check(r);
  assert.deepEqual(checked.failures, []);
  assert.deepEqual(checked.screening.filter(s => s.rule === "digest"), []);

  const manifests = parsePruneManifests(["prune/PR-0001.md"], p => readFileSync(join(r, p), "utf8"));
  assert.equal(manifests.get("evidence/0001/actor-1/out/junk.txt")?.action, "pruned");
  assert.equal(manifests.get("evidence/0008/actor-1-audit.json")?.action, "compacted");

  const second = pruneAndCompactRecords(r, { retainRounds: 2, apply: true });
  assert.equal(second.tombstonePath, null);
  assert.equal(second.commit, null);
});

test("records-check refuses forged prune tombstones with non-ancestor originCommit, tampered hash, or non-prunable path", () => {
  const sha = "a".repeat(40);
  const evPath = "evidence/0001/actor-1/out/file.txt";
  const evBytes = "original\n";
  const h = {
    id: "R-0001-actor", time: "2026-11-20T00:00:00Z", phase: "v1", round: 1, step: "actor", role: "actor",
    attempt: 1, view: sha, agent: { runner: "paseo" }, product: { base: sha, commit: sha },
    audit: { violations: 0 }, record: "rounds/0001-actor.md", files: ["rounds/0001-actor.md", evPath],
  };
  const r = repo({
    "README.md": "# records\n",
    "rounds/0001-actor.md": "# R-0001-actor\n",
    [evPath]: evBytes,
    "metrics/handoffs.jsonl": `${JSON.stringify(h)}\n`,
  });
  const goodOrigin = git(r, "rev-parse", "HEAD");

  git(r, "checkout", "-q", "--orphan", "forged-branch");
  put(r, evPath, evBytes);
  git(r, "add", evPath);
  git(r, "commit", "-qm", "orphan commit");
  const orphanCommit = git(r, "rev-parse", "HEAD");
  git(r, "checkout", "-q", "main");

  git(r, "rm", "-q", evPath);
  const manifest = (path, hash, bytes, origin) => [
    "# PR-0001 Forged",
    "",
    "| Path | Action | SHA-256 | Bytes | Origin commit | New SHA-256 | New bytes | Reason |",
    "|---|---|---|---:|---|---|---:|---|",
    `| \`${path}\` | pruned | \`${hash}\` | \`${bytes}\` | \`${origin}\` | — | — | test |`,
    "",
  ].join("\n");

  put(r, "prune/PR-0001.md", manifest(evPath, sha256(evBytes), Buffer.byteLength(evBytes), orphanCommit));
  git(r, "add", "prune/PR-0001.md");
  check(r, { write: true });
  git(r, "add", "INDEX.md");
  git(r, "commit", "-qm", "forged non-ancestor");
  const nonAnc = check(r);
  assert.ok(nonAnc.failures.some(f => f.rule === "handoff" && /not an ancestor of HEAD/.test(f.detail)));

  put(r, "prune/PR-0001.md", manifest(evPath, "0".repeat(64), Buffer.byteLength(evBytes), goodOrigin));
  git(r, "add", "prune/PR-0001.md");
  git(r, "commit", "-qm", "forged hash");
  const badHash = check(r);
  assert.ok(badHash.failures.some(f => f.rule === "handoff" && /does not match/.test(f.detail)));

  put(r, "prune/PR-0001.md", manifest(evPath, sha256(evBytes), Buffer.byteLength(evBytes), goodOrigin));
  git(r, "add", "prune/PR-0001.md");
  git(r, "commit", "-qm", "valid tombstone");
  assert.deepEqual(check(r).failures, []);
});
