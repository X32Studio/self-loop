// suite-green.mjs: the full suite on an exact commit in a clean checkout. Admission evidence (fixtures/suite-green/):
// real runs of this skill's own suite through the gate, red on c7e7c50 (the lead committed it with 2 failing tests)
// and green on a4db050 and 4748705; each recorded log is re-judged here by the same rule. Live cases use small
// repositories built in the test.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseSummary, suiteGreen, suiteStore, verdict } from "../suite-green.mjs";
import { tipProblem } from "../lib/tip.mjs";
import { fixtures, git, repo, scripts, skill, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");

const ADMISSION = { c7e7c50: false, a4db050: true, "4748705": true };

test("admission: the recorded runs re-judge identically: red on c7e7c50 (2 failing tests), green on a4db050 and 4748705", () => {
  for (const [short, expected] of Object.entries(ADMISSION)) {
    const receipt = JSON.parse(readFileSync(join(fixtures, "suite-green", `${short}.json`), "utf8"));
    const log = gunzipSync(readFileSync(join(fixtures, "suite-green", `${short}.log.gz`))).toString();
    assert.equal(createHash("sha256").update(log).digest("hex"), receipt.log.sha256, `${short}: the log is the one the receipt names`);
    assert.ok(receipt.sha.startsWith(short) && receipt.command === "node --test scripts/test", short);
    assert.equal(receipt.green, expected, short);
    const v = verdict({ exit: receipt.exit, output: log, format: "node-test" });
    assert.deepEqual([v.green, v.reasons, v.summary], [receipt.green, receipt.reasons, receipt.summary], short);
    if (spawnSync("git", ["-C", skill, "cat-file", "-e", `${receipt.sha}^{commit}`]).status === 0)
      assert.equal(git(skill, "rev-parse", short), receipt.sha, `${short} is a commit of this skill`);
  }
  const red = JSON.parse(readFileSync(join(fixtures, "suite-green", "c7e7c50.json"), "utf8"));
  assert.deepEqual([red.summary.tests, red.summary.pass, red.summary.fail], [70, 68, 2]);
  assert.match(gunzipSync(readFileSync(join(fixtures, "suite-green", "c7e7c50.log.gz"))).toString(), /✖ B7 the default budget of 2 sends at most 2 batches/);
});

test("summary parsing: spec and TAP lines, summed over runs; none when absent", () => {
  assert.deepEqual(parseSummary("ℹ tests 3\nℹ pass 2\nℹ fail 1\nℹ cancelled 0\n# tests 2\n# pass 2\n").pass, 4);
  assert.equal(parseSummary("all good\n"), null);
  assert.deepEqual(verdict({ exit: 0, output: "ℹ tests 0\nℹ pass 0\nℹ fail 0\n" }).reasons, ["no test ran"]);
  assert.deepEqual(verdict({ exit: 0, output: "ℹ tests 2\nℹ pass 1\nℹ fail 0\nℹ cancelled 1\n" }).reasons, ["1 test(s) cancelled"]);
  assert.deepEqual(verdict({ exit: 0, output: "ok\n", format: "node-test" }).reasons, ["no node --test summary in the output"]);
  assert.equal(verdict({ exit: 0, output: "ok\n" }).green, true, "another runner: the exit code decides");
});

const project = (testBody, extra = {}) => repo({ "t.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\n${testBody}\n`, ...extra });

test("live: a passing suite is green, with the exact SHA, counts and duration", () => {
  const dir = project(`test("ok", () => assert.equal(1, 1));`);
  const r = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" });
  assert.deepEqual([r.green, r.sha, r.exit, r.summary.tests, r.summary.fail], [true, git(dir, "rev-parse", "HEAD"), 0, 1, 0], r.text);
  assert.ok(r.durationMs > 0);
  assert.equal(git(dir, "worktree", "list").split("\n").length, 1, "the worktree is removed");
});

test("live: a file present only in the working tree (untracked or modified) does not make the commit green", () => {
  // the v0.2 review's B1 case: an untracked src/cli.js made the entry point pass outside the delivered tree
  const dir = project(`import { ok } from "./cli.mjs";\ntest("entry", () => assert.equal(ok, true));`, { "cli.mjs": "export const ok = false;\n" });
  writeFileSync(join(dir, "cli.mjs"), "export const ok = true;\n");
  assert.equal(spawnSync(process.execPath, ["--test"], { cwd: dir, env: { ...process.env, NODE_TEST_CONTEXT: "" } }).status, 0, "green in the dirty working tree");
  const r = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test" });
  assert.equal(r.green, false);
  assert.ok(r.reasons.includes("1 test(s) failed"), r.reasons.join());
});

test("live: exit 0 with a failed test is red; a failing install stops before the command", () => {
  const dir = project(`test("bad", () => assert.equal(1, 2));`);
  const masked = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test; exit 0" });
  assert.deepEqual([masked.exit, masked.green, masked.reasons], [0, false, ["1 test(s) failed"]]);
  const install = suiteGreen({ repo: dir, sha: "HEAD", install: "exit 7", command: "touch ran" });
  assert.deepEqual([install.green, install.exit], [false, -1]);
  assert.ok(install.reasons.includes("install exited 7"));
});

test("CLI: exit 0 green, 2 red, 64 usage; --out writes the receipt and log once and never overwrites", () => {
  const dir = project(`test("ok", () => assert.ok(true));`);
  const out = join(temp(), "evidence", "suite-1");
  const run = (...a) => spawnSync(process.execPath, [join(scripts, "suite-green.mjs"), "--repo", dir, "--sha", "HEAD", ...a], { encoding: "utf8" });
  const ok = run("--command", "node --test", "--format", "node-test", "--out", out);
  assert.equal(ok.status, 0, ok.stderr);
  const receipt = JSON.parse(readFileSync(`${out}.json`, "utf8"));
  assert.equal(receipt.sha, git(dir, "rev-parse", "HEAD"));
  assert.equal(createHash("sha256").update(gunzipSync(readFileSync(`${out}.log.gz`))).digest("hex"), receipt.log.sha256);
  assert.equal(run("--command", "node --test", "--out", out).status, 64, "never overwrites evidence");
  assert.equal(run("--command", "exit 3").status, 2);
  assert.equal(run().status, 64);
  assert.equal(existsSync(join(dir, "ran")), false);
});

const counted = (extra = {}) => {
  const runs = join(temp(), "runs");
  const dir = repo({ VERSION: "1.0.0\n", "t.test.mjs": `import test from "node:test";\nimport { appendFileSync, readFileSync } from "node:fs";\ntest("count", () => appendFileSync(${JSON.stringify(runs)}, readFileSync("VERSION", "utf8").trim() + "\\n"));\n`, ...extra });
  return { dir, runs: () => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean) : []) };
};
const commitTree = (dir, tree, message) => git(dir, "commit-tree", tree, "-p", "HEAD", "-m", message);

test("one tree, one run: a green receipt is reused for any commit of the same tree, command and install, never across them", () => {
  const { dir, runs } = counted();
  const head = git(dir, "rev-parse", "HEAD");
  const first = suiteGreen({ repo: dir, sha: head, command: "node --test", format: "node-test" });
  assert.deepEqual([first.green, first.reusedFrom, runs()], [true, undefined, ["1.0.0"]]);
  const twin = commitTree(dir, git(dir, "rev-parse", "HEAD^{tree}"), "same tree, another commit");
  const again = suiteGreen({ repo: dir, sha: twin, command: "node --test", format: "node-test" });
  assert.deepEqual([again.green, again.sha, again.tree, runs()], [true, twin, first.tree, ["1.0.0"]]);
  assert.ok(again.reusedFrom.startsWith(suiteStore(dir)), again.reusedFrom);
  assert.equal(createHash("sha256").update(again.text).digest("hex"), again.log.sha256);
  const named = suiteGreen({ repo: dir, sha: head, command: "node --test t.test.mjs", format: "node-test" });
  const installed = suiteGreen({ repo: dir, sha: head, command: "node --test", install: "true", format: "node-test" });
  assert.deepEqual([named.green, named.reusedFrom, installed.green, installed.reusedFrom, runs()], [true, undefined, true, undefined, ["1.0.0", "1.0.0", "1.0.0"]], "another command or install runs");
  const linked = join(temp(), "linked");
  git(dir, "worktree", "add", "-q", "--detach", linked, head);
  const fromLinked = suiteGreen({ repo: linked, sha: head, command: "node --test", format: "node-test" });
  assert.deepEqual([fromLinked.repository, Boolean(fromLinked.reusedFrom), runs().length], [linked, true, 3], "one repository, one store");
});

test("reuse re-judges the stored output with the requested evidence check; a red or tampered run is never reused", () => {
  const { dir } = counted();
  const smoke = suiteGreen({ repo: dir, sha: "HEAD", command: "echo smoke" });
  assert.equal(smoke.green, true, "auto: the exit code decides");
  const strict = suiteGreen({ repo: dir, sha: "HEAD", command: "echo smoke", format: "node-test" });
  assert.deepEqual([strict.green, strict.reusedFrom, strict.reasons], [false, undefined, ["no node --test summary in the output"]]);
  const red = suiteGreen({ repo: dir, sha: "HEAD", command: "exit 3" });
  assert.equal(red.green, false);
  assert.equal(suiteGreen({ repo: dir, sha: "HEAD", command: "exit 3" }).reusedFrom, undefined, "a red run is run again");
  const kept = suiteGreen({ repo: dir, sha: "HEAD", command: "echo smoke" });
  assert.equal(kept.reusedFrom, undefined);

  assert.equal(suiteGreen({ repo: dir, sha: "HEAD", command: "echo smoke" }).reusedFrom, undefined, "a log that is not the one its receipt names");
});

test("--vary-version measures the commit's tree with VERSION replaced; only a VERSION-only child of exactly that VERSION reuses it", () => {
  const { dir, runs } = counted({ "README.md": "# product\n" });
  const parent = git(dir, "rev-parse", "HEAD");
  const varied = suiteGreen({ repo: dir, sha: parent, command: "node --test", format: "node-test", varyVersion: "1.1.0-rc.2" });
  assert.deepEqual([varied.green, varied.sha, varied.versionVaried, runs()], [true, parent, "1.1.0-rc.2", ["1.1.0-rc.2"]]);
  assert.equal(readFileSync(join(dir, "VERSION"), "utf8"), "1.0.0\n", "the product's checkout is untouched");
  assert.throws(() => suiteGreen({ repo: dir, sha: parent, command: "node --test", varyVersion: "1.1.0+build" }), /not X\.Y\.Z/);
  const child = version => {
    writeFileSync(join(dir, "VERSION"), version);
    git(dir, "add", "VERSION");
    const sha = commitTree(dir, git(dir, "write-tree"), version);
    git(dir, "reset", "-q", "--hard", parent);
    return sha;
  };
  const tip = child("1.1.0-rc.2\n");
  assert.equal(tipProblem(dir, parent, tip), null);
  const reused = suiteGreen({ repo: dir, sha: tip, command: "node --test", format: "node-test" });
  assert.deepEqual([reused.green, reused.sha, Boolean(reused.reusedFrom), reused.versionVaried, runs().length], [true, tip, true, undefined, 1]);
  suiteGreen({ repo: dir, sha: child("1.1.0-rc.3\n"), command: "node --test", format: "node-test" });
  suiteGreen({ repo: dir, sha: child("1.1.0-rc.2"), command: "node --test", format: "node-test" });
  assert.deepEqual(runs(), ["1.1.0-rc.2", "1.1.0-rc.3", "1.1.0-rc.2"], "another VERSION, or other bytes, runs the suite");
  suiteGreen({ repo: dir, sha: parent, command: "node --test", format: "node-test" });
  assert.equal(runs().length, 4, "the varied run does not stand for the parent's own tree");
});

test("the suite measures the tree Git publishes: a local replacement neither satisfies a run nor changes it", () => {
  const dir = project(`import { readFileSync } from "node:fs";\ntest("state", () => assert.equal(readFileSync("state.txt", "utf8"), "good\\n"));`, { "state.txt": "bad\n" });
  const bad = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "state.txt"), "good\n");
  git(dir, "commit", "-qam", "good");
  const good = git(dir, "rev-parse", "HEAD");
  const [badTree, goodTree] = [bad, good].map(sha => git(dir, "rev-parse", `${sha}^{tree}`));
  const run = (sha, command = "node --test") => suiteGreen({ repo: dir, sha, command, format: "node-test" });
  assert.equal(run(good).green, true);
  git(dir, "replace", bad, good);
  const satisfied = run(bad);
  assert.deepEqual([satisfied.green, satisfied.tree, satisfied.reusedFrom], [false, badTree, undefined], satisfied.text);
  git(dir, "replace", "-d", bad);
  git(dir, "replace", good, bad);
  const reused = run(good);
  assert.deepEqual([reused.green, reused.tree, Boolean(reused.reusedFrom)], [true, goodTree, true]);
  const fresh = run(good, "node --test t.test.mjs");
  assert.deepEqual([fresh.green, fresh.tree, fresh.reusedFrom], [true, goodTree, undefined], fresh.text);
});

