// F-0015, P-0014, P-0015, D-0016, D-0064, D-0069, R-0055-judge-frame-hygiene
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  archBaselineFacts,
  lastOuterBaselineSha,
  refuseExhaustedWindow,
  refuseOuterLoopOverdue,
  refuseUndiagnosed,
  refuseUndistilledOwnerWords,
  viewHandoffs,
} from "../lib/call-gates.mjs";
import { cleanWorkDir, collectCleanOutFiles, reclaimWorkspacePayloads } from "../lib/work-hygiene.mjs";
import { git, scripts, setup, temp } from "./helpers.mjs";

const put = (root, rel, content = "ok\n") => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return full;
};

test("collectCleanOutFiles excludes PG clusters, caches, build/source/binary junk while preserving keep.txt and bare base/work/target", () => {
  const outDir = temp("work-hygiene-out-");
  put(outDir, "report.md", "# Report\n");
  put(outDir, "public.md", "# Public\n");
  put(outDir, "decisions.json", "[]\n");
  put(outDir, "comment-resolutions.json", "[]\n");
  put(outDir, "blueprint/F-0015.md", "# F-0015\n");
  put(outDir, "design/hygiene.md", "# Hygiene\n");
  put(outDir, "evidence.json", '{"ok":true}\n');
  put(outDir, "base/notes.md", "keep bare base dir\n");
  put(outDir, "work/summary.txt", "keep bare work dir\n");
  put(outDir, "target/metrics.json", '{"ms":12}\n');
  put(outDir, "nested-repo/.git/config", "[core]\n");
  put(outDir, "nested-repo/keep.txt", "kept\n");
  put(outDir, "gitfile-dir/.git", "gitdir: /home/alice/repo/.git\n");
  put(outDir, "gitfile-dir/sibling.txt", "kept sibling\n");

  put(outDir, "pgdata/PG_VERSION", "16\n");
  put(outDir, "pgdata/base/16384/1234", "pg-table");
  put(outDir, "pgcluster/pg_wal/000000010000000000000001", "wal");
  put(outDir, "pgcluster/data.txt", "inside pg cluster");
  put(outDir, "pg_wal/000000010000000000000002", "wal");
  put(outDir, "node-compile-cache/entry.bin", "cache");
  put(outDir, ".cache/blob.txt", "cache");
  put(outDir, "my_cache_dir/a.txt", "cache");
  put(outDir, "tmp/scratch.txt", "tmp");
  put(outDir, "node_modules/pkg/index.txt", "nm");
  put(outDir, "bare-repo/HEAD", "ref: refs/heads/main\n");
  mkdirSync(join(outDir, "bare-repo", "objects"), { recursive: true });
  mkdirSync(join(outDir, "bare-repo", "refs"), { recursive: true });
  put(outDir, "bare-repo/description", "bare");
  put(outDir, "db/app.sqlite", "sql");
  put(outDir, "db/app.sqlite-wal", "wal");
  put(outDir, "db/app.db-shm", "shm");
  put(outDir, "db/00000001000000000000000F", "wal24");
  put(outDir, "headers/foo.h", "int x;\n");
  put(outDir, "src/dump.ts", "export const x = 1;\n");
  put(outDir, "src/dump.py", "x = 1\n");
  put(outDir, ".DS_Store", "mac");
  put(outDir, "LICENSE.md", "MIT");
  put(outDir, "archive.tar", "tar");
  put(outDir, "artifact.wasm", "wasm");
  put(outDir, " leading-space.txt", "bad");
  put(outDir, 'quote"name.txt', "bad");

  const res = collectCleanOutFiles(outDir, { role: "actor" });
  const names = res.included.map(([p]) => p);
  assert.deepEqual(names, [
    "blueprint/F-0015.md",
    "comment-resolutions.json",
    "decisions.json",
    "design/hygiene.md",
    "public.md",
    "report.md",
    "base/notes.md",
    "evidence.json",
    "gitfile-dir/sibling.txt",
    "nested-repo/keep.txt",
    "target/metrics.json",
    "work/summary.txt",
  ]);
  assert.equal(res.truncated, false);
  assert.equal(res.excludedCount, res.excludedPaths.length);
  assert.ok(res.excludedPaths.includes("pgdata/"));
  assert.ok(res.excludedPaths.includes("pgcluster/"));
  assert.ok(res.excludedPaths.includes("pg_wal/"));
  assert.ok(res.excludedPaths.includes("node-compile-cache/"));
  assert.ok(res.excludedPaths.includes("bare-repo/"));
  assert.ok(res.excludedPaths.includes("nested-repo/.git/"));
  assert.ok(res.excludedPaths.includes("gitfile-dir/.git"));
  assert.ok(res.excludedPaths.includes("db/00000001000000000000000F"));
  assert.ok(res.excludedPaths.includes("headers/foo.h"));
  assert.ok(res.excludedPaths.includes(" leading-space.txt"));
  assert.ok(res.excludedPaths.includes('quote"name.txt'));
});

