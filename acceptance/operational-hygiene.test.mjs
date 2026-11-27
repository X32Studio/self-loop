// F-0015, P-0014, P-0015, I-0005, D-0016, D-0069
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  auditAccess,
  MAX_AUDIT_JSON_BYTES,
  MAX_COMMAND_PREVIEW_CHARS,
  MAX_ORDINARY_FLAGS,
  MAX_PATHS_PER_COMMAND,
  serializeBoundedAudit,
} from "../scripts/audit-access.mjs";
import { EXIT, preparedIn } from "../scripts/call.mjs";
import { collectArchFacts } from "../scripts/lib/arch-facts.mjs";
import { commentResolutions } from "../scripts/lib/comments.mjs";
import { pendingOwnerPrompts } from "../scripts/lib/owner-words.mjs";
import { reconcilePlans } from "../scripts/lib/plan.mjs";
import { hostLoad } from "../scripts/lib/registry.mjs";
import { pruneSuiteStore, suiteGreen, suiteStore } from "../scripts/suite-green.mjs";
import { BRIEFS, git, isolatedEnv, loopProduct, ownerStore, repo, ROOMY, roomyStore, scripts, selfLoop, setup, temp } from "../scripts/test/helpers.mjs";

const put = (root, rel, data) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  return abs;
};

const bashTool = command => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
const readTool = file_path => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path } }] } });
const runCli = (script, args, opts = {}) => spawnSync(process.execPath, [join(scripts, script), ...args], { encoding: "utf8", ...opts });

test("Surface 1 (flow: 34KB x 1,032 outside probes + trailing sealed read; loss: disclosure or OOM bloat): bounded prioritized audit", () => {
  const sealed = "/loop/sealed";
  const hugePath = `/tmp/${"a".repeat(34_000)}/probe.log`;
  const multiPaths = Array.from({ length: 30 }, (_, i) => `/tmp/multi-${i}/file-${"b".repeat(80)}.txt`).join(" ");
  const events = [
    { id: "actor", event: bashTool(`cat ${hugePath} ${sealed}/case-07.mjs`) },
    { id: "actor", event: bashTool(`cat ${multiPaths} ${sealed}/case-08.mjs`) },
    ...Array.from({ length: 1032 }, (_, i) => ({
      id: "actor",
      event: bashTool(`ls /tmp/noise-${String(i).padStart(4, "0")}/entry-${"c".repeat(200)}.txt`),
    })),
    { id: "actor", event: bashTool(`cat ${sealed}/case-09.mjs`) },
    { id: "actor", event: readTool(`${sealed}/case-10.mjs`) },
  ];
  const audit = auditAccess(["/ws", "/ws/wt"], events, { tools: null, forbidden: [sealed], cwd: "/ws/wt" });
  assert.deepEqual(audit.violations.map(v => v.path), [`${sealed}/case-10.mjs`]);
  const forbiddenPaths = audit.flags.filter(f => f.forbidden === true).map(f => f.path);
  for (const target of [`${sealed}/case-07.mjs`, `${sealed}/case-08.mjs`, `${sealed}/case-09.mjs`]) {
    assert.ok(forbiddenPaths.includes(target), target);
  }
  for (const flag of audit.flags) {
    if (flag.command !== undefined) assert.ok(flag.command.length <= MAX_COMMAND_PREVIEW_CHARS + 25);
    assert.equal(flag.omitted, undefined);
    assert.ok(!String(flag.path ?? "").includes("omitted"));
  }
  const ordinaryFlags = audit.flags.filter(f => f.forbidden !== true && !String(f.path ?? "").startsWith("("));
  assert.ok(ordinaryFlags.length <= MAX_ORDINARY_FLAGS);
  const multiOrdinary = audit.flags.filter(f => String(f.path ?? "").startsWith("/tmp/multi-"));
  assert.ok(multiOrdinary.length <= MAX_PATHS_PER_COMMAND);
  assert.ok(Number.isInteger(audit.omittedFlags) && audit.omittedFlags > 0);
  const full = { id: "R-0055-actor", role: "actor", attempt: 1, exit: 0, nonce: "deadbeef01234567", agent: { runner: "codex" }, excludedOutCount: 8, ...audit };
  const json = serializeBoundedAudit(full);
  assert.ok(Buffer.byteLength(json, "utf8") <= MAX_AUDIT_JSON_BYTES);
  const parsed = JSON.parse(json);
  assert.equal(parsed.id, "R-0055-actor");
  assert.equal(parsed.role, "actor");
  assert.equal(parsed.attempt, 1);
  assert.equal(parsed.exit, 0);
  assert.equal(parsed.nonce, "deadbeef01234567");
  assert.deepEqual(parsed.agent, { runner: "codex" });
  assert.equal(parsed.excludedOutCount, 8);
  assert.ok(Number.isInteger(parsed.omittedFlags) && parsed.omittedFlags > 0);
  for (const target of [`${sealed}/case-07.mjs`, `${sealed}/case-08.mjs`, `${sealed}/case-09.mjs`]) {
    assert.ok(parsed.flags.some(f => f.forbidden === true && f.path === target), target);
  }
});