test("a running suite holds one lease in the host load directory, removed after a green, a red or a failed install", () => {
  const dir = repo({ "t.test.mjs": `import test from "node:test";\nimport assert from "node:assert";\nimport { readdirSync } from "node:fs";\ntest("lease", () => assert.equal(readdirSync(process.env.SELF_LOOP_LOAD_DIR).filter(n => /^suite-\\d+-\\d+\\.json$/.test(n)).length, 1));\n` });
  const head = git(dir, "rev-parse", "HEAD");
  const seen = join(temp(), "lease.json");
  const copy = `cp "$SELF_LOOP_LOAD_DIR"/suite-${process.pid}-*.json ${JSON.stringify(seen)}`;
  assert.equal(suiteGreen({ repo: dir, sha: head, command: `${copy} && node --test`, format: "node-test" }).green, true);
  const lease = JSON.parse(readFileSync(seen, "utf8"));
  assert.deepEqual([lease.kind, lease.pid, lease.repo, lease.sha, typeof lease.started], ["suite", process.pid, dir, head, "string"]);
  assert.equal(suiteGreen({ repo: dir, sha: head, command: "exit 1" }).green, false);
  assert.equal(suiteGreen({ repo: dir, sha: head, install: "exit 1", command: "true" }).green, false);
  assert.deepEqual(readdirSync(process.env.SELF_LOOP_LOAD_DIR).filter(n => n.startsWith("suite-")), []);
});