test("collectCleanOutFiles prioritizes canonical outputs and enforces single-file, count, and total-byte caps", () => {
  const outDir = temp("work-hygiene-caps-");
  put(outDir, "report.md", "R".repeat(400));
  put(outDir, "public.md", "P".repeat(200));
  put(outDir, "a-huge.txt", "X".repeat(300));
  put(outDir, "b-small.txt", "B".repeat(100));
  put(outDir, "c-small.txt", "C".repeat(100));
  put(outDir, "d-small.txt", "D".repeat(100));

  const res = collectCleanOutFiles(outDir, { role: "judge", maxFiles: 4, maxSingleBytes: 250, maxTotalBytes: 750 });
  assert.deepEqual(res.included.map(([p]) => p), ["public.md", "report.md", "b-small.txt"]);
  assert.equal(res.truncated, true);
  assert.ok(res.excludedPaths.includes("a-huge.txt"));
  assert.ok(res.excludedPaths.includes("c-small.txt"));
  assert.ok(res.excludedPaths.includes("d-small.txt"));
});

test("reclaimWorkspacePayloads deletes heavy children including read-only files while strictly keeping call.json", () => {
  const ws = temp("work-hygiene-reclaim-");
  put(ws, "call.json", '{"version":2,"recorded":true}\n');
  put(ws, "records/INDEX.md", "# Index\n");
  put(ws, "purpose/P-0001.md", "# P-0001\n");
  put(ws, "out/report.md", "# Report\n");
  put(ws, "wt/file.txt", "wt payload\n");
  put(ws, "suite.log.gz", "gz");
  const receipt = put(ws, "suite-receipt.json", '{"green":true}\n');
  chmodSync(receipt, 0o444);
  const arch = put(ws, "arch-facts.json", '{"files":1}\n');
  chmodSync(arch, 0o444);
  const ssot = put(ws, "ssot-status.md", "# SSOT\n");
  chmodSync(ssot, 0o444);
  put(ws, "brief.md", "brief\n");
  put(ws, "brief-shared.md", "shared\n");
  put(ws, "task.md", "task\n");
  put(ws, "t3-prompt.md", "prompt\n");

  const res = reclaimWorkspacePayloads(ws);
  assert.equal(res.keptManifest, true);
  assert.ok(res.reclaimedBytes > 50);
  assert.equal(existsSync(join(ws, "call.json")), true);
  for (const child of [
    "records", "purpose", "out", "wt", "suite.log.gz", "suite-receipt.json",
    "arch-facts.json", "ssot-status.md", "brief.md", "brief-shared.md", "task.md", "t3-prompt.md",
  ]) {
    assert.equal(existsSync(join(ws, child)), false, `${child} should be removed`);
  }
});

