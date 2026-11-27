// F-0008, D-0016, D-0064
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { proseLines } from "../lib/comments.mjs";
import { EXIT, recordCall } from "../call.mjs";
import { check } from "../records-check.mjs";
import { parseHandoffs } from "../lib/handoff.mjs";
import { git, grepTree, redOn, scripts, setup, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");

const handoffs = records => parseHandoffs(git(records, "show", "HEAD:metrics/handoffs.jsonl")).filter(h => h.step !== "reviewer-frame");
const viewOf = r => join(r.ws, "records");
const committed = records => git(records, "ls-tree", "-r", "--name-only", "HEAD").split("\n");

test("a call runs the agent once and commits exactly its hand-off: record, evidence, its line and the index", async () => {
  const s = await setup({ critic: [{ write: { "test/b.test.js": "export const attack = 1;\n", "ws:out/cases.json": "[1]\n" } }] });
  const before = git(s.records, "rev-parse", "HEAD");
  const r = s.run("critic");
  assert.equal(r.code, EXIT.done, r.message);
  assert.deepEqual(s.counts(), { critic: 1 });
  const changed = git(s.records, "diff", "--name-only", before, "HEAD").split("\n").sort();
  assert.deepEqual(changed, ["INDEX.md", "evidence/0001/critic-1-audit.json", "evidence/0001/critic-1.log.gz", "evidence/0001/critic-1/out/cases.json", "metrics/handoffs.jsonl", "rounds/0001-critic.md"]);
  assert.equal(git(s.records, "rev-list", "--count", `${before}..HEAD`), "1", "one records commit");
  const [h] = handoffs(s.records);
  assert.equal(h.id, "R-0001-critic");
  assert.deepEqual(h.features, ["F-0001"]);
  assert.equal(h.view, before, "the view commit the role read");
  assert.deepEqual(h.files.sort(), changed.filter(p => !["INDEX.md", "metrics/handoffs.jsonl"].includes(p)));
  assert.equal(h.product.base, git(s.product, "rev-parse", "loop/s5~1"));
  assert.equal(h.product.commit, git(s.product, "rev-parse", "loop/s5"), "owned change committed, branch moved");
  assert.equal(git(s.product, "show", "--name-only", "--format=", "loop/s5"), "test/b.test.js");
  const record = readFileSync(join(s.records, "rounds/0001-critic.md"), "utf8");
  assert.match(record, /## Task \(verbatim\)\n\n```text\nTask for the critic\.\nfeatures: F-0001\n```/);
  assert.match(record, /## Report \(verbatim\)\n\ncritic report 0/);
  assert.deepEqual(check(s.records).failures, [], "the lead's read-only check agrees with the committed index");
  assert.equal(git(s.records, "status", "--porcelain"), "");
  assert.equal(git(s.product, "worktree", "list").split("\n").length, 1, "worktree removed");
});

test("a CLI actor with an unclassified comment awaits independent resolution with evidence and leaves the product alone", async () => {
  const s = await setup({ actor: [{ write: { "src/new.js": "export const n = 1; // Explain the constant.\n", "src/a.js": "// D-0016\nexport const a = 1;\n" } }] });
  const before = git(s.product, "rev-parse", "loop/s5");
  const r = s.run("actor");
  assert.equal(r.code, EXIT.records, r.message);
  assert.match(r.message, /src\/new\.js:1: pending independent resolution/);
  assert.doesNotMatch(r.message, /src\/a\.js/);
  assert.equal(git(s.product, "rev-parse", "loop/s5"), before);
  assert.deepEqual(handoffs(s.records), []);
  const evidence = JSON.parse(git(s.records, "show", "HEAD:evidence/0001/actor-1-comments.json"));
  assert.deepEqual(evidence.prose, proseLines("src/new.js", "export const n = 1; // Explain the constant.\n"));
  assert.match(r.message, /No prose verdict for pending candidates/);
  assert.equal(git(s.product, "worktree", "list").split("\n").length, 1, "a CLI call has no retry, so its worktree goes");
});

test("the call decides nothing: a CONVERGED ruling is recorded as text, with no verdict field and no next step", async () => {
  const s = await setup({ judge: [{ report: "VERDICT: CONVERGED\nSUITE: 0/3\n" }] });
  const r = s.run("judge");
  assert.equal(r.code, EXIT.done);
  const [h] = handoffs(s.records);
  for (const key of ["verdict", "unmet", "opened", "closed", "ci", "next"]) assert.equal(h[key], undefined, key);
});

test("one call is one agent run: a report saying `FACT-NEEDED: none.` costs no second call", async () => {
  assert.deepEqual(redOn("one-call"), { reviewerCalls: 2 });
  const s = await setup({ reviewer: [{ report: "VERDICT: CONTINUE\nFACT-NEEDED: none. Everything needed is in the records.\n" }] }, { frame: false });
  assert.equal(s.run("reviewer", { step: "reviewer-frame" }).code, EXIT.done);
  assert.deepEqual(s.counts(), { reviewer: 1 });
});

test("feature declarations are checked against regular feature files in the exact role view before any model runs", async () => {
  const path = "blueprint/F-0001.md";
  const s = await setup({ reviewer: [{ report: "Frame report." }] }, { recordFiles: { [path]: "# F-0001 Feature\n" } });
  const staged = "blueprint/F-0002.md";
  writeFileSync(join(s.records, staged), "# F-0002 Draft\n");
  git(s.records, "add", "--", staged);
  for (const task of ["No feature field.\n", "features: F-0002\n", "features: none\n",
    "features: F-0001, invalid\n", "```text\nfeatures: F-0001\n```\n"]) {
    const rejected = s.run("critic", { task });
    assert.equal(rejected.code, EXIT.records, rejected.message);
    assert.match(rejected.message, /features:/);
    assert.equal(rejected.ws, undefined);
  }
  assert.deepEqual(s.counts(), {});
  const reviewer = s.run("reviewer", { task: "Mode: FRAME.\nfeatures: none\n" });
  assert.equal(reviewer.code, EXIT.done, reviewer.message);
  assert.deepEqual(handoffs(s.records)[0].features, []);
  assert.ok(existsSync(join(viewOf(reviewer), path)));
  git(s.records, "commit", "-qm", "Publish another feature", "--", staged);
  const accepted = s.run("critic", { task: "features: F-0001, F-0002\r\nAdvance both.\r\n" });
  assert.equal(accepted.code, EXIT.done, accepted.message);
  assert.deepEqual(handoffs(s.records)[1].features, ["F-0001", "F-0002"]);
  const oldView = s.run("actor", { task: "features: F-0002\n", view: "HEAD~2", dry: true });
  assert.equal(oldView.code, EXIT.records, oldView.message);
});

test("a record number already taken is refused before any model call", async () => {
  assert.deepEqual(redOn("taken-number"), { code: 7, reviewerCalls: 1 });
  const s = await setup({}, { recordFiles: { "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nOlder record.\n" } });
  const r = s.run("reviewer", { step: "reviewer-frame" });
  assert.equal(r.code, EXIT.records);
  assert.match(r.message, /already exists.*no model was called/);
  assert.deepEqual(s.counts(), {});
});

test("a failing setup stops the call before the model runs: no hand-off", async () => {
  assert.deepEqual(redOn("setup-failed-handoff"), { criticHandoff: true, critic: 1, code: "handoff" });
  const s = await setup({}, { setup: [["sh", "-c", "exit 19"]] });
  const head = git(s.records, "rev-parse", "HEAD");
  const r = s.run("critic");
  assert.equal(r.code, EXIT.failure);
  assert.match(r.message, /setup `sh -c exit 19` exited 19.*no model was called/);
  assert.deepEqual(s.counts(), {});
  assert.equal(git(s.records, "rev-parse", "HEAD"), head);
  assert.equal(git(s.product, "worktree", "list").split("\n").length, 1);
});

test("usage refusals: codex and t3:codex frame reviewer, the cmd stand-in outside tests, protected base branch, a step of another role, an uncommitted brief", async () => {
  const s = await setup({});
  delete process.env.SELF_LOOP_TEST;
  try { assert.match(s.run("critic").message, /cmd runner is a test stand-in.*SELF_LOOP_TEST=1/); } finally { process.env.SELF_LOOP_TEST = "1"; }
  s.cfg.agents.reviewer = { runner: "codex" };
  const cliCodex = s.run("reviewer");
  assert.equal(cliCodex.code, EXIT.usage);
  assert.match(cliCodex.message, /cannot run on codex/);
  s.cfg.agents.reviewer = { runner: "t3", provider: "codex" };
  const t3Codex = s.run("reviewer", { prepare: true });
  assert.equal(t3Codex.code, EXIT.usage);
  assert.match(t3Codex.message, /cannot run on t3:codex/);
  assert.equal(s.run("critic", { base: "main" }).code, EXIT.usage);
  assert.equal(s.run("critic", { step: "actor-x" }).code, EXIT.usage);
  writeFileSync(join(s.records, "engines/new.md"), "# new\n");
  s.cfg.briefs.critic = "engines/new.md";
  assert.match(s.run("critic").message, /not committed in the records/);
  assert.deepEqual(s.counts(), {});
});

test("an older judge report under rounds/ with no hand-off is not in any view, unless the lead imports it as public", async () => {
  assert.deepEqual(redOn("legacy-judge-in-view"), { inCriticView: true });
  const legacy = "# R-0002-judge\n\nHeld-out case 07 expects SYNTHETIC_HELDOUT_311.\n";
  const s = await setup({}, { recordFiles: { "rounds/0002-judge.md": legacy, "rounds/0003-critic.md": "# R-0003-critic\n\nPUBLIC_OLD_CRITIC\n" } });
  const r = s.run("critic", { dry: true });
  assert.deepEqual(grepTree(viewOf(r), "SYNTHETIC_HELDOUT_311"), []);
  assert.deepEqual(grepTree(viewOf(r), "PUBLIC_OLD_CRITIC"), [], "not imported yet");
  writeFileSync(join(s.records, "records.json"), JSON.stringify({ publicImports: ["rounds/0003-critic.md"] }));
  git(s.records, "add", "records.json"); git(s.records, "commit", "-qm", "import");
  const imported = s.run("actor", { dry: true });
  assert.ok(grepTree(viewOf(imported), "PUBLIC_OLD_CRITIC").length, "the lead's explicit import is visible");
  assert.deepEqual(grepTree(viewOf(imported), "SYNTHETIC_HELDOUT_311"), []);
});

test("the judge's public record is its out/public.md only: no line of the private report reaches another role", async () => {
  assert.deepEqual(redOn("private-header-in-public"), { inPublicRecord: true });
  const report = "VERDICT: CONTINUE\nSHA: x\nSUITE: 1/0\nOPENED: -\nCLOSED: -\nACCEPTANCE: -\nPRIVATE-NOTE: SYNTHETIC_SEALED_909\n\n# Ruling\n\nHeld-out case 07 expects CANNED_KEY_230.\n";
  const s = await setup({ judge: [{ report, write: { "ws:out/public.md": "Key rotation loses a member's key under concurrent writes (property).\n" } }] });
  assert.equal(s.run("judge").code, EXIT.done);
  const pub = readFileSync(join(s.records, "rounds/0001-judge.md"), "utf8");
  assert.ok(pub.includes("loses a member's key"));
  for (const marker of ["SYNTHETIC_SEALED_909", "CANNED_KEY_230", "Task for the judge", s.sealed]) assert.ok(!pub.includes(marker), marker);
  const sealedRecord = readFileSync(join(s.records, "sealed/judge/0001/judge-1.md"), "utf8");
  assert.ok(sealedRecord.includes("SYNTHETIC_SEALED_909") && sealedRecord.includes("Task for the judge"), "the full record is kept, sealed");
  assert.ok(existsSync(join(s.records, "sealed/judge/0001/judge-1.log.gz")), "the judge's log is sealed too");
  for (const role of ["critic", "actor", "reviewer"]) {
    const r = s.run(role, { round: 2, dry: true });
    for (const marker of ["SYNTHETIC_SEALED_909", "CANNED_KEY_230", "SEALED_CASE_07"]) assert.deepEqual(grepTree(r.ws, marker), [], `${role}: ${marker}`);
    assert.ok(readFileSync(join(viewOf(r), "rounds/0001-judge.md"), "utf8").includes("loses a member's key"), `${role} sees the public ruling`);
    assert.equal(existsSync(join(viewOf(r), "sealed")), false);
  }
  mkdirSync(join(s.records, "sealed/cases"), { recursive: true });
  writeFileSync(join(s.records, "sealed/cases/case-09.md"), "CRITIC_HELDOUT_909\n");
  git(s.records, "add", "sealed/cases/case-09.md"); git(s.records, "commit", "-qm", "a held-out case");
  const judge = s.run("judge", { round: 2, dry: true });
  assert.ok(readFileSync(join(viewOf(judge), "sealed/judge/0001/judge-1.md"), "utf8").includes("SYNTHETIC_SEALED_909"));
  assert.deepEqual(grepTree(judge.ws, "CRITIC_HELDOUT_909"), [], "other sealed records stay out of the judge's view");
  assert.deepEqual(grepTree(viewOf(judge), "SEALED_CASE_07"), [], "the sealed repository is given by path, not copied");
});

test("a committed symlink never enters a view", async () => {
  assert.deepEqual(redOn("symlink-in-view"), { symlinkInView: true, readsOutside: true });
  const secret = join(temp(), "owner-private.md");
  writeFileSync(secret, "OWNER_PRIVATE_515\n");
  const s = await setup({});
  mkdirSync(join(s.records, "research"));
  symlinkSync(secret, join(s.records, "research/notes.md"));
  git(s.records, "add", "research/notes.md"); git(s.records, "commit", "-qm", "symlink");
  const r = s.run("reviewer", { dry: true });
  assert.equal(existsSync(join(viewOf(r), "research/notes.md")), false);
  assert.deepEqual(grepTree(r.ws, "OWNER_PRIVATE_515"), []);
});

test("ignored, staged and uncommitted drafts, briefs, evidence and the records' own index are not in a view", async () => {
  const s = await setup({}, { recordFiles: { ".gitignore": "purpose/local-draft.md\n", "evidence/0001/raw.log": "EVIDENCE_RAW\n", "INDEX.md": "# stale INDEX_FROM_COMMIT\n" } });
  writeFileSync(join(s.records, "purpose/local-draft.md"), "IGNORED_DRAFT\n");
  writeFileSync(join(s.records, "purpose/P-0009.md"), "# P-0009 UNCOMMITTED_DRAFT\n");
  writeFileSync(join(s.records, "purpose/P-0010.md"), "# P-0010 STAGED_DRAFT\n");
  git(s.records, "add", "purpose/P-0010.md");
  writeFileSync(join(s.records, "engines/frame-reviewer.md"), "# changed but not committed: WORKING_BRIEF\n");
  const r = s.run("reviewer", { dry: true });
  for (const needle of ["IGNORED_DRAFT", "UNCOMMITTED_DRAFT", "STAGED_DRAFT", "WORKING_BRIEF", "EVIDENCE_RAW", "INDEX_FROM_COMMIT"]) assert.deepEqual(grepTree(r.ws, needle), [], needle);
  assert.equal(existsSync(join(viewOf(r), "engines")), false, "briefs come as brief.md, not through the view");
  assert.ok(readFileSync(join(r.ws, "purpose/docs/PURPOSE.md"), "utf8").includes("Books survive"), "the reviewer gets the product's purpose");
  const viewIndex = readFileSync(join(viewOf(r), "INDEX.md"), "utf8");
  assert.ok(!/engines\/|evidence|P-0010/.test(viewIndex), "the view's index names only what the view holds");
});

test("an unrelated staged file stays staged and out of the hand-off commit and its index", async () => {
  assert.deepEqual(redOn("index-lists-staged"), { indexListsStaged: true, committed: false });
  const s = await setup({});
  mkdirSync(join(s.records, "lessons"));
  writeFileSync(join(s.records, "lessons/L-0007.md"), "# L-0007\napplies-to: product\n");
  git(s.records, "add", "lessons/L-0007.md");
  assert.equal(s.run("reviewer").code, EXIT.done);
  assert.ok(!committed(s.records).includes("lessons/L-0007.md"));
  assert.ok(!git(s.records, "show", "HEAD:INDEX.md").includes("L-0007"));
  assert.equal(git(s.records, "diff", "--cached", "--name-only"), "lessons/L-0007.md", "still staged, for the lead");
});

test("raw files the role wrote under out/ are recorded with the hand-off", async () => {
  assert.deepEqual(redOn("raw-artifact"), { rawCommitted: false });
  const s = await setup({ actor: [{ report: "Measured: see out/raw-trial.json", write: { "ws:out/raw-trial.json": "{\"latencyMs\":[812,790]}\n" } }] });
  assert.equal(s.run("actor").code, EXIT.done);
  assert.equal(git(s.records, "show", "HEAD:evidence/0001/actor-1/out/raw-trial.json"), "{\"latencyMs\":[812,790]}");
  assert.ok(handoffs(s.records)[0].files.includes("evidence/0001/actor-1/out/raw-trial.json"));
});

test("a failed call commits only its numbered evidence; a retry keeps the first attempt's", async () => {
  const s = await setup({ critic: [{ exit: 3 }, {}] });
  const r1 = s.run("critic");
  assert.equal(r1.code, EXIT.failure);
  assert.match(r1.message, /exited 3.*no hand-off/);
  assert.ok(committed(s.records).includes("evidence/0001/critic-1-audit.json"));
  assert.ok(!committed(s.records).includes("rounds/0001-critic.md") && handoffs(s.records).length === 0);
  assert.equal(git(s.product, "rev-parse", "loop/s5"), git(s.product, "rev-parse", "main"), "the product did not move");
  const r2 = s.run("critic");
  assert.equal(r2.code, EXIT.done, r2.message);
  assert.equal(handoffs(s.records)[0].attempt, 2);
  assert.ok(committed(s.records).includes("evidence/0001/critic-1-audit.json") && committed(s.records).includes("evidence/0001/critic-2-audit.json"));
  assert.equal(git(s.records, "status", "--porcelain"), "");
});

test("a certain access to a sealed root or the records repository stops the call: audit committed, no hand-off", async () => {
  const s = await setup({});
  s.scenarioSet({ actor: [{ events: [{ name: "Read", input: { file_path: join(s.sealed, "case-07.mjs") } }] }],
    critic: [{ events: [{ name: "Read", input: { file_path: join(s.records, "engines/judge.md") } }] }] });
  const r = s.run("actor");
  assert.equal(r.code, EXIT.violation);
  assert.equal(JSON.parse(git(s.records, "show", "HEAD:evidence/0001/actor-1-audit.json")).violations[0].path, join(s.sealed, "case-07.mjs"));
  assert.equal(s.run("critic").code, EXIT.violation, "the records repository itself is read only through the view");
  assert.ok(handoffs(s.records).length === 0);
});

test("the actor's changes outside its owned paths and its own commits are not taken; they are reported", async () => {
  const s = await setup({ actor: [{ write: { "src/b.js": "export const b = 2;\n", "other.txt": "not owned\n" }, git: [["add", "-A"], ["commit", "-qm", "agent commit"]] }] });
  assert.equal(s.run("actor").code, EXIT.done);
  const [h] = handoffs(s.records);
  assert.deepEqual(h.product.outside, ["other.txt"]);
  const tree = git(s.product, "ls-tree", "-r", "--name-only", "loop/s5");
  assert.ok(tree.includes("src/b.js") && !tree.includes("other.txt"));
  assert.match(git(s.product, "log", "-1", "--format=%s", "loop/s5"), /R-0001-actor/);
});

test("the records check refuses a hand-off line naming a file the records do not hold, or a second line for one record", async () => {
  const s = await setup({}, { frame: false });
  assert.equal(s.run("reviewer").code, EXIT.done);
  const line = git(s.records, "show", "HEAD:metrics/handoffs.jsonl");
  const h = JSON.parse(line);
  writeFileSync(join(s.records, "metrics/handoffs.jsonl"), `${line}\n${JSON.stringify({ ...h, round: 2, id: "R-0002-reviewer", record: "rounds/0002-reviewer.md", files: ["rounds/0002-reviewer.md"] })}\n`);
  assert.match(check(s.records).failures.map(f => f.detail).join(), /R-0002-reviewer names rounds\/0002-reviewer\.md, which the records do not hold/);
  writeFileSync(join(s.records, "metrics/handoffs.jsonl"), `${line}\n${line}\n`);
  assert.match(check(s.records).failures.map(f => f.detail).join(), /two hand-offs for rounds\/0001-reviewer\.md/);
  assert.match(s.run("critic").message, /uncommitted changes/, "and a call refuses to build on it");
  assert.deepEqual(s.counts(), { reviewer: 1 });
});

test("dry run: the workspace and prompt are built, nothing is called or recorded, no worktree is left", async () => {
  const s = await setup({});
  const head = git(s.records, "rev-parse", "HEAD");
  const r = s.run("judge", { dry: true });
  assert.equal(r.code, EXIT.done);
  assert.deepEqual(s.counts(), {});
  assert.equal(git(s.records, "rev-parse", "HEAD"), head);
  const prompt = readFileSync(join(r.ws, "prompt.md"), "utf8");
  assert.ok(prompt.includes(s.sealed), "only the judge is told where the held-out cases are");
  assert.ok(!readFileSync(join(s.run("actor", { dry: true }).ws, "prompt.md"), "utf8").includes(s.sealed));
  assert.equal(lstatSync(join(r.ws, "task.md")).isFile(), true);
  assert.equal(git(s.product, "worktree", "list").split("\n").length, 1);
});

test("CLI, run from inside a git hook: inherited GIT_INDEX_FILE / GIT_DIR never redirect the call's git commands", async () => {
  const s = await setup({}, { frame: false });
  const decoy = temp();
  git(decoy, "init", "-q");
  const config = join(s.dir, "loop.json");
  writeFileSync(config, JSON.stringify(s.cfg));
  const task = join(s.dir, "task.md");
  writeFileSync(task, "Mode: FRAME.\nfeatures: none\n");
  const r = spawnSync(process.execPath, [join(scripts, "call.mjs"), config, "reviewer", "--round", "1", "--step", "reviewer-frame", "--task", task],
    { encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: join(decoy, ".git", "index"), GIT_DIR: join(decoy, ".git") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).id, "R-0001-reviewer-frame");
  assert.ok(committed(s.records).includes("rounds/0001-reviewer-frame.md"));
  assert.equal(git(s.records, "status", "--porcelain"), "");
  assert.equal(existsSync(join(decoy, ".git", "index")), false, "the decoy's index was never written");
  const usage = spawnSync(process.execPath, [join(scripts, "call.mjs"), config, "reviewer"], { encoding: "utf8" });
  assert.equal(usage.status, 64);
  const env = { ...process.env };
  delete env.SELF_LOOP_TEST;
  const refused = spawnSync(process.execPath, [join(scripts, "call.mjs"), config, "reviewer", "--round", "2", "--task", task], { encoding: "utf8", env });
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /SELF_LOOP_TEST=1/);
  assert.deepEqual(s.counts(), { reviewer: 1 }, "refused before the stand-in ran");
});

test("codex sandbox: workspace-write by default, danger-full-access only when the agent config names it, anything else refused", async () => {
  const { argv } = await import("../call.mjs");
  const base = { runner: "codex", model: "m" };
  assert.ok(argv(base, { confined: false, cwd: ".", addDirs: [] })[1].includes('sandbox_mode="workspace-write"'));
  assert.ok(argv({ ...base, sandbox: "danger-full-access" }, { confined: false, cwd: ".", addDirs: [] })[1].includes('sandbox_mode="danger-full-access"'));
  assert.throws(() => argv({ ...base, sandbox: "read-only-ish" }, { confined: false, cwd: ".", addDirs: [] }));
});

test("actor design replaces the current design in the same hand-off as the original evidence", async () => {
  const s = await setup({ actor: [{ write: { "ws:out/design/records.md": "# Current records\n" } }] },
    { recordFiles: { "design/records.md": "# Old records\n" } });
  const r = s.run("actor");
  assert.equal(r.code, EXIT.done, r.message);
  assert.equal(git(s.records, "show", "HEAD^:design/records.md"), "# Old records");
  assert.equal(git(s.records, "show", "HEAD:design/records.md"), "# Current records");
  assert.equal(git(s.records, "show", "HEAD:evidence/0001/actor-1/out/design/records.md"), "# Current records");
  assert.match(git(s.records, "show", "HEAD:INDEX.md"), /design\/records.md.*Current records/);
  assert.ok(r.handoff.files.includes("design/records.md"));
  assert.equal(git(s.records, "status", "--porcelain"), "");
});

test("out/design accepts only an actor's direct design files", async () => {
  for (const [role, path] of [["actor", "design/nested/area.md"], ["actor", "design/area.txt"], ["critic", "design/area.md"]]) {
    const s = await setup({ [role]: [{ write: { ["ws:out/" + path]: "# Design\n" } }] });
    const r = s.run(role);
    assert.equal(r.code, EXIT.records, r.message);
    assert.match(r.message, /out\/design/);
    assert.ok(handoffs(s.records).length === 0);
  }
});

test("a failed actor keeps the proposed design in evidence without replacing current design", async () => {
  const s = await setup({ actor: [{ exit: 3, write: { "ws:out/design/records.md": "# Proposed\n" } }] },
    { recordFiles: { "design/records.md": "# Current\n" } });
  assert.equal(s.run("actor").code, EXIT.failure);
  assert.equal(git(s.records, "show", "HEAD:design/records.md"), "# Current");
  assert.equal(git(s.records, "show", "HEAD:evidence/0001/actor-1/out/design/records.md"), "# Proposed");
});

test("adversarial calls and T3 preparation require a committed frame hand-off for the current phase", async () => {
  const s = await setup({}, { frame: false });
  assert.equal(s.run("reviewer", { step: "reviewer-frame" }).code, EXIT.done);
  s.cfg.phase = "S6";
  for (const role of ["critic", "actor", "judge"]) {
    const cli = s.run(role);
    assert.equal(cli.code, EXIT.records, cli.message);
    assert.match(cli.message, /S6.*reviewer-frame/);
    s.cfg.agents[role] = { runner: "t3", provider: "codex" };
    const t3 = s.run(role, { prepare: true });
    assert.equal(t3.code, EXIT.records, t3.message);
    assert.match(t3.message, /S6.*reviewer-frame/);
  }
  assert.deepEqual(s.counts(), { reviewer: 1 });
  const oldView = git(s.records, "rev-parse", "HEAD");
  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-diagnosis" }).code, EXIT.done);
  assert.equal(s.run("actor", { round: 2, prepare: true }).code, EXIT.records);
  assert.equal(s.run("reviewer", { round: 2, step: "reviewer-frame" }).code, EXIT.done);
  const prepared = s.run("actor", { round: 2, view: oldView, prepare: true });
  assert.equal(prepared.code, EXIT.done, prepared.message);
  assert.equal(JSON.parse(readFileSync(join(prepared.prepared.ws, "call.json"), "utf8")).phase, "S6");
});

test("D-0064 T9 & D-0067: recordCall skips out/tmp and nested .git, auto-prunes wt/, and injects ssotHint for critic", async () => {
  const s = await setup({}, {
    ssot: { entries: [{ id: "purpose", doc: "docs/PURPOSE.md", watch: ["src/**"], mode: "same-batch" }] },
  });
  s.cfg.configFile = join(s.records, "loop.json");
  writeFileSync(s.cfg.configFile, JSON.stringify({
    product: s.product, records: ".", workDir: s.cfg.workDir, branch: s.cfg.branch, phase: s.cfg.phase,
    briefs: s.cfg.briefs, agents: s.cfg.agents, ssot: s.cfg.ssot,
  }, null, 2) + "\n");
  const criticDry = s.run("critic", { dry: true });
  assert.equal(criticDry.code, EXIT.done, criticDry.message);
  const statusFile = join(criticDry.ws, "ssot-status.md");
  assert.equal(existsSync(statusFile), true);
  assert.equal(statSync(statusFile).mode & 0o777, 0o444);
  assert.match(readFileSync(join(criticDry.ws, "prompt.md"), "utf8"), /SSOT status at .*read ssot-status\.md before reviewing/);

  s.cfg.agents.judge = { runner: "t3", provider: "codex", model: "gpt-5.4" };
  const prep = s.run("judge", { round: 2, prepare: true });
  assert.equal(prep.code, EXIT.done, prep.message);
  const { ws, wt, prompt: childPrompt } = prep.prepared;
  assert.equal(existsSync(wt), true);
  assert.ok(git(s.product, "worktree", "list").includes(wt));

  writeFileSync(join(ws, "out", "report.md"), "VERDICT: CONVERGED\nACCEPTANCE: pass\n");
  writeFileSync(join(ws, "out", "public.md"), "All checks pass.\n");
  writeFileSync(join(ws, "out", "evidence.json"), '{"ok":true}\n');
  mkdirSync(join(ws, "out", "tmp", "scratch-repo", ".git"), { recursive: true });
  writeFileSync(join(ws, "out", "tmp", "scratch-repo", ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(ws, "out", "tmp", "scratch.txt"), "ignore me\n");
  mkdirSync(join(ws, "out", "nested-repo", ".git"), { recursive: true });
  writeFileSync(join(ws, "out", "nested-repo", ".git", "config"), "[core]\n");
  writeFileSync(join(ws, "out", "nested-repo", "keep.txt"), "kept\n");
  mkdirSync(join(ws, "out", "gitfile-dir"), { recursive: true });
  writeFileSync(join(ws, "out", "gitfile-dir", ".git"), "gitdir: /tmp/x\n");

  const txFile = join(temp("t9-tx-"), "codex.jsonl");
  const lines = [
    { type: "session_meta", payload: { id: "sess-t9-1", cwd: wt } },
    { type: "turn_context", payload: { model: "gpt-5.4" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: childPrompt }] } },
    { type: "event_msg", payload: { type: "task_complete" } },
  ];
  writeFileSync(txFile, lines.map(l => JSON.stringify(l)).join("\n") + "\n");

  const zombieWt = join(temp("t9-zombie-"), "wt");
  git(s.product, "worktree", "add", "-q", "--detach", zombieWt, "HEAD");
  rmSync(zombieWt, { recursive: true, force: true });
  assert.ok(git(s.product, "worktree", "list", "--porcelain").includes("prunable"));

  const recorded = recordCall(s.cfg, ws, { transcript: txFile });
  assert.equal(recorded.code, EXIT.done, recorded.message);
  const files = committed(s.records);
  assert.ok(files.some(f => f.endsWith("/out/evidence.json")));
  assert.ok(files.some(f => f.endsWith("/out/nested-repo/keep.txt")));
  assert.equal(files.some(f => f.includes("/out/tmp/")), false);
  assert.equal(files.some(f => f.includes("/.git")), false);
  assert.equal(existsSync(wt), false, "wt/ auto-pruned after successful recordCall");
  assert.equal(git(s.product, "worktree", "list").includes(wt), false);
  assert.equal(git(s.product, "worktree", "list", "--porcelain").includes("prunable"), false);
  assert.equal(git(s.product, "worktree", "list").split("\n").length, 1);
});