const storedRuns = dir => readdirSync(suiteStore(dir)).flatMap(k => readdirSync(join(suiteStore(dir), k)).filter(n => n.endsWith(".json")).map(n => join(suiteStore(dir), k, n)));
const pathNode = () => JSON.parse(execFileSync("sh", ["-c", `node -p 'JSON.stringify([process.version, process.platform, process.arch])'`], { encoding: "utf8" }));

const pathNodeBinary = () => execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim();
function otherNode(version) {
  const bin = temp("other-node-");
  writeFileSync(join(bin, "version.mjs"), `Object.defineProperty(process, "version", { value: ${JSON.stringify(version)} });\n`);
  writeFileSync(join(bin, "node"), `#!/bin/sh\nexec ${JSON.stringify(pathNodeBinary())} --import ${JSON.stringify(join(bin, "version.mjs"))} "$@"\n`);
  chmodSync(join(bin, "node"), 0o755);
  return bin;
}

function onPath(bin, body) {
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  try { return body(); } finally { process.env.PATH = before; }
}

test("R6-3: the runtime that executes the suite is part of the key; a run is reused only on an equal runtime, and every receipt names it", () => {
  const { dir, runs } = counted();
  const [node, platform, arch] = pathNode();
  const first = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" });
  assert.deepEqual([first.green, first.runtime, runs().length], [true, { node, platform, arch }, 1], first.text);
  const stored = JSON.parse(readFileSync(storedRuns(dir)[0], "utf8"));
  assert.deepEqual([stored.runtime, stored.key.runtime], [first.runtime, first.runtime]);
  const other = otherNode("v0.0.0-release");
  const switched = onPath(other, () => suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" }));
  assert.deepEqual([switched.green, switched.reusedFrom, switched.runtime, runs().length], [true, undefined, null, 2], "another Node on the command's PATH runs the suite");
  const again = onPath(other, () => suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" }));
  assert.deepEqual([Boolean(again.reusedFrom), again.runtime, runs().length], [false, null, 3], "an opaque wrapper is run again");
  const back = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" });
  assert.deepEqual([Boolean(back.reusedFrom), back.runtime, runs().length], [true, first.runtime, 3]);
  const before = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--import=${join(otherNode("v0.0.0-options"), "version.mjs")}`;
  let options;
  try { options = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" }); }
  finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before; }
  assert.deepEqual([options.reusedFrom, options.runtime, runs().length], [undefined, null, 4], "NODE_OPTIONS reaches the probe as it reaches the suite");
});

test("R6-3: a stored run whose runtime or key does not equal the request is never reused, wherever it is filed", () => {
  const { dir, runs } = counted();
  suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" });
  const [file] = storedRuns(dir);
  const run = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...run, runtime: { ...run.runtime, node: "v0.0.0-elsewhere" } }));
  assert.equal(suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" }).reusedFrom, undefined, "a run naming another runtime");
  assert.equal(runs().length, 2);
  const named = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test t.test.mjs", format: "node-test" });
  assert.equal(runs().length, 3);
  const other = storedRuns(dir).find(f => JSON.parse(readFileSync(f, "utf8")).command === named.command);
  const moved = join(file, "..", "9999999999999-misfiled.json");
  renameSync(other, moved);
  renameSync(other.replace(/\.json$/, ".log.gz"), moved.replace(/\.json$/, ".log.gz"));
  const after = suiteGreen({ repo: dir, sha: "HEAD", command: "node --test", format: "node-test" });
  assert.ok(after.reusedFrom && after.reusedFrom !== moved && after.reusedFrom !== file, after.reusedFrom);
  assert.equal(runs().length, 3, "a run of another command filed under this key is skipped, the valid one reused");
});
