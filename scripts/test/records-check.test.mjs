// Admission of the records check's hard failures, and behaviour of its screening and index. Inputs are frozen fixtures;
// no test reads a live records directory (the v0.1 tests that did broke when a new file appeared there).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { check, classify, DEFAULT_LAYOUT, inspect, openWords, parseLayout } from "../records-check.mjs";
import { fixtures, git, here, repo, scripts } from "./helpers.mjs";

const layoutText = readFileSync(DEFAULT_LAYOUT, "utf8");
const layout = parseLayout(layoutText);
// lessons/L-0001.md of example-loop at b2ca438, frozen.
const L0001 = readFileSync(join(fixtures, "l-0001.md"), "utf8");

test("the layout is parsed from RECORDS.md, the one source", () => {
  const kinds = layout.map(k => k.kind);
  for (const k of ["Purpose", "Decisions", "Design", "Rounds", "Sealed", "Evidence", "Hand-offs", "Trajectory", "Owner batches", "Owner answers", "Interventions", "Lessons", "Engines", "Backtests", "Research", "Repository", "Index"])
    assert.ok(kinds.includes(k), k);
  assert.deepEqual(classify(layout, "rounds/0031-judge.md"), { kind: "Rounds", id: "R-0031-judge", changes: "immutable" });
  assert.deepEqual(classify(layout, "rounds/0031-reviewer-diagnosis.md"), { kind: "Rounds", id: "R-0031-reviewer-diagnosis", changes: "immutable" });
  assert.deepEqual(classify(layout, "decisions/D-0020.md"), { kind: "Decisions", id: "D-0020", changes: "immutable" });
  assert.equal(classify(layout, "owner/B-0001.md").changes, "immutable");
  assert.equal(classify(layout, "owner/answers.jsonl").changes, "append-only");
  assert.equal(classify(layout, "design/access.md").changes, "editable");
  assert.equal(classify(layout, "sealed/judge/0001-judge.md").kind, "Sealed");
  assert.equal(classify(layout, "decisions/D-20.md"), null);
  assert.equal(classify(layout, "notes.md"), null);
});

// Gate 1: a file outside every declared kind and path.
test("undeclared files, red and green on the real example-loop file list (b2ca438)", () => {
  const [legit, baseline] = readFileSync(join(fixtures, "example-loop-files.txt"), "utf8").split("# baseline sample\n").map(s => s.split("\n").filter(Boolean));
  assert.ok(legit.length > 250 && baseline.length > 150);
  const falseKills = legit.filter(p => !classify(layout, p));
  assert.deepEqual(falseKills, [], "every managed record of the real repository is declared");
  const caught = baseline.filter(p => !classify(layout, p));
  assert.equal(caught.length, baseline.length, "every path of the unmanaged rescue copy is undeclared");
});

// Screening (was a hard gate in v0.1): a record ID cited that no record carries. The real defect: lesson L-0001 cites
// "lead ruling T", which lived only in the scratch copy of lead-rulings.md. A citation in prose cannot be told apart
// from a template's example ID (the bundled shared brief's `D-0007` failed round one in the v0.1 review), so it is
// reported, never blocking.
test("dangling ID: reported for the lesson that cites a ruling the repository lacks; gone once the decision exists", () => {
  const lesson = L0001.replace("lead ruling T", "decision D-0020");
  assert.notEqual(lesson, L0001);
  const red = repo({ "README.md": "# loop records\n", "lessons/L-0001.md": lesson });
  check(red, { layoutText, write: true });
  const state = inspect(red, { layoutText });
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.screening.filter(f => f.rule === "dangling-id").map(f => [f.path, f.detail]), [["lessons/L-0001.md", "cites D-0020, which no record carries"]]);
  const green = repo({ "README.md": "# loop records\n", "lessons/L-0001.md": lesson, "decisions/D-0020.md": "# D-0020 Upgrade obligations follow what shipped\n\nby: lead\n" });
  check(green, { layoutText, write: true });
  assert.deepEqual(inspect(green, { layoutText }).screening.filter(f => f.rule === "dangling-id"), []);
});

