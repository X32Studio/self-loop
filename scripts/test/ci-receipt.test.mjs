// D-0015 item 1: the closing writer derives its loop from the ledger it writes and reads CI itself, once per row. The loop
// is the records repository holding the real path of --file; its loop.json names the product, push remote and required
// checks. No flag, configuration file, environment variable or working directory can name another loop.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { alarms } from "../trajectory.mjs";
import { inspect } from "../records-check.mjs";
import { fakeGh, git, isolatedEnv, repo, scripts, temp } from "./helpers.mjs";

const VERIFY = "github-actions/verify", LINT = "github-actions/lint";
const run = (name, id, conclusion = "success", status = "completed") => ({ id, app: "github-actions", name, status, conclusion: status === "completed" ? conclusion : null });
const green = [run("verify", 1), run("lint", 2)];
const red = [run("verify", 1), run("lint", 2), run("verify", 3, "failure")];

/** A records repository for `product` (loop.json committed); `loop` overrides loop.json fields, null writes none. */
function records(product, loop = {}) {
  const files = { "README.md": "# records\n", "records.json": "{}\n", "metrics/.keep": "" };
  if (loop) files["loop.json"] = JSON.stringify({ product, records: ".", workDir: temp(), phase: "v1", briefs: {}, agents: {},
    gates: { require: [VERIFY, LINT] }, ...loop }) + "\n";
  return repo(files);
}

/** Two loops whose products share Git history (a ruled commit and its VERSION tip), pushing to example/a and example/b. */
function twoLoops() {
  const a = repo({ "VERSION": "1.0.0\n", "src/a.js": "a\n" });
  const ruled = git(a, "rev-parse", "HEAD");
  writeFileSync(join(a, "VERSION"), "1.0.1\n");
  git(a, "commit", "-qam", "1.0.1");
  const tip = git(a, "rev-parse", "HEAD");
  const b = temp();
  git(b, "clone", "-q", a, ".");
  git(a, "remote", "add", "origin", "https://github.com/example/a.git");
  git(b, "remote", "set-url", "origin", "https://github.com/example/b.git");
  const gh = fakeGh({ "example/a": { [ruled]: green, [tip]: green }, "example/b": { [ruled]: red, [tip]: red } });
  return { a: { product: a, records: records(a) }, b: { product: b, records: records(b) }, ruled, tip, gh };
}

const ledger = dir => join(dir, "metrics", "trajectory.jsonl");
const bytes = file => (existsSync(file) ? readFileSync(file, "utf8") : "");
const rows = file => bytes(file).split("\n").filter(Boolean).map(line => JSON.parse(line));
const evidence = dir => (existsSync(join(dir, "evidence")) ? readdirSync(join(dir, "evidence"), { recursive: true }).map(String).sort() : []);

/** trajectory.mjs append of round 1, phase v1, by the judge, on `ruled`, with the given verdict and extra arguments. */
function appender(gh, ruled) {
  return (file, verdict, extra = [], { cwd = process.cwd(), env = {} } = {}) => spawnSync(process.execPath, [join(scripts, "trajectory.mjs"), "append",
    "--file", file, "--round", "1", "--phase", "v1", "--role", "judge", "--area", "watch", "--verdict", verdict, "--suite", "9/0",
    "--commit", ruled, ...extra], { encoding: "utf8", cwd, env: isolatedEnv({ PATH: gh.env.PATH, ...env }) });
}