test("cleanWorkDir identifies terminal, stale, and orphaned workspaces and removes matching .prepared sidecars on apply", () => {
  const workDir = temp("work-hygiene-clean-");
  put(workDir, "tasks/t1.md", "keep task\n");
  put(workDir, "0001-actor-rec/call.json", JSON.stringify({ id: "R-0001-actor", round: 1, recorded: true }));
  put(workDir, "0002-actor-can/call.json", JSON.stringify({ id: "R-0002-actor", round: 2, cancelled: true }));
  put(workDir, "0003-actor-id/call.json", JSON.stringify({ id: "R-0003-actor", round: 3 }));
  put(workDir, "0004-actor-old/call.json", JSON.stringify({ id: "R-0004-actor", round: 4, pid: 2 ** 22 + 1 }));
  put(workDir, "0004-actor-livepid/call.json", JSON.stringify({ id: "R-0004-actor-live", round: 4, pid: process.pid }));
  put(workDir, "0015-actor-active/call.json", JSON.stringify({ id: "R-0015-actor", round: 15 }));
  put(workDir, "orphan-dir/notes.txt", "no call.json\n");

  put(workDir, ".prepared/0001-actor-rec.json", '{"manifest":"a"}\n');
  put(workDir, ".prepared/0001-actor-rec.json.session", "sess-1\n");
  put(workDir, ".prepared/0002-actor-can.session", "sess-2\n");
  put(workDir, ".prepared/0015-actor-active.json", '{"manifest":"keep"}\n');

  const dry = cleanWorkDir(workDir, { maxRound: 15, retainRounds: 10, recordedIds: new Set(["R-0003-actor"]), apply: false });
  assert.equal(dry.removed.length, 0);
  assert.equal(dry.bytesFreed, 0);
  assert.equal(dry.candidates.length, 5);
  assert.equal(existsSync(join(workDir, "0001-actor-rec")), true);

  const applied = cleanWorkDir(workDir, { maxRound: 15, retainRounds: 10, recordedIds: new Set(["R-0003-actor"]), apply: true });
  assert.equal(applied.removed.length, 5);
  assert.ok(applied.bytesFreed > 0);
  assert.equal(existsSync(join(workDir, "0001-actor-rec")), false);
  assert.equal(existsSync(join(workDir, ".prepared/0001-actor-rec.json")), false);
  assert.equal(existsSync(join(workDir, ".prepared/0001-actor-rec.json.session")), false);
  assert.equal(existsSync(join(workDir, ".prepared/0002-actor-can.session")), false);
  assert.equal(existsSync(join(workDir, "orphan-dir")), false);
  assert.equal(existsSync(join(workDir, "0015-actor-active")), true);
  assert.equal(existsSync(join(workDir, ".prepared/0015-actor-active.json")), true);
  assert.equal(existsSync(join(workDir, "0004-actor-livepid")), true);
  assert.equal(existsSync(join(workDir, "tasks/t1.md")), true);
});

test("call-gates.mjs is acyclic (zero imports from ../call.mjs) and enforces pre-call gates cleanly", async () => {
  const src = readFileSync(join(scripts, "lib", "call-gates.mjs"), "utf8");
  assert.doesNotMatch(src, /from\s+["']\.\.\/call\.mjs["']/);

  const s = await setup();
  const view = git(s.records, "rev-parse", "HEAD");
  const viewPaths = new Set(git(s.records, "ls-tree", "-r", "--name-only", view).split("\n").filter(Boolean));
  assert.ok(Array.isArray(viewHandoffs(s.cfg, view, viewPaths)));
  assert.equal(lastOuterBaselineSha(s.cfg, view, viewPaths), null);
  assert.equal(archBaselineFacts(s.cfg, view, viewPaths, null, null), null);
  assert.doesNotThrow(() => refuseUndiagnosed(s.cfg, view, 1));
  assert.equal(refuseExhaustedWindow(s.cfg, view, viewPaths, 1).actorBlocked, false);
  assert.doesNotThrow(() => refuseOuterLoopOverdue(s.cfg, view, viewPaths, git(s.product, "rev-parse", "HEAD"), 1, null, null));
  assert.doesNotThrow(() => refuseUndistilledOwnerWords(s.cfg, view, 1));

  put(s.records, "owner/words.jsonl", `${JSON.stringify({ id: "W-1234567890", time: "2026-11-27T00:00:00Z", text: "Please build the new hygiene gate for records." })}\n`);
  git(s.records, "add", "owner/words.jsonl");
  git(s.records, "commit", "-qm", "open owner word");
  const view2 = git(s.records, "rev-parse", "HEAD");
  class CustomStop extends Error { constructor(code, message) { super(message); this.code = code; } }
  assert.throws(
    () => refuseUndistilledOwnerWords(s.cfg, view2, 2, { Stop: CustomStop, EXIT: { records: 7 } }),
    err => err instanceof CustomStop && err.code === 7 && /un-distilled substantive owner word/.test(err.message),
  );
});