test("Surface 2 (flow: DB/cache/header/js/>2MiB/nested-.git out/ junk, duplicate record, migration call.json; loss: data bloat or stuck)", async t => {
  const s = await setup({}, {
    agents: {
      actor: { runner: "paseo", provider: "pi", model: "openrouter/gemini-2.5-pro-exp" },
      critic: { runner: "codex" },
      judge: { runner: "codex" },
      reviewer: { runner: "claude" },
    },
    judgeIndependence: "session",
  });
  const loadDir = temp("oh-s2-load-");
  const env = isolatedEnv({ SELF_LOOP_TEST: "1", SELF_LOOP_LOAD_DIR: loadDir, SELF_LOOP_OWNER_STORE: roomyStore() });
  const cfgPath = join(s.records, "loop.json");
  writeFileSync(cfgPath, JSON.stringify({
    product: s.product, branch: s.cfg.branch, records: ".", workDir: s.cfg.workDir, phase: s.cfg.phase, briefs: BRIEFS,
    sealed: s.cfg.sealed, purpose: s.cfg.purpose, owns: s.cfg.owns, protected: s.cfg.protected, agents: s.cfg.agents,
    commitPrefix: s.cfg.commitPrefix, judgeIndependence: "session",
  }, null, 2) + "\n");
  const taskFile = put(s.dir, "actor-task.md", "features: F-0001\nShip clean artifact boundaries.\n");
  const prep = runCli("call.mjs", [cfgPath, "actor", "--round", "1", "--plan", "PL-0001", "--package", "actor", "--task", taskFile, "--prepare"], { env });
  assert.equal(prep.status, 0, prep.stderr);
  const ws = join(s.cfg.workDir, readdirSync(s.cfg.workDir).find(n => n.startsWith("0001-actor-")));
  const prompt = readFileSync(join(ws, "t3-prompt.md"), "utf8");
  const txFile = join(s.dir, "actor-tx.jsonl");
  writeFileSync(txFile, [
    { role: "user", content: prompt },
    { role: "assistant", model: "openrouter/gemini-2.5-pro-exp", content: "Completed." },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");

  put(join(ws, "wt"), "src/hygiene.js", "export const hygiene = 1;\n");
  git(join(ws, "wt"), "add", "src/hygiene.js");
  git(join(ws, "wt"), "commit", "-qm", "actor change");
  put(ws, "suite.log.gz", gzipSync("ok\n"));
  put(ws, "suite-receipt.json", "{}\n");
  put(ws, "arch-facts.json", "{}\n");
  put(ws, "ssot-status.md", "# s\n");
  put(ws, "purpose/P-0001.md", "# p\n");
  put(ws, "out/report.md", "# R-0001-actor\n\nImplemented.\n");
  put(ws, "out/pg_wal/000000010000000000000001", "wal\n");
  put(ws, "out/db/PG_VERSION", "16\n");
  put(ws, "out/db/base/1/1259", "rel\n");
  put(ws, "out/node-compile-cache/v24/chunk.bin", "cache\n");
  put(ws, "out/cache/data.sqlite", "sqlite\n");
  put(ws, "out/headers/foo.h", "int x;\n");
  put(ws, "out/dist/bundle.js", "export const b = 1;\n");
  put(ws, "out/big.bin", Buffer.alloc(2 * 1024 * 1024 + 4096, 0x61));
  put(ws, "out/nested-repo/.git/HEAD", "ref: refs/heads/main\n");
  put(ws, "out/nested-repo/keep.txt", "keep me\n");

  const rec = runCli("call.mjs", [cfgPath, "record", "--ws", ws, "--transcript", txFile, "--session", "pi-hygiene-1"], { env });
  assert.equal(rec.status, 0, rec.stderr);
  const tree = git(s.records, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
  for (const banned of ["pg_wal", "PG_VERSION", "db/base", "node-compile-cache", "data.sqlite", "foo.h", "bundle.js", "big.bin", "nested-repo/.git"]) {
    assert.ok(!tree.some(p => p.startsWith("evidence/") && p.includes(banned)), banned);
  }
  assert.ok(tree.includes("rounds/0001-actor.md"));
  assert.ok(tree.includes("evidence/0001/actor-1/out/nested-repo/keep.txt"));
  const audit = JSON.parse(git(s.records, "show", "HEAD:evidence/0001/actor-1-audit.json"));
  assert.match(audit.nonce, /^[0-9a-f]{16}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(audit), "utf8") <= MAX_AUDIT_JSON_BYTES);
  assert.ok(audit.excludedOutCount >= 8);
  assert.ok(Array.isArray(audit.excludedOutPaths) && audit.excludedOutPaths.some(p => p.includes("pg_wal")));
  for (const reclaimed of ["records", "purpose", "out", "wt", "suite.log.gz", "suite-receipt.json", "arch-facts.json", "ssot-status.md", "brief.md", "brief-shared.md", "task.md", "t3-prompt.md"]) {
    assert.equal(existsSync(join(ws, reclaimed)), false, reclaimed);
  }
  assert.equal(JSON.parse(readFileSync(join(ws, "call.json"), "utf8")).recorded, true);
  const dup = runCli("call.mjs", [cfgPath, "record", "--ws", ws, "--transcript", txFile, "--session", "pi-hygiene-1"], { env });
  assert.equal(dup.status, EXIT.records);

  const migratedDir = join(s.cfg.workDir, "0001-judge-abc");
  put(migratedDir, "call.json", JSON.stringify({
    version: 2, id: "R-0001-judge-abc", phase: s.cfg.phase, role: "judge", round: 1, step: "judge-abc",
    record: "rounds/0001-judge-abc.md", nonce: "aaaaaaaaaaaaaaaa", ws: "/home/alice/.old-root/work/0001-judge-abc", recorded: true,
  }) + "\n");
  assert.doesNotThrow(() => preparedIn(s.cfg, { currentMaxRound: 2 }));
  const nextRes = runCli("loop.mjs", ["next", "--config", cfgPath], { env });
  assert.equal(nextRes.status, 0, nextRes.stderr);

  const badDir = join(s.cfg.workDir, "0002-actor-real");
  put(badDir, "call.json", JSON.stringify({
    version: 2, id: "R-0002-actor-cur", phase: s.cfg.phase, role: "actor", round: 2, step: "actor-cur",
    record: "rounds/0002-actor-cur.md", nonce: "bbbbbbbbbbbbbbbb", ws: "/home/alice/other/work/0002-actor-wrong",
  }) + "\n");
  assert.throws(() => preparedIn(s.cfg, { currentMaxRound: 2 }), /not a supported prepared call/);
});

test("Surface 3 (flow: multi-round P1-P6 + uncited + >1MiB audit + forged tombstone; loss: data or false-verdict): Layer 3 gc & tombstones", () => {
  const { product, records } = loopProduct();
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: roomyStore() });
  const cfgPath = join(records, "loop.json");
  const bigFlags = Array.from({ length: 1200 }, (_, i) => ({ path: `/tmp/bloat-${i}-${"x".repeat(900)}.log` }));
  const sealedFlag = { path: "/loop/sealed/case-07.mjs", forbidden: true };
  const padAudit = (id, nonce) => JSON.stringify({ id, role: "actor", attempt: 1, exit: 0, nonce, flags: [...bigFlags, sealedFlag] }) + "\n";

  const sha = git(product, "rev-parse", "HEAD");
  put(records, "rounds/0001-reviewer-architecture.md", "# R-0001-reviewer-architecture\n");
  put(records, "evidence/0001/reviewer-architecture-1-arch-facts.json", "{\"schema\":1}\n");
  put(records, "rounds/0001-actor.md", "# R-0001-actor\n\nSee evidence/0001/actor-1/cited-proof.txt and evidence/0001/actor-1-audit.json.\n");
  put(records, "evidence/0001/actor-1/cited-proof.txt", "kept P5\n");
  put(records, "evidence/0001/actor-1/old-uncited.txt", "prune me\n");
  put(records, "evidence/0001/actor-1-audit.json", padAudit("R-0001-actor", "1111222233334444"));
  put(records, "evidence/0001/ci-receipt.json", JSON.stringify({ sha, ci: "success", ok: true, runs: [{ name: "verify", conclusion: "success" }] }) + "\n");
  put(records, "metrics/trajectory.jsonl", JSON.stringify({ round: 1, phase: "v1", role: "actor", area: "core", verdict: "PASS", commit: sha, suite: "3/0", ci: "success", ciReceipt: "evidence/0001/ci-receipt.json" }) + "\n");
  put(records, "evidence/0001/time-binding/TB-0001.json", "{\"sha\":\"a\"}\n");
  put(records, "sealed/judge/0001/judge-1/note.txt", "kept P4\n");
  put(records, "sealed/judge/0001/judge-1-audit.json", padAudit("R-0001-judge", "5555666677778888"));
  for (let r = 2; r <= 7; r++) {
    const rr = String(r).padStart(4, "0");
    put(records, `rounds/${rr}-actor.md`, `# R-${rr}-actor\n`);
    if (r === 6) put(records, `evidence/${rr}/actor-1/recent.txt`, "kept P6\n");
  }
  const hs = [
    { id: "R-0001-reviewer-architecture", phase: "v1", round: 1, step: "reviewer-architecture", role: "reviewer", record: "rounds/0001-reviewer-architecture.md", files: ["rounds/0001-reviewer-architecture.md", "evidence/0001/reviewer-architecture-1-arch-facts.json"], view: sha, attempt: 1, agent: { runner: "claude" }, product: null, audit: { violations: 0 } },
    { id: "R-0001-actor", phase: "v1", round: 1, step: "actor", role: "actor", record: "rounds/0001-actor.md", files: ["rounds/0001-actor.md", "evidence/0001/actor-1-audit.json", "evidence/0001/actor-1/old-uncited.txt"], view: sha, attempt: 1, agent: { runner: "codex" }, product: { base: sha, commit: sha }, audit: { violations: 0 } },
    { id: "R-0001-judge", phase: "v1", round: 1, step: "judge", role: "judge", record: "rounds/0001-judge.md", files: ["rounds/0001-judge.md", "sealed/judge/0001/judge-1-audit.json", "sealed/judge/0001/judge-1/note.txt"], view: sha, attempt: 1, agent: { runner: "codex" }, product: null, audit: { violations: 0 } },
    { id: "R-0007-actor", phase: "v1", round: 7, step: "actor", role: "actor", record: "rounds/0007-actor.md", files: ["rounds/0007-actor.md"], view: sha, attempt: 1, agent: { runner: "codex" }, product: { base: sha, commit: sha }, audit: { violations: 0 } },
  ];
  put(records, "rounds/0001-judge.md", "# R-0001-judge\n");
  put(records, "metrics/handoffs.jsonl", hs.map(h => JSON.stringify(h)).join("\n") + "\n");
  git(records, "add", "-A");
  git(records, "commit", "-qm", "seed multi-round records");
  assert.equal(runCli("records-check.mjs", ["--repo", records, "--write"], { env }).status, 0);
  git(records, "add", "INDEX.md", "BLUEPRINT.md");
  git(records, "commit", "-qm", "sync initial index");
  const headBefore = git(records, "rev-parse", "HEAD");

  const dry = selfLoop(["records", "gc", "--config", cfgPath, "--dry-run", "--json"], { cwd: product, env });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(git(records, "rev-parse", "HEAD"), headBefore);
  assert.equal(existsSync(join(records, "evidence/0001/actor-1/old-uncited.txt")), true);
  assert.equal(existsSync(join(records, "prune")), false);

  const applied = selfLoop(["records", "gc", "--config", cfgPath, "--apply", "--json"], { cwd: product, env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(join(records, "evidence/0001/actor-1/old-uncited.txt")), false);
  for (const keep of [
    "evidence/0001/ci-receipt.json",
    "evidence/0001/time-binding/TB-0001.json",
    "evidence/0001/reviewer-architecture-1-arch-facts.json",
    "sealed/judge/0001/judge-1/note.txt",
    "evidence/0001/actor-1/cited-proof.txt",
    "evidence/0006/actor-1/recent.txt",
  ]) {
    assert.equal(existsSync(join(records, keep)), true, keep);
  }
  const compacted = readFileSync(join(records, "evidence/0001/actor-1-audit.json"), "utf8");
  assert.ok(Buffer.byteLength(compacted, "utf8") < MAX_AUDIT_JSON_BYTES);
  const parsedCompact = JSON.parse(compacted);
  assert.equal(parsedCompact.nonce, "1111222233334444");
  assert.ok(parsedCompact.flags.some(f => f.forbidden === true && f.path === "/loop/sealed/case-07.mjs"));

  const tomb = readFileSync(join(records, "prune/PR-0001.md"), "utf8");
  assert.match(tomb, /evidence\/0001\/actor-1\/old-uncited\.txt/);
  assert.match(tomb, /SHA-256/);
  assert.match(tomb, /Origin commit/);
  assert.match(tomb, new RegExp(headBefore));
  assert.equal(runCli("records-check.mjs", ["--repo", records, "--json"], { env }).status, 0);

  const emptyTree = git(records, "hash-object", "-t", "tree", "/dev/null");
  const orphanCommit = git(records, "commit-tree", emptyTree, "-m", "unrelated non-ancestor");
  const forged = tomb.replaceAll(`\`${headBefore}\``, `\`${orphanCommit}\``);
  assert.notEqual(forged, tomb);
  writeFileSync(join(records, "prune/PR-0001.md"), forged);
  git(records, "add", "prune/PR-0001.md");
  git(records, "commit", "-qm", "forge tombstone originCommit");
  const badCheck = runCli("records-check.mjs", ["--repo", records, "--json"], { env });
  assert.equal(badCheck.status, 1);
  assert.match(badCheck.stdout, /PR-0001|tombstone|originCommit/i);
});

test("Surface 4 (flow: portable pre-commit blocks stray/drift with blueprint while start stays read-only on unhooked repo; loss: stuck or disclosure)", () => {
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: roomyStore() });
  const freshProduct = repo({ "src/a.js": "export const a = 1;\n" });
  const initRes = selfLoop(["init", "--json"], { cwd: freshProduct, env });
  assert.equal(initRes.status, 0, initRes.stderr);
  const freshRecords = join(freshProduct, ".self-loop");
  const hookPath = join(freshRecords, ".githooks/pre-commit");
  assert.equal(existsSync(hookPath), true);
  assert.ok((statSync(hookPath).mode & 0o111) !== 0);
  const hookBody = readFileSync(hookPath, "utf8");
  assert.doesNotMatch(hookBody, new RegExp(freshProduct.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(git(freshRecords, "config", "--local", "--get", "core.hooksPath"), ".githooks");

  const hookEnv = { ...env, SELF_LOOP_HOME: dirname(scripts) };
  put(freshRecords, "prompts/draft.md", "# stray\n");
  git(freshRecords, "add", "prompts/draft.md");
  const strayCommit = spawnSync("git", ["-C", freshRecords, "commit", "-m", "stray"], { encoding: "utf8", env: hookEnv });
  assert.notEqual(strayCommit.status, 0);
  assert.match(strayCommit.stderr, /staged-stray-file|prompts\/draft\.md/);
  git(freshRecords, "reset", "-q", "HEAD", "--", "prompts/draft.md");
  rmSync(join(freshRecords, "prompts"), { recursive: true, force: true });

  put(freshRecords, "purpose/P-0002.md", "# P-0002 More\n");
  put(freshRecords, "blueprint/F-0002.md", "# F-0002 More\n\nid: F-0002\nphase: v1\nrequirements: P-0002\n");
  git(freshRecords, "add", "purpose/P-0002.md", "blueprint/F-0002.md");
  const driftCommit = spawnSync("git", ["-C", freshRecords, "commit", "-m", "drift"], { encoding: "utf8", env: hookEnv });
  assert.notEqual(driftCommit.status, 0);
  assert.match(driftCommit.stderr, /staged-index-drift|INDEX\.md|BLUEPRINT\.md/);
  assert.equal(runCli("records-check.mjs", ["--repo", freshRecords, "--write"], { env }).status, 0);
  git(freshRecords, "add", "INDEX.md", "BLUEPRINT.md");
  const cleanCommit = spawnSync("git", ["-C", freshRecords, "commit", "-qm", "synced commit"], { encoding: "utf8", env: hookEnv });
  assert.equal(cleanCommit.status, 0, cleanCommit.stderr);

  const unhooked = loopProduct();
  const cfgPath = join(unhooked.records, "loop.json");
  const beforeHead = git(unhooked.records, "rev-parse", "HEAD");
  const startJson = selfLoop(["start", "--config", cfgPath, "--json"], { cwd: unhooked.product, env });
  assert.equal(startJson.status, 0, startJson.stderr);
  const parsed = JSON.parse(startJson.stdout);
  assert.equal(parsed.session.hygiene.healthy, false);
  assert.ok(parsed.session.hygiene.findings.some(f => /hooks install/i.test(f)));
  assert.equal(existsSync(join(unhooked.records, ".githooks/pre-commit")), false);
  assert.equal(git(unhooked.records, "rev-parse", "HEAD"), beforeHead);
  assert.equal(git(unhooked.records, "status", "--porcelain"), "");
  assert.equal(spawnSync("git", ["-C", unhooked.records, "config", "--local", "--get", "core.hooksPath"], { encoding: "utf8" }).status, 1);
});

test("Surface 5 (flow: T3/summary noise vs mid-sentence refs, atomic mark, open hints, PreInvocation dedup; loss: data or noise)", () => {
  const { product, records } = loopProduct();
  const appDir = temp("oh-s5-ag-");
  const txDir = temp("oh-s5-cl-");
  const env = isolatedEnv({ ANTIGRAVITY_APP_DATA_DIR: appDir, GEMINI_HOME: temp("oh-s5-gem-"), T3CODE_HOME: "", T3CODE_THREAD_ID: "", SELF_LOOP_OWNER_STORE: roomyStore() });
  const txPath = join(txDir, "session.jsonl");
  const cap = payload => runCli("owner-words.mjs", ["capture", "--records", records, "--project", product], { input: JSON.stringify(payload), env });

  put(records, "purpose/P-0001.md", "# P-0001 Purpose\n\nQuote without id: \"请只处理 F-0015\".\n");
  git(records, "add", "purpose/P-0001.md");
  git(records, "commit", "-qm", "quote without word id");
  const prompts = [
    { id: "e1", text: '[T3 Code: scheduled task "tick"]\nheartbeat body' },
    { id: "e2", text: "<chat-history-summary>\nsummary only\n</chat-history-summary>" },
    { id: "e3", text: "<chat-history-summary>\nold context\n</chat-history-summary>\n\n请只处理 F-0015" },
    { id: "e4", text: '请保留 <chat-history-summary> 和 [T3 Code: scheduled task "tick"] 的正文引用' },
    { id: "e5", text: "继续" },
  ];
  writeFileSync(txPath, prompts.map(p => JSON.stringify({
    type: "user",
    sessionId: "s-oh-5",
    cwd: product,
    promptId: p.id,
    timestamp: "2026-11-27T00:00:00Z",
    message: { role: "user", content: p.text },
  })).join("\n") + "\n");
  for (const p of prompts) {
    const res = cap({ session_id: "s-oh-5", cwd: product, transcript_path: txPath, prompt: p.text, prompt_id: p.id });
    assert.equal(res.status, 0, res.stderr);
  }
  const openRes = runCli("owner-words.mjs", ["open", "--records", records, "--hints", "--json"], { env });
  assert.equal(openRes.status, 2);
  const openData = JSON.parse(openRes.stdout);
  assert.deepEqual(openData.open.map(w => w.text), [
    "请只处理 F-0015",
    '请保留 <chat-history-summary> 和 [T3 Code: scheduled task "tick"] 的正文引用',
    "继续",
  ]);
  assert.ok(openData.quoteMatches.length > 0 && openData.routineCandidates.length > 0 && openData.routineHint);
  const openPlain = runCli("owner-words.mjs", ["open", "--records", records, "--hints"], { env });
  assert.equal(openPlain.status, 2);
  assert.match(openPlain.stdout, /\[quote-match\].*words: W-/);
  assert.match(openPlain.stdout, /mark\s+--records\s+\S+\s+--ids/);
  const ids = openData.open.map(w => w.id);
  assert.equal(runCli("owner-words.mjs", ["mark", "--records", records, "--ids", "W-0000000000", "--as", "routine", "--note", "bad"], { env }).status, 64);
  assert.equal(runCli("owner-words.mjs", ["mark", "--records", records, "--ids", `${ids[0]},W-0000000000`, "--as", "routine", "--note", "atomic"], { env }).status, 64);
  assert.equal(runCli("owner-words.mjs", ["open", "--records", records, "--json"], { env }).status, 2);
  const markOk = runCli("owner-words.mjs", ["mark", "--records", records, "--ids", ids.join(","), "--as", "routine", "--note", "batch ok"], { env });
  assert.equal(markOk.status, 0, markOk.stderr);
  assert.equal(runCli("owner-words.mjs", ["open", "--records", records, "--json"], { env }).status, 0);

  const convId = "conv-oh-dedup";
  const agFile = join(appDir, "brain", convId, ".system_generated", "logs", "transcript.jsonl");
  const uStep = (step_index, content, extra = {}) => ({ step_index, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: "2026-11-27T01:00:00Z", content, ...extra });
  put(dirname(agFile), "transcript.jsonl", JSON.stringify(uStep(0, "继续", { truncated_fields: ["content"] })) + "\n");
  const agCap = payload => runCli("owner-words.mjs", ["capture", "--harness", "antigravity", "--records", records, "--project", product], { input: JSON.stringify(payload), env });
  assert.match(JSON.parse(agCap({ hookEventName: "PreInvocation", conversationId: convId, cwd: product, initialNumSteps: 1, lastUserInput: "继续", transcriptPath: agFile }).stdout).injectSteps[0].systemMessage.systemMessage, /pending/);
  assert.deepEqual(JSON.parse(agCap({ hookEventName: "PreInvocation", conversationId: convId, cwd: product, initialNumSteps: 4, lastUserInput: "继续", transcriptPath: agFile }).stdout), {});
  assert.equal(pendingOwnerPrompts(records, convId).length, 1);
  writeFileSync(agFile, [uStep(0, "继续", { truncated_fields: ["content"] }), uStep(5, "继续", { truncated_fields: ["content"] })].map(r => JSON.stringify(r)).join("\n") + "\n");
  assert.match(JSON.parse(agCap({ hookEventName: "PreInvocation", conversationId: convId, cwd: product, initialNumSteps: 6, lastUserInput: "继续", transcriptPath: agFile }).stdout).injectSteps[0].systemMessage.systemMessage, /pending/);
  assert.equal(pendingOwnerPrompts(records, convId).length, 2);
});

test("Surface 6a (flow: empty comments 0 ls-tree, arch cache + fresh churn, missing ws >1MiB audit nonce & .log.gz fallback <2s; loss: stuck)", () => {
  const { product, records } = loopProduct();
  const shimBin = temp("oh-s6-gitshim-");
  const gitLog = join(shimBin, "git.log");
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const gitShim = join(shimBin, "git");
  writeFileSync(gitShim, `#!/bin/sh\necho "$*" >> ${JSON.stringify(gitLog)}\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(gitShim, 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${shimBin}:${oldPath}`;
  try {
    assert.deepEqual(commentResolutions(records), []);
    const logged = existsSync(gitLog) ? readFileSync(gitLog, "utf8") : "";
    assert.equal(logged.split("\n").filter(l => l.includes("ls-tree")).length, 0);
  } finally {
    process.env.PATH = oldPath;
  }

  const c0 = git(product, "rev-parse", "HEAD");
  for (let i = 1; i <= 3; i++) {
    put(product, "src/m1.js", `export const m1 = ${i};\n`);
    git(product, "add", "src/m1.js");
    git(product, "commit", "-qm", `c${i}`);
  }
  const c3 = git(product, "rev-parse", "HEAD");
  const f1 = collectArchFacts(product, c3, { baselineSha: c0 });
  put(product, "src/m1.js", "export const m1 = 4;\nexport const extra = 5;\n");
  git(product, "add", "src/m1.js");
  git(product, "commit", "-qm", "c4");
  const c4 = git(product, "rev-parse", "HEAD");
  const f2 = collectArchFacts(product, c4, { baselineSha: c0 });
  assert.ok(f1.churnHotspots.some(h => h.path === "src/m1.js" && h.commits === 3));
  assert.ok(f2.churnHotspots.some(h => h.path === "src/m1.js" && h.commits === 4));
  const c2 = c4;

  const bigAudit = nonce => JSON.stringify({
    id: "R-0001-actor", role: "actor", attempt: 1, exit: 0, ...(nonce ? { nonce } : {}),
    flags: Array.from({ length: 1200 }, (_, i) => ({ path: `/tmp/big-${i}-${"d".repeat(900)}.txt` })),
  }) + "\n";
  const hs = [];
  for (let r = 1; r <= 30; r++) {
    const rr = String(r).padStart(4, "0");
    put(records, `rounds/${rr}-actor.md`, `# R-${rr}-actor\n`);
    if (r <= 2) {
      const aPath = `evidence/${rr}/actor-1-audit.json`;
      const logPath = `evidence/${rr}/actor-1.log.gz`;
      put(records, aPath, bigAudit(r === 1 ? "1111111122222222" : undefined));
      put(records, logPath, gzipSync(`self-loop call R-${rr}-actor · nonce ${r === 1 ? "1111111122222222" : "3333333344444444"}\n`));
      hs.push({ id: `R-${rr}-actor`, phase: "v1", round: r, step: "actor", role: "actor", record: `rounds/${rr}-actor.md`, files: [`rounds/${rr}-actor.md`, aPath, logPath], view: c2, attempt: 1, agent: { runner: "codex" }, product: { base: c2, commit: c2 }, audit: { violations: 0 } });
    } else {
      hs.push({ id: `R-${rr}-actor`, phase: "v1", round: r, step: "actor", role: "actor", record: `rounds/${rr}-actor.md`, files: [`rounds/${rr}-actor.md`], view: c2, attempt: 1, agent: { runner: "codex" }, product: { base: c2, commit: c2 }, audit: { violations: 0 } });
    }
  }
  put(records, "metrics/handoffs.jsonl", hs.map(h => JSON.stringify(h)).join("\n") + "\n");
  put(records, "plans/PL-0001.md", [
    "# PL-0001", "scope: v1/perf", "phase: v1", "",
    "## a1", "role: actor", "handoff: R-0001-actor", "authority: P-0001", "goal: first", "files: src/m1.js", "interface: fixed", "acceptance: pass", "needs: ", "",
    "## a2", "role: actor", "handoff: R-0002-actor", "authority: P-0001", "goal: second", "files: src/m2.js", "interface: fixed", "acceptance: pass", "needs: ", "",
  ].join("\n"));
  git(records, "add", "-A");
  git(records, "commit", "-qm", "seed heavy plan reconciliation");
  const t0 = performance.now();
  const reconciled = reconcilePlans(records, "HEAD", "v1", { host: { admits: true, over: [] }, base: c2, live: [
    { id: "R-0001-actor", nonce: "1111111122222222", ws: "/tmp/missing-ws-1", role: "actor", round: 1, step: "actor" },
    { id: "R-0002-actor", nonce: "3333333344444444", ws: "/tmp/missing-ws-2", role: "actor", round: 2, step: "actor" },
  ] });
  const elapsedMs = performance.now() - t0;
  assert.ok(reconciled);
  assert.ok(elapsedMs < 2000, `reconcilePlans took ${elapsedMs}ms`);
  const nextRes = selfLoop(["next", "--config", join(records, "loop.json")], { env: isolatedEnv({ SELF_LOOP_OWNER_STORE: roomyStore() }) });
  assert.equal(nextRes.status, 0, nextRes.stderr);
});

test("Surface 6b (flow: I-0005 intent sender gate, pruneSuiteStore eviction, dead-PID lease unlink; loss: disclosure or stuck): gates & hostLoad", () => {
  const { product, records } = loopProduct();
  const env = isolatedEnv({ SELF_LOOP_OWNER_STORE: roomyStore() });
  const intentFile = put(temp("oh-s6-intent-"), "D-0002.json", JSON.stringify({
    kind: "intent",
    requirement: "P-0001",
    questions: [{ question: "Clarify goal?", whyAsked: "Not settled by records.", options: ["Option A", "Option B"], recommendation: "Option A, because it bounds scope." }],
  }));
  const denied = runCli("decisions.mjs", ["send", "--records", records, "--file", intentFile, "--phase", "v1", "--from", "lead"], { env });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /refused/);
  const allowed = runCli("decisions.mjs", ["send", "--records", records, "--file", intentFile, "--phase", "v1", "--from", "R-0001-reviewer"], { env });
  assert.equal(allowed.status, 0, allowed.stderr);

  const suiteProd = repo({ "a.test.mjs": 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => assert.equal(1, 1));\n' });
  const pinnedTree = git(suiteProd, "rev-parse", "HEAD^{tree}");
  assert.equal(suiteGreen({ repo: suiteProd, sha: "HEAD", command: "node --test a.test.mjs", format: "node-test" }).green, true);
  const storeDir = suiteStore(suiteProd);
  const oldBucket = join(storeDir, "old-unpinned");
  mkdirSync(oldBucket, { recursive: true });
  const oldJson = join(oldBucket, "old.json");
  writeFileSync(oldJson, JSON.stringify({ green: true, tree: "9".repeat(40), pad: "x".repeat(4096) }));
  writeFileSync(join(oldBucket, "old.log.gz"), gzipSync("ok\n"));
  const pruned = pruneSuiteStore(suiteProd, { maxReceipts: 1, maxBytes: 1024, maxAgeMs: 14 * 86400_000, pinnedTrees: [pinnedTree], apply: true, now: () => Date.now() + 20 * 86400_000 });
  assert.ok(pruned.removed.includes(oldJson));
  assert.equal(existsSync(oldJson), false);

  const loadDir = temp("oh-s6-load-");
  const deadCall = put(loadDir, "call-99999999-1.json", JSON.stringify({ kind: "call", pid: 99999999, role: "actor", id: "R-0001-actor" }));
  const deadSuite = put(loadDir, "suite-99999999-1.json", JSON.stringify({ kind: "suite", pid: 99999999, repo: product, sha: git(product, "rev-parse", "HEAD") }));
  const aliveSuite = put(loadDir, `suite-${process.pid}-9.json`, JSON.stringify({ kind: "suite", pid: process.pid, repo: product, sha: git(product, "rev-parse", "HEAD") }));
  const store = ownerStore([{ name: "p", records }], { bound: ROOMY });
  const load = hostLoad({ store: { path: store }, env: { ...process.env, SELF_LOOP_LOAD_DIR: loadDir } });
  assert.equal(existsSync(deadCall), false);
  assert.equal(existsSync(deadSuite), false);
  assert.equal(existsSync(aliveSuite), true);
  assert.ok(load.calls.some(c => c.kind === "suite" && c.line.includes(`pid ${process.pid}`)));
});