// Screening (was a hard gate in v0.1): material for a role that may not read sealed records names a sealed path. The
// v0.1 gate refused a judge-only engine brief naming its own file; isolation is by construction (role views), so this
// is reported for the lead.
test("sealed path: reported for actor and reviewer material, never for the judge's own brief or round", () => {
  const sealedRepo = repo({ "case-07.mjs": "export default {}\n" });
  const files = {
    "README.md": "# r\n",
    "records.json": JSON.stringify({ sealed: [sealedRepo] }),
    "rounds/0001-actor.md": `# R-0001-actor\n\nRead the held-out case ${sealedRepo}/case-07.mjs before fixing.\n`,
    "rounds/0001-reviewer-frame.md": "# R-0001-reviewer-frame\n\nCompare with sealed/keys.md.\n",
    "rounds/0001-judge.md": `# R-0001-judge\n\nHeld-out: ${sealedRepo}/case-07.mjs\n`,
    "engines/judge.md": `# Judge\n\nYour held-out example ${sealedRepo}/case-07.mjs\n`,
    "engines/actor.md": `# Actor\n\nNever read ${sealedRepo}.\n`,
  };
  const state = inspect(repo(files), { layoutText, config: JSON.parse(files["records.json"]) });
  assert.deepEqual(state.failures.filter(f => f.rule !== "index-drift"), []);
  assert.deepEqual([...new Set(state.screening.filter(f => f.rule === "sealed-path").map(f => f.path))].sort(), ["engines/actor.md", "rounds/0001-actor.md", "rounds/0001-reviewer-frame.md"]);
});

test("sealed-path screening skips generated hand-off pointers and round headers while checking authored text", () => {
  const round = "rounds/0001-judge.md", auditFile = "sealed/judge/0001/judge-1-audit.json";
  const sha = "a".repeat(40);
  const handoff = { id: "R-0001-judge", role: "judge", step: "judge", round: 1, phase: "S1", attempt: 1, view: sha,
    record: round, agent: { runner: "t3" }, product: null, files: [auditFile, round],
    audit: { violations: 0, denied: 0, flags: 1, file: auditFile }, note: "Read sealed/named-in-note.md" };
  const files = {
    [auditFile]: "{}\n",
    "metrics/handoffs.jsonl": JSON.stringify(handoff) + "\n",
    [round]: [`# ${handoff.id}`, "", "phase: S1", "role: judge", "agent: t3", `view: records@${sha}`,
      "briefs: engines/judge.md", `product: ${sha}`, `audit: 0 violations, 0 denied, 1 flags (${auditFile})`, "",
      "## Public report (verbatim, out/public.md)", "", "audit: 0 violations, 0 denied, 1 flags (sealed/in-the-report.json)", ""].join("\n"),
  };
  const state = inspect(repo(files), { layoutText });
  assert.deepEqual(state.failures, []);
  const findings = state.screening.filter(f => f.rule === "sealed-path");
  assert.deepEqual(findings.map(({ path, line }) => [path, line]), [["metrics/handoffs.jsonl", 1], [round, 13]]);
  assert.match(findings[0].detail, /sealed\/named-in-note\.md/);
  assert.match(findings[1].detail, /sealed\/in-the-report\.json/);
});

for (const resolution of ["decision", "later actor hand-off"]) {
  test(`a design conflict clears on a ${resolution} even with identical design bytes`, () => {
    const path = "design/core.md", design = "# Incumbent\n", proposal = "evidence/0002/actor-b-1/out/design/core.md";
    const sha = "a".repeat(40);
    const actor = (round, step, ...files) => {
      const record = `rounds/${String(round).padStart(4, "0")}-${step}.md`;
      return { id: `R-${String(round).padStart(4, "0")}-${step}`, role: "actor", step, round, phase: "S1",
        view: sha, attempt: 1, agent: { runner: "t3" }, product: null, audit: { violations: 0 }, record, files: [record, ...files] };
    };
    const first = actor(2, "actor-a", path), conflicting = actor(2, "actor-b", proposal), later = actor(1, "actor", path);
    conflicting.designConflicts = [{ path, current: createHash("sha256").update(design).digest("hex"), changed: sha, proposal }];
    const files = { [path]: design, [proposal]: "# Proposal\n", [first.record]: "# First\n", [conflicting.record]: "# Conflict\n",
      [later.record]: "# Later\n", "decisions/D-0001.md": `# D-0001\n\nDiscuss ${conflicting.id}-other.\n` };
    const checkConflicts = rows => {
      files["metrics/handoffs.jsonl"] = rows.map(h => JSON.stringify(h)).join("\n") + "\n";
      const state = inspect("/work/records", { files: Object.keys(files), read: p => files[p], layoutText });
      assert.deepEqual(state.failures, []);
      return state.screening.filter(f => f.rule === "design-conflict");
    };
    assert.deepEqual(checkConflicts([first, conflicting]).map(f => f.path), [path]);
    if (resolution === "decision") {
      files["decisions/D-0001.md"] = `# D-0001\n\nKeep the incumbent for \`${conflicting.id}\`.\n`;
      assert.deepEqual(checkConflicts([first, conflicting]), []);
    } else {
      assert.deepEqual(checkConflicts([first, conflicting, later]), []);
    }
  });
}

