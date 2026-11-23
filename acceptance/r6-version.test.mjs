import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { has, output, put, status } from "./fixture.mjs";
import { versionWorld } from "./r6-version-fixture.mjs";
import { pushWorld } from "./r6-push-fixture.mjs";
import { appendArgs, assertRow, serveChecks } from "./closing-fixture.mjs";

function tipSha(result) {
  const sha = output(result).match(/\b[0-9a-f]{40}\b/g)?.at(-1);
  assert.ok(sha, output(result));
  return sha;
}

function assertTip(p, sha, parent) {
  assert.equal(p.w.git(p.product, "show", "-s", "--format=%P", sha), parent);
  assert.equal(p.w.git(p.product, "diff", "--name-only", parent, sha), "VERSION");
  const result = p.w.runGit(p.product, "show", sha + ":VERSION");
  assert.equal(status(result, 0), p.versions.higher + "\n");
}

test("R6-A19 pre-push refuses a fan-out before updating either remote repository", t => {
  const p = versionWorld(t);
  p.hook();
  const mirror = p.addRemote("secondary");
  p.w.git(p.product, "remote", "set-url", "--push", "origin", p.bare);
  p.w.git(p.product, "remote", "set-url", "--add", "--push", "origin", mirror);
  p.w.git(p.product, "tag", "v" + p.versions.parent);
  const push = () => p.w.runGit(p.product, "push", "--atomic", "origin", "main", "v" + p.versions.parent);
  const attempts = [push(), p.version(["release"]), p.version(["reconcile"])];
  assert.deepEqual([p.refs(), p.refs(mirror)], ["", ""], output(attempts[0]));
  for (const result of attempts) {
    assert.notEqual(result.status, 0);
    has(output(result), p.bare);
    has(output(result), mirror);
  }
  p.w.git(p.product, "config", "--unset-all", "remote.origin.pushurl");
  status(push(), 0);
  status(p.version(["release"]), 0);
  status(p.version(["reconcile"]), 0);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/main"), p.parent);
  assert.equal(p.refs(mirror), "");
});

test("R6-A20 a single explicit push URL remains valid through the Git hook", t => {
  const p = versionWorld(t);
  p.hook();
  const direct = p.addRemote("standalone");
  const tag = "v" + p.versions.parent;
  p.w.git(p.product, "tag", tag);
  status(p.w.runGit(p.product, "push", "--atomic", direct, "main", tag), 0);
  assert.equal(p.w.git(direct, "rev-parse", "refs/heads/main"), p.parent);
  assert.equal(p.w.git(direct, "rev-parse", "refs/tags/" + tag + "^{commit}"), p.parent);
  assert.equal(p.refs(), "");
});

test("R6-A21 tip fast-forwards a named branch without touching a staged and dirty checkout", t => {
  const p = versionWorld(t);
  p.w.git(p.product, "branch", "round/candidate");
  put(p.product, "rules.txt", "Committed before the ruling\n");
  const ruled = p.w.commit(p.product, "Prepare reviewed product");
  put(p.product, "README.md", "# Staged version\n");
  p.w.git(p.product, "add", "README.md");
  put(p.product, "README.md", "# Owner draft\n");
  put(p.product, "VERSION", "local draft\n");
  const before = p.state();
  const result = p.version(["tip", "--version", p.versions.higher, "--on", ruled, "--branch", "round/candidate"]);
  assert.deepEqual(p.state(), before);
  status(result, 0);
  const sha = tipSha(result);
  assertTip(p, sha, ruled);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/round/candidate"), sha);

  const clean = join(p.w.dir, "clean");
  p.w.git(p.product, "worktree", "add", "-q", "--detach", clean, sha);
  status(p.version(["release", "--branch", "round/candidate"], clean), 0);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/heads/round/candidate"), sha);
  assert.equal(p.w.git(p.bare, "rev-parse", "refs/tags/v" + p.versions.higher + "^{commit}"), sha);
});

test("R6-A22 tip returns its commit without replacing a branch that advanced beyond its base", t => {
  const p = versionWorld(t);
  put(p.product, "rules.txt", "Work already on this branch\n");
  const advanced = p.w.commit(p.product, "Continue development");
  const before = p.state();
  const result = p.version(["tip", "--version", p.versions.higher, "--on", p.parent]);
  assert.deepEqual(p.state(), before);
  status(result, 2);
  const sha = tipSha(result);
  assertTip(p, sha, p.parent);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/main"), advanced);

  const retry = p.version(["tip", "--version", p.versions.higher, "--on", advanced]);
  status(retry, 0);
  assertTip(p, tipSha(retry), advanced);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/main"), tipSha(retry));
});

test("R6-A23 malformed or non-increasing versions preserve the branch and the checkout", t => {
  const p = versionWorld(t);
  const before = p.state();
  for (const [versions, code] of [[p.versions.invalid, 64], [[p.versions.parent, p.versions.lower], 2]]) {
    for (const version of versions) {
      const result = p.version(["tip", "--version", version]);
      assert.deepEqual(p.state(), before);
      status(result, code);
      assert.match(output(result), /version/i);
    }
  }
  const result = p.version(["tip", "--version", p.versions.higher]);
  status(result, 0);
  const sha = tipSha(result);
  assertTip(p, sha, p.parent);
  assert.equal(p.w.git(p.product, "rev-parse", "refs/heads/main"), sha);
  assert.deepEqual(p.state(), { ...before, head: sha });
});

test("R6-A24 a generated VERSION tip can close a round judged on its parent", t => {
  const p = pushWorld(t, { publishedRuling: false, edits: {} });
  const requested = "0.4.4-v1.6";
  const result = p.w.run(["tip", "--version", requested], { entry: "version-gate.mjs", cwd: p.product });
  status(result, 0);
  const tip = tipSha(result);
  const { slug } = p.first;
  serveChecks(p.w, { [slug]: { [tip]: p.close.initial } });
  const append = p.w.run(appendArgs({ file: p.file, ruled: p.ruled, tip }), { entry: "trajectory.mjs" });
  status(append, 0);
  assertRow(p.records, { ruled: p.ruled, tip, destination: slug });
});
