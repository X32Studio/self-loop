import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { check, classify, DEFAULT_LAYOUT, parseLayout } from "../records-check.mjs";
import { git, repo, scripts } from "./helpers.mjs";

const feature = (id, fields = "", design = "") => `# ${id} 规划 | 功能

id: ${id}
phase: A1
requirements: P-0001
${fields}
## 为什么
需要它。

## 做什么
提供功能。

## 设计
${design}

## 验收
`;
const purpose = "# P-0001 保存记录\n\nstatus: active\n";
const inactive = "# P-0003 旧记录\n\nstatus: superseded\n";
const events = "metrics/blueprint.jsonl";
const event = (status, evidence = {}) => JSON.stringify({ feature: "F-0001", status, evidence, time: "2026-11-21T00:00:00Z", by: "lead", note: "Status change" });
const read = (records, file) => readFileSync(join(records, file), "utf8");

test("the blueprint's declared kinds and uncovered purposes in a legacy records repository", () => {
  const layout = parseLayout(readFileSync(DEFAULT_LAYOUT, "utf8"));
  assert.deepEqual(classify(layout, "blueprint/F-0001.md"), { id: "F-0001", kind: "Blueprint", changes: "editable" });
  assert.equal(classify(layout, events).changes, "append-only");
  assert.equal(classify(layout, "BLUEPRINT.md").kind, "Blueprint view");
  const records = repo({ "purpose/P-0001.md": purpose, "purpose/P-0003.md": inactive });
  check(records, { write: true });
  const state = check(records);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.screening.filter(f => f.rule === "blueprint-unserved-purpose").map(f => f.path), ["purpose/P-0001.md"]);
  assert.equal(existsSync(join(records, "BLUEPRINT.md")), false);
});

test("a generated Chinese view is deterministic, includes owner alarms, and detects drift", () => {
  const records = repo({ "purpose/P-0001.md": purpose, "purpose/P-0002.md": purpose.replaceAll("P-0001", "P-0002"),
    "blueprint/F-0001.md": feature("F-0001"), "blueprint/F-0002.md": feature("F-0002", "depends: F-0001"), [events]: event("building") + "\n" });
  let state = check(records);
  assert.ok(state.failures.some(f => f.rule === "blueprint-drift" && /missing/.test(f.detail)));
  assert.equal(existsSync(join(records, "BLUEPRINT.md")), false);
  assert.deepEqual(check(records, { write: true }).failures, []);
  const view = read(records, "BLUEPRINT.md");
  for (const heading of ["顶层需求", "全部功能", "按阶段统计", "待处理"]) assert.match(view, new RegExp(`## ${heading}`));
  assert.match(view, /P-0001 保存记录 \| F-0001、F-0002/);
  assert.ok(view.includes("规划 \\| 功能"));
  assert.match(view, /\| F-0002 .*未记录.*F-0001 \|/);
  assert.match(view, /A1 \| 0 \/ 2/);
  assert.match(view, /P-0002.*没有/);
  assert.match(view, /F-0002.*状态/);
  const cli = spawnSync(process.execPath, [join(scripts, "blueprint.mjs"), "view", "--records", records], { encoding: "utf8" });
  assert.equal(cli.stdout, view);
  git(records, "add", "-A");
  assert.deepEqual(check(records).failures, [], "staging generated views does not change their output");
  writeFileSync(join(records, "BLUEPRINT.md"), view.replace("顶层需求", "编辑"));
  state = check(records);
  assert.deepEqual(state.failures.map(f => f.rule), ["blueprint-drift"]);
  assert.match(state.failures[0].detail, /records-check\.mjs .* --write/);
  assert.deepEqual(check(records, { write: true }).failures, []);
  assert.equal(read(records, "BLUEPRINT.md"), view);
});

test("feature structures and status evidence fail the records check while owner alarms do not", () => {
  const files = { "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001", "depends: F-0002"),
    "blueprint/F-0002.md": feature("F-0002"), [events]: event("building") + "\n" };
  const records = repo(files);
  assert.deepEqual(check(records, { write: true }).failures, []);
  assert.deepEqual(check(records).failures, []);
  writeFileSync(join(records, "blueprint/F-0002.md"), feature("F-0002", "depends: F-0001"));
  writeFileSync(join(records, events), event("done") + "\n");
  const findings = check(records).failures;
  assert.ok(findings.some(f => f.rule === "blueprint-feature" && /cycle/.test(f.detail)));
  assert.ok(findings.some(f => f.rule === "feature-event" && f.line === 1));
});