test("nothing a caller passes, sets or stands in can put one loop's CI into another loop's ledger", () => {
  const { a, b, ruled, tip, gh } = twoLoops();
  const append = appender(gh, ruled);
  const target = ledger(b.records);

  // The flags that once named the loop or the CI word are refused outright, naming the flag, before anything is read.
  const receipt = join(temp(), "green.json");
  writeFileSync(receipt, JSON.stringify({ repository: "example/a", sha: tip, ci: "success", ok: true, missing: [], conclusions: { [VERIFY]: "success", [LINT]: "success" } }));
  for (const [flag, value] of [["--config", join(a.records, "loop.json")], ["--repo", a.product], ["--remote", "origin"], ["--ci", "success"], ["--ci-receipt", receipt]]) {
    const refused = append(target, "CONVERGED", ["--tip", tip, flag, value]);
    assert.equal(refused.status, 64, `${flag}: ${refused.stderr}`);
    assert.match(refused.stderr, new RegExp(`${flag} was removed`));
  }
  assert.equal(append(target, "CONVERGED", ["--tip", tip, "--records", a.records]).status, 64, "an option the append does not take is no silent pass either");
  assert.deepEqual([bytes(target), evidence(b.records), gh.queries()], ["", [], []]);

  // The caller's configuration and folder are ignored: B's own destination decides, and it is red.
  const fromA = append(target, "CONVERGED", ["--tip", tip], { cwd: a.records, env: { SELF_LOOP_CONFIG: join(a.records, "loop.json") } });
  assert.equal(fromA.status, 2, fromA.stderr);
  assert.match(fromA.stderr, /CONVERGED needs CI success on [0-9a-f]{40}; it is failure \(github-actions\/verify: completed\/failure\)/);
  assert.deepEqual(gh.queries(), [`example/b ${tip}`], "one reading, in B's destination, of the pushed tip");

  // A green receipt for the same SHA placed among B's evidence is not read: the append makes its own reading.
  mkdirSync(join(b.records, "evidence", "0001"), { recursive: true });
  writeFileSync(join(b.records, "evidence", "0001", `ci-${tip.slice(0, 12)}-1.json`), readFileSync(receipt));
  assert.equal(append(target, "CONVERGED", ["--tip", tip]).status, 2);

  // A's ledger path made a link to B's ledger is B's ledger: the loop follows the real path.
  writeFileSync(target, "");
  symlinkSync(target, ledger(a.records));
  assert.equal(append(ledger(a.records), "CONVERGED", ["--tip", tip]).status, 2);
  const continued = append(ledger(a.records), "CONTINUE", ["--tip", tip]);
  assert.equal(continued.status, 0, continued.stderr);
  const [row] = rows(target);
  assert.deepEqual([row.verdict, row.ci, row.tip], ["CONTINUE", "failure", tip]);
  assert.ok(existsSync(join(b.records, row.ciReceipt)), "the receipt lies in B's records, next to B's ledger");
  assert.deepEqual(gh.queries().filter(q => q.startsWith("example/a")), [], "A's destination was never read");
  assert.doesNotMatch(bytes(target), /"ci":"success"/);

  // A link to nothing cannot be told apart from where it would write, so it is refused.
  const dangling = records(a.product);
  symlinkSync(join(temp(), "metrics", "trajectory.jsonl"), ledger(dangling));
  assert.equal(append(ledger(dangling), "CONTINUE").status, 64);
});