test("changed records: an immutable record edited in place, or an append-only one rewritten, is reported", () => {
  const answers = "{\"batch\":\"B-0001\",\"time\":\"2026-11-20T00:00:00Z\",\"words\":\"yes\"}\n";
  const dir = repo({ "README.md": "# r\n", "decisions/D-0002.md": "# D-0002\nby: owner\nChosen A.\n", "owner/B-0001.md": "# B-0001\n\nphase: P\n",
    "owner/B-0002.md": "# B-0002\n\nphase: P\n", "owner/answers.jsonl": answers });
  writeFileSync(join(dir, "decisions/D-0002.md"), "# D-0002\nby: owner\nChosen B.\n");
  writeFileSync(join(dir, "owner/B-0001.md"), "# B-0001\n\nphase: P\n\n## Answers\n\nOwner (2026-11-20): yes\n");
  writeFileSync(join(dir, "owner/answers.jsonl"), `${answers}${answers.replace("B-0001", "B-0002")}`);
  const state = check(dir, { layoutText, write: true });
  assert.deepEqual(state.screening.filter(f => f.rule === "changed-record").map(f => f.path), ["decisions/D-0002.md", "owner/B-0001.md"], "a batch is immutable; answers are appended events");
});

test("undeclared files: hard in the checked set only; elsewhere screening", () => {
  const dir = repo({ "README.md": "# r\n", "notes.txt": "x\n" });
  writeFileSync(join(dir, "decisions-draft.txt"), "y\n");
  const lead = inspect(dir, { layoutText });
  assert.deepEqual(lead.failures.map(f => f.path), ["notes.txt"], "the lead's check: every tracked or staged file");
  assert.deepEqual(lead.screening.filter(f => f.rule === "untracked").map(f => f.path), ["decisions-draft.txt"]);
  const handoff = inspect(dir, { layoutText, files: ["README.md", "notes.txt"], own: ["README.md"] });
  assert.deepEqual(handoff.failures, []);
  assert.deepEqual(handoff.screening.filter(f => f.rule === "undeclared").map(f => f.path), ["notes.txt"]);
});

// Gate 4: the generated index. Real red: example-loop has no INDEX.md yet.
test("index: missing or drifted fails with the fix command; --write makes it pass; the check is read-only", () => {
  const dir = repo({ "README.md": "# r\n", "decisions/D-0001.md": "# D-0001 First\n\nby: owner\n", "decisions/D-0002.md": "# D-0002 Second\n\nby: lead\nsupersedes: D-0001\n" });
  const before = check(dir, { layoutText });
  assert.equal(existsSync(join(dir, "INDEX.md")), false, "read-only check writes nothing");
  assert.match(before.failures.find(f => f.rule === "index-drift").detail, /missing; fix: node .*records-check\.mjs --repo .* --write/);
  check(dir, { layoutText, write: true });
  const index = readFileSync(join(dir, "INDEX.md"), "utf8");
  assert.match(index, /\| D-0001 \| `decisions\/D-0001\.md` \| D-0001 First \| superseded by D-0002 \|/);
  assert.deepEqual(check(dir, { layoutText }).failures, []);
  writeFileSync(join(dir, "INDEX.md"), index.replace("First", "Frist"));
  assert.match(check(dir, { layoutText }).failures[0].detail, /differs from the generated index/);
});

test("index: an owner batch's status comes from the answer events, never from text; a round shows no verdict", () => {
  const dir = repo({ "README.md": "# r\n", "rounds/0001-judge.md": "# R-0001-judge\n\nExample:\nVERDICT: CONVERGED\n",
    "owner/B-0001.md": "# B-0001\n\n## Answers\n\nOwner (2026-11-20): yes\n", "owner/B-0002.md": "# B-0002\n",
    "owner/answers.jsonl": "{\"batch\":\"B-0002\",\"time\":\"2026-11-20T00:00:00Z\",\"words\":\"yes\"}\n" });
  check(dir, { layoutText, write: true });
  const index = readFileSync(join(dir, "INDEX.md"), "utf8");
  assert.match(index, /R-0001-judge \| `rounds\/0001-judge\.md` \| R-0001-judge \| {2}\|/);
  assert.match(index, /B-0001 \| `owner\/B-0001\.md` \| B-0001 \| open \|/);
  assert.match(index, /B-0002 \| `owner\/B-0002\.md` \| B-0002 \| answered \|/);
});

