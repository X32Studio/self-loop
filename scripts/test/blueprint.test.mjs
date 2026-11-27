import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fakeGh, git, repo, scripts } from "./helpers.mjs";

const feature = (n, fields = "", body = "") => `# F-000${n} 功能 ${n}

id: F-000${n}
phase: A1
requirements: P-0001
${fields}
## 为什么
满足产品需求。

## 做什么
处理记录。

## 设计
${body}
## 验收
`;
const purpose = "# P-0001 管理记录\n\nstatus: active\n";
const eventFile = "metrics/blueprint.jsonl";
const sha = "a".repeat(40);
const receiptPath = "evidence/0001/ci.json";
const receipt = { repository: "example/product", sha, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" },
  runs: { "github-actions/verify": { id: 1, status: "completed", conclusion: "success" } } };
const command = env => (records, name, ...args) => spawnSync(process.execPath, [join(scripts, "blueprint.mjs"), name, "--records", records, ...args], { encoding: "utf8", env });
const run = command(process.env);
const setter = run => (records, status, ...args) => run(records, "set", "--feature", "F-0001", "--status", status, "--by", "lead", "--note", "记录状态", ...args);
const set = setter(run);
const judge = "--round";
// D-0015
const done = [judge, "R-0001-judge"];
const converged = (round, more = {}) => JSON.stringify({ round, phase: "A1", role: "judge", verdict: "CONVERGED", commit: sha, ci: "success", ciReceipt: receiptPath, ...more });

function setup(files = {}) {
  return repo({ "blueprint/F-0001.md": feature(1), "purpose/P-0001.md": purpose, [receiptPath]: JSON.stringify(receipt),
    "rounds/0001-judge.md": "# R-0001-judge\n", "rounds/0002-judge.md": "# R-0002-judge\n",
    "metrics/trajectory.jsonl": [1, 2, 3].map(n => converged(n)).join("\n") + "\n",
    "decisions/D-0001.md": "# D-0001\n\nRetire F-0001.\n", "decisions/D-0002.md": "# D-0002\n\nRetire F-00010.\n", ...files });
}

