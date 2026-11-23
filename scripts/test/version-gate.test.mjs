// version-gate.mjs: every push carries a higher, tagged version; released tags never move. Live cases push to a bare
// repository through the repository's own pre-push hook (core.hooksPath), as any harness or terminal would.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { tipProblem } from "../lib/tip.mjs";
import { compareVersions, isRelease, parseVersion } from "../lib/version.mjs";
import { repo as makeRepo, scripts, skill, temp } from "./helpers.mjs";

process.env.SELF_LOOP_LOAD_DIR = temp("self-loop-load-");
const git = (repo, ...argv) => execFileSync("git", ["-C", repo, ...argv], { encoding: "utf8", env: process.env }).trim();

const v = text => parseVersion(text);
const sorted = list => [...list].sort((a, b) => compareVersions(v(a), v(b)));

test("versions are X.Y.Z or X.Y.Z-<prerelease> and order by SemVer precedence", () => {
  assert.deepEqual(v("0.4.0\n"), { text: "0.4.0", core: [0n, 4n, 0n], pre: [] });
  assert.deepEqual(v("0.4.4-v1.5").pre, ["v1", 5n]);
  for (const text of ["0.4", "v0.4.0", "0.4.4-", "0.4.4-v1..5", "0.4.4-v1.05", "0.4.4+build", "0.4.4-v1.5+build", "0.4.4-v1_5"]) assert.equal(v(text), null, text);
  assert.ok(isRelease(v("0.4.4")) && !isRelease(v("0.4.4-v1.5")));
  assert.ok(compareVersions(v("0.10.0"), v("0.9.9")) > 0);
  assert.equal(compareVersions(v("1.2.3"), v("1.2.3")), 0);
  const order = ["0.4.3", "0.4.4-v1.5", "0.4.4-v1.6", "0.4.4-v1.10", "0.4.4", "0.5.0-v2.1"];
  assert.deepEqual(sorted([...order].reverse()), order);
  // The SemVer 2.0 specification's own example of precedence.
  const spec = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  assert.deepEqual(sorted([...spec].reverse()), spec);
  assert.ok(compareVersions(v("1.0.0-1"), v("1.0.0-a")) < 0, "a numeric identifier sorts before a word");
});

const GREEN = "import test from 'node:test'; test('fixture', () => {});\n";
const RED = "import test from 'node:test'; test('fixture', () => { throw Error('red fixture'); });\n";
const testPath = "scripts/test/example.test.mjs";