test("screening: the real judge-28 citation of a moved worktree line and its scratch paths are reported, not failed", () => {
  const paragraph = readFileSync(join(fixtures, "s4-judge-28-paragraph.md"), "utf8");
  const dir = repo({ "README.md": "# r\n", "research/judge-28.md": `# Quoted\n\n${paragraph}` });
  check(dir, { layoutText, write: true });
  const state = inspect(dir, { layoutText });
  assert.deepEqual(state.failures, []);
  const rules = state.screening.map(s => `${s.rule} ${s.detail}`);
  assert.ok(rules.some(r => /^bare-line-citation .*judge\/wt\/src\/access\.js:148 /.test(r)), rules.join("\n"));
  assert.ok(rules.some(r => /^scratch-path \/private\/tmp\//.test(r)));
});

test("screening: commit citations, digests, secrets and history inside a design file", () => {
  const dir = repo({ "README.md": "# r\n", "design/access.md": "# Access\n\nCurrent design.\n" });
  const commit = git(dir, "rev-parse", "--short", "HEAD");
  const files = {
    "decisions/D-0001.md": `# D-0001\n\nSee design/access.md@${commit} and design/access.md@0000000 and evidence/0001/run.log sha256:${"0".repeat(64)}.\nToken ghp_${"a".repeat(36)}\n`,
    "design/access.md": "# Access\n\n## Round 5 changes\n",
    "evidence/0001/run.log": "ok\n",
  };
  for (const [p, t] of Object.entries(files)) { const full = join(dir, p); spawnSync("mkdir", ["-p", join(full, "..")]); writeFileSync(full, t); }
  git(dir, "add", "-A");
  const state = check(dir, { layoutText, write: true });
  assert.deepEqual(state.failures, []);
  const rules = state.screening.map(s => s.rule).sort();
  assert.deepEqual(rules, ["commit-citation", "digest", "history-in-design", "secret"]);
  assert.match(state.screening.find(s => s.rule === "commit-citation").detail, /@0000000/);
});

test("CLI: exit 1 with the finding on a certain failure, exit 0 with screening only", () => {
  const dir = repo({ "README.md": "# r\n", "notes.txt": "x\n" });
  const run = (...a) => spawnSync(process.execPath, [join(scripts, "records-check.mjs"), "--repo", dir, ...a], { encoding: "utf8" });
  const red = run("--write");
  assert.equal(red.status, 1);
  assert.match(red.stdout, /undeclared {2}notes\.txt/);
  git(dir, "rm", "-q", "notes.txt");
  assert.equal(run("--write").status, 0);
  assert.equal(run().status, 0);
  assert.equal(run("--json").status, 0);
});

test("no test reads the live example-loop directory; its inputs are frozen fixtures", () => {
  // red on a8d6043: 38 pass / 2 fail after a new file appeared in example-loop (the v0.1 reviewer's own run)
  assert.match(readFileSync(join(fixtures, "v0.1-post-report-test.log"), "utf8"), /ℹ fail 2/);
  for (const f of readdirSync(here).filter(f => f.endsWith(".mjs")))
    assert.ok(f === "records-check.test.mjs" || !/example-loop["/]|EXAMPLE_LOOP/.test(readFileSync(join(here, f), "utf8")), f);
});

test("the check screens old designs until an actor hand-off writes them in the current phase", () => {
  const handoff = (round, phase, path) => {
    const id = `R-000${round}-actor`, record = `rounds/000${round}-actor.md`;
    return { id, phase, round, record, step: "actor", role: "actor", view: "1".repeat(40),
      attempt: 1, agent: { runner: "claude" }, product: null, audit: { violations: 0 }, files: [record, path] };
  };
  const rows = [handoff(1, "S4", "design/records.md"), handoff(2, "A1", "design/materials.md")];
  const r = repo({
    "loop.json": '{"phase":"A1"}\n',
    "design/records.md": "# Records\n",
    "design/materials.md": "# Materials\n",
    ...Object.fromEntries(rows.map(h => [h.record, `# ${h.id}\n`])),
    "metrics/handoffs.jsonl": rows.map(h => JSON.stringify(h)).join("\n") + "\n",
  });
  const state = inspect(r);
  assert.deepEqual(state.failures, []);
  assert.deepEqual(state.screening.filter(f => f.rule === "stale-design").map(f => f.path), ["design/records.md"]);
});

test("owner ledgers and rules are native kinds without duplicate legacy index sections", () => {
  assert.equal(classify(layout, "owner/words.jsonl").kind, "Owner words");
  assert.equal(classify(layout, "owner/word-marks.jsonl").changes, "append-only");
  assert.equal(classify(layout, "AGENTS.md").kind, "Rules");
  const extra = parseLayout(layoutText, [
    { kind: "Owner words", path: "owner/words.jsonl", changes: "append-only", citedAs: "line, by its W- ID" },
  ]);
  assert.equal(extra.filter(k => k.kind === "Owner words").length, 1);
  assert.equal(classify(extra, "owner/words.jsonl").id, null);
});

test("owner words settle through a managed citation or a mark, and dated purpose headers resolve their word IDs", () => {
  const cited = "W-21ee1f9e90", marked = "W-9245ff1826", open = "W-7f721eb4f7", unknown = "W-ffffffffff";
  const r = repo({
    "owner/words.jsonl": [cited, marked, open].map(id => JSON.stringify({ id, text: `Example: ${open}` })).join("\n"),
    "owner/word-marks.jsonl": JSON.stringify({ id: marked, as: "routine" }) + "\n",
    "evidence/0001/raw.md": `Raw output mentioning ${open}\n`,
    "purpose/P-0001.md": "# P-0001 Legacy\n\ndate: 2026-11-20\n",
    "purpose/P-0002.md": `# P-0002 Distilled\n\ndate: 2026-11-21\nwords: ${cited}\n`,
    "purpose/P-0003.md": `# P-0003 Missing\n\ndate: 2026-11-22\n\n## Body\n\nwords: ${unknown}\n`,
    "purpose/P-0004.md": `# P-0004 Unknown\n\ndate: 2026-11-23\nwords: ${unknown}\n`,
  });
  const s = inspect(r);
  assert.deepEqual(s.failures.filter(f => f.rule === "unknown-owner-word").map(f => f.path), ["purpose/P-0004.md"]);
  assert.deepEqual(s.screening.filter(f => f.rule === "purpose-words").map(f => f.path), ["purpose/P-0003.md"]);
  assert.deepEqual(s.screening.filter(f => f.rule === "open-owner-word").map(f => f.detail), [`${open} has no record citation or mark`]);
});

test("D-0007: the themes index settles its citations when its records kind explicitly opts in", () => {
  const themed = "W-0000000001", incidental = "W-0000000002";
  const extraKinds = [
    { kind: "Owner themes", path: "owner/themes.md", changes: "editable" },
    { kind: "Notes", path: "owner/notes.md", settlesOwnerWords: "true" },
  ];
  const r = repo({
    "records.json": JSON.stringify({ extraKinds }),
    "owner/words.jsonl": [themed, incidental].map(id => JSON.stringify({ id, text: "an owner word" })).join("\n"),
    "owner/themes.md": "# Owner themes\n\nDistilled in D-0003 (" + themed + ").\n",
    "owner/notes.md": "# Notes\n\nA reference to " + incidental + ".\n",
    "evidence/0001/raw.md": "# Raw evidence\n\nAn incidental reference to " + incidental + ".\n",
  });
  const old = git(r, "rev-parse", "HEAD");
  assert.deepEqual(openWords(r).map(w => w.id), [themed, incidental]);

  extraKinds[0].settlesOwnerWords = true;
  writeFileSync(join(r, "records.json"), JSON.stringify({ extraKinds }));
  git(r, "add", "records.json");
  const checked = spawnSync(process.execPath, [join(scripts, "records-check.mjs"), "--repo", r, "--write", "--json"],
    { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.deepEqual(JSON.parse(checked.stdout).screening.filter(f => f.rule === "open-owner-word").map(f => f.detail),
    [incidental + " has no record citation or mark"]);
  assert.deepEqual(openWords(r).map(w => w.id), [themed, incidental], "a staged opt-in is not committed yet");

  git(r, "commit", "-qm", "declare owner themes as distillations");
  assert.deepEqual(openWords(r).map(w => w.id), [incidental]);
  assert.deepEqual(openWords(r, old).map(w => w.id), [themed, incidental]);
});
