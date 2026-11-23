import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { closingScenario, closingWorld } from "./closing-fixture.mjs";
import { has, output, put, skill, status, world } from "./fixture.mjs";
import { rulingWorld } from "./ruling-fixture.mjs";

function releaseWorld(t, initial = "0.4.3", { red = false } = {}) {
  const w = world(t);
  const remote = join(w.dir, "destination.git");
  mkdirSync(remote);
  w.git(remote, "init", "-q", "--bare");
  const product = w.repo(join(w.dir, "product"), {
    VERSION: initial + "\n",
    "scripts/test/fixture.test.mjs": `import test from "node:test";\ntest("release suite", () => {${red ? 'throw Error("release suite failed");' : ''}});\n`,
  });
  const gate = join(skill, "scripts", "version-gate.mjs");
  const hook = put(product, ".git/hooks/pre-push", `#!/bin/sh\nexec "${process.execPath}" "${gate}" pre-push "$@"\n`);
  chmodSync(hook, 0o755);
  w.git(product, "remote", "add", "origin", remote);
  const edit = version => {
    put(product, "VERSION", version + "\n");
    return w.commit(product, "Set VERSION to " + version);
  };
  const release = () => w.run(["release"], { entry: "version-gate.mjs", cwd: product });
  const push = (...refs) => w.runGit(product, "push", "--atomic", "origin", ...refs);
  const tag = version => w.git(product, "tag", "v" + version);
  const remoteRefs = () => w.git(remote, "for-each-ref", "--format=%(objectname) %(refname)");
  const delivered = (version, sha = w.git(product, "rev-parse", "HEAD")) => {
    assert.equal(w.git(remote, "rev-parse", "refs/heads/main"), sha);
    assert.equal(w.git(remote, "rev-parse", `refs/tags/v${version}^{commit}`), sha);
  };
  return { edit, release, push, tag, delivered, remoteRefs };
}

test("R5-VER-01 release publishes prerelease tags and a final release for the same core version", t => {
  const s = releaseWorld(t);
  status(s.release(), 0);
  s.delivered("0.4.3");
  for (const version of ["0.4.4-v1.5", "0.4.4-v1.6", "0.4.4"]) {
    const sha = s.edit(version);
    status(s.release(), 0);
    s.delivered(version, sha);
  }
});

test("R5-VER-02 real pre-push uses numeric, ASCII and prefix SemVer precedence", t => {
  const s = releaseWorld(t);
  status(s.release(), 0);
  // SemVer 2 orders numeric identifiers by value (including beyond JS's safe integer range),
  // numeric before nonnumeric, upper before lower ASCII and a shorter equal prefix first.
  for (const version of [
    "0.4.4-9007199254740992", "0.4.4-9007199254740993", "0.4.4-Beta",
    "0.4.4-alpha", "0.4.4-alpha.9", "0.4.4-alpha.10", "0.4.4-alpha.10.0",
  ]) {
    const sha = s.edit(version);
    s.tag(version);
    status(s.push("main", "v" + version), 0);
    s.delivered(version, sha);
  }
});

test("R5-VER-03 numerical downgrade or a prerelease after the same final version still refuses", t => {
  const s = releaseWorld(t);
  status(s.release(), 0);
  s.edit("0.4.4-v1.10");
  status(s.release(), 0);
  let before = s.remoteRefs();
  s.edit("0.4.4-v1.9");
  s.tag("0.4.4-v1.9");
  const downgrade = s.push("main", "v0.4.4-v1.9");
  assert.notEqual(downgrade.status, 0);
  assert.match(output(downgrade), /not greater|raise/i);
  assert.deepEqual(s.remoteRefs(), before);

  s.edit("0.4.4");
  status(s.release(), 0);
  before = s.remoteRefs();
  s.edit("0.4.4-zz");
  const late = s.release();
  assert.notEqual(late.status, 0);
  assert.match(output(late), /not greater|raise/i);
  assert.deepEqual(s.remoteRefs(), before);
});

test("R5-VER-04 malformed prereleases and build metadata remain invalid VERSION values", t => {
  const s = releaseWorld(t);
  status(s.release(), 0);
  const before = s.remoteRefs();
  for (const version of ["0.4.4-rc.01", "0.4.4-alpha_1", "0.4.4-", "0.4.4-rc.1+build"]) {
    s.edit(version);
    s.tag(version);
    for (const result of [s.release(), s.push("main", "v" + version)]) {
      assert.notEqual(result.status, 0);
      has(output(result), version);
      assert.match(output(result), /VERSION/i);
      assert.deepEqual(s.remoteRefs(), before);
    }
  }
});

test("R5-VER-05 a prerelease still needs its exact tag and a green suite", t => {
  const s = releaseWorld(t, "0.4.4-v1.5", { red: true });
  s.tag("0.4.4");
  const mistagged = s.push("v0.4.4");
  assert.notEqual(mistagged.status, 0);
  has(output(mistagged), "v0.4.4");
  assert.match(output(mistagged), /tags a commit whose VERSION/i);

  const untagged = s.push("main");
  assert.notEqual(untagged.status, 0);
  assert.match(output(untagged), /tag v0\.4\.4-v1\.5.*point/i);

  const red = s.release();
  assert.notEqual(red.status, 0);
  assert.match(output(red), /suite is not green/i);
  assert.equal(s.remoteRefs(), "");
});

test("R5-VER-06 a VERSION-only prerelease tip can inherit the ruling and uses the tip's CI", t => {
  const w = world(t);
  const release = rulingWorld(w, { VERSION: "0.4.4-v1.5\n" });
  status(release.promote(), 0);
  // The writer must apply the same tip rule where it records the exact check result.
  const separate = world(t);
  const close = closingWorld(separate, closingScenario(), { edits: { VERSION: "0.4.4-v1.5\n" } });
  status(close.append(), 0);
  close.row();
  close.assertReading(0);
});
