import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bytes } from "./closing-fixture.mjs";
import { put, skill, world } from "./fixture.mjs";
import { seed, seeded } from "./scenario.mjs";

const fullSuite = "node --test scripts/test/*.test.mjs && if [ -d acceptance ]; then node --test acceptance; fi";

/** @typedef {{parent: string, higher: string, lower: string, invalid: string[]}} VersionScenario */

/** @returns {VersionScenario} */
export function versionScenario() {
  const draw = seeded(seed);
  const core = `2.${draw(100)}.${draw(100)}`;
  return {
    parent: core + "-rc.9", higher: core + "-rc.10", lower: core + "-rc.8",
    invalid: [core + "-rc.01", core + "+build"],
  };
}

export function versionWorld(t, { failTip = false, pause = false } = {}) {
  const w = world(t);
  const versions = versionScenario();
  const log = join(w.dir, "suite-runs");
  const load = join(w.dir, "suite-load");
  const go = join(w.dir, "continue-suite");
  const testBody = `import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import test from "node:test";

test("measure the version suite", async () => {
  const version = readFileSync("VERSION", "utf8").trim();
  appendFileSync(${JSON.stringify(log)}, version + "\\n");
  ${pause ? `while (!existsSync(${JSON.stringify(go)})) await setTimeout(20);` : ""}
  ${failTip ? `assert.notEqual(version, ${JSON.stringify(versions.higher)}, "VERSION is rejected by the suite");` : ""}
});
`;
  const product = w.repo(join(w.dir, "version-product"), {
    VERSION: versions.parent + "\n", "README.md": "# Version example\n", "scripts/test/probe.test.mjs": testBody,
  });
  const source = join(skill, "scripts");
  cpSync(source, join(product, "scripts"), {
    recursive: true,
    filter: file => file !== join(source, "test"),
  });
  cpSync(join(skill, ".githooks"), join(product, ".githooks"), { recursive: true });
  const parent = w.commit(product, "Install release hooks");
  const hook = () => w.git(product, "config", "core.hooksPath", ".githooks");
  const addRemote = name => {
    const bare = join(w.dir, name + ".git");
    mkdirSync(bare);
    w.git(bare, "init", "-q", "--bare");
    return bare;
  };
  const bare = addRemote("origin");
  w.git(product, "remote", "add", "origin", bare);
  const refs = (repo = bare) => w.git(repo, "for-each-ref", "--format=%(objectname) %(refname)");
  const runs = () => bytes(log).toString().split("\n").filter(Boolean);
  const version = (args, cwd = product) => w.run(args,
    { entry: "version-gate.mjs", cwd, extraEnv: { SELF_LOOP_LOAD_DIR: load } });
  const suiteSettings = { entry: "suite-green.mjs", extraEnv: { SELF_LOOP_LOAD_DIR: load } };
  const suiteArgs = (sha, args) =>
    ["--repo", product, "--sha", sha, "--command", fullSuite, "--format", "node-test", ...args];
  const suite = (sha = parent, args = []) => w.run(suiteArgs(sha, args), suiteSettings);
  const suiteAsync = (sha = parent, args = []) => w.runAsync(suiteArgs(sha, args), suiteSettings);
  const editTip = () => {
    put(product, "VERSION", versions.higher + "\n");
    return w.commit(product, "Prepare the higher VERSION");
  };
  const state = () => ({
    head: w.git(product, "rev-parse", "HEAD"),
    index: readFileSync(join(product, ".git", "index")),
    readme: readFileSync(join(product, "README.md")),
    version: readFileSync(join(product, "VERSION")),
  });
  return { w, product, parent, versions, hook, addRemote, bare, refs, runs, log, load, go, version, suite, suiteAsync, editTip, state };
}