test("design drift compares only the cited Markdown section at the loop branch tip", () => {
  const product = repo({ "docs/design.md": "# Product\n\n## 记录设计\n\nOriginal.\n\n## Other\n\nOther.\n" });
  const original = git(product, "rev-parse", "HEAD");
  const ref = `docs/design.md#记录设计@${original}`;
  git(product, "switch", "-qc", "loop/a1");
  const records = repo({ "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001", "", `- \`${ref}\``),
    "loop.json": JSON.stringify({ product, branch: "loop/a1" }) });
  check(records, { write: true });
  const edit = (a, b) => {
    writeFileSync(join(product, "docs/design.md"), read(product, "docs/design.md").replace(a, b));
    git(product, "commit", "-qam", "Change design");
  };
  const designAlarms = () => {
    const state = check(records);
    assert.deepEqual(state.failures, []);
    return state.screening.filter(f => f.rule === "blueprint-design-drift");
  };
  edit("Other.", "Unrelated change.");
  assert.deepEqual(designAlarms(), []);
  edit("Original.", "Changed design.");
  git(product, "switch", "-q", "main");
  assert.match(designAlarms()[0].detail, /记录设计/);
});

test("three distinct phase rounds with no named call and a done feature with an unfinished dependency are alarms", () => {
  const sha = "a".repeat(40);
  const receipt = { repository: "test/product", sha, ci: "success", ok: true, missing: [], conclusions: { "github-actions/verify": "success" } };
  const ci = "evidence/0001/ci.json";
  const judge = "rounds/0001-judge.md";
  const handoffs = "metrics/handoffs.jsonl";
  const records = repo({ "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001", "depends: F-0002"),
    "blueprint/F-0002.md": feature("F-0002"), [judge]: "# R-0001-judge",
    [ci]: JSON.stringify(receipt), [events]: event("done", { commit: sha, ci, round: "R-0001-judge" }) + "\n" + event("building").replace("F-0001", "F-0002"),
    [handoffs]: JSON.stringify({ id: "R-0001-judge", round: 1, phase: "A1", role: "judge", step: "judge", attempt: 1,
      view: sha, product: { base: sha, commit: sha }, agent: { runner: "cmd" }, audit: { violations: 0 }, record: judge, files: [judge] }) + "\n",
    "metrics/trajectory.jsonl": [2, 3, 4].map(round => JSON.stringify({ round, phase: round === 4 ? "A2" : "A1", role: "judge" })).join("\n") + "\n" });
  assert.deepEqual(check(records, { write: true }).failures, []);
  const alarms = () => check(records).screening.filter(f => /blueprint-(inactive-building|dependency)/.test(f.rule)).map(f => f.rule);
  assert.deepEqual(alarms().sort(), ["blueprint-dependency", "blueprint-inactive-building"]);
  writeFileSync(join(records, handoffs), read(records, handoffs).replace('"round":1', '"features":["F-0001","F-0002"],"round":1'));
  assert.deepEqual(alarms(), ["blueprint-dependency"]);
});

test("B2: historical judge rounds without hand-offs raise a screening alarm", () => {
  const sha = "a".repeat(40), ci = "evidence/0001/ci.json";
  const records = repo({ "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001"),
    [events]: event("done", { round: "R-0001-judge", commit: sha, ci }) + "\n",
    "rounds/0001-judge.md": "# Old ruling\n",
    [ci]: JSON.stringify({ sha, repository: "fixture", ci: "success", ok: true, missing: [], conclusions: { "fixture/suite": "success" } }),
  });
  const state = check(records, { write: true });
  assert.deepEqual(state.failures, []);
  assert.ok(state.screening.some(f => f.rule === "blueprint-legacy-round" && /R-0001-judge/.test(f.detail)));
});

test("B3: an unreadable product stays an alarm and preserves baseline status, but new baselines need readable evidence", () => {
  const product = repo({ "docs/PRODUCT.md": "# Product\n\n## Requirements\n\n## Acceptance\n" });
  const sha = git(product, "rev-parse", "HEAD"), ci = "evidence/blueprint/ci.json";
  const files = { "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001").replace("P-0001", `docs/PRODUCT.md#Requirements@${sha}`),
    "blueprint/F-0002.md": feature("F-0002"), "loop.json": JSON.stringify({ product }),
    [events]: event("done", { acceptance: `docs/PRODUCT.md#Acceptance@${sha}`, commit: sha, ci }) + "\n",
    [ci]: JSON.stringify({ sha, repository: "fixture", ci: "success", ok: true, missing: [], conclusions: { "fixture/suite": "success" } }),
  };
  const records = repo({ ...files, "records.json": JSON.stringify({ extraKinds: [{ kind: "Blueprint evidence", path: "evidence/blueprint/", changes: "immutable" }] }) });
  const options = { config: JSON.parse(read(records, "records.json")) };
  assert.deepEqual(check(records, { ...options, write: true }).failures, []);
  writeFileSync(join(records, "loop.json"), JSON.stringify({ product: join(product, "gone") }));
  const state = check(records, options);
  assert.deepEqual(state.failures, []);
  assert.equal(state.blueprint.latest.get("F-0001").status, "done");
  assert.equal(state.screening.filter(f => f.rule === "blueprint-unverifiable").length, 2);
  const set = (...args) => spawnSync(process.execPath, [join(scripts, "blueprint.mjs"), "set", "--records", records, "--feature", "F-0002", "--by", "lead", "--note", "Fixture", ...args], { encoding: "utf8" });
  assert.equal(set("--status", "designing").status, 0);
  assert.equal(set("--status", "done", "--acceptance", `docs/PRODUCT.md#Acceptance@${sha}`, "--commit", sha, "--ci", ci).status, 2);
  writeFileSync(join(records, "loop.json"), JSON.stringify({ product }));
  writeFileSync(join(records, "blueprint/F-0001.md"), files["blueprint/F-0001.md"].replace("#Requirements@", "#Absent@"));
  assert.ok(check(records, options).failures.some(f => f.rule === "blueprint-feature" && /unknown requirement/.test(f.detail)));
});