test("a close reads the pushed SHA once where the loop's gates.remote pushes, over its gates.require, and the row names the saved receipt", () => {
  const { a, ruled, tip, gh } = twoLoops();
  git(a.product, "remote", "add", "publish", "https://github.com/example/a.git");
  git(a.product, "remote", "set-url", "--push", "publish", "git@github.com:example/fork.git");
  const loop = records(a.product, { gates: { remote: "publish", require: [LINT, VERIFY] } });
  const file = ledger(loop);
  const append = appender(gh, ruled);
  const receiptOf = row => JSON.parse(readFileSync(join(loop, row.ciReceipt), "utf8"));

  gh.serve({ "example/fork": { [tip]: green } });
  const closed = append(file, "CONVERGED", ["--tip", tip]);
  assert.equal(closed.status, 0, closed.stderr);
  const [row] = rows(file);
  assert.deepEqual([row.commit, row.tip, row.verdict, row.ci, row.ciReceipt], [ruled, tip, "CONVERGED", "success", `evidence/0001/ci-${tip.slice(0, 12)}-1/receipt.json`]);
  assert.deepEqual([receiptOf(row).repository, receiptOf(row).sha, receiptOf(row).ci], ["example/fork", tip, "success"]);
  assert.deepEqual(gh.queries(), [`example/fork ${tip}`]);
  assert.deepEqual(inspect(loop).failures.filter(f => f.rule === "trajectory"), [], "the row's receipt is a green reading of its tip");

  // Every row gets one reading; a second reading of the same SHA gets the next folder. On a case-insensitive file system
  // the ledger named in another case is the same ledger of the same loop.
  const otherCase = file.replace(/metrics/, "METRICS");
  assert.equal(append(existsSync(otherCase) ? otherCase : file, "CONTINUE", ["--tip", tip]).status, 0);
  assert.equal(rows(file)[1].ciReceipt, `evidence/0001/ci-${tip.slice(0, 12)}-2/receipt.json`);
  assert.equal(gh.queries().length, 2);

  // A failed re-run refuses CONVERGED and writes nothing, neither row nor receipt.
  const before = [bytes(file), evidence(loop)];
  gh.serve({ "example/fork": { [tip]: red } });
  const rerun = append(file, "CONVERGED", ["--tip", tip]);
  assert.equal(rerun.status, 2, rerun.stderr);
  assert.match(rerun.stderr, /github-actions\/verify: completed\/failure/);
  // Unreadable CI refuses CONVERGED with the command that reads it, and is written as unknown on any other row.
  gh.serve({});
  const unread = append(file, "CONVERGED", ["--tip", tip]);
  assert.equal(unread.status, 2);
  assert.match(unread.stderr, /CONVERGED needs CI success on [0-9a-f]{40}; it is unknown: the CI could not be read .*ci-green\.mjs --repo \S+ --remote publish --sha [0-9a-f]{40} --require github-actions\/lint,github-actions\/verify/);
  // The loop's phase is the row's phase; a tip that changes more than VERSION is refused before any reading.
  const phase = append(file, "CONVERGED", ["--tip", tip, "--phase", "v2"]);
  assert.equal(phase.status, 2);
  assert.match(phase.stderr, /--phase v2 is not the loop's phase "v1"/);
  writeFileSync(join(a.product, "src/a.js"), "b\n");
  git(a.product, "commit", "-qam", "code after the ruling");
  const code = git(a.product, "rev-parse", "HEAD");
  assert.match(append(file, "CONTINUE", ["--tip", code]).stderr, /src\/a\.js/);
  assert.deepEqual([bytes(file), evidence(loop)], before);
  assert.equal(gh.queries().length, 4, "one reading per CONVERGED refusal on CI; none for the phase or the tip");

  const unknown = append(file, "CONTINUE", ["--tip", tip]);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(unknown.stderr, /unreadable, written as unknown: github-actions\/lint: check runs could not be read/);
  assert.deepEqual([rows(file)[2].ci, receiptOf(rows(file)[2]).ci], ["unknown", "unknown"]);
});

test("without a loop a CONVERGED row is refused and any other row is written with CI absent, reading nothing", () => {
  const { a, ruled, gh } = twoLoops();
  const append = appender(gh, ruled);
  const bare = records(a.product, null);
  const outside = join(temp(), "trajectory.jsonl");
  const nested = join(records(a.product), "sub", "metrics", "trajectory.jsonl");
  mkdirSync(join(nested, ".."), { recursive: true });
  for (const file of [ledger(bare), outside, nested]) {
    const refused = append(file, "CONVERGED");
    assert.equal(refused.status, 2, refused.stderr);
    assert.match(refused.stderr, /needs the loop's CI/);
    assert.equal(append(file, "CONTINUE").status, 0);
    const [row] = rows(file);
    assert.deepEqual([row.ci, "ciReceipt" in row], ["absent", false]);
  }
  assert.deepEqual(gh.queries(), []);
  assert.deepEqual(alarms(rows(outside)).map(x => x.key), ["ci-absent:v1:1"], "a judged round that never reached CI raises its alarm");
});

test("alarms: ci-absent for a judge row whose CI is absent or unknown; a failure stays ci-not-green", () => {
  const row = (round, ci, role = "judge") => ({ time: "-", round, phase: "v1", area: "watch", role, model: "-", verdict: "CONTINUE", opened: "-", closed: "-", suite: "-", owner: "0", commit: "a".repeat(40), ci });
  const found = alarms([row(1, "absent"), row(2, "unknown"), row(3, "success"), row(4, "failure"), row(5, "absent", "external"), row(6, "-")]);
  const ci = found.filter(x => x.type.startsWith("ci-"));
  assert.deepEqual(ci.map(x => x.key), ["ci-absent:v1:1", "ci-absent:v1:2", "ci-not-green:v1:4"]);
  assert.match(ci[1].message, /could not be read/);
});

test("records-check: a CONVERGED row naming a receipt needs a green reading of its pushed SHA that the records hold", () => {
  const sha = "a".repeat(40), tip = "b".repeat(40);
  const receipt = (of, ci = "success") => JSON.stringify({ repository: "example/a", sha: of, ci, ok: ci === "success" });
  const check = (row, files = {}) => {
    const dir = repo({ "README.md": "# records\n", "metrics/trajectory.jsonl": JSON.stringify(row) + "\n", ...files });
    return inspect(dir).failures.filter(f => f.rule === "trajectory").map(f => f.detail);
  };
  const converged = { round: 3, phase: "v1", role: "judge", verdict: "CONVERGED", commit: sha, tip, ci: "success", ciReceipt: "evidence/0003/ci-1/receipt.json" };
  assert.deepEqual(check(converged, { "evidence/0003/ci-1/receipt.json": receipt(tip) }), []);
  assert.match(check(converged, { "evidence/0003/ci-1/receipt.json": receipt(sha) })[0], /not a green reading/, "the receipt is for the ruled SHA, not the pushed tip");
  assert.match(check(converged, { "evidence/0003/ci-1/receipt.json": receipt(tip, "failure") })[0], /not a green reading/);
  assert.match(check(converged)[0], /which the records do not hold/);
  assert.deepEqual(check({ ...converged, ciReceipt: undefined }), [], "rows written before the append read CI still parse");
  assert.deepEqual(check({ ...converged, verdict: "CONTINUE" }), [], "only a CONVERGED row claims a green reading");
});