test("blueprint status derives from events, appending one change without committing", () => {
  const records = setup({ "blueprint/F-0002.md": feature(2).replace("phase: A1", "phase: later") });
  const before = git(records, "rev-parse", "HEAD");
  assert.equal(run(records, "status", "--phase", "A1").status, 2);
  assert.match(run(records, "status").stdout, /F-0001.*未记录/);
  assert.equal(set(records, "building").status, 0);
  const building = readFileSync(join(records, eventFile), "utf8");
  assert.equal(set(records, "building").status, 2);
  assert.equal(readFileSync(join(records, eventFile), "utf8"), building);
  assert.equal(set(records, "done", ...done).status, 0);
  const lines = readFileSync(join(records, eventFile), "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map(e => [e.feature, e.status, e.by, e.note]), ["building", "done"].map(s => ["F-0001", s, "lead", "记录状态"]));
  assert.deepEqual(lines[1].evidence, { round: "R-0001-judge", commit: sha, ci: receiptPath });
  assert.equal(git(records, "rev-parse", "HEAD"), before);
  assert.equal(run(records, "status", "--phase", "A1").status, 0);
  assert.equal(run(records, "status", "--phase", "unknown").status, 2);
  assert.equal(run(records, "status").status, 2);
  assert.equal(run(records, "status", "--phase").status, 64);
  assert.match(run(records, "view").stdout, /F-0001.*done/);
});

test("done, reopening and retiring require resolving evidence", () => {
  const records = setup();
  assert.equal(set(records, "done").status, 2);
  assert.equal(set(records, "done", ...done.slice(0, 1), "R-0009-judge", ...done.slice(2)).status, 2);
  for (const bad of [{ ...receipt, ok: false }, { ...receipt, sha: "b".repeat(40) }, { ...receipt, conclusions: {} }]) {
    writeFileSync(join(records, receiptPath), JSON.stringify(bad));
    assert.equal(set(records, "done", ...done).status, 2);
  }
  assert.equal(existsSync(join(records, eventFile)), false);
  writeFileSync(join(records, receiptPath), JSON.stringify(receipt));
  assert.equal(set(records, "done", ...done).status, 0);
  assert.equal(set(records, "building").status, 2);
  assert.equal(set(records, "building", judge, "R-0001-judge").status, 2);
  assert.equal(set(records, "building", judge, "R-0002-judge").status, 0);
  assert.equal(set(records, "retired", "--decision", "D-0002").status, 2);
  assert.equal(set(records, "retired", "--decision", "D-0001").status, 0);
  assert.match(run(records, "status").stdout, /F-0001.*retired/);
});

test("a done citing a round takes commit and CI from that round's CONVERGED row; the caller supplies neither", () => {
  const tip = "b".repeat(40), tipReceipt = "evidence/0002/ci-tip/receipt.json";
  const rows = [converged(1, { ciReceipt: undefined }), converged(2, { tip, ciReceipt: tipReceipt }),
    JSON.stringify({ round: 3, phase: "A1", role: "judge", verdict: "CONTINUE", commit: sha, ci: "failure" })];
  const records = setup({ "metrics/trajectory.jsonl": rows.join("\n") + "\n", "rounds/0003-judge.md": "# R-0003-judge\n",
    [tipReceipt]: JSON.stringify({ ...receipt, sha: tip }) });
  for (const flags of [["--commit", sha], ["--ci", receiptPath]]) {
    const given = set(records, "done", judge, "R-0002-judge", ...flags);
    assert.equal(given.status, 64, given.stderr);
    assert.match(given.stderr, /takes its commit and CI from R-0002-judge's CONVERGED trajectory row/);
  }
  assert.match(set(records, "done", judge, "R-0003-judge").stderr, /its last judge row says CONTINUE/);
  assert.match(set(records, "done", judge, "R-0001-judge").stderr, /names no ciReceipt/, "a row written before the append read CI carries no receipt");
  assert.equal(existsSync(join(records, eventFile)), false);
  const closed = set(records, "done", judge, "R-0002-judge");
  assert.equal(closed.status, 0, closed.stderr);
  assert.deepEqual(JSON.parse(closed.stdout).evidence, { round: "R-0002-judge", commit: sha, tip, ci: tipReceipt }, "the receipt is the tip's, as the row says");
  assert.equal(set(records, "building", judge, "R-0003-judge", "--commit", sha, "--ci", receiptPath).status, 0);
});

test("baseline done accepts a lead's product anchor pinned to an existing heading", () => {
  const product = repo({ "docs/PRODUCT.md": "# 产品\n\n## 顶层需求\n\n要求。\n\n## 实际验收\n\n已验收。\n" });
  git(product, "remote", "add", "origin", "https://github.com/example/product.git");
  const ref = git(product, "rev-parse", "--short", "HEAD");
  const head = git(product, "rev-parse", "HEAD");
  const requirement = `docs/PRODUCT.md#顶层需求@${ref}`;
  const loop = JSON.stringify({ product, gates: { require: ["github-actions/verify"] } });
  const records = setup({ "blueprint/F-0001.md": feature(1).replace("P-0001", requirement), [receiptPath]: JSON.stringify({ ...receipt, sha: head }) });
  const gh = fakeGh();
  const lead = command(gh.env), setNow = setter(lead);
  const args = ["--commit", head, "--ci", receiptPath];
  const anchor = `docs/PRODUCT.md#实际验收@${ref}`;
  assert.equal(setNow(records, "done", "--acceptance", anchor, ...args).status, 2, "without a loop there is no product to anchor in and no destination, so no done");
  writeFileSync(join(records, "loop.json"), loop);
  assert.equal(setNow(records, "done", "--acceptance", anchor.replace("实际验收", "缺少"), ...args).status, 2);
  assert.equal(lead(records, "set", "--feature", "F-0001", "--status", "done", "--by", "actor", "--note", "old", "--acceptance", anchor, ...args).status, 2);
  const unread = setNow(records, "done", "--acceptance", anchor, ...args);
  assert.equal(unread.status, 2);
  assert.match(unread.stderr, /a done needs CI success on [0-9a-f]{40}; it is unknown: the CI could not be read .*ci-green\.mjs --repo \S+ --remote origin --sha [0-9a-f]{40} --require github-actions\/verify/);
  gh.serve({ "example/product": { [head]: [{ id: 1, app: "github-actions", name: "verify", status: "completed", conclusion: "failure" }] } });
  assert.match(setNow(records, "done", "--acceptance", anchor, ...args).stderr, /a done needs CI success on [0-9a-f]{40}; it is failure \(github-actions\/verify: completed\/failure\)/);
  gh.serve({ "example/product": { [head]: [{ id: 1, app: "github-actions", name: "verify", status: "completed", conclusion: "success" }] } });
  const accepted = setNow(records, "done", "--acceptance", anchor, ...args);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(run(records, "view").stdout, /实际验收/);
  assert.equal(setNow(records, "building", judge, "R-0002-judge").status, 0);
  assert.equal(setNow(records, "done", "--acceptance", anchor, ...args).status, 2, "a reopening needs a new ruling to close");
  assert.deepEqual(gh.queries(), Array(3).fill(`example/product ${head}`), "one reading per baseline done that passed the offline checks; none for refusals or other events");
});

test("malformed headers, unknown structured references and dependency cycles refuse changes", () => {
  for (const [bad, message] of [
    [feature(1).replace("id: F-0001", "id: F-0010"), /id/],
    [feature(1, "status: done"), /status/],
    [feature(1, "depends: F-0002"), /F-0002/],
    [feature(1, "decisions: D-0008"), /D-0008/],
    [feature(1).replace("P-0001", "P-0008"), /P-0008/],
    [feature(1, "depends: F-0001"), /cycle/],
  ]) {
    const records = setup({ "blueprint/F-0001.md": bad });
    const result = set(records, "planned");
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(existsSync(join(records, eventFile)), false);
  }
});

test("a malformed or orphaned event blocks status and append", () => {
  for (const line of ["{", JSON.stringify({ feature: "F-0099", status: "planned", time: new Date().toISOString(), by: "lead", note: "old", evidence: {} })]) {
    const records = setup({ [eventFile]: line });
    assert.equal(set(records, "building").status, 2);
    assert.equal(run(records, "status").status, 2);
    assert.equal(readFileSync(join(records, eventFile), "utf8"), line);
  }
});

test("the documented phase gate requires every selected feature to be done or retired", () => {
  const records = setup({ "blueprint/F-0002.md": feature(2) });
  const skill = readFileSync(join(scripts, "..", "SKILL.md"), "utf8");
  const gate = skill.split("\n").find(line => line.startsWith("| the phase converged |"));
  assert.match(gate, /blueprint\.mjs status --records <records> --phase <phase>/);
  assert.match(gate, /blueprint status exit 0/);
  assert.match(skill, /out\/blueprint\/F-NNNN\.md/);
  const phase = () => run(records, "status", "--phase", "A1").status;
  assert.equal(phase(), 2);
  assert.equal(set(records, "done", ...done).status, 0);
  assert.equal(phase(), 2, "one completed feature cannot stand in for all features in the phase");
  writeFileSync(join(records, "decisions/D-0001.md"), "# D-0001 Retire F-0002\n");
  const retired = run(records, "set", "--feature", "F-0002", "--status", "retired", "--decision", "D-0001", "--by", "lead", "--note", "Retired");
  assert.equal(retired.status, 0, retired.stderr);
  assert.equal(phase(), 0);
});

test("B1: after reopening, completion must cite a round that never appeared in this feature's evidence", () => {
  const records = setup({ "rounds/0003-judge.md": "# Reopening ruling\n" });
  assert.equal(set(records, "done", judge, "R-0002-judge", ...done.slice(2)).status, 0);
  assert.equal(set(records, "building", judge, "R-0003-judge").status, 0);
  for (const round of ["R-0002-judge", "R-0003-judge"])
    assert.equal(set(records, "done", judge, round, ...done.slice(2)).status, 2);
  const fresh = set(records, "done", judge, "R-0001-judge", ...done.slice(2));
  assert.equal(fresh.status, 0, fresh.stderr);
});

test("B2: completion binds the judge's hand-off to the cited SHA and feature", () => {
  const path = "rounds/0001-judge.md";
  const base = { id: "R-0001-judge", phase: "A1", round: 1, step: "judge", role: "judge", record: path,
    files: [path], view: sha, attempt: 1, agent: { runner: "codex" }, audit: { violations: 0 } };
  const handoffs = "metrics/handoffs.jsonl";
  const given = setup({ "blueprint/F-0002.md": feature(2), [handoffs]: "" });
  const record = (commit, features) => writeFileSync(join(given, handoffs),
    JSON.stringify({ ...base, product: { base: commit, commit }, features }) + "\n");
  record("b".repeat(40), ["F-0001"]);
  assert.equal(set(given, "done", ...done).status, 2);
  record(sha, ["F-0002"]);
  assert.equal(set(given, "done", ...done).status, 2);
  record(sha, ["F-0001"]);
  const allowed = set(given, "done", ...done);
  assert.equal(allowed.status, 0, allowed.stderr);
});

test("B5: the event's phase anchors the alarm when the feature header is moved", () => {
  const records = setup({ "blueprint/F-0002.md": feature(2) });
  assert.equal(set(records, "building").status, 0);
  assert.equal(JSON.parse(readFileSync(join(records, eventFile), "utf8")).phase, "A1");
  const other = run(records, "set", "--feature", "F-0002", "--status", "done", "--by", "lead", "--note", "Done", ...done);
  assert.equal(other.status, 0, other.stderr);
  writeFileSync(join(records, "blueprint/F-0001.md"), feature(1).replace("phase: A1", "phase: later"));
  const gate = run(records, "status", "--phase", "A1");
  assert.equal(gate.status, 0);
  assert.match(gate.stderr, /F-0001.*A1.*later/);
  assert.match(run(records, "view").stdout.split("## 待处理")[1], /F-0001.*A1.*later/);
});

test("D-0064 T10: blueprint set --status done --round accepts independent no-dispute critic convergence and refuses disputed or same-model critics", () => {
  const product = repo({ "src/a.mjs": "export const a = 1;\n" });
  const baseSha = git(product, "rev-parse", "HEAD");
  writeFileSync(join(product, "src/a.mjs"), "export const a = 2;\n");
  git(product, "add", "src/a.mjs");
  git(product, "commit", "-qm", "actor edit");
  const actorSha = git(product, "rev-parse", "HEAD");
  writeFileSync(join(product, "src/a.test.mjs"), "export const t = 1;\n");
  git(product, "add", "src/a.test.mjs");
  git(product, "commit", "-qm", "critic test");
  const criticSha = git(product, "rev-parse", "HEAD");

  const ciPath = "evidence/0002/ci.json";
  const criticRec = "rounds/0002-critic-a.md";
  const criticReport = hdr => `# R-0002-critic-a\n\n## Report (verbatim)\n\n${hdr}\n`;
  const actorH = {
    id: "R-0002-actor-a", time: "2026-11-27T00:00:00Z", phase: "A1", round: 2, step: "actor-a", role: "actor", attempt: 1,
    agent: { runner: "t3:antigravity", model: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", observedModels: ["gemini-2.5-flash"] },
    view: baseSha, product: { base: baseSha, commit: actorSha }, audit: { violations: 0 },
    record: "rounds/0002-actor-a.md", files: ["rounds/0002-actor-a.md"], features: ["F-0001"],
  };
  const criticH = (model, violations = 0) => ({
    id: "R-0002-critic-a", time: "2026-11-27T01:00:00Z", phase: "A1", round: 2, step: "critic-a", role: "critic", attempt: 1,
    agent: { runner: "t3:antigravity", model, observedModel: model, observedModels: [model] },
    view: baseSha, product: { base: actorSha, commit: criticSha }, audit: { violations },
    record: criticRec, files: [criticRec], features: ["F-0001"],
  });
  const records = repo({
    "blueprint/F-0001.md": feature(1),
    "purpose/P-0001.md": purpose,
    "loop.json": JSON.stringify({ product, phase: "A1", judgeIndependence: "model", gates: { require: ["github-actions/verify"] } }),
    [ciPath]: JSON.stringify({ ...receipt, sha: criticSha }),
    "rounds/0002-actor-a.md": "# R-0002-actor-a\n",
    [criticRec]: criticReport("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: -"),
    "metrics/handoffs.jsonl": `${JSON.stringify(actorH)}\n${JSON.stringify(criticH("gemini-2.5-pro"))}\n`,
    "metrics/trajectory.jsonl": `${JSON.stringify({ round: 2, phase: "A1", role: "critic", verdict: "PASS", commit: criticSha, suite: "5/0", ci: "success", ciReceipt: ciPath })}\n`,
  });

  writeFileSync(join(records, criticRec), criticReport("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: D1\nOPENED: -"));
  assert.equal(set(records, "done", "--round", "R-0002-critic-a").status, 2);

  writeFileSync(join(records, criticRec), criticReport("VERDICT: PASS\nACCEPTANCE: pass\nDISPUTES: -\nOPENED: -"));
  writeFileSync(join(records, "metrics/handoffs.jsonl"), `${JSON.stringify(actorH)}\n${JSON.stringify(criticH("gemini-2.5-flash"))}\n`);
  assert.equal(set(records, "done", "--round", "R-0002-critic-a").status, 2);

  writeFileSync(join(records, "metrics/handoffs.jsonl"), `${JSON.stringify(actorH)}\n${JSON.stringify(criticH("gemini-2.5-pro", 1))}\n`);
  assert.equal(set(records, "done", "--round", "R-0002-critic-a").status, 2);

  writeFileSync(join(records, "metrics/handoffs.jsonl"), `${JSON.stringify(actorH)}\n${JSON.stringify(criticH("gemini-2.5-pro", 0))}\n`);
  const ok = set(records, "done", "--round", "R-0002-critic-a");
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  assert.deepEqual(JSON.parse(ok.stdout).evidence, { round: "R-0002-critic-a", commit: criticSha, ci: ciPath });
  assert.equal(run(records, "status", "--phase", "A1").status, 0);
});