test("B4: sealed paths named in public blueprint records and public JSONL records are screened", () => {
  const sealed = "/private/held-out-fixture";
  const records = repo({ "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001") + `See ${sealed}/case.js.\n`,
    "metrics/trajectory.jsonl": JSON.stringify({ note: `${sealed}/case.js` }) + "\n",
    "rounds/0001-judge.md": `# Private import candidate\n\n${sealed}/case.js\n`,
  });
  const withImport = check(records, { config: { sealed: [sealed], publicImports: ["rounds/0001-judge.md"] }, write: true });
  assert.deepEqual(withImport.screening.filter(f => f.rule === "sealed-path").map(f => f.path).sort(), [
    "blueprint/F-0001.md", "metrics/trajectory.jsonl", "rounds/0001-judge.md",
  ]);
});

test("Opus 6 and 10: the view counts retired features and the check warns about misspelled fields", () => {
  const records = repo({ "purpose/P-0001.md": purpose, "blueprint/F-0001.md": feature("F-0001", "depend: F-0002"),
    "decisions/D-0001.md": "# Retire F-0001", [events]: event("retired", { decision: "D-0001" }) + "\n" });
  const state = check(records, { write: true });
  assert.deepEqual(state.failures, []);
  assert.match(read(records, "BLUEPRINT.md"), /A1 \| 1 \/ 1/);
  assert.ok(state.screening.some(f => f.rule === "blueprint-unknown-field" && /depend/.test(f.detail)));
  const old = read(records, "BLUEPRINT.md").replace("已完成或退役", "已完成").replace("1 / 1", "0 / 1");
  writeFileSync(join(records, "BLUEPRINT.md"), old);
  const migration = check(records);
  assert.deepEqual(migration.failures, []);
  assert.ok(migration.screening.some(f => f.rule === "generated-format" && f.path === "BLUEPRINT.md"));
  writeFileSync(join(records, "BLUEPRINT.md"), old.replace("0 / 1", "0 / 2"));
  assert.ok(check(records).failures.some(f => f.rule === "blueprint-drift"));
});

test("Opus 11: baseline CI receipts have a native private kind and index log rows have no document ID", () => {
  const layout = parseLayout(readFileSync(DEFAULT_LAYOUT, "utf8"));
  assert.equal(classify(layout, "evidence/blueprint/ci-1.json")?.kind, "Blueprint evidence");
  const extraKinds = [{ kind: "Owner words", path: "owner/words.jsonl", changes: "append-only", citedAs: "line, by its W- ID" }];
  const records = repo({ "owner/words.jsonl": "", "evidence/blueprint/ci-1.json": "{}" });
  assert.deepEqual(check(records, { config: { extraKinds }, write: true }).failures, []);
  const index = read(records, "INDEX.md");
  assert.match(index, /\| — \| `owner\/words\.jsonl`/);
  writeFileSync(join(records, "INDEX.md"), index.replace("| — | `owner/words.jsonl`", "| line, by its W- ID | `owner/words.jsonl`"));
  const migration = check(records, { config: { extraKinds } });
  assert.deepEqual(migration.failures, []);
  assert.ok(migration.screening.some(f => f.rule === "generated-format" && f.path === "INDEX.md"));
});

test("process purpose remains in the owner view without requiring a product feature", () => {
  const records = repo({
    "purpose/P-0001.md": purpose,
    "purpose/P-0002.md": "# P-0002 开发流程\n\nstatus: active\nscope: process\n",
    "purpose/P-0003.md": "# P-0003 功能需求\n\nstatus: active\n\n## Example\n\nscope: process\n",
    "blueprint/F-0001.md": feature("F-0001"),
  });
  const state = check(records, { write: true });
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.screening.filter(f => f.rule === "blueprint-unserved-purpose").map(f => f.path), ["purpose/P-0003.md"]);
  const view = read(records, "BLUEPRINT.md");
  assert.match(view, /P-0002 开发流程/);
  assert.doesNotMatch(view.split("## 待处理")[1], /P-0002/);
  assert.match(view.split("## 待处理")[1], /P-0003/);
});