function setup({ version = "0.4.0", suite = GREEN, hooks = true, files = {} } = {}) {
  const remote = temp("remote-");
  git(remote, "init", "-q", "--bare");
  const repo = temp("dev-");
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "scripts", "lib"), { recursive: true });
  for (const entry of readdirSync(scripts, { withFileTypes: true })) {
    if (entry.name !== "test") cpSync(join(scripts, entry.name), join(repo, "scripts", entry.name), { recursive: true });
  }
  cpSync(join(skill, ".githooks"), join(repo, ".githooks"), { recursive: true });
  mkdirSync(join(repo, "scripts/test"));
  cpSync(join(scripts, "test/index.js"), join(repo, "scripts/test/index.js"));
  writeFileSync(join(repo, testPath), suite);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  writeFileSync(join(repo, "VERSION"), `${version}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", version);
  if (hooks) git(repo, "config", "core.hooksPath", ".githooks");
  git(repo, "remote", "add", "origin", remote);
  return { repo, remote };
}
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
const push = (repo, ...refs) => spawnSync("git", ["-C", repo, "push", "origin", ...refs], { encoding: "utf8", env });
const gate = (repo, ...args) => spawnSync(process.execPath, [join(repo, "scripts", "version-gate.mjs"), ...args], { cwd: repo, encoding: "utf8", env });
const release = (repo, ...args) => gate(repo, "release", ...args);
const refs = repo => git(repo, "for-each-ref", "--format=%(refname)");

test("a release tags HEAD and pushes branch and tag; a push without a raised, tagged version is refused", () => {
  const { repo, remote } = setup();
  const first = release(repo);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(git(remote, "rev-parse", "refs/tags/v0.4.0^{commit}"), git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(repo, "a.txt"), "change\n");
  git(repo, "add", "a.txt");
  git(repo, "commit", "-qm", "change without a version");
  const same = push(repo, "main");
  assert.notEqual(same.status, 0);
  assert.match(same.stderr, /VERSION 0\.4\.0 is not greater than the remote's 0\.4\.0/);
  writeFileSync(join(repo, "VERSION"), "0.4.1\n");
  git(repo, "commit", "-qam", "0.4.1");
  const untagged = push(repo, "main");
  assert.notEqual(untagged.status, 0);
  assert.match(untagged.stderr, /tag v0\.4\.1 must point at the pushed commit/);
  const second = release(repo);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));
});

test("a tag must equal its commit's VERSION, and a released tag never moves or disappears", () => {
  const { repo } = setup();
  assert.equal(release(repo).status, 0);
  git(repo, "tag", "v9.9.9");
  assert.match(push(repo, "refs/tags/v9.9.9").stderr, /v9\.9\.9 tags a commit whose VERSION is 0\.4\.0/);
  writeFileSync(join(repo, "b.txt"), "x\n");
  git(repo, "add", "b.txt");
  git(repo, "commit", "-qm", "x");
  git(repo, "tag", "-f", "v0.4.0");
  assert.match(push(repo, "-f", "refs/tags/v0.4.0").stderr, /v0\.4\.0: a released tag never moves/);
  assert.match(push(repo, ":refs/tags/v0.4.0").stderr, /a released tag is never deleted/);
});

test("release refuses a dirty tree and an invalid VERSION", () => {
  const { repo } = setup();
  writeFileSync(join(repo, "stray.txt"), "x\n");
  assert.match(release(repo).stderr, /working tree is not clean/);
  spawnSync("rm", [join(repo, "stray.txt")]);
  writeFileSync(join(repo, "VERSION"), "0.4\n");
  git(repo, "commit", "-qam", "bad");
  assert.match(release(repo).stderr, /VERSION "0\.4" is not X\.Y\.Z/);
});

test("a local release tag does not cover a branch push until it reaches the destination", () => {
  const { repo, remote } = setup();
  git(repo, "tag", "-a", "v0.4.0", "-m", "fixture");
  assert.match(push(repo, "main").stderr, /tag v0\.4\.0 must point at the pushed commit/);
  assert.equal(refs(remote), "");
  assert.equal(push(repo, "v0.4.0").status, 0, "a green annotated tag may go first");
  assert.equal(push(repo, "main").status, 0, "the existing remote tag covers its commit");
});

test("tag-only and mixed pushes run the suite on every new release commit, despite the old test switch", () => {
  const { repo, remote } = setup({ suite: RED });
  git(repo, "tag", "-a", "v0.4.0", "-m", "red");
  const red = git(repo, "rev-parse", "HEAD");
  const attempt = (...args) => spawnSync("git", ["push", "origin", ...args], { cwd: repo,
    encoding: "utf8", env: { ...env, SELF_LOOP_SKIP_SUITE: "1" } });
  for (const args of [["v0.4.0"], ["main", "v0.4.0"]]) {
    const result = attempt(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /suite is not green/);
    assert.equal(refs(remote), "");
  }
  writeFileSync(join(repo, testPath), GREEN);
  writeFileSync(join(repo, "VERSION"), "0.4.1\n");
  git(repo, "commit", "-qam", "green");
  git(repo, "tag", "v0.4.1");
  const mixed = attempt("main", "v0.4.1", "v0.4.0");
  assert.match(mixed.stderr, new RegExp("suite is not green on " + red.slice(0, 7)));
  assert.equal(refs(remote), "");
});

test("tag-only pushes reject an invalid VERSION even when it matches the tag spelling", () => {
  const { repo, remote } = setup({ version: "wrong" });
  git(repo, "tag", "vwrong");
  assert.match(push(repo, "vwrong").stderr, /VERSION.*not X\.Y\.Z/);
  assert.equal(refs(remote), "");
});

test("release validates a red commit even with no installed hook", () => {
  const { repo, remote } = setup({ hooks: false, suite: RED });
  assert.match(release(repo).stderr, /suite is not green/);
  assert.equal(refs(remote), "");
});

test("release is atomic if the destination refuses the branch", () => {
  const { repo, remote } = setup();
  writeFileSync(join(remote, "hooks/update"), '#!/bin/sh\n[ "$1" != refs/heads/main ]\n', { mode: 0o755 });
  assert.notEqual(release(repo).status, 0);
  assert.equal(refs(remote), "");
});

test("release resolves the selected branch for its SHA, VERSION, test and tag", () => {
  const { repo, remote } = setup({ hooks: false });
  git(repo, "branch", "maintenance");
  const selected = git(repo, "rev-parse", "maintenance");
  writeFileSync(join(repo, "VERSION"), "0.4.1\n");
  writeFileSync(join(repo, testPath), RED);
  git(repo, "commit", "-qam", "unrelated HEAD");
  const result = release(repo, "--branch", "maintenance");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(remote, "rev-parse", "maintenance"), selected);
  assert.equal(git(remote, "rev-parse", "refs/tags/v0.4.0^{commit}"), selected);
  assert.doesNotMatch(refs(remote), /0\.4\.1/);
});

test("pre-commit tests the index even if the working copy fixes the red test", () => {
  const { repo } = setup();
  writeFileSync(join(repo, testPath), RED);
  git(repo, "add", testPath);
  writeFileSync(join(repo, testPath), GREEN);
  const commit = spawnSync("git", ["commit", "-qm", "red staged test"], { cwd: repo, encoding: "utf8", env });
  assert.notEqual(commit.status, 0);
  assert.match(commit.stderr, /red fixture/);
  assert.match(git(repo, "show", ":scripts/test/example.test.mjs"), /red fixture/);
});

test("large consecutive release versions compare exactly and leading zeros are rejected", () => {
  assert.equal(parseVersion("0.04.2"), null);
  for (const text of ["00.4.2", "0.4.02", "0.4.2-rc.01", "0.4.2+build"]) assert.equal(parseVersion(text), null);
  const { repo, remote } = setup({ version: "1.0.9007199254740992" });
  assert.equal(release(repo).status, 0);
  writeFileSync(join(repo, "VERSION"), "1.0.9007199254740993\n");
  git(repo, "commit", "-qam", "raise");
  const result = release(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.match(refs(remote), /v1\.0\.9007199254740993/);
});

test("an owner's unattested remote update stays open until reconciled to committed evidence", () => {
  const { repo, remote } = setup();
  const records = makeRepo({ "decisions/D-0003.md": "# D-0003\n\nOwner approved an emergency push.\n" });
  const scan = (...args) => gate(repo, "reconcile", "--remote", "origin", "--branch", "main", "--records", records, ...args);
  assert.equal(release(repo).status, 0);
  assert.deepEqual(JSON.parse(scan().stdout), []);
  writeFileSync(join(repo, "VERSION"), "0.4.1\n");
  git(repo, "commit", "-qam", "emergency");
  // Update the disposable remote directly to reproduce the result of an owner push that skipped the hook.
  const unhooked = temp();
  git(unhooked, "clone", "-q", "--no-hardlinks", repo, ".");
  git(unhooked, "push", "-q", remote, "main");
  const [finding] = JSON.parse(scan().stdout);
  assert.equal(finding.ref, "refs/heads/main");
  assert.equal(finding.sha, git(repo, "rev-parse", "HEAD"));
  writeFileSync(join(repo, "VERSION"), "0.4.2\n");
  git(repo, "commit", "-qam", "ordinary release");
  assert.equal(release(repo).status, 0);
  assert.deepEqual(JSON.parse(scan().stdout).map(r => r.id), [finding.id]);
  assert.notEqual(scan("--close", finding.id, "--cite", "D-9999").status, 0);
  assert.deepEqual(JSON.parse(scan("--close", finding.id, "--cite", "D-0003").stdout), []);
  assert.deepEqual(JSON.parse(scan().stdout), []);
});

for (const hooks of [true, false]) {
  test(`an unattested destination tip stays visible after replacement by ${hooks ? "pre-push" : "release without hooks"}`, () => {
    const { repo, remote } = setup({ hooks });
    assert.equal(release(repo).status, 0);

    writeFileSync(join(repo, "VERSION"), "0.4.1\n");
    git(repo, "commit", "-qam", "emergency change");
    const bypassed = git(repo, "rev-parse", "HEAD");
    git(remote, "fetch", "--no-tags", repo, "main:refs/heads/main");

    writeFileSync(join(repo, "VERSION"), "0.4.2\n");
    git(repo, "commit", "-qam", "ordinary release");
    git(repo, "tag", "-a", "v0.4.2", "-m", "fixture");
    const result = hooks ? push(repo, "main", "v0.4.2") : release(repo);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));

    const findings = gate(repo, "reconcile", "--branch", "main");
    assert.equal(findings.status, 0, findings.stderr);
    assert.deepEqual(JSON.parse(findings.stdout).map(({ ref, sha }) => [ref, sha]), [["refs/heads/main", bypassed]]);
  });
}

test("a round's candidate carries a prerelease VERSION: tagged, pushed, ordered by precedence, its tag immutable", () => {
  const { repo, remote } = setup({ version: "0.4.3" });
  assert.equal(release(repo).status, 0);
  const raise = version => { writeFileSync(join(repo, "VERSION"), `${version}\n`); git(repo, "commit", "-qam", version); };
  raise("0.4.4-v1.5");
  assert.match(push(repo, "main").stderr, /tag v0\.4\.4-v1\.5 must point at the pushed commit/, "an untagged candidate is refused");
  const first = release(repo);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(git(remote, "rev-parse", "refs/tags/v0.4.4-v1.5^{commit}"), git(repo, "rev-parse", "HEAD"));
  raise("0.4.4-v1.6");
  git(repo, "tag", "v0.4.4-v1.6");
  const hooked = push(repo, "main", "v0.4.4-v1.6");
  assert.equal(hooked.status, 0, hooked.stderr);
  raise("0.4.4-v1.5.1");
  assert.match(release(repo).stderr, /VERSION 0\.4\.4-v1\.5\.1 is not greater than the remote's 0\.4\.4-v1\.6/);
  assert.equal(git(repo, "tag", "--list", "v0.4.4-v1.5.1"), "", "a refused release leaves no tag");
  git(repo, "reset", "-q", "--hard", "HEAD~1");
  raise("0.4.4");
  assert.equal(release(repo).status, 0, "the release outranks its prereleases");
  raise("0.4.4-v1.7");
  assert.match(release(repo).stderr, /VERSION 0\.4\.4-v1\.7 is not greater than the remote's 0\.4\.4/);
  git(repo, "reset", "-q", "--hard", "HEAD~1");
  git(repo, "tag", "-f", "v0.4.4-v1.5", "HEAD");
  assert.match(push(repo, "-f", "refs/tags/v0.4.4-v1.5").stderr, /v0\.4\.4-v1\.5: a released tag never moves/);
  assert.match(push(repo, ":refs/tags/v0.4.4-v1.6").stderr, /v0\.4\.4-v1\.6: a released tag is never deleted/);
  raise("0.4.5+build.1");
  assert.match(push(repo, "main").stderr, /VERSION "0\.4\.5\+build\.1" is not X\.Y\.Z or X\.Y\.Z-<prerelease>/);
});

test("tip writes a VERSION-only commit and moves the branch only as a fast-forward, leaving index and working tree alone", () => {
  const { repo } = setup();
  const base = git(repo, "rev-parse", "HEAD");
  writeFileSync(join(repo, "VERSION"), "draft\n");
  const index = readFileSync(join(repo, ".git", "index"));
  const made = gate(repo, "tip", "--version", "0.4.1");
  assert.equal(made.status, 0, made.stderr);
  const sha = made.stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.deepEqual([git(repo, "rev-parse", "main"), git(repo, "rev-parse", `${sha}^`), git(repo, "show", `${sha}:VERSION`)], [sha, base, "0.4.1"]);
  assert.equal(tipProblem(repo, base, sha), null);
  assert.deepEqual([readFileSync(join(repo, "VERSION"), "utf8"), readFileSync(join(repo, ".git", "index"))], ["draft\n", index]);
  assert.match(made.stderr, /checked out in/);
  for (const [version, code] of [["0.4", 64], ["0.4.1-rc.01", 64], ["0.4.1", 2], ["0.4.1-rc.1", 2], ["0.3.9", 2]]) {
    const r = gate(repo, "tip", "--version", version);
    assert.equal(r.status, code, `${version}: ${r.stderr}`);
    assert.equal(git(repo, "rev-parse", "main"), sha);
  }
  assert.equal(gate(repo, "tip").status, 64);
  const behind = gate(repo, "tip", "--version", "0.5.0", "--on", base);
  assert.equal(behind.status, 2);
  const aside = behind.stdout.trim();
  assert.deepEqual([git(repo, "rev-parse", `${aside}^`), git(repo, "rev-parse", "main")], [base, sha], "printed, branch untouched");
  assert.match(behind.stderr, /was not moved/);
  const created = gate(repo, "tip", "--version", "0.5.0", "--on", base, "--branch", "release/0.5");
  assert.equal(created.status, 0, created.stderr);
  assert.equal(git(repo, "rev-parse", "release/0.5"), created.stdout.trim());
  assert.doesNotMatch(created.stderr, /checked out/);
  assert.equal(gate(repo, "tip", "--version", "0.6.0", "--branch", "absent").status, 64);
  git(repo, "checkout", "-q", "--detach", base);
  assert.equal(gate(repo, "tip", "--version", "0.6.0").status, 64, "a detached HEAD names no branch");
  git(repo, "rm", "-q", "--cached", "VERSION");
  const bare = git(repo, "commit-tree", git(repo, "write-tree"), "-p", base, "-m", "no VERSION");
  const none = gate(repo, "tip", "--version", "0.6.0", "--on", bare, "--branch", "other");
  assert.equal(none.status, 2);
  assert.match(none.stderr, /VERSION "missing"/);
});

test("release, reconcile and pre-push refuse a remote with two push URLs, naming both, before either is updated", () => {
  const { repo, remote } = setup();
  const mirror = temp("mirror-");
  git(mirror, "init", "-q", "--bare");
  git(repo, "remote", "set-url", "--add", "--push", "origin", remote);
  git(repo, "remote", "set-url", "--add", "--push", "origin", mirror);
  git(repo, "tag", "v0.4.0");
  for (const result of [release(repo), gate(repo, "reconcile"), push(repo, "main", "v0.4.0")]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`${remote}, ${mirror}`));
  }
  assert.equal(release(repo).status, 2);
  assert.deepEqual([refs(remote), refs(mirror)], ["", ""]);
  const direct = spawnSync("git", ["-C", repo, "push", mirror, "main", "v0.4.0"], { encoding: "utf8", env });
  assert.equal(direct.status, 0, direct.stderr);
  assert.equal(git(mirror, "rev-parse", "main"), git(repo, "rev-parse", "HEAD"));
});

for (const acceptance of [false, true]) {
  test(`one tree, one suite run${acceptance ? " with acceptance cases" : ""}: pre-push and release reuse the green run of pre-commit or suite-green.mjs`, () => {
    const counter = join(temp(), "runs");
    const probe = name => `import test from 'node:test'; import { appendFileSync } from 'node:fs'; test('${name}', () => appendFileSync(${JSON.stringify(counter)}, '${name}\\n'));\n`;
    const files = { "scripts/test/helper.mjs": `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(counter)}, 'helper\\n');\n` };
    if (acceptance) Object.assign(files, { "acceptance/probe.test.mjs": probe("acceptance"), "acceptance/nested/deep.test.mjs": probe("nested") });
    const { repo, remote } = setup({ suite: probe("unit"), files });
    const command = `node --test ${testPath}${acceptance ? " acceptance/probe.test.mjs" : ""}`;
    const runs = () => existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter(Boolean).sort() : [];
    const measured = n => Array.from({ length: n }, () => acceptance ? ["acceptance", "unit"] : ["unit"]).flat().sort();
    const raise = (version, ...flags) => { writeFileSync(join(repo, "VERSION"), `${version}\n`); git(repo, "commit", "-qam", version, ...flags); };
    const reused = (result, sha) => {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`version-gate: reused \\S+/self-loop-suite/\\S+ for ${sha.slice(0, 7)}`));
    };

    raise("0.4.1");
    assert.deepEqual(runs(), measured(1), "pre-commit ran the staged tree");
    git(repo, "tag", "v0.4.1");
    reused(push(repo, "main", "v0.4.1"), git(repo, "rev-parse", "HEAD"));
    assert.deepEqual(runs(), measured(1), "pre-push reused the pre-commit run");

    raise("0.4.2", "--no-verify");
    const head = git(repo, "rev-parse", "HEAD");
    const suite = spawnSync(process.execPath, [join(repo, "scripts", "suite-green.mjs"), "--repo", repo, "--sha", head, "--command", command, "--format", "node-test"], { cwd: repo, encoding: "utf8", env });
    assert.equal(suite.status, 0, suite.stderr);
    assert.deepEqual(runs(), measured(2));
    git(repo, "tag", "v0.4.2");
    reused(push(repo, "main", "v0.4.2"), head);
    assert.deepEqual(runs(), measured(2), "pre-push reused the suite-green.mjs run");

    raise("0.4.3");
    assert.deepEqual(runs(), measured(3));
    reused(release(repo), git(repo, "rev-parse", "HEAD"));
    assert.deepEqual(runs(), measured(3), "release reused the pre-commit run");
    assert.equal(git(remote, "rev-parse", "refs/tags/v0.4.3^{commit}"), git(repo, "rev-parse", "HEAD"));
  });
}

test("R6-2: release and pre-push compare the suite receipt's measured tree with the tree they publish", async () => {
  const { pushReasons } = await import("../version-gate.mjs");
  const { repo } = setup();
  const sha = git(repo, "rev-parse", "HEAD"), tree = git(repo, "rev-parse", "HEAD^{tree}");
  git(repo, "tag", "v0.4.0");
  const updates = [{ ref: "refs/heads/main", sha, before: "0".repeat(40) }];
  const refs = new Map([["refs/tags/v0.4.0", sha]]);
  const receipt = fields => () => ({ repository: repo, sha, tree, green: true, reasons: [], ...fields });
  assert.deepEqual(pushReasons(repo, updates, refs, { suite: receipt({}) }), []);
  const empty = execFileSync("git", ["-C", repo, "mktree"], { input: "", encoding: "utf8" }).trim();
  const [reason] = pushReasons(repo, updates, refs, { suite: receipt({ tree: empty }) });
  assert.ok(reason.includes(empty) && reason.includes(tree), reason);
  assert.match(pushReasons(repo, updates, refs, { suite: receipt({ sha: "f".repeat(40) }) })[0], /receipt is for fffffff/);
});

test("release, pre-push and tip read the commit Git publishes: a local replacement neither satisfies nor changes them, and a refusal exits 2 naming both trees", () => {
  const { repo, remote } = setup();
  assert.equal(release(repo).status, 0);
  const base = git(repo, "rev-parse", "HEAD");
  const commit = (parent, files) => {
    git(repo, "read-tree", parent);
    for (const [path, text] of Object.entries(files)) { writeFileSync(join(repo, path), text); git(repo, "add", path); }
    const sha = git(repo, "commit-tree", git(repo, "write-tree"), "-p", parent, "-m", "candidate");
    git(repo, "reset", "-q", "--hard", base);
    return sha;
  };
  const red = commit(base, { [testPath]: RED, VERSION: "0.4.1\n" }), green = commit(base, { [testPath]: GREEN, VERSION: "0.4.1\n" });
  const same = commit(green, { "README.md": "unreleased\n" }), bumped = commit(green, { VERSION: "0.4.2\n" });
  const [redTree, greenTree] = [red, green].map(sha => git(repo, "rev-parse", `${sha}^{tree}`));
  git(repo, "branch", "candidate", red);
  git(repo, "tag", "v0.4.1", red);
  git(repo, "replace", red, green);
  const refusals = [release(repo, "--branch", "candidate"), push(repo, "candidate", "v0.4.1")];
  assert.equal(refusals[0].status, 2, refusals[0].stderr);
  assert.notEqual(refusals[1].status, 0, refusals[1].stderr);
  for (const refused of refusals) assert.ok(refused.stderr.includes(redTree) && refused.stderr.includes(greenTree), refused.stderr);
  assert.equal(refs(remote), "refs/heads/main\nrefs/tags/v0.4.0");
  git(repo, "tag", "-d", "v0.4.1");
  git(repo, "replace", "-d", red);
  git(repo, "branch", "-f", "candidate", green);
  git(repo, "replace", green, red);
  const published = release(repo, "--branch", "candidate");
  assert.equal(published.status, 0, published.stderr);
  assert.equal(git(remote, "rev-parse", "refs/heads/candidate^{tree}"), greenTree);
  const made = gate(repo, "tip", "--version", "0.4.2", "--on", "candidate", "--branch", "next");
  assert.equal(made.status, 0, made.stderr);
  assert.equal(git(repo, "--no-replace-objects", "diff", "--name-only", green, made.stdout.trim()), "VERSION");
  git(repo, "replace", same, bumped);
  git(repo, "tag", "v0.4.2", same);
  const unversioned = push(repo, `${same}:refs/heads/candidate`, "v0.4.2");
  assert.notEqual(unversioned.status, 0);
  assert.match(unversioned.stderr, /v0\.4\.2 tags a commit whose VERSION is 0\.4\.1/);
  assert.equal(git(remote, "rev-parse", "refs/heads/candidate"), green);
});

test("R6-6: release, reconcile and the pre-push hook publish through a remote whose name has slashes and dots", () => {
  const { repo, remote } = setup();
  git(repo, "remote", "rename", "origin", "team/release.v1");
  writeFileSync(join(repo, "VERSION"), "0.4.1\n");
  git(repo, "commit", "-qam", "0.4.1");
  const r = release(repo, "--remote", "team/release.v1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(git(remote, "rev-parse", "refs/tags/v0.4.1^{commit}"), git(repo, "rev-parse", "HEAD"));
  assert.equal(gate(repo, "reconcile", "--remote", "team/release.v1", "--branch", "main").status, 0);
  const unknown = release(repo, "--remote", "team");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Git knows no remote/);
});
