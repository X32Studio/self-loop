// F-0004, F-0006, F-0008, F-0011, F-0012, D-0060, D-0061, design/mandatory-control-plane.md#5, design/suite-once.md#2
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { call, cancelCall, EXIT, preparedIn, recordCall } from "../call.mjs";
import { appendWords } from "../lib/owner-words.mjs";
import { hostLoad } from "../lib/registry.mjs";
import { isStalePreparation, resolveChildSession } from "../lib/t3-child.mjs";
import { lookupSuiteReceipt, suiteGreen, suiteStore } from "../suite-green.mjs";
import { git, isolatedEnv, ownerStore, repo, roomyStore, scripts, setup, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("call-unify-load-");

const put = (root, rel, text) => {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
};
const commitAll = (dir, msg) => { git(dir, "add", "-A"); git(dir, "commit", "-qm", msg); return git(dir, "rev-parse", "HEAD"); };
const linesOf = (n, prefix = "export const v") => Array.from({ length: n }, (_, i) => `${prefix}_${i} = ${i};`).join("\n") + "\n";

function writeCodex(codexHome, sid, prompt, cwd, commands = []) {
  const now = new Date();
  const dir = join(codexHome, "sessions", String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const ts = now.toISOString();
  const file = join(dir, `rollout-${sid}-${Math.random().toString(16).slice(2)}.jsonl`);
  writeFileSync(file, [
    { timestamp: ts, type: "session_meta", payload: { cwd, id: sid } },
    { timestamp: ts, type: "turn_context", payload: { cwd, model: "gpt-6" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    ...commands.map(c => ({ timestamp: ts, type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/sh", "-c", c], cwd: `file://${cwd}`, exit_code: 0 } } })),
    { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  return file;
}

function bumpAfter(file, ws) {
  const { preparedAt } = JSON.parse(readFileSync(join(ws, "call.json"), "utf8"));
  const sec = Math.ceil((preparedAt + 1000) / 1000);
  utimesSync(file, sec, sec);
}

function planMd(id, packages, { scope = "S5/unify", phase = "S5" } = {}) {
  return [
    `# ${id} Plan`, `scope: ${scope}`, `phase: ${phase}`, "",
    ...packages.flatMap(p => [
      `## ${p.id}`, `role: ${p.role}`, `handoff: ${p.handoff}`, "authority: D-0001",
      `goal: ${p.goal ?? p.id}`, `files: ${(p.files ?? []).join(", ")}`, "interface: fixed", "acceptance: green",
      `needs: ${(p.needs ?? []).join(", ")}`, ...(p.reviews ? [`reviews: ${p.reviews.join(", ")}`] : []), "",
    ]),
  ].join("\n");
}

test("mandatory --plan refuses unplanned critic, actor, and code judge while exempting reviewer, judge-frame*, and judge-comments*", async () => {
  const s = await setup({});
  const task = "features: F-0001\nWork.\n";
  for (const role of ["critic", "actor", "judge"]) {
    const refused = call(s.cfg, role, { round: 1, task, dry: true });
    assert.equal(refused.code, EXIT.records, `${role}: ${refused.message}`);
    assert.match(refused.message, /requires --plan PL-NNNN --package <id>/);
  }
  assert.equal(call(s.cfg, "reviewer", { round: 2, step: "reviewer-architecture", task: "features: none\nReview.\n", dry: true }).code, EXIT.done);
  assert.equal(call(s.cfg, "judge", { round: 2, step: "judge-frame", task, dry: true }).code, EXIT.done);
  assert.equal(call(s.cfg, "judge", { round: 2, step: "judge-comments", task, dry: true }).code, EXIT.done);
  assert.equal(call(s.cfg, "judge", { round: 2, step: "judge-comments-prepush", task, dry: true }).code, EXIT.done);
});

test("--base provenance check refuses unattested non-lead commits above provenanceBaseline and allows lead-only and attested commits", async () => {
  const s = await setup({});
  const baseline = git(s.product, "rev-parse", "loop/s5");
  s.cfg.provenanceBaseline = baseline;

  git(s.product, "checkout", "-q", "loop/s5");
  put(s.product, "README.md", "# Updated lead doc\n");
  const leadOnlySha = commitAll(s.product, "lead doc edit");
  assert.equal(s.run("actor", { round: 1, base: leadOnlySha, dry: true }).code, EXIT.done);

  put(s.product, "src/sneaky.js", "export const sneaky = 1;\n");
  const unattestedSha = commitAll(s.product, "manual code edit");
  for (const role of ["critic", "actor", "judge"]) {
    const res = s.run(role, { round: 1, base: unattestedSha, dry: true });
    assert.equal(res.code, EXIT.records, `${role}: ${res.message}`);
    assert.match(res.message, /provenance verification/);
    assert.match(res.message, /unattested commit/);
  }
});

test("0-turn substantive owner-word guard refuses critic and actor immediately while leaving reviewer open and ignoring routine acks", async () => {
  const s = await setup({});
  appendWords(s.records, [{ id: "W-1111111111", time: "2026-11-24T00:10:00Z", source: "claude", session: "s1", text: "ok", sha256: "a" }]);
  assert.equal(s.run("critic", { round: 1, dry: true }).code, EXIT.done);
  assert.equal(s.run("actor", { round: 1, dry: true }).code, EXIT.done);

  appendWords(s.records, [{ id: "W-2222222222", time: "2026-11-24T00:20:00Z", source: "claude", session: "s1", text: "Enforce provenance on every push and refuse bypasses", sha256: "b" }]);
  for (const role of ["critic", "actor"]) {
    const refused = s.run(role, { round: 1, dry: true });
    assert.equal(refused.code, EXIT.records, `${role}: ${refused.message}`);
    assert.match(refused.message, /0-turn grace/);
    assert.match(refused.message, /W-2222222222/);
  }
  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-distill", dry: true }).code, EXIT.done);
});

test("optional --session nonce resolution, call.mjs cancel, and prior-round zombie expiry", async () => {
  const t3 = { runner: "t3", provider: "codex", model: "gpt-6", effort: "high" };
  const s = await setup({}, { agents: { critic: t3, actor: t3, judge: t3, reviewer: { runner: "cmd", cmd: ["true"] } } });
  const codexHome = temp("cu-codex-");
  const oldCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const p1 = s.run("critic", { round: 1, prepare: true });
    assert.equal(p1.code, EXIT.done, p1.message);
    const { ws, wt, nonce, prompt } = p1.prepared;
    put(ws, "out/report.md", "# R-0001-critic\n\nDone.\n");

    assert.throws(() => resolveChildSession("codex", nonce, Date.now() - 5000), /no transcript holds nonce/);
    const f1 = writeCodex(codexHome, "sess-auto-1", prompt, wt);
    bumpAfter(f1, ws);
    const unique = resolveChildSession("codex", nonce, JSON.parse(readFileSync(join(ws, "call.json"), "utf8")).preparedAt);
    assert.equal(unique.session, "sess-auto-1");

    const f2 = writeCodex(codexHome, "sess-auto-2", prompt, wt);
    bumpAfter(f2, ws);
    assert.throws(() => resolveChildSession("codex", nonce, JSON.parse(readFileSync(join(ws, "call.json"), "utf8")).preparedAt), /2 transcripts hold nonce/);

    const recExplicit = recordCall(s.cfg, ws, { session: "sess-auto-1" });
    assert.equal(recExplicit.code, EXIT.done, recExplicit.message);
    assert.equal(JSON.parse(readFileSync(join(ws, "call.json"), "utf8")).recorded, true);
    assert.equal(preparedIn(s.cfg).some(p => p.ws === ws), false);

    const p2 = s.run("actor", { round: 1, prepare: true });
    assert.equal(p2.code, EXIT.done, p2.message);
    put(p2.prepared.ws, "out/report.md", "# R-0001-actor\n\nAuto session.\n");
    bumpAfter(writeCodex(codexHome, "sess-auto-actor", p2.prepared.prompt, p2.prepared.wt), p2.prepared.ws);
    const recAuto = recordCall(s.cfg, p2.prepared.ws);
    assert.equal(recAuto.code, EXIT.done, recAuto.message);
    assert.equal(recAuto.handoff.agent.session, "sess-auto-actor");

    const p3 = s.run("actor", { round: 2, prepare: true });
    assert.equal(p3.code, EXIT.done, p3.message);
    assert.equal(preparedIn(s.cfg).some(p => p.ws === p3.prepared.ws), true);

    const cancelled = cancelCall(s.cfg, p3.prepared.ws, { reason: "superseded by new plan" });
    assert.equal(cancelled.code, EXIT.done, cancelled.message);
    assert.equal(cancelled.cancelled.cancelled, true);
    assert.equal(existsSync(p3.prepared.wt), false);
    assert.equal(preparedIn(s.cfg).some(p => p.ws === p3.prepared.ws), false);
    assert.equal(recordCall(s.cfg, p3.prepared.ws).code, EXIT.records);

    const configPath = join(s.dir, "loop.json");
    writeFileSync(configPath, JSON.stringify(s.cfg));
    const p4 = s.run("critic", { round: 2, prepare: true });
    assert.equal(p4.code, EXIT.done, p4.message);
    const cliCancel = spawnSync(process.execPath, [join(scripts, "call.mjs"), configPath, "cancel", "--ws", p4.prepared.ws, "--reason", "cli cancel"], { encoding: "utf8" });
    assert.equal(cliCancel.status, 0, cliCancel.stderr);
    assert.equal(JSON.parse(cliCancel.stdout).cancelled, true);
    assert.equal(existsSync(p4.prepared.wt), false);

    assert.equal(isStalePreparation({ round: 1 }, 2), true);
    assert.equal(isStalePreparation({ round: 2 }, 2), false);
    assert.equal(isStalePreparation({ round: 1, pid: process.pid }, 2), false);
    assert.equal(isStalePreparation({ round: 2, cancelled: true }, 2), true);
    assert.equal(isStalePreparation({ round: 2, recorded: true }, 2), true);

    const zombie = s.run("critic", { round: 3, prepare: true });
    assert.equal(zombie.code, EXIT.done, zombie.message);
    const store = ownerStore([{ name: "test", records: s.records }]);
    assert.equal(hostLoad({ store: { path: store, source: "test" }, cfg: s.cfg }).calls.some(c => c.line.includes(zombie.prepared.ws)), true);
    put(s.records, "rounds/0005-reviewer-frame.md", "# R-0005-reviewer-frame\n");
    const prev = readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8");
    put(s.records, "metrics/handoffs.jsonl", prev + JSON.stringify({
      id: "R-0005-reviewer-frame", time: "2026-11-24T10:00:00Z", phase: "S5", round: 5, step: "reviewer-frame", role: "reviewer",
      record: "rounds/0005-reviewer-frame.md", files: ["rounds/0005-reviewer-frame.md"], view: "f".repeat(40), attempt: 1,
      agent: { runner: "claude" }, product: null, audit: { violations: 0 },
    }) + "\n");
    commitAll(s.records, "advance round to 5");
    assert.equal(preparedIn(s.cfg).some(p => p.ws === zombie.prepared.ws), false);
    assert.equal(hostLoad({ store: { path: store, source: "test" }, cfg: s.cfg }).calls.some(c => c.line.includes(zombie.prepared.ws)), false);
  } finally {
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
});

test("ancestor-extinguished ci-absent and delta-scoped T3 hotspot blocking work end-to-end in call.mjs and loop.mjs", async () => {
  const s = await setup({}, { cadence: { deliveries: 10, outerGrace: 1 } });
  git(s.product, "checkout", "-q", "loop/s5");
  const c1 = git(s.product, "rev-parse", "HEAD");
  put(s.product, "src/existing-big.js", linesOf(840, "export const b"));
  put(s.product, "src/hotspot.js", linesOf(20, "export const h"));
  put(s.product, "src/clean.js", linesOf(20, "export const c"));
  const c2 = commitAll(s.product, "baseline with existing big file");

  put(s.records, "metrics/trajectory.jsonl", [
    { round: 1, phase: "S5", role: "judge", area: "core", verdict: "CONTINUE", commit: c1, ci: "absent", time: "2026-11-24T01:00:00Z" },
    { round: 2, phase: "S5", role: "judge", area: "core", verdict: "CONTINUE", commit: c2, ci: "success", time: "2026-11-24T02:00:00Z" },
  ].map(r => JSON.stringify(r)).join("\n") + "\n");
  commitAll(s.records, "extinguished ci-absent trajectory");

  assert.equal(s.run("actor", { round: 2, dry: true }).code, EXIT.done);
  const arch = s.run("reviewer", { round: 3, step: "reviewer-architecture", base: c2 });
  assert.equal(arch.code, EXIT.done, arch.message);
  assert.ok(arch.handoff.files.some(f => f.endsWith("arch-facts.json")));

  put(s.product, "src/clean.js", linesOf(25, "export const c"));
  const c3 = commitAll(s.product, "clean edit only");
  const prevH = readFileSync(join(s.records, "metrics/handoffs.jsonl"), "utf8");
  put(s.records, "rounds/0004-actor.md", "# R-0004-actor\n");
  put(s.records, "metrics/handoffs.jsonl", prevH + JSON.stringify({
    id: "R-0004-actor", time: "2026-11-24T03:00:00Z", phase: "S5", round: 4, step: "actor", role: "actor",
    attempt: 1, agent: { runner: "claude" }, view: "a".repeat(40), product: { base: c2, commit: c3 },
    audit: { violations: 0 }, record: "rounds/0004-actor.md", files: ["rounds/0004-actor.md"],
  }) + "\n");
  commitAll(s.records, "actor delivery 4");
  assert.equal(s.run("actor", { round: 5, base: c3, dry: true }).code, EXIT.done);

  put(s.product, "src/hotspot.js", linesOf(830, "export const h"));
  const c4 = commitAll(s.product, "new hotspot breach");
  put(s.records, "plans/PL-0050.md", planMd("PL-0050", [
    { id: "actor-clean", role: "actor", handoff: "R-0006-actor-clean", files: ["src/clean.js"] },
    { id: "actor-hot", role: "actor", handoff: "R-0006-actor-hot", files: ["src/hotspot.js"] },
    { id: "critic-all", role: "critic", handoff: "R-0006-critic-all", files: ["test/all.test.js"], reviews: ["actor-clean", "actor-hot"] },
    { id: "judge-all", role: "judge", handoff: "R-0006-judge", files: [], needs: ["critic-all"] },
  ], { scope: "S5/delta" }));
  commitAll(s.records, "delta plan");

  assert.equal(call(s.cfg, "actor", { round: 6, step: "actor-clean", plan: "PL-0050", package: "actor-clean", task: "features: F-0001\nClean.\n", base: c4, dry: true }).code, EXIT.records);

  const archWs = join(s.cfg.workDir, "0006-reviewer-architecture-live");
  mkdirSync(join(archWs, "purpose"), { recursive: true });
  mkdirSync(join(archWs, "records"), { recursive: true });
  mkdirSync(join(archWs, "out"), { recursive: true });
  mkdirSync(join(archWs, "wt"), { recursive: true });
  put(archWs, "call.json", JSON.stringify({
    version: 2, id: "R-0006-reviewer-architecture", phase: "S5", round: 6, step: "reviewer-architecture",
    role: "reviewer", record: "rounds/0006-reviewer-architecture.md", ws: archWs, wt: join(archWs, "wt"), nonce: "0123456789abcdef",
  }));

  const cleanAllowed = call(s.cfg, "actor", { round: 6, step: "actor-clean", plan: "PL-0050", package: "actor-clean", task: "features: F-0001\nClean.\n", base: c4, dry: true });
  assert.equal(cleanAllowed.code, EXIT.done, cleanAllowed.message);
  const hotBlocked = call(s.cfg, "actor", { round: 6, step: "actor-hot", plan: "PL-0050", package: "actor-hot", task: "features: F-0001\nHot.\n", base: c4, dry: true });
  assert.equal(hotBlocked.code, EXIT.records);
  assert.match(hotBlocked.message, /src\/hotspot\.js/);

  const cfgPath = join(s.dir, "loop.json");
  writeFileSync(cfgPath, JSON.stringify(s.cfg));
  const nextOut = spawnSync(process.execPath, [join(scripts, "loop.mjs"), "next", "--config", cfgPath], {
    encoding: "utf8", env: { ...isolatedEnv(), SELF_LOOP_OWNER_STORE: roomyStore(), SELF_LOOP_LOAD_DIR: temp("cu-next-load-") },
  });
  assert.equal(nextOut.status, 0, nextOut.stderr);
  assert.doesNotMatch(nextOut.stdout, /ci-absent:S5:1/);
});

test("stageSuiteWorkspace pre-judge ensure/red refusal, lookup, purgeTreeReceipts pre-poisoning defense, duplicateSuiteRuns audit, and gated-push auto-receipt", async () => {
  const counterFile = join(temp("cu-suite-count-"), "runs.log");
  const t3 = { runner: "t3", provider: "codex", model: "gpt-6" };
  const s = await setup({}, {
    agents: { critic: t3, actor: t3, judge: t3, reviewer: { runner: "cmd", cmd: ["true"] } },
    gates: { require: [], suite: "node --test test/suite.test.mjs", format: "node-test" },
  });
  const makeTestBody = ok => [
    'import assert from "node:assert/strict";',
    'import { appendFileSync } from "node:fs";',
    'import test from "node:test";',
    `test("counted", () => { appendFileSync(${JSON.stringify(counterFile)}, "run\\n"); assert.equal(${ok ? "1, 1" : "1, 2"}); });`,
    "",
  ].join("\n");
  const runCount = () => (existsSync(counterFile) ? readFileSync(counterFile, "utf8").split("\n").filter(Boolean).length : 0);

  git(s.product, "checkout", "-q", "loop/s5");
  put(s.product, "test/suite.test.mjs", makeTestBody(false));
  const redSha = commitAll(s.product, "red suite");

  const redJudge = s.run("judge", { round: 1, base: redSha, prepare: true });
  assert.equal(redJudge.code, EXIT.gate, redJudge.message);
  assert.match(redJudge.message, /pre-judge suite gate failed/);
  assert.equal(runCount(), 1);

  put(s.product, "test/suite.test.mjs", makeTestBody(true));
  const greenSha = commitAll(s.product, "green suite");
  const greenTree = git(s.product, "--no-replace-objects", "rev-parse", `${greenSha}^{tree}`);

  const actorCold = s.run("actor", { round: 1, base: greenSha, prepare: true });
  assert.equal(actorCold.code, EXIT.done, actorCold.message);
  assert.equal(existsSync(join(actorCold.prepared.ws, "suite-receipt.json")), false);
  assert.equal(runCount(), 1);
  assert.equal(cancelCall(s.cfg, actorCold.prepared.ws, { reason: "cold lookup checked" }).code, EXIT.done);

  const codexHome = temp("cu-suite-codex-");
  const oldCodex = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const judgePrep = s.run("judge", { round: 1, base: greenSha, prepare: true });
    assert.equal(judgePrep.code, EXIT.done, judgePrep.message);
    const stagedPath = join(judgePrep.prepared.ws, "suite-receipt.json");
    assert.equal(existsSync(stagedPath), true);
    assert.equal(statSync(stagedPath).mode & 0o222, 0);
    assert.equal(JSON.parse(readFileSync(stagedPath, "utf8")).tree, greenTree);
    assert.match(judgePrep.prepared.prompt, /do NOT re-run `node --test test\/suite\.test\.mjs` on unchanged wt/);
    assert.equal(runCount(), 2);

    put(judgePrep.prepared.ws, "out/report.md", "VERDICT: CONVERGED\nACCEPTANCE: pass\n");
    put(judgePrep.prepared.ws, "out/public.md", "Green.\n");
    bumpAfter(writeCodex(codexHome, "judge-dup-sess", judgePrep.prepared.prompt, judgePrep.prepared.wt, ["node --test test/suite.test.mjs"]), judgePrep.prepared.ws);
    const judgeRec = recordCall(s.cfg, judgePrep.prepared.ws);
    assert.equal(judgeRec.code, EXIT.done, judgeRec.message);
    const judgeAudit = JSON.parse(git(s.records, "show", `HEAD:${judgeRec.handoff.audit.file}`));
    assert.equal(judgeAudit.duplicateSuiteRuns.length, 1);

    const actorWarm = s.run("actor", { round: 2, base: greenSha, prepare: true });
    assert.equal(actorWarm.code, EXIT.done, actorWarm.message);
    assert.equal(existsSync(join(actorWarm.prepared.ws, "suite-receipt.json")), true);
    assert.equal(runCount(), 2);

    put(actorWarm.prepared.wt, "src/a.js", "export const a = 42;\n");
    git(actorWarm.prepared.wt, "add", "src/a.js");
    const nextTree = git(actorWarm.prepared.wt, "write-tree");
    git(actorWarm.prepared.wt, "reset", "-q");
    const existingHit = lookupSuiteReceipt({ repo: s.product, sha: greenSha, command: "node --test test/suite.test.mjs" });
    const stored = JSON.parse(readFileSync(existingHit.receiptPath, "utf8"));
    const forgedKey = { ...stored.key, tree: nextTree };
    const forgedHash = createHash("sha256").update(JSON.stringify([
      forgedKey.repository, forgedKey.tree, forgedKey.command, forgedKey.install ?? null, forgedKey.execution ?? null,
      [forgedKey.runtime?.node ?? null, forgedKey.runtime?.platform ?? null, forgedKey.runtime?.arch ?? null],
    ])).digest("hex");
    const forgedDir = join(suiteStore(s.product), forgedHash);
    mkdirSync(forgedDir, { recursive: true });
    const fakeLog = "$ node --test test/suite.test.mjs\nℹ tests 1\nℹ pass 1\nℹ fail 0\nℹ cancelled 0\nexit 0\n";
    writeFileSync(join(forgedDir, "999-poison.log.gz"), gzipSync(fakeLog));
    writeFileSync(join(forgedDir, "999-poison.json"), `${JSON.stringify({
      ...stored, tree: nextTree, key: forgedKey, green: true, exit: 0, reasons: [],
      log: { sha256: createHash("sha256").update(fakeLog).digest("hex"), bytes: Buffer.byteLength(fakeLog) },
    }, null, 1)}\n`);

    put(actorWarm.prepared.ws, "out/report.md", "# R-0002-actor\n\nUpdated a.js.\n");
    bumpAfter(writeCodex(codexHome, "actor-poison-sess", actorWarm.prepared.prompt, actorWarm.prepared.wt), actorWarm.prepared.ws);
    const actorRec = recordCall(s.cfg, actorWarm.prepared.ws);
    assert.equal(actorRec.code, EXIT.done, actorRec.message);
    const newSha = actorRec.handoff.product.commit;
    assert.notEqual(newSha, greenSha);
    assert.equal(lookupSuiteReceipt({ repo: s.product, sha: newSha, command: "node --test test/suite.test.mjs" }), null);

    const bare = temp("cu-bare-");
    git(bare, "init", "-q", "--bare");
    git(s.product, "remote", "set-url", "origin", bare);
    put(s.records, "loop.json", JSON.stringify({
      product: s.product, records: s.records, workDir: s.cfg.workDir, phase: "S5", branch: "loop/s5",
      briefs: s.cfg.briefs, agents: s.cfg.agents, protected: ["main"],
      gates: { remote: "origin", require: [], suite: "node --test test/suite.test.mjs" },
    }, null, 2) + "\n");
    commitAll(s.records, "commit loop.json");
    const store = ownerStore([{ name: "unify", records: s.records }]);

    const missPush = spawnSync(process.execPath, [
      join(scripts, "gated-push.mjs"), "--repo", s.product, "--branch", "work", "--sha", newSha, "--owner-store", store,
    ], { encoding: "utf8" });
    assert.equal(missPush.status, 2);
    assert.match(missPush.stderr, /no verified cached green suite receipt/);

    const ranNew = suiteGreen({ repo: s.product, sha: newSha, command: "node --test test/suite.test.mjs", format: "node-test" });
    assert.equal(ranNew.green, true);
    const hitPush = spawnSync(process.execPath, [
      join(scripts, "gated-push.mjs"), "--repo", s.product, "--branch", "work", "--sha", newSha, "--owner-store", store,
    ], { encoding: "utf8" });
    assert.equal(hitPush.status, 0, hitPush.stderr);
    assert.equal(git(bare, "rev-parse", "refs/heads/work"), newSha);

    const noSuiteRec = repo({
      "records.json": "{}\n",
      "loop.json": JSON.stringify({
        product: s.product, records: ".", workDir: temp("cu-nosuite-work-"), phase: "S5",
        briefs: {}, agents: {}, protected: ["main"], gates: { remote: "origin", require: [] },
      }, null, 2) + "\n",
    });
    const noSuiteStore = ownerStore([{ name: "nosuite", records: noSuiteRec }]);
    const noSuitePush = spawnSync(process.execPath, [
      join(scripts, "gated-push.mjs"), "--repo", s.product, "--branch", "work", "--sha", newSha, "--owner-store", noSuiteStore,
    ], { encoding: "utf8" });
    assert.equal(noSuitePush.status, 2);
    assert.match(noSuitePush.stderr, /has no gates\.suite/);
  } finally {
    if (oldCodex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodex;
  }
});
